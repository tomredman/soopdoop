// ABOUTME: The scout: every hour, when this Mac's hacker turned it on, Claude Haiku on their own Claude account reads Intercom (its MCP
// ABOUTME: server) for conversations closed or rated since the last run and sends props or saves to the crew's wire. Only those lines leave.
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { forkEnv, spawnFork, type Run } from "./ask";
import { readConfig, soopdoopHome } from "./config";
import { answerCost } from "./fund";
import { LEDGER_MODEL } from "./ledger-local";
import { isRecord } from "./state";

// Intercom's MCP server, US workspaces (developers.intercom.com/docs/guides/mcp, read 18 Oct 2026). EU workspaces use
// https://mcp.eu.intercom.com/mcp; the scout uses whichever one the hacker added to Claude Code.
export const INTERCOM_URL = "https://mcp.intercom.com/mcp";
export const MAX_LINES = 5;
// A Mac that was asleep for a week does not read a week: at most the last day.
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

// What the scout may use from Intercom: its read tools. Its write tools (internal notes, articles, Fin's live settings) are
// refused by name too, so a reply, a note or a setting can never come from the scout.
export const INTERCOM_READ_TOOLS = ["search", "fetch", "search_conversations", "get_conversation"];
export const INTERCOM_WRITE_TOOLS = [
  "add_internal_note", "create_article", "update_article", "apply_proposals", "reject_proposals", "send_operator_message",
  "get_operator_response", "get_proposal_details",
];

export function scoutDir(home: string = soopdoopHome()): string {
  return path.join(home, "scout");
}

export function lastRunPath(home: string = soopdoopHome()): string {
  return path.join(scoutDir(home), "last-run");
}

export function scoutConfigPath(home: string = soopdoopHome()): string {
  return path.join(scoutDir(home), "mcp.json");
}

// The Intercom server the hacker added to Claude Code (~/.claude.json, user scope), so the scout uses the same one they signed
// in to with /mcp. Undefined when they have not added one.
export function intercomServer(claudeJson: unknown): Record<string, unknown> | undefined {
  if (!isRecord(claudeJson) || !isRecord(claudeJson.mcpServers)) return undefined;
  const server = claudeJson.mcpServers.intercom;
  return isRecord(server) && typeof server.url === "string" ? server : undefined;
}

export async function readIntercomServer(file: string = path.join(homedir(), ".claude.json")): Promise<Record<string, unknown> | undefined> {
  return intercomServer(await Bun.file(file).json().catch(function () { return null; }));
}

// The two MCP servers the scout's claude starts: Intercom's and soopdoop's own (for the props tool).
export function scoutMcpConfig(bun: string, mcpFile: string, intercom: Record<string, unknown> | undefined, soopdoopHomeOverride?: string): Record<string, unknown> {
  return {
    mcpServers: {
      intercom: intercom ?? { type: "http", url: INTERCOM_URL },
      soopdoop: { type: "stdio", command: bun, args: [mcpFile], ...(soopdoopHomeOverride === undefined ? {} : { env: { SOOPDOOP_HOME: soopdoopHomeOverride } }) },
    },
  };
}

// Restricted mode skips the hooks in the hacker's settings (the scout never shows up as an agent) and keeps the servers given
// here; --strict-mcp-config leaves out every other one. No built-in tools, nothing saved, Haiku at low effort with thinking off
// (a quiet hour cost $0.0027 instead of $0.0043, and the same lines came out). Not --bare: bare mode reads only an API key,
// never a Claude sign-in, and not --safe-mode: it drops --mcp-config servers too (all checked 18 Oct 2026).
export function scoutArgs(configFile: string, prompt: string): string[] {
  return [
    "-p", "--restricted", "--strict-mcp-config", "--mcp-config", configFile, "--tools", "",
    "--allowedTools", [...INTERCOM_READ_TOOLS.map(function (t) { return `mcp__intercom__${t}`; }), "mcp__soopdoop__props"].join(","),
    "--disallowedTools", INTERCOM_WRITE_TOOLS.map(function (t) { return `mcp__intercom__${t}`; }).join(","),
    "--settings", JSON.stringify({ alwaysThinkingEnabled: false }),
    "--no-session-persistence", "--model", LEDGER_MODEL, "--effort", "low", "--verbose", "--output-format", "stream-json", prompt,
  ];
}

export function scoutPrompt(since: number, now: number): string {
  return [
    `You are the soopdoop scout. Look in Intercom for customer conversations closed or rated between ${new Date(since).toISOString()} and ${new Date(now).toISOString()}.`,
    "Search with the search tool (query: object_type:conversations state:closed limit:50), then read with get_conversation the ones " +
      "whose last close or rating falls in that time. Skip older ones.",
    "Decide once per conversation, and call the props tool at most once for it: kind \"save\" when it turned from an upset " +
      "customer to a happy one; otherwise kind \"props\" when the customer thanked the team or rated it 4 or 5; otherwise nothing.",
    "Each line is one plain sentence under 200 characters that says what the team did, like \"Fixed a customer's empty CSV export " +
      "the same morning\". Never name the customer, their company or their email, and nothing else that tells who they are. " +
      `At most ${MAX_LINES} lines in all: the best ones.`,
    "Only read Intercom and call props. Do not reply to customers, add notes or change anything.",
    "When you are done, reply with only the number of props calls you made.",
  ].join("\n");
}

export interface ScoutResult {
  // "ran", or why it did not: the setting is off, claude or the pairing is missing, Intercom is not signed in, it failed.
  outcome: "ran" | "off" | "no-claude" | "not-paired" | "not-team" | "no-intercom" | "failed";
  lines?: number;
  usd?: number;
  // Never the model's words: they could quote a conversation.
  why?: string;
}

// Reads `claude -p --output-format stream-json --verbose`: the init event's MCP servers and the result event. Nothing else of
// the run is kept.
export function readRun(stdout: string): { intercom?: string; soopdoop?: string; ok: boolean; lines?: number; usage?: Record<string, unknown> } {
  const out: { intercom?: string; soopdoop?: string; ok: boolean; lines?: number; usage?: Record<string, unknown> } = { ok: false };
  for (const line of stdout.split("\n")) {
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(ev)) continue;
    if (ev.type === "system" && ev.subtype === "init" && Array.isArray(ev.mcp_servers)) {
      for (const s of ev.mcp_servers) {
        if (!isRecord(s) || typeof s.status !== "string") continue;
        if (s.name === "intercom") out.intercom = s.status;
        if (s.name === "soopdoop") out.soopdoop = s.status;
      }
    }
    if (ev.type === "result") {
      out.ok = ev.is_error !== true && ev.subtype === "success";
      if (isRecord(ev.usage)) out.usage = ev.usage;
      const said = typeof ev.result === "string" ? ev.result.trim() : "";
      if (/^\d+$/.test(said)) out.lines = Number(said);
    }
  }
  return out;
}

export interface ScoutDeps {
  scoutOn(): Promise<boolean>;
  claude(): string | null;
  paired(): Promise<boolean>;
  // The crew's plan ("free" | "team"), or undefined when it cannot be read. Props from customers come with the Team plan,
  // so on free the scout does not spend the owner's Haiku on lines the backend would refuse.
  plan?(): Promise<string | undefined>;
  intercom(): Promise<Record<string, unknown> | undefined>;
  bun: string;
  mcpFile: string;
  home?: string;
  soopdoopHomeOverride?: string;
  run?: Run;
  clock?: () => number;
}

// One run of the scout. The last run's time moves only when Intercom answered and the run finished, so a missed hour is read
// at the next run.
export async function runScout(deps: ScoutDeps): Promise<ScoutResult> {
  if (!(await deps.scoutOn())) return { outcome: "off" };
  const claude = deps.claude();
  if (claude === null) return { outcome: "no-claude", why: "the claude command was not found" };
  if (!(await deps.paired())) return { outcome: "not-paired", why: "this Mac is not paired with soopdoop" };
  if (deps.plan !== undefined && (await deps.plan()) === "free") return { outcome: "not-team", why: "props from customers come with the Team plan" };
  const home = deps.home ?? soopdoopHome();
  const clock = deps.clock ?? Date.now;
  const now = clock();
  const last = Date.parse((await Bun.file(lastRunPath(home)).text().catch(function () { return ""; })).trim());
  const since = Number.isNaN(last) ? now - MAX_WINDOW_MS : Math.max(last, now - MAX_WINDOW_MS);
  await mkdir(scoutDir(home), { recursive: true, mode: 0o700 });
  const config = scoutConfigPath(home);
  await writeFile(config, JSON.stringify(scoutMcpConfig(deps.bun, deps.mcpFile, await deps.intercom(), deps.soopdoopHomeOverride), null, 2) + "\n", { mode: 0o600 });
  await chmod(config, 0o600);
  const run = deps.run ?? spawnFork;
  const result = await run([claude, ...scoutArgs(config, scoutPrompt(since, now))], { cwd: scoutDir(home), env: forkEnv(process.env), timeoutMs: RUN_TIMEOUT_MS })
    .catch(function () { return null; });
  if (result === null) return { outcome: "failed", why: "claude did not start" };
  const read = readRun(result.stdout);
  const usd = read.usage === undefined ? undefined : answerCost(read.usage, LEDGER_MODEL);
  const spent = usd === undefined ? {} : { usd };
  if (result.timedOut) return { outcome: "failed", why: "the run took longer than 10 minutes", ...spent };
  if (read.intercom !== undefined && read.intercom !== "connected") {
    return { outcome: "no-intercom", why: `Intercom's MCP server is ${read.intercom}`, ...spent };
  }
  if (!read.ok) return { outcome: "failed", why: `claude exited ${String(result.exitCode)}`, ...spent };
  await writeFile(lastRunPath(home), new Date(now).toISOString() + "\n");
  return { outcome: "ran", ...(read.lines === undefined ? {} : { lines: read.lines }), ...spent };
}

// One line for the scout's log (and for `soopdoop scout run` by hand). Sizes and cost only.
export function scoutLogLine(r: ScoutResult, at: number): string {
  const cost = r.usd === undefined ? "" : ` · $${r.usd.toFixed(4)}`;
  if (r.outcome === "ran") return `${new Date(at).toISOString()} scout ran: ${r.lines === undefined ? "?" : r.lines} line${r.lines === 1 ? "" : "s"} sent${cost}`;
  if (r.outcome === "off") return `${new Date(at).toISOString()} scout is off (soopdoop scout on)`;
  if (r.outcome === "no-intercom") {
    return `${new Date(at).toISOString()} scout: ${r.why ?? "Intercom is not reachable"}. Sign in once: run \`claude mcp add --transport http --scope user intercom ${INTERCOM_URL}\` ` +
      `(EU workspaces: https://mcp.eu.intercom.com/mcp), then /mcp in a Claude Code session${cost}`;
  }
  return `${new Date(at).toISOString()} scout did not run: ${r.why ?? r.outcome}${cost}`;
}

// Whether this Mac is paired, for the scout's props.
export async function isPaired(): Promise<boolean> {
  return (await readConfig().catch(function () { return null; })) !== null;
}

const crewForDaemon = makeFunctionReference<"query">("crews:forDaemon");

// The crew's plan from the backend, or undefined when this Mac is not paired or the backend cannot be reached.
export async function readPlan(): Promise<string | undefined> {
  const config = await readConfig().catch(function () { return null; });
  if (config === null) return undefined;
  try {
    const raw: unknown = await new ConvexHttpClient(config.convexUrl).query(crewForDaemon, { token: config.token });
    return isRecord(raw) && typeof raw.plan === "string" ? raw.plan : undefined;
  } catch {
    return undefined;
  }
}
