// ABOUTME: What each crew plan allows (docs/plan-crews.html §12): questions a day, how long the ledger keeps lines,
// ABOUTME: hand-offs a day, live notes and the team plan's extras. A hacker in no crew is on the free plan.
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

export interface Limits {
  questionsPerDay: number;
  ledgerDays: number;
  handoffsPerDay: number;
  liveNotes: number;
  agentNotes: boolean;
  digest: boolean;
  scout: boolean;
  dropBytes: number;
}

const FREE: Limits = {
  questionsPerDay: 20,
  ledgerDays: 7,
  handoffsPerDay: 5,
  liveNotes: 10,
  agentNotes: false,
  digest: false,
  scout: false,
  dropBytes: 0,
};

const TEAM: Limits = {
  questionsPerDay: 500,
  ledgerDays: 90,
  handoffsPerDay: Infinity,
  liveNotes: 60,
  agentNotes: true,
  digest: true,
  scout: true,
  dropBytes: 5e9,
};

// The crew's limits. Null (no crew) is the free plan.
export function limitsFor(crew: Doc<"crews"> | null): Limits {
  return crew !== null && crew.plan === "team" ? TEAM : FREE;
}

// The crew a hacker is in, or null. TODO(crews): lib/crew.ts (agent A1) has the real crewOf with this signature; import
// it from there once that branch is merged, and drop this copy.
export async function crewOf(ctx: QueryCtx, hackerId: Id<"hackers">): Promise<Doc<"crews"> | null> {
  const member = await ctx.db
    .query("crewMembers")
    .withIndex("by_hacker", function (q) {
      return q.eq("hackerId", hackerId);
    })
    .first();
  return member === null ? null : await ctx.db.get("crews", member.crewId);
}
