// ABOUTME: The Operator. A question goes to the crewmate agent most likely to know, whose owner's daemon asks it and sends back
// ABOUTME: its answer once (http.ts); or the Operator answers from the summaries and the ledger, or offers a work order as a hand-off. It never reads a conversation.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { addToFeed, tokensSaved } from "./feed";
import { acceptedFriendIds, areFriends } from "./friends";
import { markActed } from "./headsups";
import { hasOpenKnock, insertKnock, KNOCK_MS } from "./knocks";
import { hitView, searchLedger } from "./ledger";
import { requireDaemon, requireHacker } from "./lib/auth";
import {
  absentNote,
  answerFrom,
  chatTurn,
  type ChatTurn,
  describeError,
  handoffNote,
  type Meter,
  mentionNote,
  NOT_CONFIGURED,
  operatorMode,
  resolveMentions,
  type Route,
  routeQuestion,
} from "./lib/claude";
import { crewOf, limitsFor } from "./lib/plan";
import { relayStatus } from "./schema";

const TIMEOUT_MS = 90_000;
const LIVE_MS = 90_000;
const MAX_QUESTION = 500;
// Questions cost the crew money: at most this many per hacker per minute, and the plan's number per crew per day.
const PER_MINUTE = 6;
const DAY_MS = 24 * 60 * 60 * 1000;
// The Operator looks at the last two weeks of the crew's ledger.
const LEDGER_DAYS = 14;
// The chat sees the crew's newest live notes. A note unconfirmed for 45 days is no longer delivered.
const NOTES_SHOWN = 10;
const NOTE_STALE_MS = 45 * DAY_MS;

// The crew's questions to the Operator in the last day, counted up to `limit`. A chat message the Operator answered
// itself is a relay too, but it is not a question to the crew, so it does not count.
async function questionsToday(ctx: QueryCtx, asker: Id<"hackers">, since: number, limit: number): Promise<number> {
  let n = 0;
  // TODO(crews): crewmateIds. The crew's questions; for now the asker's and their friends'.
  for (const id of [asker, ...(await acceptedFriendIds(ctx, asker))]) {
    const recent = ctx.db
      .query("relays")
      .withIndex("by_asker", function (r) {
        return r.eq("askerHackerId", id);
      })
      .order("desc");
    for await (const r of recent) {
      if (r.createdAt < since) break;
      if (r.byOperator !== true) n += 1;
      if (n >= limit) return n;
    }
  }
  return n;
}

// Who asked, when an agent asked: its machine, and its session when the tool knows it.
interface AskedFrom {
  machine?: string;
  agentId?: string;
}

async function startRelay(ctx: MutationCtx, asker: Doc<"hackers">, question: string, via?: "chat", from: AskedFrom = {}): Promise<Id<"relays">> {
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
  const crew = await crewOf(ctx, asker._id);
  const perDay = limitsFor(crew).questionsPerDay;
  if ((await questionsToday(ctx, asker._id, now - DAY_MS, perDay)) >= perDay) {
    throw new ConvexError(`Your crew used today's questions (${perDay} on the ${crew?.plan ?? "free"} plan).`);
  }
  const id = await ctx.db.insert("relays", {
    askerHackerId: asker._id,
    question: q,
    status: "routing",
    createdAt: now,
    via,
    askerMachine: from.machine,
    askerAgentId: from.agentId,
  });
  await ctx.scheduler.runAfter(0, internal.operator.route, { relayId: id });
  await ctx.scheduler.runAfter(TIMEOUT_MS, internal.operator.expire, { relayId: id });
  return id;
}

// From an agent, through the ask_operator tool on its machine (the daemon's token). `agentId` names the asking session
// when the tool knows it, so a hand-off the Operator offers for it is reported back to that session.
export const ask = mutation({
  args: { token: v.string(), question: v.string(), agentId: v.optional(v.string()) },
  returns: v.id("relays"),
  handler: async function (ctx, args) {
    const { hacker, daemon } = await requireDaemon(ctx, args.token);
    return await startRelay(ctx, hacker, args.question, undefined, { machine: daemon.machineName, agentId: args.agentId });
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
  // A work order the Operator offered as a hand-off.
  handoffId: v.optional(v.id("handoffs")),
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
    handoffId: r.handoffId,
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
// The asker's handle comes along for the daemon's anti-hijacking fund, which gives each crewmate a share.
export const readsFor = query({
  args: { token: v.string() },
  returns: v.array(v.object({ relayId: v.id("relays"), agentId: v.string(), question: v.string(), asker: v.optional(v.string()) })),
  handler: async function (ctx, args) {
    const { hacker, daemon } = await requireDaemon(ctx, args.token);
    const rows = await ctx.db
      .query("relays")
      .withIndex("by_target_status", function (r) {
        return r.eq("targetHackerId", hacker._id).eq("status", "reading");
      })
      .collect();
    const out = [];
    for (const r of rows) {
      if (r.targetMachine !== daemon.machineName || r.targetAgentId === undefined) continue;
      out.push({ relayId: r._id, agentId: r.targetAgentId, question: r.routedQuestion ?? r.question, asker: await handleOf(ctx, r.askerHackerId) });
    }
    return out;
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

const crewmate = v.object({
  hackerId: v.id("hackers"),
  handle: v.string(),
  name: v.optional(v.string()),
  supersetHandle: v.optional(v.string()),
});

// A crewmate's ledger line that fits the question. `live`: that crewmate has an open agent running (a candidate).
const pastWork = v.object({ ...hitView.fields, live: v.boolean() });

// The crew's live notes, newest first, without the ones nobody confirmed in 45 days. TODO(crews): notes.ts (agent A1)
// may grow a helper for this; the notes table is read directly until then.
async function crewNotes(ctx: QueryCtx, hackerId: Id<"hackers">, now: number): Promise<string[]> {
  const crew = await crewOf(ctx, hackerId);
  if (crew === null) return [];
  const live = await ctx.db
    .query("notes")
    .withIndex("by_crew_status", function (q) {
      return q.eq("crewId", crew._id).eq("status", "live");
    })
    .collect();
  return live
    .filter(function (n) { return now - (n.confirmedAt ?? n.createdAt) < NOTE_STALE_MS; })
    .sort(function (a, b) { return b.updatedAt - a.updatedAt; })
    .slice(0, NOTES_SHOWN)
    .map(function (n) { return n.text; });
}

// A hacker's linked Superset profile, if they linked one: its name lets "what is Hedy doing" find @hedylamarr, and an
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

// The asker's crew (for now, their friends): everyone in it, their open, live agents with the routing summaries, their
// ledger lines that fit the question, and the crew's notes.
export const candidates = internalQuery({
  args: { relayId: v.id("relays") },
  returns: v.union(v.null(), v.object({
    question: v.string(),
    via: v.optional(v.literal("chat")),
    asker: v.string(),
    askerId: v.id("hackers"),
    // An agent asked: its machine and session, so a hand-off offered for it is reported back there.
    askerMachine: v.optional(v.string()),
    askerAgentId: v.optional(v.string()),
    // For a chat message: the chat so far (the last few finished turns), so a follow-up makes sense.
    history: v.array(v.object({ you: v.string(), operator: v.string() })),
    // Everyone in the crew, agents or not, so an @mention can be matched to the right person.
    crew: v.array(crewmate),
    candidates: v.array(candidate),
    // Crewmates' ledger lines of the last two weeks that fit the question, best first, at most 8.
    ledger: v.array(pastWork),
    // The crew's live notes, newest first, for the chat.
    notes: v.array(v.string()),
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
      crew.push({ hackerId: id, handle: hacker.handle, name, supersetHandle: profile?.handle });
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
    const live = new Set(out.map(function (c) { return c.hackerId; }));
    const ledger = (await searchLedger(ctx, relay.askerHackerId, relay.question, LEDGER_DAYS)).map(function (l) {
      return { ...l, live: live.has(l.hackerId) };
    });
    return {
      question: relay.question,
      via: relay.via,
      asker,
      askerId: relay.askerHackerId,
      askerMachine: relay.askerMachine,
      askerAgentId: relay.askerAgentId,
      history,
      crew,
      candidates: out,
      ledger,
      notes: await crewNotes(ctx, relay.askerHackerId, now),
    };
  },
});

// Why an offer or a knock could not be made, in the words the mutation used. Convex sends an error's data across a
// function call as JSON, and a runtime may hand it over still encoded ("\"…\""), so a string is decoded once more.
export function reasonOf(e: unknown): string {
  if (!(e instanceof ConvexError) || typeof e.data !== "string") return describeError(e);
  const data: string = e.data;
  if (data.startsWith("\"")) {
    try {
      const decoded: unknown = JSON.parse(data);
      if (typeof decoded === "string") return decoded;
    } catch {
      // Not JSON: the words as they are.
    }
  }
  return data;
}

export const route = internalAction({
  args: { relayId: v.id("relays") },
  returns: v.null(),
  // The return type is written out: one return reads `found`, whose type comes from this module's own API.
  handler: async function (ctx, args): Promise<null> {
    const maybe = await ctx.runQuery(internal.operator.candidates, { relayId: args.relayId });
    if (maybe === null) return null;
    const found = maybe;
    // What this relay's own Claude calls cost; kept on the relay for the crew's cost line.
    const meter: Meter = { usd: 0 };
    function spent(): number | undefined {
      return meter.usd > 0 ? meter.usd : undefined;
    }
    async function end(status: "nobody" | "error", note: string, askAgain?: boolean): Promise<null> {
      await ctx.runMutation(internal.operator.finish, { relayId: args.relayId, status, note, askAgain, usd: spent() });
      return null;
    }
    // The Operator answers itself: no agent is asked.
    async function reply(answer: string, handoffId?: Id<"handoffs">): Promise<null> {
      await ctx.runMutation(internal.operator.finish, { relayId: args.relayId, status: "answered", answer, byOperator: true, handoffId, usd: spent() });
      return null;
    }
    async function askAgent(c: (typeof found.candidates)[number], routedQuestion: string | undefined): Promise<null> {
      await ctx.runMutation(internal.operator.setTarget, {
        relayId: args.relayId,
        targetHackerId: c.hackerId,
        targetMachine: c.machineName,
        targetAgentId: c.agentId,
        targetAgentName: c.shareAgentNames ? c.agentName : undefined,
        routedQuestion,
        usd: spent(),
      });
      return null;
    }
    // A work order becomes an offer from the asker to a crewmate (to their agent, when one was picked). The crewmate
    // approves it before anything runs. Returns the hand-off and what to tell the asker, or why it could not be made.
    async function offer(toId: Id<"hackers">, task: string, targetAgentId?: string): Promise<{ handoffId: Id<"handoffs">; said: string } | { problem: string }> {
      try {
        const made = await ctx.runMutation(internal.handoffs.offerInternal, {
          fromId: found.askerId,
          toId,
          text: task,
          targetAgentId,
          relayId: args.relayId,
          fromMachine: found.askerMachine,
          fromAgentId: found.askerAgentId,
        });
        return { handoffId: made.handoffId, said: handoffNote(made.toHandle, made.targetAgentName, found.askerMachine !== undefined) };
      } catch (e) {
        return { problem: reasonOf(e) };
      }
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
    // Past work whose owner has no agent running: the Operator may answer from it, or offer a hand-off to its owner.
    const past = found.ledger.filter(function (l) { return !l.live; });
    // A chat message: the Operator answers it itself (after searching the ledger or reading the notes, if it likes),
    // asks one agent a question that stands alone, offers a hand-off or knocks.
    if (found.via === "chat") {
      if (operatorMode() === null) return await end("error", NOT_CONFIGURED);
      let turn: ChatTurn;
      try {
        turn = await chatTurn(question, found.history, found.candidates, found.asker, {
          past,
          notes: found.notes,
          crew: found.crew,
          meter,
          searchLedger: async function (query: string) {
            return await ctx.runQuery(internal.ledger.search, { hackerId: found.askerId, query, days: LEDGER_DAYS });
          },
        });
      } catch (e) {
        return await end("error", describeError(e));
      }
      // The offer and the knock the turn decided on. When one cannot be made (consent off, the day's limit, focus
      // mode), the asker reads why instead of the reply that assumed it went.
      let handoffId: Id<"handoffs"> | undefined;
      let problem: string | undefined;
      const offered = turn.offered;
      if (offered !== undefined) {
        const live = offered.agent === undefined ? undefined : found.candidates[offered.agent];
        const toId = live?.hackerId ?? found.crew.find(function (c) { return c.handle === offered.handle; })?.hackerId;
        const made = toId === undefined ? { problem: "I couldn't find that crewmate." } : await offer(toId, offered.task, live?.agentId);
        if ("problem" in made) problem = made.problem;
        else handoffId = made.handoffId;
      }
      if (turn.knocked !== undefined) {
        try {
          await ctx.runMutation(internal.operator.knock, { fromId: found.askerId, toHandle: turn.knocked.handle, note: turn.knocked.note });
        } catch (e) {
          problem = problem ?? reasonOf(e);
        }
      }
      if ("reply" in turn) return await reply(problem ?? turn.reply, handoffId);
      const picked = found.candidates[turn.ask];
      if (picked === undefined) return await end("nobody", "I couldn't find the right agent for that.");
      return await askAgent(picked, turn.question);
    }
    if (found.candidates.length === 0 && found.ledger.length === 0) return await end("nobody", "No crewmate has an open agent running right now.");
    const absent = absentNote(question, found.candidates, found.asker, found.ledger);
    if (absent !== null) return await end("nobody", absent);
    if (operatorMode() === null) return await end("error", NOT_CONFIGURED);
    let routed: Route;
    try {
      routed = await routeQuestion(question, found.candidates, { past, meter });
    } catch (e) {
      return await end("error", describeError(e));
    }
    // "What is @jimmy working on?", or a who-question the ledger answers: no agent is asked.
    if (routed !== null && "reply" in routed) return await reply(routed.reply);
    // A work order: offered to the crewmate whose agent (or past work) fits it.
    if (routed !== null && "handoff" in routed) {
      const live = found.candidates[routed.handoff];
      const toId = live?.hackerId ?? past[routed.handoff - found.candidates.length]?.hackerId;
      if (toId === undefined) return await end("nobody", "None of your crewmates' agents seems to know about this.");
      const made = await offer(toId, routed.task, live?.agentId);
      return "problem" in made ? await end("nobody", made.problem) : await reply(made.said, made.handoffId);
    }
    const chosen = routed === null ? undefined : found.candidates[routed.ask];
    if (chosen === undefined) {
      return await end("nobody", found.candidates.length === 0
        ? "No crewmate has an open agent running right now."
        : "None of your crewmates' agents seems to know about this.");
    }
    // With its @mentions matched to handles: the agent is asked this, and its answer is checked against it.
    return await askAgent(chosen, question === found.question ? undefined : question);
  },
});

// Adds what one more Claude call cost to what a relay already cost.
function plusUsd(had: number | undefined, more: number | undefined): number | undefined {
  return more === undefined ? had : (had ?? 0) + more;
}

export const setTarget = internalMutation({
  args: {
    relayId: v.id("relays"),
    targetHackerId: v.id("hackers"),
    targetMachine: v.string(),
    targetAgentId: v.string(),
    targetAgentName: v.optional(v.string()),
    routedQuestion: v.optional(v.string()),
    usd: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async function (ctx, args) {
    const relay = await ctx.db.get("relays", args.relayId);
    if (relay === null || relay.status !== "routing") return null;
    const { relayId, usd, ...target } = args;
    await ctx.db.patch("relays", relayId, { ...target, status: "reading", usd: plusUsd(relay.usd, usd) });
    // Asking a crewmate's agent right after a heads-up about their work is acting on it.
    await markActed(ctx, relay.askerHackerId, args.targetHackerId, "ask");
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
    // The Operator offered the question, a work order, as this hand-off.
    handoffId: v.optional(v.id("handoffs")),
    // What the Operator's own Claude calls cost since the relay was last written; added to what it cost before.
    usd: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async function (ctx, args) {
    const relay = await ctx.db.get("relays", args.relayId);
    if (relay === null || (relay.status !== "routing" && relay.status !== "reading")) return null;
    const { relayId, usd, ...result } = args;
    const now = Date.now();
    await ctx.db.patch("relays", relayId, { ...result, usd: plusUsd(relay.usd, usd), finishedAt: now });
    // A crewmate's agent answered: the crew's wire hears about it, with what it saved the asker.
    if (args.status === "answered" && args.byOperator !== true && relay.targetHackerId !== undefined) {
      await addToFeed(ctx, { kind: "answer", hackerId: relay.targetHackerId, otherHackerId: relay.askerHackerId, tokensSaved: tokensSaved(args), at: now });
    }
    return null;
  },
});

// A knock the chat sends for the asker (its knock tool), under the same rules as knocks.send.
export const knock = internalMutation({
  args: { fromId: v.id("hackers"), toHandle: v.string(), note: v.string() },
  returns: v.id("knocks"),
  handler: async function (ctx, args) {
    const from = await ctx.db.get("hackers", args.fromId);
    const to = await ctx.db
      .query("hackers")
      .withIndex("by_handle", function (q) {
        return q.eq("handle", args.toHandle.trim().replace(/^@/, "").toLowerCase());
      })
      .unique();
    if (from === null || to === null) throw new ConvexError("ain’t nobody with that handle");
    // TODO(crews): isCrewmate
    if (!(await areFriends(ctx, from._id, to._id))) throw new ConvexError("You can only knock on a crewmate.");
    const now = Date.now();
    if (to.focusUntil !== undefined && to.focusUntil > now) throw new ConvexError(`@${to.handle} is in focus mode. Try later.`);
    if (await hasOpenKnock(ctx, from._id, to._id)) throw new ConvexError(`You already have a knock waiting with @${to.handle}.`);
    const note = args.note.trim().slice(0, 120);
    const id = await insertKnock(ctx, {
      from: from._id,
      to: to._id,
      item: { kind: "session", title: `a knock from @${from.handle}, through the Operator` },
      note: note === "" ? undefined : note,
      lifetimeMs: KNOCK_MS,
      now,
    });
    await markActed(ctx, from._id, to._id, "knock");
    return id;
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

// A made-up line of past work, for dry runs.
const dryRunPast = v.object({
  handle: v.string(),
  name: v.optional(v.string()),
  did: v.string(),
  areas: v.array(v.string()),
  at: v.number(),
  workspace: v.optional(v.string()),
});

// Tries the Operator's Claude calls on made-up agents, to check the prompts against the real model:
// npx convex run operator:dryRun '{"question": "...", "candidates": [...], "past": [...], "context": "...", "owner": "tom"}'
// `picked` is the agent's owner the question would go to; `reply`, the Operator's own answer from the summaries or the
// ledger instead; `handoff`, whom a work order would be offered to, and the task. With "chatAs": "tom" (and "history",
// "notes"), it also runs one turn of the chat with its tools (the ledger search covers `past`; offers and knocks are
// only described). `usd` is what the calls cost. Reads no hacker's data and stores nothing.
export const dryRun = internalAction({
  args: {
    question: v.string(),
    candidates: v.array(dryRunCandidate),
    past: v.optional(v.array(dryRunPast)),
    context: v.optional(v.string()),
    owner: v.optional(v.string()),
    chatAs: v.optional(v.string()),
    history: v.optional(v.array(v.object({ you: v.string(), operator: v.string() }))),
    notes: v.optional(v.array(v.string())),
  },
  returns: v.object({
    picked: v.union(v.null(), v.string()),
    reply: v.optional(v.string()),
    handoff: v.optional(v.string()),
    answer: v.union(v.null(), v.string()),
    chat: v.optional(v.string()),
    usd: v.number(),
  }),
  handler: async function (_ctx, args) {
    const meter: Meter = { usd: 0 };
    const past = args.past ?? [];
    const routed = await routeQuestion(args.question, args.candidates, { past, meter });
    const picked = routed !== null && "ask" in routed ? (args.candidates[routed.ask]?.handle ?? null) : null;
    const reply = routed !== null && "reply" in routed ? routed.reply : undefined;
    const handoff = routed !== null && "handoff" in routed
      ? `@${(args.candidates[routed.handoff] ?? past[routed.handoff - args.candidates.length])?.handle ?? "?"}: ${routed.task}`
      : undefined;
    let answer: string | null = null;
    if (args.context !== undefined && args.owner !== undefined) {
      const fromSlice = await answerFrom(args.question, args.context, { handle: args.owner });
      meter.usd += fromSlice.usd ?? 0;
      answer = fromSlice.text;
    }
    if (args.chatAs === undefined) return { picked, reply, handoff, answer, usd: meter.usd };
    const crew = [...args.candidates, ...past].filter(function (c, i, all) {
      return all.findIndex(function (o) { return o.handle === c.handle; }) === i;
    }).map(function (c) { return { handle: c.handle, name: c.name }; });
    const turn = await chatTurn(args.question, args.history ?? [], args.candidates, args.chatAs, { past, notes: args.notes ?? [], crew, meter });
    const said = "reply" in turn ? `reply: ${turn.reply}` : `ask @${args.candidates[turn.ask]?.handle ?? "?"}: ${turn.question}`;
    const offered = turn.offered === undefined
      ? ""
      : ` [offer to ${turn.offered.agent === undefined ? `@${turn.offered.handle ?? "?"}` : `@${args.candidates[turn.offered.agent]?.handle ?? "?"}'s agent`}: ${turn.offered.task}]`;
    const knocked = turn.knocked === undefined ? "" : ` [knock @${turn.knocked.handle}: ${turn.knocked.note}]`;
    return { picked, reply, handoff, answer, chat: `${said}${offered}${knocked}`, usd: meter.usd };
  },
});
