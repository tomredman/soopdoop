// ABOUTME: Ranks ledger lines against a question: shared words of four letters or more, folders and the parts of paths,
// ABOUTME: and a small bonus for recent work. The Operator searches the crew's ledger with it; hand-offs pick an agent with it.

const DAY_MS = 24 * 60 * 60 * 1000;
// Work this old gets no recency bonus.
const RECENT_MS = 30 * DAY_MS;
// Under 1, so recency only orders lines that match equally well.
const RECENT_BONUS = 0.9;

// Words that turn up in any question or any line of work, so they say nothing about which work it is.
const STOP = new Set([
  "about", "after", "again", "agent", "agents", "also", "anybody", "anyone", "been", "before", "being", "could", "does",
  "doing", "done", "file", "files", "from", "have", "here", "into", "just", "know", "knows", "last", "like", "made",
  "make", "makes", "more", "most", "much", "need", "needs", "only", "over", "please", "should", "some", "someone",
  "something", "than", "that", "their", "them", "then", "there", "these", "they", "thing", "things", "this", "those",
  "want", "what", "when", "where", "which", "while", "with", "work", "worked", "working", "works", "would", "your",
]);

// Three-letter words of a question that are not folder names.
const STOP3 = new Set([
  "all", "and", "any", "are", "but", "can", "did", "for", "get", "had", "has", "her", "him", "his", "how", "its", "new",
  "not", "now", "one", "our", "out", "see", "set", "she", "the", "two", "use", "was", "who", "why", "you",
]);

// Folder names and file endings every project has.
const GENERIC = new Set([
  "app", "apps", "build", "css", "dist", "html", "index", "json", "jsx", "lib", "libs", "package", "packages", "src",
  "swift", "test", "tests", "tsx",
]);

function stem(word: string): string {
  return word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

// The words of a text that can say what it is about: lowercase, four letters or more, without a plural "s".
export function terms(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length >= 4 && !STOP.has(word)) out.add(stem(word));
  }
  return out;
}

// The names in a path that can say what it is about, three letters or more: "apps/web/quote" is web and quote.
function pathParts(path: string): Set<string> {
  const out = new Set<string>();
  for (const part of path.toLowerCase().split(/[^a-z0-9]+/)) {
    if (part.length >= 3 && !GENERIC.has(part)) out.add(stem(part));
  }
  return out;
}

interface Query {
  words: Set<string>;
  // The words, and short words standing on their own, matched against the names of the folders a line touched.
  parts: Set<string>;
  // Paths written in the question, like apps/web/quote/Form.tsx: matched against whole folders.
  paths: string[];
}

function readQuery(text: string): Query {
  const tokens = text
    .toLowerCase()
    .split(/\s+/)
    .map(function (t) { return t.replace(/^[^a-z0-9._/-]+|[^a-z0-9._/-]+$/g, "").replace(/\/+$/, ""); });
  const words = terms(text);
  const parts = new Set(words);
  const paths: string[] = [];
  for (const t of tokens) {
    // A path is matched whole, so a folder in the middle of it ("web" in apps/web/quote) does not match others.
    if (t.includes("/")) {
      paths.push(t);
      continue;
    }
    // A short word can name a folder: "the hud", "the api".
    for (const w of t.split(/[^a-z0-9]+/)) if (w.length === 3 && !STOP3.has(w) && !GENERIC.has(w)) parts.add(w);
  }
  return { words, parts, paths };
}

// What a ledger line holds that a search reads.
export interface LedgerText {
  did: string;
  areas: string[];
  at: number;
  workspace?: string;
  branch?: string;
}

function scoreOf(q: Query, line: LedgerText): number {
  let score = 0;
  for (const w of terms(line.did)) if (q.words.has(w)) score += 1;
  // A folder the question names outright is worth more than a word of it.
  const seen = new Set<string>();
  for (const raw of line.areas) {
    const area = raw.toLowerCase().replace(/\/+$/, "");
    if (q.paths.some(function (p) { return p === area || p.startsWith(`${area}/`) || area.startsWith(`${p}/`); })) {
      score += 3;
      continue;
    }
    for (const part of pathParts(area)) {
      if (seen.has(part) || !q.parts.has(part)) continue;
      seen.add(part);
      score += 2;
    }
  }
  for (const w of terms(`${line.workspace ?? ""} ${line.branch ?? ""}`)) if (q.words.has(w) && !seen.has(w)) score += 1;
  return score;
}

function recency(at: number, now: number): number {
  return RECENT_BONUS * Math.max(0, 1 - Math.max(0, now - at) / RECENT_MS);
}

// The lines that match the query at all, best first; between equal matches, the newer first.
export function search<T extends LedgerText>(query: string, lines: T[], now: number = Date.now()): { line: T; score: number }[] {
  const q = readQuery(query);
  const out: { line: T; score: number }[] = [];
  for (const line of lines) {
    const base = scoreOf(q, line);
    if (base > 0) out.push({ line, score: base + recency(line.at, now) });
  }
  out.sort(function (a, b) { return b.score - a.score || b.line.at - a.line.at; });
  return out;
}

// How well a text (an agent's routing summary and name) fits a task: the words they share.
export function fitScore(task: string, text: string): number {
  const want = terms(task);
  let n = 0;
  for (const w of terms(text)) if (want.has(w)) n += 1;
  return n;
}
