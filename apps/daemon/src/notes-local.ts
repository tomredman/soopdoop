// ABOUTME: Crew notes on this Mac: the crew's live notes told to each session when it starts (those that apply where it runs, 2 KB at
// ABOUTME: most), a line at its next prompt when one changes, and ~/.soopdoop/crew.md for Codex and Grok, with the pointers to it.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { soopdoopHome } from "./config";
import { dayOf } from "./headsups-local";
import { agentLine, type CrewNow } from "./intro";
import { isRecord } from "./state";

export interface CrewNote {
  id: string;
  authorHandle: string;
  text: string;
  tags: string[];
  appliesWhen?: string;
  createdAt: number;
  updatedAt: number;
}

export interface NotesNow {
  now: number;
  notes: CrewNote[];
}

// crews:forDaemon: the crew's name and plan, its leader, and the crewmates (friends when there is no crew).
export interface CrewInfo {
  crewName?: string;
  plan: string;
  leaderHandle?: string;
  members: { handle: string; name?: string }[];
}

// Where a session runs, for a note's "applies when".
export interface Place {
  cwd?: string;
  repo?: string;
  branch?: string;
}

export const MAX_NOTES_BYTES = 2_048;

export function parseNotes(raw: unknown): NotesNow | null {
  if (!isRecord(raw) || typeof raw.now !== "number" || !Array.isArray(raw.notes)) return null;
  const notes: CrewNote[] = [];
  for (const n of raw.notes) {
    if (!isRecord(n) || typeof n.id !== "string" || typeof n.text !== "string" || typeof n.updatedAt !== "number") continue;
    const note: CrewNote = {
      id: n.id,
      authorHandle: typeof n.authorHandle === "string" ? n.authorHandle : "",
      text: n.text,
      tags: Array.isArray(n.tags) ? n.tags.filter(function (t): t is string { return typeof t === "string"; }) : [],
      createdAt: typeof n.createdAt === "number" ? n.createdAt : n.updatedAt,
      updatedAt: n.updatedAt,
    };
    if (typeof n.appliesWhen === "string" && n.appliesWhen.trim() !== "") note.appliesWhen = n.appliesWhen.trim();
    notes.push(note);
  }
  notes.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
  return { now: raw.now, notes };
}

export function parseCrewInfo(raw: unknown): CrewInfo | null {
  if (!isRecord(raw) || !Array.isArray(raw.members)) return null;
  const info: CrewInfo = { plan: typeof raw.plan === "string" ? raw.plan : "free", members: [] };
  if (typeof raw.crewName === "string") info.crewName = raw.crewName;
  if (typeof raw.leaderHandle === "string") info.leaderHandle = raw.leaderHandle;
  for (const m of raw.members) {
    if (!isRecord(m) || typeof m.handle !== "string") continue;
    info.members.push(typeof m.name === "string" ? { handle: m.handle, name: m.name } : { handle: m.handle });
  }
  return info;
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(function (w) { return w !== ""; }));
}

// Whether a note applies to a session. No "applies when": everywhere. Otherwise it is a list split by commas, and one entry
// that fits is enough: a folder (with a slash) inside the session's folder path, or words that are all in the session's
// folder, repository name or branch ("quote" fits the branch feat/quote-redesign).
export function applies(note: CrewNote, place: Place): boolean {
  if (note.appliesWhen === undefined) return true;
  const repoName = place.repo === undefined ? "" : path.basename(place.repo);
  const haystack = [place.cwd ?? "", repoName, place.branch ?? ""].join(" ").toLowerCase();
  const have = words(haystack);
  for (const raw of note.appliesWhen.split(",")) {
    const entry = raw.trim().toLowerCase();
    if (entry === "") continue;
    if (entry.includes("/")) {
      const folder = entry.replace(/^\/+|\/+$/g, "");
      if (`/${(place.cwd ?? "").toLowerCase()}/`.includes(`/${folder}/`)) return true;
      continue;
    }
    const want = [...words(entry)];
    if (want.length > 0 && want.every(function (w) { return have.has(w); })) return true;
  }
  return false;
}

// "- @adalovelace (16 Oct): the quote page uses the M10 components."
export function noteLine(note: CrewNote): string {
  return `- @${note.authorHandle} (${dayOf(note.updatedAt)}): ${note.text.replace(/\s+/g, " ").trim()}`;
}

const NOTES_HEADER =
  "soopdoop: your crew's notes, newest first. A crew note outranks what you remember about the same thing, and a note with a date is the current one.";

// The notes a session starts with: those that apply where it runs, newest first, 2 KB at most. Null when none apply.
export function notesBlock(notes: CrewNote[], place: Place, maxBytes: number = MAX_NOTES_BYTES): { text: string | null; told: CrewNote[] } {
  const fitting = notes.filter(function (n) { return applies(n, place); });
  if (fitting.length === 0) return { text: null, told: [] };
  const lines = [NOTES_HEADER];
  const told: CrewNote[] = [];
  let bytes = Buffer.byteLength(NOTES_HEADER);
  for (const n of fitting) {
    const line = noteLine(n);
    const more = fitting.length - told.length - 1;
    // Room for this line and, when others are left out, the line that says so.
    const tail = more > 0 ? Buffer.byteLength(`\n- and ${more} more: crew_notes lists them all.`) : 0;
    if (bytes + 1 + Buffer.byteLength(line) + tail > maxBytes) break;
    lines.push(line);
    told.push(n);
    bytes += 1 + Buffer.byteLength(line);
  }
  const left = fitting.length - told.length;
  if (left > 0) lines.push(`- and ${left} more: crew_notes lists them all.`);
  return { text: lines.join("\n"), told };
}

// What a session hears at its next prompt about notes that changed, or were retired, since it was told.
export function changesNote(changed: CrewNote[], retired: CrewNote[]): string | null {
  const out: string[] = [];
  if (changed.length === 1 && changed[0] !== undefined) {
    out.push(`soopdoop: a crew note changed. ${noteLine(changed[0]).slice(2)}`);
  } else if (changed.length > 1) {
    out.push(`soopdoop: ${changed.length} crew notes changed.`, ...changed.slice(0, 5).map(noteLine));
  }
  for (const r of retired.slice(0, 3)) out.push(`soopdoop: a crew note was retired and no longer stands: ${noteLine(r).slice(2)}`);
  return out.length === 0 ? null : out.join("\n");
}

export interface NotesKeeper {
  // SessionStart (and the first prompt of a session it did not see start): the notes that apply. A later prompt: changes.
  contextFor(event: string, sessionId: string, place: Place): Promise<string | null>;
  // A new copy of notes:forDaemon (the daemon follows it live) and of crews:forDaemon.
  set(raw: unknown): void;
  setCrew(raw: unknown): void;
  notes(): NotesNow | null;
  crewInfo(): CrewInfo | null;
  keepOnly(sessionIds: Set<string>): void;
}

export interface NotesOptions {
  // notes:forDaemon, read once when a session starts before the live copy arrived.
  readNotes?: () => Promise<unknown>;
  waitMs?: number;
  // Called when the copy of the notes or of the crew changes, to write crew.md.
  changed?: () => void;
}

interface Told {
  // The newest note version this session was told about.
  upTo: number;
  // The notes it was told, by id, so a retired one can be named.
  notes: Map<string, CrewNote>;
}

export function notesKeeper(options: NotesOptions = {}): NotesKeeper {
  const waitMs = options.waitMs ?? 1_500;
  let copy: NotesNow | null = null;
  let crew: CrewInfo | null = null;
  const told = new Map<string, Told>();

  async function current(): Promise<NotesNow | null> {
    if (copy !== null || options.readNotes === undefined) return copy;
    const read = options.readNotes().then(function (raw) {
      const parsed = parseNotes(raw);
      if (parsed !== null && copy === null) copy = parsed;
      return parsed;
    }).catch(function () { return null; });
    const got = await Promise.race([read, Bun.sleep(waitMs).then(function () { return null; })]);
    return got ?? copy;
  }

  async function introduce(sessionId: string, place: Place): Promise<string | null> {
    const now = await current();
    if (now === null) {
      told.delete(sessionId);
      return null;
    }
    const block = notesBlock(now.notes, place);
    const upTo = now.notes.reduce(function (m, n) { return applies(n, place) ? Math.max(m, n.updatedAt) : m; }, 0);
    told.set(sessionId, { upTo, notes: new Map(block.told.map(function (n) { return [n.id, n]; })) });
    return block.text;
  }

  return {
    async contextFor(event, sessionId, place) {
      if (event === "SessionStart") return await introduce(sessionId, place);
      if (event !== "UserPromptSubmit") return null;
      const was = told.get(sessionId);
      if (was === undefined) return await introduce(sessionId, place);
      if (copy === null) return null;
      const fitting = copy.notes.filter(function (n) { return applies(n, place); });
      const changed = fitting.filter(function (n) { return n.updatedAt > was.upTo; });
      const live = new Set(copy.notes.map(function (n) { return n.id; }));
      const retired = [...was.notes.values()].filter(function (n) { return !live.has(n.id); });
      for (const n of changed) was.notes.set(n.id, n);
      for (const n of retired) was.notes.delete(n.id);
      was.upTo = fitting.reduce(function (m, n) { return Math.max(m, n.updatedAt); }, was.upTo);
      return changesNote(changed, retired);
    },
    set(raw) {
      const parsed = parseNotes(raw);
      if (parsed === null) return;
      const before = JSON.stringify(copy?.notes ?? null);
      copy = parsed;
      if (JSON.stringify(parsed.notes) !== before) options.changed?.();
    },
    setCrew(raw) {
      const parsed = parseCrewInfo(raw);
      if (parsed === null) return;
      const before = JSON.stringify(crew);
      crew = parsed;
      if (JSON.stringify(parsed) !== before) options.changed?.();
    },
    notes() {
      return copy;
    },
    crewInfo() {
      return crew;
    },
    keepOnly(sessionIds) {
      for (const id of [...told.keys()]) if (!sessionIds.has(id)) told.delete(id);
    },
  };
}

// ~/.soopdoop/crew.md, or wherever SOOPDOOP_HOME is.
export function crewFilePath(home: string = soopdoopHome()): string {
  return path.join(home, "crew.md");
}

function tilde(p: string, home: string = homedir()): string {
  return p.startsWith(home + "/") ? `~${p.slice(home.length)}` : p;
}

// What crew.md holds: the crew, each crewmate and their running agents, the live notes, and how to ask. Codex and Grok
// sessions read it (their files point here); `GET /crew` on the daemon shows it.
export function crewMarkdown(info: CrewInfo | null, crew: CrewNow | null, notes: NotesNow | null): string {
  const out = ["# Your soopdoop crew", "", "soopdoop writes this file on this Mac and keeps it up to date. Do not edit it.", ""];
  if (info?.crewName !== undefined) {
    out.push(`Crew: ${info.crewName}${info.leaderHandle === undefined ? "" : ` (led by @${info.leaderHandle})`}.`, "");
  }
  out.push("## Crewmates and their agents running now", "");
  const agents = crew?.agents ?? [];
  const members = info?.members ?? [];
  const handles = [...new Set([...members.map(function (m) { return m.handle; }), ...agents.map(function (a) { return a.handle; })])];
  if (handles.length === 0) out.push("Nobody yet. Your user adds crewmates in the soopdoop app.");
  for (const handle of handles) {
    const name = members.find(function (m) { return m.handle === handle; })?.name ?? agents.find(function (a) { return a.handle === handle; })?.name;
    const theirs = agents.filter(function (a) { return a.handle === handle; });
    out.push(`- @${handle}${name === undefined ? "" : ` (${name})`}: ${theirs.length === 0 ? "no agent running now" : theirs.length === 1 ? "1 agent running now" : `${theirs.length} agents running now`}`);
    for (const a of theirs) out.push(`  ${agentLine(a)}`);
  }
  out.push("", "## Crew notes, newest first", "",
    "A crew note outranks what you remember about the same thing, and a note with a date is the current one.", "");
  const list = notes?.notes ?? [];
  if (list.length === 0) out.push("No live notes.");
  for (const n of list) out.push(`${noteLine(n)}${n.appliesWhen === undefined ? "" : ` (applies when: ${n.appliesWhen})`}`);
  out.push("", "## How to ask", "",
    "Before you build on or change a crewmate's work, ask their agent: call the soopdoop tool ask_operator with their @handle in the " +
      "question, like \"@jimmy: how are bounces counted?\". crew_status lists the crew, crew_notes the notes, and crew_note proposes a " +
      "new note when your user states a rule the crew should keep.", "");
  return out.join("\n");
}

let writes = 0;

// Writes crew.md when its text changed, through a temporary file of its own. Returns whether it wrote.
export async function writeCrewFile(text: string, file: string = crewFilePath()): Promise<boolean> {
  const before = await readFile(file, "utf8").catch(function () { return null; });
  if (before === text) return false;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  writes += 1;
  const tmp = `${file}.${process.pid}.${writes}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, file);
  return true;
}

// The managed block in Codex's AGENTS.md and Grok's rule file: only a pointer, so it never changes.
export const BLOCK_START = "<!-- soopdoop:start -->";
export const BLOCK_END = "<!-- soopdoop:end -->";

export function pointerBlock(crewFile: string = crewFilePath()): string {
  return `${BLOCK_START}\nRead ${tilde(crewFile)}: your crew's notes and agents\n${BLOCK_END}`;
}

// The text with our block in it: replaced between the markers when it is there, else added at the end (after a blank line
// when the text ends with a newline). Everything else stays exactly as it was.
export function withBlock(text: string, block: string): string {
  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END, start);
  if (start !== -1 && end !== -1) return text.slice(0, start) + block + text.slice(end + BLOCK_END.length);
  if (text === "") return `${block}\n`;
  return `${text}\n${block}\n`;
}

// The text without our block, and without the newlines withBlock added around it.
export function withoutBlock(text: string): string {
  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END, start);
  if (start === -1 || end === -1) return text;
  let from = start;
  let to = end + BLOCK_END.length;
  if (text[to] === "\n") to += 1;
  if (from > 0 && text[from - 1] === "\n") from -= 1;
  return text.slice(0, from) + text.slice(to);
}

// Codex's global instructions (<CODEX_HOME>/AGENTS.md) and Grok's home rule file (<GROK_HOME>/rules/soopdoop.md).
export function codexAgentsPath(codexHome: string): string {
  return path.join(codexHome, "AGENTS.md");
}

export function grokRulePath(grokHome: string): string {
  return path.join(grokHome, "rules", "soopdoop.md");
}

// Puts our block in a file, creating it if needed. Returns whether the file changed.
export async function installPointer(file: string, block: string = pointerBlock()): Promise<boolean> {
  const before = await readFile(file, "utf8").catch(function () { return null; });
  const after = withBlock(before ?? "", block);
  if (after === before) return false;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, after);
  return true;
}

// Takes our block out of a file. A file left empty that held only our block is removed (Grok's rule file is ours alone).
// Returns whether anything was ours.
export async function uninstallPointer(file: string, removeIfEmpty: boolean = false): Promise<boolean> {
  const before = await readFile(file, "utf8").catch(function () { return null; });
  if (before === null || !before.includes(BLOCK_START)) return false;
  const after = withoutBlock(before);
  if (removeIfEmpty && after.trim() === "") await rm(file, { force: true });
  else await writeFile(file, after);
  return true;
}
