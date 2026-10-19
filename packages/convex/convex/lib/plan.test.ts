// ABOUTME: Tests for the plan limits: free for friends and anyone in no crew, team for a paying crew, with the plan's
// ABOUTME: numbers.
import { describe, expect, test } from "bun:test";
import type { Doc, Id } from "../_generated/dataModel";
import { FREE, limitsFor, TEAM } from "./plan";

function crew(plan: "free" | "team"): Doc<"crews"> {
  return {
    _id: "crew1" as Id<"crews">,
    _creationTime: 0,
    name: "tom's crew",
    leaderId: "tom1" as Id<"hackers">,
    plan,
    digestHour: 9,
    timezone: "UTC",
    createdAt: 0,
  };
}

describe("plan limits", function () {
  test("the free plan is for friends and anyone in no crew; the team plan is the paid one", function () {
    expect(limitsFor(null)).toEqual(FREE);
    expect(limitsFor(crew("free"))).toEqual(FREE);
    expect(limitsFor(crew("team"))).toEqual(TEAM);
  });

  test("the numbers are the ones in the plan (docs/plan-crews.html §12)", function () {
    expect(FREE).toEqual({ questionsPerDay: 20, ledgerDays: 7, handoffsPerDay: 5, liveNotes: 10, agentNotes: false, digest: false, scout: false, dropBytes: 0 });
    expect(TEAM).toEqual({ questionsPerDay: 500, ledgerDays: 90, handoffsPerDay: Infinity, liveNotes: 60, agentNotes: true, digest: true, scout: true, dropBytes: 5e9 });
  });
});
