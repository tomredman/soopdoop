// ABOUTME: Scheduled jobs. Linked Superset profiles are refreshed every 6 hours; the wire and the ledger drop old lines and lapsed
// ABOUTME: team plans end daily, heads-ups weekly; every hour the digest tick writes the crews whose digest hour it is. Intervals.
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("refresh superset profiles", { hours: 6 }, internal.superset.refreshAll, {});
crons.interval("prune the wire", { hours: 24 }, internal.feed.prune, {});
// Each crew's digest goes out in its own time zone, so the tick runs every hour and checks each crew's local hour.
crons.interval("write crew digests", { hours: 1 }, internal.digests.tick, {});
crons.interval("prune the ledger", { hours: 24 }, internal.ledger.prune, {});
crons.interval("prune heads-ups", { hours: 24 * 7 }, internal.headsups.prune, {});
// A crew whose renewal went unpaid keeps the team plan 3 days past its paid period, then this moves it to free.
crons.interval("end lapsed team plans", { hours: 24 }, internal.billing.expire, {});

export default crons;
