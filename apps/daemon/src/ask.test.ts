import { afterAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  ANSWER_MODEL, answerModel, askAgent, askArgs, askPrompt, configDirFor, findCodex, findGrok, findRealClaude, forkEnv,
  GROK_TOOLS, grokForkId, homeVarFor, MAX_ANSWER, NOT_FOUND, parseResult, type Run,
} from "./ask";
import type { AgentRecord } from "./state";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "soopdoop-ask-"));
  dirs.push(dir);
  return dir;
}
afterAll(async function () {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function agentRecord(over: Partial<AgentRecord> = {}): AgentRecord {
  return { agentId: "s1", harness: "claude-code", name: "vibes", status: "working", open: true, transcriptPath: "/t.jsonl", lastTurnAt: 0, ...over };
}

// What `claude -p --output-format json` prints for a finished turn.
function result(text: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    total_cost_usd: 0.03,
    usage: { input_tokens: 10, cache_creation_input_tokens: 6_000, cache_read_input_tokens: 500, output_tokens: 90 },
    ...over,
  });
}

// What `codex exec fork … --json` prints (Codex 0.160.0): one event per line, warnings as items of type "error".
function codexEvents(text: string, usage: Record<string, unknown> = { input_tokens: 66_392, cached_input_tokens: 34_048, cache_write_input_tokens: 0, output_tokens: 69, reasoning_output_tokens: 0 }): string {
  return [
    { type: "thread.started", thread_id: "01a00000-0000-7000-8000-00000000f0f0" },
    { type: "item.completed", item: { id: "item_0", type: "error", message: "Code Mode is unavailable because code-mode host is disabled." } },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_1", type: "agent_message", text } },
    { type: "turn.completed", usage },
  ].map(function (e) { return JSON.stringify(e); }).join("\n") + "\n";
}

// What `grok -p … --output-format json` prints (Grok's headless guide): one object with the reply, the fork's id and usage.
function grokResult(text: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    text,
    stopReason: "end_turn",
    sessionId: "01a00000-0000-7000-8000-00000000fork",
    requestId: "req-1",
    num_turns: 1,
    usage: { input_tokens: 41_450, cache_read_input_tokens: 1_152, cache_creation_input_tokens: 0, output_tokens: 94, reasoning_tokens: 81, total_tokens: 42_696 },
    modelUsage: { "grok-4.7-build": { inputTokens: 41_450, outputTokens: 94, cacheReadInputTokens: 1_152, modelCalls: 1 } },
    ...over,
  });
}

describe("asking a Claude Code agent", function () {
  test("forks the session without saving it, with no tools, hooks or MCP servers, and puts the question last", function () {
    const args = askArgs("claude-code", "s1", "where is the retry limit?");
    // On the session's own model when it is known, so the fund knows the price.
    const onModel = askArgs("claude-code", "s1", "where is the retry limit?", "claude-opus-5-5");
    expect(onModel.slice(onModel.indexOf("--model"), onModel.indexOf("--model") + 2)).toEqual(["--model", "claude-opus-5-5"]);
    expect(onModel.at(-1)).toBe(askPrompt("where is the retry limit?"));
    expect(args).not.toContain("--model");
    expect(args.slice(0, 3)).toEqual(["-p", "--resume", "s1"]);
    for (const flag of ["--fork-session", "--no-session-persistence", "--safe-mode"]) expect(args).toContain(flag);
    // --tools takes a list: its empty value must be followed by another flag, never by the prompt.
    const tools = args.indexOf("--tools");
    expect(args[tools + 1]).toBe("");
    expect(args[tools + 2]?.startsWith("--")).toBe(true);
    expect(args.at(-1)).toBe(askPrompt("where is the retry limit?"));
    expect(askPrompt("where is the retry limit?")).toContain("<question>\nwhere is the retry limit?\n</question>");
    expect(askPrompt("x")).toContain(NOT_FOUND);
    // It answers questions; it does not take work orders.
    expect(askPrompt("x")).toContain("you only answer questions about your own work");
  });

  test("resumes a session kept outside ~/.claude from its own config folder", function () {
    const home = "/Users/me";
    expect(configDirFor("/Users/me/.claude/projects/-Users-me-vibes/s1.jsonl", home)).toBeUndefined();
    expect(configDirFor("/Users/me/.claude-work/projects/-Users-me-vibes/s1.jsonl", home)).toBe("/Users/me/.claude-work");
    expect(configDirFor("/somewhere/else/s1.jsonl", home)).toBeUndefined();
    expect(configDirFor(undefined, home)).toBeUndefined();
    expect(homeVarFor("claude-code", "/Users/me/.claude-work/projects/-Users-me-vibes/s1.jsonl", home)).toEqual({ CLAUDE_CONFIG_DIR: "/Users/me/.claude-work" });
  });

  test("starts the fork as its own session: no Claude Code, Grok or Superset session markers, provider settings kept", function () {
    const env = forkEnv({
      PATH: "/usr/bin",
      HOME: "/Users/me",
      CLAUDECODE: "1",
      CLAUDE_CODE_SESSION_ID: "s0",
      CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/x.sock",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CONFIG_DIR: "/Users/me/.claude-other",
      CLAUDE_CODE_USE_BEDROCK: "1",
      SUPERSET_TERMINAL_ID: "t1",
      GROK_SESSION_ID: "g0",
      GROK_HOME: "/Users/me/.grok-other",
      UNSET: undefined,
    }, { CLAUDE_CONFIG_DIR: "/Users/me/.claude-work" });
    // SOOPDOOP_FORK keeps any hook that still runs in the fork from reporting it as an agent.
    expect(env).toEqual({
      PATH: "/usr/bin", HOME: "/Users/me", CLAUDE_CODE_USE_BEDROCK: "1", GROK_HOME: "/Users/me/.grok-other",
      CLAUDE_CONFIG_DIR: "/Users/me/.claude-work", SOOPDOOP_FORK: "1",
    });
    expect(forkEnv({ CLAUDE_CONFIG_DIR: "/x" })).toEqual({ SOOPDOOP_FORK: "1" });
  });

  test("uses the real claude command, not Superset's wrapper", async function () {
    const home = await tempDir();
    const wrapper = path.join(home, ".superset", "bin");
    const real = path.join(home, "real-bin");
    for (const dir of [wrapper, real]) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "claude"), "#!/bin/sh\n");
      await chmod(path.join(dir, "claude"), 0o755);
    }
    expect(findRealClaude(home, `${wrapper}:${real}`)).toBe(path.join(real, "claude"));
  });

  test("reads the answer and what it cost to read; NOT_FOUND and failures become reasons", function () {
    // The cost comes from the copy's own usage at the model's prices: 10 input, 6,000 cache writes, 500 cache reads and
    // 90 output tokens on Claude Opus 5.5. total_cost_usd (0.03 here) is not used: it counts the session's past too.
    const usd = (10 * 4 + 6_000 * 5 + 500 * 0.2 + 90 * 20) / 1_000_000;
    expect(parseResult("claude-code", result("It is MAX_RETRIES in src/retry.ts."), "claude-opus-5-5")).toEqual({
      answer: "It is MAX_RETRIES in src/retry.ts.", tokensRead: 6_510, usd, model: "claude-opus-5-5",
    });
    // Not knowing still cost the owner a read; the log on their machine says so.
    expect(parseResult("claude-code", result(`${NOT_FOUND}`), "claude-opus-5-5")).toEqual({ refused: "It has not worked on this.", tokensRead: 6_510, usd, model: "claude-opus-5-5" });
    // An unknown model is priced like the dearest one.
    expect(parseResult("claude-code", result("  "))).toEqual({ refused: "It has not worked on this.", tokensRead: 6_510, usd: (10 * 10 + 6_000 * 12.5 + 500 * 1 + 90 * 50) / 1_000_000 });
    expect(parseResult("claude-code", result("Prompt is too long", { subtype: "error_during_execution", is_error: true }))).toEqual({
      refused: "Could not ask that agent: Prompt is too long",
    });
    expect(parseResult("claude-code", "")).toEqual({ refused: "That agent gave no answer." });
    expect(parseResult("claude-code", "[1]")).toEqual({ refused: "That agent gave no answer." });
    const long = parseResult("claude-code", result("y".repeat(5_000)));
    if (!("answer" in long)) throw new Error("expected an answer");
    expect(long.answer.length).toBe(MAX_ANSWER);
  });

  test("runs the fork in the agent's folder, and says why when it cannot", async function () {
    const cwd = await tempDir();
    const calls: { cmd: string[]; cwd: string; env: Record<string, string> }[] = [];
    function fake(out: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }): Run {
      return async function (cmd, opts) {
        calls.push({ cmd, cwd: opts.cwd, env: opts.env });
        return out;
      };
    }
    const agent = agentRecord({ cwd, transcriptPath: "/Users/me/.claude-work/projects/x/s1.jsonl" });
    const ok = await askAgent(agent, "where?", fake({ exitCode: 0, stdout: result("Here."), stderr: "", timedOut: false }), "/bin/claude");
    expect(ok).toMatchObject({ answer: "Here." });
    expect(calls[0]?.cmd.slice(0, 4)).toEqual(["/bin/claude", "-p", "--resume", "s1"]);
    expect(calls[0]?.cwd).toBe(cwd);
    expect(calls[0]?.env.CLAUDE_CONFIG_DIR).toBe("/Users/me/.claude-work");
    expect(calls[0]?.env.SOOPDOOP_FORK).toBe("1");

    // A folder that is gone: the fork runs from home.
    await askAgent(agentRecord({ cwd: path.join(cwd, "gone") }), "where?", fake({ exitCode: 0, stdout: result("Here."), stderr: "", timedOut: false }), "/bin/claude");
    expect(calls[1]?.cwd).toBe(homedir());

    const missing = fake({ exitCode: 1, stdout: "", stderr: "No conversation found with session ID: s1\n", timedOut: false });
    expect(await askAgent(agent, "where?", missing, "/bin/claude")).toEqual({ refused: "Could not ask that agent: No conversation found with session ID: s1" });
    expect(await askAgent(agent, "where?", fake({ exitCode: null, stdout: "", stderr: "", timedOut: true }), "/bin/claude")).toEqual({
      refused: "That agent took too long to answer.",
    });
    expect(await askAgent(agent, "where?", fake({ exitCode: 0, stdout: "", stderr: "", timedOut: false }), null)).toEqual({
      refused: "Claude Code is not installed where soopdoop can find it on that machine.",
    });
  });

  test("answers on Claude Sonnet 5.5, or on Haiku when the session runs on it, and prices the answer at that model's rates", async function () {
    expect(answerModel("claude-opus-5-5")).toBe(ANSWER_MODEL);
    expect(answerModel("claude-fable-5-1")).toBe("claude-sonnet-5-5");
    expect(answerModel(undefined)).toBe("claude-sonnet-5-5");
    expect(answerModel("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5-20251001");

    const dir = await tempDir();
    async function modelFor(lines: Record<string, unknown>[]): Promise<{ args: string[]; asked: Awaited<ReturnType<typeof askAgent>> }> {
      const transcript = path.join(dir, "s1.jsonl");
      await writeFile(transcript, lines.map(function (l) { return JSON.stringify(l); }).join("\n") + "\n");
      const calls: string[][] = [];
      async function run(cmd: string[]) {
        calls.push(cmd);
        return { exitCode: 0, stdout: result("Here."), stderr: "", timedOut: false };
      }
      const asked = await askAgent(agentRecord({ cwd: dir, transcriptPath: transcript }), "where?", run, "/bin/claude");
      return { args: calls[0] ?? [], asked };
    }
    function flag(args: string[]): string | undefined {
      return args[args.indexOf("--model") + 1];
    }
    // An Opus session is answered on Sonnet 5.5, at Sonnet's prices.
    const opus = await modelFor([{ type: "assistant", message: { model: "claude-opus-5-5", content: [{ type: "text", text: "hi" }] } }]);
    expect(flag(opus.args)).toBe("claude-sonnet-5-5");
    expect(opus.asked).toMatchObject({ answer: "Here.", model: "claude-sonnet-5-5", usd: (10 * 2 + 6_000 * 2.5 + 500 * 0.2 + 90 * 10) / 1_000_000 });
    // The model of the last real reply counts: one Claude Code wrote itself ("<synthetic>") does not.
    const haiku = await modelFor([
      { type: "assistant", message: { model: "claude-opus-5-5", content: [{ type: "text", text: "first" }] } },
      { type: "assistant", message: { model: "claude-haiku-4-5", content: [{ type: "text", text: "then" }] } },
      { type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "cancelled" }] } },
    ]);
    expect(flag(haiku.args)).toBe("claude-haiku-4-5");
  });
});

describe("asking a Codex agent", function () {
  test("forks with `codex exec fork`: unsaved, read-only, hooks, shell and code mode off, no user config, low effort, the question last", function () {
    const args = askArgs("codex", "01a00000-0000-7000-8000-000000000c0d", "where is the retry limit?", "gpt-6.1-sol");
    expect(args).toEqual([
      "exec", "fork", "01a00000-0000-7000-8000-000000000c0d", "--ephemeral", "--json", "--skip-git-repo-check", "--ignore-user-config",
      "-c", 'sandbox_mode="read-only"', "-c", "features.hooks=false", "-c", "features.shell_tool=false",
      "-c", "features.unified_exec=false", "-c", "features.code_mode_host=false", "-c", 'model_reasoning_effort="low"',
      "-m", "gpt-6.1-sol", askPrompt("where is the retry limit?"),
    ]);
    expect(askArgs("codex", "s1", "q")).not.toContain("-m");
  });

  test("reads the last agent message and the turn's usage; warnings are not failures", function () {
    // 66,392 tokens read, 34,048 of them cached, 69 written, on gpt-6.1-sol ($2 input, $0.10 cached, $10 output).
    const asked = parseResult("codex", codexEvents("The retry limit is MAX_RETRIES in src/retry.ts."), "gpt-6.1-sol");
    expect(asked).toMatchObject({ answer: "The retry limit is MAX_RETRIES in src/retry.ts.", tokensRead: 66_392, model: "gpt-6.1-sol" });
    expect(asked.usd).toBeCloseTo(((66_392 - 34_048) * 2 + 34_048 * 0.1 + 69 * 10) / 1_000_000, 10);
    expect(parseResult("codex", codexEvents(NOT_FOUND), "gpt-6.1-sol")).toMatchObject({ refused: "It has not worked on this.", tokensRead: 66_392 });
    const failed = JSON.stringify({ type: "turn.failed", error: { message: "stream disconnected before completion" } });
    expect(parseResult("codex", failed, "gpt-6.1-sol")).toEqual({ refused: "Could not ask that agent: stream disconnected before completion" });
    expect(parseResult("codex", "")).toEqual({ refused: "That agent gave no answer." });
  });

  test("runs the fork in the session's folder with its CODEX_HOME, on the session's model, and passes on Codex's error", async function () {
    const home = await tempDir();
    const cwd = await tempDir();
    // A rollout under another Codex home, in the format Codex 0.160.0 writes.
    const rollout = path.join(home, ".codex-work", "sessions", "2026", "10", "18", "rollout-2026-10-18T09-00-00-c0d3x.jsonl");
    await mkdir(path.dirname(rollout), { recursive: true });
    await writeFile(rollout, [
      { timestamp: "2026-10-18T13:00:00.000Z", type: "session_meta", payload: { id: "c0d3x", cwd, originator: "codex_exec", cli_version: "0.160.0", git: { branch: "feat/retry" } } },
      { timestamp: "2026-10-18T13:00:01.000Z", type: "turn_context", payload: { cwd, model: "gpt-6.1-sol", effort: "medium" } },
    ].map(function (l) { return JSON.stringify(l); }).join("\n") + "\n");
    const calls: { cmd: string[]; cwd: string; env: Record<string, string> }[] = [];
    function fake(out: { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }): Run {
      return async function (cmd, opts) {
        calls.push({ cmd, cwd: opts.cwd, env: opts.env });
        return out;
      };
    }
    const agent = agentRecord({ agentId: "c0d3x", harness: "codex", cwd, transcriptPath: rollout });
    expect(await askAgent(agent, "where?", fake({ exitCode: 0, stdout: codexEvents("Here."), stderr: "", timedOut: false }), "/bin/codex")).toMatchObject({
      answer: "Here.", model: "gpt-6.1-sol", tokensRead: 66_392,
    });
    expect(calls[0]?.cmd.slice(0, 4)).toEqual(["/bin/codex", "exec", "fork", "c0d3x"]);
    expect(calls[0]?.cmd).toContain("gpt-6.1-sol");
    expect(calls[0]?.cwd).toBe(cwd);
    expect(calls[0]?.env.CODEX_HOME).toBe(path.join(home, ".codex-work"));
    expect(calls[0]?.env.SOOPDOOP_FORK).toBe("1");
    // Codex 0.160.0 on a session it cannot find: exit 1, the reason on stderr.
    const gone = fake({ exitCode: 1, stdout: "", stderr: "Error: thread/fork: thread/fork failed: no rollout found for thread id c0d3x (code -32600)\n", timedOut: false });
    expect(await askAgent(agent, "where?", gone, "/bin/codex")).toEqual({
      refused: "Could not ask that agent: Error: thread/fork: thread/fork failed: no rollout found for thread id c0d3x (code -32600)",
    });
    expect(await askAgent(agent, "where?", gone, null)).toEqual({ refused: "Codex is not installed where soopdoop can find it on that machine." });
  });

  test("finds the native codex binary behind npm's node launcher, and never Superset's wrapper", async function () {
    const home = await tempDir();
    // npm's layout: <prefix>/bin/codex -> ../lib/node_modules/@openai/codex/bin/codex.js, which starts the platform package's binary.
    const pkg = path.join(home, "lib", "node_modules", "@openai", "codex");
    const arm = process.arch === "arm64";
    const target = process.platform === "linux"
      ? { pkg: `codex-linux-${arm ? "arm64" : "x64"}`, triple: `${arm ? "aarch64" : "x86_64"}-unknown-linux-musl` }
      : { pkg: `codex-darwin-${arm ? "arm64" : "x64"}`, triple: `${arm ? "aarch64" : "x86_64"}-apple-darwin` };
    const native = path.join(pkg, "node_modules", "@openai", target.pkg, "vendor", target.triple, "bin", "codex");
    await mkdir(path.dirname(native), { recursive: true });
    await writeFile(native, "binary");
    await mkdir(path.join(pkg, "bin"), { recursive: true });
    await writeFile(path.join(pkg, "bin", "codex.js"), "#!/usr/bin/env node\n// launcher\n");
    await mkdir(path.join(home, "bin"), { recursive: true });
    await symlink(path.join(pkg, "bin", "codex.js"), path.join(home, "bin", "codex"));
    const wrapper = path.join(home, ".superset", "bin");
    await mkdir(wrapper, { recursive: true });
    await writeFile(path.join(wrapper, "codex"), "#!/bin/sh\n");
    // Paths come back resolved (on macOS the temporary folder is under /private).
    expect(findCodex(home, `${wrapper}:${path.join(home, "bin")}`, [])).toBe(realpathSync(native));
    // A codex that is already a binary is used as it is; none at all is null.
    const plain = path.join(home, "plain");
    await mkdir(plain, { recursive: true });
    await writeFile(path.join(plain, "codex"), "binary");
    expect(findCodex(home, plain, [])).toBe(realpathSync(path.join(plain, "codex")));
    // Only Superset's wrapper on PATH: nothing.
    expect(findCodex(home, wrapper, [])).toBeNull();
  });
});

describe("asking a Grok agent", function () {
  test("forks with `grok -p … -r <id> --fork-session`: one turn, low effort, every built-in tool taken away", function () {
    const args = askArgs("grok", "01a00000-0000-7000-8000-00000000960c", "where is the retry limit?");
    expect(args).toEqual([
      "-p", askPrompt("where is the retry limit?"), "-r", "01a00000-0000-7000-8000-00000000960c", "--fork-session",
      "--output-format", "json", "--effort", "low", "--max-turns", "1", "--disallowed-tools", GROK_TOOLS.join(","),
    ]);
    for (const tool of ["run_terminal_command", "read_file", "search_replace", "write", "use_tool", "web_fetch", "spawn_subagent", "Agent"]) {
      expect(GROK_TOOLS).toContain(tool);
    }
  });

  test("reads the reply, the usage in Claude's keys and the model it ran on; an error object is a reason", function () {
    // grok-4.7-build: $0.68 input, $0.17 cached, $2.04 output. These numbers are one real turn's, whose cost Grok recorded
    // as 285,736,000 ticks ($0.0285736).
    const asked = parseResult("grok", grokResult("It is MAX_RETRIES in src/retry.ts."));
    expect(asked).toMatchObject({ answer: "It is MAX_RETRIES in src/retry.ts.", tokensRead: 42_602, model: "grok-4.7-build" });
    expect(asked.usd).toBeCloseTo(0.0285736, 10);
    expect(parseResult("grok", grokResult(NOT_FOUND))).toMatchObject({ refused: "It has not worked on this." });
    // What Grok 1.0.46 printed on this Mac when its sign-in had expired.
    const signedOut = JSON.stringify({ type: "error", message: "Not signed in. To authenticate without a browser, run:\n  grok login --device-code" });
    expect(parseResult("grok", `${signedOut}\nError: Not signed in.`)).toEqual({ refused: "Could not ask that agent: Not signed in. To authenticate without a browser, run:" });
    expect(parseResult("grok", "")).toEqual({ refused: "That agent gave no answer." });
    expect(grokForkId(grokResult("x"))).toBe("01a00000-0000-7000-8000-00000000fork");
    expect(grokForkId(grokResult("x", { sessionId: "../../etc" }))).toBeNull();
  });

  test("deletes the fork Grok saved, never the agent's own session, and runs with the session's GROK_HOME", async function () {
    const home = await tempDir();
    const session = path.join(home, ".grok-work", "sessions", "%2Ftmp%2Fvibes", "g1", "chat_history.jsonl");
    await mkdir(path.dirname(session), { recursive: true });
    await writeFile(session, JSON.stringify({ type: "assistant", content: "hi", model_id: "grok-4.7-build" }) + "\n");
    const calls: { cmd: string[]; env: Record<string, string> }[] = [];
    function fake(stdout: string): Run {
      return async function (cmd, opts) {
        calls.push({ cmd, env: opts.env });
        return { exitCode: 0, stdout, stderr: "", timedOut: false };
      };
    }
    const agent = agentRecord({ agentId: "g1", harness: "grok", transcriptPath: session });
    expect(await askAgent(agent, "where?", fake(grokResult("Here.", { sessionId: "g1-fork" })), "/bin/grok")).toMatchObject({ answer: "Here.", model: "grok-4.7-build" });
    expect(calls.map(function (c) { return c.cmd.slice(0, 4); })).toEqual([["/bin/grok", "-p", askPrompt("where?"), "-r"], ["/bin/grok", "sessions", "delete", "g1-fork"]]);
    expect(calls[0]?.env.GROK_HOME).toBe(path.join(home, ".grok-work"));
    // A reply that names the agent's own session is never deleted.
    calls.length = 0;
    await askAgent(agent, "where?", fake(grokResult("Here.", { sessionId: "g1" })), "/bin/grok");
    expect(calls).toHaveLength(1);
  });

  test("finds grok on PATH or in ~/.grok/bin, never Superset's wrapper", async function () {
    const home = await tempDir();
    const wrapper = path.join(home, ".superset", "bin");
    await mkdir(wrapper, { recursive: true });
    await writeFile(path.join(wrapper, "grok"), "#!/bin/sh\n");
    expect(findGrok(home, wrapper, [])).toBeNull();
    await mkdir(path.join(home, ".grok", "bin"), { recursive: true });
    await writeFile(path.join(home, ".grok", "bin", "grok"), "binary");
    expect(findGrok(home, wrapper, [])).toBe(path.join(home, ".grok", "bin", "grok"));
    expect(homeVarFor("grok", "/Users/me/.grok/sessions/%2Fx/g1/chat_history.jsonl", "/Users/me")).toEqual({});
    expect(homeVarFor("codex", "/Users/me/.codex/sessions/2026/10/18/rollout-x.jsonl", "/Users/me")).toEqual({});
  });
});
