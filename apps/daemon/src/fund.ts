// ABOUTME: The anti-hijacking fund: how much this Mac's agents may spend answering crewmates' questions in 24 hours, in all
// ABOUTME: and per crewmate, checked before each answer; and what one answer cost, from the usage Claude Code reports.
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { soopdoopHome } from "./config";
import { isRecord } from "./state";

// US dollars per million tokens, from Anthropic's API prices (October 2026): input, output and cache reads. A cache write
// costs 1.25 times input when it lasts 5 minutes, twice input when it lasts an hour. Longer names come first, so
// "claude-opus-5-5" is not priced as "claude-opus-5". A model not listed is priced like the dearest.
interface Price {
  input: number;
  output: number;
  cacheRead: number;
}
const PRICES: [string, Price][] = [
  ["claude-fable-5-1", { input: 10, output: 50, cacheRead: 0.25 }],
  ["claude-mythos-5-1", { input: 10, output: 50, cacheRead: 0.25 }],
  ["claude-fable-5", { input: 10, output: 50, cacheRead: 1 }],
  ["claude-opus-5-5", { input: 4, output: 20, cacheRead: 0.2 }],
  ["claude-opus-5", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-opus-4", { input: 5, output: 25, cacheRead: 0.5 }],
  ["claude-sonnet-5-5", { input: 2, output: 10, cacheRead: 0.2 }],
  ["claude-sonnet-5", { input: 2, output: 10, cacheRead: 0.2 }],
  ["claude-sonnet-4", { input: 3, output: 15, cacheRead: 0.3 }],
  ["claude-haiku-4-5", { input: 1, output: 5, cacheRead: 0.1 }],
];
const DEAREST: Price = { input: 10, output: 50, cacheRead: 1 };

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

// What one answer cost, from the answering copy's own usage. Claude Code's total_cost_usd is not used: after --resume it
// also counts everything the original session ever spent. The small side call Claude Code makes on a cheap model is left out.
export function answerCost(usage: Record<string, unknown>, model: string | undefined): number {
  const price = priceFor(model);
  const split = isRecord(usage.cache_creation) ? usage.cache_creation : {};
  const written = count(usage, "cache_creation_input_tokens");
  const hour = Math.min(written, count(split, "ephemeral_1h_input_tokens"));
  const dollars =
    count(usage, "input_tokens") * price.input +
    (written - hour) * price.input * 1.25 +
    hour * price.input * 2 +
    count(usage, "cache_read_input_tokens") * price.cacheRead +
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

// What reading this agent's conversation will cost with nothing cached, judged from the last time it was read. Zero
// when it has not been read yet, so the fund can run over by that one answer.
export function estimateCost(spends: Spend[], agentId: string): number {
  let last: Spend | undefined;
  for (const s of spends) if (s.agentId === agentId && s.tokensRead !== undefined && (last === undefined || s.at > last.at)) last = s;
  if (last?.tokensRead === undefined) return 0;
  const price = priceFor(last.model);
  return (last.tokensRead * price.input * 1.25 + ANSWER_TOKENS * price.output) / 1_000_000;
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
