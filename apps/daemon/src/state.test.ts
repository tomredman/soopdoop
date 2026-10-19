import { describe, expect, test } from "bun:test";
import { apply, parseHookEvent, sweep, toReport } from "./state";

describe("subset state", function () {
  test("a session starts idle, works on a prompt, idles on Stop, leaves on SessionEnd", function () {
    const s = new Map();
    expect(apply(s, { hook_event_name: "SessionStart", session_id: "a", cwd: "/repo/vibes" }, 1)).toBe(true);
    expect(s.get("a")?.status).toBe("idle");
    expect(s.get("a")?.name).toBe("vibes");
    expect(apply(s, { hook_event_name: "UserPromptSubmit", session_id: "a" }, 2)).toBe(true);
    expect(s.get("a")?.status).toBe("working");
    // Repeated tool use while working is not a change worth reporting.
    expect(apply(s, { hook_event_name: "PreToolUse", session_id: "a" }, 3)).toBe(false);
    expect(apply(s, { hook_event_name: "Stop", session_id: "a" }, 4)).toBe(true);
    expect(s.get("a")?.status).toBe("idle");
    expect(apply(s, { hook_event_name: "SessionEnd", session_id: "a" }, 5)).toBe(true);
    expect(s.size).toBe(0);
  });

  test("a private directory makes the agent closed, and the transcript path never leaves", function () {
    const s = new Map();
    apply(s, { hook_event_name: "SessionStart", session_id: "t", cwd: "/home/me/taxes", transcript_path: "/home/me/.claude/x.jsonl" }, 1, ["/home/me/taxes"]);
    expect(s.get("t")?.open).toBe(false);
    expect(s.get("t")?.transcriptPath).toBe("/home/me/.claude/x.jsonl");
    const r = toReport(s)[0];
    expect(r).toBeDefined();
    expect(Object.keys(r ?? {})).not.toContain("transcriptPath");
  });

  test("sweep removes agents that went silent", function () {
    const s = new Map();
    apply(s, { hook_event_name: "SessionStart", session_id: "old" }, 0);
    apply(s, { hook_event_name: "SessionStart", session_id: "new" }, 50_000);
    expect(sweep(s, 60_000, 30_000)).toBe(true);
    expect(Array.from(s.keys())).toEqual(["new"]);
  });

  test("parseHookEvent keeps only the fields the daemon reads and rejects junk", function () {
    expect(parseHookEvent({ hook_event_name: "Stop", session_id: "s", cwd: "/r", transcript_path: "/t", message: "m", extra: 1 })).toEqual({
      hook_event_name: "Stop", session_id: "s", cwd: "/r", transcript_path: "/t", message: "m",
    });
    expect(parseHookEvent({ hook_event_name: "Stop" })).toBeNull();
    expect(parseHookEvent({ session_id: "s" })).toBeNull();
    expect(parseHookEvent({ hook_event_name: "Stop", session_id: "s", cwd: 5 })).toEqual({ hook_event_name: "Stop", session_id: "s" });
    expect(parseHookEvent("nope")).toBeNull();
    expect(parseHookEvent(null)).toBeNull();
  });

  test("a prompt is read at UserPromptSubmit only, and never lands on the agent or in the report", function () {
    const ev = parseHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "s", cwd: "/r/vibes", prompt: "fix the bounces" });
    expect(ev?.prompt).toBe("fix the bounces");
    expect(parseHookEvent({ hook_event_name: "Stop", session_id: "s", prompt: "fix the bounces" })?.prompt).toBeUndefined();
    const s = new Map();
    if (ev !== null) apply(s, ev, 1);
    expect(JSON.stringify([...s.values()])).not.toContain("bounces");
    expect(JSON.stringify(toReport(s))).not.toContain("bounces");
  });

  test("parseHookEvent takes Grok's camelCase payload and the harness and local fields the hook adds", function () {
    // Grok's own event names are snake_case; Claude's PascalCase name rides hook_event_name when Grok sends it.
    expect(parseHookEvent({ hookEventName: "pre_tool_use", sessionId: "g1", cwd: "/r", workspaceRoot: "/r" })).toEqual({
      hook_event_name: "PreToolUse", session_id: "g1", cwd: "/r",
    });
    expect(parseHookEvent({ hookEventName: "session_end", hook_event_name: "SessionEnd", sessionId: "g1" })?.hook_event_name).toBe("SessionEnd");
    expect(parseHookEvent({ hook_event_name: "Stop", sessionId: "g1", transcriptPath: "/t" })).toEqual({ hook_event_name: "Stop", session_id: "g1", transcript_path: "/t" });
    expect(parseHookEvent({
      hook_event_name: "Stop", session_id: "s", harness: "codex", supersetTerminalId: "t1", supersetWorkspaceId: "w1",
      inboxSocket: "/tmp/1.sock", inboxToken: "tok", grokSessionId: "",
    })).toEqual({
      hook_event_name: "Stop", session_id: "s", harness: "codex", supersetTerminalId: "t1", supersetWorkspaceId: "w1", inboxSocket: "/tmp/1.sock", inboxToken: "tok",
    });
    // An unknown harness is not one; a null transcript path (Codex's, sometimes) is none.
    expect(parseHookEvent({ hook_event_name: "Stop", session_id: "s", harness: "cursor", transcript_path: null })).toEqual({ hook_event_name: "Stop", session_id: "s" });
  });

  test("an agent takes its harness from the event, Claude Code when an older hook says nothing", function () {
    const s = new Map();
    apply(s, { hook_event_name: "SessionStart", session_id: "c", cwd: "/r/vibes", harness: "codex" }, 1);
    apply(s, { hook_event_name: "SessionStart", session_id: "g", cwd: "/r/vibes", harness: "grok" }, 1);
    apply(s, { hook_event_name: "SessionStart", session_id: "o", cwd: "/r/vibes" }, 1);
    expect(toReport(s).map(function (a) { return [a.agentId, a.harness]; })).toEqual([["c", "codex"], ["g", "grok"], ["o", "claude-code"]]);
    // A harness that changes is worth reporting, even on an event that changes nothing else.
    expect(apply(s, { hook_event_name: "SubagentStart", session_id: "o", harness: "codex" }, 2)).toBe(true);
    expect(s.get("o")?.harness).toBe("codex");
  });

  test("Codex's and Grok's own events: a permission request waits, an interrupt or a cancelled turn is idle", function () {
    const s = new Map();
    apply(s, { hook_event_name: "UserPromptSubmit", session_id: "c", harness: "codex" }, 1);
    expect(apply(s, { hook_event_name: "PermissionRequest", session_id: "c", harness: "codex" }, 2)).toBe(true);
    expect(s.get("c")?.status).toBe("waiting");
    apply(s, { hook_event_name: "PreToolUse", session_id: "c", harness: "codex" }, 3);
    expect(apply(s, { hook_event_name: "Interrupt", session_id: "c", harness: "codex" }, 4)).toBe(true);
    expect(s.get("c")?.status).toBe("idle");
    apply(s, { hook_event_name: "PostToolUse", session_id: "g", harness: "grok" }, 5);
    expect(s.get("g")?.status).toBe("working");
    apply(s, { hook_event_name: "StopCancelled", session_id: "g", harness: "grok" }, 6);
    expect(s.get("g")?.status).toBe("idle");
    apply(s, { hook_event_name: "StopFailure", session_id: "g", harness: "grok" }, 7);
    expect(s.get("g")?.status).toBe("idle");
  });

  test("keeps how to reach a session on this Mac, newest first, and never reports it", function () {
    const s = new Map();
    apply(s, { hook_event_name: "SessionStart", session_id: "a", inboxSocket: "/tmp/1.sock", inboxToken: "tok", supersetTerminalId: "t1", supersetWorkspaceId: "w1" }, 1);
    // Claude Code's SessionEnd comes without the socket; a Stop without it keeps the one known.
    apply(s, { hook_event_name: "Stop", session_id: "a" }, 2);
    expect(s.get("a")).toMatchObject({ inboxSocket: "/tmp/1.sock", inboxToken: "tok", supersetTerminalId: "t1", supersetWorkspaceId: "w1" });
    apply(s, { hook_event_name: "UserPromptSubmit", session_id: "a", inboxSocket: "/tmp/2.sock" }, 3);
    expect(s.get("a")?.inboxSocket).toBe("/tmp/2.sock");
    apply(s, { hook_event_name: "SessionStart", session_id: "g", harness: "grok", grokSessionId: "g" }, 4);
    const report = JSON.stringify(toReport(s));
    for (const local of ["inboxSocket", "inboxToken", "supersetTerminalId", "supersetWorkspaceId", "grokSessionId", "sock", "tok", "t1", "w1"]) {
      expect(report).not.toContain(local);
    }
  });
});
