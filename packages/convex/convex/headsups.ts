// ABOUTME: Heads-ups: the owner's Mac saw a prompt about an area a crewmate's agent is on, and the HUD shows a card for 10
// ABOUTME: minutes (a scheduled function ends it). Asking that agent, handing off or knocking counts as acted on. Kept a week.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { addToFeed } from "./feed";
import { areFriends } from "./friends";
import { requireDaemon, requireHacker } from "./lib/auth";
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
    const { hacker } = await requireDaemon(ctx, args.token);
    const other = await ctx.db
      .query("hackers")
      .withIndex("by_handle", function (q) {
        return q.eq("handle", args.otherHandle.replace(/^@/, "").toLowerCase());
      })
      .unique();
    // TODO(crews): isCrewmate
    if (other === null || other._id === hacker._id || !(await areFriends(ctx, hacker._id, other._id))) {
      throw new ConvexError("No crewmate has that handle.");
    }
    const line = redactSecrets(args.line.trim()).slice(0, MAX_LINE);
    if (line === "") throw new ConvexError("A heads-up says what the crewmate's agent is on.");
    const now = Date.now();
    const recent = await ctx.db
      .query("headsups")
      .withIndex("by_hacker_at", function (q) {
        return q.eq("hackerId", hacker._id).gt("at", now - QUIET_MS - CARD_MS);
      })
      .collect();
    const samePair = recent.filter(function (h) { return h.otherId === other._id && h.otherAgentId === args.otherAgentId; });
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
      otherAgentId: args.otherAgentId,
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

// The agent's name, only when its owner shares agent names.
async function agentName(ctx: QueryCtx, owner: Doc<"hackers">, agentId: string): Promise<string | undefined> {
  if (!owner.shareAgentNames) return undefined;
  const subsets = await ctx.db
    .query("subsets")
    .withIndex("by_hacker_machine", function (q) {
      return q.eq("hackerId", owner._id);
    })
    .collect();
  for (const s of subsets) {
    const agent = s.agents.find(function (a) { return a.agentId === agentId && a.open; });
    if (agent !== undefined) return agent.name;
  }
  return undefined;
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
// minutes of it (operator.setTarget, handoffs, knocks.send call this). Dismissed cards do not count. With an agent, only
// cards about that agent. The wire hears about it once. Returns how many cards it marked.
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
  let first: Doc<"headsups"> | undefined;
  let marked = 0;
  for (const h of rows) {
    if (h.otherId !== otherId || h.dismissedAt !== undefined || h.actedAt !== undefined) continue;
    if (otherAgentId !== undefined && h.otherAgentId !== otherAgentId) continue;
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
