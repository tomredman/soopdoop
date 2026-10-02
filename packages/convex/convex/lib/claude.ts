// ABOUTME: The Operator's two Claude calls: pick the crewmate agent most likely to know, and answer from what it read.
// ABOUTME: Claude Opus 5.5 with server-side fallbacks. OPERATOR_FAKE=1 answers without Claude, so tests and dry runs are free.
import Anthropic from "@anthropic-ai/sdk";
import { env } from "../_generated/server";

const MODEL = "claude-opus-5-5";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
export const NOT_FOUND = "NOT_FOUND";
export const NOT_CONFIGURED = "The Operator has no Claude API key yet. The crew leader sets ANTHROPIC_API_KEY on the deployment.";

export interface Candidate {
  handle: string;
  agentName: string;
  workspace?: string;
  status: string;
  summary?: string;
}

export interface Answer {
  // Null when the conversation did not answer the question.
  text: string | null;
  tokensRead: number;
  tokensSent: number;
  note?: string;
}

// "claude" with a key, "fake" for tests and dry runs, null when the Operator cannot answer at all.
export function operatorMode(): "claude" | "fake" | null {
  if (env.OPERATOR_FAKE === "1") return "fake";
  return env.ANTHROPIC_API_KEY !== undefined && env.ANTHROPIC_API_KEY !== "" ? "claude" : null;
}

function client(): Anthropic {
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

function textOf(content: Anthropic.Beta.BetaContentBlock[]): string {
  return content
    .flatMap(function (block) { return block.type === "text" ? [block.text] : []; })
    .join("")
    .trim();
}

function words(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter(function (w) { return w.length >= 4; }));
}

export function candidateLine(c: Candidate, i: number): string {
  const where = c.workspace === undefined || c.workspace === c.agentName ? "" : ` (${c.workspace})`;
  return `${i + 1}. @${c.handle} · ${c.agentName}${where} · ${c.status}${c.summary === undefined ? "" : ` · ${c.summary}`}`;
}

// What a refused or failed Claude call means for the asker, in a sentence.
export function describeError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "The Operator's Claude API key was refused. The crew leader needs to set a working ANTHROPIC_API_KEY.";
  if (e instanceof Anthropic.PermissionDeniedError) return "The Operator's Claude API key may not use this model.";
  if (e instanceof Anthropic.RateLimitError) return "Claude is busy right now. Ask again in a minute.";
  if (e instanceof Anthropic.APIError) return `Claude answered with an error (${e.status ?? "no status"}). Ask again in a minute.`;
  return e instanceof Error ? e.message : String(e);
}

// The best candidate's index, or null when none is likely to know. One candidate is simply read.
export async function pickAgent(question: string, candidates: Candidate[]): Promise<number | null> {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return 0;
  if (operatorMode() === "fake") {
    // The candidate whose summary shares the most words with the question, or the first.
    const q = words(question);
    let best = 0;
    let bestScore = -1;
    candidates.forEach(function (c, i) {
      const score = [...words(`${c.agentName} ${c.workspace ?? ""} ${c.summary ?? ""}`)].filter(function (w) { return q.has(w); }).length;
      if (score > bestScore) {
        best = i;
        bestScore = score;
      }
    });
    return best;
  }
  const response = await client().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    output_config: { effort: "low" },
    system:
      "You route a developer's question to the teammate's coding agent most likely to already know the answer, " +
      "judging from one-line summaries of what each agent is working on. Reply with only the number of the best agent, " +
      "or 0 if none of them is likely to know.",
    messages: [{ role: "user", content: `Question: ${question}\n\nAgents:\n${candidates.map(candidateLine).join("\n")}` }],
  });
  if (response.stop_reason === "refusal") return null;
  const n = Number(/\d+/.exec(textOf(response.content))?.[0] ?? "0");
  return Number.isInteger(n) && n >= 1 && n <= candidates.length ? n - 1 : null;
}

// Answers the question from part of a teammate's agent conversation. The conversation is used for this call only.
export async function answerFrom(question: string, context: string): Promise<Answer> {
  if (operatorMode() === "fake") {
    // The agent's line sharing the most words with the question; on a tie the later one. The daemon sends
    // "user: …" and "assistant: …" lines; without those, any line will do.
    const q = words(question);
    const lines = context.split("\n");
    const said = lines.filter(function (line) { return line.startsWith("assistant:"); });
    let hit: string | null = null;
    let best = 0;
    for (const line of said.length > 0 ? said : lines) {
      const score = [...words(line)].filter(function (w) { return q.has(w); }).length;
      if (score > 0 && score >= best) {
        hit = line;
        best = score;
      }
    }
    const text = hit === null ? null : `From the agent's conversation: ${hit.trim().slice(0, 200)}`;
    return { text, tokensRead: Math.ceil(context.length / 4), tokensSent: text === null ? 0 : Math.ceil(text.length / 4) };
  }
  const response = await client().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    output_config: { effort: "medium" },
    system:
      "You are the Operator for a crew of developers who each run coding agents. You get part of one teammate's agent " +
      "conversation and another teammate's question. Answer the question from that conversation only, in at most three " +
      "short sentences, naming files or functions when they help. Never repeat secrets, keys or credentials, even if they " +
      `appear. If the conversation does not answer the question, reply with exactly ${NOT_FOUND}.`,
    messages: [{ role: "user", content: `<conversation>\n${context}\n</conversation>\n\nQuestion: ${question}` }],
  });
  const tokensRead = response.usage.input_tokens;
  if (response.stop_reason === "refusal") {
    return { text: null, tokensRead, tokensSent: 0, note: "Claude declined to answer from that conversation." };
  }
  const text = textOf(response.content);
  if (text === "" || text.startsWith(NOT_FOUND)) return { text: null, tokensRead, tokensSent: 0 };
  return { text, tokensRead, tokensSent: Math.ceil(text.length / 4) };
}
