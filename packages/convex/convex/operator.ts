// ABOUTME: The Operator. A question goes to the crewmate agent most likely to know; its owner's daemon then sends a slice
// ABOUTME: of that agent's conversation once, straight into the answer call (http.ts). Only the question and answer are kept.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { acceptedFriendIds } from "./friends";
import { requireDaemon, requireHacker } from "./lib/auth";
import { answerFrom, describeError, NOT_CONFIGURED, operatorMode, pickAgent } from "./lib/claude";
import { relayStatus } from "./schema";

const TIMEOUT_MS = 90_000;
const LIVE_MS = 90_000;
const MAX_QUESTION = 500;
// Questions cost the crew money: at most this many per hacker per minute.
const PER_MINUTE = 6;

async function startRelay(ctx: MutationCtx, asker: Doc<"hackers">, question: string): Promise<Id<"relays">> {
  const q = question.trim();
  if (q === "") throw new ConvexError("Ask a question.");
  if (q.length > MAX_QUESTION) throw new ConvexError(`Keep the question under ${MAX_QUESTION} characters.`);
  const now = Date.now();
  const recent = await ctx.db
    .query("relays")
    .withIndex("by_asker", function (r) {
      return r.eq("askerHackerId", asker._id);
    })
    .order("desc")
    .take(PER_MINUTE);
  const oldest = recent[PER_MINUTE - 1];
  if (oldest !== undefined && now - oldest.createdAt < 60_000) throw new ConvexError("That is a lot of questions. Wait a minute.");
  const id = await ctx.db.insert("relays", { askerHackerId: asker._id, question: q, status: "routing", createdAt: now });
  await ctx.scheduler.runAfter(0, internal.operator.route, { relayId: id });
  await ctx.scheduler.runAfter(TIMEOUT_MS, internal.operator.expire, { relayId: id });
  return id;
}

// From an agent, through the ask_operator tool on its machine (the daemon's token).
export const ask = mutation({
  args: { token: v.string(), question: v.string() },
  returns: v.id("relays"),
  handler: async function (ctx, args) {
    const { hacker } = await requireDaemon(ctx, args.token);
    return await startRelay(ctx, hacker, args.question);
  },
});

// From the HUD.
export const askAsHacker = mutation({
  args: { question: v.string() },
  returns: v.id("relays"),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    return await startRelay(ctx, me, args.question);
  },
});

const relayView = v.object({
  _id: v.id("relays"),
  question: v.string(),
  status: relayStatus,
  answer: v.optional(v.string()),
  note: v.optional(v.string()),
  askerHandle: v.string(),
  targetHandle: v.optional(v.string()),
  targetAgentName: v.optional(v.string()),
  tokensRead: v.optional(v.number()),
  tokensSent: v.optional(v.number()),
  createdAt: v.number(),
  finishedAt: v.optional(v.number()),
  // Whether the viewer asked it or their agent answered it.
  role: v.union(v.literal("asked"), v.literal("answered")),
});

async function handleOf(ctx: QueryCtx, id: Id<"hackers"> | undefined): Promise<string | undefined> {
  if (id === undefined) return undefined;
  return (await ctx.db.get("hackers", id))?.handle;
}

async function view(ctx: QueryCtx, r: Doc<"relays">, role: "asked" | "answered") {
  return {
    _id: r._id,
    question: r.question,
    status: r.status,
    answer: r.answer,
    note: r.note,
    askerHandle: (await handleOf(ctx, r.askerHackerId)) ?? "",
    targetHandle: await handleOf(ctx, r.targetHackerId),
    targetAgentName: r.targetAgentName,
    tokensRead: r.tokensRead,
    tokensSent: r.tokensSent,
    createdAt: r.createdAt,
    finishedAt: r.finishedAt,
    role,
  };
}

// What the asking agent's tool waits on.
export const relay = query({
  args: { token: v.string(), relayId: v.id("relays") },
  returns: v.union(v.null(), relayView),
  handler: async function (ctx, args) {
    const { hacker } = await requireDaemon(ctx, args.token);
    const r = await ctx.db.get("relays", args.relayId);
    if (r === null || r.askerHackerId !== hacker._id) return null;
    return await view(ctx, r, "asked");
  },
});

// What this machine's daemon must read now: which of its agents, for which relay. The question is not sent.
export const readsFor = query({
  args: { token: v.string() },
  returns: v.array(v.object({ relayId: v.id("relays"), agentId: v.string() })),
  handler: async function (ctx, args) {
    const { hacker, daemon } = await requireDaemon(ctx, args.token);
    const rows = await ctx.db
      .query("relays")
      .withIndex("by_target_status", function (r) {
        return r.eq("targetHackerId", hacker._id).eq("status", "reading");
      })
      .collect();
    return rows.flatMap(function (r) {
      return r.targetMachine === daemon.machineName && r.targetAgentId !== undefined ? [{ relayId: r._id, agentId: r.targetAgentId }] : [];
    });
  },
});

// The relays a hacker may read: the ones they asked and the ones their agents answered. Newest first.
export const log = query({
  args: {},
  returns: v.array(relayView),
  handler: async function (ctx) {
    const me = await requireHacker(ctx);
    const asked = await ctx.db
      .query("relays")
      .withIndex("by_asker", function (r) {
        return r.eq("askerHackerId", me._id);
      })
      .order("desc")
      .take(20);
    const answered = await ctx.db
      .query("relays")
      .withIndex("by_target_status", function (r) {
        return r.eq("targetHackerId", me._id);
      })
      .take(200);
    const rows: { r: Doc<"relays">; role: "asked" | "answered" }[] = [
      ...asked.map(function (r) { return { r, role: "asked" as const }; }),
      ...answered.map(function (r) { return { r, role: "answered" as const }; }),
    ];
    rows.sort(function (a, b) { return b.r.createdAt - a.r.createdAt; });
    const out = [];
    for (const { r, role } of rows.slice(0, 20)) out.push(await view(ctx, r, role));
    return out;
  },
});

const candidate = v.object({
  hackerId: v.id("hackers"),
  handle: v.string(),
  name: v.optional(v.string()),
  shareAgentNames: v.boolean(),
  machineName: v.string(),
  agentId: v.string(),
  agentName: v.string(),
  workspace: v.optional(v.string()),
  status: v.string(),
  summary: v.optional(v.string()),
});

// A hacker's name from their linked Superset profile, if they linked one: it lets "what is Vlad doing" find @vladimir.
async function linkedName(ctx: QueryCtx, hackerId: Id<"hackers">): Promise<string | undefined> {
  const profile = await ctx.db
    .query("supersetProfiles")
    .withIndex("by_hacker", function (q) {
      return q.eq("hackerId", hackerId);
    })
    .first();
  return profile?.name;
}

// The open, live agents of the asker's crewmates, with their routing summaries. For now the crew is the asker's friends.
export const candidates = internalQuery({
  args: { relayId: v.id("relays") },
  returns: v.union(v.null(), v.object({ question: v.string(), candidates: v.array(candidate) })),
  handler: async function (ctx, args) {
    const relay = await ctx.db.get("relays", args.relayId);
    if (relay === null || relay.status !== "routing") return null;
    const now = Date.now();
    const out = [];
    for (const id of await acceptedFriendIds(ctx, relay.askerHackerId)) {
      const hacker = await ctx.db.get("hackers", id);
      if (hacker === null) continue;
      const name = await linkedName(ctx, id);
      const subsets = await ctx.db
        .query("subsets")
        .withIndex("by_hacker_machine", function (s) {
          return s.eq("hackerId", id);
        })
        .collect();
      for (const subset of subsets) {
        if (now - subset.updatedAt >= LIVE_MS) continue;
        for (const agent of subset.agents) {
          if (!agent.open) continue;
          const summary = await ctx.db
            .query("routingSummaries")
            .withIndex("by_hacker_agent", function (s) {
              return s.eq("hackerId", id).eq("agentId", agent.agentId);
            })
            .unique();
          out.push({
            hackerId: id,
            handle: hacker.handle,
            name,
            shareAgentNames: hacker.shareAgentNames,
            machineName: subset.machineName,
            agentId: agent.agentId,
            agentName: agent.name,
            workspace: agent.workspace,
            status: agent.status,
            summary: summary?.summary,
          });
        }
      }
    }
    return { question: relay.question, candidates: out };
  },
});

export const route = internalAction({
  args: { relayId: v.id("relays") },
  returns: v.null(),
  handler: async function (ctx, args) {
    const found = await ctx.runQuery(internal.operator.candidates, { relayId: args.relayId });
    if (found === null) return null;
    async function end(status: "nobody" | "error", note: string): Promise<null> {
      await ctx.runMutation(internal.operator.finish, { relayId: args.relayId, status, note });
      return null;
    }
    if (found.candidates.length === 0) return await end("nobody", "No crewmate has an open agent running right now.");
    if (operatorMode() === null) return await end("error", NOT_CONFIGURED);
    let index: number | null;
    try {
      index = await pickAgent(found.question, found.candidates);
    } catch (e) {
      return await end("error", describeError(e));
    }
    const chosen = index === null ? undefined : found.candidates[index];
    if (chosen === undefined) return await end("nobody", "None of your crewmates' agents seems to know about this.");
    await ctx.runMutation(internal.operator.setTarget, {
      relayId: args.relayId,
      targetHackerId: chosen.hackerId,
      targetMachine: chosen.machineName,
      targetAgentId: chosen.agentId,
      targetAgentName: chosen.shareAgentNames ? chosen.agentName : undefined,
    });
    return null;
  },
});

export const setTarget = internalMutation({
  args: {
    relayId: v.id("relays"),
    targetHackerId: v.id("hackers"),
    targetMachine: v.string(),
    targetAgentId: v.string(),
    targetAgentName: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async function (ctx, args) {
    const relay = await ctx.db.get("relays", args.relayId);
    if (relay === null || relay.status !== "routing") return null;
    const { relayId, ...target } = args;
    await ctx.db.patch("relays", relayId, { ...target, status: "reading" });
    return null;
  },
});

// Ends a relay that is still open. A late answer after a timeout changes nothing.
export const finish = internalMutation({
  args: {
    relayId: v.id("relays"),
    status: v.union(v.literal("answered"), v.literal("not-found"), v.literal("nobody"), v.literal("timeout"), v.literal("error")),
    answer: v.optional(v.string()),
    note: v.optional(v.string()),
    tokensRead: v.optional(v.number()),
    tokensSent: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async function (ctx, args) {
    const relay = await ctx.db.get("relays", args.relayId);
    if (relay === null || (relay.status !== "routing" && relay.status !== "reading")) return null;
    const { relayId, ...result } = args;
    await ctx.db.patch("relays", relayId, { ...result, finishedAt: Date.now() });
    return null;
  },
});

export const expire = internalMutation({
  args: { relayId: v.id("relays") },
  returns: v.null(),
  handler: async function (ctx, args) {
    const relay = await ctx.db.get("relays", args.relayId);
    if (relay === null || (relay.status !== "routing" && relay.status !== "reading")) return null;
    await ctx.db.patch("relays", args.relayId, {
      status: "timeout",
      note: relay.status === "reading" ? "The crewmate's machine did not answer in time." : "Routing took too long.",
      finishedAt: Date.now(),
    });
    return null;
  },
});

// For the answer endpoint, which gets the relay id as plain text: the relay and its question, if this daemon is the
// one the relay waits on.
export const relayForDaemon = internalQuery({
  args: { token: v.string(), relayId: v.string() },
  returns: v.union(
    v.null(),
    v.object({ relayId: v.id("relays"), question: v.string(), owner: v.object({ handle: v.string(), name: v.optional(v.string()) }) }),
  ),
  handler: async function (ctx, args) {
    const { hacker, daemon } = await requireDaemon(ctx, args.token);
    const relayId = ctx.db.normalizeId("relays", args.relayId);
    const relay = relayId === null ? null : await ctx.db.get("relays", relayId);
    if (relay === null || relay.status !== "reading") return null;
    if (relay.targetHackerId !== hacker._id || relay.targetMachine !== daemon.machineName) return null;
    // Whose agent is read, so the answer credits the work to them and to nobody else.
    return { relayId: relay._id, question: relay.question, owner: { handle: hacker.handle, name: await linkedName(ctx, hacker._id) } };
  },
});

const dryRunCandidate = v.object({
  handle: v.string(),
  name: v.optional(v.string()),
  agentName: v.string(),
  workspace: v.optional(v.string()),
  status: v.string(),
  summary: v.optional(v.string()),
});

// Tries the Operator's two Claude calls on made-up agents, to check the prompts against the real model:
// npx convex run --prod operator:dryRun '{"question": "...", "candidates": [...], "context": "...", "owner": "tom"}'
// Reads no hacker's data and stores nothing.
export const dryRun = internalAction({
  args: { question: v.string(), candidates: v.array(dryRunCandidate), context: v.optional(v.string()), owner: v.optional(v.string()) },
  returns: v.object({ picked: v.union(v.null(), v.string()), answer: v.union(v.null(), v.string()) }),
  handler: async function (_ctx, args) {
    const index = await pickAgent(args.question, args.candidates);
    const picked = index === null ? null : (args.candidates[index]?.handle ?? null);
    const answer = args.context === undefined || args.owner === undefined
      ? null
      : (await answerFrom(args.question, args.context, { handle: args.owner })).text;
    return { picked, answer };
  },
});
