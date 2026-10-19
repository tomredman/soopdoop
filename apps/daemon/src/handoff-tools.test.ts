// ABOUTME: Tests for the hand_off and report_back MCP tools with a stand-in backend: what each sends, what the agent reads
// ABOUTME: back, the cost from the log, and how the MCP server lists and calls them.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getFunctionName } from "convex/server";
import { appendHandoffLog, readHandoffLog } from "./handoff-log";
import { callHandoffTool, HAND_OFF_TOOL, offeredText, REPORT_BACK_TOOL, sessionIdOf, type HandoffToolDeps } from "./handoff-tools";
import { handle } from "./mcp";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "soopdoop-htools-"));
  dirs.push(dir);
  return dir;
}
afterAll(async function () {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

interface Sent {
  url: string;
  fn: string;
  args: Record<string, unknown>;
}

async function deps(over: Partial<HandoffToolDeps> & { answer?: unknown; error?: unknown } = {}): Promise<{ deps: HandoffToolDeps; sent: Sent[]; costs: unknown[][] }> {
  const sent: Sent[] = [];
  const costs: unknown[][] = [];
  const home = await tempDir();
  return {
    sent,
    costs,
    deps: {
      async config() { return { convexUrl: "https://dev.convex.cloud", token: "dtok", privateDirs: [] }; },
      async mutation(url, fn, args) {
        sent.push({ url, fn: getFunctionName(fn), args });
        if (over.error !== undefined) throw over.error;
        return over.answer ?? null;
      },
      async cost(harness, agentId, since) {
        costs.push([harness, agentId, since]);
        return 0.37;
      },
      env: { CLAUDE_CODE_SESSION_ID: "6132-abcd" },
      home,
      now() { return Date.parse("2026-10-19T11:00:00Z"); },
      ...over,
    },
  };
}

describe("the hand_off tool", function () {
  test("offers the task in the user's words, from this session, and says who got it, that they approve it, and when to expect news", async function () {
    const d = await deps({ answer: { handoffId: "h1", status: "offered", toHandle: "jimmy", targetAgentName: "email-metrics" } });
    const got = await callHandoffTool("hand_off", { handle: "@jimmy", task: " Fix the double-counted bounces (VIB-123). ", why: "he built the metrics" }, d.deps);
    expect(d.sent).toEqual([{
      url: "https://dev.convex.cloud",
      fn: "handoffs:offerFromAgent",
      args: { token: "dtok", toHandle: "jimmy", text: "Fix the double-counted bounces (VIB-123).", why: "he built the metrics", agentId: "6132-abcd" },
    }]);
    expect(got).toEqual({
      text: "Offered to @jimmy, for their email-metrics agent. @jimmy must approve it in soopdoop before it runs. You will hear back at a later prompt when it is done, declined or expired. Tell your user in a sentence and carry on; do not wait for it.",
    });
  });

  test("says when the crewmate lets this sender's hand-offs run when their agent is idle, or picks the agent", function () {
    expect(offeredText({ status: "accepted", toHandle: "jimmy", targetAgentName: "email-metrics" })).toBe(
      "@jimmy lets your hand-offs run without asking each time, so it goes to their email-metrics agent when that agent is next idle. You will hear back at a later prompt when it is done. Tell your user in a sentence and carry on; do not wait for it.",
    );
    expect(offeredText({ status: "offered", toHandle: "jimmy" })).toBe(
      "Offered to @jimmy; they pick which of their agents runs it. @jimmy must approve it in soopdoop before it runs. You will hear back at a later prompt when it is done, declined or expired. Tell your user in a sentence and carry on; do not wait for it.",
    );
  });

  test("passes the backend's reason on, and asks for what is missing", async function () {
    const refused = await deps({ error: Object.assign(new Error("x"), { data: "@jimmy has turned hand-offs from you off." }) });
    expect(await callHandoffTool("hand_off", { handle: "jimmy", task: "t" }, refused.deps)).toEqual({ text: "Could not offer the hand-off: @jimmy has turned hand-offs from you off.", isError: true });
    const d = await deps();
    expect(await callHandoffTool("hand_off", { task: "t" }, d.deps)).toMatchObject({ isError: true, text: "Say whose agent should do it: their @handle (crew_status lists them)." });
    expect(await callHandoffTool("hand_off", { handle: "jimmy", task: "  " }, d.deps)).toMatchObject({ isError: true, text: "Say what the task is." });
    const unpaired = await deps({ async config() { return null; } });
    expect(await callHandoffTool("hand_off", { handle: "jimmy", task: "t" }, unpaired.deps)).toMatchObject({ isError: true });
    expect(d.sent).toEqual([]);
  });

  test("from Codex, which tells its MCP servers no thread id, the offer names no session", async function () {
    const d = await deps({ env: {} });
    await callHandoffTool("hand_off", { handle: "jimmy", task: "t" }, d.deps);
    expect(d.sent[0]?.args).toEqual({ token: "dtok", toHandle: "jimmy", text: "t" });
    expect(sessionIdOf({ CLAUDE_CODE_SESSION_ID: "../x" })).toBeUndefined();
  });
});

describe("the report_back tool", function () {
  test("reports the summary and links with what the hand-off cost since it reached this agent, logs it, and thanks the agent", async function () {
    const d = await deps();
    const at = Date.parse("2026-10-19T10:00:00Z");
    await appendHandoffLog({ at, event: "delivered", handoffId: "h1", fromHandle: "ada", agentId: "s1", harness: "claude-code", channel: "socket", chars: 300 }, d.deps.home);
    const got = await callHandoffTool("report_back", { handoff_id: "h1", summary: "Fixed it in metrics.ts.", links: ["https://github.com/acme/vibes/pull/418", 3] }, d.deps);
    expect(d.costs).toEqual([["claude-code", "s1", at]]);
    expect(d.sent).toEqual([{
      url: "https://dev.convex.cloud",
      fn: "handoffs:reportBack",
      args: { token: "dtok", handoffId: "h1", summary: "Fixed it in metrics.ts.", links: ["https://github.com/acme/vibes/pull/418"], usd: 0.37 },
    }]);
    expect(got).toEqual({ text: "Reported back to @ada. The hand-off is done; tell your user in a sentence." });
    expect((await readHandoffLog(d.deps.home)).at(-1)).toEqual({ at: Date.parse("2026-10-19T11:00:00Z"), event: "reported", handoffId: "h1", by: "agent", chars: 23, agentId: "s1", usd: 0.37 });
  });

  test("an agent that did not do the task says done false: the hand-off fails with its words as the note, never done", async function () {
    const d = await deps();
    const at = Date.parse("2026-10-19T10:00:00Z");
    await appendHandoffLog({ at, event: "delivered", handoffId: "h1", fromHandle: "ada", agentId: "s1", harness: "claude-code", channel: "socket", chars: 300 }, d.deps.home);
    const got = await callHandoffTool("report_back", { handoff_id: "h1", summary: "There is no production database on this Mac.", done: false, links: ["https://github.com/acme/vibes/pull/1"] }, d.deps);
    expect(d.sent).toEqual([{ url: "https://dev.convex.cloud", fn: "handoffs:failed", args: { token: "dtok", handoffId: "h1", note: "There is no production database on this Mac." } }]);
    expect(got).toEqual({ text: "Reported back to @ada that it was not done, and why. Tell your user in a sentence." });
    // Settled on this Mac, with its cost for the allowance, and none of the agent's words.
    expect((await readHandoffLog(d.deps.home)).at(-1)).toEqual({ at: Date.parse("2026-10-19T11:00:00Z"), event: "failed", handoffId: "h1", by: "agent", chars: 44, agentId: "s1", usd: 0.37 });
    // Only false says it was not done.
    const yes = await deps();
    await callHandoffTool("report_back", { handoff_id: "h2", summary: "Done.", done: true }, yes.deps);
    expect(yes.sent[0]?.fn).toBe("handoffs:reportBack");
    expect(REPORT_BACK_TOOL.inputSchema.properties.done.type).toBe("boolean");
  });

  test("a hand-off this Mac has no record of is reported without a cost; errors come back as errors", async function () {
    const d = await deps();
    await callHandoffTool("report_back", { handoff_id: "h2", summary: "Could not find the file." }, d.deps);
    expect(d.sent[0]?.args).toEqual({ token: "dtok", handoffId: "h2", summary: "Could not find the file." });
    expect(d.costs).toEqual([]);
    const refused = await deps({ error: Object.assign(new Error("x"), { data: "This Mac has no such hand-off." }) });
    expect(await callHandoffTool("report_back", { handoff_id: "h3", summary: "s" }, refused.deps)).toEqual({ text: "Could not report back: This Mac has no such hand-off.", isError: true });
    expect(await readHandoffLog(refused.deps.home)).toEqual([]);
    expect(await callHandoffTool("report_back", { summary: "s" }, d.deps)).toMatchObject({ isError: true, text: "Give the handoff_id from the hand-off message." });
    expect(await callHandoffTool("report_back", { handoff_id: "h1" }, d.deps)).toMatchObject({ isError: true });
  });
});

describe("in the MCP server", function () {
  test("both tools are listed and called through tools/call; other names are not theirs", async function () {
    const calls: unknown[] = [];
    async function never(): Promise<string> {
      throw new Error("not asked");
    }
    const tools = {
      ask: never,
      crew: never,
      async handoff(name: unknown, args: Record<string, unknown>) {
        calls.push([name, args]);
        return name === "report_back" ? { text: "Reported back." } : null;
      },
    };
    const list = await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, tools, "0");
    expect(list).toMatchObject({ result: { tools: expect.arrayContaining([HAND_OFF_TOOL, REPORT_BACK_TOOL]) } });
    expect(await handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "report_back", arguments: { handoff_id: "h1", summary: "s" } } }, tools, "0"))
      .toEqual({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "Reported back." }] } });
    expect(await handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope", arguments: {} } }, tools, "0")).toMatchObject({ error: { code: -32602 } });
    expect(calls).toEqual([["report_back", { handoff_id: "h1", summary: "s" }], ["nope", {}]]);
    const failing = { ...tools, async handoff() { return { text: "Could not report back: no.", isError: true }; } };
    expect(await handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "report_back", arguments: {} } }, failing, "0"))
      .toEqual({ jsonrpc: "2.0", id: 4, result: { content: [{ type: "text", text: "Could not report back: no." }], isError: true } });
  });
});
