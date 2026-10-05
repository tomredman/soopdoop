// ABOUTME: The Operator. A question goes to the crewmate agent most likely to know, whose owner's daemon asks it and sends back
// ABOUTME: its answer once (http.ts), or the Operator answers from the routing summaries. It never reads a conversation; only the question and answer are kept.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { acceptedFriendIds } from "./friends";
import { requireDaemon, requireHacker } from "./lib/auth";
import {
  absentNote,
  answerFrom,
  chatTurn,
  type ChatTurn,
  describeError,
  mentionNote,
  NOT_CONFIGURED,
  operatorMode,
  resolveMentions,
  type Route,
  routeQuestion,
} from "./lib/claude";
import { relayStatus } from "./schema";

const TIMEOUT_MS = 90_000;
const LIVE_MS = 90_000;
const MAX_QUESTION = 500;
// Questions cost the crew money: at most this many per hacker per minute.
const PER_MINUTE = 6;

async function startRelay(ctx: MutationCtx, asker: Doc<"hackers">, question: string, via?: "chat"): Promise<Id<"relays">> {
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
  const id = await ctx.db.insert("relays", { askerHackerId: asker._id, question: q, status: "routing", createdAt: now, via });
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

// From the HUD of apps before the chat.
export const askAsHacker = mutation({
  args: { question: v.string() },
  returns: v.id("relays"),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    return await startRelay(ctx, me, args.question);
  },
});

// A message in the Operator chat (the app). The Operator answers it itself, or asks a crewmate's agent (route).
export const chat = mutation({
  args: { text: v.string() },
  returns: v.id("relays"),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    return await startRelay(ctx, me, args.text, "chat");
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
  via: v.optional(v.literal("chat")),
  byOperator: v.optional(v.boolean()),
  askAgain: v.optional(v.boolean()),
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
    via: r.via,
    byOperator: r.byOperator,
    askAgain: r.askAgain,
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

// What this machine's daemon must answer now: which of its agents, for which relay, and the question to ask that agent.
// Daemons before the question was sent ignore it and send a slice of the conversation instead (http.ts).
export const readsFor = query({
  args: { token: v.string() },
  returns: v.array(v.object({ relayId: v.id("relays"), agentId: v.string(), question: v.string() })),
  handler: async function (ctx, args) {
    const { hacker, daemon } = await requireDaemon(ctx, args.token);
    const rows = await ctx.db
      .query("relays")
      .withIndex("by_target_status", function (r) {
        return r.eq("targetHackerId", hacker._id).eq("status", "reading");
      })
      .collect();
    return rows.flatMap(function (r) {
      return r.targetMachine === daemon.machineName && r.targetAgentId !== undefined
        ? [{ relayId: r._id, agentId: r.targetAgentId, question: r.routedQuestion ?? r.question }]
        : [];
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

// The Operator chat: my messages and its replies, oldest first, the last 30.
export const chatLog = query({
  args: {},
  returns: v.array(relayView),
  handler: async function (ctx) {
    const me = await requireHacker(ctx);
    const mine = await ctx.db
      .query("relays")
      .withIndex("by_asker", function (r) {
        return r.eq("askerHackerId", me._id);
      })
      .order("desc")
      .take(200);
    const out = [];
    for (const r of mine.filter(function (x) { return x.via === "chat"; }).slice(0, 30).reverse()) out.push(await view(ctx, r, "asked"));
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

const crewmate = v.object({ handle: v.string(), name: v.optional(v.string()), supersetHandle: v.optional(v.string()) });

// A hacker's linked Superset profile, if they linked one: its name lets "what is Vlad doing" find @vladimir, and an
// @mention of its handle finds them too.
async function linkedProfile(ctx: QueryCtx, hackerId: Id<"hackers">): Promise<{ handle: string; name?: string } | undefined> {
  const profile = await ctx.db
    .query("supersetProfiles")
    .withIndex("by_hacker", function (q) {
      return q.eq("hackerId", hackerId);
    })
    .first();
  return profile === null ? undefined : { handle: profile.handle, name: profile.name };
}

// The asker's crew (for now, their friends), and their open, live agents with the routing summaries.
export const candidates = internalQuery({
  args: { relayId: v.id("relays") },
  returns: v.union(v.null(), v.object({
    question: v.string(),
    via: v.optional(v.literal("chat")),
    asker: v.string(),
    // For a chat message: the chat so far (the last few finished turns), so a follow-up makes sense.
    history: v.array(v.object({ you: v.string(), operator: v.string() })),
    // Everyone in the crew, agents or not, so an @mention can be matched to the right person.
    crew: v.array(crewmate),
    candidates: v.array(candidate),
  })),
  handler: async function (ctx, args) {
    const relay = await ctx.db.get("relays", args.relayId);
    if (relay === null || relay.status !== "routing") return null;
    const history: { you: string; operator: string }[] = [];
    if (relay.via === "chat") {
      const earlier = await ctx.db
        .query("relays")
        .withIndex("by_asker", function (r) {
          return r.eq("askerHackerId", relay.askerHackerId);
        })
        .order("desc")
        .take(40);
      const turns = earlier
        .filter(function (r) { return r.via === "chat" && r._id !== relay._id && r.status !== "routing" && r.status !== "reading"; })
        .slice(0, 6)
        .reverse();
      for (const r of turns) {
        const target = r.byOperator === true ? undefined : await handleOf(ctx, r.targetHackerId);
        const said = r.answer ?? r.note ?? "No answer.";
        history.push({ you: r.question, operator: target === undefined ? said : `(asked @${target}'s agent) ${said}` });
      }
    }
    const asker = (await handleOf(ctx, relay.askerHackerId)) ?? "";
    const now = Date.now();
    const crew = [];
    const out = [];
    for (const id of await acceptedFriendIds(ctx, relay.askerHackerId)) {
      const hacker = await ctx.db.get("hackers", id);
      if (hacker === null) continue;
      const profile = await linkedProfile(ctx, id);
      const name = profile?.name;
      crew.push({ handle: hacker.handle, name, supersetHandle: profile?.handle });
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
    crew.sort(function (a, b) { return a.handle.localeCompare(b.handle); });
    return { question: relay.question, via: relay.via, asker, history, crew, candidates: out };
  },
});

export const route = internalAction({
  args: { relayId: v.id("relays") },
  returns: v.null(),
  // The return type is written out: one return reads `found`, whose type comes from this module's own API.
  handler: async function (ctx, args): Promise<null> {
    const found = await ctx.runQuery(internal.operator.candidates, { relayId: args.relayId });
    if (found === null) return null;
    async function end(status: "nobody" | "error", note: string, askAgain?: boolean): Promise<null> {
      await ctx.runMutation(internal.operator.finish, { relayId: args.relayId, status, note, askAgain });
      return null;
    }
    // The Operator answers itself: no agent is asked.
    async function reply(answer: string): Promise<null> {
      await ctx.runMutation(internal.operator.finish, { relayId: args.relayId, status: "answered", answer, byOperator: true });
      return null;
    }
    // "@ada" means @adalovelace when she is the only crewmate it fits. A name that fits nobody, or more than one
    // crewmate, gets the crew's handles back, so the asker can fix it.
    const mentions = resolveMentions(found.question, found.crew, found.asker);
    if (mentions.unknown.length > 0 || mentions.unclear.length > 0) {
      const note = mentionNote(mentions, found.crew);
      // With nobody in the crew, there is no handle to fix.
      return found.via === "chat" ? await reply(note) : await end("nobody", note, found.crew.length > 0 ? true : undefined);
    }
    const question = mentions.question;
    // A chat message: the Operator answers it itself, or asks one agent a question that stands alone.
    if (found.via === "chat") {
      if (operatorMode() === null) return await end("error", NOT_CONFIGURED);
      let turn: ChatTurn;
      try {
        turn = await chatTurn(question, found.history, found.candidates, found.asker);
      } catch (e) {
        return await end("error", describeError(e));
      }
      if ("reply" in turn) return await reply(turn.reply);
      const picked = found.candidates[turn.ask];
      if (picked === undefined) return await end("nobody", "I couldn't find the right agent for that.");
      await ctx.runMutation(internal.operator.setTarget, {
        relayId: args.relayId,
        targetHackerId: picked.hackerId,
        targetMachine: picked.machineName,
        targetAgentId: picked.agentId,
        targetAgentName: picked.shareAgentNames ? picked.agentName : undefined,
        routedQuestion: turn.question,
      });
      return null;
    }
    if (found.candidates.length === 0) return await end("nobody", "No crewmate has an open agent running right now.");
    const absent = absentNote(question, found.candidates, found.asker);
    if (absent !== null) return await end("nobody", absent);
    if (operatorMode() === null) return await end("error", NOT_CONFIGURED);
    let routed: Route;
    try {
      routed = await routeQuestion(question, found.candidates);
    } catch (e) {
      return await end("error", describeError(e));
    }
    // "What is @jimmy working on?": the summaries answer it, and no agent is asked.
    if (routed !== null && "reply" in routed) return await reply(routed.reply);
    const chosen = routed === null ? undefined : found.candidates[routed.ask];
    if (chosen === undefined) return await end("nobody", "None of your crewmates' agents seems to know about this.");
    await ctx.runMutation(internal.operator.setTarget, {
      relayId: args.relayId,
      targetHackerId: chosen.hackerId,
      targetMachine: chosen.machineName,
      targetAgentId: chosen.agentId,
      targetAgentName: chosen.shareAgentNames ? chosen.agentName : undefined,
      // With its @mentions matched to handles: the agent is asked this, and its answer is checked against it.
      routedQuestion: question === found.question ? undefined : question,
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
    routedQuestion: v.optional(v.string()),
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
    byOperator: v.optional(v.boolean()),
    askAgain: v.optional(v.boolean()),
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
    const owner = { handle: hacker.handle, name: (await linkedProfile(ctx, hacker._id))?.name };
    return { relayId: relay._id, question: relay.routedQuestion ?? relay.question, owner };
  },
});

// Deletes relays by id: for a wrong answer that should not stay on anyone's wire. XP is counted from relays, so any
// assist it gave goes too. Internal, so no app can call it: npx convex run --prod operator:forget '{"relayIds": ["…"]}'
export const forget = internalMutation({
  args: { relayIds: v.array(v.string()) },
  returns: v.number(),
  handler: async function (ctx, args) {
    let deleted = 0;
    for (const raw of args.relayIds) {
      const id = ctx.db.normalizeId("relays", raw);
      if (id === null || (await ctx.db.get("relays", id)) === null) continue;
      await ctx.db.delete("relays", id);
      deleted += 1;
    }
    return deleted;
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

// Tries the Operator's Claude calls on made-up agents, to check the prompts against the real model:
// npx convex run --prod operator:dryRun '{"question": "...", "candidates": [...], "context": "...", "owner": "tom"}'
// `picked` is the agent's owner the question would go to; `reply`, the Operator's own answer from the summaries instead.
// With "chatAs": "tom" (and "history"), it also runs one turn of the chat. Reads no hacker's data and stores nothing.
export const dryRun = internalAction({
  args: {
    question: v.string(),
    candidates: v.array(dryRunCandidate),
    context: v.optional(v.string()),
    owner: v.optional(v.string()),
    chatAs: v.optional(v.string()),
    history: v.optional(v.array(v.object({ you: v.string(), operator: v.string() }))),
  },
  returns: v.object({
    picked: v.union(v.null(), v.string()),
    reply: v.optional(v.string()),
    answer: v.union(v.null(), v.string()),
    chat: v.optional(v.string()),
  }),
  handler: async function (_ctx, args) {
    const routed = await routeQuestion(args.question, args.candidates);
    const picked = routed === null || "reply" in routed ? null : (args.candidates[routed.ask]?.handle ?? null);
    const reply = routed !== null && "reply" in routed ? routed.reply : undefined;
    const answer = args.context === undefined || args.owner === undefined
      ? null
      : (await answerFrom(args.question, args.context, { handle: args.owner })).text;
    if (args.chatAs === undefined) return { picked, reply, answer };
    const turn = await chatTurn(args.question, args.history ?? [], args.candidates, args.chatAs);
    const chat = "reply" in turn ? `reply: ${turn.reply}` : `ask @${args.candidates[turn.ask]?.handle ?? "?"}: ${turn.question}`;
    return { picked, reply, answer, chat };
  },
});
