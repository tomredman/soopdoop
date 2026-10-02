import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { NOT_CONFIGURED } from "./lib/claude";
import { rankFor } from "./play";
import { type Actor, befriend, hackerNamed, harness, type Harness, must } from "./testing.helpers";

const CONTEXT = [
  "user: where do we filter expired listings for the market update?",
  "assistant: Expired listings are dropped in convex/marketUpdate/select.ts, by listDate, before the closest six are picked.",
].join("\n");

function agent(agentId: string, name: string, open: boolean, status: "working" | "idle" = "working") {
  return { agentId, harness: "claude-code", name, workspace: "vibes", status, open, lastTurnAt: Date.now() };
}

// Pairs a machine for a hacker and reports its agents, as the daemon does.
async function machine(t: Harness, as: Actor, name: string, agents: ReturnType<typeof agent>[]): Promise<string> {
  const token = await as.mutation(api.subsets.pairDaemon, { machineName: name });
  await t.mutation(api.subsets.report, { token, agents });
  return token;
}

async function crew(t: Harness) {
  const tom = await hackerNamed(t, "tom");
  const jimmy = await hackerNamed(t, "jimmy");
  await befriend(tom, jimmy, "jimmy");
  const jimmyToken = await machine(t, jimmy, "jm", [agent("a1", "listing-cards", true), agent("a2", "taxes", false)]);
  await t.mutation(api.routing.update, { token: jimmyToken, agentId: "a1", summary: "vibes · market update listings · files: convex/marketUpdate/select.ts" });
  return { tom, jimmy, jimmyToken };
}

function answer(t: Harness, body: Record<string, unknown>) {
  return t.fetch("/operator/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

let savedFake: string | undefined;
beforeEach(function () {
  savedFake = process.env.OPERATOR_FAKE;
  process.env.OPERATOR_FAKE = "1";
});
afterEach(function () {
  if (savedFake === undefined) delete process.env.OPERATOR_FAKE;
  else process.env.OPERATOR_FAKE = savedFake;
});

describe("the Operator", function () {
  test("a question reaches the crewmate agent that knows, and the answer comes back to both of them", async function () {
    const t = harness();
    const { tom, jimmy, jimmyToken } = await crew(t);
    await jimmy.mutation(api.hackers.updateSharing, { shareAgentNames: true, shareWorkspaceNames: false });

    const relayId = await tom.mutation(api.operator.askAsHacker, { question: "Where are expired listings filtered?" });
    await t.action(internal.operator.route, { relayId });
    // Jimmy's daemon is told which agent to read, and nothing else.
    expect(await t.query(api.operator.readsFor, { token: jimmyToken })).toEqual([{ relayId, agentId: "a1" }]);

    const res = await answer(t, { token: jimmyToken, relayId, context: CONTEXT });
    expect(res.status).toBe(200);
    const [asked] = await tom.query(api.operator.log, {});
    expect(asked).toMatchObject({ _id: relayId, status: "answered", role: "asked", askerHandle: "tom", targetHandle: "jimmy", targetAgentName: "listing-cards" });
    expect(asked?.answer).toContain("convex/marketUpdate/select.ts");
    expect(asked?.tokensRead).toBeGreaterThan(0);
    expect((await jimmy.query(api.operator.log, {}))[0]).toMatchObject({ _id: relayId, role: "answered" });
    expect(await t.query(api.operator.readsFor, { token: jimmyToken })).toEqual([]);

    // What was read is gone: the relay keeps the question and the short answer only. The context's other line is nowhere.
    const stored = await t.run(async function (ctx) { return await ctx.db.get("relays", relayId); });
    expect(JSON.stringify(stored)).not.toContain("for the market update");

    // An assist for Jimmy, a question for Tom.
    const board = await tom.query(api.play.board, {});
    expect(board.map(function (r) { return [r.handle, r.xp, r.assists, r.asks, r.rank]; })).toEqual([
      ["jimmy", 10, 1, 0, "n00b"],
      ["tom", 1, 0, 1, "n00b"],
    ]);
  });

  test("an agent's name stays hidden unless its owner shares agent names", async function () {
    const t = harness();
    const { tom, jimmyToken } = await crew(t);
    const relayId = await tom.mutation(api.operator.askAsHacker, { question: "Where are expired listings filtered?" });
    await t.action(internal.operator.route, { relayId });
    await answer(t, { token: jimmyToken, relayId, context: CONTEXT });
    const [asked] = await tom.query(api.operator.log, {});
    expect(asked?.targetHandle).toBe("jimmy");
    expect(asked?.targetAgentName).toBeUndefined();
  });

  test("an agent can ask through its machine's token, and only the asker can follow the answer", async function () {
    const t = harness();
    const { tom, jimmy, jimmyToken } = await crew(t);
    const tomToken = await machine(t, tom, "mbp16", [agent("t1", "rail", true)]);
    const relayId = await t.mutation(api.operator.ask, { token: tomToken, question: "Where are expired listings filtered?" });
    expect((await t.query(api.operator.relay, { token: tomToken, relayId }))?.status).toBe("routing");
    expect(await t.query(api.operator.relay, { token: jimmyToken, relayId })).toBeNull();
    await t.action(internal.operator.route, { relayId });
    await answer(t, { token: jimmyToken, relayId, context: CONTEXT });
    expect((await t.query(api.operator.relay, { token: tomToken, relayId }))?.status).toBe("answered");
    // Tom's own agents are never asked his own question.
    expect(await t.query(api.operator.readsFor, { token: tomToken })).toEqual([]);
    void jimmy;
  });

  test("only the daemon a relay waits on can answer it, once", async function () {
    const t = harness();
    const { tom, jimmyToken } = await crew(t);
    const tomToken = await machine(t, tom, "mbp16", []);
    const relayId = await tom.mutation(api.operator.askAsHacker, { question: "Where are expired listings filtered?" });
    await t.action(internal.operator.route, { relayId });
    expect((await answer(t, { token: tomToken, relayId, context: CONTEXT })).status).toBe(404);
    expect((await answer(t, { token: "sd_nope", relayId, context: CONTEXT })).status).toBe(404);
    expect((await answer(t, { token: jimmyToken, relayId: "not-an-id", context: CONTEXT })).status).toBe(404);
    expect((await answer(t, { token: jimmyToken, relayId })).status).toBe(400);
    expect((await answer(t, { token: jimmyToken, relayId, context: "x".repeat(300_000) })).status).toBe(413);
    expect((await answer(t, { token: jimmyToken, relayId, refused: "That agent ended." })).status).toBe(200);
    expect((await tom.query(api.operator.log, {}))[0]).toMatchObject({ status: "not-found", note: "That agent ended." });
    // Already finished: a second answer is refused.
    expect((await answer(t, { token: jimmyToken, relayId, context: CONTEXT })).status).toBe(404);
  });

  test("with nobody to ask, says so; private and offline agents are never asked", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const lonely = await tom.mutation(api.operator.askAsHacker, { question: "Anyone?" });
    await t.action(internal.operator.route, { relayId: lonely });
    expect((await tom.query(api.operator.log, {}))[0]).toMatchObject({ status: "nobody" });

    const mira = await hackerNamed(t, "mira");
    await befriend(tom, mira, "mira");
    await machine(t, mira, "mm", [agent("m1", "secret-stuff", false)]);
    const privateOnly = await tom.mutation(api.operator.askAsHacker, { question: "Anyone at all?" });
    await t.action(internal.operator.route, { relayId: privateOnly });
    expect((await tom.query(api.operator.log, {}))[0]).toMatchObject({ _id: privateOnly, status: "nobody" });
  });

  test("without a Claude key the Operator says what is missing", async function () {
    delete process.env.OPERATOR_FAKE;
    const t = harness();
    const { tom } = await crew(t);
    const relayId = await tom.mutation(api.operator.askAsHacker, { question: "Where are expired listings filtered?" });
    await t.action(internal.operator.route, { relayId });
    expect((await tom.query(api.operator.log, {}))[0]).toMatchObject({ status: "error", note: NOT_CONFIGURED });
  });

  test("a relay that waits too long times out, and a late answer changes nothing", async function () {
    const t = harness();
    const { tom, jimmyToken } = await crew(t);
    const relayId = await tom.mutation(api.operator.askAsHacker, { question: "Where are expired listings filtered?" });
    await t.action(internal.operator.route, { relayId });
    await t.mutation(internal.operator.expire, { relayId });
    expect((await tom.query(api.operator.log, {}))[0]).toMatchObject({ status: "timeout" });
    expect((await answer(t, { token: jimmyToken, relayId, context: CONTEXT })).status).toBe(404);
    // Routing again after the end does nothing.
    await t.action(internal.operator.route, { relayId });
    expect((await tom.query(api.operator.log, {}))[0]?.status).toBe("timeout");
  });

  test("questions are checked and limited", async function () {
    const t = harness();
    const { tom } = await crew(t);
    await expect(tom.mutation(api.operator.askAsHacker, { question: "  " })).rejects.toThrow("Ask a question");
    await expect(tom.mutation(api.operator.askAsHacker, { question: "x".repeat(501) })).rejects.toThrow("under 500");
    for (let i = 0; i < 6; i++) await tom.mutation(api.operator.askAsHacker, { question: `question ${i}` });
    await expect(tom.mutation(api.operator.askAsHacker, { question: "one more" })).rejects.toThrow("Wait a minute");
  });
});

describe("routing summaries", function () {
  test("only for open agents this machine reported, and dropped when the agent ends", async function () {
    const t = harness();
    const { jimmy, jimmyToken } = await crew(t);
    await t.mutation(api.routing.update, { token: jimmyToken, agentId: "a2", summary: "private work" });
    await t.mutation(api.routing.update, { token: jimmyToken, agentId: "ghost", summary: "not reported" });
    expect((await jimmy.query(api.routing.mine, {})).map(function (s) { return s.agentId; })).toEqual(["a1"]);
    await t.mutation(api.routing.update, { token: jimmyToken, agentId: "a1", summary: "y".repeat(900) });
    expect(must((await jimmy.query(api.routing.mine, {}))[0]).summary).toHaveLength(600);
    await t.mutation(api.subsets.report, { token: jimmyToken, agents: [agent("a2", "taxes", false)] });
    expect(await jimmy.query(api.routing.mine, {})).toEqual([]);
  });
});

describe("play", function () {
  test("ranks go from n00b to legend", function () {
    expect(rankFor(0)).toEqual({ rank: "n00b", at: 0, next: 20 });
    expect(rankFor(25)).toEqual({ rank: "script kiddie", at: 20, next: 100 });
    expect(rankFor(400).rank).toBe("wizard");
    expect(rankFor(5000)).toEqual({ rank: "legend", at: 1000, next: null });
  });

  test("a hacker can hide from the board, but still sees their own row", async function () {
    const t = harness();
    const { tom, jimmy } = await crew(t);
    await jimmy.mutation(api.hackers.setHideFromBoards, { hide: true });
    expect((await tom.query(api.play.board, {})).map(function (r) { return r.handle; })).toEqual(["tom"]);
    expect((await jimmy.query(api.play.board, {})).find(function (r) { return r.me; })).toMatchObject({ handle: "jimmy", hidden: true });
    expect((await jimmy.query(api.hackers.me, {}))?.hideFromBoards).toBe(true);
  });
});

// Keeps the Id import used for readers checking relay ids in this file's assertions.
export type RelayId = Id<"relays">;
