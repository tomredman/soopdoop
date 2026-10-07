// ABOUTME: Introduces the crew's agents to this machine's agents: what crewmates' running agents work on, added to a session's
// ABOUTME: context when it starts (or at its first prompt), and agents that start later, at its next prompt. The crew comes from routing:crew.
import { isRecord } from "./state";

export interface CrewAgent {
  // The same while the agent runs.
  key: string;
  handle: string;
  name?: string;
  status: string;
  summary: string;
  // When the crew first heard of this agent (server time).
  since: number;
}

export interface CrewNow {
  // The server's clock when it was read.
  now: number;
  agents: CrewAgent[];
}

// The most agents an introduction names, and the longest line for one of them.
const MAX_INTRODUCED = 12;
const MAX_LINE = 320;

export function parseCrewNow(raw: unknown): CrewNow | null {
  if (!isRecord(raw) || typeof raw.now !== "number" || !Array.isArray(raw.agents)) return null;
  const agents: CrewAgent[] = [];
  for (const a of raw.agents) {
    if (!isRecord(a) || typeof a.key !== "string" || typeof a.handle !== "string" || typeof a.summary !== "string" || typeof a.since !== "number") continue;
    const agent: CrewAgent = { key: a.key, handle: a.handle, status: typeof a.status === "string" ? a.status : "idle", summary: a.summary, since: a.since };
    if (typeof a.name === "string") agent.name = a.name;
    agents.push(agent);
  }
  return { now: raw.now, agents };
}

export function agentLine(a: CrewAgent): string {
  const who = a.name === undefined ? `@${a.handle}` : `@${a.handle} (${a.name})`;
  const line = `- ${who}, ${a.status === "working" ? "working" : "idle"}: ${a.summary}`;
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line;
}

const HOW_TO_ASK =
  "When your user's task touches one of these, ask that agent before you build on or change that part: call ask_operator " +
  "with the crewmate's @handle in the question. It answers from what it knows; it does not do work for you.";

// Everything a new session is told about the crew. Null when no crewmate has an agent to introduce.
export function introduction(crew: CrewNow): string | null {
  if (crew.agents.length === 0) return null;
  const shown = crew.agents.slice(0, MAX_INTRODUCED);
  const more = crew.agents.length - shown.length;
  return [
    "soopdoop: your crewmates' agents running now, and what each one is working on.",
    ...shown.map(agentLine),
    ...(more > 0 ? [`- and ${more} more. ask_operator reaches them too.`] : []),
    HOW_TO_ASK,
  ].join("\n");
}

// The agents the crew heard of after `seenAt`. Null when there are none.
export function news(crew: CrewNow, seenAt: number): string | null {
  const fresh = crew.agents.filter(function (a) { return a.since > seenAt; }).slice(0, MAX_INTRODUCED);
  if (fresh.length === 0) return null;
  return [
    `soopdoop: ${fresh.length === 1 ? "a crewmate's agent" : "crewmates' agents"} started since you last heard about your crew.`,
    ...fresh.map(agentLine),
    "If your work touches theirs, ask that agent with ask_operator and the crewmate's @handle in the question.",
  ].join("\n");
}

export interface Introducer {
  // What to add to the session's context for one hook event, or null.
  contextFor(event: string, sessionId: string): Promise<string | null>;
  // Reads the crew again when the copy is older than `maxAgeMs`. The daemon's heartbeat calls it.
  refresh(maxAgeMs: number): Promise<void>;
  // Forgets sessions that ended.
  keepOnly(sessionIds: Set<string>): void;
}

export interface IntroducerOptions {
  // A session that starts gets a copy of the crew at most this old; it waits up to `waitMs` for a fresh one.
  maxAgeMs?: number;
  waitMs?: number;
  clock?: () => number;
}

// `readCrew` asks the backend (routing:crew). Prompts never wait for it: they use the last copy and read again behind it.
export function introducer(readCrew: () => Promise<unknown>, options: IntroducerOptions = {}): Introducer {
  const maxAgeMs = options.maxAgeMs ?? 30_000;
  const waitMs = options.waitMs ?? 1_500;
  const clock = options.clock ?? Date.now;
  let copy: { at: number; crew: CrewNow } | null = null;
  let reading: Promise<CrewNow | null> | null = null;
  // For each session: the server time of the crew it was last told about.
  const seen = new Map<string, number>();

  function read(): Promise<CrewNow | null> {
    if (reading !== null) return reading;
    reading = readCrew()
      .then(function (raw) {
        const crew = parseCrewNow(raw);
        if (crew !== null) copy = { at: clock(), crew };
        return crew;
      })
      .catch(function () { return null; })
      .finally(function () { reading = null; });
    return reading;
  }

  // The crew, read again first when the copy is too old, waiting at most waitMs for it. Null when there is none at all.
  async function current(): Promise<CrewNow | null> {
    if (copy !== null && clock() - copy.at < maxAgeMs) return copy.crew;
    // Undefined when the read takes too long; it still lands in the copy for the next prompt.
    const got = await Promise.race([read(), Bun.sleep(waitMs).then(function () { return undefined; })]);
    return got ?? copy?.crew ?? null;
  }

  async function introduce(sessionId: string): Promise<string | null> {
    const crew = await current();
    // Without a crew to go by, the next prompt tries again.
    if (crew === null) {
      seen.delete(sessionId);
      return null;
    }
    seen.set(sessionId, crew.now);
    return introduction(crew);
  }

  return {
    async contextFor(event, sessionId) {
      // A new, resumed, cleared or compacted session: the whole introduction.
      if (event === "SessionStart") return await introduce(sessionId);
      if (event !== "UserPromptSubmit") return null;
      const seenAt = seen.get(sessionId);
      // A session this daemon has not introduced (it started while the daemon was down, or it restarted): introduce it now.
      if (seenAt === undefined) return await introduce(sessionId);
      if (copy === null || clock() - copy.at >= maxAgeMs) void read();
      if (copy === null) return null;
      const crew = copy.crew;
      if (crew.now > seenAt) seen.set(sessionId, crew.now);
      return news(crew, seenAt);
    },
    async refresh(maxAge) {
      if (copy === null || clock() - copy.at >= maxAge) await read();
    },
    keepOnly(sessionIds) {
      for (const id of [...seen.keys()]) if (!sessionIds.has(id)) seen.delete(id);
    },
  };
}
