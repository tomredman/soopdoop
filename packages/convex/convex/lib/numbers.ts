// ABOUTME: The crew's four numbers over a time window: questions answered by crewmates' agents (and the tokens that saved),
// ABOUTME: hand-offs done, heads-ups acted on, ships (and how many had a walkthrough). Crew totals only, never per person.
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { tokensSaved } from "../feed";

export interface CrewNumbers {
  answered: number;
  tokensSaved: number;
  handoffs: number;
  headsups: number;
  ships: number;
  walkthroughs: number;
}

const HOUR_MS = 60 * 60 * 1000;
// A hand-off is done at most 24 hours after its offer expires and 24 hours after it starts: look back that far.
const HANDOFF_LOOKBACK_MS = 48 * HOUR_MS;

// Counts within [from, to) for a set of crew members. Only work between members counts: a question one of them asked
// that another's agent answered, a hand-off one of them did for another.
export async function crewNumbers(ctx: QueryCtx, members: Id<"hackers">[], from: number, to: number): Promise<CrewNumbers> {
  const inCrew = new Set<Id<"hackers">>(members);
  const out: CrewNumbers = { answered: 0, tokensSaved: 0, handoffs: 0, headsups: 0, ships: 0, walkthroughs: 0 };
  for (const id of members) {
    const asked = await ctx.db
      .query("relays")
      .withIndex("by_asker", function (q) {
        return q.eq("askerHackerId", id).gte("_creationTime", from).lt("_creationTime", to);
      })
      .collect();
    for (const r of asked) {
      if (r.createdAt < from || r.createdAt >= to) continue;
      if (r.status !== "answered" || r.byOperator === true || r.targetHackerId === undefined || !inCrew.has(r.targetHackerId)) continue;
      out.answered += 1;
      out.tokensSaved += tokensSaved(r);
    }

    const done = await ctx.db
      .query("handoffs")
      .withIndex("by_to_status", function (q) {
        return q.eq("toId", id).eq("status", "done").gte("_creationTime", from - HANDOFF_LOOKBACK_MS).lt("_creationTime", to);
      })
      .collect();
    for (const h of done) {
      if (h.finishedAt !== undefined && h.finishedAt >= from && h.finishedAt < to && inCrew.has(h.fromId)) out.handoffs += 1;
    }

    // A heads-up card lasts 10 minutes, so one acted on in the window was raised at most an hour before it.
    const cards = await ctx.db
      .query("headsups")
      .withIndex("by_hacker_at", function (q) {
        return q.eq("hackerId", id).gte("at", from - HOUR_MS).lt("at", to);
      })
      .collect();
    for (const c of cards) if (c.actedAt !== undefined && c.actedAt >= from && c.actedAt < to && inCrew.has(c.otherId)) out.headsups += 1;

    const lines = await ctx.db
      .query("ledger")
      .withIndex("by_hacker_at", function (q) {
        return q.eq("hackerId", id).gte("at", from).lt("at", to);
      })
      .collect();
    for (const l of lines) {
      if (l.shipped !== true) continue;
      out.ships += 1;
      if (l.walkthrough !== undefined) out.walkthroughs += 1;
    }
  }
  return out;
}
