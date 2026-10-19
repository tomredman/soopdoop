// ABOUTME: Hand-offs: a task offered to a crewmate's agent. The crewmate approves it (or lets it run when their agent is
// ABOUTME: idle), their daemon runs it in that agent on their own account, and the agent reports back. Offers expire in 24 hours.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { addToFeed } from "./feed";
import { markActed } from "./headsups";
import { hasOpenKnock, insertKnock, KNOCK_MS } from "./knocks";
import { allowanceGroup } from "./lib/allowance";
import { requireDaemon, requireHacker } from "./lib/auth";
import { crewmateIds, isCrewmate } from "./lib/crew";
import { fitScore } from "./lib/ledgerSearch";
import { limitsFor } from "./lib/plan";
import { redactSecrets } from "./lib/summaries";
import { handoffMode, handoffStatus } from "./schema";
import { supersetCard } from "./superset";

const DAY_MS = 24 * 60 * 60 * 1000;
// An offer waits a day for its receiver; a hand-off that started has a day to report back.
export const OFFER_MS = DAY_MS;
// A machine that reported in the last 90 seconds is live, as for presence and the Operator.
const LIVE_MS = 90_000;
export const MAX_TASK = 2_000;
const MAX_WHY = 500;
const MAX_SUMMARY = 1_000;
const MAX_NOTE = 500;
const MAX_LINKS = 5;
const MAX_LINK = 500;
// The knock that goes with an offer no agent fits carries the start of the task.
const KNOCK_NOTE = 120;

type Via = "agent" | "hud" | "menu" | "operator" | "headsup";

const offeredView = v.object({
  handoffId: v.id("handoffs"),
  status: handoffStatus,
  toHandle: v.string(),
  // Only when the receiver shares agent names.
  targetAgentName: v.optional(v.string()),
});

interface Offered {
  handoffId: Id<"handoffs">;
  status: Doc<"handoffs">["status"];
  toHandle: string;
  targetAgentName?: string;
}

// One of the receiver's open agents on a live machine, with what it is working on.
export interface OpenAgent {
  machineName: string;
  agentId: string;
  agentName: string;
  harness: string;
  workspace?: string;
  summary?: string;
}

async function hackerByHandle(ctx: QueryCtx, raw: string): Promise<Doc<"hackers">> {
  const hacker = await ctx.db
    .query("hackers")
    .withIndex("by_handle", function (q) {
      return q.eq("handle", raw.trim().replace(/^@/, "").toLowerCase());
    })
    .unique();
  if (hacker === null) throw new ConvexError("ain’t nobody with that handle");
  return hacker;
}

// Private agents never take a hand-off: they are never listed here.
async function openAgents(ctx: QueryCtx, hackerId: Id<"hackers">, now: number): Promise<OpenAgent[]> {
  const subsets = await ctx.db
    .query("subsets")
    .withIndex("by_hacker_machine", function (q) {
      return q.eq("hackerId", hackerId);
    })
    .collect();
  const out: OpenAgent[] = [];
  for (const s of subsets) {
    if (now - s.updatedAt >= LIVE_MS) continue;
    for (const a of s.agents) {
      if (!a.open) continue;
      const summary = await ctx.db
        .query("routingSummaries")
        .withIndex("by_hacker_agent", function (q) {
          return q.eq("hackerId", hackerId).eq("agentId", a.agentId);
        })
        .unique();
      out.push({ machineName: s.machineName, agentId: a.agentId, agentName: a.name, harness: a.harness, workspace: a.workspace, summary: summary?.summary });
    }
  }
  return out;
}

// The agent a task goes to: the one asked for, when it is open; else the open agent whose summary fits the task best;
// else none.
export function pickAgent(agents: OpenAgent[], task: string, wanted?: string): OpenAgent | undefined {
  const asked = wanted === undefined ? undefined : agents.find(function (a) { return a.agentId === wanted; });
  if (asked !== undefined) return asked;
  let best: { agent: OpenAgent; score: number } | undefined;
  for (const agent of agents) {
    const score = fitScore(task, `${agent.agentName} ${agent.workspace ?? ""} ${agent.summary ?? ""}`);
    if (score > 0 && (best === undefined || score > best.score)) best = { agent, score };
  }
  return best?.agent;
}

// What the receiver lets this sender do: ask each time (no row), run when idle, or never.
async function consentOf(ctx: QueryCtx, receiver: Id<"hackers">, sender: Id<"hackers">): Promise<Doc<"handoffConsents">["mode"]> {
  const row = await ctx.db
    .query("handoffConsents")
    .withIndex("by_hacker_other", function (q) {
      return q.eq("hackerId", receiver).eq("otherId", sender);
    })
    .unique();
  return row?.mode ?? "ask";
}

// Offers made in the last day by the people who share the sender's allowance (lib/allowance.ts), counted up to `limit`.
async function offersToday(ctx: QueryCtx, senders: Id<"hackers">[], since: number, limit: number): Promise<number> {
  let n = 0;
  for (const id of senders) {
    const rows = await ctx.db
      .query("handoffs")
      .withIndex("by_from", function (q) {
        return q.eq("fromId", id).gt("createdAt", since);
      })
      .collect();
    n += rows.length;
    if (n >= limit) return n;
  }
  return n;
}

// Whether that Mac lists the agent as private now. A private agent's work stays on its Mac: it neither hands work off
// nor runs a hand-off, even one accepted before it went private.
async function isPrivateOn(ctx: QueryCtx, hackerId: Id<"hackers">, machineName: string, agentId: string): Promise<boolean> {
  const subset = await ctx.db
    .query("subsets")
    .withIndex("by_hacker_machine", function (q) {
      return q.eq("hackerId", hackerId).eq("machineName", machineName);
    })
    .unique();
  return subset?.agents.some(function (a) { return a.agentId === agentId && !a.open; }) === true;
}

// A note or a reason: trimmed, anything that looks like a key taken out, cut short. Undefined when empty.
function optionalText(text: string | undefined, max: number): string | undefined {
  if (text === undefined) return undefined;
  const t = redactSecrets(text.trim()).slice(0, max);
  return t === "" ? undefined : t;
}

interface Offer {
  text: string;
  why?: string;
  targetAgentId?: string;
  via: Via;
  fromMachine?: string;
  fromAgentId?: string;
  relayId?: Id<"relays">;
  // False when the sender did not pick the receiver themselves (the Operator picked a crewmate the asker did not name):
  // then it waits for the receiver's yes even when they let this sender's hand-offs run.
  autoOk?: boolean;
}

// Every offer, from wherever it came: checks, the agent it goes to, consent, the knock when no agent fits, and the
// 24-hour end. The text is kept as the sender wrote it: the receiver approves exactly that.
async function makeOffer(ctx: MutationCtx, from: Doc<"hackers">, to: Doc<"hackers">, o: Offer): Promise<Offered> {
  if (to._id === from._id) throw new ConvexError("That is you.");
  if (!(await isCrewmate(ctx, from._id, to._id))) throw new ConvexError("You can only hand work to a crewmate.");
  const text = o.text.trim();
  if (text === "") throw new ConvexError("Say what the task is.");
  if (text.length > MAX_TASK) throw new ConvexError("Keep a hand-off under 2,000 characters.");
  if (o.fromMachine !== undefined && o.fromAgentId !== undefined && (await isPrivateOn(ctx, from._id, o.fromMachine, o.fromAgentId))) {
    throw new ConvexError("A private agent's work stays on its Mac, so it cannot hand work off.");
  }
  const consent = await consentOf(ctx, to._id, from._id);
  if (consent === "never") throw new ConvexError(`@${to.handle} has turned hand-offs from you off.`);
  const now = Date.now();
  const group = await allowanceGroup(ctx, from._id);
  const limits = limitsFor(group.crew);
  if ((await offersToday(ctx, group.ids, now - DAY_MS, limits.handoffsPerDay)) >= limits.handoffsPerDay) {
    throw new ConvexError(`Your crew has made today's hand-offs (${limits.handoffsPerDay} a day on the ${group.crew?.plan ?? "free"} plan).`);
  }
  const agent = pickAgent(await openAgents(ctx, to._id, now), text, o.targetAgentId);
  // "Run when my agent is idle" needs an agent to run in; without one, the receiver picks one when they accept.
  const auto = consent === "auto" && agent !== undefined && o.autoOk !== false;
  const status = auto ? "accepted" : "offered";
  const id = await ctx.db.insert("handoffs", {
    fromId: from._id,
    toId: to._id,
    targetMachine: agent?.machineName,
    targetAgentId: agent?.agentId,
    targetAgentName: agent?.agentName,
    targetHarness: agent?.harness,
    text,
    why: optionalText(o.why, MAX_WHY),
    status,
    autoAccepted: auto ? true : undefined,
    via: o.via,
    fromMachine: o.fromMachine,
    fromAgentId: o.fromAgentId,
    relayId: o.relayId,
    createdAt: now,
    expiresAt: now + OFFER_MS,
    decidedAt: status === "accepted" ? now : undefined,
  });
  // No agent of theirs fits: a knock with the start of the task, so they see it now. Not in focus mode, and not on top
  // of a knock from the sender that is still waiting.
  const inFocus = to.focusUntil !== undefined && to.focusUntil > now;
  if (agent === undefined && !inFocus && !(await hasOpenKnock(ctx, from._id, to._id))) {
    const knockId = await insertKnock(ctx, {
      from: from._id,
      to: to._id,
      item: { kind: "session", title: `a hand-off from @${from.handle}` },
      note: text.slice(0, KNOCK_NOTE),
      lifetimeMs: KNOCK_MS,
      now,
      automatic: true,
    });
    await ctx.db.patch("handoffs", id, { knockId });
  }
  await ctx.scheduler.runAfter(OFFER_MS, internal.handoffs.expire, { handoffId: id });
  await markActed(ctx, from._id, to._id, "handoff");
  return { handoffId: id, status, toHandle: to.handle, targetAgentName: to.shareAgentNames ? agent?.agentName : undefined };
}

// From the HUD, the menu bar or a heads-up card.
export const offer = mutation({
  args: {
    toHandle: v.string(),
    text: v.string(),
    why: v.optional(v.string()),
    targetAgentId: v.optional(v.string()),
    via: v.union(v.literal("hud"), v.literal("menu"), v.literal("headsup"), v.literal("operator")),
  },
  returns: v.id("handoffs"),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const to = await hackerByHandle(ctx, args.toHandle);
    const made = await makeOffer(ctx, me, to, { text: args.text, why: args.why, targetAgentId: args.targetAgentId, via: args.via });
    return made.handoffId;
  },
});

// From an agent, through the hand_off tool on its machine. The offering session hears back at its next prompt.
export const offerFromAgent = mutation({
  args: {
    token: v.string(),
    toHandle: v.string(),
    text: v.string(),
    why: v.optional(v.string()),
    targetAgentId: v.optional(v.string()),
    agentId: v.optional(v.string()),
  },
  returns: offeredView,
  handler: async function (ctx, args) {
    const { hacker, daemon } = await requireDaemon(ctx, args.token);
    const to = await hackerByHandle(ctx, args.toHandle);
    return await makeOffer(ctx, hacker, to, {
      text: args.text,
      why: args.why,
      targetAgentId: args.targetAgentId,
      via: "agent",
      fromMachine: daemon.machineName,
      fromAgentId: args.agentId,
    });
  },
});

// For the Operator: a work order it turned into an offer, from the asker to a crewmate (and their agent, when it picked
// one). Errors (consent off, the day's limit) come back to the Operator, which says them to the asker.
export const offerInternal = internalMutation({
  args: {
    fromId: v.id("hackers"),
    toId: v.id("hackers"),
    text: v.string(),
    targetAgentId: v.optional(v.string()),
    relayId: v.optional(v.id("relays")),
    fromMachine: v.optional(v.string()),
    fromAgentId: v.optional(v.string()),
    // False when the asker did not name this crewmate: the offer then waits for their yes whatever their setting.
    autoOk: v.optional(v.boolean()),
  },
  returns: offeredView,
  handler: async function (ctx, args) {
    const from = await ctx.db.get("hackers", args.fromId);
    const to = await ctx.db.get("hackers", args.toId);
    if (from === null || to === null) throw new ConvexError("ain’t nobody with that handle");
    // One offer per question, even if the Operator's routing for it runs twice.
    if (args.relayId !== undefined) {
      const recent = await ctx.db
        .query("handoffs")
        .withIndex("by_from", function (q) {
          return q.eq("fromId", from._id).gt("createdAt", Date.now() - OFFER_MS);
        })
        .collect();
      const same = recent.find(function (h) { return h.relayId === args.relayId; });
      if (same !== undefined) {
        return { handoffId: same._id, status: same.status, toHandle: to.handle, targetAgentName: to.shareAgentNames ? same.targetAgentName : undefined };
      }
      // A question that ran out of time (the asker already read that) makes no offer behind their back.
      const relay = await ctx.db.get("relays", args.relayId);
      if (relay === null || relay.status !== "routing") throw new ConvexError("That question ran out of time before the hand-off went out.");
    }
    return await makeOffer(ctx, from, to, {
      text: args.text,
      targetAgentId: args.targetAgentId,
      via: "operator",
      relayId: args.relayId,
      fromMachine: args.fromMachine,
      fromAgentId: args.fromAgentId,
      autoOk: args.autoOk,
    });
  },
});

// The receiver says yes (with the agent to run it in, if not the one it was offered to) or no.
export const decide = mutation({
  args: {
    handoffId: v.id("handoffs"),
    outcome: v.union(v.literal("accept"), v.literal("decline")),
    targetAgentId: v.optional(v.string()),
    targetMachine: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const h = await ctx.db.get("handoffs", args.handoffId);
    if (h === null || h.toId !== me._id) throw new ConvexError("Not your hand-off.");
    if (h.status !== "offered" && h.status !== "accepted") throw new ConvexError("This hand-off is not waiting any more.");
    const now = Date.now();
    const note = optionalText(args.note, MAX_NOTE);
    if (args.outcome === "decline") {
      await ctx.db.patch("handoffs", h._id, { status: "declined", autoAccepted: undefined, decidedAt: now, finishedAt: now, note });
      return null;
    }
    const agentId = args.targetAgentId ?? h.targetAgentId;
    if (agentId === undefined) throw new ConvexError("Pick one of your agents to run it.");
    const machine = args.targetAgentId === undefined ? (args.targetMachine ?? h.targetMachine) : args.targetMachine;
    const agent = (await openAgents(ctx, me._id, now)).find(function (a) {
      return a.agentId === agentId && (machine === undefined || a.machineName === machine);
    });
    if (agent === undefined) throw new ConvexError("That agent is not open right now. Pick another one.");
    // Accepted: it has a day from now to run, however late in its offer's day it was accepted.
    await ctx.db.patch("handoffs", h._id, {
      status: "accepted",
      autoAccepted: undefined,
      decidedAt: now,
      expiresAt: now + OFFER_MS,
      note,
      targetMachine: agent.machineName,
      targetAgentId: agent.agentId,
      targetAgentName: agent.agentName,
      targetHarness: agent.harness,
    });
    await ctx.scheduler.runAfter(OFFER_MS, internal.handoffs.expire, { handoffId: h._id });
    return null;
  },
});

// What this machine's daemon should run: accepted hand-offs for its agents that are not private now. It runs each when
// its agent is idle.
export const toRun = query({
  args: { token: v.string() },
  returns: v.array(v.object({
    handoffId: v.id("handoffs"),
    targetAgentId: v.string(),
    text: v.string(),
    fromHandle: v.string(),
    why: v.optional(v.string()),
    targetHarness: v.optional(v.string()),
    // "Run when my agent is idle" accepted it, not the owner's own click: the daemon waits for the agent to be idle.
    autoAccepted: v.optional(v.boolean()),
  })),
  handler: async function (ctx, args) {
    const { hacker, daemon } = await requireDaemon(ctx, args.token);
    const rows = await ctx.db
      .query("handoffs")
      .withIndex("by_to_status", function (q) {
        return q.eq("toId", hacker._id).eq("status", "accepted");
      })
      .collect();
    const out = [];
    for (const h of rows) {
      if (h.targetMachine !== daemon.machineName || h.targetAgentId === undefined) continue;
      if (await isPrivateOn(ctx, hacker._id, daemon.machineName, h.targetAgentId)) continue;
      const from = await ctx.db.get("hackers", h.fromId);
      out.push({
        handoffId: h._id,
        targetAgentId: h.targetAgentId,
        text: h.text,
        fromHandle: from?.handle ?? "",
        why: h.why,
        targetHarness: h.targetHarness,
        autoAccepted: h.autoAccepted === true,
      });
    }
    return out;
  },
});

// A hand-off for this Mac, for its receiver's daemon: only the Mac it runs on starts it, fails it or reports it back.
async function receiversHandoff(ctx: QueryCtx, hacker: Doc<"hackers">, id: Id<"handoffs">, machineName: string): Promise<Doc<"handoffs">> {
  const h = await ctx.db.get("handoffs", id);
  if (h === null || h.toId !== hacker._id || h.targetMachine !== machineName) throw new ConvexError("This Mac has no such hand-off.");
  return h;
}

// The agent it runs in went private after it was accepted: it neither runs nor reports back to the crew.
async function refuseIfPrivate(ctx: QueryCtx, h: Doc<"handoffs">): Promise<void> {
  if (h.targetMachine !== undefined && h.targetAgentId !== undefined && (await isPrivateOn(ctx, h.toId, h.targetMachine, h.targetAgentId))) {
    throw new ConvexError("That agent is private now, so the hand-off stays off it.");
  }
}

// The daemon delivered it to the agent. It has a day from now to report back.
export const started = mutation({
  // `note` says how it was delivered when that matters to the sender ("copied to the clipboard: paste it into the agent").
  args: { token: v.string(), handoffId: v.id("handoffs"), note: v.optional(v.string()) },
  returns: v.null(),
  handler: async function (ctx, args) {
    const { hacker, daemon } = await requireDaemon(ctx, args.token);
    const h = await receiversHandoff(ctx, hacker, args.handoffId, daemon.machineName);
    if (h.status === "running") return null;
    if (h.status !== "accepted") throw new ConvexError("This hand-off is not waiting to run.");
    await refuseIfPrivate(ctx, h);
    const now = Date.now();
    const note = args.note?.trim().slice(0, 200);
    await ctx.db.patch("handoffs", h._id, { status: "running", startedAt: now, expiresAt: now + OFFER_MS, ...(note === undefined || note === "" ? {} : { note }) });
    await ctx.scheduler.runAfter(OFFER_MS, internal.handoffs.expire, { handoffId: h._id });
    return null;
  },
});

function cleanLinks(links: string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of links ?? []) {
    const link = raw.trim();
    if (/^https?:\/\/\S+$/i.test(link) && link.length <= MAX_LINK && !out.includes(link)) out.push(link);
    if (out.length === MAX_LINKS) break;
  }
  return out;
}

// The agent that did it reports back (the report_back tool): done, on the wire, and an assist for the receiver. A
// late report after the 24 hours ran out still counts.
export const reportBack = mutation({
  args: {
    token: v.string(),
    handoffId: v.id("handoffs"),
    summary: v.string(),
    links: v.optional(v.array(v.string())),
    usd: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async function (ctx, args) {
    const { hacker, daemon } = await requireDaemon(ctx, args.token);
    const h = await receiversHandoff(ctx, hacker, args.handoffId, daemon.machineName);
    if (h.status === "done") throw new ConvexError("This hand-off was already reported back.");
    if (h.status !== "accepted" && h.status !== "running" && h.status !== "failed") throw new ConvexError("This hand-off is not running.");
    await refuseIfPrivate(ctx, h);
    const summary = redactSecrets(args.summary.trim()).slice(0, MAX_SUMMARY);
    if (summary === "") throw new ConvexError("Say what was done.");
    const links = cleanLinks(args.links);
    const usd = args.usd !== undefined && Number.isFinite(args.usd) && args.usd >= 0 ? args.usd : undefined;
    const now = Date.now();
    await ctx.db.patch("handoffs", h._id, {
      status: "done",
      summary,
      links: links.length > 0 ? links : undefined,
      usd,
      finishedAt: now,
      note: h.status === "failed" ? undefined : h.note,
    });
    await addToFeed(ctx, { kind: "handoff", hackerId: h.toId, otherHackerId: h.fromId, text: summary, url: links[0], handoffId: h._id, at: now });
    return null;
  },
});

// The daemon could not run it, or the agent could not do it.
export const failed = mutation({
  args: { token: v.string(), handoffId: v.id("handoffs"), note: v.string() },
  returns: v.null(),
  handler: async function (ctx, args) {
    const { hacker, daemon } = await requireDaemon(ctx, args.token);
    const h = await receiversHandoff(ctx, hacker, args.handoffId, daemon.machineName);
    if (h.status !== "accepted" && h.status !== "running") throw new ConvexError("This hand-off is not running.");
    const note = redactSecrets(args.note.trim()).slice(0, MAX_NOTE);
    await ctx.db.patch("handoffs", h._id, { status: "failed", note: note === "" ? "It could not be run." : note, finishedAt: Date.now() });
    return null;
  },
});

const incomingView = v.object({
  _id: v.id("handoffs"),
  fromHandle: v.string(),
  fromName: v.optional(v.string()),
  text: v.string(),
  why: v.optional(v.string()),
  targetAgentId: v.optional(v.string()),
  targetAgentName: v.optional(v.string()),
  targetMachine: v.optional(v.string()),
  status: handoffStatus,
  createdAt: v.number(),
  expiresAt: v.number(),
  via: v.optional(v.union(v.literal("agent"), v.literal("hud"), v.literal("menu"), v.literal("operator"), v.literal("headsup"))),
});

const outgoingView = v.object({
  _id: v.id("handoffs"),
  toHandle: v.string(),
  text: v.string(),
  status: handoffStatus,
  summary: v.optional(v.string()),
  links: v.optional(v.array(v.string())),
  note: v.optional(v.string()),
  createdAt: v.number(),
  decidedAt: v.optional(v.number()),
  finishedAt: v.optional(v.number()),
  // Only when the receiver shares agent names.
  targetAgentName: v.optional(v.string()),
});

// Hand-offs waiting for me (offered, or accepted and not run yet), newest first, and the last 20 I offered.
export const mine = query({
  args: {},
  returns: v.object({ incoming: v.array(incomingView), outgoing: v.array(outgoingView) }),
  handler: async function (ctx) {
    const me = await requireHacker(ctx);
    const waiting: Doc<"handoffs">[] = [];
    const statuses: ("offered" | "accepted")[] = ["offered", "accepted"];
    for (const status of statuses) {
      waiting.push(...(await ctx.db
        .query("handoffs")
        .withIndex("by_to_status", function (q) {
          return q.eq("toId", me._id).eq("status", status);
        })
        .collect()));
    }
    waiting.sort(function (a, b) { return b.createdAt - a.createdAt; });
    const incoming = [];
    for (const h of waiting) {
      const from = await ctx.db.get("hackers", h.fromId);
      if (from === null) continue;
      incoming.push({
        _id: h._id,
        fromHandle: from.handle,
        fromName: (await supersetCard(ctx, from._id))?.name,
        text: h.text,
        why: h.why,
        targetAgentId: h.targetAgentId,
        targetAgentName: h.targetAgentName,
        targetMachine: h.targetMachine,
        status: h.status,
        createdAt: h.createdAt,
        expiresAt: h.expiresAt,
        via: h.via,
      });
    }
    const offered = await ctx.db
      .query("handoffs")
      .withIndex("by_from", function (q) {
        return q.eq("fromId", me._id);
      })
      .order("desc")
      .take(20);
    const outgoing = [];
    for (const h of offered) {
      const to = await ctx.db.get("hackers", h.toId);
      if (to === null) continue;
      outgoing.push({
        _id: h._id,
        toHandle: to.handle,
        text: h.text,
        status: h.status,
        summary: h.summary,
        links: h.links,
        note: h.note,
        createdAt: h.createdAt,
        decidedAt: h.decidedAt,
        finishedAt: h.finishedAt,
        targetAgentName: to.shareAgentNames ? h.targetAgentName : undefined,
      });
    }
    return { incoming, outgoing };
  },
});

// Hand-offs this machine's agents offered that ended in the last day (done, failed, declined or expired), so the
// daemon can tell the session that offered each one at its next prompt. Only "done" is news on the wire.
export const finishedForDaemon = query({
  args: { token: v.string() },
  returns: v.array(v.object({
    handoffId: v.id("handoffs"),
    fromAgentId: v.optional(v.string()),
    toHandle: v.string(),
    status: v.union(v.literal("done"), v.literal("failed"), v.literal("declined"), v.literal("expired")),
    summary: v.optional(v.string()),
    links: v.optional(v.array(v.string())),
    note: v.optional(v.string()),
    finishedAt: v.number(),
  })),
  handler: async function (ctx, args) {
    const { hacker, daemon } = await requireDaemon(ctx, args.token);
    const now = Date.now();
    // An offer waits up to a day and then has a day to run: anything that finished today was offered in the last three.
    const rows = await ctx.db
      .query("handoffs")
      .withIndex("by_from", function (q) {
        return q.eq("fromId", hacker._id).gt("createdAt", now - 3 * DAY_MS);
      })
      .collect();
    const out = [];
    for (const h of rows) {
      if (h.fromMachine !== daemon.machineName || h.finishedAt === undefined || h.finishedAt <= now - DAY_MS) continue;
      if (h.status !== "done" && h.status !== "failed" && h.status !== "declined" && h.status !== "expired") continue;
      const to = await ctx.db.get("hackers", h.toId);
      out.push({
        handoffId: h._id,
        fromAgentId: h.fromAgentId,
        toHandle: to?.handle ?? "",
        status: h.status,
        summary: h.summary,
        links: h.links,
        note: h.note,
        finishedAt: h.finishedAt,
      });
    }
    return out;
  },
});

// What I let each crewmate do with hand-offs to me. "ask" when I never said.
export const consents = query({
  args: {},
  returns: v.array(v.object({ handle: v.string(), name: v.optional(v.string()), mode: handoffMode })),
  handler: async function (ctx) {
    const me = await requireHacker(ctx);
    const out = [];
    for (const id of await crewmateIds(ctx, me._id)) {
      const other = await ctx.db.get("hackers", id);
      if (other === null) continue;
      out.push({ handle: other.handle, name: (await supersetCard(ctx, id))?.name, mode: await consentOf(ctx, me._id, id) });
    }
    out.sort(function (a, b) { return a.handle.localeCompare(b.handle); });
    return out;
  },
});

export const setConsent = mutation({
  args: { handle: v.string(), mode: handoffMode },
  returns: v.null(),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const other = await hackerByHandle(ctx, args.handle);
    if (other._id === me._id || !(await isCrewmate(ctx, me._id, other._id))) throw new ConvexError("Only for a crewmate.");
    const row = await ctx.db
      .query("handoffConsents")
      .withIndex("by_hacker_other", function (q) {
        return q.eq("hackerId", me._id).eq("otherId", other._id);
      })
      .unique();
    if (row === null) await ctx.db.insert("handoffConsents", { hackerId: me._id, otherId: other._id, mode: args.mode });
    else await ctx.db.patch("handoffConsents", row._id, { mode: args.mode });
    // No longer "run when my agent is idle": what that setting accepted from them and did not start yet comes back to
    // me to approve, or, with "never", is declined.
    if (args.mode !== "auto") {
      const now = Date.now();
      const accepted = await ctx.db
        .query("handoffs")
        .withIndex("by_to_status", function (q) {
          return q.eq("toId", me._id).eq("status", "accepted");
        })
        .collect();
      for (const h of accepted) {
        if (h.fromId !== other._id || h.autoAccepted !== true) continue;
        if (args.mode === "never") {
          await ctx.db.patch("handoffs", h._id, { status: "declined", autoAccepted: undefined, decidedAt: now, finishedAt: now, note: "Hand-offs from you are off now." });
        } else {
          await ctx.db.patch("handoffs", h._id, { status: "offered", autoAccepted: undefined, decidedAt: undefined });
        }
      }
    }
    return null;
  },
});

// The scheduled end: an offer nobody took after 24 hours expires (so does an accepted one that never ran), and one
// that ran without a report back in 24 hours fails. A hand-off accepted or started later has a later end of its own.
export const expire = internalMutation({
  args: { handoffId: v.id("handoffs") },
  returns: v.null(),
  handler: async function (ctx, args) {
    const h = await ctx.db.get("handoffs", args.handoffId);
    const now = Date.now();
    if (h === null || h.expiresAt > now) return null;
    if (h.status === "offered") await ctx.db.patch("handoffs", h._id, { status: "expired", finishedAt: now });
    else if (h.status === "accepted") await ctx.db.patch("handoffs", h._id, { status: "expired", note: "It did not run within 24 hours.", finishedAt: now });
    else if (h.status === "running") await ctx.db.patch("handoffs", h._id, { status: "failed", note: "No report back in 24 hours.", finishedAt: now });
    return null;
  },
});
