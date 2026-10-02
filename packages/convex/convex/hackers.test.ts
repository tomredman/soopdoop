import { describe, expect, test } from "bun:test";
import { api } from "./_generated/api";
import { harness } from "./testing.helpers";

describe("hackers", function () {
  test("a handle is claimed once, checked, and case-insensitive", async function () {
    const t = harness();
    const tom = t.withIdentity({ subject: "superset|u1", issuer: "https://api.superset.sh" });
    expect(await tom.query(api.hackers.me, {})).toBeNull();
    await expect(tom.mutation(api.hackers.claimHandle, { handle: "t" })).rejects.toThrow("2 to 39");
    await expect(tom.mutation(api.hackers.claimHandle, { handle: "tom--x" })).rejects.toThrow("2 to 39");
    await expect(tom.mutation(api.hackers.claimHandle, { handle: "Tom Redman" })).rejects.toThrow("2 to 39");
    await tom.mutation(api.hackers.claimHandle, { handle: "Tom" });
    const me = await tom.query(api.hackers.me, {});
    expect(me?.handle).toBe("tom");
    expect(me?.shareAgentNames).toBe(false);
    await expect(tom.mutation(api.hackers.claimHandle, { handle: "tom2" })).rejects.toThrow("already have a handle");

    const other = t.withIdentity({ subject: "superset|u2", issuer: "https://api.superset.sh" });
    await expect(other.mutation(api.hackers.claimHandle, { handle: "TOM" })).rejects.toThrow("taken");
    await expect(t.query(api.hackers.me, {})).resolves.toBeNull();
    await expect(t.mutation(api.hackers.claimHandle, { handle: "anon" })).rejects.toThrow("Not signed in");
  });

  test("focus mode has an end time and can be turned off", async function () {
    const t = harness();
    const tom = t.withIdentity({ subject: "superset|u1", issuer: "https://api.superset.sh" });
    await tom.mutation(api.hackers.claimHandle, { handle: "tom" });
    const before = Date.now();
    await tom.mutation(api.hackers.setFocus, { minutes: 25 });
    const on = await tom.query(api.hackers.me, {});
    expect(on?.focusUntil).toBeGreaterThanOrEqual(before + 25 * 60_000);
    await tom.mutation(api.hackers.setFocus, { minutes: null });
    expect((await tom.query(api.hackers.me, {}))?.focusUntil).toBeUndefined();
  });
});
