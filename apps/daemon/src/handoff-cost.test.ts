import { describe, expect, test } from "bun:test";
import { claudeCostSince, codexCostSince, costSince } from "./handoff-cost";

const START = Date.parse("2026-10-19T03:40:53.000Z");

// Claude Code 2.1.303 lines: one per content block of a reply, each with the reply's whole usage.
function claudeLine(id: string, at: string, usage: Record<string, unknown>, model = "claude-sonnet-5-5"): string {
  return JSON.stringify({ type: "assistant", timestamp: at, requestId: `req_${id}`, message: { id, model, role: "assistant", usage, content: [{ type: "text", text: "…" }] } });
}

const usage = { input_tokens: 10, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 0, output_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 1_000, ephemeral_5m_input_tokens: 0 } };

describe("what a hand-off cost", function () {
  test("Claude Code: each reply once, only since the hand-off reached the agent, not Claude Code's own replies", function () {
    const text = [
      claudeLine("m0", "2026-10-19T03:30:00.000Z", usage),
      JSON.stringify({ type: "user", timestamp: "2026-10-19T03:40:53.537Z", isMeta: true, message: { role: "user", content: "Another Claude session sent a message: …" } }),
      claudeLine("m1", "2026-10-19T03:40:57.402Z", usage),
      claudeLine("m1", "2026-10-19T03:40:58.051Z", usage),
      claudeLine("m2", "2026-10-19T03:41:10.000Z", { input_tokens: 5, cache_read_input_tokens: 1_000, output_tokens: 50 }),
      claudeLine("m3", "2026-10-19T03:41:11.000Z", { input_tokens: 0, output_tokens: 0 }, "<synthetic>"),
      '{"type":"api-request-blob","messages":[]}',
      "cut {",
    ].join("\n");
    const cost = claudeCostSince(text, START);
    expect(cost.calls).toBe(2);
    // m1 at Sonnet 5.5: 10 in at $2, 1,000 written to the hour-long cache at $4, 100 out at $10; m2: 5 in, 1,000 read at
    // $0.20, 50 out.
    const m1 = (10 * 2 + 1_000 * 4 + 100 * 10) / 1e6;
    const m2 = (5 * 2 + 1_000 * 0.2 + 50 * 10) / 1e6;
    expect(cost.usd).toBeCloseTo(m1 + m2, 10);
  });

  test("Codex: the token_count events since then, on the model the turn ran on", function () {
    const row = function (at: string, type: string, payload: Record<string, unknown>): string {
      return JSON.stringify({ timestamp: at, type, payload });
    };
    const last = { input_tokens: 1_204, cached_input_tokens: 1_000, cache_write_input_tokens: 0, output_tokens: 40, reasoning_output_tokens: 10, total_tokens: 1_244 };
    const text = [
      row("2026-10-19T03:58:06.411Z", "turn_context", { model: "gpt-6.1-sol" }),
      row("2026-10-19T03:58:06.539Z", "event_msg", { type: "token_count", info: { last_token_usage: last, total_token_usage: last } }),
      row("2026-10-19T04:00:00.000Z", "turn_context", { model: "gpt-6.1-sol" }),
      row("2026-10-19T04:00:01.000Z", "event_msg", { type: "token_count", info: { last_token_usage: last, total_token_usage: last } }),
      row("2026-10-19T04:00:02.000Z", "event_msg", { type: "token_count", info: null }),
    ].join("\n");
    const cost = codexCostSince(text, Date.parse("2026-10-19T03:59:00Z"));
    expect(cost.calls).toBe(1);
    // 204 fresh at $2, 1,000 cached at $0.10, 40 out at $10 (reasoning inside output).
    expect(cost.usd).toBeCloseTo((204 * 2 + 1_000 * 0.1 + 40 * 10) / 1e6, 10);
  });

  test("Grok: not priced yet", function () {
    expect(costSince("grok", "{}", 0)).toBeNull();
    expect(costSince("claude-code", "", 0)).toEqual({ usd: 0, calls: 0 });
  });
});
