// ABOUTME: One door to every harness's transcripts on this machine: find a session's file, read and parse it into one shape,
// ABOUTME: and build the routing summary from that shape. Claude Code, Codex and Grok each have their own reader beside this file.
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Glob } from "bun";
import { parseClaude } from "./claude";
import { parseCodex } from "./codex";
import { grokFolderName, grokSummary, parseGrok } from "./grok";
import { emptyParsed, type Parsed } from "./parsed";

export { emptyParsed, type Parsed, type Turn } from "./parsed";

export const SUMMARY_MAX = 600;

// Parses a transcript's text with its harness's reader. `into` carries what is already known about the session.
export function parseFor(harness: string, text: string, into: Parsed = emptyParsed()): Parsed {
  if (harness === "codex") return parseCodex(text, into);
  if (harness === "grok") return parseGrok(text, into);
  return parseClaude(text, into);
}

// Where each harness keeps its sessions: Claude Code's config folder (CLAUDE_CONFIG_DIR, else ~/.claude), Codex's
// (CODEX_HOME, else ~/.codex) and Grok's (GROK_HOME, else ~/.grok).
export interface Homes {
  claude: string;
  codex: string;
  grok: string;
}

function set(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

export function harnessHomes(env: Record<string, string | undefined> = process.env, home: string = homedir()): Homes {
  return {
    claude: set(env.CLAUDE_CONFIG_DIR) ?? path.join(home, ".claude"),
    codex: set(env.CODEX_HOME) ?? path.join(home, ".codex"),
    grok: set(env.GROK_HOME) ?? path.join(home, ".grok"),
  };
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function names(dir: string): Promise<string[]> {
  return await readdir(dir).catch(function () { return []; });
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// Codex session ids are UUIDv7: their first 48 bits are when the session started, in milliseconds. Its rollout sits in that
// day's folder (local time), so those days are looked at first, with the day either side for time zones.
export function codexDays(sessionId: string): string[] {
  const hex = sessionId.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex) || hex[12] !== "7") return [];
  const ms = parseInt(hex.slice(0, 12), 16);
  return [0, -1, 1].map(function (d) {
    const t = new Date(ms + d * 86_400_000);
    return `${t.getFullYear()}/${pad(t.getMonth() + 1)}/${pad(t.getDate())}`;
  });
}

async function findCodexRollout(codexHome: string, sessionId: string): Promise<string | null> {
  const sessions = path.join(codexHome, "sessions");
  const suffix = `-${sessionId}.jsonl`;
  for (const day of codexDays(sessionId)) {
    const hit = (await names(path.join(sessions, day))).find(function (n) { return n.startsWith("rollout-") && n.endsWith(suffix); });
    if (hit !== undefined) return path.join(sessions, day, hit);
  }
  try {
    for await (const file of new Glob(`*/*/*/rollout-*${suffix}`).scan({ cwd: sessions, absolute: true })) return file;
  } catch {
    // No sessions folder.
  }
  return null;
}

async function findGrokSession(grokHome: string, sessionId: string, cwd: string | undefined): Promise<string | null> {
  const sessions = path.join(grokHome, "sessions");
  if (cwd !== undefined) {
    const file = path.join(sessions, grokFolderName(cwd), sessionId, "chat_history.jsonl");
    if (await isFile(file)) return file;
  }
  // A long folder name is a slug and a hash, and a session can be looked for without its folder: every group.
  for (const group of await names(sessions)) {
    const file = path.join(sessions, group, sessionId, "chat_history.jsonl");
    if (await isFile(file)) return file;
  }
  return null;
}

async function findClaudeTranscript(claudeHome: string, sessionId: string, cwd: string | undefined): Promise<string | null> {
  const projects = path.join(claudeHome, "projects");
  if (cwd !== undefined) {
    // Claude Code names a project's folder after its path, every character but letters and digits made a dash.
    const file = path.join(projects, cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
    if (await isFile(file)) return file;
  }
  for (const folder of await names(projects)) {
    const file = path.join(projects, folder, `${sessionId}.jsonl`);
    if (await isFile(file)) return file;
  }
  return null;
}

// The file holding a session's conversation, or null. A transcript path the hook gave wins; otherwise each harness's own
// place is looked through: Codex by the session's day, Grok by its folder. Ids that are not plain ids are never looked up.
export async function findTranscript(
  harness: string,
  sessionId: string,
  cwd?: string,
  transcriptPath?: string,
  homes: Homes = harnessHomes(),
): Promise<string | null> {
  if (transcriptPath !== undefined && (await isFile(transcriptPath))) return transcriptPath;
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return null;
  if (harness === "codex") return await findCodexRollout(homes.codex, sessionId);
  if (harness === "grok") return await findGrokSession(homes.grok, sessionId, cwd);
  return await findClaudeTranscript(homes.claude, sessionId, cwd);
}

// The last maxBytes of a transcript. A missing file reads as empty.
export async function readTail(file: string, maxBytes: number): Promise<string> {
  const f = Bun.file(file);
  if (!(await f.exists())) return "";
  const size = f.size;
  return await f.slice(Math.max(0, size - maxBytes), size).text();
}

async function readHead(file: string, maxBytes: number): Promise<string> {
  const f = Bun.file(file);
  if (!(await f.exists())) return "";
  return await f.slice(0, Math.min(f.size, maxBytes)).text();
}

// Reads a session's transcript (its last maxBytes) into the one shape. A Codex rollout's first line is read too: it holds the
// folder and the branch, which a long rollout's tail no longer has. Grok's summary.json beside the chat history says the same.
export async function readTranscript(harness: string, file: string, maxBytes: number = 512_000): Promise<Parsed> {
  const into = emptyParsed();
  if (harness === "codex") parseCodex((await readHead(file, 256_000)).split("\n")[0] ?? "", into);
  if (harness === "grok") {
    const summary = grokSummary(await Bun.file(path.join(path.dirname(file), "summary.json")).json().catch(function () { return null; }));
    if (summary.cwd !== undefined) into.cwd = summary.cwd;
    if (summary.branch !== undefined) into.branch = summary.branch;
    if (summary.model !== undefined) into.model = summary.model;
  }
  return parseFor(harness, await readTail(file, maxBytes), into);
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
