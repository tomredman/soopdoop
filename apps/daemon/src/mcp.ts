// ABOUTME: The soopdoop MCP server (stdio) that Claude Code starts: ask_operator asks the crew's Operator and waits for the
// ABOUTME: answer, crew_status lists the crew's @handles. soopdoop setup registers it with `claude mcp add`. JSON-RPC 2.0, one message per line.
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { type Config, readConfig } from "./config";
import { isRecord } from "./state";

const askRef = makeFunctionReference<"mutation">("operator:ask");
const relayRef = makeFunctionReference<"query">("operator:relay");
const crewRef = makeFunctionReference<"query">("friends:crew");

export const TOOL = {
  name: "ask_operator",
  description:
    "Ask your soopdoop crew's Operator. Use it as soon as your user asks who to ask about something, who knows or works " +
    "on something, or what a crewmate is doing, and before a long search of code a teammate built or is changing. A " +
    "who-question gets the crewmate who has an agent on it, and \"What would you like to know?\": send your user's " +
    "answer as a new question with that crewmate's @handle in it, and their agent answers. Any other question goes to " +
    "the crewmate's agent that knows, and its short answer comes back, or the Operator says nobody knows. crew_status " +
    "lists the @handles. Never ask for secrets or credentials.",
  inputSchema: {
    type: "object",
    properties: { question: { type: "string", description: "One clear question, under 500 characters." } },
    required: ["question"],
    additionalProperties: false,
  },
};

export const CREW_TOOL = {
  name: "crew_status",
  description:
    "List your soopdoop crew: each crewmate's @handle, their name when they linked one, and whether they have open " +
    "agents running now. Use it to find the right @handle before you ask_operator about one person's work.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

export interface RelayView {
  status: string;
  answer?: string;
  note?: string;
  targetHandle?: string;
  targetAgentName?: string;
  byOperator?: boolean;
  askAgain?: boolean;
}

function parseRelay(raw: unknown): RelayView | null {
  if (!isRecord(raw) || typeof raw.status !== "string") return null;
  const view: RelayView = { status: raw.status };
  if (typeof raw.answer === "string") view.answer = raw.answer;
  if (typeof raw.note === "string") view.note = raw.note;
  if (typeof raw.targetHandle === "string") view.targetHandle = raw.targetHandle;
  if (typeof raw.targetAgentName === "string") view.targetAgentName = raw.targetAgentName;
  if (raw.byOperator === true) view.byOperator = true;
  if (raw.askAgain === true) view.askAgain = true;
  return view;
}

// What the asking agent reads back. The lines in brackets are for the agent: how to pass the answer on, and how to ask
// a crewmate's agent more. They say nothing about how the Operator found it, which agents tend to repeat to their user.
export function formatRelay(r: RelayView): string {
  const who = r.targetHandle === undefined
    ? "a crewmate's agent"
    : `@${r.targetHandle}'s ${r.targetAgentName === undefined ? "agent" : `${r.targetAgentName} agent`}`;
  if (r.status === "answered" && r.answer !== undefined) {
    if (r.byOperator === true) {
      return `${r.answer}\n\n(From the soopdoop Operator. Pass it on to your user in a sentence or two. To ask a crewmate's agent something, call ask_operator with the question and their @handle.)`;
    }
    return `${r.answer}\n\n(${who} answered this, through the soopdoop Operator.)`;
  }
  if (r.status === "not-found") return `${who} did not know${r.note === undefined ? "." : `: ${r.note}`} Work it out yourself.`;
  // A name the Operator could not place: the note lists the crew, and the question can be fixed.
  if (r.askAgain === true) return `${r.note ?? "The Operator could not tell who the question is about."} Ask again with the right @handle.`;
  return `${r.note ?? "The Operator could not answer."} Work it out yourself.`;
}

export interface Crewmate {
  handle: string;
  name?: string;
  led: string;
  inFocus: boolean;
  agentCount: number;
}

export interface CrewView {
  me: string;
  crew: Crewmate[];
}

function parseCrew(raw: unknown): CrewView | null {
  if (!isRecord(raw) || typeof raw.me !== "string" || !Array.isArray(raw.crew)) return null;
  const crew: Crewmate[] = [];
  for (const c of raw.crew) {
    if (!isRecord(c) || typeof c.handle !== "string") continue;
    const mate: Crewmate = {
      handle: c.handle,
      led: typeof c.led === "string" ? c.led : "x",
      inFocus: c.inFocus === true,
      agentCount: typeof c.agentCount === "number" ? c.agentCount : 0,
    };
    if (typeof c.name === "string") mate.name = c.name;
    crew.push(mate);
  }
  return { me: raw.me, crew };
}

function stateOf(c: Crewmate): string {
  if (c.inFocus) return "in focus mode";
  if (c.led === "x") return "offline";
  if (c.agentCount === 0) return "online, no open agents";
  return `${c.agentCount === 1 ? "1 open agent" : `${c.agentCount} open agents`}, ${c.led === "g" ? "working" : "idle"}`;
}

// What the agent reads back from crew_status: one line per crewmate.
export function formatCrew(view: CrewView): string {
  if (view.crew.length === 0) {
    return `You are @${view.me}, and your crew is empty, so there is nobody to ask yet. Your user adds crewmates in the soopdoop app.`;
  }
  const lines = view.crew.map(function (c) {
    return `- ${c.name === undefined ? `@${c.handle}` : `@${c.handle} (${c.name})`}: ${stateOf(c)}`;
  });
  return [`Your crew (you are @${view.me}):`, ...lines, "", "To ask about one crewmate's work, put their @handle in your ask_operator question."].join("\n");
}

// This machine's pairing, or null before setup.
async function paired(): Promise<Config | null> {
  try {
    return await readConfig();
  } catch {
    return null;
  }
}

export async function crewStatus(): Promise<string> {
  const config = await paired();
  if (config === null) return "soopdoop is not set up on this machine: open the soopdoop app and sign in.";
  try {
    const view = parseCrew(await new ConvexHttpClient(config.convexUrl).query(crewRef, { token: config.token }));
    return view === null ? "soopdoop sent back a crew this tool cannot read." : formatCrew(view);
  } catch (e) {
    return `Could not read your crew: ${cleanError(e)}`;
  }
}

// A ConvexError's message travels as its data (production passes it on; any other error's text becomes "Server
// Error"). In development Convex wraps the text in "[CONVEX M(…)] [Request ID: …] Server Error\nUncaught Error: <message>".
export function cleanError(e: unknown): string {
  if (e instanceof Error && "data" in e && typeof e.data === "string") return e.data;
  const raw = e instanceof Error ? e.message : String(e);
  return /Uncaught (?:Convex)?Error: ([^\n]*?)(?:\s+at\s|\n|$)/.exec(raw)?.[1] ?? raw;
}

export async function askOperator(question: string, waitMs: number = 75_000, pollMs: number = 1_500): Promise<string> {
  const config = await paired();
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

// What the two tools do. Tests pass stand-ins.
export interface Tools {
  ask: (question: string) => Promise<string>;
  crew: () => Promise<string>;
}

// One JSON-RPC message in, at most one out. Notifications (no id) get no answer.
export async function handle(raw: unknown, tools: Tools, version: string): Promise<Message | null> {
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
      return result(id, { tools: [TOOL, CREW_TOOL] });
    case "tools/call": {
      const args = isRecord(params.arguments) ? params.arguments : {};
      if (params.name === CREW_TOOL.name) return result(id, { content: [{ type: "text", text: await tools.crew() }] });
      if (params.name !== TOOL.name) return failure(id, -32602, `Unknown tool ${String(params.name)}`);
      if (typeof args.question !== "string" || args.question.trim() === "") {
        return result(id, { content: [{ type: "text", text: "Give the Operator a question." }], isError: true });
      }
      return result(id, { content: [{ type: "text", text: await tools.ask(args.question) }] });
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
      void handle(message, { ask: askOperator, crew: crewStatus }, version).then(function (reply) {
        if (reply !== null) process.stdout.write(JSON.stringify(reply) + "\n");
      });
    }
  }
}

if (import.meta.main) await main();
