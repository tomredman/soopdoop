// ABOUTME: Tests the crew's MCP tools (crew_note, crew_notes, props) against a stand-in backend: the functions and arguments they
// ABOUTME: call, what the agent reads back, and their errors; and that the MCP server lists and runs them.
import { describe, expect, test } from "bun:test";
import { confirmByMs, crewTools, type Backend } from "./crew-tools";
import { handle, type McpTool, type Tools } from "./mcp";

function standIn(answers: Record<string, unknown> = {}, error?: Error) {
  const calls: [string, Record<string, unknown>][] = [];
  const backend: Backend = {
    async query(name, args) {
      calls.push([name, args]);
      if (error !== undefined) throw error;
      return answers[name];
    },
    async mutation(name, args) {
      calls.push([name, args]);
      if (error !== undefined) throw error;
      return answers[name];
    },
  };
  return { calls, backend };
}

function explain(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function tool(tools: McpTool[], name: string): McpTool {
  const found = tools.find(function (t) { return t.definition.name === name; });
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
}

describe("crew_note", function () {
  test("proposes the note with its tags, where it applies and when to check it; says whether it went live", async function () {
    const { calls, backend } = standIn({ "notes:propose": { noteId: "n1", status: "proposed" } });
    const t = tool(crewTools(backend, explain), "crew_note");
    const out = await t.call({ text: " The quote page uses the M10 components. ", tags: ["design", 3], applies_when: "apps/web/quote", confirm_by: "2026-11-01" });
    expect(calls).toEqual([["notes:propose", { text: "The quote page uses the M10 components.", tags: ["design"], appliesWhen: "apps/web/quote", confirmBy: Date.parse("2026-11-01T12:00:00") }]]);
    expect(out.text).toStartWith("Proposed: your user approves it in soopdoop");
    const live = standIn({ "notes:propose": { noteId: "n2", status: "live" } });
    expect((await tool(crewTools(live.backend, explain), "crew_note").call({ text: "Ship on weekdays." })).text).toStartWith("Posted: the note is live");
    expect(live.calls).toEqual([["notes:propose", { text: "Ship on weekdays." }]]);
  });

  test("refuses an empty or long note and a date it cannot read, without calling the backend", async function () {
    const { calls, backend } = standIn();
    const t = tool(crewTools(backend, explain), "crew_note");
    expect(await t.call({ text: " " })).toEqual({ text: "Give the note's text.", isError: true });
    expect((await t.call({ text: "x".repeat(401) })).isError).toBe(true);
    expect(await t.call({ text: "ok", confirm_by: "next week" })).toEqual({ text: "confirm_by is a date like 2026-11-01.", isError: true });
    expect(calls).toEqual([]);
    expect(confirmByMs(undefined)).toBeUndefined();
    expect(confirmByMs("2026-13-45")).toBeNull();
  });

  test("passes the backend's reason on: no crew, too many waiting, not paired", async function () {
    const { backend } = standIn({}, new Error("Crew notes belong to a crew. Start one in Settings → Crew."));
    expect(await tool(crewTools(backend, explain), "crew_note").call({ text: "a rule" })).toEqual({
      text: "soopdoop could not do that: Crew notes belong to a crew. Start one in Settings → Crew.", isError: true,
    });
    const unpaired = standIn({}, new Error("soopdoop is not set up on this machine: open the soopdoop app and sign in."));
    expect((await tool(crewTools(unpaired.backend, explain), "crew_notes").call({})).text).toBe("soopdoop is not set up on this machine: open the soopdoop app and sign in.");
  });
});

describe("crew_notes", function () {
  test("one note per line, newest first, with who wrote it, when, and where it applies", async function () {
    const updated = Date.parse("2026-10-16T12:00:00Z");
    const { calls, backend } = standIn({
      "notes:forDaemon": {
        now: updated + 1,
        notes: [
          { id: "n1", authorHandle: "adalovelace", text: "The quote page uses the M10 components.", tags: [], appliesWhen: "quote", createdAt: updated, updatedAt: updated },
          { id: "n2", authorHandle: "jimmy", text: "Lob postcards are $0.61.", tags: ["pricing"], createdAt: updated + 1, updatedAt: updated + 1 },
        ],
      },
    });
    const out = await tool(crewTools(backend, explain), "crew_notes").call({});
    expect(calls).toEqual([["notes:forDaemon", {}]]);
    expect(out.text.split("\n")).toEqual([
      "Your crew's live notes, newest first (2):",
      "- @jimmy (16 Oct): Lob postcards are $0.61.",
      "- @adalovelace (16 Oct): The quote page uses the M10 components. (applies when: quote)",
    ]);
    const none = standIn({ "notes:forDaemon": { now: 1, notes: [] } });
    expect((await tool(crewTools(none.backend, explain), "crew_notes").call({})).text).toBe("Your crew has no live notes yet.");
  });
});

describe("props", function () {
  test("sends one line to the wire, secrets out and cut at 200; kind is props or save", async function () {
    const { calls, backend } = standIn({ "feed:fromScout": "f1" });
    const t = tool(crewTools(backend, explain), "props");
    expect((await t.call({ kind: "props", line: "Fixed an empty CSV export   the same morning." })).text).toBe("Sent to your crew's wire as props from a customer.");
    expect((await t.call({ kind: "save", line: "y".repeat(300) })).text).toBe("Sent to your crew's wire as a save.");
    expect(await t.call({ kind: "hooray", line: "x" })).toEqual({ text: "kind is props or save.", isError: true });
    expect(await t.call({ kind: "props", line: "use sk-ant-api03-abcdefghijklmnopqrstuvwx" })).toMatchObject({ text: expect.stringContaining("Sent") });
    expect(calls.map(function ([name, args]) { return [name, args.kind, String(args.line).length]; })).toEqual([
      ["feed:fromScout", "props", "Fixed an empty CSV export the same morning.".length], ["feed:fromScout", "save", 200], ["feed:fromScout", "props", 12],
    ]);
    expect(calls[2]?.[1].line).toBe("use [secret]");
  });
});

describe("the MCP server with the crew tools", function () {
  async function never(): Promise<string> {
    throw new Error("not asked");
  }
  const idle: Tools = { ask: never, crew: never };

  test("lists them after ask_operator and crew_status, and runs them by name", async function () {
    const { backend } = standIn({ "feed:fromScout": "f1" });
    const more = crewTools(backend, explain);
    const list = await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, idle, "0", more);
    expect((list?.result as { tools: { name: string }[] }).tools.map(function (t) { return t.name; })).toEqual(["ask_operator", "crew_status", "crew_note", "crew_notes", "props"]);
    const call = await handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "props", arguments: { kind: "save", line: "Refunded a double charge." } } }, idle, "0", more);
    expect(call).toEqual({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "Sent to your crew's wire as a save." }] } });
    const bad = await handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "props", arguments: {} } }, idle, "0", more);
    expect(bad).toMatchObject({ result: { isError: true } });
  });
});
