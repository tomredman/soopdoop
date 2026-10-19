// ABOUTME: Scheduled jobs. Linked Superset profiles are refreshed every 6 hours; the wire drops week-old events daily; every
// ABOUTME: hour the digest tick writes the crews whose digest hour it is. Intervals, not fixed minutes, so Convex spreads the runs.
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("refresh superset profiles", { hours: 6 }, internal.superset.refreshAll, {});
crons.interval("prune the wire", { hours: 24 }, internal.feed.prune, {});
// Each crew's digest goes out in its own time zone, so the tick runs every hour and checks each crew's local hour.
crons.interval("write crew digests", { hours: 1 }, internal.digests.tick, {});

export default crons;
