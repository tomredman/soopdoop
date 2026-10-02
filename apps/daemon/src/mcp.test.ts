import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { formatRelay, handle, TOOL } from "./mcp";
import { logRead, parseReads, prepareRead, siteUrl, SLICE_CHARS } from "./operator";
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

  test("reads only open agents with a transcript, and sends a bounded slice", async function () {
    const dir = await tempDir();
    const file = path.join(dir, "t.jsonl");
    const turn = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(3_000) }] } });
    await writeFile(file, Array.from({ length: 40 }, function () { return turn; }).join("\n"));
    const subset: Subset = new Map([
      ["a1", agentRecord({ transcriptPath: file })],
      ["a2", agentRecord({ agentId: "a2", open: false, transcriptPath: file })],
      ["a3", agentRecord({ agentId: "a3" })],
    ]);
    const read = await prepareRead(subset, "a1");
    if (!("context" in read)) throw new Error("expected a slice");
    expect(read.context.length).toBeLessThanOrEqual(SLICE_CHARS);
    expect(read.context.startsWith("assistant: xxx")).toBe(true);
    expect(await prepareRead(subset, "a2")).toEqual({ refused: "That agent is private." });
    expect(await prepareRead(subset, "a3")).toEqual({ refused: "That agent's conversation is not available yet." });
    expect(await prepareRead(subset, "gone")).toEqual({ refused: "That agent is no longer running." });
  });

  test("logs every read on this machine, without what was read", async function () {
    const home = await tempDir();
    await logRead({ relayId: "r1", agentId: "a1", sentChars: 1234 }, home);
    const line = JSON.parse((await readFile(path.join(home, "logs", "reads.log"), "utf8")).trim());
    expect(line).toMatchObject({ relayId: "r1", agentId: "a1", sentChars: 1234 });
    expect(typeof line.at).toBe("string");
  });

  test("finds the HTTP host and reads read requests defensively", function () {
    expect(siteUrl("https://fleet-skunk-723.convex.cloud")).toBe("https://fleet-skunk-723.convex.site");
    expect(parseReads([{ relayId: "r1", agentId: "a1" }, { relayId: 2 }, "x"])).toEqual([{ relayId: "r1", agentId: "a1" }]);
    expect(parseReads(null)).toEqual([]);
  });
});
