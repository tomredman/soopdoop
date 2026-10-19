// ABOUTME: Heads-ups on this Mac: each prompt is scored here, with no network, against what crewmates' agents are on now (their
// ABOUTME: routing summaries), what the crew did lately (its ledger) and same-file collisions. Over the line: a HUD card and a note. The prompt is then dropped.
import { isRecord } from "./state";
import type { CrewNow } from "./intro";

// Points: a shared word 1, a shared folder or file name part 2, a path or file name the prompt writes out 5. A heads-up about a
// running agent needs 6, so one word or one folder in common is never enough. A ledger line is one short sentence and its
// areas, with no files, so past work needs 4; it is looked at only when no running agent is on it. Both were picked against
// made-up prompts that must and must not fire (headsups-local.test.ts).
export const THRESHOLD = 6;
export const PAST_THRESHOLD = 4;
const WORD = 1;
const PART = 2;
const PATH = 5;
// One heads-up per crewmate agent per session in this long; the backend keeps a card open for 10 minutes.
export const QUIET_MS = 60 * 60 * 1000;
// The most heads-ups one prompt makes.
const MAX_HITS = 2;
const MAX_LINE = 240;
const LEDGER_EVERY_MS = 5 * 60 * 1000;

// Words in any prompt or any line of work, which say nothing about which work it is (the backend's ledger search list, and
// words every coding prompt has).
const STOP = new Set([
  "about", "after", "again", "agent", "agents", "also", "anybody", "anyone", "been", "before", "being", "could", "does",
  "doing", "done", "file", "files", "from", "have", "here", "into", "just", "know", "knows", "last", "like", "made",
  "make", "makes", "more", "most", "much", "need", "needs", "only", "over", "please", "should", "some", "someone",
  "something", "than", "that", "their", "them", "then", "there", "these", "they", "thing", "things", "this", "those",
  "want", "what", "when", "where", "which", "while", "with", "work", "worked", "working", "works", "would", "your",
  "able", "actually", "already", "because", "check", "class", "code", "const", "data", "different", "each", "error",
  "errors", "every", "false", "first", "function", "going", "good", "help", "instead", "issue", "issues",
  "line", "lines", "look", "looks", "maybe", "method", "name", "next", "null", "okay", "other", "page", "really", "return",
  "right", "same", "seems", "since", "still", "string", "sure", "thank", "thanks", "think", "true", "type", "types",
  "undefined", "update", "using", "value", "values", "well", "without", "wrong", "yeah", "change", "changes", "fixed", "added",
  "remove", "test", "tests", "build", "fails", "failing", "broken", "number",
]);

// Three-letter words of a prompt that are not folder names.
const STOP3 = new Set([
  "all", "and", "any", "are", "but", "can", "did", "for", "get", "had", "has", "her", "him", "his", "how", "its", "new",
  "not", "now", "one", "our", "out", "see", "set", "she", "the", "two", "use", "was", "who", "why", "you", "fix", "bug",
  "add", "let", "way", "too", "yes", "own", "via", "per",
]);

// Folder names and file endings every project has.
const GENERIC = new Set([
  "app", "apps", "build", "css", "dist", "html", "index", "json", "jsx", "lib", "libs", "package", "packages", "src", "swift",
  "test", "tests", "tsx", "source", "sources", "spec", "specs", "util", "utils", "public", "assets", "main", "mjs", "cjs",
  "yaml", "yml", "toml", "scss",
]);

// File names every project has: never a collision, never a match by name.
const GENERIC_FILE = /^(?:index|main|readme|claude|agents|changelog|license|makefile|dockerfile)(?:\.[a-z]+)?$|^(?:package(?:-lock)?\.json|tsconfig[\w.-]*\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|\.gitignore|\.env[\w.]*)$/;
const FILE_NAME = /^[a-z0-9_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|swift|kt|java|md|mdx|json|css|scss|html|sql|yml|yaml|toml|sh|vue|svelte)$/;

function stem(word: string): string {
  let w = word;
  if (w.length > 5 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  return w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
}

// The words of a text that can say what it is about: lowercase, four letters or more, stemmed.
export function terms(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) if (word.length >= 4 && !STOP.has(word)) out.add(stem(word));
  return out;
}

// The names in a path that can say what it is about, three letters or more: "apps/web/quote/Form.tsx" is web, quote, form.
function pathParts(p: string): Set<string> {
  const out = new Set<string>();
  for (const part of p.toLowerCase().split(/[^a-z0-9]+/)) if (part.length >= 3 && !GENERIC.has(part) && !STOP.has(part)) out.add(stem(part));
  return out;
}

// Three-letter words that can name a topic or a folder: "csv", "sso", "hud", "m10".
function shortWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) if (w.length === 3 && !STOP3.has(w) && !GENERIC.has(w)) out.add(w);
  return out;
}

function baseName(p: string): string {
  return (p.split("/").pop() ?? p).toLowerCase();
}

// A routing summary, as the daemon builds it and the backend passes it on: `[<folder>@<branch> · ]"<last prompt>" · files: a, b`.
// The folder is left off unless its owner shares folder names. Files outside the agent's folder are shortened to "…/a/b/c".
export function parseSummary(summary: string): { workspace?: string; prompt?: string; files: string[] } {
  let rest = summary.trim();
  let files: string[] = [];
  const at = rest.lastIndexOf(" · files: ");
  if (at !== -1 || rest.startsWith("files: ")) {
    const list = at !== -1 ? rest.slice(at + " · files: ".length) : rest.slice("files: ".length);
    files = list.split(", ").map(function (f) { return f.trim(); }).filter(function (f) { return f !== ""; });
    rest = at !== -1 ? rest.slice(0, at) : "";
  }
  const out: { workspace?: string; prompt?: string; files: string[] } = { files };
  const quote = rest.indexOf("\"");
  if (quote === -1) {
    if (rest !== "") out.workspace = rest;
    return out;
  }
  const before = rest.slice(0, quote).replace(/\s*·\s*$/, "").trim();
  if (before !== "") out.workspace = before;
  out.prompt = rest.slice(quote + 1).replace(/"\s*$/, "");
  return out;
}

// What one crewmate's agent (or line of work) is scored on. Built once per copy of the crew or the ledger, not per prompt.
interface Target {
  handle: string;
  otherAgentId: string;
  live: boolean;
  words: Set<string>;
  parts: Set<string>;
  // Its files (live) or areas (ledger), lowercase, to match paths the prompt writes out.
  paths: string[];
  names: Set<string>;
  // Live only: its files inside its folder, as written, for collisions.
  files: string[];
  // What the note and the card show.
  areas: string[];
  topic: string;
  at?: number;
}

function folderOf(file: string): string {
  const parts = file.split("/").slice(0, -1);
  return parts.slice(0, 3).join("/");
}

function liveTarget(key: string, handle: string, summary: string): Target {
  const parsed = parseSummary(summary);
  const inside = parsed.files.filter(function (f) { return !f.startsWith("…/") && !f.startsWith("/"); });
  const parts = shortWords(parsed.prompt ?? "");
  for (const f of parsed.files) for (const p of pathParts(f.replace(/^…\//, ""))) parts.add(p);
  const areas: string[] = [];
  for (const f of inside) {
    const folder = folderOf(f);
    if (folder !== "" && !areas.includes(folder)) areas.push(folder);
  }
  return {
    handle,
    otherAgentId: key,
    live: true,
    words: terms(`${parsed.prompt ?? ""} ${parsed.workspace ?? ""}`),
    parts,
    paths: inside.map(function (f) { return f.toLowerCase(); }),
    names: new Set(inside.map(baseName).filter(function (n) { return !GENERIC_FILE.test(n); })),
    files: inside,
    areas: areas.slice(0, 3),
    topic: parsed.prompt ?? "",
  };
}

// One line of crewmates' recent work, as ledger:crewRecent returns it.
export interface CrewLine {
  handle: string;
  name?: string;
  did: string;
  areas: string[];
  at: number;
  workspace?: string;
  harness: string;
  shipped?: boolean;
}

export function parseCrewLines(raw: unknown): CrewLine[] | null {
  if (!Array.isArray(raw)) return null;
  const out: CrewLine[] = [];
  for (const l of raw) {
    if (!isRecord(l) || typeof l.handle !== "string" || typeof l.did !== "string" || typeof l.at !== "number") continue;
    const line: CrewLine = {
      handle: l.handle,
      did: l.did,
      areas: Array.isArray(l.areas) ? l.areas.filter(function (a): a is string { return typeof a === "string"; }) : [],
      at: l.at,
      harness: typeof l.harness === "string" ? l.harness : "claude-code",
    };
    if (typeof l.name === "string") line.name = l.name;
    if (typeof l.workspace === "string") line.workspace = l.workspace;
    if (l.shipped === true) line.shipped = true;
    out.push(line);
  }
  return out;
}

function ledgerTarget(line: CrewLine): Target {
  const parts = shortWords(line.did);
  for (const a of line.areas) for (const p of pathParts(a)) parts.add(p);
  return {
    handle: line.handle,
    // Past work has no running agent to point at: one card per crewmate.
    otherAgentId: `ledger:${line.handle}`,
    live: false,
    words: terms(`${line.did} ${line.workspace ?? ""}`),
    parts,
    paths: line.areas.map(function (a) { return a.toLowerCase().replace(/\/+$/, ""); }),
    names: new Set(),
    files: [],
    areas: line.areas.slice(0, 3),
    topic: line.did,
    at: line.at,
  };
}

interface PromptFeatures {
  words: Set<string>;
  parts: Set<string>;
  paths: string[];
  names: Set<string>;
}

// Prompts can be long (a pasted log); what they are about is in their first 8,000 characters.
export function readPrompt(prompt: string): PromptFeatures {
  const text = prompt.slice(0, 8_000);
  const words = terms(text);
  const parts = new Set(words);
  const paths: string[] = [];
  const names = new Set<string>();
  for (const raw of text.toLowerCase().split(/\s+/)) {
    // Without what ends a sentence or wraps a path: "apps/web/quote." is apps/web/quote, `src/x.ts` is src/x.ts.
    const t = raw.replace(/^[^a-z0-9._/@-]+|[^a-z0-9_/-]+$/g, "").replace(/^(?:\.\/|@\/)/, "").replace(/[./]+$/, "");
    if (t === "") continue;
    if (t.includes("/")) {
      paths.push(t);
      for (const p of pathParts(t)) parts.add(p);
    }
    const name = baseName(t);
    if (FILE_NAME.test(name) && !GENERIC_FILE.test(name)) names.add(name);
    // A short word can name a folder: "the hud", "the api".
    for (const w of t.split(/[^a-z0-9]+/)) if (w.length === 3 && !STOP3.has(w) && !GENERIC.has(w)) parts.add(w);
  }
  return { words, parts, paths, names };
}

function pathMatches(promptPath: string, target: string): boolean {
  return promptPath === target || target.startsWith(`${promptPath}/`) || target.endsWith(`/${promptPath}`) || promptPath.startsWith(`${target}/`);
}

// How well a prompt fits what a crewmate's agent is on, or what they did.
export function score(q: PromptFeatures, t: Target): number {
  let n = 0;
  for (const w of t.words) if (q.words.has(w)) n += WORD;
  for (const p of t.parts) if (q.parts.has(p)) n += PART;
  for (const p of q.paths) if (t.paths.some(function (tp) { return pathMatches(p, tp); })) n += PATH;
  for (const name of q.names) if (t.names.has(name)) n += PATH;
  return n;
}

export interface HeadsUp {
  otherHandle: string;
  otherAgentId: string;
  kind: "area" | "files";
  // The HUD card's line, from what the crewmate shares. Never anything from the prompt.
  line: string;
  live: boolean;
  areas: string[];
  // A collision's files.
  files: string[];
  // Past work's day ("15 Oct").
  day?: string;
}

function cut(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "16 Oct", in this Mac's time zone.
export function dayOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()] ?? ""}`;
}

function where(areas: string[]): string {
  return areas.length === 0 ? "" : ` (${areas.join(", ")})`;
}

function hitOf(t: Target, collision: string[]): HeadsUp {
  if (collision.length > 0) {
    return {
      otherHandle: t.handle, otherAgentId: t.otherAgentId, kind: "files", live: true, areas: t.areas, files: collision,
      line: cut(`@${t.handle}'s agent is changing the same files right now: ${collision.slice(0, 3).join(", ")}`, MAX_LINE),
    };
  }
  if (t.live) {
    const topic = t.topic === "" ? "" : `: "${cut(t.topic, 110)}"`;
    return { otherHandle: t.handle, otherAgentId: t.otherAgentId, kind: "area", live: true, areas: t.areas, files: [], line: cut(`@${t.handle}'s agent is on this now${where(t.areas)}${topic}`, MAX_LINE) };
  }
  const day = t.at === undefined ? undefined : dayOf(t.at);
  return {
    otherHandle: t.handle, otherAgentId: t.otherAgentId, kind: "area", live: false, areas: t.areas, files: [],
    line: cut(`@${t.handle} worked on this${day === undefined ? "" : ` on ${day}`}${where(t.areas)}: ${t.topic}`, MAX_LINE),
    ...(day === undefined ? {} : { day }),
  };
}

// The note an agent reads (Claude Code and Codex). One line per heads-up.
export function headsUpNote(hits: HeadsUp[]): string | null {
  if (hits.length === 0) return null;
  return hits.map(function (h) {
    const ask = `ask it (ask_operator with @${h.otherHandle}) or hand it off (hand_off with @${h.otherHandle}) before you build.`;
    if (h.kind === "files") return `soopdoop: @${h.otherHandle}'s agent is changing the same files right now (${h.files.slice(0, 3).join(", ")}); ${ask}`;
    if (h.live) return `soopdoop: @${h.otherHandle}'s agent is on this area now${where(h.areas)}; ${ask}`;
    return `soopdoop: @${h.otherHandle} worked on this area${h.day === undefined ? "" : ` on ${h.day}`}${where(h.areas)} and their agent on it is not running; ` +
      `ask (ask_operator with @${h.otherHandle}) or hand it off (hand_off with @${h.otherHandle}) before you build.`;
  }).join("\n");
}

export interface HeadsUps {
  // The heads-ups for one prompt of one of this Mac's open sessions, each at most once an hour per crewmate agent. No network.
  check(sessionId: string, prompt: string): HeadsUp[];
  // This session's own routing summary (after a turn): its files, for collisions.
  ownSummary(sessionId: string, summary: string): void;
  // Reads ledger:crewRecent again when the copy is older than maxAgeMs. The heartbeat calls it.
  refreshLedger(maxAgeMs?: number): Promise<void>;
  keepOnly(sessionIds: Set<string>): void;
}

export interface HeadsUpOptions {
  // The introducer's copy of routing:crew.
  crew: () => CrewNow | null;
  // ledger:crewRecent with 14 days.
  readLedger: () => Promise<unknown>;
  clock?: () => number;
  quietMs?: number;
}

export function headsUpper(options: HeadsUpOptions): HeadsUps {
  const clock = options.clock ?? Date.now;
  const quietMs = options.quietMs ?? QUIET_MS;
  let ledger: { at: number; lines: CrewLine[] } | null = null;
  let reading: Promise<void> | null = null;
  // Targets, rebuilt when the crew's copy or the ledger's changes.
  let builtFrom: { crew: CrewNow | null; ledger: CrewLine[] | null } = { crew: null, ledger: null };
  let live: Target[] = [];
  let past: Target[] = [];
  const own = new Map<string, Set<string>>();
  // For each session: when each crewmate agent was last named to it.
  const told = new Map<string, Map<string, number>>();

  function targets(): void {
    const crew = options.crew();
    const lines = ledger?.lines ?? null;
    if (crew === builtFrom.crew && lines === builtFrom.ledger) return;
    builtFrom = { crew, ledger: lines };
    live = (crew?.agents ?? []).map(function (a) { return liveTarget(a.key, a.handle, a.summary); });
    past = (lines ?? []).map(ledgerTarget);
  }

  return {
    check(sessionId, prompt) {
      targets();
      if (live.length === 0 && past.length === 0) return [];
      const q = readPrompt(prompt);
      const mine = own.get(sessionId) ?? new Set<string>();
      const found: { t: Target; points: number; collision: string[] }[] = [];
      for (const t of live) {
        const collision = t.files.filter(function (f) { return mine.has(f) && !GENERIC_FILE.test(baseName(f)) && f.includes("/"); });
        const points = score(q, t);
        if (collision.length > 0 || points >= THRESHOLD) found.push({ t, points, collision });
      }
      // Past work only when no crewmate's running agent is on it: the best line of each crewmate.
      if (found.length === 0) {
        const best = new Map<string, { t: Target; points: number }>();
        for (const t of past) {
          const points = score(q, t);
          const was = best.get(t.handle);
          if (points >= PAST_THRESHOLD && (was === undefined || points > was.points || (points === was.points && (t.at ?? 0) > (was.t.at ?? 0)))) best.set(t.handle, { t, points });
        }
        for (const b of best.values()) found.push({ t: b.t, points: b.points, collision: [] });
      }
      found.sort(function (a, b) { return b.collision.length - a.collision.length || b.points - a.points; });
      const now = clock();
      const named = told.get(sessionId) ?? new Map<string, number>();
      const out: HeadsUp[] = [];
      for (const f of found) {
        if (out.length === MAX_HITS) break;
        const last = named.get(f.t.otherAgentId);
        if (last !== undefined && now - last < quietMs) continue;
        if (out.some(function (h) { return h.otherAgentId === f.t.otherAgentId; })) continue;
        named.set(f.t.otherAgentId, now);
        out.push(hitOf(f.t, f.collision));
      }
      told.set(sessionId, named);
      return out;
    },
    ownSummary(sessionId, summary) {
      own.set(sessionId, new Set(parseSummary(summary).files.filter(function (f) { return !f.startsWith("…/") && !f.startsWith("/"); })));
    },
    async refreshLedger(maxAgeMs = LEDGER_EVERY_MS) {
      if (ledger !== null && clock() - ledger.at < maxAgeMs) return;
      if (reading !== null) return await reading;
      reading = options.readLedger()
        .then(function (raw) {
          const lines = parseCrewLines(raw);
          if (lines !== null) ledger = { at: clock(), lines };
        })
        .catch(function () { /* the next heartbeat tries again */ })
        .finally(function () { reading = null; });
      await reading;
    },
    keepOnly(sessionIds) {
      for (const id of [...own.keys()]) if (!sessionIds.has(id)) own.delete(id);
      for (const id of [...told.keys()]) if (!sessionIds.has(id)) told.delete(id);
    },
  };
}
