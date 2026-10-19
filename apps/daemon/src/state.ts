// ABOUTME: The daemon's in-memory picture of this machine's agents, built from harness hook events (Claude Code, Codex, Grok).
// ABOUTME: Pure functions so the state transitions are testable without a harness.
import { isPrivate } from "./privacy";

export type AgentStatus = "working" | "idle" | "waiting";

// The harnesses whose sessions soopdoop reads.
export type Harness = "claude-code" | "codex" | "grok";

export function toHarness(raw: unknown): Harness | undefined {
  return raw === "claude-code" || raw === "codex" || raw === "grok" ? raw : undefined;
}

export interface AgentRecord {
  agentId: string;
  harness: string;
  name: string;
  workspace?: string;
  status: AgentStatus;
  open: boolean;
  transcriptPath?: string;
  // The folder the session runs in, and the repository it belongs to. Both stay on this machine.
  cwd?: string;
  repo?: string;
  lastTurnAt: number;
  // How to reach the session later, for a hand-off. All stay on this machine: the Superset terminal and workspace it runs
  // in, Claude Code's inbox socket and its token, and Grok's session id.
  supersetTerminalId?: string;
  supersetWorkspaceId?: string;
  inboxSocket?: string;
  inboxToken?: string;
  grokSessionId?: string;
}

// The hook payload fields the daemon reads, in Claude Code's and Codex's spelling, plus what the hook adds.
export interface HookEvent {
  hook_event_name: string;
  session_id: string;
  cwd?: string;
  transcript_path?: string;
  // Notification hooks carry a message; "waiting" is inferred from it.
  message?: string;
  // UserPromptSubmit only: the hacker's prompt (its first 8,000 characters). The daemon scores it on this Mac for heads-ups
  // and drops it. It is never put on the agent, kept, logged or sent: toReport has no field for it.
  prompt?: string;
  // The harness that ran the hook (its command names it). Missing from older hooks, which were all Claude Code's.
  harness?: Harness;
  // From the hook's environment, when there. Kept on this machine (see AgentRecord).
  supersetTerminalId?: string;
  supersetWorkspaceId?: string;
  inboxSocket?: string;
  inboxToken?: string;
  grokSessionId?: string;
}

export type Subset = Map<string, AgentRecord>;

export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function text(x: unknown): string | undefined {
  return typeof x === "string" && x !== "" ? x : undefined;
}

// Grok names its events in snake_case ("pre_tool_use"); soopdoop uses the PascalCase names Claude Code and Codex use.
export function pascalEvent(raw: unknown): string | undefined {
  const name = text(raw);
  if (name === undefined) return undefined;
  return name
    .split("_")
    .map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); })
    .join("");
}

// Reads a hook payload off the wire. Only the event name and session id are required; the rest is optional. Grok's payload
// is camelCase (sessionId, hookEventName); Claude Code's and Codex's are snake_case. Returns null for anything that is not a
// usable event, so a stray POST can never poison the subset.
export function parseHookEvent(raw: unknown): HookEvent | null {
  if (!isRecord(raw)) return null;
  const event = text(raw.hook_event_name) ?? pascalEvent(raw.hookEventName);
  const sessionId = text(raw.session_id) ?? text(raw.sessionId);
  if (event === undefined || sessionId === undefined) return null;
  const ev: HookEvent = { hook_event_name: event, session_id: sessionId };
  if (typeof raw.cwd === "string") ev.cwd = raw.cwd;
  const transcript = text(raw.transcript_path) ?? text(raw.transcriptPath);
  if (transcript !== undefined) ev.transcript_path = transcript;
  if (typeof raw.message === "string") ev.message = raw.message;
  if (event === "UserPromptSubmit" && typeof raw.prompt === "string" && raw.prompt.trim() !== "") ev.prompt = raw.prompt;
  const harness = toHarness(raw.harness);
  if (harness !== undefined) ev.harness = harness;
  const terminal = text(raw.supersetTerminalId);
  if (terminal !== undefined) ev.supersetTerminalId = terminal;
  const workspace = text(raw.supersetWorkspaceId);
  if (workspace !== undefined) ev.supersetWorkspaceId = workspace;
  const socket = text(raw.inboxSocket);
  if (socket !== undefined) ev.inboxSocket = socket;
  const token = text(raw.inboxToken);
  if (token !== undefined) ev.inboxToken = token;
  const grokSession = text(raw.grokSessionId);
  if (grokSession !== undefined) ev.grokSessionId = grokSession;
  return ev;
}

function nameFromCwd(cwd: string | undefined): string {
  if (cwd === undefined || cwd === "") return "agent";
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "agent";
}

// Keeps the newest way to reach the session. A hook that does not see a value (Claude Code's SessionEnd has no inbox
// socket) leaves the one already known.
function keepLocal(agent: AgentRecord, ev: HookEvent): void {
  if (ev.supersetTerminalId !== undefined) agent.supersetTerminalId = ev.supersetTerminalId;
  if (ev.supersetWorkspaceId !== undefined) agent.supersetWorkspaceId = ev.supersetWorkspaceId;
  if (ev.inboxSocket !== undefined) agent.inboxSocket = ev.inboxSocket;
  if (ev.inboxToken !== undefined) agent.inboxToken = ev.inboxToken;
  if (ev.grokSessionId !== undefined) agent.grokSessionId = ev.grokSessionId;
}

// The status an event leaves the agent in, or null for events that change nothing (and "end" for the session's end).
function statusAfter(event: string): AgentStatus | "end" | null {
  switch (event) {
    case "SessionStart":
    case "Stop":
    case "StopFailure":
    case "StopCancelled":
    case "Interrupt":
      return "idle";
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse":
      return "working";
    case "Notification":
    case "PermissionRequest":
      return "waiting";
    case "SessionEnd":
      return "end";
    default:
      return null;
  }
}

// Applies one hook event. Returns true when the subset changed in a way worth reporting. `repoOf` names the repository a
// new agent's folder belongs to (git, in the daemon), so a private repository covers its worktrees too.
export function apply(
  subset: Subset,
  ev: HookEvent,
  now: number,
  privateDirs: string[] = [],
  repoOf: (cwd: string) => string | undefined = function () { return undefined; },
): boolean {
  const existing = subset.get(ev.session_id);
  const name = existing?.name ?? nameFromCwd(ev.cwd);
  const repo = existing === undefined && ev.cwd !== undefined ? repoOf(ev.cwd) : existing?.repo;
  const base: AgentRecord = existing ?? {
    agentId: ev.session_id,
    harness: ev.harness ?? "claude-code",
    name,
    workspace: nameFromCwd(ev.cwd),
    status: "idle",
    open: !isPrivate(ev.cwd, repo, privateDirs),
    lastTurnAt: now,
  };
  // A harness the hook names wins; a session first seen through an older hook (no name) was Claude Code's.
  const harnessChanged = ev.harness !== undefined && base.harness !== ev.harness;
  if (ev.harness !== undefined) base.harness = ev.harness;
  if (repo !== undefined) base.repo = repo;
  if (ev.transcript_path !== undefined) base.transcriptPath = ev.transcript_path;
  if (ev.cwd !== undefined) base.cwd = ev.cwd;
  keepLocal(base, ev);

  const next = statusAfter(ev.hook_event_name);
  if (next === "end") return subset.delete(ev.session_id);
  if (next === null) return harnessChanged;
  // Repeated tool use while working is not a change worth reporting.
  if (next === "working" && base.status === "working" && existing !== undefined) {
    subset.set(ev.session_id, { ...base, lastTurnAt: now });
    return harnessChanged;
  }
  subset.set(ev.session_id, { ...base, status: next, lastTurnAt: now });
  return true;
}

// Checks every agent against a changed privateDirs. Returns true when one turned private or open.
export function reapplyPrivacy(subset: Subset, privateDirs: string[]): boolean {
  let changed = false;
  for (const [id, a] of subset) {
    const open = !isPrivate(a.cwd, a.repo, privateDirs);
    if (open !== a.open) {
      subset.set(id, { ...a, open });
      changed = true;
    }
  }
  return changed;
}

// Drops agents that have not spoken for `staleMs`; a crashed harness never sends SessionEnd.
export function sweep(subset: Subset, now: number, staleMs: number): boolean {
  let changed = false;
  for (const [id, a] of subset) {
    if (now - a.lastTurnAt > staleMs) {
      subset.delete(id);
      changed = true;
    }
  }
  return changed;
}

// What leaves the machine: never the transcript path, the folder, the repository, or how to reach the session.
export function toReport(subset: Subset) {
  return Array.from(subset.values(), function (a) {
    return {
      agentId: a.agentId,
      harness: a.harness,
      name: a.name,
      workspace: a.workspace,
      status: a.status,
      open: a.open,
      lastTurnAt: a.lastTurnAt,
    };
  });
}
