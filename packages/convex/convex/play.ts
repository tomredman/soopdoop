// ABOUTME: Play: XP and ranks from what hackers do for each other, and the crew board. Only positive signals, no tokens.
// ABOUTME: An assist (your agent answered a crewmate through the Operator) is worth 10 XP, a question asked 1.
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { query } from "./_generated/server";
import { acceptedFriendIds } from "./friends";
import { requireHacker } from "./lib/auth";

export const XP = { assist: 10, ask: 1 };

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

async function countsFor(ctx: QueryCtx, id: Id<"hackers">): Promise<{ assists: number; asks: number }> {
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
  return { assists: assists.length, asks: asks.length };
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
      const { assists, asks } = await countsFor(ctx, id);
      const xp = assists * XP.assist + asks * XP.ask;
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
        tier: profile?.tier,
        hidden,
      });
    }
    out.sort(function (a, b) { return b.xp - a.xp || a.handle.localeCompare(b.handle); });
    return out;
  },
});
