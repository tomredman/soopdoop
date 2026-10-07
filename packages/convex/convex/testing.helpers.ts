// ABOUTME: Builds the convex-test harness under `bun test`, which has no import.meta.glob.
// ABOUTME: Two dots in the file name keep Convex from bundling it as a function module (it skips multi-dot names).
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";

const modules = {
  "./_generated/api.js": function () {
    return import("./_generated/api.js");
  },
  "./_generated/server.js": function () {
    return import("./_generated/server.js");
  },
  "./flicks.ts": function () {
    return import("./flicks");
  },
  "./friends.ts": function () {
    return import("./friends");
  },
  "./http.ts": function () {
    return import("./http");
  },
  "./hackers.ts": function () {
    return import("./hackers");
  },
  "./knocks.ts": function () {
    return import("./knocks");
  },
  "./crons.ts": function () {
    return import("./crons");
  },
  "./lib/auth.ts": function () {
    return import("./lib/auth");
  },
  "./lib/claude.ts": function () {
    return import("./lib/claude");
  },
  "./lib/friendships.ts": function () {
    return import("./lib/friendships");
  },
  "./lib/summaries.ts": function () {
    return import("./lib/summaries");
  },
  "./lib/supersetProfile.ts": function () {
    return import("./lib/supersetProfile");
  },
  "./operator.ts": function () {
    return import("./operator");
  },
  "./play.ts": function () {
    return import("./play");
  },
  "./routing.ts": function () {
    return import("./routing");
  },
  "./schema.ts": function () {
    return import("./schema");
  },
  "./subsets.ts": function () {
    return import("./subsets");
  },
  "./superset.ts": function () {
    return import("./superset");
  },
};

export type Harness = ReturnType<typeof harness>;
// What `withIdentity` returns: the same accessor, acting as one hacker.
export type Actor = ReturnType<Harness["withIdentity"]>;

// Every harness made since the last settleScheduled().
const made: { finishInProgressScheduledFunctions: () => Promise<void> }[] = [];

export function harness() {
  const t = convexTest(schema, modules);
  made.push(t);
  return t;
}

// Runs the scheduled functions a test started but did not wait for (the Operator's `route` runs at once). They start on
// a timer, and a test that only awaits database calls never lets a timer fire, so they would all start during the next
// test file, against databases that are gone, and fail it.
export async function settleScheduled(): Promise<void> {
  await new Promise(function (resolve) { setTimeout(resolve, 0); });
  for (const t of made.splice(0)) await t.finishInProgressScheduledFunctions();
}

// A signed-in hacker: claims the handle and returns an accessor that acts as them.
export async function hackerNamed(t: Harness, handle: string) {
  const as = t.withIdentity({ subject: `superset|${handle}`, issuer: "https://api.superset.sh" });
  await as.mutation(api.hackers.claimHandle, { handle });
  return as;
}

// Makes two signed-in hackers friends the way the product does it: request, then accept.
export async function befriend(a: Actor, b: Actor, bHandle: string): Promise<void> {
  await a.mutation(api.friends.request, { handle: bHandle });
  const pending = await b.query(api.friends.pending, {});
  const first = must(pending[0]);
  await b.mutation(api.friends.accept, { friendshipId: first.friendshipId });
}

export function must<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error("Expected a value");
  return x;
}

export const link = { kind: "link" as const, title: "the coupon fix", url: "https://example.com/pr/1" };
