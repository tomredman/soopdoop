import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { answerFrom, askersWords, chatTurn, MAX_TOOL_ROUNDS, type Meter, parseRoute, ROUTE_MODEL, routeQuestion } from "./claude";

// These run the Operator's Claude code paths with the real SDK against a stand-in for the Messages API: `fetch` is
// replaced, so nothing leaves the machine, and each request is kept to check what would have been sent.

const NOW = Date.UTC(2026, 9, 16, 12);
const DAY = 24 * 60 * 60 * 1000;
const candidates = [
  { handle: "jimmy", agentName: "email-metrics", status: "working", summary: "vibes@email-metrics · fix bounce counts" },
  { handle: "adalovelace", name: "Ada Lovelace", agentName: "quote-page", status: "idle", summary: "the quote page redesign" },
];
const past = [{ handle: "hedy", did: "rounded the coupon code totals", areas: ["convex/coupons"], at: NOW - DAY }];
const crew = [{ handle: "adalovelace", name: "Ada Lovelace" }, { handle: "hedy" }, { handle: "jimmy" }];

interface Asked {
  url: string;
  beta: string;
  body: Record<string, unknown>;
}

let asked: Asked[] = [];
let replies: unknown[] = [];
let realFetch: typeof fetch;
let savedFake: string | undefined;
let savedKey: string | undefined;

async function standIn(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : {};
  asked.push({ url, beta: new Headers(init?.headers).get("anthropic-beta") ?? "", body: body as Record<string, unknown> });
  const next = replies.shift();
  // A 400 is not retried by the SDK, so a test that runs out of replies fails at once.
  if (next === undefined) return Response.json({ type: "error", error: { type: "invalid_request_error", message: "no reply left" } }, { status: 400 });
  return Response.json(next, { headers: { "request-id": "req_test" } });
}

beforeEach(function () {
  asked = [];
  replies = [];
  savedFake = process.env.OPERATOR_FAKE;
  savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.OPERATOR_FAKE;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-a-real-key";
  realFetch = globalThis.fetch;
  globalThis.fetch = standIn as typeof fetch;
});

afterEach(function () {
  globalThis.fetch = realFetch;
  if (savedFake === undefined) delete process.env.OPERATOR_FAKE;
  else process.env.OPERATOR_FAKE = savedFake;
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

function message(content: unknown[], stopReason: string, usage = { input_tokens: 1_000, output_tokens: 100 }) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: ROUTE_MODEL,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage },
  };
}

function toolUse(id: string, name: string, input: Record<string, unknown>) {
  return { type: "tool_use", id, name, input };
}

function text(said: string) {
  return { type: "text", text: said };
}

function messagesOf(a: Asked | undefined): { role: string; content: unknown }[] {
  return (a?.body.messages ?? []) as { role: string; content: unknown }[];
}

describe("the Operator chat with tools, against a stand-in for the API", function () {
  test("it searches the ledger, reads the result, and answers: Sonnet 5.5, five tools, fallbacks on, and what it cost", async function () {
    replies = [
      message([toolUse("tu1", "search_ledger", { query: "coupon rounding" })], "tool_use"),
      message([text("Hedy rounded the coupon totals yesterday. Her agent on it is off. Knock her, or hand it off?")], "end_turn"),
    ];
    const searched: string[] = [];
    const meter: Meter = { usd: 0 };
    const turn = await chatTurn("who did the coupon rounding?", [{ you: "hi", operator: "Hey." }], candidates, "tom", {
      past: [],
      notes: [],
      crew,
      meter,
      now: NOW,
      searchLedger: async function (query) {
        searched.push(query);
        return past;
      },
    });
    expect(turn).toEqual({ reply: "Hedy rounded the coupon totals yesterday. Her agent on it is off. Knock her, or hand it off?" });
    expect(searched).toEqual(["coupon rounding"]);
    expect(asked).toHaveLength(2);
    const first = asked[0];
    expect(first?.url).toContain("/v1/messages");
    expect(first?.beta).toContain("server-side-fallback-2026-07-01");
    expect(first?.body).toMatchObject({ model: "claude-sonnet-5-5", fallbacks: "default", output_config: { effort: "low" }, tool_choice: { type: "auto" } });
    expect((first?.body.tools as { name: string }[]).map(function (t) { return t.name; })).toEqual(["search_ledger", "crew_notes", "ask_agent", "offer_handoff", "knock"]);
    expect(String(first?.body.system)).toContain("You are chatting with @tom");
    const opening = String(messagesOf(first)[0]?.content);
    expect(opening).toContain("1. @jimmy · email-metrics · working · vibes@email-metrics · fix bounce counts");
    expect(opening).toContain("@tom: hi\nOperator: Hey.");
    expect(opening).toContain("New message from @tom: who did the coupon rounding?");
    // The second request carries Claude's tool call and the ledger's answer to it.
    const second = messagesOf(asked[1]);
    expect(second.map(function (m) { return m.role; })).toEqual(["user", "assistant", "user"]);
    expect(second[2]?.content).toEqual([
      { type: "tool_result", tool_use_id: "tu1", content: "- @hedy · yesterday · rounded the coupon code totals · areas: convex/coupons" },
    ]);
    // Two calls of 1,000 tokens in and 100 out on Sonnet 5.5: $0.003 each.
    expect(meter.usd).toBeCloseTo(0.006, 10);
  });

  test("an offer and a knock come back as effects for the backend to carry out; a wrong number is an error Claude can fix", async function () {
    replies = [
      message([toolUse("tu1", "offer_handoff", { agent: "7", task: "Fix the coupon rounding" })], "tool_use"),
      message([
        toolUse("tu2", "offer_handoff", { agent: "3", task: "Fix the coupon rounding" }),
        toolUse("tu3", "knock", { handle: "@hedy", note: "a hand-off is waiting for you" }),
      ], "tool_use"),
      message([text("Offered it to Hedy, and knocked so she sees it.")], "end_turn"),
    ];
    const turn = await chatTurn("hand the coupon rounding fix to whoever did it", [], candidates, "tom", { past, notes: [], crew, now: NOW });
    expect(turn).toEqual({
      reply: "Offered it to Hedy, and knocked so she sees it.",
      offered: { handle: "hedy", task: "Fix the coupon rounding" },
      knocked: { handle: "hedy", note: "a hand-off is waiting for you" },
    });
    const afterWrong = messagesOf(asked[1]);
    expect(afterWrong[2]?.content).toMatchObject([{ type: "tool_result", tool_use_id: "tu1", is_error: true }]);
    // The past work line is numbered after the two open agents.
    expect(String(messagesOf(asked[0])[0]?.content)).toContain("Past work (their agent is not running):\n3. @hedy · yesterday · rounded the coupon code totals");

    replies = [
      message([toolUse("tu1", "offer_handoff", { agent: "2", task: "Tighten the quote form" })], "tool_use"),
      message([toolUse("tu2", "offer_handoff", { agent: "1", task: "a second one" })], "tool_use"),
      message([text("Offered to Ada's agent.")], "end_turn"),
    ];
    const toAgent = await chatTurn("hand the quote form fix to Ada's agent", [], candidates, "tom", { past, notes: [], crew, now: NOW });
    expect(toAgent).toEqual({ reply: "Offered to Ada's agent.", offered: { agent: 1, task: "Tighten the quote form" } });
    expect(messagesOf(asked[asked.length - 1])[4]?.content).toMatchObject([{ tool_use_id: "tu2", is_error: true, content: "One hand-off per message." }]);
  });

  test("an offer by @handle with nothing said after it is told in plain words", async function () {
    replies = [
      message([toolUse("tu1", "offer_handoff", { agent: "@hedy", task: "Fix the coupon rounding" })], "tool_use"),
      message([], "end_turn"),
    ];
    expect(await chatTurn("give the coupon fix to hedy", [], candidates, "tom", { past, notes: [], crew, now: NOW })).toEqual({
      reply: "Offered it to @hedy. They approve it in soopdoop.",
      offered: { handle: "hedy", task: "Fix the coupon rounding" },
    });
  });

  test("ask_agent ends the turn at once, with the agent and a question that stands alone; a question about @someone only lists them", async function () {
    replies = [message([toolUse("tu1", "ask_agent", { agent: 1, question: "Where does the quote page check addresses?" })], "tool_use")];
    const turn = await chatTurn("@adalovelace where are addresses checked?", [], candidates, "tom", { past, notes: ["Coupons round half up."], crew, now: NOW });
    expect(turn).toEqual({ ask: 1, question: "Where does the quote page check addresses?" });
    expect(asked).toHaveLength(1);
    const opening = String(messagesOf(asked[0])[0]?.content);
    expect(opening).toContain("1. @adalovelace (Ada Lovelace) · quote-page");
    expect(opening).not.toContain("@jimmy");
    expect(opening).not.toContain("@hedy");
  });

  test("after four rounds of tools it must answer with what it has", async function () {
    for (let i = 0; i < MAX_TOOL_ROUNDS; i++) replies.push(message([toolUse(`tu${i}`, "crew_notes", {})], "tool_use"));
    replies.push(message([text("Coupons round half up.")], "end_turn"));
    const turn = await chatTurn("what are our rules on coupons?", [], candidates, "tom", { past: [], notes: ["Coupons round half up."], crew, now: NOW });
    expect(turn).toEqual({ reply: "Coupons round half up." });
    expect(asked.map(function (a) { return (a.body.tool_choice as { type: string }).type; })).toEqual(["auto", "auto", "auto", "auto", "none"]);
    expect(messagesOf(asked[1])[2]?.content).toEqual([{ type: "tool_result", tool_use_id: "tu0", content: "- Coupons round half up." }]);
  });

  test("a refusal is a short reply and does nothing it had decided; an answer in the old JSON form is still read", async function () {
    replies = [message([], "refusal")];
    expect(await chatTurn("something it will not do", [], candidates, "tom")).toEqual({ reply: "I'll pass on that one." });
    replies = [
      message([toolUse("tu1", "offer_handoff", { agent: "@hedy", task: "do the thing" }), toolUse("tu2", "knock", { handle: "hedy", note: "look" })], "tool_use"),
      message([], "refusal"),
    ];
    expect(await chatTurn("hand hedy this: do the thing", [], candidates, "tom", { past, notes: [], crew, now: NOW })).toEqual({ reply: "I'll pass on that one." });
    replies = [message([text('{"ask": 2, "question": "Is the quote page done?"}')], "end_turn")];
    expect(await chatTurn("is the quote page done?", [], candidates, "tom")).toEqual({ ask: 1, question: "Is the quote page done?" });
  });
});

describe("the asker's own words, and the router's answer read strictly", function () {
  test("a hand-off's text is the task as the asker wrote it, or their whole message", function () {
    const said = "hey, hand this to Jimmy: Fix the bounce counts in VIB-123, thanks";
    expect(askersWords("fix the bounce counts in VIB-123", said)).toBe("Fix the bounce counts in VIB-123");
    expect(askersWords("Repair the bounce counting", said)).toBe(said);
    expect(askersWords("  ", `  ${said} `)).toBe(said);
  });

  test("a bare number is an agent only when it is the whole answer; prose with numbers in it is nobody", function () {
    expect(parseRoute(" 2 ", 2)).toEqual({ ask: 1 });
    expect(parseRoute("Ada did 2 pieces of work on that, the last 1 day ago.", 2)).toBeNull();
  });
});

describe("the router, against a stand-in for the API", function () {
  test("it lists past work numbered after the open agents, and a hand-off to past work goes to its owner", async function () {
    const meter: Meter = { usd: 0 };
    replies = [message([text('{"handoff": 3, "task": "Fix the coupon rounding at checkout"}')], "end_turn")];
    const routed = await routeQuestion("Fix the coupon rounding at checkout, please", candidates, { past, meter, now: NOW });
    expect(routed).toEqual({ handoff: 2, task: "Fix the coupon rounding at checkout" });
    const sent = asked[0];
    expect(sent?.body).toMatchObject({ model: "claude-sonnet-5-5", fallbacks: "default" });
    expect(String(sent?.body.system)).toContain("{\"handoff\": <agent or past work number>");
    expect(String(messagesOf(sent)[0]?.content)).toBe(
      "Question: Fix the coupon rounding at checkout, please\n\nAgents:\n" +
        "1. @jimmy · email-metrics · working · vibes@email-metrics · fix bounce counts\n" +
        "2. @adalovelace (Ada Lovelace) · quote-page · idle · the quote page redesign\n\n" +
        "Past work (their agent is not running):\n3. @hedy · yesterday · rounded the coupon code totals · areas: convex/coupons",
    );
    expect(meter.usd).toBeCloseTo(0.003, 10);

    // No task: the question is the task. A past work line cannot be asked.
    replies = [message([text('{"handoff": 1}')], "end_turn")];
    expect(await routeQuestion("Fix the bounce counts", candidates, { past })).toEqual({ handoff: 0, task: "Fix the bounce counts" });
    replies = [message([text('{"ask": 3}')], "end_turn")];
    expect(await routeQuestion("How are coupons rounded?", candidates, { past })).toBeNull();
    // A who-question the ledger answers comes back as the Operator's reply.
    replies = [message([text('{"reply": "Hedy (@hedy) did a piece of work on that yesterday. Her agent on it is off right now. Knock her, or hand it off?"}')], "end_turn")];
    expect(await routeQuestion("Who knows about coupon rounding?", [], { past })).toEqual({
      reply: "Hedy (@hedy) did a piece of work on that yesterday. Her agent on it is off right now. Knock her, or hand it off?",
    });
  });

  test("an answer from a slice runs on Sonnet 5.5 and says what it cost", async function () {
    replies = [message([text("Expired listings are dropped in select.ts.")], "end_turn", { input_tokens: 5_000, output_tokens: 20 })];
    const a = await answerFrom("Where are expired listings dropped?", "assistant: in select.ts", { handle: "jimmy" });
    expect(a).toMatchObject({ text: "Expired listings are dropped in select.ts.", tokensRead: 5_000 });
    expect(a.usd).toBeCloseTo(0.0102, 10);
    expect(asked[0]?.body).toMatchObject({ model: "claude-sonnet-5-5", output_config: { effort: "medium" } });
  });
});
