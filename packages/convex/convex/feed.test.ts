import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { rallyIsNews, tokensSaved } from "./feed";
import { SUPER_EVERY } from "./flicks";
import { type Actor, befriend, hackerNamed, harness, type Harness, must, settleScheduled } from "./testing.helpers";

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
});

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
