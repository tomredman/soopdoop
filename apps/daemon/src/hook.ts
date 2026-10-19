// ABOUTME: What each harness hook runs (Claude Code, Codex, Grok): reads the hook payload on stdin and posts the few fields the
// ABOUTME: daemon uses. It never fails, drops replays by other tools, prints only the crew introduction at starts and prompts, and imports nothing heavy.
import { isRecord, parseHookEvent, toHarness, type Harness } from "./state";

const PORT = Number(process.env.SOOPDOOP_PORT ?? "47311");
// Events whose hook can add text to the session's context. The daemon may answer these with the crew's agents.
const SPEAKING = new Set(["SessionStart", "UserPromptSubmit"]);
// Harnesses that read a hook's additionalContext at those events. Grok ignores what those hooks print (its hooks guide).
const LISTENING = new Set<Harness>(["claude-code", "codex"]);

export type Env = Record<string, string | undefined>;

function value(env: Env, name: string): string | undefined {
  const v = env[name];
  return v === undefined || v === "" ? undefined : v;
}

// The harness running this hook, from SOOPDOOP_HARNESS in its command. Claude Code's hook commands never named one.
export function harnessOf(env: Env): Harness {
  return toHarness(value(env, "SOOPDOOP_HARNESS")) ?? "claude-code";
}

// Why this hook must stay quiet, or null when it may report. Other tools replay soopdoop's hooks: Cursor (and Devin) run
// Claude Code's, and Grok runs Claude Code's and Codex's. Claude Code sets CLAUDECODE for its hooks, so a Claude Code hook
// without it was run by something else. A Codex or Grok started from inside a Claude Code session is that session's helper,
// not a new agent. The daemon's own forks, which answer crewmates' questions, are never agents.
export function droppedBecause(harness: Harness, env: Env): string | null {
  if (value(env, "SOOPDOOP_FORK") !== undefined) return "a soopdoop fork";
  if (value(env, "CURSOR_AGENT") !== undefined || value(env, "CURSOR_VERSION") !== undefined) return "run by Cursor";
  if (harness !== "grok" && (value(env, "GROK_SESSION_ID") !== undefined || value(env, "GROK_HOOK_EVENT") !== undefined)) return "run by Grok";
  if (harness === "claude-code" && value(env, "CLAUDECODE") === undefined) return "not run by Claude Code";
  if (harness !== "claude-code" && value(env, "CLAUDECODE") !== undefined) return "inside a Claude Code session";
  return null;
}

// What the environment says about where the session runs, for hand-offs later. It goes to the daemon and stays there.
export function localFields(env: Env): Record<string, string> {
  const names: [string, string][] = [
    ["supersetTerminalId", "SUPERSET_TERMINAL_ID"],
    ["supersetWorkspaceId", "SUPERSET_WORKSPACE_ID"],
    ["inboxSocket", "CLAUDE_CODE_MESSAGING_SOCKET"],
    ["inboxToken", "CLAUDE_CODE_MESSAGING_TOKEN"],
    ["grokSessionId", "GROK_SESSION_ID"],
  ];
  const out: Record<string, string> = {};
  for (const [field, name] of names) {
    const v = value(env, name);
    if (v !== undefined) out[field] = v;
  }
  return out;
}

function printOut(text: string): void {
  process.stdout.write(text);
}

// Prompts and tool inputs stay out: only the event name, session id, cwd, transcript path, message and its type, harness,
// permission mode and the local fields above cross the socket. Grok's payload is camelCase (sessionId); Claude Code's and Codex's are snake_case.
export async function forwardHook(
  event: string,
  raw: string,
  port: number = PORT,
  write: (text: string) => void = printOut,
  env: Env = process.env,
): Promise<void> {
  try {
    const harness = harnessOf(env);
    if (droppedBecause(harness, env) !== null) return;
    const payload: unknown = raw.trim() === "" ? {} : JSON.parse(raw);
    const fields = isRecord(payload) ? payload : {};
    const ev = parseHookEvent({
      hook_event_name: event,
      session_id: fields.session_id ?? fields.sessionId ?? (harness === "grok" ? value(env, "GROK_SESSION_ID") : undefined),
      cwd: fields.cwd,
      transcript_path: fields.transcript_path ?? fields.transcriptPath,
      message: fields.message,
      notification_type: fields.notification_type ?? fields.notificationType,
      harness,
      permission_mode: fields.permission_mode ?? fields.permissionMode,
      ...localFields(env),
    });
    if (ev === null) return;
    const speaking = SPEAKING.has(event) && LISTENING.has(harness);
    const res = await fetch(`http://127.0.0.1:${port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ev),
      // A session's start can wait a moment for the crew; every other event is fire and forget.
      signal: AbortSignal.timeout(speaking ? 3_000 : 1_500),
    });
    if (!speaking || !(res.headers.get("content-type") ?? "").includes("application/json")) return;
    const reply: unknown = await res.json();
    if (!isRecord(reply) || typeof reply.context !== "string" || reply.context === "") return;
    // Claude Code and Codex add additionalContext to the session (Claude Code as a system reminder, Codex as developer context).
    write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: reply.context } }) + "\n");
  } catch {
    // The daemon is not running, or the payload was odd. The harness must never notice.
  }
}

if (import.meta.main) {
  await forwardHook(Bun.argv[2] ?? "", await Bun.stdin.text());
}
