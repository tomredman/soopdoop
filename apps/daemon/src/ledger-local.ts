// ABOUTME: Ledger lines made on this Mac: one line per finished piece of work (a session that ended, or one idle ten minutes after
// ABOUTME: a turn), built from its transcript, in Haiku's words on the owner's own Claude account when allowed, sent once per change.
import { appendFile, mkdir, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { forkEnv, spawnFork, type Run } from "./ask";
import { soopdoopHome } from "./config";
import { answerCost } from "./fund";
import { redactSecrets } from "./redact";
import { isRecord, type AgentRecord } from "./state";
import { grokTitle } from "./transcripts/grok";
import { findTranscript, harnessHomes, parseFor, readTranscript, type Homes, type Parsed } from "./transcripts/index";

// A session idle this long after its last turn has finished a piece of work.
export const IDLE_MS = 10 * 60 * 1000;
// The backend keeps at most 240 characters; Haiku is asked for fewer.
export const MAX_DID = 240;
export const LEDGER_MODEL = "claude-haiku-5-5";
// How much of a transcript is read for its line: the tail, and the head for the first prompt of a long one.
const WORK_BYTES = 4_000_000;
const HEAD_BYTES = 256_000;
const HAIKU_TIMEOUT_MS = 60_000;
// Lines are kept in ledger.json for as long as the longest plan keeps them.
const KEPT_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_AREAS = 6;
const MAX_AREA_DEPTH = 3;
// Folders that hold code rather than name a part of the project, dropped from the end of an area.
const INNER = new Set(["src", "lib", "libs", "source", "sources", "components", "test", "tests", "__tests__", "spec", "specs", "utils", "internal"]);

// One ledger line, as ledger:report takes it (with the machine's token added).
export interface LedgerLine {
  sessionKey: string;
  harness: string;
  workspace?: string;
  branch?: string;
  did: string;
  areas: string[];
  files: number;
  pr?: string;
  shipped?: boolean;
  at: number;
}

// Where a line's words came from: Haiku, Codex's own memory of the session, Grok's title for it, or the prompts themselves.
export type LineSource = "haiku" | "codex-memory" | "grok-title" | "prompts";

// What ledger.json keeps for one session: what was sent and when, and the transcript's fingerprint at the time.
export interface SentLine extends LedgerLine {
  sentAt: number;
  fingerprint: string;
  source: LineSource;
  usd?: number;
}

export interface LedgerFile {
  lines: Record<string, SentLine>;
}

export function ledgerPath(home: string = soopdoopHome()): string {
  return path.join(home, "ledger.json");
}

export function ledgerLogPath(home: string = soopdoopHome()): string {
  return path.join(home, "logs", "ledger.log");
}

function cut(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// A file's path inside the session's folder, or null for a file elsewhere (a config file in the home folder, a scratch file).
export function insideFolder(file: string, cwd: string | undefined): string | null {
  if (!path.isAbsolute(file)) {
    const rel = path.normalize(file);
    return rel === "." || rel.startsWith("..") ? null : rel;
  }
  if (cwd === undefined || !file.startsWith(cwd + "/")) return null;
  return file.slice(cwd.length + 1);
}

// The part of the project a file belongs to: its folder, at most three deep, without code-holding folders at the end.
// "apps/web/quote/Form.tsx" is apps/web/quote, "packages/email/src/send.ts" is packages/email. Null for a file at the top.
export function areaOf(relative: string): string | null {
  let parts = relative.split("/").slice(0, -1).filter(function (p) { return p !== "" && p !== "."; }).slice(0, MAX_AREA_DEPTH);
  while (parts.length > 1 && INNER.has((parts[parts.length - 1] ?? "").toLowerCase())) parts = parts.slice(0, -1);
  return parts.length === 0 ? null : parts.join("/");
}

// The areas and how many files the session's work touched, from the files it changed (or, when it changed none, the files it
// read), inside its folder only. Areas with the most files come first. `shown` is the last files, for Haiku.
export function workOf(parsed: Parsed, cwd: string | undefined): { areas: string[]; files: number; shown: string[] } {
  const source = parsed.edited !== undefined && parsed.edited.length > 0 ? parsed.edited : parsed.files;
  const seen = new Set<string>();
  const counts = new Map<string, number>();
  for (const file of source) {
    const rel = insideFolder(file, cwd);
    if (rel === null || seen.has(rel)) continue;
    seen.add(rel);
    const area = areaOf(rel);
    if (area !== null) counts.set(area, (counts.get(area) ?? 0) + 1);
  }
  const areas = [...counts].sort(function (a, b) { return b[1] - a[1]; }).slice(0, MAX_AREAS).map(function ([a]) { return a; });
  return { areas, files: seen.size, shown: [...seen].slice(-15) };
}

// Changes when the session did more: more turns, another prompt, more files, a PR, a merge.
export function fingerprint(parsed: Parsed): string {
  const last = parsed.turns[parsed.turns.length - 1]?.text.slice(0, 200) ?? "";
  return String(Bun.hash(JSON.stringify([
    parsed.turns.length, last, parsed.firstPrompt ?? "", parsed.lastPrompt ?? "", parsed.files.length, parsed.edited?.length ?? 0,
    parsed.prLinks, parsed.merged,
  ])));
}

// "What was done" for free: the hacker's first prompt, and the last one when it differs, in their own words.
export function freeLine(parsed: Parsed): string | null {
  const first = oneLine(parsed.firstPrompt ?? "");
  if (first === "") return null;
  const last = oneLine(parsed.lastPrompt ?? "");
  const text = last === "" || last === first ? `"${cut(first, 200)}"` : `"${cut(first, 150)}" → "${cut(last, 70)}"`;
  return cut(redactSecrets(text), MAX_DID);
}

const SYSTEM = "You write one-line entries for a software team's work log. Each entry says what was done in one coding session.";

// What Haiku is given: the first and last prompts, the agent's last reply, the files and the PR link. Secrets are taken out first.
export function haikuPrompt(parsed: Parsed, shown: string[]): string {
  const lastReply = [...parsed.turns].reverse().find(function (t) { return t.role === "assistant" && !t.text.startsWith("["); })?.text;
  const parts = [
    "Write the work log entry for this coding session: one plain sentence under 160 characters that says what was done, " +
      "starting with a verb in the past tense (\"Fixed …\", \"Added …\", \"Looked into …\"). Name the feature or the part of " +
      "the project, not the files. No secrets, keys or tokens. No names of people. No quotes, no markdown. Reply with the sentence only.",
    "",
    `<first_request>${cut(oneLine(parsed.firstPrompt ?? ""), 1_500)}</first_request>`,
  ];
  if (parsed.lastPrompt !== undefined && parsed.lastPrompt !== parsed.firstPrompt) parts.push(`<last_request>${cut(oneLine(parsed.lastPrompt), 800)}</last_request>`);
  if (lastReply !== undefined) parts.push(`<agent_last_reply>${cut(lastReply, 800)}</agent_last_reply>`);
  if (shown.length > 0) parts.push(`<files>${shown.join(", ")}</files>`);
  const pr = parsed.prLinks[0];
  if (pr !== undefined) parts.push(`<pull_request>${pr}${parsed.merged ? " (merged)" : ""}</pull_request>`);
  return redactSecrets(parts.join("\n"));
}

// The Haiku call on the owner's own Claude account. Safe mode skips hooks, MCP servers and CLAUDE.md (so the call never shows
// up as an agent), no tools, nothing saved. Not --bare: bare mode reads only an API key, never a Claude sign-in.
export function haikuArgs(prompt: string): string[] {
  return [
    "-p", "--safe-mode", "--no-session-persistence", "--tools", "", "--model", LEDGER_MODEL, "--effort", "low",
    "--system-prompt", SYSTEM, "--output-format", "json", prompt,
  ];
}

// Haiku's sentence, cleaned: its first line, without list marks, quotes or a refusal. Null when nothing usable came back.
export function cleanSentence(raw: string): string | null {
  const first = raw.split("\n").map(function (l) { return l.trim(); }).find(function (l) { return l !== ""; }) ?? "";
  const s = oneLine(first.replace(/^[-*•]\s+/, "").replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, ""));
  if (s === "" || /^(?:i can(?:no|')t|i'm sorry|sorry|i am unable|as an ai)\b/i.test(s)) return null;
  return cut(redactSecrets(s), MAX_DID);
}

export interface Haiku {
  did: string | null;
  usd?: number;
}

// Asks Haiku for the line. A failure gives no line (the prompts' line is used instead), with what it cost if anything.
export async function askHaiku(prompt: string, claude: string, run: Run = spawnFork, cwd: string = soopdoopHome()): Promise<Haiku> {
  const result = await run([claude, ...haikuArgs(prompt)], { cwd, env: forkEnv(process.env), timeoutMs: HAIKU_TIMEOUT_MS }).catch(function () { return null; });
  if (result === null || result.timedOut) return { did: null };
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout);
  } catch {
    return { did: null };
  }
  if (!isRecord(raw)) return { did: null };
  const usd = isRecord(raw.usage) ? answerCost(raw.usage, LEDGER_MODEL) : undefined;
  if (raw.is_error === true || raw.subtype !== "success" || typeof raw.result !== "string") return { did: null, ...(usd === undefined ? {} : { usd }) };
  return { did: cleanSentence(raw.result), ...(usd === undefined ? {} : { usd }) };
}

// Codex's own note on the session (<CODEX_HOME>/memories/rollout_summaries/*.md, "thread_id: <id>" on its first line), its
// heading. Codex writes these some time after a session, so there is often none yet.
export async function codexMemory(codexHome: string, sessionId: string): Promise<string | undefined> {
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return undefined;
  const dir = path.join(codexHome, "memories", "rollout_summaries");
  const names = (await readdir(dir).catch(function (): string[] { return []; })).filter(function (n) { return n.endsWith(".md"); });
  // Named by time: the newest first.
  names.sort().reverse();
  const want = `thread_id: ${sessionId}`;
  for (const name of names.slice(0, 2_000)) {
    const file = Bun.file(path.join(dir, name));
    const head = await file.slice(0, 256).text().catch(function () { return ""; });
    if (head.split("\n")[0]?.trim() !== want) continue;
    const text = await file.slice(0, 65_536).text().catch(function () { return ""; });
    const heading = text.split("\n").find(function (l) { return l.startsWith("# "); });
    const title = heading === undefined ? "" : oneLine(heading.slice(2));
    return title === "" ? undefined : title;
  }
  return undefined;
}

// The transcript's work: its last 4 MB, and for a longer one the first prompt from its head.
export async function readWork(harness: string, file: string): Promise<Parsed> {
  const parsed = await readTranscript(harness, file, WORK_BYTES);
  const f = Bun.file(file);
  if (f.size > WORK_BYTES) {
    const head = parseFor(harness, await f.slice(0, HEAD_BYTES).text());
    if (head.firstPrompt !== undefined) parsed.firstPrompt = head.firstPrompt;
  }
  return parsed;
}

export async function readLedgerFile(file: string = ledgerPath()): Promise<LedgerFile> {
  try {
    const raw: unknown = await Bun.file(file).json();
    if (isRecord(raw) && isRecord(raw.lines)) {
      const lines: Record<string, SentLine> = {};
      for (const [key, value] of Object.entries(raw.lines)) {
        if (isRecord(value) && typeof value.fingerprint === "string" && typeof value.sentAt === "number" && typeof value.did === "string") {
          lines[key] = {
            sessionKey: key,
            harness: typeof value.harness === "string" ? value.harness : "claude-code",
            did: value.did,
            areas: Array.isArray(value.areas) ? value.areas.filter(function (a): a is string { return typeof a === "string"; }) : [],
            files: typeof value.files === "number" ? value.files : 0,
            at: typeof value.at === "number" ? value.at : value.sentAt,
            sentAt: value.sentAt,
            fingerprint: value.fingerprint,
            source: value.source === "haiku" || value.source === "codex-memory" || value.source === "grok-title" ? value.source : "prompts",
            ...(typeof value.workspace === "string" ? { workspace: value.workspace } : {}),
            ...(typeof value.branch === "string" ? { branch: value.branch } : {}),
            ...(typeof value.pr === "string" ? { pr: value.pr } : {}),
            ...(value.shipped === true ? { shipped: true } : {}),
            ...(typeof value.usd === "number" ? { usd: value.usd } : {}),
          };
        }
      }
      return { lines };
    }
  } catch {
    // Missing or unreadable: nothing was sent from here yet.
  }
  return { lines: {} };
}

// Written to a temporary file and renamed, so a reader never sees half a file. Lines past the longest plan's 90 days go.
export async function writeLedgerFile(data: LedgerFile, now: number, file: string = ledgerPath()): Promise<void> {
  const kept: Record<string, SentLine> = {};
  for (const [key, line] of Object.entries(data.lines)) if (now - line.sentAt < KEPT_MS) kept[key] = line;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ lines: kept }, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, file);
}

export interface LedgerDeps {
  // ledger:report with this Mac's token. Throws when it did not go through.
  send(line: LedgerLine): Promise<void>;
  // Whether lines can be sent at all (the Mac is paired). Nothing is built, and no Haiku is paid for, until then.
  ready(): boolean;
  // Whether the agent is private now (its folder or repository is in privateDirs).
  isPrivate(agent: AgentRecord): boolean;
  // The ledgerLines setting, read each time so `soopdoop ledger-lines off` needs no restart.
  haikuAllowed(): Promise<boolean>;
  // The real claude command, or null.
  claude(): string | null;
  run?: Run;
  homes?: Homes;
  file?: string;
  log?: string;
  clock?: () => number;
  idleMs?: number;
}

export interface Ledger {
  // A session ended (or was swept as stale): its line, if its work changed since the last one sent.
  ended(agent: AgentRecord): Promise<void>;
  // The heartbeat: sessions idle ten minutes since their last turn get their line once per idle spell; lines that failed to
  // send go again.
  tick(agents: Iterable<AgentRecord>): Promise<void>;
}

interface Unsent {
  line: LedgerLine;
  fingerprint: string;
  source: LineSource;
  usd?: number;
  agent: AgentRecord;
  tries: number;
}

const MAX_TRIES = 10;

export function ledgerKeeper(deps: LedgerDeps): Ledger {
  const clock = deps.clock ?? Date.now;
  const idleMs = deps.idleMs ?? IDLE_MS;
  const file = deps.file ?? ledgerPath();
  const log = deps.log ?? ledgerLogPath();
  const homes = deps.homes ?? harnessHomes();
  // The last turn each session was looked at for, so an idle session is looked at once per idle spell.
  const considered = new Map<string, number>();
  const busy = new Set<string>();
  const unsent = new Map<string, Unsent>();
  let writing: Promise<void> = Promise.resolve();
  let ticking = false;

  function logLine(entry: Record<string, unknown>): Promise<void> {
    return mkdir(path.dirname(log), { recursive: true })
      .then(function () { return appendFile(log, JSON.stringify({ at: new Date(clock()).toISOString(), ...entry }) + "\n"); })
      .catch(function () { /* the log is a convenience */ });
  }

  // One write at a time, so two sessions finishing together both land in the file.
  function record(entry: SentLine): Promise<void> {
    writing = writing.then(async function () {
      const data = await readLedgerFile(file);
      data.lines[entry.sessionKey] = entry;
      await writeLedgerFile(data, clock(), file);
    }).catch(function () { /* a failed write only means the line may be sent once more */ });
    return writing;
  }

  async function describe(agent: AgentRecord, parsed: Parsed, transcript: string, shown: string[]): Promise<{ did: string; source: LineSource; usd?: number } | null> {
    if (agent.harness === "codex") {
      const memory = await codexMemory(homes.codex, agent.agentId);
      if (memory !== undefined) return { did: cut(redactSecrets(memory), MAX_DID), source: "codex-memory" };
    }
    if (agent.harness === "grok") {
      const title = grokTitle(await Bun.file(path.join(path.dirname(transcript), "summary.json")).json().catch(function () { return null; }));
      if (title !== undefined) return { did: cut(redactSecrets(title), MAX_DID), source: "grok-title" };
    }
    let usd: number | undefined;
    const claude = deps.claude();
    if (claude !== null && (await deps.haikuAllowed())) {
      const asked = await askHaiku(haikuPrompt(parsed, shown), claude, deps.run ?? spawnFork);
      usd = asked.usd;
      if (asked.did !== null) return { did: asked.did, source: "haiku", ...(usd === undefined ? {} : { usd }) };
    }
    const free = freeLine(parsed);
    return free === null ? null : { did: free, source: "prompts", ...(usd === undefined ? {} : { usd }) };
  }

  async function deliver(item: Unsent): Promise<boolean> {
    if (item.agent.open === false || deps.isPrivate(item.agent)) {
      unsent.delete(item.line.sessionKey);
      return false;
    }
    try {
      await deps.send(item.line);
    } catch (e) {
      item.tries += 1;
      if (item.tries >= MAX_TRIES) unsent.delete(item.line.sessionKey);
      else unsent.set(item.line.sessionKey, item);
      void logLine({ sessionKey: item.line.sessionKey, harness: item.line.harness, sent: false, error: e instanceof Error ? e.message.slice(0, 200) : "send failed" });
      return false;
    }
    unsent.delete(item.line.sessionKey);
    const sentAt = clock();
    await record({ ...item.line, sentAt, fingerprint: item.fingerprint, source: item.source, ...(item.usd === undefined ? {} : { usd: item.usd }) });
    // Sizes and cost only, never the line's words.
    void logLine({
      sessionKey: item.line.sessionKey, harness: item.line.harness, source: item.source, sent: true, chars: item.line.did.length,
      areas: item.line.areas.length, files: item.line.files, ...(item.usd === undefined ? {} : { usd: item.usd, model: LEDGER_MODEL }),
    });
    return true;
  }

  async function consider(agent: AgentRecord): Promise<void> {
    if (!deps.ready()) return;
    considered.set(agent.agentId, agent.lastTurnAt);
    if (agent.open === false || deps.isPrivate(agent) || busy.has(agent.agentId)) return;
    busy.add(agent.agentId);
    try {
      const transcript = await findTranscript(agent.harness, agent.agentId, agent.cwd, agent.transcriptPath, homes);
      if (transcript === null) return;
      const parsed = await readWork(agent.harness, transcript);
      const print = fingerprint(parsed);
      const before = (await readLedgerFile(file)).lines[agent.agentId];
      if (before?.fingerprint === print || unsent.get(agent.agentId)?.fingerprint === print) return;
      const cwd = parsed.cwd ?? agent.cwd;
      const work = workOf(parsed, cwd);
      // A session that touched no file and opened no PR did no work worth a line ("say hi").
      if (work.files === 0 && parsed.prLinks.length === 0) return;
      const words = await describe(agent, parsed, transcript, work.shown);
      if (words === null) return;
      const folder = agent.repo ?? cwd;
      const pr = parsed.prLinks[0];
      const line: LedgerLine = {
        sessionKey: agent.agentId,
        harness: agent.harness,
        ...(folder === undefined ? {} : { workspace: path.basename(folder) }),
        ...(parsed.branch === undefined ? {} : { branch: parsed.branch }),
        did: words.did,
        areas: work.areas,
        files: work.files,
        ...(pr === undefined ? {} : { pr }),
        ...(parsed.merged ? { shipped: true } : {}),
        at: agent.lastTurnAt,
      };
      await deliver({ line, fingerprint: print, source: words.source, ...(words.usd === undefined ? {} : { usd: words.usd }), agent, tries: 0 });
    } catch (e) {
      void logLine({ sessionKey: agent.agentId, harness: agent.harness, sent: false, error: e instanceof Error ? e.message.slice(0, 200) : "failed" });
    } finally {
      busy.delete(agent.agentId);
    }
  }

  return {
    async ended(agent) {
      await consider(agent);
    },
    async tick(agents) {
      if (ticking) return;
      ticking = true;
      try {
        const now = clock();
        const here = new Set<string>();
        for (const agent of agents) {
          here.add(agent.agentId);
          if (agent.status !== "idle" || now - agent.lastTurnAt < idleMs || considered.get(agent.agentId) === agent.lastTurnAt) continue;
          await consider(agent);
        }
        for (const id of [...considered.keys()]) if (!here.has(id)) considered.delete(id);
        for (const item of [...unsent.values()]) await deliver(item);
      } finally {
        ticking = false;
      }
    },
  };
}
