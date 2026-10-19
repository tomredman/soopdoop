// ABOUTME: Tests ledger lines made on the Mac: areas and file counts from what a session changed, the free line, Haiku's line and
// ABOUTME: its flags, Codex's memory and Grok's title, and the keeper (idle ten minutes, session end, private agents, resend rules).
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunResult } from "./ask";
import {
  areaOf, cleanSentence, codexMemory, fingerprint, freeLine, haikuArgs, haikuPrompt, insideFolder, ledgerKeeper, readLedgerFile, workOf,
  type LedgerDeps, type LedgerLine,
} from "./ledger-local";
import type { AgentRecord } from "./state";
import { emptyParsed, parseFor, type Parsed } from "./transcripts/index";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "soopdoop-ledger-"));
  dirs.push(dir);
  return dir;
}
afterAll(async function () {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const CWD = "/Users/jimmy/projects/vibes";

function row(type: string, content: unknown): string {
  return JSON.stringify({ type, cwd: CWD, gitBranch: "fix/bounces", message: { role: type, content, ...(type === "assistant" ? { model: "claude-opus-5-5" } : {}) } });
}
function tool(id: string, name: string, input: Record<string, unknown>): string {
  return row("assistant", [{ type: "tool_use", id, name, input }]);
}

// A made-up Claude Code session: read two files, changed two, opened a PR.
const SESSION = [
  row("user", "the delivery metrics count bounces twice, fix it"),
  tool("r1", "Read", { file_path: `${CWD}/packages/email/src/metrics.ts` }),
  tool("r2", "Read", { file_path: "/Users/jimmy/.claude/CLAUDE.md" }),
  tool("e1", "Edit", { file_path: `${CWD}/packages/email/src/metrics.ts` }),
  tool("e2", "Edit", { file_path: `${CWD}/apps/web/metrics/page.tsx` }),
  tool("b1", "Bash", { command: "gh pr create --fill" }),
  row("user", [{ type: "tool_result", tool_use_id: "b1", content: "https://github.com/example-org/vibes/pull/418\n" }]),
  row("assistant", [{ type: "text", text: "Fixed: bounces are counted once now. PR #418 is open." }]),
  row("user", "thanks, looks good"),
].join("\n") + "\n";

describe("what a session's work touched", function () {
  test("only files inside the session's folder count", function () {
    expect(insideFolder(`${CWD}/apps/web/x.ts`, CWD)).toBe("apps/web/x.ts");
    expect(insideFolder("/Users/jimmy/.claude/CLAUDE.md", CWD)).toBeNull();
    expect(insideFolder("src/coupon.ts", CWD)).toBe("src/coupon.ts");
    expect(insideFolder("../other/x.ts", CWD)).toBeNull();
    expect(insideFolder(`${CWD}/x.ts`, undefined)).toBeNull();
  });

  test("an area is the file's folder, at most three deep, without code-holding folders at the end", function () {
    expect(areaOf("apps/web/quote/Form.tsx")).toBe("apps/web/quote");
    expect(areaOf("packages/email/src/send.ts")).toBe("packages/email");
    expect(areaOf("apps/hud/Sources/Soopdoop/Views/HUD.swift")).toBe("apps/hud");
    expect(areaOf("src/checkout.ts")).toBe("src");
    expect(areaOf("README.md")).toBeNull();
  });

  test("areas and the file count come from the files changed, else the files read; the busiest area first", function () {
    const parsed = parseFor("claude-code", SESSION);
    expect(workOf(parsed, CWD)).toEqual({ areas: ["packages/email", "apps/web/metrics"], files: 2, shown: ["packages/email/src/metrics.ts", "apps/web/metrics/page.tsx"] });
    const readOnly: Parsed = { ...emptyParsed(), files: [`${CWD}/a/b/one.ts`, `${CWD}/a/b/two.ts`, `${CWD}/c/three.ts`] };
    expect(workOf(readOnly, CWD)).toMatchObject({ areas: ["a/b", "c"], files: 3 });
  });
});

describe("the line's words", function () {
  test("for free: the first prompt, and the last one when it differs, secrets taken out", function () {
    expect(freeLine({ ...emptyParsed(), firstPrompt: "fix the bounces", lastPrompt: "merge it" })).toBe('"fix the bounces" → "merge it"');
    expect(freeLine({ ...emptyParsed(), firstPrompt: "fix the bounces", lastPrompt: "fix the bounces" })).toBe('"fix the bounces"');
    expect(freeLine({ ...emptyParsed(), firstPrompt: "use sk-ant-api03-abcdefghijklmnopqrstuvwx for it" })).toBe('"use [secret] for it"');
    expect(freeLine(emptyParsed())).toBeNull();
    expect(freeLine({ ...emptyParsed(), firstPrompt: "x".repeat(500) })?.length).toBeLessThanOrEqual(240);
  });

  test("Haiku runs in safe mode on the owner's sign-in, no tools, nothing saved, at low effort, the prompt last", function () {
    const args = haikuArgs("PROMPT");
    expect(args.slice(0, 11)).toEqual(["-p", "--safe-mode", "--no-session-persistence", "--tools", "", "--model", "claude-haiku-5-5", "--effort", "low", "--system-prompt", expect.any(String)]);
    expect(args.slice(-3)).toEqual(["--output-format", "json", "PROMPT"]);
    expect(args).not.toContain("--bare");
  });

  test("Haiku is given the first and last prompts, the agent's last reply, the files and the PR, without secrets", function () {
    const parsed = parseFor("claude-code", SESSION.replace("count bounces twice", "count bounces twice (key sk-ant-api03-abcdefghijklmnopqrstuvwx)"));
    const prompt = haikuPrompt(parsed, workOf(parsed, CWD).shown);
    expect(prompt).toContain("<first_request>the delivery metrics count bounces twice (key [secret]), fix it</first_request>");
    expect(prompt).toContain("<last_request>thanks, looks good</last_request>");
    expect(prompt).toContain("<agent_last_reply>Fixed: bounces are counted once now. PR #418 is open.</agent_last_reply>");
    expect(prompt).toContain("<files>packages/email/src/metrics.ts, apps/web/metrics/page.tsx</files>");
    expect(prompt).toContain("<pull_request>https://github.com/example-org/vibes/pull/418</pull_request>");
    expect(prompt).toContain("No names of people");
    expect(prompt).not.toContain("sk-ant");
  });

  test("Haiku's reply is cleaned to one plain line; a refusal or nothing is no line", function () {
    expect(cleanSentence("\"Fixed bounce double-counting in delivery metrics.\"\n\nExtra")).toBe("Fixed bounce double-counting in delivery metrics.");
    expect(cleanSentence("- Added coupon codes")).toBe("Added coupon codes");
    expect(cleanSentence("I can't help with that.")).toBeNull();
    expect(cleanSentence("   ")).toBeNull();
  });

  test("the fingerprint changes when the session does more, and only then", function () {
    const a = parseFor("claude-code", SESSION);
    expect(fingerprint(parseFor("claude-code", SESSION))).toBe(fingerprint(a));
    expect(fingerprint(parseFor("claude-code", SESSION + row("user", "and add a test") + "\n"))).not.toBe(fingerprint(a));
  });

  test("Codex's own note on the session, found by its thread id; none for another session", async function () {
    const home = await tempDir();
    const dir = path.join(home, "memories", "rollout_summaries");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "2026-10-18T13-00-00-ab12-coupon_codes.md"), "thread_id: c-1\nupdated_at: 2026-10-18T14:00:00+00:00\ncwd: /r/vibes\n\n# Added coupon codes to checkout\n\nRollout context: …\n");
    await writeFile(path.join(dir, "2026-10-17T13-00-00-cd34-other.md"), "thread_id: c-2\n\n# Something else\n");
    expect(await codexMemory(home, "c-1")).toBe("Added coupon codes to checkout");
    expect(await codexMemory(home, "c-3")).toBeUndefined();
    expect(await codexMemory(home, "../x")).toBeUndefined();
    expect(await codexMemory(path.join(home, "missing"), "c-1")).toBeUndefined();
  });
});

describe("the ledger keeper", function () {
  const NOW = Date.parse("2026-10-18T15:00:00Z");

  function agentRecord(over: Partial<AgentRecord>): AgentRecord {
    return { agentId: "s1", harness: "claude-code", name: "vibes", status: "idle", open: true, cwd: CWD, repo: CWD, lastTurnAt: NOW - 11 * 60_000, ...over };
  }

  async function setup(over: Partial<LedgerDeps> = {}, haikuReply: string | null = "Fixed delivery counts that double-counted bounces.") {
    const home = await tempDir();
    const transcript = path.join(home, "s1.jsonl");
    await writeFile(transcript, SESSION);
    const sent: LedgerLine[] = [];
    const runs: string[][] = [];
    let clock = NOW;
    async function run(cmd: string[]): Promise<RunResult> {
      runs.push(cmd);
      if (haikuReply === null) return { exitCode: 1, stdout: "", stderr: "boom", timedOut: false };
      return {
        exitCode: 0, stderr: "", timedOut: false,
        stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: haikuReply, usage: { input_tokens: 2, cache_creation_input_tokens: 900, output_tokens: 20, cache_creation: { ephemeral_1h_input_tokens: 900 } } }),
      };
    }
    const deps: LedgerDeps = {
      async send(line) { sent.push(line); },
      ready() { return true; },
      isPrivate() { return false; },
      async haikuAllowed() { return true; },
      claude() { return "/bin/claude"; },
      run,
      homes: { claude: path.join(home, ".claude"), codex: path.join(home, ".codex"), grok: path.join(home, ".grok") },
      file: path.join(home, "ledger.json"),
      log: path.join(home, "logs", "ledger.log"),
      clock() { return clock; },
      ...over,
    };
    return { home, transcript, sent, runs, deps, keeper: ledgerKeeper(deps), tick(ms: number) { clock += ms; } };
  }

  test("an agent idle ten minutes gets one line in Haiku's words, kept in ledger.json; the next heartbeat sends nothing", async function () {
    const t = await setup();
    const agent = agentRecord({ transcriptPath: t.transcript });
    await t.keeper.tick([agentRecord({ transcriptPath: t.transcript, lastTurnAt: NOW - 60_000 })]);
    expect(t.sent).toEqual([]);
    await t.keeper.tick([agent]);
    expect(t.sent).toEqual([{
      sessionKey: "s1", harness: "claude-code", workspace: "vibes", branch: "fix/bounces",
      did: "Fixed delivery counts that double-counted bounces.", areas: ["packages/email", "apps/web/metrics"], files: 2,
      pr: "https://github.com/example-org/vibes/pull/418", at: agent.lastTurnAt,
    }]);
    expect(t.runs).toHaveLength(1);
    await t.keeper.tick([agent]);
    expect(t.sent).toHaveLength(1);
    const kept = (await readLedgerFile(t.deps.file)).lines.s1;
    expect(kept).toMatchObject({ did: "Fixed delivery counts that double-counted bounces.", source: "haiku", sentAt: NOW });
    expect(kept?.usd).toBeCloseTo((2 * 0.1 + 900 * 0.2 + 20 * 0.5) / 1_000_000, 10);
    // The log has sizes and cost, never the words.
    const log = await readFile(t.deps.log ?? "", "utf8");
    expect(log).toContain('"source":"haiku"');
    expect(log).not.toContain("bounces");
  });

  test("the same session after another turn: unchanged work is not sent again, more work is", async function () {
    const t = await setup();
    await t.keeper.tick([agentRecord({ transcriptPath: t.transcript })]);
    // A new turn that added nothing to the transcript (the same fingerprint).
    await t.keeper.tick([agentRecord({ transcriptPath: t.transcript, lastTurnAt: NOW - 10 * 60_000 - 1 })]);
    expect(t.sent).toHaveLength(1);
    expect(t.runs).toHaveLength(1);
    await writeFile(t.transcript, SESSION + row("user", "now add a test for it") + "\n" + tool("e3", "Edit", { file_path: `${CWD}/packages/email/src/metrics.test.ts` }) + "\n");
    await t.keeper.ended(agentRecord({ transcriptPath: t.transcript, status: "working" }));
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1]?.files).toBe(3);
  });

  test("a private agent gets no line, and neither does one made private before its line went out", async function () {
    const t = await setup({ isPrivate(agent) { return agent.cwd === CWD; } });
    await t.keeper.ended(agentRecord({ transcriptPath: t.transcript }));
    await t.keeper.ended(agentRecord({ transcriptPath: t.transcript, open: false, cwd: "/elsewhere" }));
    expect(t.sent).toEqual([]);
    expect(t.runs).toEqual([]);
  });

  test("with ledger lines off, or when Haiku fails, the line is the prompts' own words", async function () {
    const off = await setup({ async haikuAllowed() { return false; } });
    await off.keeper.ended(agentRecord({ transcriptPath: off.transcript }));
    expect(off.runs).toEqual([]);
    expect(off.sent[0]?.did).toBe('"the delivery metrics count bounces twice, fix it" → "thanks, looks good"');
    const failing = await setup({}, null);
    await failing.keeper.ended(agentRecord({ transcriptPath: failing.transcript }));
    expect(failing.runs).toHaveLength(1);
    expect(failing.sent[0]?.did).toStartWith('"the delivery metrics');
    const noClaude = await setup({ claude() { return null; } });
    await noClaude.keeper.ended(agentRecord({ transcriptPath: noClaude.transcript }));
    expect(noClaude.runs).toEqual([]);
    expect((await readLedgerFile(noClaude.deps.file)).lines.s1?.source).toBe("prompts");
  });

  test("a line that did not go through goes again at the next heartbeat, without asking Haiku again", async function () {
    let fail = true;
    const sent: LedgerLine[] = [];
    const t = await setup({ async send(line) { if (fail) throw new Error("offline"); sent.push(line); } });
    await t.keeper.ended(agentRecord({ transcriptPath: t.transcript }));
    expect(sent).toEqual([]);
    expect((await readLedgerFile(t.deps.file)).lines.s1).toBeUndefined();
    fail = false;
    await t.keeper.tick([]);
    expect(sent).toHaveLength(1);
    expect(t.runs).toHaveLength(1);
    expect((await readLedgerFile(t.deps.file)).lines.s1?.did).toBe("Fixed delivery counts that double-counted bounces.");
  });

  test("nothing is built before the Mac is paired, and a session that touched no file has no line", async function () {
    const unpaired = await setup({ ready() { return false; } });
    await unpaired.keeper.ended(agentRecord({ transcriptPath: unpaired.transcript }));
    expect(unpaired.runs).toEqual([]);
    const chat = await setup();
    await writeFile(chat.transcript, row("user", "say hi") + "\n" + row("assistant", [{ type: "text", text: "Hi!" }]) + "\n");
    await chat.keeper.ended(agentRecord({ transcriptPath: chat.transcript }));
    expect(chat.sent).toEqual([]);
    expect(chat.runs).toEqual([]);
  });

  test("Codex sessions use Codex's own note and Grok sessions their title, without Haiku", async function () {
    const t = await setup();
    const codexHome = t.deps.homes?.codex ?? "";
    await mkdir(path.join(codexHome, "memories", "rollout_summaries"), { recursive: true });
    await writeFile(path.join(codexHome, "memories", "rollout_summaries", "2026-10-18-x.md"), "thread_id: c1\n\n# Fixed double-counted bounces\n");
    const rollout = path.join(t.home, "rollout-c1.jsonl");
    await writeFile(rollout, [
      JSON.stringify({ type: "session_meta", payload: { id: "c1", cwd: CWD, git: { branch: "main" } } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix the bounces" }], internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] } } }),
      JSON.stringify({ type: "event_msg", payload: { type: "item_completed", item: { type: "FileChange", changes: { [`${CWD}/packages/email/send.ts`]: {} } } } }),
    ].join("\n") + "\n");
    await t.keeper.ended(agentRecord({ agentId: "c1", harness: "codex", transcriptPath: rollout }));
    const grokDir = path.join(t.home, "g1");
    await mkdir(grokDir, { recursive: true });
    await writeFile(path.join(grokDir, "summary.json"), JSON.stringify({ info: { cwd: CWD }, generated_title: "Coupon codes at checkout" }));
    await writeFile(path.join(grokDir, "chat_history.jsonl"), [
      JSON.stringify({ type: "user", content: [{ type: "text", text: "add coupon codes" }], prompt_index: 0 }),
      JSON.stringify({ type: "assistant", content: "", tool_calls: [{ id: "w1", name: "write", arguments: JSON.stringify({ file_path: `${CWD}/src/coupon.ts` }) }] }),
    ].join("\n") + "\n");
    await t.keeper.ended(agentRecord({ agentId: "g1", harness: "grok", transcriptPath: path.join(grokDir, "chat_history.jsonl") }));
    expect(t.sent.map(function (l) { return [l.harness, l.did, l.branch, l.areas]; })).toEqual([
      ["codex", "Fixed double-counted bounces", "main", ["packages/email"]],
      ["grok", "Coupon codes at checkout", undefined, ["src"]],
    ]);
    expect(t.runs).toEqual([]);
  });
});
