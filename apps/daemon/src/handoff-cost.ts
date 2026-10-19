// ABOUTME: What a hand-off cost on this Mac: the usage of the agent's model calls since it started, read from its transcript
// ABOUTME: (Claude Code's message.usage per reply, Codex's token_count events) and priced with the fund's prices.
import { answerCost } from "./fund";
import { isRecord } from "./state";
import { readTail } from "./transcripts/index";

export interface Cost {
  usd: number;
  // How many model calls it counted.
  calls: number;
}

function timeOf(row: Record<string, unknown>): number {
  return typeof row.timestamp === "string" ? Date.parse(row.timestamp) : Number.NaN;
}

function rows(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row: unknown = JSON.parse(line);
      if (isRecord(row)) out.push(row);
    } catch {
      // The first line of a tail read is usually cut.
    }
  }
  return out;
}

// Claude Code writes a reply as one line per content block, each carrying the whole reply's usage, so each reply (its
// message id) is counted once. Replies Claude Code wrote itself ("<synthetic>": errors, "Not logged in") cost nothing.
export function claudeCostSince(text: string, since: number): Cost {
  const seen = new Set<string>();
  let usd = 0;
  let calls = 0;
  for (const row of rows(text)) {
    if (row.type !== "assistant" || !(timeOf(row) >= since) || !isRecord(row.message)) continue;
    const m = row.message;
    if (!isRecord(m.usage) || m.model === "<synthetic>") continue;
    const id = typeof m.id === "string" ? m.id : typeof row.requestId === "string" ? row.requestId : null;
    if (id !== null) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    usd += answerCost(m.usage, typeof m.model === "string" ? m.model : undefined);
    calls += 1;
  }
  return { usd, calls };
}

// Codex writes a token_count event after each model call; its last_token_usage is that call's usage (OpenAI's keys: cached
// tokens inside input_tokens). The model is the one the latest turn_context names.
export function codexCostSince(text: string, since: number): Cost {
  let model: string | undefined;
  let usd = 0;
  let calls = 0;
  for (const row of rows(text)) {
    const p = isRecord(row.payload) ? row.payload : null;
    if (p === null) continue;
    if (row.type === "turn_context" && typeof p.model === "string") model = p.model;
    if (row.type !== "event_msg" || p.type !== "token_count" || !(timeOf(row) >= since)) continue;
    const info = isRecord(p.info) ? p.info : null;
    if (info === null || !isRecord(info.last_token_usage)) continue;
    usd += answerCost(info.last_token_usage, model);
    calls += 1;
  }
  return { usd, calls };
}

// Null for a harness whose transcript this cannot price yet (Grok).
export function costSince(harness: string, text: string, since: number): Cost | null {
  if (harness === "codex") return codexCostSince(text, since);
  if (harness === "claude-code") return claudeCostSince(text, since);
  return null;
}

// Reads the end of the transcript: a hand-off's turns are its newest lines. Claude Code 2.1.30x also writes whole request
// bodies into the transcript, so the window is wide.
export async function handoffCost(harness: string, transcriptPath: string, since: number, maxBytes: number = 64_000_000): Promise<Cost | null> {
  return costSince(harness, await readTail(transcriptPath, maxBytes), since);
}
