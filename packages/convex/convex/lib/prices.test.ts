import { describe, expect, test } from "bun:test";
import { priceOf, usdOf } from "./prices";

describe("what the Operator's Claude calls cost", function () {
  test("Sonnet 5.5 and Opus 5.5 at API prices: input, output and cache reads per million tokens", function () {
    expect(priceOf("claude-sonnet-5-5", { input_tokens: 1_000_000, output_tokens: 0 })).toBeCloseTo(2, 10);
    expect(priceOf("claude-sonnet-5-5", { input_tokens: 0, output_tokens: 1_000_000 })).toBeCloseTo(10, 10);
    expect(priceOf("claude-sonnet-5-5", { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 })).toBeCloseTo(0.2, 10);
    expect(priceOf("claude-opus-5-5", { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 })).toBeCloseTo(24.2, 10);
    // A routing call: 1,200 tokens in, 80 out on Sonnet 5.5, under half a cent.
    expect(priceOf("claude-sonnet-5-5", { input_tokens: 1_200, output_tokens: 80 })).toBeCloseTo(0.0032, 10);
  });

  test("writing the cache costs 1.25 times input for five minutes and twice for an hour; null counts are none", function () {
    expect(priceOf("claude-opus-5-5", { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 })).toBeCloseTo(5, 10);
    expect(priceOf("claude-opus-5-5", {
      input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_1h_input_tokens: 1_000_000 },
    })).toBeCloseTo(8, 10);
    expect(priceOf("claude-sonnet-5-5", { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: null, cache_creation_input_tokens: null })).toBeCloseTo(0.00002, 12);
  });

  test("a model the table does not know is priced as Opus 5.5", function () {
    expect(priceOf("claude-something-new", { input_tokens: 1_000_000, output_tokens: 0 })).toBeCloseTo(4, 10);
  });

  test("a response that fell back to another model is priced step by step, each as its own model", function () {
    const plain = { model: "claude-sonnet-5-5", usage: { input_tokens: 1_000_000, output_tokens: 0 } };
    expect(usdOf(plain)).toBeCloseTo(2, 10);
    const fellBack = {
      model: "claude-opus-5-5",
      usage: {
        input_tokens: 2_000_000,
        output_tokens: 0,
        iterations: [
          { type: "message", model: "claude-sonnet-5-5", input_tokens: 1_000_000, output_tokens: 0 },
          { type: "fallback_message", model: "claude-opus-5-5", input_tokens: 1_000_000, output_tokens: 0 },
          // Compaction is not part of the Operator's calls, and is not counted here.
          { type: "compaction", input_tokens: 5_000_000, output_tokens: 0 },
        ],
      },
    };
    expect(usdOf(fellBack)).toBeCloseTo(6, 10);
  });
});
