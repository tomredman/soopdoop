import { describe, expect, jest, test } from "bun:test";
import { api, internal } from "./_generated/api";
import { befriend, hackerNamed, harness, link, must } from "./testing.helpers";

describe("knocks", function () {
  test("only friends can knock, one open knock per pair, the receiver sees it, and a decision sticks", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const mira = await hackerNamed(t, "mira");
    await expect(tom.mutation(api.knocks.send, { toHandle: "mira", item: link })).rejects.toThrow("only knock on a friend");
    await befriend(tom, mira, "mira");

    const before = Date.now();
    const first = await tom.mutation(api.knocks.send, { toHandle: "Mira", item: link, note: "found it" });
    await expect(tom.mutation(api.knocks.send, { toHandle: "mira", item: link })).rejects.toThrow("already have a knock");

    const inbox = await mira.query(api.knocks.incoming, {});
    expect(inbox.current?._id).toBe(first);
    expect(inbox.current?.fromHandle).toBe("tom");
    expect(inbox.current?.note).toBe("found it");
    expect(inbox.current?.lifetimeMs).toBe(30_000);
    expect(inbox.pending).toBe(0);

    // The expiry is a scheduled function on the server, 30 s out by default.
    const jobs = await t.run(async function (ctx) {
      return await ctx.db.system.query("_scheduled_functions").collect();
    });
    expect(jobs).toHaveLength(1);
    const job = must(jobs[0]);
    expect(job.name).toContain("expire");
    expect(job.scheduledTime).toBeGreaterThanOrEqual(before + 30_000);
    expect(job.scheduledTime).toBeLessThanOrEqual(Date.now() + 30_000);

    await expect(tom.mutation(api.knocks.decide, { knockId: first, outcome: "opened" })).rejects.toThrow("Not your knock");
    await mira.mutation(api.knocks.decide, { knockId: first, outcome: "opened" });
    expect((await tom.query(api.knocks.sent, {}))[0]?.outcome).toBe("opened");
    expect((await mira.query(api.knocks.incoming, {})).current).toBeNull();

    // Expiry after a decision changes nothing.
    await t.mutation(internal.knocks.expire, { knockId: first });
    expect((await tom.query(api.knocks.sent, {}))[0]?.outcome).toBe("opened");

    // Once decided, the sender may knock again.
    await tom.mutation(api.knocks.send, { toHandle: "mira", item: link, lifetimeMs: 120_000 });
    expect((await mira.query(api.knocks.incoming, {})).current?.lifetimeMs).toBe(120_000);
  });

  test("an ignored knock expires on its own through the scheduled function", async function () {
    jest.useFakeTimers();
    try {
      const t = harness();
      const tom = await hackerNamed(t, "tom");
      const mira = await hackerNamed(t, "mira");
      await befriend(tom, mira, "mira");
      const id = await tom.mutation(api.knocks.send, { toHandle: "mira", item: link, lifetimeMs: 10_000 });
      expect((await mira.query(api.knocks.incoming, {})).current?._id).toBe(id);
      expect((await tom.query(api.knocks.sent, {}))[0]?.outcome).toBe("open");

      await t.finishAllScheduledFunctions(function () {
        jest.advanceTimersByTime(10_001);
      });

      expect((await mira.query(api.knocks.incoming, {})).current).toBeNull();
      expect((await tom.query(api.knocks.sent, {}))[0]?.outcome).toBe("expired");
    } finally {
      jest.useRealTimers();
    }
  });

  test("focus mode blocks knocks, and only 10 s, 30 s, or 2 min are allowed", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const mira = await hackerNamed(t, "mira");
    await befriend(tom, mira, "mira");
    await mira.mutation(api.hackers.setFocus, { minutes: 30 });
    await expect(tom.mutation(api.knocks.send, { toHandle: "mira", item: link })).rejects.toThrow("focus mode");
    await mira.mutation(api.hackers.setFocus, { minutes: null });
    await expect(tom.mutation(api.knocks.send, { toHandle: "mira", item: link, lifetimeMs: 5_000 })).rejects.toThrow("10 s, 30 s, or 2 min");
    await tom.mutation(api.knocks.send, { toHandle: "mira", item: link, lifetimeMs: 10_000 });
  });

  test("the receiver sees the oldest open knock; the rest wait in the pending count", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const dev = await hackerNamed(t, "dev");
    const mira = await hackerNamed(t, "mira");
    await befriend(tom, mira, "mira");
    await befriend(dev, mira, "mira");
    const fromTom = await tom.mutation(api.knocks.send, { toHandle: "mira", item: link });
    await dev.mutation(api.knocks.send, { toHandle: "mira", item: { kind: "page", title: "standup" } });
    const inbox = await mira.query(api.knocks.incoming, {});
    expect(inbox.current?._id).toBe(fromTom);
    expect(inbox.pending).toBe(1);
    await mira.mutation(api.knocks.decide, { knockId: fromTom, outcome: "not-now" });
    const next = await mira.query(api.knocks.incoming, {});
    expect(next.current?.fromHandle).toBe("dev");
    expect(next.pending).toBe(0);
    expect((await tom.query(api.knocks.sent, {}))[0]?.outcome).toBe("not-now");
  });
});
