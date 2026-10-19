// ABOUTME: Scheduled jobs. Linked Superset profiles are refreshed every 6 hours; the wire and the ledger drop old lines
// ABOUTME: daily, heads-ups weekly. Intervals, not a fixed minute, so Convex spreads the runs (the no-top-of-hour-crons lint rule).
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("refresh superset profiles", { hours: 6 }, internal.superset.refreshAll, {});
crons.interval("prune the wire", { hours: 24 }, internal.feed.prune, {});
crons.interval("prune the ledger", { hours: 24 }, internal.ledger.prune, {});
crons.interval("prune heads-ups", { hours: 24 * 7 }, internal.headsups.prune, {});

export default crons;
