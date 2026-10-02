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
  "./friends.ts": function () {
    return import("./friends");
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
  "./lib/supersetProfile.ts": function () {
    return import("./lib/supersetProfile");
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

export function harness() {
  return convexTest(schema, modules);
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
