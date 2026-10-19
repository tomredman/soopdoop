// ABOUTME: What one of the Operator's own Claude calls cost, in US dollars at Anthropic's API prices (October 2026), from
// ABOUTME: the response's model and usage. Relays keep it, so a crew sees what its Operator costs. Pure, so it is tested.

// Dollars per million tokens: input, output, and input read back from the prompt cache.
interface Price {
  input: number;
  output: number;
  cacheRead: number;
}

const PRICES: Record<string, Price> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  // Sonnet 5.5's server-side fallback can answer on the Sonnet before it, at the same prices.
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
};

// A model this table does not know (a server-side fallback after a refusal can answer on another model) is priced as
// Opus 5.5, the dearer of the two the Operator uses, so the crew's cost line errs high rather than low.
const UNKNOWN: Price = { input: 4, output: 20, cacheRead: 0.2 };

// Writing the prompt cache costs more than plain input: 1.25 times for five minutes, twice for an hour.
const WRITE_5M = 1.25;
const WRITE_1H = 2;

// The token counts a response's usage carries. The SDK's usage objects fit this shape.
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_1h_input_tokens: number } | null;
}

// One sampling step of a request (usage.iterations): its own model and counts. A server-side fallback adds one per model.
export interface IterationUsage extends TokenUsage {
  type: string;
  model?: string | null;
}

export function priceOf(model: string, usage: TokenUsage): number {
  const p = PRICES[model] ?? UNKNOWN;
  const hour = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const fiveMinutes = Math.max(0, (usage.cache_creation_input_tokens ?? 0) - hour);
  const dollars =
    usage.input_tokens * p.input +
    usage.output_tokens * p.output +
    (usage.cache_read_input_tokens ?? 0) * p.cacheRead +
    fiveMinutes * p.input * WRITE_5M +
    hour * p.input * WRITE_1H;
  return dollars / 1_000_000;
}

// What a whole response cost. When usage lists its sampling steps, each is priced as the model that ran it (a refusal
// that fell back to another model is billed on both); otherwise the totals are priced as the response's model.
export function usdOf(response: { model: string; usage: TokenUsage & { iterations?: IterationUsage[] | null } }): number {
  const steps = (response.usage.iterations ?? []).filter(function (s) {
    return s.type === "message" || s.type === "fallback_message";
  });
  if (steps.length === 0) return priceOf(response.model, response.usage);
  return steps.reduce(function (sum, s) { return sum + priceOf(s.model ?? response.model, s); }, 0);
}
