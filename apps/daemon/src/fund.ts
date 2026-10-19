// ABOUTME: The anti-hijacking fund: how much this Mac's agents may spend answering crewmates' questions in 24 hours, in all
// ABOUTME: and per crewmate, checked before each answer; and what one answer cost, from the usage Claude Code, Codex or Grok reports.
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { soopdoopHome } from "./config";
import { isRecord } from "./state";

// US dollars per million tokens: input, output, cache reads and cache writes.
interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  // A cache write: 1.25 times input at Anthropic (a 5-minute cache) and at OpenAI where it lists one; plain input otherwise.
  cacheWrite: number;
}

interface Price extends Rates {
  // Anthropic's hour-long cache write, twice input. Claude Code writes the conversation to it.
  cacheWriteHour?: number;
  // A request with at least `from` tokens of input is priced at these rates, all of it.
  long?: Rates & { from: number };
}

function anthropic(input: number, output: number, cacheRead: number): Price {
  return { input, output, cacheRead, cacheWrite: input * 1.25, cacheWriteHour: input * 2 };
}

// OpenAI lists cache writes (1.25 times input) for the gpt-6 and gpt-5.6 families only; the others write at plain input. A
// model with no cached-input price ("pro") reads its cache at plain input. Long context starts above 272,000 input tokens.
function openai(input: number, cacheRead: number | null, output: number, options: { writes?: boolean; long?: [number, number, number] } = {}): Price {
  const write = options.writes === true ? 1.25 : 1;
  const price: Price = { input, output, cacheRead: cacheRead ?? input, cacheWrite: input * write };
  if (options.long !== undefined) {
    const [longInput, longRead, longOutput] = options.long;
    price.long = { input: longInput, output: longOutput, cacheRead: longRead, cacheWrite: longInput * write, from: 272_001 };
  }
  return price;
}

// xAI lists no cache-write price, and charges twice every rate for a request of 200,000 tokens or more.
function xai(input: number, cacheRead: number, output: number): Price {
  return {
    input, output, cacheRead, cacheWrite: input,
    long: { input: input * 2, output: output * 2, cacheRead: cacheRead * 2, cacheWrite: input * 2, from: 200_000 },
  };
}

// Prices by model name prefix, October 2026. The longest prefix that fits wins, so "gpt-5.4-mini" is not priced as
// "gpt-5.4" and "claude-opus-5-5" not as "claude-opus-5".
//   Anthropic: Anthropic's API prices (claude.com/pricing).
//   OpenAI: https://developers.openai.com/api/docs/pricing, read 18 Oct 2026, Standard tier.
//   xAI: https://docs.x.ai/docs/models, read 18 Oct 2026. grok-4.7-build (what Grok Build's own sign-in serves) is not
//   listed there: its rates come from the cost Grok 1.0.46 recorded for it on Mr. Tom's Mac (usage.json, costUsdTicks), which
//   two turns matched to the tick at $0.68 / $0.17 / $2.04; that it doubles at 200,000 tokens like grok-4.7 is assumed.
const PRICES: [string, Price][] = [
  ["claude-fable-5-1", anthropic(10, 50, 0.25)],
  ["claude-mythos-5-1", anthropic(10, 50, 0.25)],
  ["claude-fable-5", anthropic(10, 50, 1)],
  ["claude-opus-5-5", anthropic(4, 20, 0.2)],
  ["claude-opus-5", anthropic(5, 25, 0.5)],
  ["claude-opus-4", anthropic(5, 25, 0.5)],
  ["claude-sonnet-5-5", anthropic(2, 10, 0.2)],
  ["claude-sonnet-5", anthropic(2, 10, 0.2)],
  ["claude-sonnet-4", anthropic(3, 15, 0.3)],
  ["claude-haiku-4-5", anthropic(1, 5, 0.1)],

  ["gpt-6-astra", openai(10, 1, 50, { writes: true, long: [20, 2, 75] })],
  ["gpt-6.1-sol", openai(2, 0.1, 10, { writes: true, long: [4, 0.2, 15] })],
  ["gpt-6-sol", openai(2, 0.2, 10, { writes: true, long: [4, 0.4, 15] })],
  ["gpt-6-luna", openai(0.1, 0.01, 0.5, { writes: true })],
  ["gpt-5.6-sol", openai(4, 0.4, 20, { writes: true })],
  ["gpt-5.6-terra", openai(2, 0.2, 12, { writes: true })],
  ["gpt-5.6-luna", openai(0.2, 0.02, 1.2, { writes: true })],
  ["gpt-5.5-pro", openai(30, null, 180)],
  ["gpt-5.5", openai(5, 0.5, 30, { long: [10, 1, 45] })],
  ["gpt-5.4-pro", openai(30, null, 180)],
  ["gpt-5.4-mini", openai(0.75, 0.075, 4.5)],
  ["gpt-5.4-nano", openai(0.2, 0.02, 1.25)],
  ["gpt-5.4", openai(2.5, 0.25, 15, { long: [5, 0.5, 22.5] })],
  ["gpt-5.3-codex", openai(1.75, 0.175, 14)],
  ["gpt-5.2-pro", openai(21, null, 168)],
  ["gpt-5.2", openai(1.75, 0.175, 14)],
  ["gpt-5.1", openai(1.25, 0.125, 10)],
  ["gpt-5-pro", openai(15, null, 120)],
  ["gpt-5-mini", openai(0.25, 0.025, 2)],
  ["gpt-5-nano", openai(0.05, 0.005, 0.4)],
  ["gpt-5", openai(1.25, 0.125, 10)],
  ["o1-pro", openai(150, null, 600)],
  ["o1", openai(15, 7.5, 60)],
  ["o3-pro", openai(20, null, 80)],
  ["o3-mini", openai(1.1, 0.55, 4.4)],
  ["o3", openai(2, 0.5, 8)],
  ["o4-mini", openai(1.1, 0.275, 4.4)],

  ["grok-4.7-build", xai(0.68, 0.17, 2.04)],
  ["grok-4.7", xai(2, 0.5, 6)],
  ["grok-4.6", xai(2, 0.5, 6)],
  ["grok-4.5", xai(2, 0.3, 6)],
  ["grok-4.3", xai(1.25, 0.2, 2.5)],
  ["grok-4.20", xai(1.25, 0.2, 2.5)],
  ["grok-build-0.1", xai(1, 0.2, 2)],
  // A Grok model not listed above is priced like the dearest Grok.
  ["grok-", xai(2, 0.5, 6)],
];
PRICES.sort(function (a, b) { return b[0].length - a[0].length; });

// A model not listed is priced like the dearest.
const DEAREST: Price = anthropic(10, 50, 1);

export function priceFor(model: string | undefined): Price {
  if (model !== undefined) {
    for (const [prefix, price] of PRICES) if (model.startsWith(prefix)) return price;
  }
  return DEAREST;
}

function count(record: Record<string, unknown>, key: string): number {
  const n = record[key];
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

// OpenAI's usage (Codex) counts cached and cache-written tokens inside input_tokens; Anthropic's (Claude Code) and xAI's
// (Grok) count them apart, as cache_read_input_tokens and cache_creation_input_tokens.
function isOpenAiUsage(usage: Record<string, unknown>): boolean {
  return "cached_input_tokens" in usage || "cache_write_input_tokens" in usage;
}

// How many tokens of conversation the answering copy read, whatever the harness.
export function tokensReadOf(usage: Record<string, unknown>): number {
  if (isOpenAiUsage(usage)) return count(usage, "input_tokens");
  return count(usage, "input_tokens") + count(usage, "cache_creation_input_tokens") + count(usage, "cache_read_input_tokens");
}

function ratesFor(price: Price, prompt: number): Price {
  return price.long !== undefined && prompt >= price.long.from ? { ...price, ...price.long } : price;
}

// What one answer cost, from the answering copy's own usage, at the model's API prices. Claude Code's total_cost_usd is
// not used: after --resume it also counts everything the original session ever spent. The small side call Claude Code
// makes on a cheap model is left out. Codex's output tokens include its reasoning, and so do Grok's.
export function answerCost(usage: Record<string, unknown>, model: string | undefined): number {
  const openAi = isOpenAiUsage(usage);
  const read = count(usage, openAi ? "cached_input_tokens" : "cache_read_input_tokens");
  const written = count(usage, openAi ? "cache_write_input_tokens" : "cache_creation_input_tokens");
  const fresh = openAi ? Math.max(0, count(usage, "input_tokens") - read - written) : count(usage, "input_tokens");
  const price = ratesFor(priceFor(model), fresh + read + written);
  const split = isRecord(usage.cache_creation) ? usage.cache_creation : {};
  const hour = Math.min(written, count(split, "ephemeral_1h_input_tokens"));
  const dollars =
    fresh * price.input +
    (written - hour) * price.cacheWrite +
    hour * (price.cacheWriteHour ?? price.cacheWrite) +
    read * price.cacheRead +
    count(usage, "output_tokens") * price.output;
  return dollars / 1_000_000;
}

// How much this Mac's agents may spend on crewmates' questions in any 24 hours, and the part of that one crewmate may use.
export interface Fund {
  dailyUsd: number;
  askerShare: number;
}

export const DEFAULT_FUND: Fund = { dailyUsd: 5, askerShare: 0.5 };

export function fundPath(home: string = soopdoopHome()): string {
  return path.join(home, "fund.json");
}

export function parseFund(raw: unknown): Fund {
  const fund = { ...DEFAULT_FUND };
  if (!isRecord(raw)) return fund;
  if (typeof raw.dailyUsd === "number" && Number.isFinite(raw.dailyUsd) && raw.dailyUsd >= 0) fund.dailyUsd = raw.dailyUsd;
  if (typeof raw.askerShare === "number" && raw.askerShare > 0 && raw.askerShare <= 1) fund.askerShare = raw.askerShare;
  return fund;
}

export async function readFund(file: string = fundPath()): Promise<Fund> {
  try {
    return parseFund(await Bun.file(file).json());
  } catch {
    return { ...DEFAULT_FUND };
  }
}

export async function writeFund(fund: Fund, file: string = fundPath()): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await Bun.write(file, JSON.stringify(fund, null, 2) + "\n");
}

// Where every answer is logged (sizes and cost, never the question or the answer).
export function readsLogPath(home: string = soopdoopHome()): string {
  return path.join(home, "logs", "reads.log");
}

// One answer from reads.log, as the fund counts it.
export interface Spend {
  at: number;
  agentId: string;
  usd: number;
  asker?: string;
  model?: string;
  tokensRead?: number;
}

// Only lines with "usd" count: older lines logged Claude Code's total_cost_usd, which includes the whole session's past.
export function parseSpends(text: string): Spend[] {
  const out: Spend[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(row) || typeof row.usd !== "number" || typeof row.agentId !== "string" || typeof row.at !== "string") continue;
    const at = Date.parse(row.at);
    if (Number.isNaN(at)) continue;
    const spend: Spend = { at, agentId: row.agentId, usd: row.usd };
    if (typeof row.asker === "string") spend.asker = row.asker;
    if (typeof row.model === "string") spend.model = row.model;
    if (typeof row.tokensRead === "number") spend.tokensRead = row.tokensRead;
    out.push(spend);
  }
  return out;
}

export async function readSpends(home: string = soopdoopHome()): Promise<Spend[]> {
  const text = await readFile(readsLogPath(home), "utf8").catch(function () { return ""; });
  return parseSpends(text);
}

const WINDOW_MS = 24 * 60 * 60 * 1000;
// Room for the answer itself: the copy is asked for five short sentences, and it thinks a little first.
const ANSWER_TOKENS = 2_000;

// What reading this agent's conversation will cost with nothing cached, judged from the last time it was read: Claude
// Code writes the conversation to an hour-long prompt cache, at twice the input price; Codex and Grok at their cache-write
// price. Zero when it has not been read yet, so the fund can run over by that one answer.
export function estimateCost(spends: Spend[], agentId: string): number {
  let last: Spend | undefined;
  for (const s of spends) if (s.agentId === agentId && s.tokensRead !== undefined && (last === undefined || s.at > last.at)) last = s;
  if (last?.tokensRead === undefined) return 0;
  const price = ratesFor(priceFor(last.model), last.tokensRead);
  return (last.tokensRead * (price.cacheWriteHour ?? price.cacheWrite) + ANSWER_TOKENS * price.output) / 1_000_000;
}

// Why the fund stops one more answer, if it does: answering is off, the 24-hour fund is spent, or this crewmate has used
// their share of it. Null when the answer can go ahead. `pending` is what answers still running have reserved.
export type Limit = { kind: "off" | "fund" | "share"; note: string };

export function fundLimit(fund: Fund, spends: Spend[], read: { agentId: string; asker?: string }, now: number, pending = 0): Limit | null {
  if (fund.dailyUsd <= 0) return { kind: "off", note: "This crewmate has turned off answering questions." };
  const recent = spends.filter(function (s) { return now - s.at < WINDOW_MS; });
  const estimate = estimateCost(spends, read.agentId);
  const spent = recent.reduce(function (sum, s) { return sum + s.usd; }, 0) + pending;
  if (spent + estimate > fund.dailyUsd) {
    return { kind: "fund", note: "This crewmate's agents have spent today's answering fund." };
  }
  if (read.asker !== undefined) {
    const theirs = recent.reduce(function (sum, s) { return s.asker === read.asker ? sum + s.usd : sum; }, 0);
    if (theirs + estimate > fund.dailyUsd * fund.askerShare) {
      return { kind: "share", note: "You have used your share of this crewmate's answering fund for today." };
    }
  }
  return null;
}

// Spent in the last 24 hours, in all and by asker, for `soopdoop fund`.
export function spentToday(spends: Spend[], now: number): { total: number; byAsker: Map<string, number> } {
  const byAsker = new Map<string, number>();
  let total = 0;
  for (const s of spends) {
    if (now - s.at >= WINDOW_MS) continue;
    total += s.usd;
    const who = s.asker ?? "?";
    byAsker.set(who, (byAsker.get(who) ?? 0) + s.usd);
  }
  return { total, byAsker };
}
