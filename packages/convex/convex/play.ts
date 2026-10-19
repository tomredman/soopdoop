// ABOUTME: Play: XP and ranks from what hackers do for each other, and the crew board. No tokens. An assist (your agent
// ABOUTME: answered a crewmate) is 10 XP, a hand-off done 20, props received 5, a question 1, a flick 1, a knock 2; flicks also move XP.
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { query } from "./_generated/server";
import { acceptedFriendIds } from "./friends";
import { requireHacker } from "./lib/auth";

export const XP = { assist: 10, ask: 1, flick: 1, knock: 2, handoff: 20, props: 5 };

// The spec's ranks; "n00b" is said with pride.
export const RANKS: readonly { name: string; at: number }[] = [
  { name: "n00b", at: 0 },
  { name: "script kiddie", at: 20 },
  { name: "hacker", at: 100 },
  { name: "wizard", at: 400 },
  { name: "legend", at: 1000 },
];

// The rank for an XP total, where it started, and where the next one starts (null at the top).
export function rankFor(xp: number): { rank: string; at: number; next: number | null } {
  let current = RANKS[0] ?? { name: "n00b", at: 0 };
  let next: number | null = null;
  for (const r of RANKS) {
    if (xp >= r.at) current = r;
    else {
      next = r.at;
      break;
    }
  }
  return { rank: current.name, at: current.at, next };
}

interface Counts {
  assists: number;
  asks: number;
  // Flicks (superflicks too) and knocks sent, caught or not, opened or not.
  flicks: number;
  knocks: number;
  // XP flicks moved (flicks.ts): what this hacker caught or superflicked from others, minus what others took from them.
  flickXp: number;
  // Hand-offs this hacker's agents did for crewmates, and props given to them on the wire (by crewmates or customers).
  handoffs: number;
  props: number;
}

async function countsFor(ctx: QueryCtx, id: Id<"hackers">): Promise<Counts> {
  const assists = await ctx.db
    .query("relays")
    .withIndex("by_target_status", function (q) {
      return q.eq("targetHackerId", id).eq("status", "answered");
    })
    .collect();
  const asks = await ctx.db
    .query("relays")
    .withIndex("by_asker", function (q) {
      return q.eq("askerHackerId", id);
    })
    .collect();
  const sent = await ctx.db
    .query("flicks")
    .withIndex("by_from_outcome", function (q) {
      return q.eq("fromHackerId", id);
    })
    .collect();
  const got = await ctx.db
    .query("flicks")
    .withIndex("by_to_outcome", function (q) {
      return q.eq("toHackerId", id);
    })
    .collect();
  let flickXp = 0;
  for (const f of sent) flickXp += (f.superXp ?? 0) - (f.caughtXp ?? 0);
  for (const f of got) flickXp += (f.caughtXp ?? 0) - (f.superXp ?? 0);
  const knocks = await ctx.db
    .query("knocks")
    .withIndex("by_from_to", function (q) {
      return q.eq("fromHackerId", id);
    })
    .collect();
  // A message the Operator answered itself is a chat, not a question to the crew: it earns nothing.
  const questions = asks.filter(function (r) { return r.byOperator !== true; });
  const handoffs = await ctx.db
    .query("handoffs")
    .withIndex("by_to_status", function (q) {
      return q.eq("toId", id).eq("status", "done");
    })
    .collect();
  return {
    assists: assists.length,
    asks: questions.length,
    flicks: sent.length,
    knocks: knocks.length,
    flickXp,
    handoffs: handoffs.length,
    props: await propsFor(ctx, id),
  };
}

// Props given to a hacker: by a crewmate on one of their wire lines (otherHackerId is them), or by a customer through
// the scout or a help desk's rating (hackerId is them, fromCustomer). Counted from the wire, which keeps a week.
async function propsFor(ctx: QueryCtx, id: Id<"hackers">): Promise<number> {
  const fromCrew = await ctx.db
    .query("feed")
    .withIndex("by_other_at", function (q) {
      return q.eq("otherHackerId", id);
    })
    .collect();
  const own = await ctx.db
    .query("feed")
    .withIndex("by_hacker_at", function (q) {
      return q.eq("hackerId", id);
    })
    .collect();
  return fromCrew.filter(function (e) { return e.kind === "props" && e.fromCustomer !== true; }).length +
    own.filter(function (e) { return e.kind === "props" && e.fromCustomer === true; }).length;
}

// Never below zero: a flick only takes what is there.
function xpFrom(c: Counts): number {
  return Math.max(
    0,
    c.assists * XP.assist + c.asks * XP.ask + c.flicks * XP.flick + c.knocks * XP.knock + c.handoffs * XP.handoff + c.props * XP.props + c.flickXp,
  );
}

export async function xpOf(ctx: QueryCtx, id: Id<"hackers">): Promise<number> {
  return xpFrom(await countsFor(ctx, id));
}

const row = v.object({
  handle: v.string(),
  me: v.boolean(),
  xp: v.number(),
  rank: v.string(),
  rankAt: v.number(),
  nextRankAt: v.union(v.number(), v.null()),
  assists: v.number(),
  asks: v.number(),
  // Hand-offs done for crewmates, and props received.
  handoffs: v.optional(v.number()),
  props: v.optional(v.number()),
  tier: v.optional(v.string()),
  hidden: v.boolean(),
});

// The viewer and their crew (their friends, for now), most XP first. Someone who hides is left out, except to themselves.
export const board = query({
  args: {},
  returns: v.array(row),
  handler: async function (ctx) {
    const me = await requireHacker(ctx);
    const out = [];
    for (const id of [me._id, ...(await acceptedFriendIds(ctx, me._id))]) {
      const hacker = await ctx.db.get("hackers", id);
      if (hacker === null) continue;
      const hidden = hacker.hideFromBoards === true;
      if (hidden && id !== me._id) continue;
      const counts = await countsFor(ctx, id);
      const { assists, asks, handoffs, props } = counts;
      const xp = xpFrom(counts);
      const rank = rankFor(xp);
      const profile = await ctx.db
        .query("supersetProfiles")
        .withIndex("by_hacker", function (q) {
          return q.eq("hackerId", id);
        })
        .unique();
      out.push({
        handle: hacker.handle,
        me: id === me._id,
        xp,
        rank: rank.rank,
        rankAt: rank.at,
        nextRankAt: rank.next,
        assists,
        asks,
        handoffs,
        props,
        tier: profile?.tier,
        hidden,
      });
    }
    out.sort(function (a, b) { return b.xp - a.xp || a.handle.localeCompare(b.handle); });
    return out;
  },
});
