// ABOUTME: The Operator's Claude calls: route an agent's question (answer from the summaries, or pick the agent that knows),
// ABOUTME: chat with a hacker, answer from a slice for older daemons; plus @handle matching and answer checks. OPERATOR_FAKE=1 skips Claude.
import Anthropic from "@anthropic-ai/sdk";
import { env } from "../_generated/server";

const MODEL = "claude-opus-5-5";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
export const NOT_FOUND = "NOT_FOUND";
export const NOT_CONFIGURED = "The Operator has no Claude API key yet. The crew leader sets ANTHROPIC_API_KEY on the deployment.";
// The Operator's own answer to an agent is cut here, like an agent's answer on its owner's machine.
const MAX_REPLY = 2_000;

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
// can be an everyday word (@dev), so matching words would send ordinary questions to one person's agents. "@Évariste" is
// not a mention: a handle has no letters like "É".
export function mentionedHandles(question: string): string[] {
  const out: string[] = [];
  for (const m of question.toLowerCase().matchAll(/(?:^|[^a-z0-9])@([a-z0-9]+(?:-[a-z0-9]+)*)(?![\p{L}\p{N}])/gu)) {
    if (m[1] !== undefined && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

// A crewmate as a question may name them: their soopdoop handle, and the Superset handle and name they linked, if any.
export interface Crewmate {
  handle: string;
  name?: string;
  supersetHandle?: string;
}

// Lowercase and without accents, so "Évariste" reads as "evariste".
function plain(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// The crewmates an @mention can mean: the one with that handle; else the one who linked that Superset handle; else each
// one whose handle, Superset handle, or a word of whose name starts with it ("@ada" finds @adalovelace). Exactly one is
// a match. None, or more than one, is for the asker to sort out.
export function crewmatesFor(mention: string, crew: Crewmate[]): Crewmate[] {
  const m = plain(mention);
  const exact = crew.filter(function (c) { return c.handle === m; });
  if (exact.length > 0) return exact;
  const linked = crew.filter(function (c) { return c.supersetHandle !== undefined && plain(c.supersetHandle) === m; });
  if (linked.length > 0) return linked;
  if (m.length < 2) return [];
  return crew.filter(function (c) {
    const names = [c.handle, plain(c.supersetHandle ?? ""), ...plain(c.name ?? "").split(/[^a-z0-9]+/)];
    return names.some(function (n) { return n !== "" && n.startsWith(m); });
  });
}

// A question with each @mention written as the handle it means, and the mentions that mean nobody in the crew, or more
// than one crewmate.
export interface Mentions {
  question: string;
  unknown: string[];
  unclear: { mention: string; handles: string[] }[];
}

// The same mentions as mentionedHandles, in any case.
const MENTION = /(^|[^A-Za-z0-9])@([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)(?![\p{L}\p{N}])/gu;

// "@ada" becomes "@adalovelace" when she is the only crewmate it can mean, so her agents are the ones asked and the
// answer is checked against her handle. The asker's own handle is left as it is.
export function resolveMentions(question: string, crew: Crewmate[], me: string): Mentions {
  const unknown: string[] = [];
  const unclear: { mention: string; handles: string[] }[] = [];
  const text = question.replace(MENTION, function (whole: string, before: string, raw: string) {
    const mention = raw.toLowerCase();
    if (mention === me) return whole;
    const fits = crewmatesFor(mention, crew);
    const only = fits.length === 1 ? fits[0] : undefined;
    if (only !== undefined) return only.handle === mention ? whole : `${before}@${only.handle}`;
    if (fits.length === 0) {
      if (!unknown.includes(mention)) unknown.push(mention);
    } else if (!unclear.some(function (u) { return u.mention === mention; })) {
      unclear.push({ mention, handles: fits.map(function (f) { return f.handle; }) });
    }
    return whole;
  });
  return { question: text, unknown, unclear };
}

// What the Operator says when a question names someone it cannot place: who, and the crew to pick from.
export function mentionNote(m: Mentions, crew: Crewmate[]): string {
  const said = m.unknown.map(function (h) { return `Nobody in your crew is @${h}.`; });
  for (const u of m.unclear) said.push(`@${u.mention} could be ${u.handles.map(function (h) { return `@${h}`; }).join(" or ")}.`);
  const list = crew.map(function (c) { return c.name === undefined ? `@${c.handle}` : `@${c.handle} (${c.name})`; });
  said.push(list.length === 0 ? "You have no crewmates on soopdoop yet." : `Your crew: ${list.join(", ")}.`);
  return said.join(" ");
}

// For a question that names crewmates when none of them has an open agent running: who is missing, in a sentence.
// Null when one of them has.
export function absentNote(question: string, candidates: Candidate[], me: string): string | null {
  const mentioned = mentionedHandles(question);
  if (mentioned.length === 0 || candidates.some(function (c) { return mentioned.includes(c.handle); })) return null;
  return mentioned
    .map(function (h) {
      return h === me ? `@${h} is you, and the Operator only asks your crewmates' agents.` : `@${h} has no open agent running right now.`;
    })
    .join(" ");
}

const ROUTER =
  "You are the Operator of a soopdoop crew: developers who each run coding agents. One of their agents asks you a " +
  "question, often for its user. You see the crew's open agents, each with its owner's @handle (and their name, " +
  "when known) and a one-line summary of what the agent is working on. You never see code or conversations. Do one " +
  "of three things. Reply yourself only when the question just asks who knows about or works on something (\"who " +
  "should I ask about checkout?\", \"who's on enrichment?\") or what someone, or the crew, is working on (\"what is " +
  "jimmy working on?\"), and the summaries answer every part of it; an agent with no summary does not stop you from " +
  "answering about the others. Ask an agent when any part needs that agent's own knowledge: how something works, " +
  "where it lives, why it was done that way, what it changes, which files, what is half done, or whether something " +
  "is still true. Pick the one most likely to know. When a summary only hints at the answer, ask that agent instead " +
  "of guessing or saying what the summary leaves out. Say nobody knows when no agent is likely to know. A question " +
  "about one person can only be answered from that person's own agents. A reply sounds like a teammate in a chat: " +
  "one or two short sentences, about the people and their work, with the person's first name when you know it and " +
  "their @handle once. To a who-question, say who has an agent on it and end with \"What would you like to know?\", " +
  "for example: \"Ada (@adalovelace) has an agent on enrichment right now. What would you like to know?\" To a " +
  "who-question that no agent fits, say in one sentence that nobody in the crew is on it right now. Never name the " +
  "agents, never describe the list of agents (how many there are, or whose), and never talk about summaries, " +
  "statuses or what you can see. Never confirm or deny what the summaries do not say, and never make up facts about " +
  "code or people. Reply with JSON only, one of {\"reply\": \"<your answer>\"}, {\"ask\": <agent number>} or " +
  "{\"nobody\": true}.";

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
    `person goes only to that person's agents. When @${me} asks who knows about something or who to ask, say who has an ` +
    `agent on it and ask what they would like to know; their answer goes to that agent. Reply with JSON only, either ` +
    `{"reply": "<your answer>"} or {"ask": <agent number>, "question": "<the question for that agent, written to stand ` +
    `alone without this chat>"}. Keep a reply to three short sentences, plain and a little playful, about the people and ` +
    `their work. Never name the agents, never describe the list of agents, and never talk about summaries or what you ` +
    `can see. Never make up facts about code or people.`
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

// What the Operator does with an agent's question: answers it itself from the summaries, asks one agent (an index into
// the candidates), or neither (null) when no agent is likely to know.
export type Route = { reply: string } | { ask: number } | null;

// The router's JSON, for `agents` listed agents. A bare number is read as an agent, the way the router used to answer;
// anything else as nobody.
export function parseRoute(text: string, agents: number): Route {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (json === undefined) {
    const n = Number(/\d+/.exec(text)?.[0] ?? "0");
    return Number.isInteger(n) && n >= 1 && n <= agents ? { ask: n - 1 } : null;
  }
  try {
    const raw: unknown = JSON.parse(json);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    if ("ask" in raw && typeof raw.ask === "number" && Number.isInteger(raw.ask) && raw.ask >= 1 && raw.ask <= agents) {
      return { ask: raw.ask - 1 };
    }
    if ("reply" in raw && typeof raw.reply === "string" && raw.reply.trim() !== "") return { reply: raw.reply.trim().slice(0, MAX_REPLY) };
  } catch {
    // Not JSON after all.
  }
  return null;
}

// "Ada (@adalovelace)", or "@adalovelace" without a linked name.
export function firstNameAndHandle(c: { handle: string; name?: string }): string {
  const first = c.name?.trim().split(/\s+/)[0];
  return first === undefined || first === "" ? `@${c.handle}` : `${first} (@${c.handle})`;
}

// For fake mode: the candidate in `pool` whose agent shares the most words with the question, and how many.
function bestFit(question: string, pool: number[], candidates: Candidate[]): { index: number; score: number } | null {
  const q = words(question);
  let best: { index: number; score: number } | null = null;
  for (const i of pool) {
    const c = candidates[i];
    if (c === undefined) continue;
    const score = [...words(`${c.agentName} ${c.workspace ?? ""} ${c.summary ?? ""}`)].filter(function (w) { return q.has(w); }).length;
    if (best === null || score > best.score) best = { index: i, score };
  }
  return best;
}

// Routes an agent's question. A question about @someone goes only to their own agents; if they have none open, nothing
// is read. Even a lone candidate is checked: reading an agent that cannot answer would show its owner's work to someone
// who asked about something, or someone, else.
export async function routeQuestion(question: string, candidates: Candidate[]): Promise<Route> {
  const mentioned = mentionedHandles(question);
  const pool = candidates.flatMap(function (c, i) { return mentioned.length === 0 || mentioned.includes(c.handle) ? [i] : []; });
  if (pool.length === 0) return null;
  if (operatorMode() === "fake") {
    // "What is … working on?" with summaries to go by: those summaries. "Who …?": the crewmate whose agent fits best,
    // and what they would like to know. Otherwise the candidate whose summary shares the most words with the question,
    // or the first.
    const known = pool.flatMap(function (i) {
      const c = candidates[i];
      return c?.summary === undefined ? [] : [`@${c.handle}'s agent: ${c.summary}`];
    });
    if (/\bworking on\b/i.test(question) && known.length > 0) return { reply: known.join(" ") };
    const best = bestFit(question, pool, candidates);
    if (/^\s*who\b/i.test(question)) {
      const c = best === null || best.score === 0 ? undefined : candidates[best.index];
      return c === undefined ? null : { reply: `${firstNameAndHandle(c)} has an agent on that right now. What would you like to know?` };
    }
    return best === null ? null : { ask: best.index };
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
  const route = parseRoute(textOf(response.content), listed.length);
  if (route === null || "reply" in route) return route;
  const index = pool[route.ask];
  return index === undefined ? null : { ask: index };
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
