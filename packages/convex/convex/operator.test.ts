import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConvexError } from "convex/values";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  absentNote,
  agentAnswer,
  ago,
  answerFrom,
  candidateLine,
  crewmatesFor,
  firstNameAndHandle,
  handoffNote,
  isWorkOrder,
  ledgerReply,
  mentionedHandles,
  mentionNote,
  NOT_CONFIGURED,
  parseChatTurn,
  parseRoute,
  pastLine,
  resolveMentions,
} from "./lib/claude";
import { reasonOf } from "./operator";
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
    expect(await t.query(api.operator.readsFor, { token: jimmyToken })).toEqual([{ relayId, agentId: "a1", question: "Where are expired listings filtered?", asker: "tom" }]);

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
      { relayId: aboutJimmy, agentId: "a1", question: "where does @Jimmy filter expired listings?", asker: "tom" },
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
      { relayId: followUp, agentId: "a1", question: "@jimmy: where are expired listings filtered?", asker: "tom" },
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
      expect(await t.query(api.operator.readsFor, { token: adaToken })).toEqual([{ relayId, agentId: "a1", question: routed, asker: "tom" }]);
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
    await befriend(tom, await hackerNamed(t, "hedy"), "hedy");
    const aboutHedy = await tom.mutation(api.operator.askAsHacker, { question: "Where does @hedy keep the coupon code?" });
    await t.action(internal.operator.route, { relayId: aboutHedy });
    expect(await logged(tom, aboutHedy)).toMatchObject({ status: "nobody", note: "@hedy has no open agent running right now." });
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

  test("when the answering Mac's anti-hijacking fund says no, the asker reads whose fund it was", async function () {
    const t = harness();
    const { tom, jimmyToken } = await crew(t);
    const notes: [string, string][] = [
      ["fund", "@jimmy's agents have spent today's answering fund."],
      ["share", "You have used your share of @jimmy's answering fund for today."],
      ["off", "@jimmy has turned off answering questions."],
    ];
    for (const [limit, note] of notes) {
      const relayId = await tom.mutation(api.operator.askAsHacker, { question: "Where are expired listings filtered?" });
      await t.action(internal.operator.route, { relayId });
      expect((await answer(t, { token: jimmyToken, relayId, refused: "This crewmate's agents have spent today's answering fund.", limit })).status).toBe(200);
      expect(await logged(tom, relayId)).toMatchObject({ status: "nobody", note, targetHandle: "jimmy" });
    }
    // Any other refusal is still the agent not knowing, in the daemon's words.
    const relayId = await tom.mutation(api.operator.askAsHacker, { question: "Where are expired listings filtered?" });
    await t.action(internal.operator.route, { relayId });
    await answer(t, { token: jimmyToken, relayId, refused: "That agent is private.", limit: "something else" });
    expect(await logged(tom, relayId)).toMatchObject({ status: "not-found", note: "That agent is private." });
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
    // Jimmy's agent, asked about Hedy: nothing is answered and nothing is spent.
    expect(await answerFrom("What is @hedy doing?", CONTEXT, { handle: "jimmy" })).toEqual({ text: null, tokensRead: 0, tokensSent: 0 });
    expect((await answerFrom("Where are expired listings filtered, @jimmy?", CONTEXT, { handle: "jimmy" })).text).toContain("select.ts");
    // The same for an answer Jimmy's agent wrote itself.
    expect(agentAnswer("What is @hedy doing?", "Fixing the HUD.", { handle: "jimmy" }, 800)).toEqual({ text: null, tokensRead: 800, tokensSent: 0 });
    expect(agentAnswer("What is @jimmy doing?", "Fixing the HUD.", { handle: "jimmy" }, 800)).toEqual({ text: "Fixing the HUD.", tokensRead: 800, tokensSent: 4 });
  });

  test("@mentions are found, and the router sees each owner's name", function () {
    expect(mentionedHandles("what is @hedy working on? ask @Jimmy-Vibes too")).toEqual(["hedy", "jimmy-vibes"]);
    expect(mentionedHandles("mail tom@vibes.dev about it")).toEqual([]);
    expect(mentionedHandles("what is jimmy working on")).toEqual([]);
    // A handle has no letters like "É", so this is a name, not a mention.
    expect(mentionedHandles("what is @Évariste doing?")).toEqual([]);
    expect(candidateLine({ handle: "hedylamarr", name: "Hedy P", agentName: "api", status: "working" }, 0)).toBe("1. @hedylamarr (Hedy P) · api · working");
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
      { relayId, agentId: "a1", question: "Where are expired listings filtered in the market update?", asker: "tom" },
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
      { relayId, agentId: "a1", question: "where does @jimmy filter expired listings for the market update?", asker: "tom" },
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
    const hedy = await hackerNamed(t, "hedy");
    await befriend(tom, hedy, "hedy");
    await hedy.mutation(api.hackers.setFocus, { minutes: 25 });
    const tomToken = await machine(t, tom, "mbp16", []);
    expect(await t.query(api.friends.crew, { token: tomToken })).toEqual({
      me: "tom",
      crew: [
        { handle: "hedy", name: undefined, led: "x", inFocus: true, agentCount: 0 },
        // Jimmy's private agent is not counted.
        { handle: "jimmy", name: "Jimmy Neutron", led: "g", inFocus: false, agentCount: 1 },
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

async function idOf(t: Harness, handle: string): Promise<Id<"hackers">> {
  const row = await t.run(async function (ctx) {
    return await ctx.db.query("hackers").withIndex("by_handle", function (q) { return q.eq("handle", handle); }).unique();
  });
  return must(row)._id;
}

// Runs the route each new question scheduled, once each, as the deployment does. (Calling route by hand as well would
// route a question twice once the scheduled one fires.)
async function routeOnce(t: Harness): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await new Promise(function (resolve) { setTimeout(resolve, 1); });
    await t.finishInProgressScheduledFunctions();
    const waiting = await t.run(async function (ctx) {
      const jobs = await ctx.db.system.query("_scheduled_functions").collect();
      return jobs.filter(function (j) { return j.name === "operator:route" && (j.state.kind === "pending" || j.state.kind === "inProgress"); });
    });
    if (waiting.length === 0) return;
  }
  throw new Error("The Operator's route did not run.");
}

// Hedy is in Tom's crew with no agent running, and her ledger has two pieces of work on the coupon code.
async function withHedy(t: Harness, tom: Actor) {
  const hedy = await hackerNamed(t, "hedy");
  await befriend(tom, hedy, "hedy");
  const hedyToken = await machine(t, hedy, "hm", []);
  for (const [key, did] of [["h1", "rounded the coupon code totals"], ["h2", "coupon code expiry dates"]] as const) {
    await t.mutation(api.ledger.report, { token: hedyToken, sessionKey: key, harness: "codex", did, areas: ["convex/coupons"], files: 3 });
  }
  return { hedy, hedyToken };
}

describe("the Operator with the crew's ledger and hand-offs", function () {
  test("a work order is no longer refused: it is offered as a hand-off to the agent that fits, and no agent is read", async function () {
    const t = harness();
    const { tom, jimmy, jimmyToken } = await crew(t);
    const question = "Fix the market update listings filter for expired listings";
    const relayId = await tom.mutation(api.operator.askAsHacker, { question });
    await routeOnce(t);
    const r = must(await logged(tom, relayId));
    expect(r).toMatchObject({ status: "answered", byOperator: true, answer: "Offered as a hand-off to @jimmy; they approve it in soopdoop. You will hear back on the wire." });
    expect(await t.query(api.operator.readsFor, { token: jimmyToken })).toEqual([]);
    const { incoming } = await jimmy.query(api.handoffs.mine, {});
    expect(incoming).toMatchObject([{ _id: must(r.handoffId), fromHandle: "tom", text: question, via: "operator", targetAgentId: "a1", status: "offered" }]);
    const offered = await t.run(async function (ctx) { return await ctx.db.get("handoffs", must(r.handoffId)); });
    expect(offered?.relayId).toBe(relayId);
    // Routing the same question again offers nothing new.
    const tomId = await idOf(t, "tom");
    const jimmyId = await idOf(t, "jimmy");
    const again = await t.mutation(internal.handoffs.offerInternal, { fromId: tomId, toId: jimmyId, text: question, relayId });
    expect(again.handoffId).toBe(must(r.handoffId));
    expect((await jimmy.query(api.handoffs.mine, {})).incoming).toHaveLength(1);
    // Not a question to the crew: nobody earns XP for it.
    expect((await tom.query(api.play.board, {})).map(function (row) { return [row.handle, row.xp]; })).toEqual([["jimmy", 0], ["tom", 0]]);
  });

  test("from an agent, the answer names the agent when shared, and the offering session hears back at its next prompt", async function () {
    const t = harness();
    const { tom, jimmy } = await crew(t);
    await jimmy.mutation(api.hackers.updateSharing, { shareAgentNames: true, shareWorkspaceNames: false });
    const tomToken = await machine(t, tom, "mbp16", [agent("t1", "rail", true)]);
    const relayId = await t.mutation(api.operator.ask, { token: tomToken, question: "Fix the market update listings filter", agentId: "t1" });
    await routeOnce(t);
    const seen = must(await t.query(api.operator.relay, { token: tomToken, relayId }));
    expect(seen).toMatchObject({
      status: "answered",
      byOperator: true,
      answer: "Offered as a hand-off to @jimmy's listing-cards agent; they approve it in soopdoop. You will hear back on the wire and at your next prompt.",
    });
    const offered = await t.run(async function (ctx) { return await ctx.db.get("handoffs", must(seen.handoffId)); });
    expect(offered).toMatchObject({ fromMachine: "mbp16", fromAgentId: "t1", via: "operator" });
  });

  test("an offer the crewmate turned off is said plainly, and nothing is offered", async function () {
    const t = harness();
    const { tom, jimmy } = await crew(t);
    await jimmy.mutation(api.handoffs.setConsent, { handle: "tom", mode: "never" });
    const relayId = await tom.mutation(api.operator.askAsHacker, { question: "Fix the market update listings filter" });
    await routeOnce(t);
    expect(await logged(tom, relayId)).toMatchObject({ status: "nobody", note: "@jimmy has turned hand-offs from you off." });
    expect((await jimmy.query(api.handoffs.mine, {})).incoming).toEqual([]);
  });

  test("a work order nobody's running agent fits goes to the crewmate whose past work does, with a knock", async function () {
    const t = harness();
    const { tom } = await crew(t);
    const { hedy } = await withHedy(t, tom);
    const relayId = await tom.mutation(api.operator.askAsHacker, { question: "Fix the coupon code rounding at checkout" });
    await routeOnce(t);
    expect(await logged(tom, relayId)).toMatchObject({ status: "answered", byOperator: true, answer: "Offered as a hand-off to @hedy; they approve it in soopdoop. You will hear back on the wire." });
    expect((await hedy.query(api.handoffs.mine, {})).incoming).toMatchObject([{ fromHandle: "tom", text: "Fix the coupon code rounding at checkout" }]);
    expect((await hedy.query(api.knocks.incoming, {})).current).toMatchObject({ fromHandle: "tom", item: { title: "a hand-off from @tom" } });
  });

  test("a who-question no running agent fits is answered from the ledger, and a crewmate with no agent gets what the ledger has", async function () {
    const t = harness();
    const { tom, jimmyToken } = await crew(t);
    await withHedy(t, tom);
    await linkSuperset(t, "hedy", "hedy-l", "Hedy Lamarr");
    const who = await tom.mutation(api.operator.askAsHacker, { question: "Who knows about the coupon code?" });
    await routeOnce(t);
    expect(await logged(tom, who)).toMatchObject({
      status: "answered",
      byOperator: true,
      answer: "Hedy (@hedy) did 2 pieces of work on that in the last two weeks, the last today. Their agent on it is off right now. Knock them, or hand it off?",
    });
    expect(await t.query(api.operator.readsFor, { token: jimmyToken })).toEqual([]);

    const where = await tom.mutation(api.operator.askAsHacker, { question: "Where does @hedy keep the coupon code?" });
    await routeOnce(t);
    expect(await logged(tom, where)).toMatchObject({
      status: "nobody",
      note: "@hedy has no open agent running right now. They did 2 pieces of work on that in the last two weeks, the last today. Knock them, or hand it off?",
    });

    // With nobody's agent running at all, past work still answers a who-question; anything else has nobody to ask.
    await t.mutation(api.subsets.report, { token: jimmyToken, agents: [] });
    const again = await tom.mutation(api.operator.askAsHacker, { question: "Who knows about coupon codes?" });
    await routeOnce(t);
    expect((await logged(tom, again))?.answer).toContain("Hedy (@hedy) did 2 pieces of work");
    const other = await tom.mutation(api.operator.askAsHacker, { question: "How does the coupon code get applied?" });
    await routeOnce(t);
    expect(await logged(tom, other)).toMatchObject({ status: "nobody", note: "No crewmate has an open agent running right now." });
  });

  test("the Operator sees the crew's ledger lines that fit (marked live when their owner has an agent running) and the crew's live notes", async function () {
    const t = harness();
    const { tom, jimmyToken } = await crew(t);
    await withHedy(t, tom);
    await t.mutation(api.ledger.report, { token: jimmyToken, sessionKey: "j1", harness: "claude-code", did: "coupon banner on the market update", areas: ["convex/marketUpdate"], files: 2 });
    const tomId = await idOf(t, "tom");
    const now = Date.now();
    await t.run(async function (ctx) {
      const crewId = await ctx.db.insert("crews", { name: "vibes", leaderId: tomId, plan: "free", digestHour: 9, timezone: "America/Toronto", createdAt: now });
      await ctx.db.insert("crewMembers", { crewId, hackerId: tomId, role: "leader", joinedAt: now });
      const note = { crewId, authorId: tomId, tags: [], createdAt: now - 60_000, updatedAt: now - 60_000 };
      await ctx.db.insert("notes", { ...note, text: "Coupons round half up.", status: "live" });
      await ctx.db.insert("notes", { ...note, text: "The quote page uses the M10 components.", status: "live", updatedAt: now });
      await ctx.db.insert("notes", { ...note, text: "Waiting for approval.", status: "proposed" });
      await ctx.db.insert("notes", { ...note, text: "Old rule.", status: "retired" });
      await ctx.db.insert("notes", { ...note, text: "Nobody confirmed this in two months.", status: "live", createdAt: now - 60 * 24 * 60 * 60 * 1000 });
    });
    const relayId = await tom.mutation(api.operator.askAsHacker, { question: "Who knows about the coupon code?" });
    const seen = must(await t.query(internal.operator.candidates, { relayId }));
    expect(seen.askerId).toBe(tomId);
    // Equal matches: the newer line first.
    expect(seen.ledger.map(function (l) { return [l.handle, l.did, l.live]; })).toEqual([
      ["hedy", "coupon code expiry dates", false],
      ["hedy", "rounded the coupon code totals", false],
      ["jimmy", "coupon banner on the market update", true],
    ]);
    expect(seen.notes).toEqual(["The quote page uses the M10 components.", "Coupons round half up."]);
  });

  test("a crew's questions are capped a day by its plan, counted across the crew; the Operator's own chat replies do not count", async function () {
    const t = harness();
    const { tom, jimmy } = await crew(t);
    const tomId = await idOf(t, "tom");
    const jimmyId = await idOf(t, "jimmy");
    const hour = 60 * 60 * 1000;
    await t.run(async function (ctx) {
      // Oldest first, as they would have been asked.
      for (let i = 0; i < 3; i++) await ctx.db.insert("relays", { askerHackerId: tomId, question: `yesterday ${i}`, status: "answered", createdAt: Date.now() - 30 * hour });
      for (let i = 0; i < 10; i++) await ctx.db.insert("relays", { askerHackerId: jimmyId, question: `jimmy ${i}`, status: "answered", createdAt: Date.now() - 3 * hour });
      for (let i = 0; i < 5; i++) await ctx.db.insert("relays", { askerHackerId: tomId, question: `chat ${i}`, status: "answered", via: "chat", byOperator: true, createdAt: Date.now() - 2 * hour });
      for (let i = 0; i < 9; i++) await ctx.db.insert("relays", { askerHackerId: tomId, question: `tom ${i}`, status: "answered", createdAt: Date.now() - 2 * hour });
    });
    // 19 so far today: one more fits.
    await tom.mutation(api.operator.askAsHacker, { question: "Where are expired listings filtered?" });
    await expect(tom.mutation(api.operator.chat, { text: "and the rest?" })).rejects.toThrow("Your crew used today's questions (20 on the free plan).");
    await expect(jimmy.mutation(api.operator.askAsHacker, { question: "Anyone?" })).rejects.toThrow("Your crew used today's questions");

    // The team plan allows 500.
    await t.run(async function (ctx) {
      const crewId = await ctx.db.insert("crews", { name: "vibes", leaderId: tomId, plan: "team", digestHour: 9, timezone: "America/Toronto", createdAt: Date.now() });
      await ctx.db.insert("crewMembers", { crewId, hackerId: tomId, role: "leader", joinedAt: Date.now() });
    });
    await tom.mutation(api.operator.askAsHacker, { question: "Where are expired listings filtered?" });
  });

  test("what the Operator's own Claude calls cost is added up on the relay", async function () {
    const t = harness();
    const { tom } = await crew(t);
    const tomId = await idOf(t, "tom");
    const jimmyId = await idOf(t, "jimmy");
    // A relay with no scheduled route of its own, so only these calls write to it.
    const relayId = await t.run(async function (ctx) {
      return await ctx.db.insert("relays", { askerHackerId: tomId, question: "Where are expired listings filtered?", status: "routing", createdAt: Date.now() });
    });
    await t.mutation(internal.operator.setTarget, { relayId, targetHackerId: jimmyId, targetMachine: "jm", targetAgentId: "a1", usd: 0.003 });
    await t.mutation(internal.operator.finish, { relayId, status: "answered", answer: "In select.ts.", usd: 0.002 });
    const stored = must(await t.run(async function (ctx) { return await ctx.db.get("relays", relayId); }));
    expect(stored.usd).toBeCloseTo(0.005, 10);
    // In fake mode no call is made, so nothing is recorded.
    const free = await tom.mutation(api.operator.askAsHacker, { question: "What is @jimmy working on?" });
    await routeOnce(t);
    expect(must(await t.run(async function (ctx) { return await ctx.db.get("relays", free); })).usd).toBeUndefined();
  });

  test("a refusal's words reach the asker as they were written", function () {
    expect(reasonOf(new ConvexError("@jimmy has turned hand-offs from you off."))).toBe("@jimmy has turned hand-offs from you off.");
    expect(reasonOf(new ConvexError("\"@jimmy is in focus mode. Try later.\""))).toBe("@jimmy is in focus mode. Try later.");
    expect(reasonOf(new Error("boom"))).toBe("boom");
  });
});

describe("the Operator chat's tools", function () {
  test("a message that asks to search the ledger gets the ledger's lines back", async function () {
    const t = harness();
    const { tom } = await crew(t);
    await withHedy(t, tom);
    await tom.mutation(api.operator.chat, { text: "search the ledger for coupon work" });
    await routeOnce(t);
    expect((await tom.query(api.operator.chatLog, {}))[0]).toMatchObject({
      byOperator: true,
      answer: "From the ledger: @hedy, today: coupon code expiry dates; @hedy, today: rounded the coupon code totals.",
    });
  });

  test("hand this to …: the chat offers it, the relay keeps the hand-off, and a refusal is said instead", async function () {
    const t = harness();
    const { tom, jimmy } = await crew(t);
    await tom.mutation(api.operator.chat, { text: "hand this to @jim: fix the market update listings filter" });
    await routeOnce(t);
    const turn = must((await tom.query(api.operator.chatLog, {}))[0]);
    expect(turn).toMatchObject({ status: "answered", byOperator: true, answer: "Offered it to @jimmy." });
    // Jimmy reads Tom's message exactly as Tom wrote it.
    expect((await jimmy.query(api.handoffs.mine, {})).incoming).toMatchObject([{
      _id: must(turn.handoffId), text: "hand this to @jim: fix the market update listings filter", via: "operator", targetAgentId: "a1",
    }]);

    await jimmy.mutation(api.handoffs.setConsent, { handle: "tom", mode: "never" });
    const refused = await tom.mutation(api.operator.chat, { text: "hand this to @jimmy too: fix the listings again" });
    await routeOnce(t);
    expect((await tom.query(api.operator.chatLog, {})).find(function (r) { return r._id === refused; })).toMatchObject({
      byOperator: true, answer: "@jimmy has turned hand-offs from you off.",
    });
    expect((await jimmy.query(api.handoffs.mine, {})).incoming).toHaveLength(1);
  });

  test("knock …: the chat knocks on the crewmate; in focus mode it says so", async function () {
    const t = harness();
    const { tom, jimmy } = await crew(t);
    await tom.mutation(api.operator.chat, { text: "knock @jimmy about the release" });
    await routeOnce(t);
    expect((await tom.query(api.operator.chatLog, {}))[0]).toMatchObject({ answer: "Knocked on @jimmy." });
    const knock = must((await jimmy.query(api.knocks.incoming, {})).current);
    expect(knock).toMatchObject({ fromHandle: "tom", item: { kind: "session", title: "a knock from @tom, through the Operator" }, note: "knock @jimmy about the release" });
    await jimmy.mutation(api.knocks.decide, { knockId: knock._id, outcome: "not-now" });
    await jimmy.mutation(api.hackers.setFocus, { minutes: 25 });
    const later = await tom.mutation(api.operator.chat, { text: "knock @jimmy again" });
    await routeOnce(t);
    expect((await tom.query(api.operator.chatLog, {})).find(function (r) { return r._id === later; })).toMatchObject({ answer: "@jimmy is in focus mode. Try later." });
  });

  test("the crew's notes", async function () {
    const t = harness();
    const { tom } = await crew(t);
    const tomId = await idOf(t, "tom");
    await t.run(async function (ctx) {
      const crewId = await ctx.db.insert("crews", { name: "vibes", leaderId: tomId, plan: "free", digestHour: 9, timezone: "America/Toronto", createdAt: Date.now() });
      await ctx.db.insert("crewMembers", { crewId, hackerId: tomId, role: "leader", joinedAt: Date.now() });
      await ctx.db.insert("notes", { crewId, authorId: tomId, text: "Coupons round half up.", tags: ["pricing"], status: "live", createdAt: Date.now(), updatedAt: Date.now() });
    });
    await tom.mutation(api.operator.chat, { text: "what do the crew notes say?" });
    await routeOnce(t);
    expect((await tom.query(api.operator.chatLog, {}))[0]).toMatchObject({ answer: "The crew's notes: Coupons round half up." });
  });
});

describe("the Operator's words for hand-offs and past work", function () {
  const NOW = Date.UTC(2026, 9, 16, 12);
  const DAY = 24 * 60 * 60 * 1000;
  const past = [
    { handle: "adalovelace", name: "Ada Lovelace", did: "new pricing table", areas: ["apps/web/pricing"], at: NOW - 2 * DAY },
    { handle: "adalovelace", name: "Ada Lovelace", did: "pricing plans copy", areas: [], at: NOW - 5 * DAY },
    { handle: "jimmy", did: "pricing emails", areas: ["packages/email"], at: NOW },
  ];

  test("the router's hand-off is read with its task, numbered across agents and past work", function () {
    expect(parseRoute('{"handoff": 3, "task": "Fix the rounding"}', 2, 1)).toEqual({ handoff: 2, task: "Fix the rounding" });
    expect(parseRoute('{"handoff": 1}', 2)).toEqual({ handoff: 0, task: "" });
    expect(parseRoute('{"handoff": 4, "task": "x"}', 2, 1)).toBeNull();
    // Past work cannot be asked.
    expect(parseRoute('{"ask": 3}', 2, 1)).toBeNull();
  });

  test("work orders, the hand-off answer, and what the ledger says", function () {
    expect(["Fix the coupon rounding", "@jimmy: review my PR", "please write the migration", "Can you change the copy?"].every(isWorkOrder)).toBe(true);
    expect(["What did @tom change?", "Where is the fix for bounces?", "who fixed the coupons?"].some(isWorkOrder)).toBe(false);
    expect(handoffNote("jimmy", "email-metrics", true)).toBe(
      "Offered as a hand-off to @jimmy's email-metrics agent; they approve it in soopdoop. You will hear back on the wire and at your next prompt.",
    );
    expect(handoffNote("jimmy", undefined, false)).toBe("Offered as a hand-off to @jimmy; they approve it in soopdoop. You will hear back on the wire.");
    expect(ledgerReply(past, NOW)).toBe("Ada (@adalovelace) did 2 pieces of work on that in the last two weeks, the last 2 days ago. Their agent on it is off right now. Knock them, or hand it off?");
    expect(ledgerReply([], NOW)).toBeNull();
    expect(absentNote("what did @jimmy do on pricing?", [], "tom", past, NOW)).toBe(
      "@jimmy has no open agent running right now. They did a piece of work on that in the last two weeks, the last today. Knock them, or hand it off?",
    );
    expect(pastLine(must(past[0]), 2, NOW)).toBe("3. @adalovelace (Ada Lovelace) · 2 days ago · new pricing table · areas: apps/web/pricing");
    expect([ago(NOW, NOW), ago(NOW - DAY, NOW), ago(NOW - 3 * DAY - 1, NOW)]).toEqual(["today", "yesterday", "3 days ago"]);
  });
});

describe("the Operator's hand-offs and the ledger, after review", function () {
  test("a crewmate with another agent running still gets their past work: answered from the ledger, and offered the work order", async function () {
    const t = harness();
    const { tom } = await crew(t);
    const { hedy, hedyToken } = await withHedy(t, tom);
    await t.mutation(api.subsets.report, { token: hedyToken, agents: [agent("o1", "onboarding", true)] });
    await t.mutation(api.routing.update, { token: hedyToken, agentId: "o1", summary: "vibes · onboarding emails for new teams" });
    const who = await tom.mutation(api.operator.askAsHacker, { question: "Who knows about the coupon code?" });
    await routeOnce(t);
    expect((await logged(tom, who))?.answer).toBe("@hedy did 2 pieces of work on that in the last two weeks, the last today. Their agent on it is off right now. Knock them, or hand it off?");
    const order = await tom.mutation(api.operator.askAsHacker, { question: "Fix the coupon code rounding at checkout" });
    await routeOnce(t);
    expect((await logged(tom, order))?.answer).toBe("Offered as a hand-off to @hedy; they approve it in soopdoop. You will hear back on the wire.");
    expect((await hedy.query(api.handoffs.mine, {})).incoming).toMatchObject([{ text: "Fix the coupon code rounding at checkout" }]);
  });

  test("a question about @someone looks at their past work only, so newer work by others cannot crowd it out", async function () {
    const t = harness();
    const { tom, jimmyToken } = await crew(t);
    await withHedy(t, tom);
    for (let i = 0; i < 8; i++) {
      await t.mutation(api.ledger.report, { token: jimmyToken, sessionKey: `j${i}`, harness: "claude-code", did: `coupon code report ${i}`, areas: ["convex/coupons"], files: 1 });
    }
    const relayId = await tom.mutation(api.operator.askAsHacker, { question: "Where does @hedy keep the coupon code?" });
    await routeOnce(t);
    expect((await logged(tom, relayId))?.note).toBe(
      "@hedy has no open agent running right now. They did 2 pieces of work on that in the last two weeks, the last today. Knock them, or hand it off?",
    );
  });

  test("a work order from a private agent is not handed off, and only a session the daemon names hears back at its next prompt", async function () {
    const t = harness();
    const { tom } = await crew(t);
    const tomToken = await machine(t, tom, "mbp16", [agent("t1", "rail", true), agent("t2", "secret-stuff", false)]);
    const fromPrivate = await t.mutation(api.operator.ask, { token: tomToken, question: "Fix the market update listings filter", agentId: "t2" });
    await routeOnce(t);
    expect(await t.query(api.operator.relay, { token: tomToken, relayId: fromPrivate })).toMatchObject({
      status: "nobody", note: "A private agent's work stays on its Mac, so it cannot hand work off.",
    });
    const unnamed = await t.mutation(api.operator.ask, { token: tomToken, question: "Fix the market update listings filter for good" });
    await routeOnce(t);
    expect((await t.query(api.operator.relay, { token: tomToken, relayId: unnamed }))?.answer).toBe(
      "Offered as a hand-off to @jimmy; they approve it in soopdoop. You will hear back on the wire.",
    );
  });

  test("the daily cap counts an agent's question the Operator answered itself, and a crew's questions never count against a friend outside it", async function () {
    const t = harness();
    const { tom, jimmy } = await crew(t);
    const tomId = await idOf(t, "tom");
    const jimmyId = await idOf(t, "jimmy");
    const hour = 60 * 60 * 1000;
    await t.run(async function (ctx) {
      for (let i = 0; i < 20; i++) await ctx.db.insert("relays", { askerHackerId: tomId, question: `who ${i}`, status: "answered", byOperator: true, createdAt: Date.now() - hour });
    });
    await expect(tom.mutation(api.operator.askAsHacker, { question: "Anyone?" })).rejects.toThrow("Your crew used today's questions");

    // Tom and Jimmy become a crew; Sam, their friend in no crew, has his own allowance.
    const sam = await hackerNamed(t, "sam");
    await befriend(sam, tom, "tom");
    await t.run(async function (ctx) {
      const crewId = await ctx.db.insert("crews", { name: "vibes", leaderId: tomId, plan: "free", digestHour: 9, timezone: "America/Toronto", createdAt: Date.now() });
      await ctx.db.insert("crewMembers", { crewId, hackerId: tomId, role: "leader", joinedAt: Date.now() });
      await ctx.db.insert("crewMembers", { crewId, hackerId: jimmyId, role: "member", joinedAt: Date.now() });
    });
    await expect(jimmy.mutation(api.operator.askAsHacker, { question: "Anyone?" })).rejects.toThrow("Your crew used today's questions");
    await sam.mutation(api.operator.askAsHacker, { question: "Anyone?" });
  });

  test("under run when idle, a work order that names the crewmate is handed off at once and the answer says so; one the Operator aimed waits", async function () {
    const t = harness();
    const { tom, jimmy } = await crew(t);
    await jimmy.mutation(api.handoffs.setConsent, { handle: "tom", mode: "auto" });
    const named = await tom.mutation(api.operator.askAsHacker, { question: "@jimmy fix the market update listings filter" });
    await routeOnce(t);
    expect((await logged(tom, named))?.answer).toBe(
      "Handed off to @jimmy; they let your hand-offs run, so it runs when their agent is idle. You will hear back on the wire.",
    );
    const aimed = await tom.mutation(api.operator.askAsHacker, { question: "Fix the market update listings filter again" });
    await routeOnce(t);
    expect((await logged(tom, aimed))?.answer).toBe("Offered as a hand-off to @jimmy; they approve it in soopdoop. You will hear back on the wire.");
    expect((await jimmy.query(api.handoffs.mine, {})).incoming.map(function (h) { return h.status; }).sort()).toEqual(["accepted", "offered"]);
  });

  test("the chat's knock is not sent for a message that ran out of time", async function () {
    const t = harness();
    await crew(t);
    const tomId = await idOf(t, "tom");
    const relayId = await t.run(async function (ctx) {
      return await ctx.db.insert("relays", { askerHackerId: tomId, question: "knock @jimmy", status: "timeout", via: "chat", createdAt: Date.now() });
    });
    await expect(t.mutation(internal.operator.knock, { relayId, fromId: tomId, toHandle: "jimmy", note: "look" })).rejects.toThrow("ran out of time");
  });
});

// The Operator's Claude path, run by `route` itself, against a stand-in for the Messages API: `fetch` is replaced for
// the test, so nothing leaves the machine, and the real SDK builds and reads every request.
describe("the Operator's Claude path, against a stand-in for the API", function () {
  let replies: unknown[] = [];
  let realFetch: typeof fetch;
  let savedKey: string | undefined;

  // Answers each request with the next canned message, whatever was asked.
  async function standIn(_input: string | URL | Request, _init?: RequestInit): Promise<Response> {
    const next = replies.shift();
    if (next === undefined) return Response.json({ type: "error", error: { type: "invalid_request_error", message: "no reply left" } }, { status: 400 });
    return Response.json(next, { headers: { "request-id": "req_test" } });
  }

  function message(content: unknown[], stopReason: string) {
    return {
      id: "msg_test", type: "message", role: "assistant", model: "claude-sonnet-5-5", content, stop_reason: stopReason, stop_sequence: null,
      usage: { input_tokens: 1_000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    };
  }

  beforeEach(function () {
    replies = [];
    savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.OPERATOR_FAKE;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
    realFetch = globalThis.fetch;
    globalThis.fetch = standIn as typeof fetch;
  });

  afterEach(function () {
    globalThis.fetch = realFetch;
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  test("a chat turn that knocks and offers to the same crewmate does both, with one knock, and says its own reply", async function () {
    const t = harness();
    const { tom } = await crew(t);
    const { hedy } = await withHedy(t, tom);
    replies = [
      message([
        { type: "tool_use", id: "tu1", name: "knock", input: { handle: "@hedy", note: "a hand-off is coming your way" } },
        { type: "tool_use", id: "tu2", name: "offer_handoff", input: { agent: "@hedy", task: "fix the coupon code rounding" } },
      ], "tool_use"),
      message([{ type: "text", text: "Knocked on Hedy and offered her the rounding fix." }], "end_turn"),
    ];
    const said = "knock hedy, and hand her this: fix the coupon code rounding";
    const relayId = await tom.mutation(api.operator.chat, { text: said });
    await routeOnce(t);
    const turn = must((await tom.query(api.operator.chatLog, {})).find(function (r) { return r._id === relayId; }));
    expect(turn).toMatchObject({ status: "answered", byOperator: true, answer: "Knocked on Hedy and offered her the rounding fix." });
    expect((await hedy.query(api.handoffs.mine, {})).incoming).toMatchObject([{ _id: must(turn.handoffId), text: said }]);
    // One knock, with Tom's own words.
    const knocks = await t.run(async function (ctx) { return await ctx.db.query("knocks").collect(); });
    expect(knocks.map(function (k) { return k.note; })).toEqual([said]);
    // The relay keeps what the two calls cost: $0.003 each on Sonnet 5.5.
    expect(must(await t.run(async function (ctx) { return await ctx.db.get("relays", relayId); })).usd).toBeCloseTo(0.006, 10);
  });

  test("a chat turn that offers a hand-off and then asks an agent keeps the hand-off on the relay", async function () {
    const t = harness();
    const { tom, jimmy, jimmyToken } = await crew(t);
    replies = [
      message([{ type: "tool_use", id: "tu1", name: "offer_handoff", input: { agent: "1", task: "fix the market update listings filter" } }], "tool_use"),
      message([{ type: "tool_use", id: "tu2", name: "ask_agent", input: { agent: 1, question: "Where are expired listings filtered?" } }], "tool_use"),
    ];
    const said = "hand jimmy this: fix the market update listings filter. Also, where are expired listings filtered?";
    const relayId = await tom.mutation(api.operator.chat, { text: said });
    await routeOnce(t);
    expect(await t.query(api.operator.readsFor, { token: jimmyToken })).toEqual([{ relayId, agentId: "a1", question: "Where are expired listings filtered?", asker: "tom" }]);
    const turn = must((await tom.query(api.operator.chatLog, {})).find(function (r) { return r._id === relayId; }));
    expect(turn.handoffId).toBeDefined();
    expect((await jimmy.query(api.handoffs.mine, {})).incoming).toMatchObject([{ text: said }]);
  });

  test("a work order is offered in the asker's own words, never in Claude's rewording", async function () {
    const t = harness();
    const { tom, jimmy } = await crew(t);
    replies = [message([{ type: "text", text: '{"handoff": 1, "task": "Fix the expired-listings filter in the market update"}' }], "end_turn")];
    const question = "please fix how the market update drops expired listings, it misses some";
    const relayId = await tom.mutation(api.operator.askAsHacker, { question });
    await routeOnce(t);
    expect((await logged(tom, relayId))?.answer).toBe("Offered as a hand-off to @jimmy; they approve it in soopdoop. You will hear back on the wire.");
    expect((await jimmy.query(api.handoffs.mine, {})).incoming).toMatchObject([{ text: question, targetAgentId: "a1" }]);
  });
});

// Keeps the Id import used for readers checking relay ids in this file's assertions.
export type RelayId = Id<"relays">;
