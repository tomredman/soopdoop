// ABOUTME: The daemon's side of the Operator: a routing summary for each open agent after its turns, and answers to read
// ABOUTME: requests with a bounded slice of that agent's conversation, once per relay. Every read is logged on this machine.
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { soopdoopHome } from "./config";
import { isRecord, type Subset } from "./state";
import { conversationSlice, parseTranscript, readTail, routingSummary } from "./transcript";

export const updateRouting = makeFunctionReference<"mutation">("routing:update");
const readsFor = makeFunctionReference<"query">("operator:readsFor");

const TAIL_BYTES = 1_000_000;
// About 15k tokens: enough recent conversation to answer from, bounded so one question costs little.
export const SLICE_CHARS = 60_000;

export interface ReadRequest {
  relayId: string;
  agentId: string;
}

// HTTP actions live on the .site host of a deployment.
export function siteUrl(convexUrl: string): string {
  return convexUrl.replace(/\.convex\.cloud\/?$/, ".convex.site");
}

export function parseReads(raw: unknown): ReadRequest[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(function (r) {
    return isRecord(r) && typeof r.relayId === "string" && typeof r.agentId === "string" ? [{ relayId: r.relayId, agentId: r.agentId }] : [];
  });
}

// What to send for one read: the slice, or why there is none. Only open agents are ever read.
export async function prepareRead(subset: Subset, agentId: string): Promise<{ context: string } | { refused: string }> {
  const agent = subset.get(agentId);
  if (agent === undefined) return { refused: "That agent is no longer running." };
  if (!agent.open) return { refused: "That agent is private." };
  if (agent.transcriptPath === undefined) return { refused: "That agent's conversation is not available yet." };
  const slice = conversationSlice(parseTranscript(await readTail(agent.transcriptPath, TAIL_BYTES)), SLICE_CHARS);
  return slice === "" ? { refused: "That agent's conversation is empty." } : { context: slice };
}

// The one-line summary the Operator routes with, for an open agent with a transcript. Null otherwise.
export async function summaryFor(subset: Subset, agentId: string): Promise<string | null> {
  const agent = subset.get(agentId);
  if (agent === undefined || !agent.open || agent.transcriptPath === undefined) return null;
  const summary = routingSummary(parseTranscript(await readTail(agent.transcriptPath, 512_000)));
  return summary === "" ? null : summary;
}

// Every read leaves a line here: which relay, which agent, how much was sent. Never what was sent.
export async function logRead(entry: Record<string, unknown>, home: string = soopdoopHome()): Promise<void> {
  const dir = path.join(home, "logs");
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, "reads.log"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

// Follows this machine's read requests and answers each once. Returns a function that stops following.
export function answerReads(client: ConvexClient, token: string, convexUrl: string, subset: Subset): () => void {
  const handled = new Set<string>();
  const site = siteUrl(convexUrl);

  async function serve(read: ReadRequest): Promise<void> {
    const prepared = await prepareRead(subset, read.agentId);
    const sent = "context" in prepared ? prepared.context.length : 0;
    await logRead({
      relayId: read.relayId,
      agentId: read.agentId,
      agent: subset.get(read.agentId)?.name,
      sentChars: sent,
      refused: "refused" in prepared ? prepared.refused : undefined,
    });
    try {
      const res = await fetch(`${site}/operator/answer`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, relayId: read.relayId, ...prepared }),
        signal: AbortSignal.timeout(120_000),
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
