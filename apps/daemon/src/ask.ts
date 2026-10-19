// ABOUTME: Asks one of this machine's agents a crewmate's question: a headless fork of its Claude Code, Codex or Grok session answers
// ABOUTME: from what the agent already knows. The fork has no tools or hooks, saves nothing, and leaves the live session as it was.
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { answerCost, tokensReadOf } from "./fund";
import { findClaude } from "./hooks";
import { findCodex } from "./hooks-codex";
import { findGrok } from "./hooks-grok";
import { isRecord, toHarness, type AgentRecord, type Harness } from "./state";
import { findTranscript, readTranscript } from "./transcripts/index";

export { findCodex } from "./hooks-codex";
export { findGrok } from "./hooks-grok";

export const NOT_FOUND = "NOT_FOUND";
// The fork is asked for five short sentences; anything longer is cut here.
export const MAX_ANSWER = 2_000;
// The relay expires 90 s after the question, and routing takes a few of those.
const ASK_TIMEOUT_MS = 70_000;
// What marks a running Claude Code, Grok or Superset session. The fork must start as its own session, not as part of one.
const SESSION_VARS = [
  "CLAUDECODE", "CLAUDE_PID", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_EXECPATH", "CLAUDE_CODE_CHILD_SESSION",
  "GROK_SESSION_ID", "GROK_HOOK_EVENT", "GROK_HOOK_NAME", "GROK_WORKSPACE_ROOT",
];
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

// Crewmates' questions to a Claude Code agent are answered on Claude Sonnet 5.5: it reads the conversation for half what
// Opus 5.5 does, and answering from what the agent already knows needs no more. A session on a cheaper model (Haiku) keeps
// its own. Codex and Grok copies run on the session's own model, which their conversations were written for.
export const ANSWER_MODEL = "claude-sonnet-5-5";

export function answerModel(sessionModel: string | undefined): string {
  return sessionModel?.startsWith("claude-haiku") === true ? sessionModel : ANSWER_MODEL;
}

// Grok's built-in tools (from its tool definitions, Grok 1.0.46), all taken from the fork, and "Agent" for subagents.
export const GROK_TOOLS = [
  "run_terminal_command", "read_file", "search_replace", "list_dir", "grep", "kill_command_or_subagent", "todo_write",
  "get_command_or_subagent_output", "spawn_subagent", "scheduler_create", "scheduler_delete", "scheduler_list", "monitor",
  "search_tool", "use_tool", "workflow", "enter_plan_mode", "exit_plan_mode", "ask_user_question", "send_feedback",
  "web_fetch", "image_gen", "image_edit", "image_to_video", "reference_to_video", "write", "Agent",
];

// The command line that asks a copy of the session one question.
//   Claude Code: resumes the session under a new id (--fork-session) and keeps nothing on disk. Safe mode drops hooks, MCP
//   servers and skills, so the fork never shows up as an agent or asks the Operator itself; --tools "" leaves it no tools.
//   The model is named, so the fund knows the price. The prompt goes last: --tools takes a list, so it is followed by a flag.
//   Codex: `codex exec fork` into a session that is never saved (--ephemeral), in a read-only sandbox, with hooks, the shell
//   and code mode switched off (`-c features.*=false`, which a newer Codex that renamed a feature ignores instead of
//   failing), without the user's config.toml (no MCP servers, notify program or plugins), at low effort, on the session's
//   own model. --skip-git-repo-check lets it run from the home folder when the session's folder is gone.
//   Grok: resumes the session as a new one (--fork-session), one turn, low effort, every built-in tool taken away. Grok
//   saves the fork; askAgent deletes it afterwards.
export function askArgs(harness: string, sessionId: string, question: string, model?: string): string[] {
  const prompt = askPrompt(question);
  if (harness === "codex") {
    return [
      "exec", "fork", sessionId, "--ephemeral", "--json", "--skip-git-repo-check", "--ignore-user-config",
      "-c", 'sandbox_mode="read-only"', "-c", "features.hooks=false", "-c", "features.shell_tool=false",
      "-c", "features.unified_exec=false", "-c", "features.code_mode_host=false", "-c", 'model_reasoning_effort="low"',
      ...(model === undefined ? [] : ["-m", model]), prompt,
    ];
  }
  if (harness === "grok") {
    return [
      "-p", prompt, "-r", sessionId, "--fork-session", "--output-format", "json", "--effort", "low", "--max-turns", "1",
      "--disallowed-tools", GROK_TOOLS.join(","), ...(model === undefined ? [] : ["-m", model]),
    ];
  }
  return [
    "-p", "--resume", sessionId, "--fork-session", "--no-session-persistence", "--safe-mode",
    "--tools", "", "--effort", "low", ...(model === undefined ? [] : ["--model", model]), "--output-format", "json",
    prompt,
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

// The command that forks a session of this harness, or null when it is not installed where soopdoop looks.
export function findBinary(harness: string): string | null {
  if (harness === "codex") return findCodex();
  if (harness === "grok") return findGrok();
  return findRealClaude();
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

// The variable that points a harness at the folder a session lives in, when that is not the harness's usual folder: Claude
// Code's CLAUDE_CONFIG_DIR, Codex's CODEX_HOME (<home>/sessions/YYYY/MM/DD/rollout-….jsonl) or Grok's GROK_HOME
// (<home>/sessions/<folder>/<id>/chat_history.jsonl).
export function homeVarFor(harness: string, transcriptPath: string | undefined, home: string = homedir()): Record<string, string> {
  if (transcriptPath === undefined) return {};
  if (harness === "codex") {
    const sessions = path.dirname(path.dirname(path.dirname(path.dirname(transcriptPath))));
    const dir = path.dirname(sessions);
    return path.basename(sessions) === "sessions" && dir !== path.join(home, ".codex") ? { CODEX_HOME: dir } : {};
  }
  if (harness === "grok") {
    const sessions = path.dirname(path.dirname(path.dirname(transcriptPath)));
    const dir = path.dirname(sessions);
    return path.basename(sessions) === "sessions" && dir !== path.join(home, ".grok") ? { GROK_HOME: dir } : {};
  }
  const configDir = configDirFor(transcriptPath, home);
  return configDir === undefined ? {} : { CLAUDE_CONFIG_DIR: configDir };
}

// The fork's environment: the daemon's, without the marks of a running session, with SOOPDOOP_FORK so that a harness that
// still runs hooks for it (Codex and Grok can) is never reported as an agent, and with the session's folder when it has one.
export function forkEnv(env: Record<string, string | undefined>, homeVars: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || SESSION_VARS.includes(key)) continue;
    if (SESSION_PREFIXES.some(function (p) { return key.startsWith(p); })) continue;
    out[key] = value;
  }
  return { ...out, ...homeVars, SOOPDOOP_FORK: "1" };
}

function cut(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// The answer, or "not found", with what it cost. `text` is the copy's reply.
function answered(text: string, usage: Record<string, unknown>, model: string | undefined): Asked {
  const spent = { tokensRead: tokensReadOf(usage), usd: answerCost(usage, model), ...(model === undefined ? {} : { model }) };
  const result = text.trim();
  if (result === "" || result.startsWith(NOT_FOUND)) return { refused: "It has not worked on this.", ...spent };
  return { answer: cut(result, MAX_ANSWER), ...spent };
}

// Claude Code's `--output-format json`: one object with the result, whether it failed, and the copy's usage.
function claudeResult(stdout: string, model: string | undefined): Asked {
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
  return answered(result, isRecord(raw.usage) ? raw.usage : {}, model);
}

// `codex exec --json`: one event per line. The copy's reply is its last agent_message; turn.completed carries the usage. Items
// of type "error" are warnings (a bypass notice, a switched-off feature); a failed turn or an error event is the failure.
function codexResult(stdout: string, model: string | undefined): Asked {
  let reply = "";
  let usage: Record<string, unknown> | null = null;
  let failure: string | null = null;
  for (const line of stdout.split("\n")) {
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(ev)) continue;
    if (ev.type === "item.completed" && isRecord(ev.item) && ev.item.type === "agent_message" && typeof ev.item.text === "string") reply = ev.item.text;
    if (ev.type === "turn.completed" && isRecord(ev.usage)) usage = ev.usage;
    if (ev.type === "turn.failed") failure = isRecord(ev.error) && typeof ev.error.message === "string" ? ev.error.message : "the turn failed";
    if (ev.type === "error" && typeof ev.message === "string") failure = ev.message;
  }
  if (failure !== null) {
    const spent = usage === null ? {} : { tokensRead: tokensReadOf(usage), usd: answerCost(usage, model), ...(model === undefined ? {} : { model }) };
    return { refused: `Could not ask that agent: ${cut(failure, 200)}`, ...spent };
  }
  if (usage === null) return { refused: "That agent gave no answer." };
  return answered(reply, usage, model);
}

// The first JSON object in some output: the whole of it, or its first line that is one.
function firstObject(stdout: string): Record<string, unknown> | null {
  for (const candidate of [stdout, ...stdout.split("\n")]) {
    try {
      const raw: unknown = JSON.parse(candidate);
      if (isRecord(raw)) return raw;
    } catch {
      // Not this one.
    }
  }
  return null;
}

// `grok --output-format json`: one object with the reply (text), the fork's session id, its usage (Claude's keys: input
// tokens without the cached ones, cache reads and writes apart) and the model under modelUsage; or { type: "error", message }.
function grokResult(stdout: string, model: string | undefined): Asked {
  const raw = firstObject(stdout);
  if (raw === null) return { refused: "That agent gave no answer." };
  if (raw.type === "error") {
    const why = typeof raw.message === "string" ? raw.message.split("\n")[0] ?? "" : "";
    return { refused: why === "" ? "Could not ask that agent." : `Could not ask that agent: ${cut(why, 200)}` };
  }
  const used = isRecord(raw.modelUsage) ? Object.keys(raw.modelUsage)[0] : undefined;
  if (!isRecord(raw.usage)) return { refused: "That agent gave no answer." };
  return answered(typeof raw.text === "string" ? raw.text : "", raw.usage, used ?? model);
}

// The fork's JSON result: the agent's answer, how many tokens it read and what that cost, or why there is none.
export function parseResult(harness: string, stdout: string, model?: string): Asked {
  if (harness === "codex") return codexResult(stdout, model);
  if (harness === "grok") return grokResult(stdout, model);
  return claudeResult(stdout, model);
}

// The id Grok gave the fork, so it can be deleted: Grok has no way to fork without saving.
export function grokForkId(stdout: string): string | null {
  const raw = firstObject(stdout);
  return raw !== null && typeof raw.sessionId === "string" && /^[A-Za-z0-9-]+$/.test(raw.sessionId) ? raw.sessionId : null;
}

async function spawnFork(cmd: string[], opts: { cwd: string; env: Record<string, string>; timeoutMs: number }): Promise<RunResult> {
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

function notInstalled(harness: Harness): string {
  const name = harness === "codex" ? "Codex" : harness === "grok" ? "Grok" : "Claude Code";
  return `${name} is not installed where soopdoop can find it on that machine.`;
}

// Asks the agent and waits for its answer. The caller checks that the agent is open. `binary` is the harness's command.
export async function askAgent(
  agent: AgentRecord,
  question: string,
  run: Run = spawnFork,
  binary: string | null = findBinary(agent.harness),
): Promise<Asked> {
  const harness = toHarness(agent.harness) ?? "claude-code";
  if (binary === null) return { refused: notInstalled(harness) };
  // Newer harnesses find a session from any folder; older ones look in the folder the session ran in.
  const cwd = agent.cwd !== undefined && (await isDirectory(agent.cwd)) ? agent.cwd : homedir();
  const transcript = agent.transcriptPath ?? (await findTranscript(harness, agent.agentId, agent.cwd)) ?? undefined;
  const sessionModel = transcript === undefined ? undefined : (await readTranscript(harness, transcript)).model;
  const model = harness === "claude-code" ? answerModel(sessionModel) : sessionModel;
  const env = forkEnv(process.env, homeVarFor(harness, transcript));
  // Grok resumes on the session's own model; the one its transcript names is only for the price.
  const result = await run([binary, ...askArgs(harness, agent.agentId, question, harness === "grok" ? undefined : model)], { cwd, env, timeoutMs: ASK_TIMEOUT_MS });
  if (harness === "grok") {
    const fork = grokForkId(result.stdout);
    if (fork !== null && fork !== agent.agentId) await run([binary, "sessions", "delete", fork], { cwd, env, timeoutMs: 15_000 }).catch(function () { return null; });
  }
  if (result.timedOut) return { refused: "That agent took too long to answer." };
  const asked = parseResult(harness, result.stdout, model);
  if ("refused" in asked && result.exitCode !== 0) {
    const why = result.stderr.trim().split("\n")[0] ?? "";
    if (why !== "") return { refused: `Could not ask that agent: ${cut(why, 200)}`, ...(asked.usd === undefined ? {} : { tokensRead: asked.tokensRead, usd: asked.usd, model: asked.model }) };
  }
  return asked;
}
