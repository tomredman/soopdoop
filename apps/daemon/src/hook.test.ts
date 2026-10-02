import { afterAll, describe, expect, test } from "bun:test";
import { forwardHook } from "./hook";

const received: unknown[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    received.push(await req.json());
    return new Response("ok");
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
});
