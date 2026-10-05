// ABOUTME: The daemon's side of the Operator: a routing summary for each open agent after its turns, and answers to the
// ABOUTME: questions routed to this machine's agents, asked of the agent itself (ask.ts), once per relay. Every ask is logged here.
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { askAgent, type Asked } from "./ask";
import { soopdoopHome } from "./config";
import { isRecord, type AgentRecord, type Subset } from "./state";
import { parseTranscript, readTail, routingSummary } from "./transcript";

export const updateRouting = makeFunctionReference<"mutation">("routing:update");
const readsFor = makeFunctionReference<"query">("operator:readsFor");

export interface ReadRequest {
  relayId: string;
  agentId: string;
  // The crewmate's question, which the agent is asked. Older backends did not send it.
  question?: string;
}

// HTTP actions live on the .site host of a deployment.
export function siteUrl(convexUrl: string): string {
  return convexUrl.replace(/\.convex\.cloud\/?$/, ".convex.site");
}

export function parseReads(raw: unknown): ReadRequest[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(function (r) {
    if (!isRecord(r) || typeof r.relayId !== "string" || typeof r.agentId !== "string") return [];
    return [typeof r.question === "string" ? { relayId: r.relayId, agentId: r.agentId, question: r.question } : { relayId: r.relayId, agentId: r.agentId }];
  });
}

// What to send for one question: the agent's own answer, or why there is none. Only open agents are ever asked.
export async function prepareAnswer(
  subset: Subset,
  read: ReadRequest,
  ask: (agent: AgentRecord, question: string) => Promise<Asked> = askAgent,
): Promise<Asked> {
  const agent = subset.get(read.agentId);
  if (agent === undefined) return { refused: "That agent is no longer running." };
  if (!agent.open) return { refused: "That agent is private." };
  if (agent.transcriptPath === undefined) return { refused: "That agent's conversation is not available yet." };
  if (read.question === undefined) return { refused: "The Operator did not send the question." };
  return await ask(agent, read.question);
}

// The one-line summary the Operator routes with, for an open agent with a transcript. Null otherwise.
export async function summaryFor(subset: Subset, agentId: string): Promise<string | null> {
  const agent = subset.get(agentId);
  if (agent === undefined || !agent.open || agent.transcriptPath === undefined) return null;
  const summary = routingSummary(parseTranscript(await readTail(agent.transcriptPath, 512_000)));
  return summary === "" ? null : summary;
}

// Every ask leaves a line here: which relay, which agent, how long the answer was and what it read. Never the question or the answer.
export async function logRead(entry: Record<string, unknown>, home: string = soopdoopHome()): Promise<void> {
  const dir = path.join(home, "logs");
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, "reads.log"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

// Follows this machine's questions and answers each once. Returns a function that stops following.
export function answerReads(client: ConvexClient, token: string, convexUrl: string, subset: Subset): () => void {
  const handled = new Set<string>();
  const site = siteUrl(convexUrl);

  async function serve(read: ReadRequest): Promise<void> {
    const asked = await prepareAnswer(subset, read);
    await logRead({
      relayId: read.relayId,
      agentId: read.agentId,
      agent: subset.get(read.agentId)?.name,
      sentChars: "answer" in asked ? asked.answer.length : 0,
      tokensRead: asked.tokensRead,
      costUsd: asked.costUsd,
      refused: "refused" in asked ? asked.refused : undefined,
    });
    const body = "answer" in asked
      ? { token, relayId: read.relayId, answer: asked.answer, tokensRead: asked.tokensRead ?? 0 }
      : { token, relayId: read.relayId, refused: asked.refused };
    try {
      const res = await fetch(`${site}/operator/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) console.error(`operator answer for ${read.relayId}: ${res.status}`);
    } catch (e) {
      console.error("operator answer failed:", e instanceof Error ? e.message : String(e));
    }
  }

  return client.onUpdate(
    readsFor,
    { token },
    function (raw: unknown) {
      for (const read of parseReads(raw)) {
        if (handled.has(read.relayId)) continue;
        handled.add(read.relayId);
        void serve(read);
      }
    },
    function (e: Error) {
      console.error("operator reads:", e.message);
    },
  );
}
