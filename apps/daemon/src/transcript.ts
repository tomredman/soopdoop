// ABOUTME: Reads Claude Code transcripts (JSONL) on this machine: the tail of the file, the conversation in it, the agent's
// ABOUTME: model and the one-line routing summary. Pure parsing, so it is tested. The summaries and the answering copy use it.
import { homedir } from "node:os";
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
  // The model of the agent's last reply, which an answering copy of the session uses too.
  model?: string;
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
    // "<synthetic>" marks a reply Claude Code wrote itself (an error, a cancelled turn), not a model's.
    if (role === "assistant" && typeof message.model === "string" && message.model !== "<synthetic>") parsed.model = message.model;
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

// Inside the agent's folder: the path from there. Anywhere else: only its last three parts, so a home folder or a user
// name never reaches the summary ("…/daemon/src/cli.ts").
export function shortPath(cwd: string | undefined, file: string, home: string = homedir()): string {
  if (cwd !== undefined && file.startsWith(cwd + "/")) return path.relative(cwd, file);
  if (!path.isAbsolute(file)) return file;
  const rest = file.startsWith(home + "/") ? path.relative(home, file) : file.slice(1);
  const parts = rest.split("/");
  return parts.length <= 3 ? parts.join("/") : `…/${parts.slice(-3).join("/")}`;
}

// "vibes@feat/x · "fix coupon rounding" · files: src/a.ts, src/b.ts", at most 600 characters.
export function routingSummary(parsed: Parsed, home: string = homedir()): string {
  const workspace = parsed.cwd === undefined ? undefined : path.basename(parsed.cwd);
  const where = workspace === undefined ? "" : `${workspace}${parsed.branch === undefined ? "" : `@${parsed.branch}`}`;
  const prompt = parsed.lastPrompt === undefined ? "" : `"${parsed.lastPrompt.slice(0, 160)}"`;
  const recent: string[] = [];
  for (let i = parsed.files.length - 1; i >= 0 && recent.length < 8; i--) {
    const file = parsed.files[i];
    if (file === undefined) continue;
    const short = shortPath(parsed.cwd, file, home);
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
