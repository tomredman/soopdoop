// ABOUTME: The daemon's in-memory picture of this machine's agents, built from harness hook events.
// ABOUTME: Pure functions so the state transitions are testable without a harness.

export type AgentStatus = "working" | "idle" | "waiting";

export interface AgentRecord {
  agentId: string;
  harness: string;
  name: string;
  workspace?: string;
  status: AgentStatus;
  open: boolean;
  transcriptPath?: string;
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

function nameFromCwd(cwd: string | undefined): string {
  if (cwd === undefined || cwd === "") return "agent";
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "agent";
}

function isPrivate(cwd: string | undefined, privateDirs: string[]): boolean {
  if (cwd === undefined) return false;
  return privateDirs.some(function (d) {
    return cwd === d || cwd.startsWith(d + "/");
  });
}

// Applies one hook event. Returns true when the subset changed in a way worth reporting.
export function apply(subset: Subset, ev: HookEvent, now: number, privateDirs: string[] = []): boolean {
  const existing = subset.get(ev.session_id);
  const name = existing?.name ?? nameFromCwd(ev.cwd);
  const base: AgentRecord = existing ?? {
    agentId: ev.session_id,
    harness: "claude-code",
    name,
    workspace: nameFromCwd(ev.cwd),
    status: "idle",
    open: !isPrivate(ev.cwd, privateDirs),
    lastTurnAt: now,
  };
  if (ev.transcript_path !== undefined) base.transcriptPath = ev.transcript_path;

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

// What leaves the machine: never the transcript path.
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
