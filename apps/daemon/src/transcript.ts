// ABOUTME: Reads Claude Code transcripts (JSONL) on this machine: the tail of the file, the conversation in it, and the
// ABOUTME: one-line routing summary. Pure parsing, so it is tested. Only the Operator's reads and summaries use it.
import path from "node:path";
import { isRecord } from "./state";

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

export interface Parsed {
  turns: Turn[];
  // Files the agent read or changed, oldest first.
  files: string[];
  lastPrompt?: string;
  cwd?: string;
  branch?: string;
}

const FILE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "Read", "NotebookEdit"]);
const MAX_TURN_CHARS = 4_000;

export const SUMMARY_MAX = 600;

// Turns, files and where the agent works. Skips thinking, tool output, side chains, harness notes and cut lines.
export function parseTranscript(text: string): Parsed {
  const parsed: Parsed = { turns: [], files: [] };
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      // The first line of a tail read is usually cut.
      continue;
    }
    if (!isRecord(row) || row.isMeta === true || row.isSidechain === true) continue;
    const role = row.type;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof row.cwd === "string") parsed.cwd = row.cwd;
    if (typeof row.gitBranch === "string" && row.gitBranch !== "" && row.gitBranch !== "HEAD") parsed.branch = row.gitBranch;
    const message = row.message;
    if (!isRecord(message)) continue;
    const texts: string[] = [];
    if (typeof message.content === "string") texts.push(message.content);
    else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!isRecord(block)) continue;
        if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
        if (role === "assistant" && block.type === "tool_use" && typeof block.name === "string" && FILE_TOOLS.has(block.name)) {
          const input = isRecord(block.input) ? block.input : {};
          const file = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : null;
          if (file !== null) {
            parsed.files.push(file);
            texts.push(`[${block.name} ${file}]`);
          }
        }
      }
    }
    for (const t of texts) {
      const clean = t.replace(/\s+/g, " ").trim();
      // Harness notes (<system-reminder>, <command-name>, …) are not the hacker's words.
      if (clean === "" || (role === "user" && clean.startsWith("<"))) continue;
      parsed.turns.push({ role, text: clean.length > MAX_TURN_CHARS ? `${clean.slice(0, MAX_TURN_CHARS)}…` : clean });
      if (role === "user") parsed.lastPrompt = clean;
    }
  }
  return parsed;
}

// The newest turns that fit in maxChars, oldest first, one "role: text" line each. What the Operator reads.
export function conversationSlice(parsed: Parsed, maxChars: number): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = parsed.turns.length - 1; i >= 0; i--) {
    const turn = parsed.turns[i];
    if (turn === undefined) continue;
    const line = `${turn.role}: ${turn.text}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.reverse().join("\n");
}

function relativeTo(cwd: string | undefined, file: string): string {
  if (cwd === undefined || !file.startsWith(cwd + "/")) return file;
  return path.relative(cwd, file);
}

// "vibes@feat/x · "fix coupon rounding" · files: src/a.ts, src/b.ts", at most 600 characters.
export function routingSummary(parsed: Parsed): string {
  const workspace = parsed.cwd === undefined ? undefined : path.basename(parsed.cwd);
  const where = workspace === undefined ? "" : `${workspace}${parsed.branch === undefined ? "" : `@${parsed.branch}`}`;
  const prompt = parsed.lastPrompt === undefined ? "" : `"${parsed.lastPrompt.slice(0, 160)}"`;
  const recent: string[] = [];
  for (let i = parsed.files.length - 1; i >= 0 && recent.length < 8; i--) {
    const file = parsed.files[i];
    if (file === undefined) continue;
    const short = relativeTo(parsed.cwd, file);
    if (!recent.includes(short)) recent.push(short);
  }
  const files = recent.length === 0 ? "" : `files: ${recent.join(", ")}`;
  return [where, prompt, files].filter(function (part) { return part !== ""; }).join(" · ").slice(0, SUMMARY_MAX);
}

// The last maxBytes of a transcript. A missing file reads as empty.
export async function readTail(file: string, maxBytes: number): Promise<string> {
  const f = Bun.file(file);
  if (!(await f.exists())) return "";
  const size = f.size;
  return await f.slice(Math.max(0, size - maxBytes), size).text();
}
