// ABOUTME: The daemon's in-memory picture of this machine's agents, built from harness hook events.
// ABOUTME: Pure functions so the state transitions are testable without a harness.
import { isPrivate } from "./privacy";

export type AgentStatus = "working" | "idle" | "waiting";

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
}

// The subset of Claude Code hook payload fields the daemon reads.
export interface HookEvent {
  hook_event_name: string;
  session_id: string;
  cwd?: string;
  transcript_path?: string;
  // Notification hooks carry a message; "waiting" is inferred from it.
  message?: string;
}

export type Subset = Map<string, AgentRecord>;

export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// Reads a hook payload off the wire. Only the event name and session id are required; the rest is optional.
// Returns null for anything that is not a usable event, so a stray POST can never poison the subset.
export function parseHookEvent(raw: unknown): HookEvent | null {
  if (!isRecord(raw)) return null;
  const event = raw.hook_event_name;
  const sessionId = raw.session_id;
  if (typeof event !== "string" || event === "") return null;
  if (typeof sessionId !== "string" || sessionId === "") return null;
  const ev: HookEvent = { hook_event_name: event, session_id: sessionId };
  if (typeof raw.cwd === "string") ev.cwd = raw.cwd;
  if (typeof raw.transcript_path === "string") ev.transcript_path = raw.transcript_path;
  if (typeof raw.message === "string") ev.message = raw.message;
  return ev;
}

function nameFromCwd(cwd: string | undefined): string {
  if (cwd === undefined || cwd === "") return "agent";
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "agent";
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
    harness: "claude-code",
    name,
    workspace: nameFromCwd(ev.cwd),
    status: "idle",
    open: !isPrivate(ev.cwd, repo, privateDirs),
    lastTurnAt: now,
  };
  if (repo !== undefined) base.repo = repo;
  if (ev.transcript_path !== undefined) base.transcriptPath = ev.transcript_path;
  if (ev.cwd !== undefined) base.cwd = ev.cwd;

  switch (ev.hook_event_name) {
    case "SessionStart":
      subset.set(ev.session_id, { ...base, status: "idle", lastTurnAt: now });
      return true;
    case "UserPromptSubmit":
    case "PreToolUse":
      if (base.status === "working" && existing !== undefined) {
        subset.set(ev.session_id, { ...base, lastTurnAt: now });
        return false;
      }
      subset.set(ev.session_id, { ...base, status: "working", lastTurnAt: now });
      return true;
    case "Stop":
      subset.set(ev.session_id, { ...base, status: "idle", lastTurnAt: now });
      return true;
    case "Notification":
      subset.set(ev.session_id, { ...base, status: "waiting", lastTurnAt: now });
      return true;
    case "SessionEnd":
      return subset.delete(ev.session_id);
    default:
      return false;
  }
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

// What leaves the machine: never the transcript path, the folder or the repository.
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
