// ABOUTME: The wire: what happened in the crew lately (answers between agents, new agents, flicks, ships, hand-offs, heads-ups,
// ABOUTME: notes, shouts, props, saves, digests), and how many tokens the crew's answers saved. Events are written where they happen.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireDaemon, requireHacker } from "./lib/auth";
import { crewmateIds, crewOf } from "./lib/crew";
import { limitsFor } from "./lib/plan";
import { redactSecrets } from "./lib/summaries";
import { feedKind } from "./schema";

// The HUD shows a day of the wire; the table keeps a week.
const SHOWN_MS = 24 * 60 * 60 * 1000;
const KEPT_MS = 7 * 24 * 60 * 60 * 1000;
// The HUD shows 4 lines, the menu bar all of these.
const SHOWN = 40;
// A shout is gone from the wire after a day (a scheduled function removes it).
export const SHOUT_MS = 24 * 60 * 60 * 1000;
export const MAX_SHOUT = 140;
// What the scout may put on the wire: one line, and not more than this many a day per person.
export const MAX_SCOUT_LINE = 200;
export const SCOUT_PER_DAY = 30;
// Ships, props and saves go to the crew's Slack channel as they happen, when the leader turns the mirror on.
const MIRRORED = new Set(["ship", "props", "save"]);

export type FeedEvent = Omit<Doc<"feed">, "_id" | "_creationTime">;

// The one writer of the wire. A ship, props or a save also goes to the crew's Slack when its live mirror is on.
export async function addToFeed(ctx: MutationCtx, event: FeedEvent): Promise<Id<"feed">> {
  const id = await ctx.db.insert("feed", event);
  if (MIRRORED.has(event.kind)) {
    const crew = await crewOf(ctx, event.hackerId);
    if (crew !== null && crew.slackMirror === true && crew.slackWebhook !== undefined && limitsFor(crew).digest) {
      await ctx.scheduler.runAfter(0, internal.slack.mirror, { feedId: id });
    }
  }
  return id;
}

// When each of this hacker's agents was first on the wire, in the last week. A summary is dropped and sent again when its
// owner's daemon restarts (an update): this keeps such an agent from being news twice, here and in introductions.
export async function announcedAgents(ctx: QueryCtx, hackerId: Id<"hackers">): Promise<Map<string, number>> {
  const rows = await ctx.db
    .query("feed")
    .withIndex("by_hacker_at", function (q) {
      return q.eq("hackerId", hackerId).gt("at", Date.now() - KEPT_MS);
    })
    .collect();
  const first = new Map<string, number>();
  for (const r of rows) if (r.kind === "agent" && r.agentId !== undefined && !first.has(r.agentId)) first.set(r.agentId, r.at);
  return first;
}

// A rally is news when it reaches 3, then every 5.
export function rallyIsNews(rally: number): boolean {
  return rally === 3 || (rally > 0 && rally % 5 === 0);
}

// What the asker's agent did not have to read: the tokens the answering copy read, minus the answer's.
export function tokensSaved(r: { tokensRead?: number; tokensSent?: number }): number {
  return Math.max(0, Math.round((r.tokensRead ?? 0) - (r.tokensSent ?? 0)));
}

const eventView = v.object({
  _id: v.id("feed"),
  kind: feedKind,
  handle: v.string(),
  // Left out when it is someone the viewer should not see named: who asked a question between two other people.
  otherHandle: v.optional(v.string()),
  // The viewer did it, or it was done to (or for) the viewer.
  me: v.boolean(),
  otherMe: v.boolean(),
  tokensSaved: v.optional(v.number()),
  xp: v.optional(v.number()),
  rally: v.optional(v.number()),
  // The line itself (a shout, what shipped, the props line) and its link, for the kinds that came with crews.
  text: v.optional(v.string()),
  url: v.optional(v.string()),
  fromCustomer: v.optional(v.boolean()),
  handoffId: v.optional(v.id("handoffs")),
  ledgerId: v.optional(v.id("ledger")),
  noteId: v.optional(v.id("notes")),
  dropId: v.optional(v.id("drops")),
  digestId: v.optional(v.id("digests")),
  // props: the wire line they were given on.
  about: v.optional(v.id("feed")),
  // shout: when it leaves the wire.
  expiresAt: v.optional(v.number()),
  at: v.number(),
});

// The viewer's wire: the last day's events by them and their crewmates (their friends when they are in no crew), newest
// first. Who asked a question between two other crewmates stays unnamed; an event with someone outside the crew is left
// out; someone who hides from the board is left out, except to themselves; a crewmate in focus mode does not show
// starting agents; a shout past its day is gone.
export const recent = query({
  args: {},
  returns: v.array(eventView),
  handler: async function (ctx) {
    const me = await requireHacker(ctx);
    const now = Date.now();
    const crew = new Map<Id<"hackers">, Doc<"hackers">>([[me._id, me]]);
    for (const id of await crewmateIds(ctx, me._id)) {
      const mate = await ctx.db.get("hackers", id);
      if (mate !== null) crew.set(id, mate);
    }
    function visible(id: Id<"hackers"> | undefined): Doc<"hackers"> | null {
      if (id === undefined) return null;
      const hacker = crew.get(id);
      if (hacker === undefined) return null;
      return hacker._id === me._id || hacker.hideFromBoards !== true ? hacker : null;
    }
    const events: Doc<"feed">[] = [];
    for (const id of crew.keys()) {
      events.push(...(await ctx.db
        .query("feed")
        .withIndex("by_hacker_at", function (q) {
          return q.eq("hackerId", id).gt("at", now - SHOWN_MS);
        })
        .order("desc")
        .take(SHOWN)));
    }
    // Newest first; two events in the same millisecond, in the order they were written.
    events.sort(function (a, b) { return b.at - a.at || b._creationTime - a._creationTime; });
    const out = [];
    for (const e of events) {
      const who = visible(e.hackerId);
      if (who === null) continue;
      if (e.expiresAt !== undefined && e.expiresAt <= now) continue;
      const other = visible(e.otherHackerId);
      const mine = who._id === me._id;
      const forMe = e.otherHackerId === me._id;
      if (e.kind === "agent") {
        // My own agents I know about; a crewmate in focus mode is not around.
        if (mine || (who.focusUntil !== undefined && who.focusUntil > now)) continue;
      } else if (e.kind !== "answer" && e.otherHackerId !== undefined && other === null) {
        // A flick (or props, a hand-off) with someone outside the crew, or with someone who hides from the board.
        continue;
      }
      // Who asked a question between two other crewmates stays unnamed.
      const showOther = other !== null && (e.kind !== "answer" || mine || forMe);
      out.push({
        _id: e._id,
        kind: e.kind,
        handle: who.handle,
        otherHandle: showOther ? other.handle : undefined,
        me: mine,
        otherMe: forMe,
        tokensSaved: e.tokensSaved,
        xp: e.xp,
        rally: e.rally,
        text: e.text,
        url: e.url,
        fromCustomer: e.fromCustomer,
        handoffId: e.handoffId,
        ledgerId: e.ledgerId,
        noteId: e.noteId,
        dropId: e.dropId,
        digestId: e.digestId,
        about: e.about,
        expiresAt: e.expiresAt,
        at: e.at,
      });
      if (out.length === SHOWN) break;
    }
    return out;
  },
});

async function savedBy(ctx: QueryCtx, asker: Id<"hackers">): Promise<number> {
  const asked = await ctx.db
    .query("relays")
    .withIndex("by_asker", function (q) {
      return q.eq("askerHackerId", asker);
    })
    .collect();
  let total = 0;
  for (const r of asked) if (r.status === "answered" && r.byOperator !== true) total += tokensSaved(r);
  return total;
}

// Tokens the crew's answers saved, all time, as an estimate: for each answer from a crewmate's agent, the tokens its copy
// read minus the answer's, which the asking agent read instead. `you`: answers to my agents' questions. `yourAgents`:
// what my agents' answers saved crewmates. `crew`: everyone's questions, mine and my crewmates'. No board: these are not
// compared between people.
export const saved = query({
  args: {},
  returns: v.object({ you: v.number(), yourAgents: v.number(), crew: v.number() }),
  handler: async function (ctx) {
    const me = await requireHacker(ctx);
    const you = await savedBy(ctx, me._id);
    const answered = await ctx.db
      .query("relays")
      .withIndex("by_target_status", function (q) {
        return q.eq("targetHackerId", me._id).eq("status", "answered");
      })
      .collect();
    let yourAgents = 0;
    for (const r of answered) if (r.byOperator !== true) yourAgents += tokensSaved(r);
    let crew = you;
    for (const id of await crewmateIds(ctx, me._id)) crew += await savedBy(ctx, id);
    return { you, yourAgents, crew };
  },
});

// One line from a person to the crew ("CI is red, looking", "lunch?"). Gone from the wire after a day.
export const shout = mutation({
  args: { text: v.string() },
  returns: v.id("feed"),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const text = args.text.trim().replace(/\s+/g, " ");
    if (text === "") throw new ConvexError("Shout something.");
    if (text.length > MAX_SHOUT) throw new ConvexError(`Keep a shout under ${MAX_SHOUT} characters.`);
    const now = Date.now();
    const feedId = await addToFeed(ctx, { kind: "shout", hackerId: me._id, text, expiresAt: now + SHOUT_MS, at: now });
    await ctx.scheduler.runAfter(SHOUT_MS, internal.feed.expireShout, { feedId });
    return feedId;
  },
});

// Removes a shout when its day is over.
export const expireShout = internalMutation({
  args: { feedId: v.id("feed") },
  returns: v.null(),
  handler: async function (ctx, args) {
    const e = await ctx.db.get("feed", args.feedId);
    if (e !== null && e.kind === "shout") await ctx.db.delete("feed", e._id);
    return null;
  },
});

// Props on a crewmate's wire line: 5 XP for its person. Once per person per line, never on your own line.
export const props = mutation({
  args: { feedId: v.id("feed") },
  returns: v.id("feed"),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const line = await ctx.db.get("feed", args.feedId);
    if (line === null || (line.expiresAt !== undefined && line.expiresAt <= Date.now())) {
      throw new ConvexError("That line is no longer on the wire.");
    }
    if (line.hackerId === me._id) throw new ConvexError("That is your own line.");
    if (line.kind === "digest") throw new ConvexError("Props go to people, and the digest is the Operator's.");
    const person = await ctx.db.get("hackers", line.hackerId);
    if (person === null || person.hideFromBoards === true || !(await crewmateIds(ctx, me._id)).includes(line.hackerId)) {
      throw new ConvexError("That line is no longer on the wire.");
    }
    const now = Date.now();
    const given = await ctx.db
      .query("feed")
      .withIndex("by_hacker_at", function (q) {
        return q.eq("hackerId", me._id).gt("at", now - KEPT_MS);
      })
      .collect();
    if (given.some(function (e) { return e.kind === "props" && e.about === line._id; })) {
      throw new ConvexError("You already gave props for that.");
    }
    return await addToFeed(ctx, { kind: "props", hackerId: me._id, otherHackerId: line.hackerId, about: line._id, at: now });
  },
});

// From the scout on a member's Mac (the props MCP tool): one line, no customer names, about thanks from a customer
// (props) or a thread that went from upset to thanks (a save). Team plan.
export const fromScout = mutation({
  args: { token: v.string(), kind: v.union(v.literal("props"), v.literal("save")), line: v.string() },
  returns: v.id("feed"),
  handler: async function (ctx, args) {
    const { hacker } = await requireDaemon(ctx, args.token);
    const crew = await crewOf(ctx, hacker._id);
    if (!limitsFor(crew).scout) throw new ConvexError("The scout is part of the Team plan.");
    const text = redactSecrets(args.line.trim().replace(/\s+/g, " ")).slice(0, MAX_SCOUT_LINE).trim();
    if (text === "") throw new ConvexError("Send one line about what happened.");
    const now = Date.now();
    const today = await ctx.db
      .query("feed")
      .withIndex("by_hacker_at", function (q) {
        return q.eq("hackerId", hacker._id).gt("at", now - SHOWN_MS);
      })
      .collect();
    const fromScoutToday = today.filter(function (e) { return e.kind === "save" || (e.kind === "props" && e.fromCustomer === true); });
    if (fromScoutToday.length >= SCOUT_PER_DAY) throw new ConvexError("That is enough from the scout for today.");
    if (args.kind === "props") return await addToFeed(ctx, { kind: "props", hackerId: hacker._id, fromCustomer: true, text, at: now });
    return await addToFeed(ctx, { kind: "save", hackerId: hacker._id, text, at: now });
  },
});

// Drops events older than a week, a batch at a time (crons.ts runs it daily).
export const prune = internalMutation({
  args: {},
  returns: v.null(),
  handler: async function (ctx) {
    const old = await ctx.db
      .query("feed")
      .withIndex("by_at", function (q) {
        return q.lt("at", Date.now() - KEPT_MS);
      })
      .take(500);
    for (const e of old) await ctx.db.delete("feed", e._id);
    if (old.length === 500) await ctx.scheduler.runAfter(0, internal.feed.prune, {});
    return null;
  },
});
