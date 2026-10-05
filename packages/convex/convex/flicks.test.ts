import { describe, expect, test } from "bun:test";
import { api, internal } from "./_generated/api";
import { befriend, hackerNamed, harness, must } from "./testing.helpers";

describe("flicks", function () {
  test("a flick waits for a flick back, and each flick back adds one to the rally", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const vlad = await hackerNamed(t, "vlad");
    await befriend(tom, vlad, "vlad");

    expect(await tom.mutation(api.flicks.send, { toHandle: "@vlad" })).toEqual({ rally: 1 });
    expect(await tom.query(api.flicks.mine, {})).toEqual({ incoming: [], waitingOn: ["vlad"] });
    expect((await vlad.query(api.flicks.mine, {})).incoming).toMatchObject([{ fromHandle: "tom", rally: 1 }]);
    await expect(tom.mutation(api.flicks.send, { toHandle: "vlad" })).rejects.toThrow("Wait for @vlad to flick back.");

    expect(await vlad.mutation(api.flicks.send, { toHandle: "tom" })).toEqual({ rally: 2 });
    expect(await vlad.query(api.flicks.mine, {})).toEqual({ incoming: [], waitingOn: ["tom"] });
    expect((await tom.query(api.flicks.mine, {})).incoming).toMatchObject([{ fromHandle: "vlad", rally: 2 }]);
    expect(await tom.mutation(api.flicks.send, { toHandle: "vlad" })).toEqual({ rally: 3 });
  });

  test("an ignored flick expires, and then a new rally can start", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const vlad = await hackerNamed(t, "vlad");
    await befriend(tom, vlad, "vlad");
    await tom.mutation(api.flicks.send, { toHandle: "vlad" });

    // What the scheduled function runs when the 10 minutes are up. Fake timers moved that far would also fire timers
    // other test files left behind (the Operator's 90-second expiries).
    await t.mutation(internal.flicks.expire, { flickId: must((await vlad.query(api.flicks.mine, {})).incoming[0])._id });
    expect(await vlad.query(api.flicks.mine, {})).toEqual({ incoming: [], waitingOn: [] });
    expect(await tom.query(api.flicks.mine, {})).toEqual({ incoming: [], waitingOn: [] });
    expect(await tom.mutation(api.flicks.send, { toHandle: "vlad" })).toEqual({ rally: 1 });
  });

  test("only friends, never yourself, and someone in focus bounces it", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const vlad = await hackerNamed(t, "vlad");
    await hackerNamed(t, "mira");
    await befriend(tom, vlad, "vlad");
    await expect(tom.mutation(api.flicks.send, { toHandle: "mira" })).rejects.toThrow("You can only flick a friend.");
    await expect(tom.mutation(api.flicks.send, { toHandle: "tom" })).rejects.toThrow("You cannot flick yourself.");
    await expect(tom.mutation(api.flicks.send, { toHandle: "ghost" })).rejects.toThrow("nobody with that handle");
    await vlad.mutation(api.hackers.setFocus, { minutes: 25 });
    await expect(tom.mutation(api.flicks.send, { toHandle: "vlad" })).rejects.toThrow("@vlad is in focus mode. The flick bounced.");
  });
});
