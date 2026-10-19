import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Asked } from "./ask";
import { HANDOFF_TOOLS } from "./handoff-tools";
import { askWaitMs, cleanError, CREW_TOOL, formatCrew, formatRelay, handle, TOOL, type Tools } from "./mcp";
import { logRead, parseReads, prepareAnswer, siteUrl, summaryFor } from "./operator";
import type { AgentRecord, Subset } from "./state";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "soopdoop-mcp-"));
  dirs.push(dir);
  return dir;
}
afterAll(async function () {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function never(): Promise<string> {
  throw new Error("not asked");
}
const idle: Tools = { ask: never, crew: never };

describe("the ask_operator MCP server", function () {
  test("introduces itself, lists its tools, and answers pings", async function () {
    const init = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, idle, "0.2.0");
    expect(init).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "soopdoop", version: "0.2.0" } },
    });
    expect(await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }, idle, "0")).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [TOOL, CREW_TOOL, ...HANDOFF_TOOLS] } });
    expect(await handle({ jsonrpc: "2.0", id: 3, method: "ping" }, idle, "0")).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
    // Notifications get no answer.
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, idle, "0")).toBeNull();
    expect(await handle({ jsonrpc: "2.0", id: 4, method: "resources/list" }, idle, "0")).toMatchObject({ error: { code: -32601 } });
  });

  test("passes the question to the Operator and returns its answer as text", async function () {
    const asked: string[] = [];
    async function ask(q: string): Promise<string> {
      asked.push(q);
      return "It is in select.ts.";
    }
    const tools: Tools = { ask, crew: never };
    const call = { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "ask_operator", arguments: { question: "where?" } } };
    expect(await handle(call, tools, "0")).toEqual({ jsonrpc: "2.0", id: 5, result: { content: [{ type: "text", text: "It is in select.ts." }] } });
    expect(asked).toEqual(["where?"]);
    const empty = { ...call, params: { name: "ask_operator", arguments: { question: " " } } };
    expect(await handle(empty, tools, "0")).toMatchObject({ result: { isError: true } });
    expect(await handle({ ...call, params: { name: "other" } }, tools, "0")).toMatchObject({ error: { code: -32602 } });
  });

  test("lists the crew, with no arguments", async function () {
    async function crew(): Promise<string> {
      return "Your crew (you are @tom):";
    }
    const call = { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "crew_status", arguments: {} } };
    expect(await handle(call, { ask: never, crew }, "0")).toEqual({ jsonrpc: "2.0", id: 6, result: { content: [{ type: "text", text: "Your crew (you are @tom):" }] } });
    expect(await handle({ ...call, params: { name: "crew_status" } }, { ask: never, crew }, "0")).toMatchObject({ result: { content: [{ type: "text" }] } });
  });

  test("shows each crewmate's handle, name and state, one line each", function () {
    expect(formatCrew({
      me: "tom",
      crew: [
        { handle: "jimmy", led: "b", inFocus: false, agentCount: 0 },
        { handle: "adalovelace", name: "Ada Lovelace", led: "g", inFocus: false, agentCount: 3 },
        { handle: "ana", led: "b", inFocus: false, agentCount: 1 },
        { handle: "galois", name: "Évariste Galois", led: "x", inFocus: true, agentCount: 0 },
        { handle: "zed", led: "x", inFocus: false, agentCount: 0 },
      ],
    })).toBe([
      "Your crew (you are @tom):",
      "- @jimmy: online, no open agents",
      "- @adalovelace (Ada Lovelace): 3 open agents, working",
      "- @ana: 1 open agent, idle",
      "- @galois (Évariste Galois): in focus mode",
      "- @zed: offline",
      "",
      "To ask about one crewmate's work, put their @handle in your ask_operator question.",
    ].join("\n"));
    expect(formatCrew({ me: "tom", crew: [] })).toContain("your crew is empty");
  });

  test("reads back what happened in plain words", function () {
    expect(formatRelay({ status: "answered", answer: "In select.ts.", targetHandle: "jimmy", targetAgentName: "listing-cards" })).toBe(
      "In select.ts.\n\n(@jimmy's listing-cards agent answered this, through the soopdoop Operator.)",
    );
    expect(formatRelay({ status: "answered", answer: "In select.ts.", targetHandle: "jimmy" })).toContain("@jimmy's agent");
    expect(formatRelay({ status: "not-found", targetHandle: "jimmy", note: "It did not come up." })).toBe(
      "@jimmy's agent did not know: It did not come up. Work it out yourself.",
    );
    expect(formatRelay({ status: "nobody", note: "No crewmate has an open agent running right now." })).toBe(
      "No crewmate has an open agent running right now. Work it out yourself.",
    );
    // The Operator's own answer: how to pass it on and ask more, never how it was found.
    expect(formatRelay({ status: "answered", answer: "Jimmy (@jimmy) has an agent on checkout right now. What would you like to know?", byOperator: true })).toBe(
      "Jimmy (@jimmy) has an agent on checkout right now. What would you like to know?\n\n" +
        "(From the soopdoop Operator. Pass it on to your user in a sentence or two. To ask a crewmate's agent something, call ask_operator with the question and their @handle.)",
    );
    // A handle the Operator could not place: fix it and ask again, rather than give up.
    expect(formatRelay({ status: "nobody", note: "Nobody in your crew is @bob. Your crew: @adalovelace.", askAgain: true })).toBe(
      "Nobody in your crew is @bob. Your crew: @adalovelace. Ask again with the right @handle.",
    );
  });

  test("speaks JSON-RPC over stdio, one message per line", async function () {
    const proc = Bun.spawn([process.execPath, path.join(import.meta.dir, "mcp.ts")], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    proc.stdin.end();
    const out = (await new Response(proc.stdout).text()).trim().split("\n").map(function (l) { return JSON.parse(l); });
    expect(out.map(function (m) { return m.id; })).toEqual([1, 2]);
    expect(out[1].result.tools.map(function (t: { name: string }) { return t.name; })).toEqual(["ask_operator", "crew_status", "hand_off", "report_back"]);
    await proc.exited;
  });
});

describe("the daemon's side of the Operator", function () {
  function agentRecord(over: Partial<AgentRecord>): AgentRecord {
    return { agentId: "a1", harness: "claude-code", name: "listing-cards", status: "idle", open: true, lastTurnAt: 0, ...over };
  }

  test("asks only open agents with a conversation, and only with the question", async function () {
    const asked: [string, string][] = [];
    async function ask(agent: AgentRecord, question: string): Promise<Asked> {
      asked.push([agent.agentId, question]);
      return { answer: "In select.ts.", tokensRead: 1200 };
    }
    const subset: Subset = new Map([
      ["a1", agentRecord({ transcriptPath: "/t.jsonl" })],
      ["a2", agentRecord({ agentId: "a2", open: false, transcriptPath: "/t.jsonl" })],
      ["a3", agentRecord({ agentId: "a3" })],
    ]);
    const question = "Where are expired listings filtered?";
    // No transcript anywhere on this machine for a3.
    async function nowhere(): Promise<string | null> {
      return null;
    }
    expect(await prepareAnswer(subset, { relayId: "r1", agentId: "a1", question }, ask, nowhere)).toEqual({ answer: "In select.ts.", tokensRead: 1200 });
    expect(await prepareAnswer(subset, { relayId: "r2", agentId: "a2", question }, ask, nowhere)).toEqual({ refused: "That agent is private." });
    expect(await prepareAnswer(subset, { relayId: "r3", agentId: "a3", question }, ask, nowhere)).toEqual({ refused: "That agent's conversation is not available yet." });
    expect(await prepareAnswer(subset, { relayId: "r4", agentId: "gone", question }, ask, nowhere)).toEqual({ refused: "That agent is no longer running." });
    expect(await prepareAnswer(subset, { relayId: "r5", agentId: "a1" }, ask, nowhere)).toEqual({ refused: "The Operator did not send the question." });
    expect(asked).toEqual([["a1", question]]);
  });

  test("a Grok agent's hook names no transcript: it is found in Grok's folder, kept, and the agent is asked with it", async function () {
    const seen: (string | undefined)[] = [];
    async function ask(agent: AgentRecord): Promise<Asked> {
      seen.push(agent.transcriptPath);
      return { answer: "In select.ts." };
    }
    const looked: [string, string, string | undefined][] = [];
    async function find(harness: string, sessionId: string, cwd?: string): Promise<string | null> {
      looked.push([harness, sessionId, cwd]);
      return "/Users/ada/.grok/sessions/%2Fr%2Fvibes/g1/chat_history.jsonl";
    }
    const subset: Subset = new Map([["g1", agentRecord({ agentId: "g1", harness: "grok", cwd: "/r/vibes" })]]);
    expect(await prepareAnswer(subset, { relayId: "r1", agentId: "g1", question: "where?" }, ask, find)).toEqual({ answer: "In select.ts." });
    expect(looked).toEqual([["grok", "g1", "/r/vibes"]]);
    expect(seen).toEqual(["/Users/ada/.grok/sessions/%2Fr%2Fvibes/g1/chat_history.jsonl"]);
    expect(subset.get("g1")?.transcriptPath).toBe("/Users/ada/.grok/sessions/%2Fr%2Fvibes/g1/chat_history.jsonl");
  });

  test("routing summaries come from each harness's own transcript", async function () {
    const dir = await tempDir();
    const rollout = path.join(dir, "rollout-2026-10-18T09-00-00-c1.jsonl");
    await writeFile(rollout, [
      JSON.stringify({ type: "session_meta", payload: { id: "c1", cwd: "/Users/ada/projects/vibes", git: { branch: "feat/coupons" } } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "add coupon codes" }], internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] } } }),
    ].join("\n") + "\n");
    const subset: Subset = new Map([
      ["c1", agentRecord({ agentId: "c1", harness: "codex", transcriptPath: rollout })],
      ["c2", agentRecord({ agentId: "c2", harness: "codex", open: false, transcriptPath: rollout })],
    ]);
    async function nowhere(): Promise<string | null> {
      return null;
    }
    expect(await summaryFor(subset, "c1", nowhere)).toBe('vibes@feat/coupons · "add coupon codes"');
    expect(await summaryFor(subset, "c2", nowhere)).toBeNull();
    subset.set("g1", agentRecord({ agentId: "g1", harness: "grok" }));
    expect(await summaryFor(subset, "g1", nowhere)).toBeNull();
  });

  test("waits less than Codex's 60-second tool limit when Codex starts the server", function () {
    expect(askWaitMs({})).toBe(75_000);
    expect(askWaitMs({ SOOPDOOP_ASK_WAIT_MS: "50000" })).toBe(50_000);
    expect(askWaitMs({ SOOPDOOP_ASK_WAIT_MS: "nonsense" })).toBe(75_000);
    expect(askWaitMs({ SOOPDOOP_ASK_WAIT_MS: "999999" })).toBe(75_000);
  });

  test("logs every ask on this machine, without the question or the answer", async function () {
    const home = await tempDir();
    await logRead({ relayId: "r1", agentId: "a1", sentChars: 1234, tokensRead: 50_000 }, home);
    const line = JSON.parse((await readFile(path.join(home, "logs", "reads.log"), "utf8")).trim());
    expect(line).toMatchObject({ relayId: "r1", agentId: "a1", sentChars: 1234, tokensRead: 50_000 });
    expect(typeof line.at).toBe("string");
  });

  test("finds the HTTP host and reads questions defensively", function () {
    expect(siteUrl("https://fleet-skunk-723.convex.cloud")).toBe("https://fleet-skunk-723.convex.site");
    expect(parseReads([{ relayId: "r1", agentId: "a1", question: "where?" }, { relayId: "r2", agentId: "a2" }, { relayId: 2 }, "x"])).toEqual([
      { relayId: "r1", agentId: "a1", question: "where?" },
      { relayId: "r2", agentId: "a2" },
    ]);
    expect(parseReads(null)).toEqual([]);
  });
});

describe("cleanError", function () {
  test("shows a ConvexError's message, which production deployments pass on as data", function () {
    expect(cleanError(Object.assign(new Error("[CONVEX M(operator:ask)] [Request ID: 1] Server Error"), { data: "That is a lot of questions. Wait a minute." })))
      .toBe("That is a lot of questions. Wait a minute.");
    expect(cleanError(new Error("[CONVEX M(operator:ask)] [Request ID: 1] Server Error\nUncaught Error: Ask a question.\n  at handler"))).toBe("Ask a question.");
  });
});
