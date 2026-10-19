import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  answerCost,
  DEFAULT_FUND,
  estimateCost,
  fundLimit,
  parseFund,
  parseSpends,
  priceFor,
  readFund,
  type Spend,
  spentToday,
  tokensReadOf,
  writeFund,
} from "./fund";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "soopdoop-fund-"));
  dirs.push(dir);
  return dir;
}
afterAll(async function () {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-05T20:00:00Z");

function spend(over: Partial<Spend>): Spend {
  return { at: NOW - HOUR, agentId: "a1", usd: 1, ...over };
}

describe("what one answer costs", function () {
  test("prices each model, the longest name first, and an unknown model like the dearest", function () {
    expect(priceFor("claude-opus-5-5").input).toBe(4);
    expect(priceFor("claude-opus-5").input).toBe(5);
    expect(priceFor("claude-opus-4-8").input).toBe(5);
    expect(priceFor("claude-sonnet-5-5").input).toBe(2);
    expect(priceFor("claude-haiku-4-5-20251001").input).toBe(1);
    expect(priceFor("claude-fable-5-1").input).toBe(10);
    expect(priceFor("some-new-model").input).toBe(10);
    expect(priceFor(undefined).input).toBe(10);
  });

  test("matches what Claude Code charged for real forks of a 72,000-token session", function () {
    // The first question writes the conversation to an hour-long prompt cache, at twice the input price ...
    const cold = { input_tokens: 2, cache_creation_input_tokens: 72_063, cache_read_input_tokens: 540, output_tokens: 1_431,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 72_063 } };
    expect(answerCost(cold, "claude-opus-5-5")).toBeCloseTo(0.605, 3);
    // ... and a question within the hour reads it back at $0.20 a million.
    const warm = { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 72_603, output_tokens: 1_057 };
    expect(answerCost(warm, "claude-opus-5-5")).toBeCloseTo(0.0357, 4);
    // The same first question on Sonnet 5.5 costs half.
    expect(answerCost(cold, "claude-sonnet-5-5")).toBeCloseTo((2 * 2 + 72_063 * 4 + 540 * 0.2 + 1_431 * 10) / 1_000_000, 6);
    expect(answerCost(cold, "claude-sonnet-5-5") / answerCost(cold, "claude-opus-5-5")).toBeCloseTo(0.5, 1);
    // A 5-minute cache write costs 1.25 times input.
    expect(answerCost({ cache_creation_input_tokens: 1_000 }, "claude-opus-5-5")).toBeCloseTo(0.005, 6);
    expect(answerCost({}, "claude-opus-5-5")).toBe(0);
  });

  test("prices OpenAI's models (Codex) and xAI's (Grok) by the longest prefix that fits", function () {
    expect(priceFor("gpt-6.1-sol").input).toBe(2);
    expect(priceFor("gpt-6-sol").cacheRead).toBe(0.2);
    expect(priceFor("gpt-6-astra").output).toBe(50);
    expect(priceFor("gpt-5.4-mini-2026-03-01").input).toBe(0.75);
    expect(priceFor("gpt-5.4").input).toBe(2.5);
    expect(priceFor("gpt-5.2-codex").input).toBe(1.75);
    expect(priceFor("gpt-5-mini").input).toBe(0.25);
    expect(priceFor("gpt-5").input).toBe(1.25);
    expect(priceFor("o3-mini").input).toBe(1.1);
    expect(priceFor("o3").input).toBe(2);
    expect(priceFor("o4-mini").cacheRead).toBe(0.275);
    // "pro" models list no cached-input price: their cache reads cost plain input.
    expect(priceFor("gpt-5.5-pro").cacheRead).toBe(30);
    expect(priceFor("grok-4.7").input).toBe(2);
    expect(priceFor("grok-4.7-build").input).toBe(0.68);
    expect(priceFor("grok-4.3").output).toBe(2.5);
    // A Grok model not listed is priced like the dearest Grok; any other unknown model like the dearest of all.
    expect(priceFor("grok-code-fast-1").input).toBe(2);
    expect(priceFor("gpt-9").input).toBe(10);
  });

  test("Codex's usage counts cached and cache-written tokens inside input_tokens", function () {
    // A real Codex fork's usage (Codex 0.160.0, gpt-6.1-sol): 66,392 read, 34,048 of them from the cache, 69 written.
    const fork = { input_tokens: 66_392, cached_input_tokens: 34_048, cache_write_input_tokens: 0, output_tokens: 69, reasoning_output_tokens: 0 };
    expect(tokensReadOf(fork)).toBe(66_392);
    expect(answerCost(fork, "gpt-6.1-sol")).toBeCloseTo(((66_392 - 34_048) * 2 + 34_048 * 0.1 + 69 * 10) / 1_000_000, 10);
    // gpt-6.x charges cache writes at 1.25 times input.
    expect(answerCost({ input_tokens: 1_000, cached_input_tokens: 0, cache_write_input_tokens: 1_000, output_tokens: 0 }, "gpt-6.1-sol")).toBeCloseTo(0.0025, 10);
    // Above 272,000 tokens of input the whole request is priced at the long-context rates.
    expect(answerCost({ input_tokens: 272_000, cached_input_tokens: 0, output_tokens: 0 }, "gpt-6.1-sol")).toBeCloseTo(0.544, 10);
    expect(answerCost({ input_tokens: 300_000, cached_input_tokens: 0, output_tokens: 1_000 }, "gpt-6.1-sol")).toBeCloseTo(1.2 + 0.015, 10);
  });

  test("Grok's usage uses Claude's keys, and matches what Grok itself charged", function () {
    // One real Grok turn on grok-4.7-build: 42,602 tokens in, 1,152 of them cached, 94 out. Grok recorded 285,736,000 ticks
    // for it (1 dollar is 10^10 ticks).
    const turn = { input_tokens: 41_450, cache_read_input_tokens: 1_152, cache_creation_input_tokens: 0, output_tokens: 94, reasoning_tokens: 81 };
    expect(tokensReadOf(turn)).toBe(42_602);
    expect(answerCost(turn, "grok-4.7-build")).toBeCloseTo(285_736_000 / 1e10, 10);
    // From 200,000 tokens on, xAI charges twice every rate.
    expect(answerCost({ input_tokens: 200_000, output_tokens: 0 }, "grok-4.7")).toBeCloseTo(0.8, 10);
    expect(answerCost({ input_tokens: 199_999, output_tokens: 0 }, "grok-4.7")).toBeCloseTo(0.399998, 10);
  });
});

describe("the fund's settings", function () {
  test("$5 a day, half of it per crewmate, unless fund.json says otherwise", async function () {
    expect(parseFund(null)).toEqual(DEFAULT_FUND);
    expect(DEFAULT_FUND).toEqual({ dailyUsd: 5, askerShare: 0.5 });
    expect(parseFund({ dailyUsd: 12.5, askerShare: 0.25 })).toEqual({ dailyUsd: 12.5, askerShare: 0.25 });
    // Zero turns answering off; nonsense is ignored.
    expect(parseFund({ dailyUsd: 0 })).toEqual({ dailyUsd: 0, askerShare: 0.5 });
    expect(parseFund({ dailyUsd: -1, askerShare: 2 })).toEqual(DEFAULT_FUND);
    const file = path.join(await tempDir(), "fund.json");
    expect(await readFund(file)).toEqual(DEFAULT_FUND);
    await writeFund({ dailyUsd: 20, askerShare: 1 }, file);
    expect(await readFund(file)).toEqual({ dailyUsd: 20, askerShare: 1 });
  });

  test("counts only log lines that carry the answer's own cost", function () {
    const log = [
      // Older lines logged costUsd, which counted the whole session's past: not counted.
      JSON.stringify({ at: "2026-10-05T18:00:00Z", relayId: "r0", agentId: "a1", costUsd: 3.5, tokensRead: 433_197 }),
      "not json",
      JSON.stringify({ at: "2026-10-05T19:00:00Z", relayId: "r1", agentId: "a1", asker: "hedy", model: "claude-opus-5-5", tokensRead: 72_605, usd: 0.39 }),
      JSON.stringify({ at: "2026-10-05T19:30:00Z", relayId: "r2", agentId: "a2", usd: 0.04 }),
    ].join("\n");
    expect(parseSpends(log)).toEqual([
      { at: Date.parse("2026-10-05T19:00:00Z"), agentId: "a1", asker: "hedy", model: "claude-opus-5-5", tokensRead: 72_605, usd: 0.39 },
      { at: Date.parse("2026-10-05T19:30:00Z"), agentId: "a2", usd: 0.04 },
    ]);
  });
});

describe("the fund's limits", function () {
  const fund = { dailyUsd: 5, askerShare: 0.5 };

  test("expects the next read of an agent to cost what reading it all costs with nothing cached", function () {
    const spends = [
      spend({ at: NOW - 2 * HOUR, tokensRead: 10_000, model: "claude-opus-5-5" }),
      spend({ at: NOW - HOUR, tokensRead: 400_000, model: "claude-opus-5-5" }),
      spend({ agentId: "a2", tokensRead: 900_000 }),
    ];
    // The latest read of a1: 400,000 tokens at $8 a million to write to the hour-long cache, plus room for the answer.
    expect(estimateCost(spends, "a1")).toBeCloseTo((400_000 * 8 + 2_000 * 20) / 1_000_000, 6);
    expect(estimateCost(spends, "never-read")).toBe(0);
    // A Codex agent: its conversation at gpt-6.1-sol's cache-write price; a Grok one at plain input.
    expect(estimateCost([spend({ agentId: "c1", tokensRead: 66_392, model: "gpt-6.1-sol" })], "c1")).toBeCloseTo((66_392 * 2.5 + 2_000 * 10) / 1_000_000, 10);
    expect(estimateCost([spend({ agentId: "g1", tokensRead: 42_602, model: "grok-4.7-build" })], "g1")).toBeCloseTo((42_602 * 0.68 + 2_000 * 2.04) / 1_000_000, 10);
  });

  test("lets answers through while the fund lasts, then stops them; old answers drop out after 24 hours", function () {
    expect(fundLimit(fund, [], { agentId: "a1", asker: "hedy" }, NOW)).toBeNull();
    const spent = [spend({ usd: 2, asker: "hedy" }), spend({ usd: 2.5, asker: "mira" })];
    expect(fundLimit(fund, spent, { agentId: "a1", asker: "jimmy" }, NOW)).toBeNull();
    // $4.50 spent: an answer expected to cost $1.64 would pass $5.
    const big = [...spent, spend({ usd: 0, tokensRead: 200_000, model: "claude-opus-5-5" })];
    expect(fundLimit(fund, big, { agentId: "a1", asker: "jimmy" }, NOW)?.kind).toBe("fund");
    // A day later, the same answers no longer count.
    expect(fundLimit(fund, big, { agentId: "a1", asker: "jimmy" }, NOW + 24 * HOUR)).toBeNull();
    // Answers still running count too.
    expect(fundLimit(fund, spent, { agentId: "a1", asker: "jimmy" }, NOW, 0.6)?.kind).toBe("fund");
  });

  test("one crewmate can use only their share, and the others can still ask", function () {
    const spent = [spend({ usd: 2.4, asker: "hedy", tokensRead: 50_000, model: "claude-opus-5-5" })];
    // Hedy: $2.40 of their $2.50, and the next read is expected to cost about $0.44.
    expect(fundLimit(fund, spent, { agentId: "a1", asker: "hedy" }, NOW)).toEqual({
      kind: "share", note: "You have used your share of this crewmate's answering fund for today.",
    });
    expect(fundLimit(fund, spent, { agentId: "a1", asker: "mira" }, NOW)).toBeNull();
    // From an older backend, with no asker: only the whole fund applies.
    expect(fundLimit(fund, spent, { agentId: "a1" }, NOW)).toBeNull();
  });

  test("a fund of zero turns answering off", function () {
    expect(fundLimit({ dailyUsd: 0, askerShare: 0.5 }, [], { agentId: "a1", asker: "hedy" }, NOW)?.kind).toBe("off");
  });

  test("adds up the last 24 hours, by asker", function () {
    const { total, byAsker } = spentToday([spend({ usd: 1, asker: "hedy" }), spend({ usd: 0.5, asker: "hedy" }), spend({ usd: 2 }),
      spend({ usd: 9, at: NOW - 25 * HOUR, asker: "hedy" })], NOW);
    expect(total).toBe(3.5);
    expect([...byAsker]).toEqual([["hedy", 1.5], ["?", 2]]);
  });
});
