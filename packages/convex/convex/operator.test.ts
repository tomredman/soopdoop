import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  agentAnswer,
  answerFrom,
  candidateLine,
  crewmatesFor,
  firstNameAndHandle,
  mentionedHandles,
  mentionNote,
  NOT_CONFIGURED,
  parseChatTurn,
  parseRoute,
  resolveMentions,
} from "./lib/claude";
import { rankFor } from "./play";
import { type Actor, befriend, hackerNamed, harness, type Harness, must, settleScheduled } from "./testing.helpers";

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

// Links a public Superset profile to a hacker, as linking it in the app does.
async function linkSuperset(t: Harness, handle: string, supersetHandle: string, name: string): Promise<void> {
  await t.run(async function (ctx) {
    const hacker = must(await ctx.db.query("hackers").withIndex("by_handle", function (q) { return q.eq("handle", handle); }).unique());
    await ctx.db.insert("supersetProfiles", { hackerId: hacker._id, handle: supersetHandle, name, achievements: [], models: [], fetchedAt: Date.now() });
  });
}

// One relay from the asker's log.
async function logged(as: Actor, relayId: Id<"relays">) {
  return (await as.query(api.operator.log, {})).find(function (r) { return r._id === relayId; });
}

let savedFake: string | undefined;
beforeEach(function () {
  savedFake = process.env.OPERATOR_FAKE;
  process.env.OPERATOR_FAKE = "1";
});
afterEach(async function () {
  // Every question schedules `route`; it must finish while this test's database and OPERATOR_FAKE are still here.
  await settleScheduled();
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
    // Jimmy's daemon is told which agent to ask, and the question.
    expect(await t.query(api.operator.readsFor, { token: jimmyToken })).toEqual([{ relayId, agentId: "a1", question: "Where are expired listings filtered?" }]);

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

  test("a question about someone else never reads the only agent there is", async function () {
    const t = harness();
    const { tom, jimmyToken } = await crew(t);
    // Jimmy's agent is the only one open. A question about @mira, who is not in the crew, must not read it.
    const aboutMira = await tom.mutation(api.operator.askAsHacker, { question: "What is @mira working on?" });
    await t.action(internal.operator.route, { relayId: aboutMira });
    expect(await logged(tom, aboutMira)).toMatchObject({
      status: "nobody", note: "Nobody in your crew is @mira. Your crew: @jimmy.", askAgain: true,
    });
    expect(await t.query(api.operator.readsFor, { token: jimmyToken })).toEqual([]);

    // A question about @jimmy's work goes to Jimmy's agent, as it was asked.
    const aboutJimmy = await tom.mutation(api.operator.askAsHacker, { question: "where does @Jimmy filter expired listings?" });
    await t.action(internal.operator.route, { relayId: aboutJimmy });
    expect(await t.query(api.operator.readsFor, { token: jimmyToken })).toEqual([
      { relayId: aboutJimmy, agentId: "a1", question: "where does @Jimmy filter expired listings?" },
    ]);
  });

  test("what a crewmate is working on comes from the summaries: no agent is asked, and nobody earns XP", async function () {
    const t = harness();
    const { tom, jimmyToken } = await crew(t);
    const tomToken = await machine(t, tom, "mbp16", []);
    const relayId = await t.mutation(api.operator.ask, { token: tomToken, question: "What is @jimmy working on?" });
    await t.action(internal.operator.route, { relayId });
    const seen = await t.query(api.operator.relay, { token: tomToken, relayId });
    expect(seen).toMatchObject({ status: "answered", byOperator: true });
    expect(seen?.answer).toContain("convex/marketUpdate/select.ts");
    expect(seen?.targetHandle).toBeUndefined();
    expect(await t.query(api.operator.readsFor, { token: jimmyToken })).toEqual([]);
    const board = await tom.query(api.play.board, {});
    expect(board.find(function (r) { return r.handle === "tom"; })?.asks).toBe(0);
    expect(board.find(function (r) { return r.handle === "jimmy"; })?.assists).toBe(0);
  });

  test("a who-question names the crewmate with an agent on it and asks what you would like to know; the answer goes to their agent", async function () {
    const t = harness();
    const { tom, jimmyToken } = await crew(t);
    await linkSuperset(t, "jimmy", "jimmy-vibes", "Jimmy Lee");
    const tomToken = await machine(t, tom, "mbp16", []);

    const who = await t.mutation(api.operator.ask, { token: tomToken, question: "Who should I ask about the market update listings?" });
    await t.action(internal.operator.route, { relayId: who });
    expect(await t.query(api.operator.relay, { token: tomToken, relayId: who })).toMatchObject({
      status: "answered",
      byOperator: true,
      answer: "Jimmy (@jimmy) has an agent on that right now. What would you like to know?",
    });
    expect(await t.query(api.operator.readsFor, { token: jimmyToken })).toEqual([]);

    // Tom's answer, sent with the handle the Operator named, goes to Jimmy's agent.
    const followUp = await t.mutation(api.operator.ask, { token: tomToken, question: "@jimmy: where are expired listings filtered?" });
    await t.action(internal.operator.route, { relayId: followUp });
    expect(await t.query(api.operator.readsFor, { token: jimmyToken })).toEqual([
      { relayId: followUp, agentId: "a1", question: "@jimmy: where are expired listings filtered?" },
    ]);

    // Nobody's agent is on it: nobody is named.
    const nobody = await t.mutation(api.operator.ask, { token: tomToken, question: "Who should I ask about billing webhooks?" });
    await t.action(internal.operator.route, { relayId: nobody });
    expect(await t.query(api.operator.relay, { token: tomToken, relayId: nobody })).toMatchObject({ status: "nobody" });
  });

  test("an @mention finds the one crewmate it can mean, and their agent is asked with the handle written out", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const ada = await hackerNamed(t, "adalovelace");
    await befriend(tom, ada, "adalovelace");
    await linkSuperset(t, "adalovelace", "alovelace", "Ada Lovelace");
    const adaToken = await machine(t, ada, "al", [agent("a1", "segments", true)]);
    await t.mutation(api.routing.update, { token: adaToken, agentId: "a1", summary: "vibes · segment sends · files: convex/segments/send.ts" });

    // A first name, the Superset handle she linked, a word of her name.
    const cases: [string, string][] = [
      ["Where do @ada's segment sends start?", "Where do @adalovelace's segment sends start?"],
      ["Where do @ALovelace's segment sends start?", "Where do @adalovelace's segment sends start?"],
      ["Where do @lovelace's segment sends start?", "Where do @adalovelace's segment sends start?"],
    ];
    for (const [asked, routed] of cases) {
      const relayId = await tom.mutation(api.operator.askAsHacker, { question: asked });
      await t.action(internal.operator.route, { relayId });
      expect(await t.query(api.operator.readsFor, { token: adaToken })).toEqual([{ relayId, agentId: "a1", question: routed }]);
      // Her agent's answer is about the person the question now names, so it is kept.
      await answer(t, { token: adaToken, relayId, answer: "They start in convex/segments/send.ts." });
      expect(await logged(tom, relayId)).toMatchObject({ status: "answered", question: asked, targetHandle: "adalovelace" });
    }
  });

  test("a name that fits two crewmates, or nobody, comes back with the crew's handles to ask again with", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const lonely = await tom.mutation(api.operator.askAsHacker, { question: "What is @bob doing?" });
    await t.action(internal.operator.route, { relayId: lonely });
    const alone = await logged(tom, lonely);
    expect(alone).toMatchObject({ status: "nobody", note: "Nobody in your crew is @bob. You have no crewmates on soopdoop yet." });
    // With nobody in the crew there is no handle to fix.
    expect(alone?.askAgain).toBeUndefined();

    for (const handle of ["jimmy", "jimena"]) await befriend(tom, await hackerNamed(t, handle), handle);
    const relayId = await tom.mutation(api.operator.askAsHacker, { question: "Where does @jim keep the coupon code?" });
    await t.action(internal.operator.route, { relayId });
    expect(await logged(tom, relayId)).toMatchObject({
      status: "nobody", askAgain: true, note: "@jim could be @jimena or @jimmy. Your crew: @jimena, @jimmy.",
    });
  });

  test("a crewmate with no open agent, or the asker themself, is said plainly", async function () {
    const t = harness();
    const { tom } = await crew(t);
    await befriend(tom, await hackerNamed(t, "vlad"), "vlad");
    const aboutVlad = await tom.mutation(api.operator.askAsHacker, { question: "Where does @vlad keep the coupon code?" });
    await t.action(internal.operator.route, { relayId: aboutVlad });
    expect(await logged(tom, aboutVlad)).toMatchObject({ status: "nobody", note: "@vlad has no open agent running right now." });
    const aboutMe = await tom.mutation(api.operator.askAsHacker, { question: "What did @tom change?" });
    await t.action(internal.operator.route, { relayId: aboutMe });
    expect(await logged(tom, aboutMe)).toMatchObject({ status: "nobody", note: "@tom is you, and the Operator only asks your crewmates' agents." });
  });

  test("the crewmate's daemon asks its own agent and sends back that agent's answer, which is all that is kept", async function () {
    const t = harness();
    const { tom, jimmy, jimmyToken } = await crew(t);
    const relayId = await tom.mutation(api.operator.askAsHacker, { question: "Where are expired listings filtered?" });
    await t.action(internal.operator.route, { relayId });
    const said = "Expired listings are dropped in convex/marketUpdate/select.ts, by listDate, before the closest six are picked.";
    expect((await answer(t, { token: jimmyToken, relayId, answer: `  ${said}\n`, tokensRead: 52_310.4 })).status).toBe(200);
    expect((await tom.query(api.operator.log, {}))[0]).toMatchObject({
      _id: relayId, status: "answered", answer: said, tokensRead: 52_310, tokensSent: Math.ceil(said.length / 4), targetHandle: "jimmy",
    });
    expect((await jimmy.query(api.play.board, {})).find(function (r) { return r.handle === "jimmy"; })).toMatchObject({ xp: 10, assists: 1 });
    // Answered once: a second answer is refused.
    expect((await answer(t, { token: jimmyToken, relayId, answer: "again" })).status).toBe(404);
  });

  test("an agent that does not know, or an answer that is too long, gives no answer", async function () {
    const t = harness();
    const { tom, jimmyToken } = await crew(t);
    const relayId = await tom.mutation(api.operator.askAsHacker, { question: "Where are expired listings filtered?" });
    await t.action(internal.operator.route, { relayId });
    expect((await answer(t, { token: jimmyToken, relayId, answer: "x".repeat(4_001) })).status).toBe(413);
    expect((await answer(t, { token: jimmyToken, relayId, answer: "NOT_FOUND", tokensRead: 900 })).status).toBe(200);
    expect((await tom.query(api.operator.log, {}))[0]).toMatchObject({ status: "not-found", note: "It has not worked on this.", tokensRead: 900 });
  });

  test("an answer is never about anyone but the agent's owner", async function () {
    // Jimmy's agent, asked about Vlad: nothing is answered and nothing is spent.
    expect(await answerFrom("What is @vlad doing?", CONTEXT, { handle: "jimmy" })).toEqual({ text: null, tokensRead: 0, tokensSent: 0 });
    expect((await answerFrom("Where are expired listings filtered, @jimmy?", CONTEXT, { handle: "jimmy" })).text).toContain("select.ts");
    // The same for an answer Jimmy's agent wrote itself.
    expect(agentAnswer("What is @vlad doing?", "Fixing the HUD.", { handle: "jimmy" }, 800)).toEqual({ text: null, tokensRead: 800, tokensSent: 0 });
    expect(agentAnswer("What is @jimmy doing?", "Fixing the HUD.", { handle: "jimmy" }, 800)).toEqual({ text: "Fixing the HUD.", tokensRead: 800, tokensSent: 4 });
  });

  test("@mentions are found, and the router sees each owner's name", function () {
    expect(mentionedHandles("what is @vlad working on? ask @Jimmy-Vibes too")).toEqual(["vlad", "jimmy-vibes"]);
    expect(mentionedHandles("mail tom@vibes.dev about it")).toEqual([]);
    expect(mentionedHandles("what is jimmy working on")).toEqual([]);
    // A handle has no letters like "É", so this is a name, not a mention.
    expect(mentionedHandles("what is @Évariste doing?")).toEqual([]);
    expect(candidateLine({ handle: "vladimir", name: "Vlad P", agentName: "api", status: "working" }, 0)).toBe("1. @vladimir (Vlad P) · api · working");
    expect(firstNameAndHandle({ handle: "adalovelace", name: "Ada Lovelace" })).toBe("Ada (@adalovelace)");
    expect(firstNameAndHandle({ handle: "zed" })).toBe("@zed");
  });

  test("an @mention is matched to the crew: a handle, then a linked Superset handle, then the start of a handle or a name", function () {
    const crew = [
      { handle: "adalovelace", name: "Ada Lovelace", supersetHandle: "alovelace" },
      { handle: "galois", name: "Évariste Galois" },
      { handle: "jimmy" },
      { handle: "jimena" },
    ];
    function handles(mention: string): string[] {
      return crewmatesFor(mention, crew).map(function (c) { return c.handle; });
    }
    expect(handles("galois")).toEqual(["galois"]);
    expect(handles("alovelace")).toEqual(["adalovelace"]);
    expect(handles("ada")).toEqual(["adalovelace"]);
    expect(handles("lovelace")).toEqual(["adalovelace"]);
    // A name is matched without its accents.
    expect(handles("evariste")).toEqual(["galois"]);
    expect(handles("jim")).toEqual(["jimmy", "jimena"]);
    expect(handles("j")).toEqual([]);
    expect(handles("ana")).toEqual([]);

    const m = resolveMentions("Is @Ada's change near @galois's? Ask @jim, @tom and @ana. Mail ada@vibes.dev", crew, "tom");
    expect(m.question).toBe("Is @adalovelace's change near @galois's? Ask @jim, @tom and @ana. Mail ada@vibes.dev");
    expect(m.unknown).toEqual(["ana"]);
    expect(m.unclear).toEqual([{ mention: "jim", handles: ["jimmy", "jimena"] }]);
    expect(mentionNote(m, crew)).toBe(
      "Nobody in your crew is @ana. @jim could be @jimmy or @jimena. Your crew: @adalovelace (Ada Lovelace), @galois (Évariste Galois), @jimmy, @jimena.",
    );
    expect(resolveMentions("What is @Évariste doing?", crew, "tom")).toEqual({ question: "What is @Évariste doing?", unknown: [], unclear: [] });
  });

  test("the router's answer is read as JSON, or as a bare number", function () {
    expect(parseRoute('{"ask": 2}', 2)).toEqual({ ask: 1 });
    expect(parseRoute('Here you go: {"reply": "Jimmy is on checkout."}', 2)).toEqual({ reply: "Jimmy is on checkout." });
    expect(parseRoute('{"nobody": true}', 2)).toBeNull();
    expect(parseRoute('{"ask": 3}', 2)).toBeNull();
    expect(parseRoute("2", 2)).toEqual({ ask: 1 });
    expect(parseRoute("0", 2)).toBeNull();
    expect(parseRoute("Not sure.", 2)).toBeNull();
    expect(parseRoute(`{"reply": "${"x".repeat(3_000)}"}`, 1)).toEqual({ reply: "x".repeat(2_000) });
  });

  test("a wrong answer can be deleted, and the assist it gave goes with it", async function () {
    const t = harness();
    const { tom, jimmy, jimmyToken } = await crew(t);
    const relayId = await tom.mutation(api.operator.askAsHacker, { question: "Where are expired listings filtered?" });
    await t.action(internal.operator.route, { relayId });
    await answer(t, { token: jimmyToken, relayId, context: CONTEXT });
    expect((await jimmy.query(api.play.board, {})).find(function (r) { return r.handle === "jimmy"; })?.xp).toBe(10);

    expect(await t.mutation(internal.operator.forget, { relayIds: [relayId, "not-an-id"] })).toBe(1);
    expect(await tom.query(api.operator.log, {})).toEqual([]);
    expect(await jimmy.query(api.operator.log, {})).toEqual([]);
    expect((await jimmy.query(api.play.board, {})).find(function (r) { return r.handle === "jimmy"; })?.xp).toBe(0);
    expect(await t.mutation(internal.operator.forget, { relayIds: [relayId] })).toBe(0);
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

describe("the Operator chat", function () {
  test("the Operator answers small talk itself: no agent is asked, and it earns no XP", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const relayId = await tom.mutation(api.operator.chat, { text: "hey operator, anyone around?" });
    await t.action(internal.operator.route, { relayId });
    const [turn] = await tom.query(api.operator.chatLog, {});
    expect(turn).toMatchObject({ _id: relayId, via: "chat", status: "answered", byOperator: true, answer: "Nobody's agents are around right now. Just me." });
    expect(turn?.targetHandle).toBeUndefined();
    expect((await tom.query(api.play.board, {}))[0]).toMatchObject({ handle: "tom", xp: 0, asks: 0 });
  });

  test("a message that needs an agent's knowledge goes to it, as a question that stands alone, and the chat shows the answer", async function () {
    const t = harness();
    const { tom, jimmyToken } = await crew(t);
    const relayId = await tom.mutation(api.operator.chat, { text: "Where are expired listings filtered in the market update?" });
    await t.action(internal.operator.route, { relayId });
    expect(await t.query(api.operator.readsFor, { token: jimmyToken })).toEqual([
      { relayId, agentId: "a1", question: "Where are expired listings filtered in the market update?" },
    ]);
    await answer(t, { token: jimmyToken, relayId, answer: "In convex/marketUpdate/select.ts, by listDate." });
    expect((await tom.query(api.operator.chatLog, {}))[0]).toMatchObject({ status: "answered", targetHandle: "jimmy", answer: "In convex/marketUpdate/select.ts, by listDate." });
    // A real question to the crew still counts.
    expect((await tom.query(api.play.board, {})).find(function (r) { return r.handle === "tom"; })?.asks).toBe(1);
    // Chat messages are not on the wire of agents' questions only: the log still has it, marked.
    expect((await tom.query(api.operator.log, {}))[0]).toMatchObject({ _id: relayId, via: "chat" });
  });

  test("a follow-up sees the chat so far", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const first = await tom.mutation(api.operator.chat, { text: "who is around?" });
    await t.action(internal.operator.route, { relayId: first });
    const second = await tom.mutation(api.operator.chat, { text: "and later?" });
    const seen = must(await t.query(internal.operator.candidates, { relayId: second }));
    expect(seen).toMatchObject({ via: "chat", asker: "tom", history: [{ you: "who is around?", operator: "Nobody's agents are around right now. Just me." }] });
  });

  test("a name the chat cannot place gets the crew back from the Operator; one it can is written out for the agent", async function () {
    const t = harness();
    const { tom, jimmyToken } = await crew(t);
    const unknown = await tom.mutation(api.operator.chat, { text: "what is @mira doing?" });
    await t.action(internal.operator.route, { relayId: unknown });
    expect((await tom.query(api.operator.chatLog, {})).find(function (r) { return r._id === unknown; })).toMatchObject({
      status: "answered", byOperator: true, answer: "Nobody in your crew is @mira. Your crew: @jimmy.",
    });
    const relayId = await tom.mutation(api.operator.chat, { text: "where does @jim filter expired listings for the market update?" });
    await t.action(internal.operator.route, { relayId });
    expect(await t.query(api.operator.readsFor, { token: jimmyToken })).toEqual([
      { relayId, agentId: "a1", question: "where does @jimmy filter expired listings for the market update?" },
    ]);
  });

  test("the Operator's chat answer is read as JSON, and anything else as a plain reply", function () {
    expect(parseChatTurn('{"reply": "Jimmy is on checkout."}', 2)).toEqual({ reply: "Jimmy is on checkout." });
    expect(parseChatTurn('Sure. {"ask": 2, "question": "Where is the retry limit set?"}', 2)).toEqual({ ask: 1, question: "Where is the retry limit set?" });
    expect(parseChatTurn('{"ask": 3, "question": "x"}', 2)).toEqual({ reply: '{"ask": 3, "question": "x"}' });
    expect(parseChatTurn("Just me here.", 0)).toEqual({ reply: "Just me here." });
    expect(parseChatTurn("", 0)).toEqual({ reply: "Hmm. Say that again?" });
  });
});

describe("the crew an agent sees", function () {
  test("handles, linked names and lights, through the machine's token", async function () {
    const t = harness();
    const { tom } = await crew(t);
    await linkSuperset(t, "jimmy", "jimmy-neutron", "Jimmy Neutron");
    const vlad = await hackerNamed(t, "vlad");
    await befriend(tom, vlad, "vlad");
    await vlad.mutation(api.hackers.setFocus, { minutes: 25 });
    const tomToken = await machine(t, tom, "mbp16", []);
    expect(await t.query(api.friends.crew, { token: tomToken })).toEqual({
      me: "tom",
      crew: [
        // Jimmy's private agent is not counted.
        { handle: "jimmy", name: "Jimmy Neutron", led: "g", inFocus: false, agentCount: 1 },
        { handle: "vlad", name: undefined, led: "x", inFocus: true, agentCount: 0 },
      ],
    });
    await expect(t.query(api.friends.crew, { token: "sd_nope" })).rejects.toThrow("Unknown daemon token");
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
