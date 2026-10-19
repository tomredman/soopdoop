// ABOUTME: Heads-ups: the owner's Mac saw a prompt about an area a crewmate's agent is on, and the HUD shows a card for 10
// ABOUTME: minutes (a scheduled function ends it). Asking that agent, handing off or knocking counts as acted on. Kept a week.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { addToFeed } from "./feed";
import { requireDaemon, requireHacker } from "./lib/auth";
import { isCrewmate } from "./lib/crew";
import { redactSecrets } from "./lib/summaries";
import { supersetCard } from "./superset";

export const CARD_MS = 10 * 60 * 1000;
// A dismissed card, or one acted on, is not shown again for the same pair of agents for an hour.
const QUIET_MS = 60 * 60 * 1000;
const KEPT_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LINE = 240;

function isOpen(h: Doc<"headsups">, now: number): boolean {
  return h.dismissedAt === undefined && h.actedAt === undefined && h.expiredAt === undefined && h.expiresAt > now;
}

// The daemon scored a prompt on its Mac against what a crewmate's agent is on, and it was over the line. The prompt
// stays on the Mac; this keeps only the card's line, built there from what the crewmate shares. One open card per pair
// of agents: a second heads-up refreshes the first.
export const record = mutation({
  args: {
    token: v.string(),
    otherHandle: v.string(),
    otherAgentId: v.string(),
    kind: v.union(v.literal("area"), v.literal("files")),
    line: v.string(),
    agentId: v.optional(v.string()),
  },
  returns: v.id("headsups"),
  handler: async function (ctx, args) {
    const { hacker, daemon } = await requireDaemon(ctx, args.token);
    // A private agent's prompts make no heads-up.
    if (args.agentId !== undefined && (await agentsOn(ctx, hacker._id, daemon.machineName)).some(function (a) { return a.agentId === args.agentId && !a.open; })) {
      throw new ConvexError("A private agent's work stays on its Mac, so it makes no heads-up.");
    }
    const other = await ctx.db
      .query("hackers")
      .withIndex("by_handle", function (q) {
        return q.eq("handle", args.otherHandle.trim().replace(/^@/, "").toLowerCase());
      })
      .unique();
    if (other === null || other._id === hacker._id || !(await isCrewmate(ctx, hacker._id, other._id))) {
      throw new ConvexError("No crewmate has that handle.");
    }
    const line = redactSecrets(args.line.trim()).slice(0, MAX_LINE);
    if (line === "") throw new ConvexError("A heads-up says what the crewmate's agent is on.");
    // The card keeps the agent's own session id, so it stays one card across a restart, is matched when that agent is
    // asked, and "Hand off" from it reaches that agent.
    const otherAgentId = await sessionOf(ctx, other._id, args.otherAgentId);
    if (otherAgentId === null) throw new ConvexError("That crewmate's agent changed since this Mac last looked; no card.");
    const now = Date.now();
    const recent = await ctx.db
      .query("headsups")
      .withIndex("by_hacker_at", function (q) {
        return q.eq("hackerId", hacker._id).gt("at", now - QUIET_MS - CARD_MS);
      })
      .collect();
    const samePair = recent.filter(function (h) { return h.otherId === other._id && h.otherAgentId === otherAgentId; });
    const open = samePair.find(function (h) { return isOpen(h, now); });
    if (open !== undefined) {
      await ctx.db.patch("headsups", open._id, { kind: args.kind, line, agentId: args.agentId ?? open.agentId });
      return open._id;
    }
    const quiet = samePair.find(function (h) {
      const ended = h.dismissedAt ?? h.actedAt;
      return ended !== undefined && now - ended < QUIET_MS;
    });
    if (quiet !== undefined) return quiet._id;
    const id = await ctx.db.insert("headsups", {
      hackerId: hacker._id,
      otherId: other._id,
      otherAgentId,
      kind: args.kind,
      line,
      agentId: args.agentId,
      at: now,
      expiresAt: now + CARD_MS,
    });
    await ctx.scheduler.runAfter(CARD_MS, internal.headsups.expire, { headsupId: id });
    return id;
  },
});

// "Not now": the card goes, is not counted, and the same pair of agents gets no card for an hour.
export const dismiss = mutation({
  args: { headsupId: v.id("headsups") },
  returns: v.null(),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const h = await ctx.db.get("headsups", args.headsupId);
    if (h === null || h.hackerId !== me._id) throw new ConvexError("Not your heads-up.");
    if (h.dismissedAt === undefined) await ctx.db.patch("headsups", h._id, { dismissedAt: Date.now() });
    return null;
  },
});

// A hacker's agents, on one machine or on all of them.
async function agentsOn(ctx: QueryCtx, hackerId: Id<"hackers">, machineName?: string): Promise<Doc<"subsets">["agents"]> {
  const subsets = await ctx.db
    .query("subsets")
    .withIndex("by_hacker_machine", function (q) {
      return machineName === undefined ? q.eq("hackerId", hackerId) : q.eq("hackerId", hackerId).eq("machineName", machineName);
    })
    .collect();
  return subsets.flatMap(function (s) { return s.agents; });
}

// A crewmate's agent as its session id. A daemon knows a crewmate's agent by its routing summary's key (routing.crew),
// so a key of theirs is turned into the agent it is about; anything else is taken as the session id. Null for the key
// of a summary that is gone: its agent stopped, or its owner's daemon restarted and sent the summary again under a new
// key, and the asking daemon's copy of the crew is older than that. Taken as a session id, it would name no agent.
async function sessionOf(ctx: QueryCtx, ownerId: Id<"hackers">, agentId: string): Promise<string | null> {
  const summaryId = ctx.db.normalizeId("routingSummaries", agentId);
  if (summaryId === null) return agentId;
  const summary = await ctx.db.get("routingSummaries", summaryId);
  if (summary === null) return null;
  return summary.hackerId === ownerId ? summary.agentId : agentId;
}

// The agent's name, only when its owner shares agent names.
async function agentName(ctx: QueryCtx, owner: Doc<"hackers">, agentId: string): Promise<string | undefined> {
  if (!owner.shareAgentNames) return undefined;
  return (await agentsOn(ctx, owner._id)).find(function (a) { return a.agentId === agentId && a.open; })?.name;
}

// My open cards, newest first: not dismissed, not acted on, not ended.
export const cards = query({
  args: {},
  returns: v.array(v.object({
    _id: v.id("headsups"),
    otherHandle: v.string(),
    otherName: v.optional(v.string()),
    otherAgentId: v.string(),
    otherAgentName: v.optional(v.string()),
    kind: v.union(v.literal("area"), v.literal("files")),
    line: v.string(),
    at: v.number(),
    expiresAt: v.number(),
  })),
  handler: async function (ctx) {
    const me = await requireHacker(ctx);
    const now = Date.now();
    const rows = await ctx.db
      .query("headsups")
      .withIndex("by_hacker_at", function (q) {
        return q.eq("hackerId", me._id).gt("at", now - CARD_MS);
      })
      .order("desc")
      .collect();
    const out = [];
    for (const h of rows) {
      if (!isOpen(h, now)) continue;
      const other = await ctx.db.get("hackers", h.otherId);
      if (other === null) continue;
      out.push({
        _id: h._id,
        otherHandle: other.handle,
        otherName: (await supersetCard(ctx, other._id))?.name,
        otherAgentId: h.otherAgentId,
        otherAgentName: await agentName(ctx, other, h.otherAgentId),
        kind: h.kind,
        line: h.line,
        at: h.at,
        expiresAt: h.expiresAt,
      });
    }
    return out;
  },
});

// A heads-up counts as acted on when its owner asks that crewmate's agent, hands the task off or knocks within 10
// minutes of it (operator.setTarget, handoffs, knocks.send call this). Dismissed cards do not count. With an agent (an
// ask), a card about another of that crewmate's open agents does not count; one whose agent cannot be told apart (the
// daemon named it another way, or it came from the ledger) does. The wire hears about it once. Returns how many cards
// it marked.
export async function markActed(
  ctx: MutationCtx,
  hackerId: Id<"hackers">,
  otherId: Id<"hackers">,
  action: "ask" | "handoff" | "knock",
  otherAgentId?: string,
): Promise<number> {
  const now = Date.now();
  const rows = await ctx.db
    .query("headsups")
    .withIndex("by_hacker_at", function (q) {
      return q.eq("hackerId", hackerId).gte("at", now - CARD_MS);
    })
    .collect();
  const theirs = rows.filter(function (h) { return h.otherId === otherId && h.dismissedAt === undefined && h.actedAt === undefined; });
  if (theirs.length === 0) return 0;
  const known = otherAgentId === undefined ? new Set<string>() : new Set((await agentsOn(ctx, otherId)).map(function (a) { return a.agentId; }));
  let first: Doc<"headsups"> | undefined;
  let marked = 0;
  for (const h of theirs) {
    if (otherAgentId !== undefined && h.otherAgentId !== otherAgentId && known.has(h.otherAgentId)) continue;
    await ctx.db.patch("headsups", h._id, { actedAt: now, action });
    first = first ?? h;
    marked += 1;
  }
  if (first !== undefined) await addToFeed(ctx, { kind: "headsup", hackerId, otherHackerId: otherId, text: first.line, at: now });
  return marked;
}

// The card's 10 minutes are up.
export const expire = internalMutation({
  args: { headsupId: v.id("headsups") },
  returns: v.null(),
  handler: async function (ctx, args) {
    const h = await ctx.db.get("headsups", args.headsupId);
    if (h !== null && h.expiredAt === undefined) await ctx.db.patch("headsups", h._id, { expiredAt: Date.now() });
    return null;
  },
});

// Drops heads-ups older than a week, a batch at a time (crons.ts runs it weekly). The week is kept for the count.
export const prune = internalMutation({
  args: {},
  returns: v.null(),
  handler: async function (ctx) {
    const old = await ctx.db
      .query("headsups")
      .withIndex("by_at", function (q) {
        return q.lt("at", Date.now() - KEPT_MS);
      })
      .take(500);
    for (const h of old) await ctx.db.delete("headsups", h._id);
    if (old.length === 500) await ctx.scheduler.runAfter(0, internal.headsups.prune, {});
    return null;
  },
});
