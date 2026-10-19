// ABOUTME: Puts a hand-off's prompt in front of an agent running on this Mac, by the channels its harness has, tried in order:
// ABOUTME: Claude Code's inbox socket, Codex's queue, the Superset terminal it runs in, a stopped background session, the clipboard.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { findRealClaude, homeVarFor, sessionFreeEnv } from "./ask";
import { findCodex } from "./hooks-codex";
import { isRecord } from "./state";

export type Channel = "socket" | "superset" | "resume" | "codex-queue" | "clipboard";

// What the daemon knows about the agent a hand-off goes to. An agent that is not running on this Mac now has only its id
// and harness.
export interface Target {
  agentId: string;
  harness: string;
  // For the owner's notification.
  name?: string;
  permissionMode?: string;
  inboxSocket?: string;
  inboxToken?: string;
  supersetTerminalId?: string;
  supersetWorkspaceId?: string;
  transcriptPath?: string;
}

export interface Delivery {
  channel: Channel;
  // Claude Code holds a socket post to a session that bypasses permissions until its owner approves it there.
  held?: boolean;
  // For the hand-off's record (handoffs:started), when its owner has something to do.
  note?: string;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type Exec = (cmd: string[], opts: { env: Record<string, string>; stdin?: string; timeoutMs: number }) => Promise<ExecResult>;
// Posts the text into a session's inbox socket; rejects when there is no socket or it refuses the connection.
export type Post = (socket: string, token: string | undefined, text: string) => Promise<void>;

export interface DeliverDeps {
  exec: Exec;
  post: Post;
  // The commands, or null when not installed where soopdoop looks.
  claude: string | null;
  codex: string | null;
  superset: string | null;
  env: Record<string, string | undefined>;
}

// The two lines Claude Code's inbox socket takes, each ending in a newline: the auth line with the session's token
// (optional on macOS, required on Windows) and the message (cross-session messaging docs; the message line as in
// anthropics/claude-code#93720). The session reads it between tool calls, or starts a turn with it when idle.
export function socketLines(token: string | undefined, text: string): string {
  const lines: string[] = [];
  if (token !== undefined && token !== "") lines.push(JSON.stringify({ type: "auth", token }));
  lines.push(JSON.stringify({ type: "user", message: { role: "user", content: text } }));
  return lines.join("\n") + "\n";
}

// Claude Code closes a connection that sent no whole line in 30 seconds, so the lines go as soon as it opens; the
// connection stays a moment so the session reads them before it closes.
export async function postToSocket(socket: string, token: string | undefined, text: string, timeoutMs: number = 5_000): Promise<void> {
  if (!existsSync(socket)) throw new Error("no inbox socket");
  const bytes = new TextEncoder().encode(socketLines(token, text));
  await new Promise<void>(function (resolve, reject) {
    let settled = false;
    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolve();
      else reject(error);
    }
    const timer = setTimeout(function () { finish(new Error("the inbox socket did not answer")); }, timeoutMs);
    let sent = 0;
    function send(s: { write(data: Uint8Array): number; end(): void }): void {
      sent += Math.max(0, s.write(bytes.subarray(sent)));
      if (sent >= bytes.length) setTimeout(function () { s.end(); }, 300);
    }
    Bun.connect({
      unix: socket,
      socket: {
        open: send,
        drain: send,
        data() {},
        close() { finish(sent >= bytes.length ? undefined : new Error("the inbox socket closed early")); },
        error(_s, e) { finish(e); },
      },
    }).catch(function (e: unknown) {
      finish(e instanceof Error ? e : new Error(String(e)));
    });
  });
}

async function spawnCommand(cmd: string[], opts: { env: Record<string, string>; stdin?: string; timeoutMs: number }): Promise<ExecResult> {
  const proc = Bun.spawn(cmd, {
    env: opts.env,
    stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
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

// The superset command: on PATH (its own shim in ~/.superset/bin is the CLI), else in ~/.superset/bin, else in the app.
export function findSuperset(home: string = homedir(), pathVar: string = process.env.PATH ?? "", extra: string[] = ["/Applications/Superset.app/Contents/Resources/resources/bin/superset"]): string | null {
  const dirs = pathVar.split(":").filter(function (d) { return d !== ""; });
  const places = [...dirs.map(function (d) { return path.join(d, "superset"); }), path.join(home, ".superset", "bin", "superset"), ...extra];
  return places.find(function (p) { return existsSync(p); }) ?? null;
}

export function defaultDeliverDeps(): DeliverDeps {
  return { exec: spawnCommand, post: postToSocket, claude: findRealClaude(), codex: findCodex(), superset: findSuperset(), env: process.env };
}

// The channels for an agent running here, in order. Claude Code holds a socket post to a session that bypasses
// permission prompts for its owner's approval (a dialog in the session, gone after five minutes), so such a session in a
// Superset terminal gets the prompt typed there first, where it runs as its owner's own prompt.
export function channelsFor(target: Target): Channel[] {
  if (target.harness === "codex") return ["codex-queue", "superset", "clipboard"];
  if (target.harness === "grok") return ["superset", "clipboard"];
  const inSuperset = target.supersetTerminalId !== undefined && target.supersetWorkspaceId !== undefined;
  if (target.permissionMode === "bypassPermissions" && inSuperset) return ["superset", "socket", "resume", "clipboard"];
  return ["socket", "superset", "resume", "clipboard"];
}

// The channels for an agent that is not running on this Mac now: a stopped Claude Code background session wakes with it,
// and Codex keeps a queued message until the session opens again. Nothing else reaches a session that is not running.
export function awayChannelsFor(harness: string): Channel[] {
  if (harness === "codex") return ["codex-queue"];
  if (harness === "claude-code") return ["resume"];
  return [];
}

function firstLine(s: string): string {
  return s.trim().split("\n")[0]?.slice(0, 160) ?? "";
}

function failure(what: string, res: ExecResult): string {
  if (res.timedOut) return `${what} took too long`;
  const err = firstLine(res.stderr);
  const why = err === "" ? firstLine(res.stdout) : err;
  return why === "" ? `${what} exited with ${String(res.exitCode)}` : `${what}: ${why}`;
}

// A terminal takes Enter as "send", so the text goes as one line.
export function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

// Whether `claude agents --json --all` lists the session as a background one, and whether its process runs now.
export function backgroundState(json: string, sessionId: string): "running" | "stopped" | null {
  let rows: unknown;
  try {
    rows = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  const row = rows.find(function (r) { return isRecord(r) && r.sessionId === sessionId && r.kind === "background"; });
  if (!isRecord(row)) return null;
  return typeof row.pid === "number" ? "running" : "stopped";
}

// AppleScript's string quoting.
function appleString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

export function notificationScript(text: string): string {
  return `display notification ${appleString(text)} with title "soopdoop"`;
}

async function notify(deps: DeliverDeps, text: string): Promise<void> {
  await deps.exec(["/usr/bin/osascript", "-e", notificationScript(text)], { env: sessionFreeEnv(deps.env), timeoutMs: 10_000 }).catch(function () { return null; });
}

function agentName(target: Target): string {
  return target.name === undefined ? "agent" : `${target.name} agent`;
}

// Each channel: null when the prompt reached the agent, else why not.
async function viaSocket(target: Target, prompt: string, deps: DeliverDeps): Promise<string | null> {
  if (target.inboxSocket === undefined) return "no inbox socket known";
  try {
    await deps.post(target.inboxSocket, target.inboxToken, prompt);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function viaSuperset(target: Target, prompt: string, deps: DeliverDeps): Promise<string | null> {
  if (target.supersetTerminalId === undefined || target.supersetWorkspaceId === undefined) return "not in a Superset terminal";
  if (deps.superset === null) return "the superset command is not installed";
  const cmd = [deps.superset, "terminals", "send", "--local", "--workspace", target.supersetWorkspaceId, "--terminal", target.supersetTerminalId, "--text", oneLine(prompt)];
  const res = await deps.exec(cmd, { env: sessionFreeEnv(deps.env), timeoutMs: 30_000 });
  return res.exitCode === 0 && !res.timedOut ? null : failure("superset terminals send", res);
}

// A background session keeps the options it started with: `--resume <id> --bg <prompt>` with no other flag wakes it in
// place, and the prompt is its next turn (Claude Code 2.1.303). While it runs, the same command would start a copy instead.
async function viaResume(target: Target, prompt: string, deps: DeliverDeps): Promise<string | null> {
  if (deps.claude === null) return "claude is not installed";
  const env = sessionFreeEnv(deps.env, homeVarFor("claude-code", target.transcriptPath));
  const list = await deps.exec([deps.claude, "agents", "--json", "--all"], { env, timeoutMs: 30_000 });
  if (list.exitCode !== 0 || list.timedOut) return failure("claude agents", list);
  const state = backgroundState(list.stdout, target.agentId);
  if (state === null) return "not a background session";
  if (state === "running") return "its background session is running";
  const res = await deps.exec([deps.claude, "--resume", target.agentId, "--bg", prompt], { env, timeoutMs: 120_000 });
  return res.exitCode === 0 && !res.timedOut ? null : failure("claude --resume --bg", res);
}

// `codex queue` runs the message as the session's next turn: at once in an idle Codex session, after the running turn,
// or when the session is next opened (Codex 0.160.0).
async function viaCodexQueue(target: Target, prompt: string, deps: DeliverDeps): Promise<string | null> {
  if (deps.codex === null) return "codex is not installed";
  const env = sessionFreeEnv(deps.env, homeVarFor("codex", target.transcriptPath));
  const res = await deps.exec([deps.codex, "queue", "--thread", target.agentId, "--message", prompt], { env, timeoutMs: 30_000 });
  return res.exitCode === 0 && !res.timedOut ? null : failure("codex queue", res);
}

async function viaClipboard(target: Target, prompt: string, fromHandle: string, deps: DeliverDeps): Promise<string | null> {
  // pbcopy reads its input in the locale's encoding, and launchd sets none.
  const env = { ...sessionFreeEnv(deps.env), LANG: deps.env.LANG ?? "en_US.UTF-8" };
  const res = await deps.exec(["/usr/bin/pbcopy"], { env, stdin: prompt, timeoutMs: 10_000 });
  if (res.exitCode !== 0 || res.timedOut) return failure("pbcopy", res);
  await notify(deps, `A hand-off from @${fromHandle} is on your clipboard: paste it into your ${agentName(target)}.`);
  return null;
}

// Tries the channels in order and says which one reached the agent, or why none did.
export async function deliver(target: Target, prompt: string, fromHandle: string, deps: DeliverDeps, channels: Channel[] = channelsFor(target)): Promise<Delivery | { failed: string }> {
  const reasons: string[] = [];
  for (const channel of channels) {
    let why: string | null;
    if (channel === "socket") why = await viaSocket(target, prompt, deps);
    else if (channel === "superset") why = await viaSuperset(target, prompt, deps);
    else if (channel === "resume") why = await viaResume(target, prompt, deps);
    else if (channel === "codex-queue") why = await viaCodexQueue(target, prompt, deps);
    else why = await viaClipboard(target, prompt, fromHandle, deps);
    if (why !== null) {
      reasons.push(`${channel}: ${why}`);
      continue;
    }
    if (channel === "clipboard") return { channel, note: "It is on the receiver's clipboard, to paste into their agent." };
    if (channel === "socket" && target.harness === "claude-code" && target.permissionMode === "bypassPermissions") {
      await notify(deps, `A hand-off from @${fromHandle} is waiting in your ${agentName(target)}: approve the held message there to run it.`);
      return { channel, held: true, note: "It is waiting for the receiver to approve it in their session." };
    }
    return { channel };
  }
  return { failed: reasons.length === 0 ? "no way to reach it" : reasons.join("; ") };
}
