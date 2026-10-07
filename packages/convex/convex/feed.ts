// ABOUTME: The wire: a quiet feed of what happened in the crew lately (answers between agents, new agents, caught flicks,
// ABOUTME: superflicks, rallies), and how many tokens the crew's answers saved. Events are written where they happen.
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, query } from "./_generated/server";
import { acceptedFriendIds } from "./friends";
import { requireHacker } from "./lib/auth";

// The HUD shows a day of the wire; the table keeps a week.
const SHOWN_MS = 24 * 60 * 60 * 1000;
const KEPT_MS = 7 * 24 * 60 * 60 * 1000;
const SHOWN = 12;

export type FeedEvent = Omit<Doc<"feed">, "_id" | "_creationTime">;

export async function addToFeed(ctx: MutationCtx, event: FeedEvent): Promise<void> {
  await ctx.db.insert("feed", event);
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
  kind: v.union(v.literal("answer"), v.literal("agent"), v.literal("catch"), v.literal("superflick"), v.literal("rally")),
  handle: v.string(),
  // Left out when it is someone the viewer should not see named: who asked a question between two other people.
  otherHandle: v.optional(v.string()),
  // The viewer did it, or it was done to (or for) the viewer.
  me: v.boolean(),
  otherMe: v.boolean(),
  tokensSaved: v.optional(v.number()),
  xp: v.optional(v.number()),
  rally: v.optional(v.number()),
  at: v.number(),
});

// The viewer's wire: the last day's events by them and their crew (their friends, for now), newest first. Who asked a
// question between two other crewmates stays unnamed; someone who hides from the board is left out, except to themselves;
// a crewmate in focus mode does not show starting agents.
export const recent = query({
  args: {},
  returns: v.array(eventView),
  handler: async function (ctx) {
    const me = await requireHacker(ctx);
    const now = Date.now();
    const crew = new Map<Id<"hackers">, Doc<"hackers">>([[me._id, me]]);
    for (const id of await acceptedFriendIds(ctx, me._id)) {
      const friend = await ctx.db.get("hackers", id);
      if (friend !== null) crew.set(id, friend);
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
      const other = visible(e.otherHackerId);
      const mine = who._id === me._id;
      const forMe = e.otherHackerId === me._id;
      if (e.kind === "agent") {
        // My own agents I know about; a crewmate in focus mode is not around.
        if (mine || (who.focusUntil !== undefined && who.focusUntil > now)) continue;
      } else if (e.kind !== "answer" && other === null) {
        // A flick with someone outside the crew, or with someone who hides from the board.
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
// what my agents' answers saved crewmates. `crew`: everyone's questions, mine and my friends'. No board: these are not
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
    for (const id of await acceptedFriendIds(ctx, me._id)) crew += await savedBy(ctx, id);
    return { you, yourAgents, crew };
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
