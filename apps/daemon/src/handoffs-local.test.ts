import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getFunctionName } from "convex/server";
import type { Asked } from "./ask";
import { settingsPath } from "./config";
import type { DeliverDeps, ExecResult } from "./deliver";
import { appendHandoffLog, readHandoffLog } from "./handoff-log";
import {
  finishedLine, handoffPrompt, handoffSeen, handoffsLocal, mayDeliver, parseFinished, parseToRun, reportPrompt, type Backend, type HandoffsLocal,
} from "./handoffs-local";
import type { AgentRecord, HookEvent, Subset } from "./state";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "soopdoop-hand-"));
  dirs.push(dir);
  return dir;
}
const running: HandoffsLocal[] = [];
afterAll(async function () {
  for (const l of running) l.stop();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

interface Called {
  fn: string;
  args: Record<string, unknown>;
}

// The backend as the daemon sees it: the two queries it follows, and every mutation it makes.
function fakeBackend(): { backend: Backend; calls: Called[]; push(name: string, raw: unknown): void } {
  const watchers = new Map<string, (raw: unknown) => void>();
  const calls: Called[] = [];
  const backend: Backend = {
    watch(query, _args, onUpdate) {
      const name = getFunctionName(query);
      watchers.set(name, onUpdate);
      return function () { watchers.delete(name); };
    },
    async mutation(fn, args) {
      calls.push({ fn: getFunctionName(fn), args });
      return null;
    },
  };
  return { backend, calls, push(name, raw) { watchers.get(name)?.(raw); } };
}

function agent(over: Partial<AgentRecord> = {}): AgentRecord {
  return { agentId: "s1", harness: "claude-code", name: "vibes", status: "idle", open: true, lastTurnAt: 0, inboxSocket: "/tmp/cc-socks/1.sock", inboxToken: "tok", ...over };
}

function ok(stdout = ""): ExecResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

function delivery(answers: Record<string, ExecResult> = {}, postFails = false): { deps: DeliverDeps; posts: string[][]; commands: string[][] } {
  const posts: string[][] = [];
  const commands: string[][] = [];
  const deps: DeliverDeps = {
    async exec(cmd) {
      commands.push(cmd);
      return answers[`${path.basename(cmd[0] ?? "")} ${cmd[1] ?? ""}`.trim()] ?? answers[path.basename(cmd[0] ?? "")] ?? { exitCode: 1, stdout: "", stderr: "nope", timedOut: false };
    },
    async post(socket, token, text) {
      if (postFails) throw new Error("Failed to connect");
      posts.push([socket, token ?? "", text]);
    },
    claude: "/bin/claude",
    codex: "/bin/codex",
    superset: null,
    env: {},
  };
  return { deps, posts, commands };
}

function event(name: string, sessionId = "s1"): HookEvent {
  return { hook_event_name: name, session_id: sessionId };
}

const item = { handoffId: "h1", targetAgentId: "s1", text: "Fix the double-counted bounces in delivery metrics", fromHandle: "ada" };

interface Setup {
  home: string;
  subset: Subset;
  backend: ReturnType<typeof fakeBackend>;
  local: HandoffsLocal;
  posts: string[][];
  commands: string[][];
  asked: string[];
}

async function setup(over: { subset?: Subset; answers?: Record<string, ExecResult>; postFails?: boolean; fork?: (a: AgentRecord, p: string) => Promise<Asked>; now?: () => number; tickMs?: number; home?: string } = {}): Promise<Setup> {
  const home = over.home ?? (await tempDir());
  const subset = over.subset ?? new Map([["s1", agent()]]);
  const backend = fakeBackend();
  const { deps, posts, commands } = delivery(over.answers, over.postFails);
  const asked: string[] = [];
  const local = handoffsLocal({
    backend: backend.backend,
    token: "dtok",
    subset,
    home,
    deliverDeps() { return deps; },
    fork: over.fork ?? async function (_a, prompt) {
      asked.push(prompt);
      return { refused: "not asked in this test" };
    },
    now: over.now,
    tickMs: over.tickMs ?? 0,
    say() {},
  });
  running.push(local);
  return { home, subset, backend, local, posts, commands, asked };
}

describe("running a hand-off on the receiving Mac", function () {
  test("delivers it once into its idle agent, logs who, which agent, how and the size but never the text, then says it started", async function () {
    const s = await setup();
    s.backend.push("handoffs:toRun", [{ ...item, autoAccepted: false, why: "you built it" }]);
    await s.local.settle();
    const prompt = handoffPrompt("ada", item.text, "h1");
    expect(s.posts).toEqual([["/tmp/cc-socks/1.sock", "tok", prompt]]);
    expect(s.backend.calls).toEqual([{ fn: "handoffs:started", args: { token: "dtok", handoffId: "h1" } }]);
    const raw = await readFile(path.join(s.home, "logs", "handoffs.log"), "utf8");
    expect(raw).not.toContain("bounces");
    expect(await readHandoffLog(s.home)).toEqual([
      { at: expect.any(Number), event: "delivered", handoffId: "h1", fromHandle: "ada", agentId: "s1", harness: "claude-code", channel: "socket", chars: prompt.length },
    ]);
    // The query runs again (it does after every change): nothing is delivered twice.
    s.backend.push("handoffs:toRun", [{ ...item, autoAccepted: false }]);
    await s.local.settle();
    expect(s.posts).toHaveLength(1);
  });

  test("waits for idle when 'run when my agent is idle' accepted it or the backend does not say; never into an agent waiting on its owner", async function () {
    const s = await setup({ subset: new Map([["s1", agent({ status: "working" })]]) });
    s.backend.push("handoffs:toRun", [{ ...item, autoAccepted: true }, { ...item, handoffId: "h2" }]);
    await s.local.settle();
    expect(s.posts).toEqual([]);
    // The agent's turn ends (the daemon applies Stop to the subset, then tells the hand-offs).
    s.subset.set("s1", agent({ status: "idle" }));
    s.local.onHook(event("Stop"), agent({ status: "working" }));
    await s.local.settle();
    expect(s.posts.map(function (p) { return p[2]?.includes("handoff_id h1") === true || p[2]?.includes("handoff_id h2") === true; })).toEqual([true, true]);
    expect(mayDeliver({ ...item, autoAccepted: false }, "working")).toBe(true);
    expect(mayDeliver({ ...item, autoAccepted: false }, "waiting")).toBe(false);
    expect(mayDeliver({ ...item, autoAccepted: true }, "working")).toBe(false);
    expect(mayDeliver(item, "working")).toBe(false);
    expect(mayDeliver(item, "idle")).toBe(true);
  });

  test("never runs one for a private agent", async function () {
    const s = await setup({ subset: new Map([["s1", agent({ open: false })]]) });
    s.backend.push("handoffs:toRun", [{ ...item, autoAccepted: false }]);
    await s.local.settle();
    expect(s.posts).toEqual([]);
    expect(s.backend.calls).toEqual([]);
  });

  test("a hand-off past this Mac's allowance fails with a note that names the allowance, and does not run", async function () {
    const home = await tempDir();
    await writeFile(settingsPath(home), JSON.stringify({ handoffDailyUsd: 1 }));
    await appendHandoffLog({ at: Date.now() - 60_000, event: "reported", handoffId: "old", usd: 1.2 }, home);
    const s = await setup({ home });
    s.backend.push("handoffs:toRun", [{ ...item, autoAccepted: false }]);
    await s.local.settle();
    expect(s.posts).toEqual([]);
    expect(s.backend.calls).toEqual([{
      fn: "handoffs:failed",
      args: { token: "dtok", handoffId: "h1", note: "This Mac's hand-off allowance ($1.00 a day) is spent: $1.20 in the last 24 hours. Its owner can raise it with: soopdoop handoffs <dollars>." },
    }]);
    expect((await readHandoffLog(home)).at(-1)).toMatchObject({ event: "failed", handoffId: "h1" });
  });

  test("fails it with each channel's reason when nothing reaches the agent", async function () {
    const s = await setup({ postFails: true, answers: { "claude agents": ok("[]") } });
    s.backend.push("handoffs:toRun", [{ ...item, autoAccepted: false }]);
    await s.local.settle();
    expect(s.backend.calls).toEqual([{
      fn: "handoffs:failed",
      args: { token: "dtok", handoffId: "h1", note: "Could not reach that agent on its Mac (socket: Failed to connect; superset: not in a Superset terminal; resume: not a background session; clipboard: pbcopy: nope)." },
    }]);
  });

  test("the clipboard's note goes with started", async function () {
    const s = await setup({ postFails: true, answers: { "claude agents": ok("[]"), pbcopy: ok(), osascript: ok() } });
    s.backend.push("handoffs:toRun", [{ ...item, autoAccepted: false }]);
    await s.local.settle();
    expect(s.backend.calls).toEqual([{ fn: "handoffs:started", args: { token: "dtok", handoffId: "h1", note: "It is on the receiver's clipboard, to paste into their agent." } }]);
  });

  test("an agent not running here: a stopped background session is woken with it; anything else waits, and is looked for again later", async function () {
    let clock = Date.parse("2026-10-19T10:00:00Z");
    const answers: Record<string, ExecResult> = { "claude agents": ok("[]") };
    const s = await setup({ subset: new Map(), answers, now() { return clock; } });
    s.backend.push("handoffs:toRun", [{ ...item, targetHarness: "claude-code" }]);
    await s.local.settle();
    expect(s.commands).toEqual([["/bin/claude", "agents", "--json", "--all"]]);
    expect(s.backend.calls).toEqual([]);
    // Too soon to look again.
    s.local.onHook(event("PreToolUse", "other"), undefined);
    await s.local.settle();
    expect(s.commands).toHaveLength(1);
    clock += 3 * 60 * 1000;
    answers["claude agents"] = ok(JSON.stringify([{ id: "4f08ed25", kind: "background", sessionId: "s1", state: "stopped" }]));
    answers["claude --resume"] = ok();
    s.local.onHook(event("PreToolUse", "other"), undefined);
    await s.local.settle();
    expect(s.commands.at(-1)).toEqual(["/bin/claude", "--resume", "s1", "--bg", handoffPrompt("ada", item.text, "h1")]);
    expect(s.backend.calls).toEqual([{ fn: "handoffs:started", args: { token: "dtok", handoffId: "h1" } }]);
  });

  test("after a restart the log keeps it from running twice, and started is said again while the backend still lists it", async function () {
    const home = await tempDir();
    await appendHandoffLog({ at: Date.now() - 60_000, event: "delivered", handoffId: "h1", agentId: "s1", harness: "claude-code", channel: "socket", chars: 300 }, home);
    const s = await setup({ home });
    s.backend.push("handoffs:toRun", [{ ...item, autoAccepted: false }]);
    await s.local.settle();
    s.backend.push("handoffs:toRun", [{ ...item, autoAccepted: false }]);
    await s.local.settle();
    expect(s.posts).toEqual([]);
    expect(s.backend.calls).toEqual([{ fn: "handoffs:started", args: { token: "dtok", handoffId: "h1" } }]);
  });
});

// A Claude Code transcript where the hand-off arrived through the socket and the agent answered.
async function transcript(home: string, withHandoff: boolean): Promise<string> {
  const file = path.join(home, "s1.jsonl");
  const lines = [
    JSON.stringify({ type: "user", timestamp: "2026-10-19T09:00:00.000Z", message: { role: "user", content: "earlier work" } }),
    ...(withHandoff
      ? [JSON.stringify({ type: "user", isMeta: true, timestamp: "2026-10-19T10:00:01.000Z", origin: { kind: "peer" }, message: { role: "user", content: `Another Claude session sent a message:\n${handoffPrompt("ada", item.text, "h1")}` } })]
      : []),
    JSON.stringify({ type: "assistant", timestamp: "2026-10-19T10:00:05.000Z", message: { id: "m1", model: "claude-sonnet-5-5", role: "assistant", usage: { input_tokens: 100, output_tokens: 200 }, content: [{ type: "text", text: "Done." }] } }),
  ];
  await writeFile(file, lines.join("\n") + "\n");
  return file;
}

describe("reporting back when the agent did not", function () {
  test("a copy of the session that stopped says what it did, reported back with its links and what the hand-off cost", async function () {
    const home = await tempDir();
    const file = await transcript(home, true);
    await appendHandoffLog({ at: Date.parse("2026-10-19T10:00:00Z"), event: "delivered", handoffId: "h1", fromHandle: "ada", agentId: "s1", harness: "claude-code", channel: "socket", chars: 300 }, home);
    const prompts: string[] = [];
    const s = await setup({
      home,
      subset: new Map([["s1", agent({ transcriptPath: file })]]),
      async fork(_a, prompt) {
        prompts.push(prompt);
        return { answer: "I fixed the bounce count in metrics.ts and opened https://github.com/acme/vibes/pull/418.", usd: 0.02, tokensRead: 9_000, model: "claude-sonnet-5-5" };
      },
    });
    s.local.onHook(event("Stop"), agent());
    await s.local.settle();
    expect(prompts).toEqual([reportPrompt("h1")]);
    expect(s.backend.calls).toEqual([{
      fn: "handoffs:reportBack",
      args: {
        token: "dtok", handoffId: "h1", summary: "I fixed the bounce count in metrics.ts and opened https://github.com/acme/vibes/pull/418.",
        links: ["https://github.com/acme/vibes/pull/418"], usd: (100 * 2 + 200 * 10) / 1e6,
      },
    }]);
    expect((await readHandoffLog(home)).at(-1)).toMatchObject({ event: "reported", handoffId: "h1", by: "fork", usd: (100 * 2 + 200 * 10) / 1e6 });
    // The copy's own read is in reads.log, which the answering fund counts.
    const reads = await readFile(path.join(home, "logs", "reads.log"), "utf8");
    expect(JSON.parse(reads.trim())).toMatchObject({ kind: "handoff-report", handoffId: "h1", agentId: "s1", usd: 0.02, tokensRead: 9_000 });
    expect(reads).not.toContain("bounce");
    // Reported once.
    s.local.onHook(event("Stop"), agent());
    await s.local.settle();
    expect(prompts).toHaveLength(1);
  });

  test("finds the hand-off when the agent's turn ends before the channel's command returns (Codex queues and runs at once)", async function () {
    const home = await tempDir();
    const file = path.join(home, "rollout-x1.jsonl");
    const rollout = [
      JSON.stringify({ timestamp: "2026-10-19T10:00:00.100Z", type: "turn_context", payload: { model: "gpt-6.1-sol" } }),
      JSON.stringify({ timestamp: "2026-10-19T10:00:00.200Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: handoffPrompt("ada", item.text, "h1") }] } }),
      JSON.stringify({ timestamp: "2026-10-19T10:00:00.300Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } }),
    ];
    await writeFile(file, rollout.join("\n") + "\n");
    const codexAgent = agent({ agentId: "x1", harness: "codex", transcriptPath: file, inboxSocket: undefined });
    const backend = fakeBackend();
    const forked: string[] = [];
    let local: HandoffsLocal | null = null;
    const deps: DeliverDeps = {
      async exec(cmd) {
        // The session takes the queued message and ends its turn while `codex queue` is still running.
        if (cmd[1] === "queue") local?.onHook(event("Stop", "x1"), codexAgent);
        return ok("Queued message m1 for thread x1.");
      },
      async post() {},
      claude: null,
      codex: "/bin/codex",
      superset: null,
      env: {},
    };
    local = handoffsLocal({
      backend: backend.backend, token: "dtok", subset: new Map([["x1", codexAgent]]), home, tickMs: 0, say() {},
      deliverDeps() { return deps; },
      async fork(_a, prompt) {
        forked.push(prompt);
        return { answer: "I said hello to Ada.", usd: 0.01 };
      },
      now() { return Date.parse("2026-10-19T10:00:00Z"); },
    });
    running.push(local);
    backend.push("handoffs:toRun", [{ ...item, targetAgentId: "x1", autoAccepted: false }]);
    await local.settle();
    expect(forked).toEqual([reportPrompt("h1")]);
    expect(backend.calls.map(function (c) { return c.fn; })).toContain("handoffs:reportBack");
  });

  test("asks nothing when the agent reported back itself, or has not read the hand-off yet", async function () {
    const home = await tempDir();
    await appendHandoffLog({ at: Date.parse("2026-10-19T10:00:00Z"), event: "delivered", handoffId: "h1", agentId: "s1", harness: "claude-code", channel: "socket", chars: 300 }, home);
    const notRead = await setup({ home, subset: new Map([["s1", agent({ transcriptPath: await transcript(home, false) })]]) });
    notRead.local.onHook(event("Stop"), agent());
    await notRead.local.settle();
    expect(notRead.asked).toEqual([]);
    notRead.local.stop();
    await appendHandoffLog({ at: Date.parse("2026-10-19T10:05:00Z"), event: "reported", handoffId: "h1", agentId: "s1", by: "agent", usd: 0.3 }, home);
    const reported = await setup({ home, subset: new Map([["s1", agent({ transcriptPath: await transcript(home, true) })]]) });
    reported.local.onHook(event("Stop"), agent());
    await reported.local.settle();
    expect(reported.asked).toEqual([]);
    expect(reported.backend.calls).toEqual([]);
  });

  test("a session that ends without reporting back fails the hand-off", async function () {
    const home = await tempDir();
    await appendHandoffLog({ at: Date.now() - 60_000, event: "delivered", handoffId: "h1", agentId: "s1", harness: "claude-code", channel: "socket", chars: 300 }, home);
    const s = await setup({ home, subset: new Map() });
    s.local.onHook(event("SessionEnd"), agent());
    await s.local.settle();
    expect(s.backend.calls).toEqual([{ fn: "handoffs:failed", args: { token: "dtok", handoffId: "h1", note: "the session ended without reporting back" } }]);
  });

  test("a hand-off held for approval that never reached the agent fails after six minutes", async function () {
    const home = await tempDir();
    const file = await transcript(home, false);
    let clock = Date.parse("2026-10-19T10:00:00Z");
    const s = await setup({ home, subset: new Map([["s1", agent({ permissionMode: "bypassPermissions", transcriptPath: file })]]), answers: { osascript: ok() }, now() { return clock; }, tickMs: 5 });
    s.backend.push("handoffs:toRun", [{ ...item, autoAccepted: false }]);
    await s.local.settle();
    expect((await readHandoffLog(home))[0]).toMatchObject({ event: "delivered", held: true, channel: "socket" });
    expect(s.backend.calls[0]).toEqual({ fn: "handoffs:started", args: { token: "dtok", handoffId: "h1", note: "It is waiting for the receiver to approve it in their session." } });
    clock += 7 * 60 * 1000;
    await Bun.sleep(30);
    await s.local.settle();
    expect(s.backend.calls.at(-1)).toEqual({ fn: "handoffs:failed", args: { token: "dtok", handoffId: "h1", note: "It waited in the receiver's session for their approval, and nobody approved it." } });
  });
});

describe("telling the session that offered a hand-off how it ended", function () {
  test("one line at its next prompt, once, also after a restart; other sessions hear nothing", async function () {
    const home = await tempDir();
    const s = await setup({ home });
    s.backend.push("handoffs:finishedForDaemon", [
      { handoffId: "h9", fromAgentId: "s1", toHandle: "jimmy", status: "done", summary: "Fixed VIB-123.", links: ["https://github.com/acme/vibes/pull/418"], finishedAt: 1 },
      { handoffId: "h8", fromAgentId: "s1", toHandle: "grace", status: "declined", note: "Busy with the release.", finishedAt: 2 },
      { handoffId: "h7", fromAgentId: "s2", toHandle: "sam", status: "expired", finishedAt: 3 },
    ]);
    expect(await s.local.contextFor(event("SessionStart"))).toBeNull();
    expect(await s.local.contextFor(event("UserPromptSubmit"))).toBe(
      "soopdoop: your hand-off to @jimmy is done: Fixed VIB-123. https://github.com/acme/vibes/pull/418\nsoopdoop: @grace declined your hand-off: Busy with the release.",
    );
    expect(await s.local.contextFor(event("UserPromptSubmit"))).toBeNull();
    await s.local.settle();
    s.local.stop();
    const again = await setup({ home });
    again.backend.push("handoffs:finishedForDaemon", [{ handoffId: "h9", fromAgentId: "s1", toHandle: "jimmy", status: "done", summary: "Fixed VIB-123.", finishedAt: 1 }]);
    expect(await again.local.contextFor(event("UserPromptSubmit"))).toBeNull();
    expect(await again.local.contextFor(event("UserPromptSubmit", "s3"))).toBeNull();
  });

  test("words for each ending", function () {
    expect(finishedLine({ handoffId: "h", toHandle: "jimmy", status: "done", summary: "Fixed it.", finishedAt: 0 })).toBe("soopdoop: your hand-off to @jimmy is done: Fixed it.");
    expect(finishedLine({ handoffId: "h", toHandle: "jimmy", status: "declined", finishedAt: 0 })).toBe("soopdoop: @jimmy declined your hand-off.");
    expect(finishedLine({ handoffId: "h", toHandle: "jimmy", status: "expired", finishedAt: 0 })).toBe("soopdoop: your hand-off to @jimmy expired: nobody ran it within a day.");
    expect(finishedLine({ handoffId: "h", toHandle: "jimmy", status: "failed", note: "the session ended without reporting back", finishedAt: 0 }))
      .toBe("soopdoop: your hand-off to @jimmy was not done: the session ended without reporting back");
  });
});

describe("helpers", function () {
  test("the prompt the agent gets", function () {
    expect(handoffPrompt("ada", "Fix VIB-123.", "jd7abc")).toBe(
      "soopdoop hand-off from @ada (they approved this text, you approved running it): Fix VIB-123.\n\n" +
      "When you are done, call the report_back tool with handoff_id jd7abc, a short summary of what you did and any PR link. " +
      "If you cannot do it, call report_back with what stopped you.",
    );
  });

  test("whether a transcript shows the hand-off reached the agent and it answered, in Claude Code's and Codex's shapes", function () {
    const claude = [
      JSON.stringify({ type: "api-request-blob", body: "handoff_id h1" }),
      JSON.stringify({ type: "user", message: { content: "x handoff_id h1" } }),
    ];
    expect(handoffSeen(claude.join("\n"), "h1")).toEqual({ asked: true, answered: false });
    expect(handoffSeen([...claude, JSON.stringify({ type: "assistant", message: { content: [] } })].join("\n"), "h1")).toEqual({ asked: true, answered: true });
    const codex = [
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "handoff_id h1" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] } }),
    ];
    expect(handoffSeen(codex.join("\n"), "h1")).toEqual({ asked: true, answered: true });
    expect(handoffSeen(codex.join("\n"), "h2")).toEqual({ asked: false, answered: false });
  });

  test("reads the two queries without trusting their shape", function () {
    expect(parseToRun([{ handoffId: "h", targetAgentId: "a", text: "t", fromHandle: "ada", autoAccepted: true, targetHarness: "codex" }, { handoffId: 1 }, "x"]))
      .toEqual([{ handoffId: "h", targetAgentId: "a", text: "t", fromHandle: "ada", autoAccepted: true, targetHarness: "codex" }]);
    expect(parseToRun(null)).toEqual([]);
    expect(parseFinished([{ handoffId: "h", toHandle: "j", status: "running", finishedAt: 1 }, { handoffId: "h2", toHandle: "j", status: "done", finishedAt: 1, links: ["a", 2] }]))
      .toEqual([{ handoffId: "h2", toHandle: "j", status: "done", finishedAt: 1, links: ["a"] }]);
  });
});
