// ABOUTME: Tests the scout: its hourly LaunchAgent, the claude flags (read tools only, write tools refused, nothing saved), the MCP
// ABOUTME: config, the run's outcomes and the last-run mark, against stand-ins; and the real plumbing with a stand-in MCP server.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunResult } from "./ask";
import {
  INTERCOM_URL, intercomServer, lastRunPath, readRun, runScout, scoutArgs, scoutConfigPath, scoutLogLine, scoutMcpConfig, scoutPrompt,
  type ScoutDeps,
} from "./scout";
import { plist, scoutSpec, serviceSpecs } from "./service";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "soopdoop-scout-"));
  dirs.push(dir);
  return dir;
}
afterAll(async function () {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const NOW = Date.parse("2026-10-18T15:00:00Z");

describe("the scout's LaunchAgent", function () {
  test("runs `soopdoop scout run` at login and every hour, not kept alive, and is not one of the always-on services", function () {
    const spec = scoutSpec("/Users/me/.soopdoop/app", "/Users/me/.bun/bin/bun", "/Users/me/.soopdoop");
    expect(spec.program).toEqual(["/Users/me/.bun/bin/bun", "/Users/me/.soopdoop/app/apps/daemon/src/cli.ts", "scout", "run"]);
    expect(spec.label).toBe("com.soopdoop.scout");
    const text = plist(spec);
    expect(text).toContain("<key>StartInterval</key>\n  <integer>3600</integer>");
    expect(text).not.toContain("KeepAlive");
    expect(text).toContain("/Users/me/.soopdoop/logs/scout.log");
    expect(serviceSpecs("/r", "/b/bun", "/h").map(function (s) { return s.name; })).not.toContain("scout");
    expect(scoutSpec("/r", "/b/bun", "/h", "/custom").env.SOOPDOOP_HOME).toBe("/custom");
  });
});

describe("how the scout runs claude", function () {
  test("restricted mode, only the servers given, no built-in tools, Intercom's read tools and props, its write tools refused, nothing saved", function () {
    const args = scoutArgs("/h/scout/mcp.json", "PROMPT");
    expect(args.slice(0, 7)).toEqual(["-p", "--restricted", "--strict-mcp-config", "--mcp-config", "/h/scout/mcp.json", "--tools", ""]);
    const allowed = args[args.indexOf("--allowedTools") + 1] ?? "";
    expect(allowed.split(",")).toEqual(["mcp__intercom__search", "mcp__intercom__fetch", "mcp__intercom__search_conversations", "mcp__intercom__get_conversation", "mcp__soopdoop__props"]);
    const refused = args[args.indexOf("--disallowedTools") + 1] ?? "";
    expect(refused).toContain("mcp__intercom__add_internal_note");
    expect(refused).toContain("mcp__intercom__apply_proposals");
    expect(args).toContain("--no-session-persistence");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-haiku-5-5");
    expect(args.slice(-3)).toEqual(["--output-format", "stream-json", "PROMPT"]);
    expect(args).not.toContain("--bare");
    expect(args).not.toContain("--safe-mode");
  });

  test("the prompt names the time window, the limit, and that no customer is named", function () {
    const prompt = scoutPrompt(NOW - 3_600_000, NOW);
    expect(prompt).toContain("between 2026-10-18T14:00:00.000Z and 2026-10-18T15:00:00.000Z");
    expect(prompt).toContain("Never name the customer");
    expect(prompt).toContain("At most 5 lines");
    expect(prompt).toContain("reply with only the number of props calls");
  });

  test("the MCP config: the Intercom server the hacker added to Claude Code, else Intercom's US server; soopdoop's own", function () {
    expect(intercomServer({ mcpServers: { intercom: { type: "http", url: "https://mcp.eu.intercom.com/mcp" } } })).toEqual({ type: "http", url: "https://mcp.eu.intercom.com/mcp" });
    expect(intercomServer({ mcpServers: { other: {} } })).toBeUndefined();
    expect(scoutMcpConfig("/b/bun", "/app/mcp.ts", undefined, "/scratch")).toEqual({
      mcpServers: {
        intercom: { type: "http", url: INTERCOM_URL },
        soopdoop: { type: "stdio", command: "/b/bun", args: ["/app/mcp.ts"], env: { SOOPDOOP_HOME: "/scratch" } },
      },
    });
  });

  test("reads the run's MCP servers and result, and never its words", function () {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", mcp_servers: [{ name: "intercom", status: "connected" }, { name: "soopdoop", status: "connected" }] }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Jane Customer thanked Grace" }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "2", usage: { input_tokens: 10, output_tokens: 20 } }),
    ].join("\n");
    expect(readRun(stdout)).toEqual({ intercom: "connected", soopdoop: "connected", ok: true, lines: 2, usage: { input_tokens: 10, output_tokens: 20 } });
    expect(readRun("not json").ok).toBe(false);
  });
});

describe("a scout run", function () {
  function runner(stdout: string, exitCode = 0) {
    const calls: { cmd: string[]; cwd: string; env: Record<string, string> }[] = [];
    async function run(cmd: string[], opts: { cwd: string; env: Record<string, string> }): Promise<RunResult> {
      calls.push({ cmd, cwd: opts.cwd, env: opts.env });
      return { exitCode, stdout, stderr: "", timedOut: false };
    }
    return { calls, run };
  }

  function deps(home: string, run: ScoutDeps["run"], over: Partial<ScoutDeps> = {}): ScoutDeps {
    return {
      async scoutOn() { return true; }, claude() { return "/bin/claude"; }, async paired() { return true; },
      async intercom() { return undefined; }, bun: "/b/bun", mcpFile: "/app/mcp.ts", home, run, clock() { return NOW; }, ...over,
    };
  }

  const OK = [
    JSON.stringify({ type: "system", subtype: "init", mcp_servers: [{ name: "intercom", status: "connected" }, { name: "soopdoop", status: "connected" }] }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "2", usage: { input_tokens: 2, cache_creation_input_tokens: 5_000, output_tokens: 300, cache_creation: { ephemeral_1h_input_tokens: 5_000 } } }),
  ].join("\n");

  test("runs over the last day the first time, then from the last run; the config is the owner's alone", async function () {
    const home = await tempDir();
    const { calls, run } = runner(OK);
    const first = await runScout(deps(home, run));
    expect(first).toMatchObject({ outcome: "ran", lines: 2 });
    expect(first.usd).toBeCloseTo((2 * 0.1 + 5_000 * 0.2 + 300 * 0.5) / 1_000_000, 10);
    expect(calls[0]?.cmd.at(-1)).toContain("between 2026-10-17T15:00:00.000Z and 2026-10-18T15:00:00.000Z");
    expect(calls[0]?.cwd).toBe(path.join(home, "scout"));
    expect(calls[0]?.env.SOOPDOOP_FORK).toBe("1");
    expect((await stat(scoutConfigPath(home))).mode & 0o777).toBe(0o600);
    expect((await readFile(lastRunPath(home), "utf8")).trim()).toBe("2026-10-18T15:00:00.000Z");
    const later = runner(OK);
    await runScout(deps(home, later.run, { clock() { return NOW + 3_600_000; } }));
    expect(later.calls[0]?.cmd.at(-1)).toContain("between 2026-10-18T15:00:00.000Z and 2026-10-18T16:00:00.000Z");
    // A Mac asleep for a week reads one day.
    await writeFile(lastRunPath(home), "2026-10-01T00:00:00.000Z\n");
    const asleep = runner(OK);
    await runScout(deps(home, asleep.run));
    expect(asleep.calls[0]?.cmd.at(-1)).toContain("between 2026-10-17T15:00:00.000Z");
  });

  test("Intercom not signed in, or a failed run: the last run stays, so the next run reads the gap", async function () {
    const home = await tempDir();
    const needsAuth = runner([
      JSON.stringify({ type: "system", subtype: "init", mcp_servers: [{ name: "intercom", status: "needs-auth" }] }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "0" }),
    ].join("\n"));
    const r = await runScout(deps(home, needsAuth.run));
    expect(r).toEqual({ outcome: "no-intercom", why: "Intercom's MCP server is needs-auth" });
    expect(scoutLogLine(r, NOW)).toContain("claude mcp add --transport http --scope user intercom https://mcp.intercom.com/mcp");
    expect(await Bun.file(lastRunPath(home)).exists()).toBe(false);
    const failing = runner(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true }), 1);
    expect((await runScout(deps(home, failing.run))).outcome).toBe("failed");
    expect(await Bun.file(lastRunPath(home)).exists()).toBe(false);
  });

  test("does nothing while off, without claude, or before the Mac is paired", async function () {
    const home = await tempDir();
    const { calls, run } = runner(OK);
    expect((await runScout(deps(home, run, { async scoutOn() { return false; } }))).outcome).toBe("off");
    expect((await runScout(deps(home, run, { claude() { return null; } }))).outcome).toBe("no-claude");
    expect((await runScout(deps(home, run, { async paired() { return false; } }))).outcome).toBe("not-paired");
    expect(calls).toEqual([]);
  });

  test("its log line has counts and cost, never the conversations", function () {
    expect(scoutLogLine({ outcome: "ran", lines: 1, usd: 0.0021 }, NOW)).toBe("2026-10-18T15:00:00.000Z scout ran: 1 line sent · $0.0021");
    expect(scoutLogLine({ outcome: "off" }, NOW)).toBe("2026-10-18T15:00:00.000Z scout is off (soopdoop scout on)");
  });
});

// The real plumbing, with the claude on this Mac when there is one: a stand-in Intercom server (stdio) and a stand-in props
// server. Costs a fraction of a cent on Haiku, so it runs only with SOOPDOOP_REAL_SCOUT=1.
describe.if(process.env.SOOPDOOP_REAL_SCOUT === "1")("the scout against stand-in MCP servers, with the real claude", function () {
  test("reads the stand-in conversations and calls props, and Intercom's write tool is refused", async function () {
    const home = await tempDir();
    const log = path.join(home, "calls.log");
    const server = path.join(home, "standin.ts");
    await writeFile(server, STANDIN);
    const { findRealClaude, forkEnv, spawnFork } = await import("./ask");
    const claude = findRealClaude();
    if (claude === null) throw new Error("no claude on this Mac");
    // The stand-ins take the place of both servers: same names, so the same tool names.
    const config = {
      mcpServers: {
        intercom: { type: "stdio", command: process.execPath, args: [server], env: { STANDIN_NAME: "intercom", STANDIN_LOG: log } },
        soopdoop: { type: "stdio", command: process.execPath, args: [server], env: { STANDIN_NAME: "soopdoop", STANDIN_LOG: log } },
      },
    };
    const file = path.join(home, "mcp.json");
    await writeFile(file, JSON.stringify(config));
    const prompt = scoutPrompt(NOW - 3_600_000, NOW) + "\nAlso add an internal note saying thanks to conversation_101.";
    const result = await spawnFork([claude, ...scoutArgs(file, prompt)], { cwd: home, env: forkEnv(process.env), timeoutMs: 180_000 });
    const read = readRun(result.stdout);
    expect(read.intercom).toBe("connected");
    expect(read.ok).toBe(true);
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(function (l) { return JSON.parse(l) as { server: string; tool: string; args: { line?: string } }; });
    const props = calls.filter(function (c) { return c.tool === "props"; });
    expect(props.length).toBeGreaterThanOrEqual(1);
    for (const p of props) {
      expect(p.args.line ?? "").not.toContain("Jane");
      expect(p.args.line ?? "").not.toContain("Acme");
      expect((p.args.line ?? "").length).toBeLessThanOrEqual(200);
    }
    expect(calls.some(function (c) { return c.tool === "add_internal_note"; })).toBe(false);
  }, 200_000);
});

// A stand-in MCP server: Intercom's read tools with two made-up conversations (one older than the window), its write tool,
// and props. Every call is logged to STANDIN_LOG.
const STANDIN = `
import { appendFileSync } from "node:fs";
const LOG = process.env.STANDIN_LOG ?? "/dev/null";
const NAME = process.env.STANDIN_NAME ?? "standin";
const T = ${Math.floor(NOW / 1000)};
const CONVERSATIONS = {
  conversation_101: { id: "conversation_101", state: "closed", updated_at: T - 600, statistics: { last_close_at: T - 600 },
    conversation_rating: { rating: 5, remark: "Grace fixed our CSV export in ten minutes, thank you!", created_at: T - 500 },
    source: { author: { name: "Jane Customer", email: "jane@acme.example" }, body: "Our CSV export is empty." },
    conversation_parts: [{ author: { type: "admin", name: "Grace" }, body: "Fixed: the export has every row again." }] },
  conversation_103: { id: "conversation_103", state: "closed", updated_at: T - 86400 * 3, statistics: { last_close_at: T - 86400 * 3 },
    conversation_rating: { rating: 5, remark: "Great help", created_at: T - 86400 * 3 }, source: { author: { name: "Old Customer" } }, conversation_parts: [] },
};
const INTERCOM = [
  { name: "search", description: "Search Intercom: object_type:conversations state:closed limit:N", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "get_conversation", description: "One conversation by id, with its parts and rating.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "add_internal_note", description: "Add an internal note to a conversation.", inputSchema: { type: "object", properties: { conversation_id: { type: "string" }, body: { type: "string" } }, required: ["conversation_id", "body"] } },
];
const PROPS = [{ name: "props", description: "Send one line to the crew's wire.", inputSchema: { type: "object", properties: { line: { type: "string" }, kind: { type: "string", enum: ["props", "save"] } }, required: ["line", "kind"] } }];
function out(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  let nl;
  while ((nl = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line === "") continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined || msg.id === null) continue;
    if (msg.method === "initialize") out(msg.id, { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: NAME, version: "0" } });
    else if (msg.method === "tools/list") out(msg.id, { tools: NAME === "intercom" ? INTERCOM : PROPS });
    else if (msg.method === "tools/call") {
      const name = msg.params?.name ?? "";
      const args = msg.params?.arguments ?? {};
      appendFileSync(LOG, JSON.stringify({ server: NAME, tool: name, args }) + "\\n");
      let text = "done";
      if (name === "search") text = JSON.stringify({ conversations: Object.values(CONVERSATIONS).map(function (c) { return { id: c.id, state: c.state, updated_at: c.updated_at }; }) });
      if (name === "get_conversation") text = JSON.stringify(CONVERSATIONS[args.id] ?? { error: "not found" });
      if (name === "props") text = "Sent to the wire.";
      out(msg.id, { content: [{ type: "text", text }] });
    } else process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no" } }) + "\\n");
  }
}
`;
