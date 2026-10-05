import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Asked } from "./ask";
import { cleanError, formatRelay, handle, TOOL } from "./mcp";
import { logRead, parseReads, prepareAnswer, siteUrl } from "./operator";
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

describe("the ask_operator MCP server", function () {
  test("introduces itself, lists its one tool, and answers pings", async function () {
    const init = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, never, "0.2.0");
    expect(init).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "soopdoop", version: "0.2.0" } },
    });
    expect(await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }, never, "0")).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [TOOL] } });
    expect(await handle({ jsonrpc: "2.0", id: 3, method: "ping" }, never, "0")).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
    // Notifications get no answer.
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, never, "0")).toBeNull();
    expect(await handle({ jsonrpc: "2.0", id: 4, method: "resources/list" }, never, "0")).toMatchObject({ error: { code: -32601 } });
  });

  test("passes the question to the Operator and returns its answer as text", async function () {
    const asked: string[] = [];
    async function ask(q: string): Promise<string> {
      asked.push(q);
      return "It is in select.ts.";
    }
    const call = { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "ask_operator", arguments: { question: "where?" } } };
    expect(await handle(call, ask, "0")).toEqual({ jsonrpc: "2.0", id: 5, result: { content: [{ type: "text", text: "It is in select.ts." }] } });
    expect(asked).toEqual(["where?"]);
    const empty = { ...call, params: { name: "ask_operator", arguments: { question: " " } } };
    expect(await handle(empty, ask, "0")).toMatchObject({ result: { isError: true } });
    expect(await handle({ ...call, params: { name: "other" } }, ask, "0")).toMatchObject({ error: { code: -32602 } });
  });

  test("reads back what happened in plain words", function () {
    expect(formatRelay({ status: "answered", answer: "In select.ts.", targetHandle: "jimmy", targetAgentName: "listing-cards" })).toBe(
      "In select.ts.\n\n(Answered from @jimmy's listing-cards by the soopdoop Operator.)",
    );
    expect(formatRelay({ status: "answered", answer: "In select.ts.", targetHandle: "jimmy" })).toContain("@jimmy's agent");
    expect(formatRelay({ status: "not-found", targetHandle: "jimmy", note: "It did not come up." })).toBe(
      "@jimmy's agent did not know: It did not come up. Work it out yourself.",
    );
    expect(formatRelay({ status: "nobody", note: "No crewmate has an open agent running right now." })).toBe(
      "No crewmate has an open agent running right now. Work it out yourself.",
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
    expect(out[1].result.tools[0].name).toBe("ask_operator");
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
    expect(await prepareAnswer(subset, { relayId: "r1", agentId: "a1", question }, ask)).toEqual({ answer: "In select.ts.", tokensRead: 1200 });
    expect(await prepareAnswer(subset, { relayId: "r2", agentId: "a2", question }, ask)).toEqual({ refused: "That agent is private." });
    expect(await prepareAnswer(subset, { relayId: "r3", agentId: "a3", question }, ask)).toEqual({ refused: "That agent's conversation is not available yet." });
    expect(await prepareAnswer(subset, { relayId: "r4", agentId: "gone", question }, ask)).toEqual({ refused: "That agent is no longer running." });
    expect(await prepareAnswer(subset, { relayId: "r5", agentId: "a1" }, ask)).toEqual({ refused: "The Operator did not send the question." });
    expect(asked).toEqual([["a1", question]]);
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
