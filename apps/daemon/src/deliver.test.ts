// ABOUTME: Tests for delivering a hand-off: the inbox socket's lines against a real Unix socket, the order of channels per harness,
// ABOUTME: and each channel's command line (Superset, a stopped background session, codex queue, the clipboard) with stand-in commands.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  awayChannelsFor, backgroundState, channelsFor, deliver, notificationScript, oneLine, postToSocket, socketLines,
  type DeliverDeps, type Exec, type ExecResult, type Target,
} from "./deliver";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  // Unix socket paths must stay short, so these live under /tmp, not the long per-user folder.
  const dir = await mkdtemp(path.join(process.platform === "darwin" ? "/tmp" : tmpdir(), "sd-dlv-"));
  dirs.push(dir);
  return dir;
}
afterAll(async function () {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function ok(stdout = ""): ExecResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}
function bad(stderr: string): ExecResult {
  return { exitCode: 1, stdout: "", stderr, timedOut: false };
}

interface Call {
  cmd: string[];
  env: Record<string, string>;
  stdin?: string;
}

// A stand-in for running commands: each command's first two words pick its answer.
function fakeDeps(answers: Record<string, ExecResult>, over: Partial<DeliverDeps> = {}): { deps: DeliverDeps; calls: Call[]; posts: string[][] } {
  const calls: Call[] = [];
  const posts: string[][] = [];
  const exec: Exec = async function (cmd, opts) {
    calls.push({ cmd, env: opts.env, ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }) });
    const key = `${path.basename(cmd[0] ?? "")} ${cmd[1] ?? ""}`.trim();
    return answers[key] ?? answers[path.basename(cmd[0] ?? "")] ?? bad(`no answer for ${key}`);
  };
  const deps: DeliverDeps = {
    exec,
    async post(socket, token, text) {
      posts.push([socket, token ?? "", text]);
    },
    claude: "/bin/claude",
    codex: "/bin/codex",
    superset: "/bin/superset",
    env: { PATH: "/usr/bin", CLAUDECODE: "1", SUPERSET_TERMINAL_ID: "mine" },
    ...over,
  };
  return { deps, calls, posts };
}

const claudeTarget: Target = {
  agentId: "s1",
  harness: "claude-code",
  name: "vibes",
  inboxSocket: "/tmp/cc-socks/1.sock",
  inboxToken: "tok",
  supersetTerminalId: "t1",
  supersetWorkspaceId: "w1",
  transcriptPath: "/Users/ada/.claude/projects/-r-vibes/s1.jsonl",
};

describe("the inbox socket", function () {
  test("takes the auth line and the message line, each ending in a newline", function () {
    expect(socketLines("tok", "do it")).toBe('{"type":"auth","token":"tok"}\n{"type":"user","message":{"role":"user","content":"do it"}}\n');
    expect(socketLines(undefined, "a\nb")).toBe('{"type":"user","message":{"role":"user","content":"a\\nb"}}\n');
  });

  test("posts both lines into a listening socket, and refuses when there is no socket", async function () {
    const dir = await tempDir();
    const sock = path.join(dir, "s.sock");
    let got = "";
    const server = Bun.listen({
      unix: sock,
      socket: {
        data(_s, chunk) {
          got += new TextDecoder().decode(chunk);
        },
      },
    });
    try {
      await postToSocket(sock, "tok", "hello");
      expect(got.split("\n")).toEqual(['{"type":"auth","token":"tok"}', '{"type":"user","message":{"role":"user","content":"hello"}}', ""]);
    } finally {
      server.stop(true);
    }
    expect(postToSocket(path.join(dir, "gone.sock"), "tok", "hello")).rejects.toThrow("no inbox socket");
  });
});

describe("the order of channels", function () {
  test("Claude Code: socket, Superset, a stopped background session, clipboard; Superset first when the session bypasses permissions", function () {
    expect(channelsFor(claudeTarget)).toEqual(["socket", "superset", "resume", "clipboard"]);
    expect(channelsFor({ ...claudeTarget, permissionMode: "bypassPermissions" })).toEqual(["superset", "socket", "resume", "clipboard"]);
    // Without a Superset terminal the socket stays first: Claude Code holds the post for the owner's approval.
    expect(channelsFor({ agentId: "s1", harness: "claude-code", permissionMode: "bypassPermissions" })).toEqual(["socket", "superset", "resume", "clipboard"]);
  });

  test("Codex: its queue, Superset, clipboard. Grok: Superset, clipboard. An agent not running here: only what wakes or waits for it", function () {
    expect(channelsFor({ agentId: "x", harness: "codex" })).toEqual(["codex-queue", "superset", "clipboard"]);
    expect(channelsFor({ agentId: "g", harness: "grok" })).toEqual(["superset", "clipboard"]);
    expect(awayChannelsFor("claude-code")).toEqual(["resume"]);
    expect(awayChannelsFor("codex")).toEqual(["codex-queue"]);
    expect(awayChannelsFor("grok")).toEqual([]);
  });
});

describe("delivering a hand-off", function () {
  test("into Claude Code's inbox socket when it answers", async function () {
    const { deps, calls, posts } = fakeDeps({});
    expect(await deliver(claudeTarget, "the prompt", "ada", deps)).toEqual({ channel: "socket" });
    expect(posts).toEqual([["/tmp/cc-socks/1.sock", "tok", "the prompt"]]);
    expect(calls).toEqual([]);
  });

  test("a session that bypasses permissions holds the post: the owner is told to approve it there", async function () {
    const { deps, calls } = fakeDeps({ osascript: ok() });
    const got = await deliver({ ...claudeTarget, supersetTerminalId: undefined, permissionMode: "bypassPermissions" }, "p", "ada", deps);
    expect(got).toEqual({ channel: "socket", held: true, note: "It is waiting for the receiver to approve it in their session." });
    expect(calls[0]?.cmd).toEqual(["/usr/bin/osascript", "-e", 'display notification "A hand-off from @ada is waiting in your vibes agent: approve the held message there to run it." with title "soopdoop"']);
  });

  test("types it into the Superset terminal as one line when the socket fails, with no session markers in the environment", async function () {
    const { deps, calls } = fakeDeps({ "superset terminals": ok() }, {
      async post() {
        throw new Error("Failed to connect");
      },
    });
    expect(await deliver(claudeTarget, "line one\n\nline two", "ada", deps)).toEqual({ channel: "superset" });
    expect(calls[0]?.cmd).toEqual(["/bin/superset", "terminals", "send", "--local", "--workspace", "w1", "--terminal", "t1", "--text", "line one line two"]);
    expect(calls[0]?.env.CLAUDECODE).toBeUndefined();
    expect(calls[0]?.env.SUPERSET_TERMINAL_ID).toBeUndefined();
    expect(calls[0]?.env.SOOPDOOP_FORK).toBeUndefined();
  });

  test("wakes a stopped background session with only --resume <id> --bg and the prompt, never a running one", async function () {
    const stopped = JSON.stringify([{ id: "4f08ed25", kind: "background", sessionId: "s1", state: "stopped", cwd: "/r/vibes", startedAt: 1 }]);
    const { deps, calls } = fakeDeps({ "claude agents": ok(stopped), "claude --resume": ok("backgrounded · 4f08ed25") });
    const target: Target = { agentId: "s1", harness: "claude-code", transcriptPath: "/cfg/projects/-r-vibes/s1.jsonl" };
    expect(await deliver(target, "p", "ada", deps)).toEqual({ channel: "resume" });
    expect(calls.map(function (c) { return c.cmd; })).toEqual([
      ["/bin/claude", "agents", "--json", "--all"],
      ["/bin/claude", "--resume", "s1", "--bg", "p"],
    ]);
    // The session's own config folder, so the right background service runs it.
    expect(calls[1]?.env.CLAUDE_CONFIG_DIR).toBe("/cfg");
    const running = JSON.stringify([{ id: "4f08ed25", kind: "background", sessionId: "s1", pid: 58079, status: "idle" }]);
    const second = fakeDeps({ "claude agents": ok(running), pbcopy: ok(), osascript: ok() });
    expect(await deliver(target, "p", "ada", second.deps, ["resume"])).toEqual({ failed: "resume: its background session is running" });
  });

  test("falls back to the clipboard and a notification, in UTF-8", async function () {
    const { deps, calls } = fakeDeps({ "superset terminals": bad("Error: Workspace not found"), "claude agents": ok("[]"), pbcopy: ok(), osascript: ok() }, {
      async post() {
        throw new Error("no inbox socket");
      },
    });
    expect(await deliver(claudeTarget, "p ✓", "ada", deps)).toEqual({ channel: "clipboard", note: "It is on the receiver's clipboard, to paste into their agent." });
    const copy = calls.find(function (c) { return c.cmd[0] === "/usr/bin/pbcopy"; });
    expect(copy?.stdin).toBe("p ✓");
    expect(copy?.env.LANG).toBe("en_US.UTF-8");
    expect(calls.at(-1)?.cmd[2]).toContain("A hand-off from @ada is on your clipboard: paste it into your vibes agent.");
  });

  test("Codex: queues it for the thread, in the session's CODEX_HOME", async function () {
    const { deps, calls } = fakeDeps({ "codex queue": ok("Queued message m1 for thread x1.") });
    const target: Target = { agentId: "x1", harness: "codex", transcriptPath: "/acct/sessions/2026/10/18/rollout-x1.jsonl" };
    expect(await deliver(target, "p", "ada", deps)).toEqual({ channel: "codex-queue" });
    expect(calls[0]?.cmd).toEqual(["/bin/codex", "queue", "--thread", "x1", "--message", "p"]);
    expect(calls[0]?.env.CODEX_HOME).toBe("/acct");
  });

  test("says why each channel failed when none reached the agent", async function () {
    const { deps } = fakeDeps({ "codex queue": bad("Error: no rollout found for thread id x1"), pbcopy: bad("pbcopy: broken") });
    const got = await deliver({ agentId: "x1", harness: "codex" }, "p", "ada", { ...deps, superset: null });
    expect(got).toEqual({ failed: "codex-queue: codex queue: Error: no rollout found for thread id x1; superset: not in a Superset terminal; clipboard: pbcopy: pbcopy: broken" });
    expect(await deliver({ agentId: "g", harness: "grok" }, "p", "ada", deps, [])).toEqual({ failed: "no way to reach it" });
  });
});

describe("helpers", function () {
  test("reads whether a background session runs from claude agents --json", function () {
    const rows = JSON.stringify([
      { kind: "interactive", sessionId: "i1", pid: 1, status: "busy" },
      { kind: "background", sessionId: "b1", pid: 2, status: "idle", id: "b1" },
      { kind: "background", sessionId: "b2", state: "stopped", id: "b2" },
    ]);
    expect(backgroundState(rows, "b1")).toBe("running");
    expect(backgroundState(rows, "b2")).toBe("stopped");
    expect(backgroundState(rows, "i1")).toBeNull();
    expect(backgroundState("not json", "b1")).toBeNull();
  });

  test("one line for a terminal, and AppleScript quoting", function () {
    expect(oneLine("a\n\n  b\nc ")).toBe("a b c");
    expect(notificationScript('say "hi" \\ bye')).toBe('display notification "say \\"hi\\" \\\\ bye" with title "soopdoop"');
  });
});
