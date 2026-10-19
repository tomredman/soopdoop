// ABOUTME: The hand-off tools of soopdoop's MCP server: hand_off offers a task to a crewmate's agent (their owner approves it
// ABOUTME: first), report_back says what was done for a hand-off this agent was given, with what it cost on this Mac.
import { ConvexHttpClient } from "convex/browser";
import type { FunctionReference } from "convex/server";
import { makeFunctionReference } from "convex/server";
import { readConfig, soopdoopHome, type Config } from "./config";
import { handoffCost } from "./handoff-cost";
import { appendHandoffLog, readHandoffLog } from "./handoff-log";
import { cleanError } from "./mcp";
import { isRecord } from "./state";
import { findTranscript } from "./transcripts/index";

const offerRef = makeFunctionReference<"mutation">("handoffs:offerFromAgent");
const reportBackRef = makeFunctionReference<"mutation">("handoffs:reportBack");

export const HAND_OFF_TOOL = {
  name: "hand_off",
  description:
    "Offer a task to a crewmate's agent through soopdoop, when your user wants a crewmate's agent to do a piece of work " +
    "(write, change, fix or review something in their part of the code). The crewmate sees the exact task and approves it " +
    "before it runs in their agent, on their own account. Give their @handle (crew_status lists them), the task in your " +
    "user's words, and why them. You hear back at a later prompt when it is done, declined or expired. Never put secrets " +
    "or credentials in a task.",
  inputSchema: {
    type: "object",
    properties: {
      handle: { type: "string", description: "The crewmate's @handle." },
      task: { type: "string", description: "What their agent should do, under 2,000 characters." },
      why: { type: "string", description: "Why them, in a sentence (optional)." },
    },
    required: ["handle", "task"],
    additionalProperties: false,
  },
};

export const REPORT_BACK_TOOL = {
  name: "report_back",
  description:
    "Report back on a soopdoop hand-off you were given: a task a crewmate offered and your user approved in the soopdoop " +
    "app. It reaches you as a message that starts \"soopdoop hand-off from @…\". Call this once when you finish, with the " +
    "handoff_id from that message, a short summary of what you did (or what stopped you), and links such as the pull " +
    "request. The crewmate who offered it reads your summary.",
  inputSchema: {
    type: "object",
    properties: {
      handoff_id: { type: "string", description: "The handoff_id from the hand-off message." },
      summary: { type: "string", description: "What you did, or what stopped you, in one or two sentences." },
      links: { type: "array", items: { type: "string" }, description: "Links, such as the pull request." },
    },
    required: ["handoff_id", "summary"],
    additionalProperties: false,
  },
};

export const HANDOFF_TOOLS = [HAND_OFF_TOOL, REPORT_BACK_TOOL];

// The session this MCP server serves, when its harness says. Claude Code gives its MCP servers CLAUDE_CODE_SESSION_ID
// (seen on 2.1.303); Codex gives them no thread id, and Grok's was not checked.
export function sessionIdOf(env: Record<string, string | undefined> = process.env): string | undefined {
  const id = env.CLAUDE_CODE_SESSION_ID;
  return id !== undefined && /^[A-Za-z0-9-]+$/.test(id) ? id : undefined;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export interface HandoffToolDeps {
  config(): Promise<Config | null>;
  mutation(convexUrl: string, fn: FunctionReference<"mutation">, args: Record<string, unknown>): Promise<unknown>;
  // What the hand-off cost the agent it ran in since it reached it, in US dollars, or undefined when unknown.
  cost(harness: string, agentId: string, since: number): Promise<number | undefined>;
  env: Record<string, string | undefined>;
  home: string;
  now(): number;
}

async function pairedConfig(): Promise<Config | null> {
  try {
    return await readConfig();
  } catch {
    return null;
  }
}

async function transcriptCost(harness: string, agentId: string, since: number): Promise<number | undefined> {
  const file = await findTranscript(harness, agentId);
  if (file === null) return undefined;
  return (await handoffCost(harness, file, since))?.usd;
}

export function defaultToolDeps(): HandoffToolDeps {
  return {
    config: pairedConfig,
    async mutation(convexUrl, fn, args) {
      return await new ConvexHttpClient(convexUrl).mutation(fn, args);
    },
    cost: transcriptCost,
    env: process.env,
    home: soopdoopHome(),
    now: Date.now,
  };
}

function text(x: unknown): string | undefined {
  if (typeof x !== "string") return undefined;
  const t = x.trim();
  return t === "" ? undefined : t;
}

const NOT_SET_UP = "soopdoop is not set up on this machine: open the soopdoop app and sign in.";

export interface Offered {
  status: string;
  toHandle: string;
  targetAgentName?: string;
}

function parseOffered(raw: unknown, handle: string): Offered {
  if (!isRecord(raw)) return { status: "offered", toHandle: handle };
  const o: Offered = { status: typeof raw.status === "string" ? raw.status : "offered", toHandle: typeof raw.toHandle === "string" ? raw.toHandle : handle };
  if (typeof raw.targetAgentName === "string") o.targetAgentName = raw.targetAgentName;
  return o;
}

// What the offering agent reads back: who got it, which agent, that its owner approves it first, and that the answer
// comes at a later prompt.
export function offeredText(o: Offered): string {
  const who = `@${o.toHandle}`;
  const agent = o.targetAgentName === undefined ? "" : ` ${o.targetAgentName}`;
  const next = "Tell your user in a sentence and carry on; do not wait for it.";
  if (o.status === "accepted") {
    return `${who} lets your hand-offs run without asking each time, so it goes to their${agent} agent when that agent is next idle. ` +
      `You will hear back at a later prompt when it is done. ${next}`;
  }
  const where = o.targetAgentName === undefined ? `Offered to ${who}; they pick which of their agents runs it.` : `Offered to ${who}, for their${agent} agent.`;
  return `${where} ${who} must approve it in soopdoop before it runs. You will hear back at a later prompt when it is done, declined or expired. ${next}`;
}

async function handOff(args: Record<string, unknown>, deps: HandoffToolDeps): Promise<ToolResult> {
  const handle = text(args.handle)?.replace(/^@/, "");
  const task = text(args.task);
  const why = text(args.why);
  if (handle === undefined) return { text: "Say whose agent should do it: their @handle (crew_status lists them).", isError: true };
  if (task === undefined) return { text: "Say what the task is.", isError: true };
  const config = await deps.config();
  if (config === null) return { text: NOT_SET_UP, isError: true };
  const agentId = sessionIdOf(deps.env);
  let raw: unknown;
  try {
    raw = await deps.mutation(config.convexUrl, offerRef, {
      token: config.token, toHandle: handle, text: task, ...(why === undefined ? {} : { why }), ...(agentId === undefined ? {} : { agentId }),
    });
  } catch (e) {
    return { text: `Could not offer the hand-off: ${cleanError(e)}`, isError: true };
  }
  return { text: offeredText(parseOffered(raw, handle)) };
}

async function reportBack(args: Record<string, unknown>, deps: HandoffToolDeps): Promise<ToolResult> {
  const handoffId = text(args.handoff_id);
  const summary = text(args.summary);
  const links = Array.isArray(args.links) ? args.links.filter(function (l): l is string { return typeof l === "string" && l.trim() !== ""; }) : [];
  if (handoffId === undefined) return { text: "Give the handoff_id from the hand-off message.", isError: true };
  if (summary === undefined) return { text: "Say what you did for the hand-off, or what stopped you.", isError: true };
  const config = await deps.config();
  if (config === null) return { text: NOT_SET_UP, isError: true };
  // The daemon logged when the hand-off reached which agent; what that agent spent since is the hand-off's cost.
  const delivered = (await readHandoffLog(deps.home)).find(function (l) { return l.event === "delivered" && l.handoffId === handoffId; });
  const usd = delivered?.agentId === undefined ? undefined : await deps.cost(delivered.harness ?? "claude-code", delivered.agentId, delivered.at).catch(function () { return undefined; });
  try {
    await deps.mutation(config.convexUrl, reportBackRef, {
      token: config.token, handoffId, summary, ...(links.length > 0 ? { links } : {}), ...(usd === undefined ? {} : { usd }),
    });
  } catch (e) {
    return { text: `Could not report back: ${cleanError(e)}`, isError: true };
  }
  const agentId = delivered?.agentId ?? sessionIdOf(deps.env);
  await appendHandoffLog({
    at: deps.now(), event: "reported", handoffId, by: "agent", chars: summary.length, ...(agentId === undefined ? {} : { agentId }), ...(usd === undefined ? {} : { usd }),
  }, deps.home);
  return { text: `Reported back${delivered?.fromHandle === undefined ? "" : ` to @${delivered.fromHandle}`}. The hand-off is done; tell your user in a sentence.` };
}

// Calls one of the hand-off tools; null when the name is not one of them.
export async function callHandoffTool(name: unknown, args: Record<string, unknown>, deps: HandoffToolDeps = defaultToolDeps()): Promise<ToolResult | null> {
  if (name === HAND_OFF_TOOL.name) return await handOff(args, deps);
  if (name === REPORT_BACK_TOOL.name) return await reportBack(args, deps);
  return null;
}
