import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { ANSWER_MODEL, answerModel, askAgent, askArgs, askPrompt, configDirFor, findRealClaude, forkEnv, MAX_ANSWER, NOT_FOUND, parseResult, type Run } from "./ask";
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

describe("asking an agent", function () {
  test("forks the session without saving it, with no tools, hooks or MCP servers, and puts the question last", function () {
    const args = askArgs("s1", "where is the retry limit?");
    // On the session's own model when it is known, so the fund knows the price.
    const onModel = askArgs("s1", "where is the retry limit?", "claude-opus-5-5");
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
  });

  test("starts the fork as its own session: no Claude Code or Superset session markers, provider settings kept", function () {
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
      UNSET: undefined,
    }, "/Users/me/.claude-work");
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/Users/me", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CONFIG_DIR: "/Users/me/.claude-work" });
    expect(forkEnv({ CLAUDE_CONFIG_DIR: "/x" }, undefined)).toEqual({});
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
    expect(parseResult(result("It is MAX_RETRIES in src/retry.ts."), "claude-opus-5-5")).toEqual({
      answer: "It is MAX_RETRIES in src/retry.ts.", tokensRead: 6_510, usd, model: "claude-opus-5-5",
    });
    // Not knowing still cost the owner a read; the log on their machine says so.
    expect(parseResult(result(`${NOT_FOUND}`), "claude-opus-5-5")).toEqual({ refused: "It has not worked on this.", tokensRead: 6_510, usd, model: "claude-opus-5-5" });
    // An unknown model is priced like the dearest one.
    expect(parseResult(result("  "))).toEqual({ refused: "It has not worked on this.", tokensRead: 6_510, usd: (10 * 10 + 6_000 * 12.5 + 500 * 1 + 90 * 50) / 1_000_000 });
    expect(parseResult(result("Prompt is too long", { subtype: "error_during_execution", is_error: true }))).toEqual({
      refused: "Could not ask that agent: Prompt is too long",
    });
    expect(parseResult("")).toEqual({ refused: "That agent gave no answer." });
    expect(parseResult("[1]")).toEqual({ refused: "That agent gave no answer." });
    const long = parseResult(result("y".repeat(5_000)));
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
