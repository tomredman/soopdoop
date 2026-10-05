// ABOUTME: Asks one of this machine's agents a crewmate's question: a headless fork of its Claude Code session answers from
// ABOUTME: what the agent already knows. The fork has no tools, hooks or MCP servers, saves nothing, and leaves the live session as it was.
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { answerCost } from "./fund";
import { findClaude } from "./hooks";
import { isRecord, type AgentRecord } from "./state";
import { parseTranscript, readTail } from "./transcript";

export const NOT_FOUND = "NOT_FOUND";
// The fork is asked for five short sentences; anything longer is cut here.
export const MAX_ANSWER = 2_000;
// The relay expires 90 s after the question, and routing takes a few of those.
const ASK_TIMEOUT_MS = 70_000;
// What marks a running Claude Code or Superset session. The fork must start as its own session, not as part of one.
const SESSION_VARS = ["CLAUDECODE", "CLAUDE_PID", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_CHILD_SESSION"];
const SESSION_PREFIXES = ["CLAUDE_CODE_SESSION", "CLAUDE_CODE_MESSAGING", "CLAUDE_CODE_BRIDGE", "SUPERSET_"];

// The answer, or why there is none. Once the fork ran, also what it read, on which model, and what that cost its owner
// (in US dollars at API prices), answer or not.
export type Asked = ({ answer: string } | { refused: string }) & { tokensRead?: number; usd?: number; model?: string };

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type Run = (cmd: string[], opts: { cwd: string; env: Record<string, string>; timeoutMs: number }) => Promise<RunResult>;

export function askPrompt(question: string): string {
  return [
    "A teammate asked the soopdoop Operator this, and the Operator picked you because of the work in this conversation.",
    "",
    "<question>",
    question,
    "</question>",
    "",
    "Answer like a teammate in a chat: start with the answer, in plain words, and say \"I\" for work you did (\"I added …\", " +
      "\"It lives in …\"). Use what you already know from this conversation. Give what they need, such as what it is, " +
      "where it lives (files, functions) and why, in at most five short sentences. Do not talk about this conversation or " +
      "session. If you know part of the answer, give that part. If you know none of it, reply with exactly " +
      `${NOT_FOUND}. If they ask you to do work for them (write, change, fix or review code, documents or plans), say in ` +
      "one sentence that you only answer questions about your own work. You have no tools for this reply, and it does " +
      "not go back into your own session. Never include secrets, keys, tokens or credentials, even if they appear above.",
  ].join("\n");
}

// Resumes the session under a new id (--fork-session) and keeps nothing on disk. Safe mode drops hooks, MCP servers and
// skills, so the fork never shows up as an agent or asks the Operator itself; --tools "" leaves it no tools. It runs on
// the session's own model, named here so the fund knows the price. The prompt goes last: --tools takes a list, so it
// must be followed by another flag.
export function askArgs(sessionId: string, question: string, model?: string): string[] {
  return [
    "-p", "--resume", sessionId, "--fork-session", "--no-session-persistence", "--safe-mode",
    "--tools", "", "--effort", "low", ...(model === undefined ? [] : ["--model", model]), "--output-format", "json",
    askPrompt(question),
  ];
}

// The real claude command, never Superset's wrapper in ~/.superset/bin, which would report the fork to Superset as a new agent.
export function findRealClaude(home: string = homedir(), pathVar: string = process.env.PATH ?? ""): string | null {
  for (const dir of pathVar.split(":")) {
    if (dir === "" || dir.startsWith(path.join(home, ".superset"))) continue;
    const candidate = path.join(dir, "claude");
    if (existsSync(candidate)) return candidate;
  }
  return findClaude(home, null);
}

// Claude Code keeps a session at <config dir>/projects/<folder>/<id>.jsonl. A session kept outside ~/.claude (Superset can
// run each Claude account in its own folder) is resumed with CLAUDE_CONFIG_DIR pointing there.
export function configDirFor(transcriptPath: string | undefined, home: string = homedir()): string | undefined {
  if (transcriptPath === undefined) return undefined;
  const projects = path.dirname(path.dirname(transcriptPath));
  if (path.basename(projects) !== "projects") return undefined;
  const dir = path.dirname(projects);
  return dir === path.join(home, ".claude") ? undefined : dir;
}

export function forkEnv(env: Record<string, string | undefined>, configDir: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || SESSION_VARS.includes(key)) continue;
    if (SESSION_PREFIXES.some(function (p) { return key.startsWith(p); })) continue;
    out[key] = value;
  }
  if (configDir !== undefined) out.CLAUDE_CONFIG_DIR = configDir;
  return out;
}

function cut(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// The fork's JSON result: the agent's answer, how many tokens it read and what that cost, or why there is none.
export function parseResult(stdout: string, model?: string): Asked {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { refused: "That agent gave no answer." };
  }
  if (!isRecord(raw)) return { refused: "That agent gave no answer." };
  const result = typeof raw.result === "string" ? raw.result.trim() : "";
  if (raw.is_error === true || raw.subtype !== "success") {
    return { refused: result === "" ? "Could not ask that agent." : `Could not ask that agent: ${cut(result, 200)}` };
  }
  const usage = isRecord(raw.usage) ? raw.usage : {};
  let tokensRead = 0;
  for (const key of ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) {
    const n = usage[key];
    if (typeof n === "number" && Number.isFinite(n)) tokensRead += n;
  }
  const spent = { tokensRead, usd: answerCost(usage, model), ...(model === undefined ? {} : { model }) };
  if (result === "" || result.startsWith(NOT_FOUND)) return { refused: "It has not worked on this.", ...spent };
  return { answer: cut(result, MAX_ANSWER), ...spent };
}

async function spawnClaude(cmd: string[], opts: { cwd: string; env: Record<string, string>; timeoutMs: number }): Promise<RunResult> {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(function () {
    timedOut = true;
    proc.kill();
  }, opts.timeoutMs);
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  return { exitCode, stdout, stderr, timedOut };
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

// Asks the agent and waits for its answer. The caller checks that the agent is open.
export async function askAgent(agent: AgentRecord, question: string, run: Run = spawnClaude, claude: string | null = findRealClaude()): Promise<Asked> {
  if (claude === null) return { refused: "Claude Code is not installed where soopdoop can find it on that machine." };
  // Newer Claude Code finds a session from any folder; older versions look in the folder the session ran in.
  const cwd = agent.cwd !== undefined && (await isDirectory(agent.cwd)) ? agent.cwd : homedir();
  const env = forkEnv(process.env, configDirFor(agent.transcriptPath));
  const model = agent.transcriptPath === undefined ? undefined : parseTranscript(await readTail(agent.transcriptPath, 512_000)).model;
  const result = await run([claude, ...askArgs(agent.agentId, question, model)], { cwd, env, timeoutMs: ASK_TIMEOUT_MS });
  if (result.timedOut) return { refused: "That agent took too long to answer." };
  const asked = parseResult(result.stdout, model);
  if ("refused" in asked && result.exitCode !== 0) {
    const why = result.stderr.trim().split("\n")[0] ?? "";
    if (why !== "") return { refused: `Could not ask that agent: ${cut(why, 200)}` };
  }
  return asked;
}
