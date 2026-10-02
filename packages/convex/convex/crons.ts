// ABOUTME: Scheduled jobs. Linked Superset profiles are refreshed every 6 hours.
// ABOUTME: An interval, not a fixed minute, so Convex spreads the runs (the no-top-of-hour-crons lint rule).
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("refresh superset profiles", { hours: 6 }, internal.superset.refreshAll, {});

export default crons;
