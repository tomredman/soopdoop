// ABOUTME: What each plan allows a crew (docs/plan-crews.html §12): free for friends, team at $10 a member a month.
// ABOUTME: Each limit is enforced where the thing happens (notes.add, digests.tick, the scout, ...); a hacker in no crew is on free.
import type { Doc } from "../_generated/dataModel";

export interface Limits {
  // Questions to the Operator per crew per day (the team plan's is a soft cap, raised on request).
  questionsPerDay: number;
  // How long ledger lines are kept.
  ledgerDays: number;
  handoffsPerDay: number;
  liveNotes: number;
  // Agents may propose crew notes, and a trusted crewmate's agents may post them straight away.
  agentNotes: boolean;
  // The daily digest, the weekly numbers and the Slack bridge (the live mirror too).
  digest: boolean;
  // Props and saves from customers: the scout on members' Macs and help-desk webhooks.
  scout: boolean;
  // Drops storage per crew; 0 means links only.
  dropBytes: number;
}

export const FREE: Limits = {
  questionsPerDay: 20,
  ledgerDays: 7,
  handoffsPerDay: 5,
  liveNotes: 10,
  agentNotes: false,
  digest: false,
  scout: false,
  dropBytes: 0,
};

export const TEAM: Limits = {
  questionsPerDay: 500,
  ledgerDays: 90,
  handoffsPerDay: Infinity,
  liveNotes: 60,
  agentNotes: true,
  digest: true,
  scout: true,
  dropBytes: 5e9,
};

// The limits for a crew's plan. Null (a hacker in no crew) is the free plan. Billing moves `plan` back to "free" when a
// subscription ends, so `planUntil` is not checked here.
export function limitsFor(crew: Doc<"crews"> | null): Limits {
  return crew !== null && crew.plan === "team" ? TEAM : FREE;
}
