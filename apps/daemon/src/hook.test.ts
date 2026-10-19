import { afterAll, describe, expect, test } from "bun:test";
import { droppedBecause, forwardHook, harnessOf, localFields } from "./hook";

const received: unknown[] = [];
// What the stand-in daemon answers: plain "ok", or the crew introduction as JSON.
let reply: Response | (() => Response) = function () { return new Response("ok"); };
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    received.push(await req.json());
    return typeof reply === "function" ? reply() : reply;
  },
});

afterAll(function () {
  server.stop(true);
});

// The environment Claude Code gives its hooks (seen with Claude Code 2.1.303): CLAUDECODE is always set.
const CLAUDE = { CLAUDECODE: "1" };
function none(): void {}

describe("forwardHook", function () {
  test("sends only the fields the daemon reads: the prompt at UserPromptSubmit only, never tool input", async function () {
    received.length = 0;
    const payload = { session_id: "s1", cwd: "/r/vibes", transcript_path: "/t.jsonl", prompt: "fix the bounces", tool_input: { command: "rm -rf /" } };
    await forwardHook("UserPromptSubmit", JSON.stringify(payload), server.port, none, CLAUDE);
    // Another event's payload never brings a prompt along.
    await forwardHook("Stop", JSON.stringify(payload), server.port, none, CLAUDE);
    expect(received).toEqual([
      { hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/r/vibes", transcript_path: "/t.jsonl", harness: "claude-code", prompt: "fix the bounces" },
      { hook_event_name: "Stop", session_id: "s1", cwd: "/r/vibes", transcript_path: "/t.jsonl", harness: "claude-code" },
    ]);
  });

  test("a long prompt is cut to its first 8,000 characters; Codex's prompt comes the same way", async function () {
    received.length = 0;
    await forwardHook("UserPromptSubmit", JSON.stringify({ session_id: "s1", prompt: "x".repeat(20_000) }), server.port, none, CLAUDE);
    await forwardHook("UserPromptSubmit", JSON.stringify({ session_id: "c1", turn_id: "t1", prompt: "add coupon codes" }), server.port, none, { SOOPDOOP_HARNESS: "codex" });
    expect((received[0] as { prompt: string }).prompt).toHaveLength(8_000);
    expect(received[1]).toEqual({ hook_event_name: "UserPromptSubmit", session_id: "c1", harness: "codex", prompt: "add coupon codes" });
  });

  test("passes on a notification's message and type, and the permission mode", async function () {
    received.length = 0;
    const payload = { session_id: "s1", message: "Claude is waiting for your input", notification_type: "idle_prompt", permission_mode: "bypassPermissions" };
    await forwardHook("Notification", JSON.stringify(payload), server.port, none, CLAUDE);
    expect(received).toEqual([{
      hook_event_name: "Notification", session_id: "s1", message: "Claude is waiting for your input", notificationType: "idle_prompt", permissionMode: "bypassPermissions", harness: "claude-code",
    }]);
  });

  test("the event name comes from the command line, not the payload", async function () {
    received.length = 0;
    await forwardHook("Stop", JSON.stringify({ session_id: "s1", hook_event_name: "SessionEnd" }), server.port, none, CLAUDE);
    expect(received).toEqual([{ hook_event_name: "Stop", session_id: "s1", harness: "claude-code" }]);
  });

  test("sends nothing without a session id, and never throws", async function () {
    received.length = 0;
    await forwardHook("Stop", "", server.port, none, CLAUDE);
    await forwardHook("Stop", "not json", server.port, none, CLAUDE);
    await forwardHook("Stop", "[1,2]", server.port, none, CLAUDE);
    expect(received).toEqual([]);
    // Nobody listening: still quiet.
    await forwardHook("Stop", JSON.stringify({ session_id: "s1" }), 1, none, CLAUDE);
  });

  test("passes the crew introduction on to Claude Code at a session's start and at prompts, and nowhere else", async function () {
    const printed: string[] = [];
    function write(text: string): void { printed.push(text); }
    reply = function () { return Response.json({ context: "soopdoop: your crewmates' agents running now…" }); };
    await forwardHook("SessionStart", JSON.stringify({ session_id: "s1", source: "startup" }), server.port, write, CLAUDE);
    await forwardHook("UserPromptSubmit", JSON.stringify({ session_id: "s1" }), server.port, write, CLAUDE);
    await forwardHook("Stop", JSON.stringify({ session_id: "s1" }), server.port, write, CLAUDE);
    await forwardHook("PreToolUse", JSON.stringify({ session_id: "s1" }), server.port, write, CLAUDE);
    expect(printed.map(function (line) { return JSON.parse(line); })).toEqual([
      { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "soopdoop: your crewmates' agents running now…" } },
      { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "soopdoop: your crewmates' agents running now…" } },
    ]);

    // An older daemon's "ok", an empty context, or anything odd: nothing printed.
    printed.length = 0;
    for (const odd of [new Response("ok"), Response.json({ context: "" }), Response.json({ context: 5 }), Response.json(["x"])]) {
      reply = odd;
      await forwardHook("SessionStart", JSON.stringify({ session_id: "s1" }), server.port, write, CLAUDE);
    }
    expect(printed).toEqual([]);
    reply = function () { return new Response("ok"); };
  });

  test("Codex reads the introduction the same way; Grok ignores what those hooks print, so nothing is printed there", async function () {
    const printed: string[] = [];
    function write(text: string): void { printed.push(text); }
    reply = function () { return Response.json({ context: "soopdoop: crew" }); };
    received.length = 0;
    // Codex's payload (Codex 0.160.0): snake_case, with a transcript path.
    await forwardHook("SessionStart", JSON.stringify({ session_id: "c1", cwd: "/r/vibes", transcript_path: "/r.jsonl", model: "gpt-6.1-sol", source: "startup" }), server.port, write, { SOOPDOOP_HARNESS: "codex" });
    // Grok's payload (its hooks guide): camelCase, no transcript path, and GROK_SESSION_ID in the environment.
    await forwardHook("SessionStart", JSON.stringify({ hookEventName: "session_start", hook_event_name: "SessionStart", sessionId: "g1", cwd: "/r/vibes", workspaceRoot: "/r/vibes" }), server.port, write, { SOOPDOOP_HARNESS: "grok", GROK_SESSION_ID: "g1", GROK_HOOK_EVENT: "session_start" });
    expect(printed.map(function (line) { return JSON.parse(line); })).toEqual([
      { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "soopdoop: crew" } },
    ]);
    expect(received).toEqual([
      { hook_event_name: "SessionStart", session_id: "c1", cwd: "/r/vibes", transcript_path: "/r.jsonl", harness: "codex" },
      { hook_event_name: "SessionStart", session_id: "g1", cwd: "/r/vibes", harness: "grok", grokSessionId: "g1" },
    ]);
    reply = function () { return new Response("ok"); };
  });

  test("forwards how to reach the session, kept on this Mac: the Superset terminal and workspace, Claude Code's inbox, Grok's session", async function () {
    received.length = 0;
    const env = {
      ...CLAUDE,
      SUPERSET_TERMINAL_ID: "term-1",
      SUPERSET_WORKSPACE_ID: "ws-1",
      CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/1.sock",
      CLAUDE_CODE_MESSAGING_TOKEN: "tok",
      SUPERSET_ACCOUNT_ATTRIBUTION_TOKEN: "never forwarded",
    };
    await forwardHook("Stop", JSON.stringify({ session_id: "s1", inboxToken: "from the payload" }), server.port, none, env);
    expect(received).toEqual([{
      hook_event_name: "Stop", session_id: "s1", harness: "claude-code",
      supersetTerminalId: "term-1", supersetWorkspaceId: "ws-1", inboxSocket: "/tmp/cc-socks/1.sock", inboxToken: "tok",
    }]);
    expect(localFields({ GROK_SESSION_ID: "g1", SUPERSET_TERMINAL_ID: "" })).toEqual({ grokSessionId: "g1" });
  });

  test("drops replays by other tools and the daemon's own forks", async function () {
    received.length = 0;
    // Cursor runs Claude Code's hooks.
    await forwardHook("Stop", JSON.stringify({ session_id: "s1" }), server.port, none, { CLAUDECODE: "1", CURSOR_AGENT: "1" });
    // Devin, or anything else, runs them without Claude Code's CLAUDECODE.
    await forwardHook("Stop", JSON.stringify({ session_id: "s1" }), server.port, none, {});
    // Grok runs Claude Code's and Codex's hooks too.
    await forwardHook("Stop", JSON.stringify({ sessionId: "g1" }), server.port, none, { CLAUDECODE: "1", GROK_SESSION_ID: "g1" });
    await forwardHook("Stop", JSON.stringify({ sessionId: "g1" }), server.port, none, { SOOPDOOP_HARNESS: "codex", GROK_HOOK_EVENT: "stop" });
    // A Codex started from a Claude Code session's shell is that session's helper.
    await forwardHook("Stop", JSON.stringify({ session_id: "c1" }), server.port, none, { SOOPDOOP_HARNESS: "codex", CLAUDECODE: "1" });
    // A fork the daemon started to answer a question.
    await forwardHook("SessionStart", JSON.stringify({ session_id: "f1" }), server.port, none, { SOOPDOOP_HARNESS: "codex", SOOPDOOP_FORK: "1" });
    expect(received).toEqual([]);
  });
});

describe("hook hygiene", function () {
  test("names the harness from SOOPDOOP_HARNESS, Claude Code when there is none", function () {
    expect(harnessOf({})).toBe("claude-code");
    expect(harnessOf({ SOOPDOOP_HARNESS: "codex" })).toBe("codex");
    expect(harnessOf({ SOOPDOOP_HARNESS: "grok" })).toBe("grok");
    expect(harnessOf({ SOOPDOOP_HARNESS: "cursor" })).toBe("claude-code");
  });

  test("says why an event is dropped, and lets the real ones through", function () {
    expect(droppedBecause("claude-code", { CLAUDECODE: "1" })).toBeNull();
    expect(droppedBecause("codex", {})).toBeNull();
    expect(droppedBecause("grok", { GROK_SESSION_ID: "g1", GROK_HOOK_EVENT: "stop" })).toBeNull();
    expect(droppedBecause("claude-code", { CLAUDECODE: "1", CURSOR_VERSION: "2.0" })).toBe("run by Cursor");
    expect(droppedBecause("claude-code", {})).toBe("not run by Claude Code");
    expect(droppedBecause("claude-code", { CLAUDECODE: "1", GROK_SESSION_ID: "g1" })).toBe("run by Grok");
    expect(droppedBecause("grok", { CLAUDECODE: "1", GROK_SESSION_ID: "g1" })).toBe("inside a Claude Code session");
    expect(droppedBecause("codex", { SOOPDOOP_FORK: "1" })).toBe("a soopdoop fork");
  });
});
