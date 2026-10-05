// ABOUTME: The soopdoop MCP server (stdio) that Claude Code starts: one tool, ask_operator, which asks the crew's Operator
// ABOUTME: and waits for the answer. soopdoop setup registers it with `claude mcp add`. JSON-RPC 2.0, one message per line.
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { readConfig } from "./config";
import { isRecord } from "./state";

const askRef = makeFunctionReference<"mutation">("operator:ask");
const relayRef = makeFunctionReference<"query">("operator:relay");

export const TOOL = {
  name: "ask_operator",
  description:
    "Ask your soopdoop crew's Operator a question that a crewmate's coding agent has probably already worked out: how " +
    "something in this project works, where it lives, what was decided, or what a crewmate is changing. The Operator " +
    "finds the agent that knows, asks it, and returns its short answer, or says nobody knows. Try it before a long search " +
    "of code a teammate is working on. Never ask for secrets or credentials.",
  inputSchema: {
    type: "object",
    properties: { question: { type: "string", description: "One clear question, under 500 characters." } },
    required: ["question"],
    additionalProperties: false,
  },
};

export interface RelayView {
  status: string;
  answer?: string;
  note?: string;
  targetHandle?: string;
  targetAgentName?: string;
}

function parseRelay(raw: unknown): RelayView | null {
  if (!isRecord(raw) || typeof raw.status !== "string") return null;
  const view: RelayView = { status: raw.status };
  if (typeof raw.answer === "string") view.answer = raw.answer;
  if (typeof raw.note === "string") view.note = raw.note;
  if (typeof raw.targetHandle === "string") view.targetHandle = raw.targetHandle;
  if (typeof raw.targetAgentName === "string") view.targetAgentName = raw.targetAgentName;
  return view;
}

// What the asking agent reads back.
export function formatRelay(r: RelayView): string {
  const who = r.targetHandle === undefined ? "a crewmate's agent" : `@${r.targetHandle}'s ${r.targetAgentName ?? "agent"}`;
  if (r.status === "answered" && r.answer !== undefined) return `${r.answer}\n\n(Answered from ${who} by the soopdoop Operator.)`;
  if (r.status === "not-found") return `${who} did not know${r.note === undefined ? "." : `: ${r.note}`} Work it out yourself.`;
  return `${r.note ?? "The Operator could not answer."} Work it out yourself.`;
}

// A ConvexError's message travels as its data (production passes it on; any other error's text becomes "Server
// Error"). In development Convex wraps the text in "[CONVEX M(…)] [Request ID: …] Server Error\nUncaught Error: <message>".
export function cleanError(e: unknown): string {
  if (e instanceof Error && "data" in e && typeof e.data === "string") return e.data;
  const raw = e instanceof Error ? e.message : String(e);
  return /Uncaught (?:Convex)?Error: ([^\n]*?)(?:\s+at\s|\n|$)/.exec(raw)?.[1] ?? raw;
}

export async function askOperator(question: string, waitMs: number = 75_000, pollMs: number = 1_500): Promise<string> {
  let config = null;
  try {
    config = await readConfig();
  } catch {
    config = null;
  }
  if (config === null) return "soopdoop is not set up on this machine: open the soopdoop app and sign in. Work it out yourself for now.";
  const client = new ConvexHttpClient(config.convexUrl);
  let relayId: unknown;
  try {
    relayId = await client.mutation(askRef, { token: config.token, question });
  } catch (e) {
    return `The Operator could not take the question: ${cleanError(e)} Work it out yourself.`;
  }
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await Bun.sleep(pollMs);
    const view = parseRelay(await client.query(relayRef, { token: config.token, relayId }).catch(function () { return null; }));
    if (view !== null && view.status !== "routing" && view.status !== "reading") return formatRelay(view);
  }
  return "The Operator is still working on it; the answer will show in the soopdoop HUD. Carry on without it for now.";
}

type Message = Record<string, unknown>;

function result(id: unknown, value: unknown): Message {
  return { jsonrpc: "2.0", id, result: value };
}

function failure(id: unknown, code: number, message: string): Message {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// One JSON-RPC message in, at most one out. Notifications (no id) get no answer.
export async function handle(raw: unknown, ask: (question: string) => Promise<string>, version: string): Promise<Message | null> {
  if (!isRecord(raw) || raw.jsonrpc !== "2.0" || typeof raw.method !== "string") return null;
  const id = raw.id;
  if (id === undefined || id === null) return null;
  const params = isRecord(raw.params) ? raw.params : {};
  switch (raw.method) {
    case "initialize":
      return result(id, {
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "soopdoop", version },
      });
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, { tools: [TOOL] });
    case "tools/call": {
      const args = isRecord(params.arguments) ? params.arguments : {};
      if (params.name !== TOOL.name) return failure(id, -32602, `Unknown tool ${String(params.name)}`);
      if (typeof args.question !== "string" || args.question.trim() === "") {
        return result(id, { content: [{ type: "text", text: "Give the Operator a question." }], isError: true });
      }
      return result(id, { content: [{ type: "text", text: await ask(args.question) }] });
    }
    default:
      return failure(id, -32601, `Method not found: ${raw.method}`);
  }
}

async function main(): Promise<void> {
  let version = "0.0.0";
  try {
    const pkg: unknown = await Bun.file(new URL("../../../package.json", import.meta.url)).json();
    if (isRecord(pkg) && typeof pkg.version === "string") version = pkg.version;
  } catch {
    // The version is only shown to Claude Code.
  }
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line === "") continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        process.stdout.write(JSON.stringify(failure(null, -32700, "Parse error")) + "\n");
        continue;
      }
      // A question can take a minute; keep reading (pings, cancels) while it runs.
      void handle(message, askOperator, version).then(function (reply) {
        if (reply !== null) process.stdout.write(JSON.stringify(reply) + "\n");
      });
    }
  }
}

if (import.meta.main) await main();
