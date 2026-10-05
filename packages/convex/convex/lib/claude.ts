// ABOUTME: The Operator's Claude calls: pick the crewmate agent most likely to know, chat with a hacker (answer or route), and
// ABOUTME: for daemons that still send a slice, answer from it; plus the check on an agent's answer. OPERATOR_FAKE=1 skips Claude.
import Anthropic from "@anthropic-ai/sdk";
import { env } from "../_generated/server";

const MODEL = "claude-opus-5-5";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
export const NOT_FOUND = "NOT_FOUND";
export const NOT_CONFIGURED = "The Operator has no Claude API key yet. The crew leader sets ANTHROPIC_API_KEY on the deployment.";

export interface Candidate {
  handle: string;
  // The owner's name from their linked Superset profile, when they linked one.
  name?: string;
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
  const who = c.name === undefined ? `@${c.handle}` : `@${c.handle} (${c.name})`;
  const where = c.workspace === undefined || c.workspace === c.agentName ? "" : ` (${c.workspace})`;
  return `${i + 1}. ${who} · ${c.agentName}${where} · ${c.status}${c.summary === undefined ? "" : ` · ${c.summary}`}`;
}

// The @handles a question mentions ("what is @vlad working on"), lowercased. Bare names are left to Claude: a handle
// can be an everyday word (@dev), so matching words would send ordinary questions to one person's agents.
export function mentionedHandles(question: string): string[] {
  const out: string[] = [];
  for (const m of question.toLowerCase().matchAll(/(?:^|[^a-z0-9])@([a-z0-9]+(?:-[a-z0-9]+)*)/g)) {
    if (m[1] !== undefined && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

const ROUTER =
  "You route a developer's question to the crewmate's coding agent most likely to already know the answer, judging " +
  "from one-line summaries of what each agent is working on. Each agent is listed with its owner's @handle, and their " +
  "name when known. A question about a particular person (\"what is jimmy working on\", \"what did Ana change?\") can " +
  "only be answered by that person's own agents: if none of the agents belongs to that person, reply 0, even when the " +
  "work sounds related. Reply with only the number of the best agent, or 0 if none of them is likely to know.";

function answerer(owner: { handle: string; name?: string }): string {
  const who = `@${owner.handle}`;
  return (
    `You are the Operator for a crew of developers who each run coding agents. You get part of the conversation of ` +
    `${who}'s coding agent${owner.name === undefined ? "" : ` (${who} is ${owner.name})`} and a crewmate's question. ` +
    `Everything in that conversation is ${who}'s work: never say it is anyone else's, even if the question names ` +
    `someone else. If the question is about a person other than ${who}, or the conversation does not answer it, reply ` +
    `with exactly ${NOT_FOUND}. Otherwise answer from that conversation only, in at most three short sentences, naming ` +
    `files or functions when they help. Never repeat secrets, keys or credentials, even if they appear.`
  );
}

// One turn of the Operator chat: the Operator answers itself, or asks one crewmate's agent a question that stands alone.
export type ChatTurn = { reply: string } | { ask: number; question: string };

function chatter(me: string): string {
  return (
    `You are the Operator, the switchboard of a soopdoop crew: developers who each run coding agents. You are chatting ` +
    `with @${me}. You know which crewmates have an open agent and a one-line summary of what each agent is working on. ` +
    `You never see anyone's code or conversations. For each new message, do one of two things. Answer it yourself when ` +
    `it is small talk, about the crew (who is around, who works on what, going by the summaries), or about this chat. ` +
    `Or ask one crewmate's agent, when the answer needs that agent's own knowledge of the project; a question about a ` +
    `person goes only to that person's agents. Reply with JSON only, either {"reply": "<your answer>"} or ` +
    `{"ask": <agent number>, "question": "<the question for that agent, written to stand alone without this chat>"}. ` +
    `Keep a reply to three short sentences, plain and a little playful. Never make up facts about code or people.`
  );
}

// The JSON the chat call asked for. Anything else is taken as the Operator's own reply.
export function parseChatTurn(text: string, agents: number): ChatTurn {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (json !== undefined) {
    try {
      const raw: unknown = JSON.parse(json);
      if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        if ("ask" in raw && typeof raw.ask === "number" && Number.isInteger(raw.ask) && raw.ask >= 1 && raw.ask <= agents &&
          "question" in raw && typeof raw.question === "string" && raw.question.trim() !== "") {
          return { ask: raw.ask - 1, question: raw.question.trim().slice(0, 500) };
        }
        if ("reply" in raw && typeof raw.reply === "string" && raw.reply.trim() !== "") return { reply: raw.reply.trim() };
      }
    } catch {
      // Not JSON after all: read it as the reply.
    }
  }
  return { reply: text.trim() === "" ? "Hmm. Say that again?" : text.trim() };
}

// The Operator's turn in a chat with @me, given the chat so far and the crew's open agents.
export async function chatTurn(message: string, history: { you: string; operator: string }[], candidates: Candidate[], me: string): Promise<ChatTurn> {
  // A question about @someone goes only to their own agents.
  const mentioned = mentionedHandles(message);
  const pool = candidates.flatMap(function (c, i) { return mentioned.length === 0 || mentioned.includes(c.handle) ? [i] : []; });
  if (operatorMode() === "fake") {
    // The candidate whose summary shares a word with the message; otherwise the Operator answers itself.
    const q = words(message);
    for (const i of pool) {
      const c = candidates[i];
      if (c !== undefined && [...words(`${c.agentName} ${c.workspace ?? ""} ${c.summary ?? ""}`)].some(function (w) { return q.has(w); })) {
        return { ask: i, question: message };
      }
    }
    return { reply: pool.length === 0 ? "Nobody's agents are around right now. Just me." : "None of the agents I know about works on that." };
  }
  const listed = pool.flatMap(function (i, n) { const c = candidates[i]; return c === undefined ? [] : [candidateLine(c, n)]; });
  const said = history.map(function (h) { return `@${me}: ${h.you}\nOperator: ${h.operator}`; }).join("\n");
  const response = await client().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    output_config: { effort: "low" },
    system: chatter(me),
    messages: [{
      role: "user",
      content: `Agents:\n${listed.length === 0 ? "(nobody has an open agent running)" : listed.join("\n")}\n\n` +
        `Chat so far:\n${said === "" ? "(a new chat)" : said}\n\nNew message from @${me}: ${message}`,
    }],
  });
  if (response.stop_reason === "refusal") return { reply: "I'll pass on that one." };
  const turn = parseChatTurn(textOf(response.content), listed.length);
  if ("ask" in turn) {
    const index = pool[turn.ask];
    return index === undefined ? { reply: "I couldn't find the right agent for that." } : { ask: index, question: turn.question };
  }
  return turn;
}

// What a refused or failed Claude call means for the asker, in a sentence.
export function describeError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "The Operator's Claude API key was refused. The crew leader needs to set a working ANTHROPIC_API_KEY.";
  if (e instanceof Anthropic.PermissionDeniedError) return "The Operator's Claude API key may not use this model.";
  if (e instanceof Anthropic.RateLimitError) return "Claude is busy right now. Ask again in a minute.";
  if (e instanceof Anthropic.APIError) return `Claude answered with an error (${e.status ?? "no status"}). Ask again in a minute.`;
  return e instanceof Error ? e.message : String(e);
}

// The best candidate's index, or null when none is likely to know. Even a lone candidate is checked: reading an agent
// that cannot answer would show its owner's work to someone who asked about something, or someone, else.
export async function pickAgent(question: string, candidates: Candidate[]): Promise<number | null> {
  // A question about @someone goes only to their own agents. If they have none open, nothing is read.
  const mentioned = mentionedHandles(question);
  const pool = candidates.flatMap(function (c, i) { return mentioned.length === 0 || mentioned.includes(c.handle) ? [i] : []; });
  if (pool.length === 0) return null;
  if (operatorMode() === "fake") {
    // The candidate whose summary shares the most words with the question, or the first.
    const q = words(question);
    let best = pool[0] ?? null;
    let bestScore = -1;
    for (const i of pool) {
      const c = candidates[i];
      if (c === undefined) continue;
      const score = [...words(`${c.agentName} ${c.workspace ?? ""} ${c.summary ?? ""}`)].filter(function (w) { return q.has(w); }).length;
      if (score > bestScore) {
        best = i;
        bestScore = score;
      }
    }
    return best;
  }
  const listed = pool.flatMap(function (i) { const c = candidates[i]; return c === undefined ? [] : [c]; });
  const response = await client().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    output_config: { effort: "low" },
    system: ROUTER,
    messages: [{ role: "user", content: `Question: ${question}\n\nAgents:\n${listed.map(candidateLine).join("\n")}` }],
  });
  if (response.stop_reason === "refusal") return null;
  const n = Number(/\d+/.exec(textOf(response.content))?.[0] ?? "0");
  return Number.isInteger(n) && n >= 1 && n <= listed.length ? (pool[n - 1] ?? null) : null;
}

// The answer a crewmate's agent wrote itself: its daemon asked a fork of the agent's session. The Operator reads no
// conversation; it keeps the answer only when the question is about the agent's owner and the agent knew.
export function agentAnswer(question: string, text: string, owner: { handle: string }, tokensRead: number): Answer {
  const mentioned = mentionedHandles(question);
  const clean = text.trim();
  if ((mentioned.length > 0 && !mentioned.includes(owner.handle)) || clean === "" || clean.startsWith(NOT_FOUND)) {
    return { text: null, tokensRead, tokensSent: 0 };
  }
  return { text: clean, tokensRead, tokensSent: Math.ceil(clean.length / 4) };
}

// For daemons that still send a slice: answers the question from part of one crewmate's agent conversation, owner's
// work credited to the owner. The conversation is used for this call only.
export async function answerFrom(question: string, context: string, owner: { handle: string; name?: string }): Promise<Answer> {
  const mentioned = mentionedHandles(question);
  if (mentioned.length > 0 && !mentioned.includes(owner.handle)) return { text: null, tokensRead: 0, tokensSent: 0 };
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
    system: answerer(owner),
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
