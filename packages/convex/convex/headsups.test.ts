import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { CARD_MS } from "./headsups";
import { type Actor, befriend, hackerNamed, harness, type Harness, link, must, settleScheduled } from "./testing.helpers";

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

function agent(agentId: string, name: string) {
  return { agentId, harness: "claude-code", name, workspace: "vibes", status: "working" as const, open: true, lastTurnAt: Date.now() };
}

async function machine(t: Harness, as: Actor, name: string, agents: ReturnType<typeof agent>[]): Promise<string> {
  const token = await as.mutation(api.subsets.pairDaemon, { machineName: name });
  await t.mutation(api.subsets.report, { token, agents });
  return token;
}

// Tom and Jimmy are crewmates. Jimmy's agent is deep in email metrics; Tom's Mac sees a prompt about the same thing.
async function crew(t: Harness) {
  const tom = await hackerNamed(t, "tom");
  const jimmy = await hackerNamed(t, "jimmy");
  await befriend(tom, jimmy, "jimmy");
  const tomToken = await machine(t, tom, "mbp16", [agent("t1", "rail")]);
  const jimmyToken = await machine(t, jimmy, "jm", [agent("a1", "email-metrics"), agent("a2", "taxes")]);
  await t.mutation(api.routing.update, { token: jimmyToken, agentId: "a1", summary: "vibes · \"fix the email metrics bounce counts\" · files: packages/email/send.ts" });
  return { tom, jimmy, tomToken, jimmyToken };
}

const LINE = "Jimmy's agent is on email metrics right now (packages/email, apps/web/metrics)";

function headsUp(token: string, otherAgentId = "a1", line = LINE) {
  return { token, otherHandle: "@Jimmy", otherAgentId, kind: "area" as const, line, agentId: "t1" };
}

async function rows(t: Harness) {
  return await t.run(async function (ctx) { return await ctx.db.query("headsups").collect(); });
}

describe("heads-ups", function () {
  test("a heads-up is a card for 10 minutes, one per pair of agents, with the crewmate's name and, when shared, the agent's", async function () {
    const t = harness();
    const { tom, jimmy, tomToken } = await crew(t);
    await t.run(async function (ctx) {
      const jimmyId = must(await ctx.db.query("hackers").withIndex("by_handle", function (q) { return q.eq("handle", "jimmy"); }).unique())._id;
      await ctx.db.insert("supersetProfiles", { hackerId: jimmyId, handle: "jimmy-vibes", name: "Jimmy Lee", achievements: [], models: [], fetchedAt: Date.now() });
    });
    const before = Date.now();
    const id = await t.mutation(api.headsups.record, headsUp(tomToken));
    const [card] = await tom.query(api.headsups.cards, {});
    expect(card).toMatchObject({ _id: id, otherHandle: "jimmy", otherName: "Jimmy Lee", otherAgentId: "a1", kind: "area", line: LINE });
    expect(card?.otherAgentName).toBeUndefined();
    expect(must(card).expiresAt - must(card).at).toBe(CARD_MS);
    // Its end is a scheduled function.
    const jobs = await t.run(async function (ctx) { return await ctx.db.system.query("_scheduled_functions").collect(); });
    const end = must(jobs.find(function (j) { return j.name.includes("headsups:expire"); }));
    expect(end.scheduledTime).toBeGreaterThanOrEqual(before + CARD_MS);

    // The same pair again refreshes the card; another agent of Jimmy's is another card.
    await jimmy.mutation(api.hackers.updateSharing, { shareAgentNames: true, shareWorkspaceNames: false });
    expect(await t.mutation(api.headsups.record, { ...headsUp(tomToken), kind: "files", line: "Jimmy's agent is editing packages/email/send.ts too" })).toBe(id);
    expect(await tom.query(api.headsups.cards, {})).toMatchObject([{ _id: id, kind: "files", line: "Jimmy's agent is editing packages/email/send.ts too", otherAgentName: "email-metrics" }]);
    const other = await t.mutation(api.headsups.record, headsUp(tomToken, "a2", "Jimmy's agent is on taxes"));
    expect(other).not.toBe(id);
    expect((await tom.query(api.headsups.cards, {})).map(function (c) { return c._id; }).sort()).toEqual([id, other].sort());
    // Jimmy sees no card about himself.
    expect(await jimmy.query(api.headsups.cards, {})).toEqual([]);
  });

  test("only about a crewmate, never about yourself, and never without a line; secrets are taken out", async function () {
    const t = harness();
    const { tomToken } = await crew(t);
    await hackerNamed(t, "sam");
    await expect(t.mutation(api.headsups.record, { ...headsUp(tomToken), otherHandle: "sam" })).rejects.toThrow("No crewmate has that handle");
    await expect(t.mutation(api.headsups.record, { ...headsUp(tomToken), otherHandle: "nobody" })).rejects.toThrow("No crewmate has that handle");
    await expect(t.mutation(api.headsups.record, { ...headsUp(tomToken), otherHandle: "tom" })).rejects.toThrow("No crewmate has that handle");
    await expect(t.mutation(api.headsups.record, headsUp(tomToken, "a1", "  "))).rejects.toThrow("says what");
    await expect(t.mutation(api.headsups.record, headsUp("sd_nope"))).rejects.toThrow("Unknown daemon token");
    await t.mutation(api.headsups.record, headsUp(tomToken, "a1", `Jimmy's agent is on ghp_${"a".repeat(36)} ${"y".repeat(300)}`));
    const [row] = await rows(t);
    expect(row?.line).toHaveLength(240);
    expect(row?.line).toContain("[secret]");
  });

  test("Not now: the card goes, is never counted, and the same pair gets no card for an hour", async function () {
    const t = harness();
    const { tom, jimmy, tomToken } = await crew(t);
    const id = await t.mutation(api.headsups.record, headsUp(tomToken));
    await expect(jimmy.mutation(api.headsups.dismiss, { headsupId: id })).rejects.toThrow("Not your heads-up");
    await tom.mutation(api.headsups.dismiss, { headsupId: id });
    expect(await tom.query(api.headsups.cards, {})).toEqual([]);
    expect(await t.mutation(api.headsups.record, headsUp(tomToken))).toBe(id);
    expect(await tom.query(api.headsups.cards, {})).toEqual([]);
    expect(await rows(t)).toHaveLength(1);
    // A dismissed card is not acted on by a knock that follows.
    await tom.mutation(api.knocks.send, { toHandle: "jimmy", item: link });
    expect(must((await rows(t))[0]).actedAt).toBeUndefined();
  });

  test("its scheduled function ends the card after 10 minutes, with no client open", async function () {
    jest.useFakeTimers();
    try {
      const t = harness();
      const { tom, tomToken } = await crew(t);
      await t.mutation(api.headsups.record, headsUp(tomToken));
      expect(await tom.query(api.headsups.cards, {})).toHaveLength(1);
      await t.finishAllScheduledFunctions(function () {
        jest.advanceTimersByTime(CARD_MS + 1);
      });
      expect(await tom.query(api.headsups.cards, {})).toEqual([]);
      expect(must((await rows(t))[0]).expiredAt).toBeDefined();
    } finally {
      jest.useRealTimers();
    }
  });

  test("knocking on the crewmate within 10 minutes acts on it: counted once, gone from the cards, and on the wire", async function () {
    const t = harness();
    const { tom, tomToken } = await crew(t);
    await t.mutation(api.headsups.record, headsUp(tomToken));
    await t.mutation(api.headsups.record, headsUp(tomToken, "a2", "Jimmy's agent is on taxes"));
    await tom.mutation(api.knocks.send, { toHandle: "jimmy", item: link });
    const marked = await rows(t);
    expect(marked.map(function (h) { return h.action; })).toEqual(["knock", "knock"]);
    expect(marked.every(function (h) { return h.actedAt !== undefined; })).toBe(true);
    expect(await tom.query(api.headsups.cards, {})).toEqual([]);
    const wire = await t.run(async function (ctx) { return await ctx.db.query("feed").collect(); });
    expect(wire.filter(function (e) { return e.kind === "headsup"; })).toMatchObject([{ text: LINE }]);
    // Acted on: the same pair gets no new card for an hour either.
    await t.mutation(api.headsups.record, headsUp(tomToken));
    expect(await rows(t)).toHaveLength(2);
  });

  test("asking the crewmate's agent through the Operator acts on it", async function () {
    const t = harness();
    const { tomToken } = await crew(t);
    await t.mutation(api.headsups.record, headsUp(tomToken));
    const relayId = await t.mutation(api.operator.ask, { token: tomToken, question: "Where are the email metrics bounce counts fixed?" });
    await t.action(internal.operator.route, { relayId });
    expect(must((await rows(t))[0]).action).toBe("ask");
  });

  test("asking one of a crewmate's agents acts only on cards about that agent, and on cards whose agent cannot be told apart", async function () {
    const t = harness();
    const { tomToken } = await crew(t);
    const aboutA1 = await t.mutation(api.headsups.record, headsUp(tomToken));
    const aboutA2 = await t.mutation(api.headsups.record, headsUp(tomToken, "a2", "Jimmy's agent is on taxes"));
    // A card that names the agent some other way (here, by a key the daemon got for it).
    const aboutKey = await t.mutation(api.headsups.record, headsUp(tomToken, "k7f3", "Jimmy's agent is on bounce counts"));
    const relayId = await t.mutation(api.operator.ask, { token: tomToken, question: "Where are the email metrics bounce counts fixed?" });
    await t.action(internal.operator.route, { relayId });
    const byId = new Map((await rows(t)).map(function (h) { return [h._id, h]; }));
    expect(byId.get(aboutA1)?.action).toBe("ask");
    expect(byId.get(aboutA2)?.actedAt).toBeUndefined();
    expect(byId.get(aboutKey)?.action).toBe("ask");
  });

  test("a private agent's prompts make no heads-up", async function () {
    const t = harness();
    const { tom } = await crew(t);
    const token = await machine(t, tom, "mb2", [{ ...agent("p1", "secret-stuff"), open: false }]);
    await expect(t.mutation(api.headsups.record, { ...headsUp(token), agentId: "p1" })).rejects.toThrow("private agent");
    expect(await rows(t)).toEqual([]);
  });

  test("handing the task off from the card acts on it", async function () {
    const t = harness();
    const { tom, tomToken } = await crew(t);
    await t.mutation(api.headsups.record, headsUp(tomToken));
    await tom.mutation(api.handoffs.offer, { toHandle: "jimmy", text: "Fix the double-counted bounces in the email metrics", via: "headsup" });
    expect(must((await rows(t))[0]).action).toBe("handoff");
  });

  test("only cards from the last 10 minutes count, and only cards about that crewmate", async function () {
    const t = harness();
    const { tom, tomToken } = await crew(t);
    const ada = await hackerNamed(t, "adalovelace");
    await befriend(tom, ada, "adalovelace");
    await machine(t, ada, "al", [agent("d1", "quote-page")]);
    const old = await t.mutation(api.headsups.record, headsUp(tomToken));
    await t.run(async function (ctx) { await ctx.db.patch("headsups", old, { at: Date.now() - CARD_MS - 1_000, expiresAt: Date.now() - 1_000 }); });
    const aboutAda = await t.mutation(api.headsups.record, { ...headsUp(tomToken, "d1", "Ada's agent is on the quote page"), otherHandle: "adalovelace" });
    await tom.mutation(api.knocks.send, { toHandle: "jimmy", item: link });
    const byId = new Map((await rows(t)).map(function (h) { return [h._id, h]; }));
    expect(byId.get(old)?.actedAt).toBeUndefined();
    expect(byId.get(aboutAda)?.actedAt).toBeUndefined();
  });

  test("the weekly prune drops heads-ups older than a week", async function () {
    const t = harness();
    const { tomToken } = await crew(t);
    const fresh = await t.mutation(api.headsups.record, headsUp(tomToken));
    const stale: Id<"headsups"> = await t.mutation(api.headsups.record, headsUp(tomToken, "a2", "Jimmy's agent is on taxes"));
    await t.run(async function (ctx) { await ctx.db.patch("headsups", stale, { at: Date.now() - 8 * 24 * 60 * 60 * 1000 }); });
    await t.mutation(internal.headsups.prune, {});
    expect((await rows(t)).map(function (h) { return h._id; })).toEqual([fresh]);
  });
});
