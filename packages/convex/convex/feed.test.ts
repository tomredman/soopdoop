import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MAX_SCOUT_LINE, rallyIsNews, SCOUT_PER_DAY, SHOUT_MS, tokensSaved } from "./feed";
import { SUPER_EVERY } from "./flicks";
import { type Actor, befriend, crewIdOf, hackerNamed, harness, type Harness, invite, must, settleScheduled, teamPlan } from "./testing.helpers";

function agent(agentId: string) {
  return { agentId, harness: "claude-code", name: "listing-cards", workspace: "vibes", status: "working" as const, open: true, lastTurnAt: Date.now() };
}

async function machine(t: Harness, as: Actor, name: string, agentIds: string[]): Promise<string> {
  const token = await as.mutation(api.subsets.pairDaemon, { machineName: name });
  await t.mutation(api.subsets.report, { token, agents: agentIds.map(agent) });
  return token;
}

async function idOf(t: Harness, handle: string): Promise<Id<"hackers">> {
  const row = await t.run(async function (ctx) {
    return await ctx.db.query("hackers").withIndex("by_handle", function (q) { return q.eq("handle", handle); }).unique();
  });
  return must(row)._id;
}

// Tom, Jimmy and Hedy are all friends. Jimmy runs an agent that knows about listings.
async function crew(t: Harness) {
  const tom = await hackerNamed(t, "tom");
  const jimmy = await hackerNamed(t, "jimmy");
  const hedy = await hackerNamed(t, "hedy");
  await befriend(tom, jimmy, "jimmy");
  await befriend(tom, hedy, "hedy");
  await befriend(jimmy, hedy, "hedy");
  const jimmyToken = await machine(t, jimmy, "jm", ["a1"]);
  await t.mutation(api.routing.update, { token: jimmyToken, agentId: "a1", summary: "vibes · \"market update listings\" · files: convex/marketUpdate/select.ts" });
  return { tom, jimmy, hedy, jimmyToken };
}

// Tom asks; the Operator picks Jimmy's agent; Jimmy's daemon sends its answer, having read `tokensRead`.
async function answered(t: Harness, tom: Actor, jimmyToken: string, tokensRead: number): Promise<void> {
  const relayId = await tom.mutation(api.operator.askAsHacker, { question: "Where are the market update listings picked?" });
  await t.action(internal.operator.route, { relayId });
  const res = await t.fetch("/operator/answer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: jimmyToken, relayId, answer: "In convex/marketUpdate/select.ts, by distance.", tokensRead }),
  });
  expect(res.status).toBe(200);
}

let savedFake: string | undefined;
beforeEach(function () {
  savedFake = process.env.OPERATOR_FAKE;
  process.env.OPERATOR_FAKE = "1";
});
afterEach(async function () {
  await settleScheduled();
  if (savedFake === undefined) delete process.env.OPERATOR_FAKE;
  else process.env.OPERATOR_FAKE = savedFake;
  const f = globalThis.fetch as unknown as { mockRestore?: () => void };
  f.mockRestore?.();
});

// Tom leads a crew with Ada in it; Sam is Tom's friend, in no crew.
async function room(t: Harness) {
  const tom = await hackerNamed(t, "tom");
  const ada = await hackerNamed(t, "adalovelace");
  const sam = await hackerNamed(t, "sam");
  await invite(tom, ada);
  await befriend(tom, sam, "sam");
  return { tom, ada, sam, crewId: await crewIdOf(t, "tom") };
}

// Lets the functions scheduled at once run (a few rounds, for ones that schedule more).
async function drain(t: Harness): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise(function (resolve) { setTimeout(resolve, 5); });
    await t.finishInProgressScheduledFunctions();
  }
}

describe("the wire", function () {
  test("an answer is on the crew's wire, naming the asker only to the two of them, with what it saved", async function () {
    const t = harness();
    const { tom, jimmy, hedy, jimmyToken } = await crew(t);
    await answered(t, tom, jimmyToken, 40_000);

    const forTom = (await tom.query(api.feed.recent, {})).filter(function (e) { return e.kind === "answer"; });
    expect(forTom).toMatchObject([{ handle: "jimmy", otherHandle: "tom", me: false, otherMe: true }]);
    const saved = must(forTom[0]?.tokensSaved);
    // What the answer itself took to read comes off.
    expect(saved).toBeLessThan(40_000);
    expect(saved).toBeGreaterThan(39_900);
    expect((await jimmy.query(api.feed.recent, {})).find(function (e) { return e.kind === "answer"; })).toMatchObject({ handle: "jimmy", otherHandle: "tom", me: true, otherMe: false });
    const forHedy = must((await hedy.query(api.feed.recent, {})).find(function (e) { return e.kind === "answer"; }));
    expect(forHedy).toMatchObject({ handle: "jimmy", me: false, otherMe: false });
    expect(forHedy.otherHandle).toBeUndefined();

    // Tokens saved: Tom's questions, Jimmy's agents' answers, and the crew's.
    expect(await tom.query(api.feed.saved, {})).toEqual({ you: saved, yourAgents: 0, crew: saved });
    expect(await jimmy.query(api.feed.saved, {})).toEqual({ you: 0, yourAgents: saved, crew: saved });
    expect(await hedy.query(api.feed.saved, {})).toEqual({ you: 0, yourAgents: 0, crew: saved });
  });

  test("a crewmate starting an agent is on the wire once, not for its owner, and not while they are in focus", async function () {
    const t = harness();
    const { tom, jimmy, jimmyToken } = await crew(t);
    const started = (await tom.query(api.feed.recent, {})).filter(function (e) { return e.kind === "agent"; });
    expect(started).toMatchObject([{ handle: "jimmy", me: false }]);
    // A later summary for the same agent is not news.
    await t.mutation(api.routing.update, { token: jimmyToken, agentId: "a1", summary: "vibes · \"something else\"" });
    expect((await tom.query(api.feed.recent, {})).filter(function (e) { return e.kind === "agent"; })).toHaveLength(1);
    expect((await jimmy.query(api.feed.recent, {})).filter(function (e) { return e.kind === "agent"; })).toEqual([]);
    await jimmy.mutation(api.hackers.setFocus, { minutes: 25 });
    expect((await tom.query(api.feed.recent, {})).filter(function (e) { return e.kind === "agent"; })).toEqual([]);
  });

  test("caught flicks, superflicks and rallies are on the wire, and someone who hides from the board is not", async function () {
    const t = harness();
    const { tom, hedy, jimmy } = await crew(t);
    // A rally of 3: Tom, Hedy, Tom.
    await tom.mutation(api.flicks.send, { toHandle: "hedy" });
    await hedy.mutation(api.flicks.send, { toHandle: "tom" });
    await tom.mutation(api.flicks.send, { toHandle: "hedy" });
    // Hedy catches the next one.
    const open = must((await hedy.query(api.flicks.mine, {})).incoming[0]);
    await hedy.mutation(api.flicks.catchFlick, { flickId: open._id });

    const kinds = (await jimmy.query(api.feed.recent, {})).filter(function (e) { return e.kind !== "agent"; });
    // Tom had 2 XP, one for each flick he sent: that is what Hedy took.
    expect(kinds.map(function (e) { return [e.kind, e.handle, e.otherHandle, e.rally ?? e.xp]; })).toEqual([
      ["catch", "hedy", "tom", 2],
      ["rally", "tom", "hedy", 3],
    ]);
    expect((await tom.query(api.feed.recent, {})).find(function (e) { return e.kind === "catch"; })).toMatchObject({ otherMe: true });

    await hedy.mutation(api.hackers.setHideFromBoards, { hide: true });
    expect((await jimmy.query(api.feed.recent, {})).filter(function (e) { return e.kind !== "agent"; })).toEqual([]);
    // Hedy still sees their own.
    expect((await hedy.query(api.feed.recent, {})).filter(function (e) { return e.kind === "catch"; })).toMatchObject([{ me: true }]);
  });

  test("a superflick is on the wire", async function () {
    const t = harness();
    const { tom, hedy, jimmy } = await crew(t);
    const tomId = await idOf(t, "tom");
    const hedyId = await idOf(t, "hedy");
    // Five clean flicks already sent.
    await t.run(async function (ctx) {
      for (let i = 0; i < SUPER_EVERY; i++) {
        await ctx.db.insert("flicks", { fromHackerId: tomId, toHackerId: hedyId, rally: 1, outcome: "expired", createdAt: Date.now(), expiresAt: Date.now(), safe: true });
      }
    });
    await tom.mutation(api.flicks.superflick, { toHandle: "hedy" });
    expect((await jimmy.query(api.feed.recent, {})).find(function (e) { return e.kind === "superflick"; })).toMatchObject({ handle: "tom", otherHandle: "hedy", xp: 0 });
    void hedy;
  });

  test("shows a day, keeps a week", async function () {
    const t = harness();
    const { tom } = await crew(t);
    const jimmyId = await idOf(t, "jimmy");
    const day = 24 * 60 * 60 * 1000;
    await t.run(async function (ctx) {
      await ctx.db.insert("feed", { kind: "agent", hackerId: jimmyId, at: Date.now() - 2 * day });
      await ctx.db.insert("feed", { kind: "agent", hackerId: jimmyId, at: Date.now() - 8 * day });
    });
    expect((await tom.query(api.feed.recent, {})).filter(function (e) { return e.kind === "agent"; })).toHaveLength(1);
    await t.mutation(internal.feed.prune, {});
    const left = await t.run(async function (ctx) { return await ctx.db.query("feed").collect(); });
    expect(left.map(function (e) { return Math.round((Date.now() - e.at) / day); }).sort()).toEqual([0, 2]);
  });

  test("rallies are news at 3 and every 5; tokens saved never go below zero", function () {
    expect([1, 2, 3, 4, 5, 6, 10, 11].filter(rallyIsNews)).toEqual([3, 5, 10]);
    expect(tokensSaved({ tokensRead: 1000, tokensSent: 50 })).toBe(950);
    expect(tokensSaved({ tokensSent: 50 })).toBe(0);
    expect(tokensSaved({})).toBe(0);
  });
});

describe("the room", function () {
  test("a shout is on the crew's wire for a day, then a scheduled function removes it", async function () {
    const t = harness();
    const { tom, ada, sam } = await room(t);
    await expect(tom.mutation(api.feed.shout, { text: "  " })).rejects.toThrow("Shout something");
    await expect(tom.mutation(api.feed.shout, { text: "x".repeat(141) })).rejects.toThrow("under 140");
    const before = Date.now();
    const shoutId = await tom.mutation(api.feed.shout, { text: "  CI is red,   looking " });
    const seen = must((await ada.query(api.feed.recent, {})).find(function (e) { return e.kind === "shout"; }));
    expect(seen).toMatchObject({ _id: shoutId, handle: "tom", text: "CI is red, looking", me: false });
    expect(must(seen.expiresAt)).toBeGreaterThanOrEqual(before + SHOUT_MS);
    // Sam is Tom's friend, so a shout reaches him too (he is in no crew: his crew is his friends).
    expect((await sam.query(api.feed.recent, {})).some(function (e) { return e._id === shoutId; })).toBe(true);

    const jobs = await t.run(async function (ctx) { return await ctx.db.system.query("_scheduled_functions").collect(); });
    const expiry = must(jobs.find(function (j) { return j.name.includes("expireShout"); }));
    expect(expiry.scheduledTime).toBeGreaterThanOrEqual(before + SHOUT_MS);
    expect(expiry.args).toEqual([{ feedId: shoutId }]);

    // Past its day, it is off the wire even before the scheduled function runs; then the function removes it.
    await t.run(async function (ctx) { await ctx.db.patch("feed", shoutId, { expiresAt: Date.now() - 1 }); });
    expect((await ada.query(api.feed.recent, {})).some(function (e) { return e._id === shoutId; })).toBe(false);
    await t.mutation(internal.feed.expireShout, { feedId: shoutId });
    expect(await t.run(async function (ctx) { return await ctx.db.get("feed", shoutId); })).toBeNull();
  });

  test("props go on a crewmate's line, once per person, never on your own, and not across crews", async function () {
    const t = harness();
    const { tom, ada, sam } = await room(t);
    const line = await ada.mutation(api.feed.shout, { text: "lunch?" });
    const propsId = await tom.mutation(api.feed.props, { feedId: line });
    const given = must((await ada.query(api.feed.recent, {})).find(function (e) { return e._id === propsId; }));
    expect(given).toMatchObject({ kind: "props", handle: "tom", otherHandle: "adalovelace", otherMe: true, about: line });
    await expect(tom.mutation(api.feed.props, { feedId: line })).rejects.toThrow("already gave props");
    await expect(ada.mutation(api.feed.props, { feedId: line })).rejects.toThrow("your own line");
    // Sam is Tom's friend but not in his crew: Ada's line is not on his wire.
    await expect(sam.mutation(api.feed.props, { feedId: line })).rejects.toThrow("no longer on the wire");
    // Props on props: Ada thanks Tom.
    await ada.mutation(api.feed.props, { feedId: propsId });

    const digestLine = await t.run(async function (ctx) {
      const leader = must(await ctx.db.query("hackers").withIndex("by_handle", function (q) { return q.eq("handle", "tom"); }).unique());
      return await ctx.db.insert("feed", { kind: "digest", hackerId: leader._id, text: "Yesterday in tom's crew", at: Date.now() });
    });
    await expect(ada.mutation(api.feed.props, { feedId: digestLine })).rejects.toThrow("Operator's");
    await t.run(async function (ctx) { await ctx.db.patch("feed", line, { expiresAt: Date.now() - 1 }); });
    const late = await hackerNamed(t, "grace");
    await invite(tom, late);
    await expect(late.mutation(api.feed.props, { feedId: line })).rejects.toThrow("no longer on the wire");
  });

  test("the scout puts a customer's props or a save on the wire, on the team plan", async function () {
    const t = harness();
    const { tom, ada, crewId } = await room(t);
    const token = await ada.mutation(api.subsets.pairDaemon, { machineName: "am" });
    await expect(t.mutation(api.feed.fromScout, { token, kind: "props", line: "thanked for the CSV fix" })).rejects.toThrow("Team plan");
    await teamPlan(t, crewId);
    const long = `thanked for fixing their CSV export, key sk-ant-api03-AbCdEf0123456789xyz ${"and more ".repeat(40)}`;
    const propsId = await t.mutation(api.feed.fromScout, { token, kind: "props", line: long });
    const saveId = await t.mutation(api.feed.fromScout, { token, kind: "save", line: "a customer went from upset to thanks" });
    await expect(t.mutation(api.feed.fromScout, { token, kind: "save", line: "   " })).rejects.toThrow("one line");
    const wire = await tom.query(api.feed.recent, {});
    const props = must(wire.find(function (e) { return e._id === propsId; }));
    expect(props).toMatchObject({ kind: "props", handle: "adalovelace", fromCustomer: true });
    expect(must(props.text).length).toBeLessThanOrEqual(MAX_SCOUT_LINE);
    expect(props.text).toContain("[secret]");
    expect(props.otherHandle).toBeUndefined();
    expect(must(wire.find(function (e) { return e._id === saveId; }))).toMatchObject({ kind: "save", handle: "adalovelace", text: "a customer went from upset to thanks" });

    const adaId = await idOf(t, "adalovelace");
    await t.run(async function (ctx) {
      for (let i = 0; i < SCOUT_PER_DAY; i++) await ctx.db.insert("feed", { kind: "save", hackerId: adaId, text: `save ${i}`, at: Date.now() });
    });
    await expect(t.mutation(api.feed.fromScout, { token, kind: "props", line: "one more" })).rejects.toThrow("enough from the scout");
    await expect(t.mutation(api.feed.fromScout, { token: "sd_nope", kind: "props", line: "x" })).rejects.toThrow("Unknown daemon token");
  });

  test("the wire carries the new kinds' text, links and ids, up to 40 lines, and leaves out anyone outside the crew", async function () {
    const t = harness();
    const { tom } = await room(t);
    const [tomId, adaId, samId] = [await idOf(t, "tom"), await idOf(t, "adalovelace"), await idOf(t, "sam")];
    const now = Date.now();
    const ledgerId = await t.run(async function (ctx) {
      return await ctx.db.insert("ledger", { hackerId: adaId, at: now, harness: "claude-code", machineName: "am", sessionKey: "s1", did: "the quote page redesign", areas: ["apps/web"], files: 4, pr: "https://github.com/acme/web/pull/412", shipped: true });
    });
    await t.run(async function (ctx) {
      await ctx.db.insert("feed", { kind: "ship", hackerId: adaId, text: "the quote page redesign", url: "https://github.com/acme/web/pull/412", ledgerId, at: now - 1000 });
      // A hand-off Ada did for Sam, who is not in the crew, stays off Tom's wire.
      await ctx.db.insert("feed", { kind: "handoff", hackerId: adaId, otherHackerId: samId, text: "fixed the export", at: now - 2000 });
      for (let i = 0; i < 45; i++) await ctx.db.insert("feed", { kind: "note", hackerId: tomId, text: `note ${i}`, at: now - 10_000 - i });
    });
    const wire = await tom.query(api.feed.recent, {});
    expect(wire).toHaveLength(40);
    expect(wire[0]).toMatchObject({ kind: "ship", handle: "adalovelace", text: "the quote page redesign", url: "https://github.com/acme/web/pull/412", ledgerId });
    expect(wire.some(function (e) { return e.kind === "handoff"; })).toBe(false);
  });

  test("ships, props and saves go to Slack as they happen, when the mirror is on and the plan has the bridge", async function () {
    const t = harness();
    const { tom, ada, crewId } = await room(t);
    const posted: string[] = [];
    spyOn(globalThis, "fetch").mockImplementation(async function (_input: string | URL | Request, init?: RequestInit) {
      posted.push(String(init?.body));
      return new Response("ok", { status: 200 });
    } as unknown as typeof fetch);
    const token = await ada.mutation(api.subsets.pairDaemon, { machineName: "am" });
    const line = await ada.mutation(api.feed.shout, { text: "shipped the <quote> page & more" });

    // Webhook and mirror on, but the free plan has no Slack bridge.
    await tom.mutation(api.crews.setSlack, { webhook: "https://hooks.slack.com/services/T0/B0/madeup", mirror: true });
    await tom.mutation(api.feed.props, { feedId: line });
    await drain(t);
    expect(posted).toEqual([]);

    await teamPlan(t, crewId);
    await t.mutation(api.feed.fromScout, { token, kind: "save", line: "a customer went from upset to thanks" });
    await ada.mutation(api.feed.shout, { text: "shouts are not mirrored" });
    await drain(t);
    expect(posted).toEqual([JSON.stringify({ text: "@adalovelace may have just saved a customer: a customer went from upset to thanks" })]);

    const second = await tom.mutation(api.feed.shout, { text: "lunch & <cake>?" });
    await ada.mutation(api.feed.props, { feedId: second });
    await drain(t);
    expect(posted[1]).toBe(JSON.stringify({ text: "@adalovelace gave @tom props for: lunch &amp; &lt;cake&gt;?" }));

    // Mirror off: nothing more goes out.
    await tom.mutation(api.crews.setSlack, { mirror: false });
    await t.mutation(api.feed.fromScout, { token, kind: "props", line: "thanks for the quick fix" });
    await drain(t);
    expect(posted).toHaveLength(2);
  });
});
