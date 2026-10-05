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
      JSON.stringify({ at: "2026-10-05T19:00:00Z", relayId: "r1", agentId: "a1", asker: "vlad", model: "claude-opus-5-5", tokensRead: 72_605, usd: 0.39 }),
      JSON.stringify({ at: "2026-10-05T19:30:00Z", relayId: "r2", agentId: "a2", usd: 0.04 }),
    ].join("\n");
    expect(parseSpends(log)).toEqual([
      { at: Date.parse("2026-10-05T19:00:00Z"), agentId: "a1", asker: "vlad", model: "claude-opus-5-5", tokensRead: 72_605, usd: 0.39 },
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
  });

  test("lets answers through while the fund lasts, then stops them; old answers drop out after 24 hours", function () {
    expect(fundLimit(fund, [], { agentId: "a1", asker: "vlad" }, NOW)).toBeNull();
    const spent = [spend({ usd: 2, asker: "vlad" }), spend({ usd: 2.5, asker: "mira" })];
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
    const spent = [spend({ usd: 2.4, asker: "vlad", tokensRead: 50_000, model: "claude-opus-5-5" })];
    // Vlad: $2.40 of his $2.50, and the next read is expected to cost about $0.44.
    expect(fundLimit(fund, spent, { agentId: "a1", asker: "vlad" }, NOW)).toEqual({
      kind: "share", note: "You have used your share of this crewmate's answering fund for today.",
    });
    expect(fundLimit(fund, spent, { agentId: "a1", asker: "mira" }, NOW)).toBeNull();
    // From an older backend, with no asker: only the whole fund applies.
    expect(fundLimit(fund, spent, { agentId: "a1" }, NOW)).toBeNull();
  });

  test("a fund of zero turns answering off", function () {
    expect(fundLimit({ dailyUsd: 0, askerShare: 0.5 }, [], { agentId: "a1", asker: "vlad" }, NOW)?.kind).toBe("off");
  });

  test("adds up the last 24 hours, by asker", function () {
    const { total, byAsker } = spentToday([spend({ usd: 1, asker: "vlad" }), spend({ usd: 0.5, asker: "vlad" }), spend({ usd: 2 }),
      spend({ usd: 9, at: NOW - 25 * HOUR, asker: "vlad" })], NOW);
    expect(total).toBe(3.5);
    expect([...byAsker]).toEqual([["vlad", 1.5], ["?", 2]]);
  });
});
