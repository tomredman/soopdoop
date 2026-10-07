import { afterAll, describe, expect, test } from "bun:test";
import { forwardHook } from "./hook";

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

describe("forwardHook", function () {
  test("sends only the fields the daemon reads, never the prompt or tool input", async function () {
    received.length = 0;
    const payload = { session_id: "s1", cwd: "/r/vibes", transcript_path: "/t.jsonl", prompt: "my secret plan", tool_input: { command: "rm -rf /" } };
    await forwardHook("UserPromptSubmit", JSON.stringify(payload), server.port);
    expect(received).toEqual([{ hook_event_name: "UserPromptSubmit", session_id: "s1", cwd: "/r/vibes", transcript_path: "/t.jsonl" }]);
  });

  test("the event name comes from the command line, not the payload", async function () {
    received.length = 0;
    await forwardHook("Stop", JSON.stringify({ session_id: "s1", hook_event_name: "SessionEnd" }), server.port);
    expect(received).toEqual([{ hook_event_name: "Stop", session_id: "s1" }]);
  });

  test("sends nothing without a session id, and never throws", async function () {
    received.length = 0;
    await forwardHook("Stop", "", server.port);
    await forwardHook("Stop", "not json", server.port);
    await forwardHook("Stop", "[1,2]", server.port);
    expect(received).toEqual([]);
    // Nobody listening: still quiet.
    await forwardHook("Stop", JSON.stringify({ session_id: "s1" }), 1);
  });

  test("passes the crew introduction on to Claude Code at a session's start and at prompts, and nowhere else", async function () {
    const printed: string[] = [];
    function write(text: string): void { printed.push(text); }
    reply = function () { return Response.json({ context: "soopdoop: your crewmates' agents running now…" }); };
    await forwardHook("SessionStart", JSON.stringify({ session_id: "s1", source: "startup" }), server.port, write);
    await forwardHook("UserPromptSubmit", JSON.stringify({ session_id: "s1" }), server.port, write);
    await forwardHook("Stop", JSON.stringify({ session_id: "s1" }), server.port, write);
    await forwardHook("PreToolUse", JSON.stringify({ session_id: "s1" }), server.port, write);
    expect(printed.map(function (line) { return JSON.parse(line); })).toEqual([
      { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "soopdoop: your crewmates' agents running now…" } },
      { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "soopdoop: your crewmates' agents running now…" } },
    ]);

    // An older daemon's "ok", an empty context, or anything odd: nothing printed.
    printed.length = 0;
    for (const odd of [new Response("ok"), Response.json({ context: "" }), Response.json({ context: 5 }), Response.json(["x"])]) {
      reply = odd;
      await forwardHook("SessionStart", JSON.stringify({ session_id: "s1" }), server.port, write);
    }
    expect(printed).toEqual([]);
    reply = function () { return new Response("ok"); };
  });
});
