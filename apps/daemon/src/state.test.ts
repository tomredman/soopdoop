import { describe, expect, test } from "bun:test";
import { apply, sweep, toReport } from "./state";

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
});
