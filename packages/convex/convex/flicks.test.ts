import { describe, expect, test } from "bun:test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { CATCH_XP, SUPER_EVERY, SUPER_XP } from "./flicks";
import { type Actor, befriend, hackerNamed, harness, type Harness, link, must } from "./testing.helpers";

async function idOf(t: Harness, handle: string): Promise<Id<"hackers">> {
  const row = await t.run(async function (ctx) {
    return await ctx.db.query("hackers").withIndex("by_handle", function (q) { return q.eq("handle", handle); }).unique();
  });
  return must(row)._id;
}

// XP the way it is earned: each answered question is an assist, 10 XP. Someone outside the crew asks them.
async function giveAssists(t: Harness, handle: string, assists: number): Promise<void> {
  const target = await idOf(t, handle);
  await t.run(async function (ctx) {
    const asker = await ctx.db.insert("hackers", {
      handle: `asker-of-${handle}`,
      supersetUserId: `asker|${handle}`,
      shareWorkspaceNames: false,
      shareAgentNames: false,
      createdAt: Date.now(),
    });
    for (let i = 0; i < assists; i++) {
      await ctx.db.insert("relays", { askerHackerId: asker, question: "q", status: "answered", targetHackerId: target, createdAt: Date.now() });
    }
  });
}

async function xpOfHandle(as: Actor, handle: string): Promise<number> {
  return must((await as.query(api.play.board, {})).find(function (r) { return r.handle === handle; })).xp;
}

async function pair(t: Harness) {
  const tom = await hackerNamed(t, "tom");
  const hedy = await hackerNamed(t, "hedy");
  await befriend(tom, hedy, "hedy");
  return { tom, hedy };
}

// A flick from `from` that nobody caught: the catch window closes, and `to` flicks back so the next one can go.
async function cleanFlick(t: Harness, from: Actor, to: Actor, toHandle: string, fromHandle: string): Promise<void> {
  await from.mutation(api.flicks.send, { toHandle });
  const open = must((await to.query(api.flicks.mine, {})).incoming.find(function (f) { return f.fromHandle === fromHandle; }));
  await t.mutation(internal.flicks.closeCatch, { flickId: open._id });
  await t.mutation(internal.flicks.expire, { flickId: open._id });
}

describe("flicks", function () {
  test("a flick waits for a flick back, and each flick back adds one to the rally", async function () {
    const t = harness();
    const { tom, hedy } = await pair(t);

    expect(await tom.mutation(api.flicks.send, { toHandle: "@hedy" })).toEqual({ rally: 1 });
    expect(await tom.query(api.flicks.mine, {})).toMatchObject({ incoming: [], waitingOn: ["hedy"] });
    expect((await hedy.query(api.flicks.mine, {})).incoming).toMatchObject([{ fromHandle: "tom", rally: 1, superflick: false }]);
    await expect(tom.mutation(api.flicks.send, { toHandle: "hedy" })).rejects.toThrow("Wait for @hedy to flick back.");

    expect(await hedy.mutation(api.flicks.send, { toHandle: "tom" })).toEqual({ rally: 2 });
    expect(await hedy.query(api.flicks.mine, {})).toMatchObject({ incoming: [], waitingOn: ["tom"] });
    expect((await tom.query(api.flicks.mine, {})).incoming).toMatchObject([{ fromHandle: "hedy", rally: 2 }]);
    expect(await tom.mutation(api.flicks.send, { toHandle: "hedy" })).toEqual({ rally: 3 });
  });

  test("an ignored flick expires, and then a new rally can start", async function () {
    const t = harness();
    const { tom, hedy } = await pair(t);
    await tom.mutation(api.flicks.send, { toHandle: "hedy" });

    // What the scheduled function runs when the 10 minutes are up. Fake timers moved that far would also fire timers
    // other test files left behind (the Operator's 90-second expiries).
    await t.mutation(internal.flicks.expire, { flickId: must((await hedy.query(api.flicks.mine, {})).incoming[0])._id });
    expect(await hedy.query(api.flicks.mine, {})).toMatchObject({ incoming: [], waitingOn: [] });
    expect(await tom.query(api.flicks.mine, {})).toMatchObject({ incoming: [], waitingOn: [] });
    expect(await tom.mutation(api.flicks.send, { toHandle: "hedy" })).toEqual({ rally: 1 });
  });

  test("only friends, never yourself, and someone in focus bounces it", async function () {
    const t = harness();
    const { tom, hedy } = await pair(t);
    await hackerNamed(t, "mira");
    await expect(tom.mutation(api.flicks.send, { toHandle: "mira" })).rejects.toThrow("You can only flick a friend.");
    await expect(tom.mutation(api.flicks.send, { toHandle: "tom" })).rejects.toThrow("You cannot flick yourself.");
    await expect(tom.mutation(api.flicks.send, { toHandle: "ghost" })).rejects.toThrow("nobody with that handle");
    await hedy.mutation(api.hackers.setFocus, { minutes: 25 });
    await expect(tom.mutation(api.flicks.send, { toHandle: "hedy" })).rejects.toThrow("@hedy is in focus mode. The flick bounced.");
  });

  test("caught in time, the flicker loses XP to the catcher, never more than they have", async function () {
    const t = harness();
    const { tom, hedy } = await pair(t);
    await giveAssists(t, "tom", 1);

    // 10 XP, and 1 more for the flick itself.
    await tom.mutation(api.flicks.send, { toHandle: "hedy" });
    const flick = must((await hedy.query(api.flicks.mine, {})).incoming[0]);
    expect(flick.catchUntil).toBeGreaterThan(Date.now());
    expect(await hedy.mutation(api.flicks.catchFlick, { flickId: flick._id })).toEqual({ fromHandle: "tom", xp: CATCH_XP });
    expect(await xpOfHandle(tom, "tom")).toBe(10 + 1 - CATCH_XP);
    expect(await xpOfHandle(hedy, "hedy")).toBe(CATCH_XP);
    expect((await tom.query(api.flicks.mine, {})).caught).toMatchObject([{ byHandle: "hedy", xp: CATCH_XP }]);
    await expect(hedy.mutation(api.flicks.catchFlick, { flickId: flick._id })).rejects.toThrow("Too slow");

    // 7 after the next flick, 2 after its catch; then 3 after a flick, and the catch takes all 3.
    await tom.mutation(api.flicks.send, { toHandle: "hedy" });
    await hedy.mutation(api.flicks.catchFlick, { flickId: must((await hedy.query(api.flicks.mine, {})).incoming[0])._id });
    await tom.mutation(api.flicks.send, { toHandle: "hedy" });
    expect(await hedy.mutation(api.flicks.catchFlick, { flickId: must((await hedy.query(api.flicks.mine, {})).incoming[0])._id }))
      .toEqual({ fromHandle: "tom", xp: 3 });
    expect(await xpOfHandle(tom, "tom")).toBe(0);
    expect(await xpOfHandle(hedy, "hedy")).toBe(CATCH_XP * 2 + 3);
  });

  test("every flick sent is 1 XP and every knock sent 2, whatever happens to them", async function () {
    const t = harness();
    const { tom, hedy } = await pair(t);
    await tom.mutation(api.flicks.send, { toHandle: "hedy" });
    await t.mutation(internal.flicks.expire, { flickId: must((await hedy.query(api.flicks.mine, {})).incoming[0])._id });
    await tom.mutation(api.flicks.send, { toHandle: "hedy" });
    await tom.mutation(api.knocks.send, { toHandle: "hedy", item: link });
    expect(await xpOfHandle(tom, "tom")).toBe(2 * 1 + 2);
    expect(await xpOfHandle(hedy, "hedy")).toBe(0);
  });

  test("once the catch window closes, it can only be flicked back", async function () {
    const t = harness();
    const { tom, hedy } = await pair(t);
    await tom.mutation(api.flicks.send, { toHandle: "hedy" });
    const flick = must((await hedy.query(api.flicks.mine, {})).incoming[0]);
    await t.mutation(internal.flicks.closeCatch, { flickId: flick._id });
    expect(must((await hedy.query(api.flicks.mine, {})).incoming[0]).catchUntil).toBe(0);
    await expect(hedy.mutation(api.flicks.catchFlick, { flickId: flick._id })).rejects.toThrow("Too slow. You can still flick back.");
    await expect(tom.mutation(api.flicks.catchFlick, { flickId: flick._id })).rejects.toThrow("That is not your flick.");
  });

  test("five clean flicks in a row earn a superflick; it takes XP from anyone, focus or not, and cannot be caught", async function () {
    const t = harness();
    const { tom, hedy } = await pair(t);
    await giveAssists(t, "hedy", 3);
    await expect(tom.mutation(api.flicks.superflick, { toHandle: "hedy" })).rejects.toThrow("No superflick yet");

    // Four clean, then caught: the count starts over.
    for (let i = 0; i < SUPER_EVERY - 1; i++) await cleanFlick(t, tom, hedy, "hedy", "tom");
    expect((await tom.query(api.flicks.mine, {})).superflicks).toEqual({ ready: 0, clean: SUPER_EVERY - 1, every: SUPER_EVERY });
    await tom.mutation(api.flicks.send, { toHandle: "hedy" });
    await hedy.mutation(api.flicks.catchFlick, { flickId: must((await hedy.query(api.flicks.mine, {})).incoming[0])._id });
    expect((await tom.query(api.flicks.mine, {})).superflicks).toMatchObject({ ready: 0, clean: 0 });

    for (let i = 0; i < SUPER_EVERY; i++) await cleanFlick(t, tom, hedy, "hedy", "tom");
    expect((await tom.query(api.flicks.mine, {})).superflicks).toMatchObject({ ready: 1, clean: 0 });

    await hedy.mutation(api.hackers.setFocus, { minutes: 25 });
    const before = await xpOfHandle(hedy, "hedy");
    expect(await tom.mutation(api.flicks.superflick, { toHandle: "@hedy" })).toEqual({ xp: SUPER_XP, ready: 0 });
    expect(await xpOfHandle(hedy, "hedy")).toBe(before - SUPER_XP);
    const hit = must((await hedy.query(api.flicks.mine, {})).incoming.find(function (f) { return f.superflick; }));
    expect(hit).toMatchObject({ fromHandle: "tom", xp: SUPER_XP, catchUntil: 0 });
    await expect(hedy.mutation(api.flicks.catchFlick, { flickId: hit._id })).rejects.toThrow("Nobody catches a superflick.");
    await expect(tom.mutation(api.flicks.superflick, { toHandle: "hedy" })).rejects.toThrow("No superflick yet");
  });
});
