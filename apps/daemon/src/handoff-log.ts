// ABOUTME: The hand-off log on this Mac (~/.soopdoop/logs/handoffs.log: who, which agent, when, size, cost; never the text),
// ABOUTME: the daily hand-off allowance it counts against, and `soopdoop handoffs`, which shows and sets that allowance.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { readSettings, settingsPath, soopdoopHome, writeSettings } from "./config";
import { isRecord } from "./state";

export const DAY_MS = 24 * 60 * 60 * 1000;

// What happened to a hand-off on this Mac: it reached its agent, it was reported back (by the agent's report_back tool or,
// when the agent stopped without it, by a copy of the session), it failed here, or the session that offered it was told how
// it ended.
export type HandoffEvent = "delivered" | "reported" | "failed" | "told";

export interface HandoffLine {
  // Milliseconds; written as an ISO time.
  at: number;
  event: HandoffEvent;
  handoffId: string;
  fromHandle?: string;
  agentId?: string;
  harness?: string;
  // How it reached the agent (deliver.ts).
  channel?: string;
  // The size of what was sent or reported, in characters.
  chars?: number;
  // Claude Code held it for the owner's approval in the session.
  held?: boolean;
  // What the hand-off cost on this Mac, in US dollars at API prices. The allowance adds these up.
  usd?: number;
  by?: "agent" | "fork";
  // Why it failed here, in soopdoop's own words.
  note?: string;
}

export function handoffsLogPath(home: string = soopdoopHome()): string {
  return path.join(home, "logs", "handoffs.log");
}

function str(x: unknown): string | undefined {
  return typeof x === "string" && x !== "" ? x : undefined;
}

function isEvent(x: unknown): x is HandoffEvent {
  return x === "delivered" || x === "reported" || x === "failed" || x === "told";
}

// One line per entry; a line that is not one of ours is skipped.
export function parseHandoffLog(text: string): HandoffLine[] {
  const out: HandoffLine[] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    let row: unknown;
    try {
      row = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isRecord(row) || !isEvent(row.event) || typeof row.handoffId !== "string" || typeof row.at !== "string") continue;
    const at = Date.parse(row.at);
    if (Number.isNaN(at)) continue;
    const line: HandoffLine = { at, event: row.event, handoffId: row.handoffId };
    const fromHandle = str(row.fromHandle);
    if (fromHandle !== undefined) line.fromHandle = fromHandle;
    const agentId = str(row.agentId);
    if (agentId !== undefined) line.agentId = agentId;
    const harness = str(row.harness);
    if (harness !== undefined) line.harness = harness;
    const channel = str(row.channel);
    if (channel !== undefined) line.channel = channel;
    if (typeof row.chars === "number") line.chars = row.chars;
    if (row.held === true) line.held = true;
    if (typeof row.usd === "number" && Number.isFinite(row.usd) && row.usd >= 0) line.usd = row.usd;
    if (row.by === "agent" || row.by === "fork") line.by = row.by;
    const note = str(row.note);
    if (note !== undefined) line.note = note;
    out.push(line);
  }
  return out;
}

export async function readHandoffLog(home: string = soopdoopHome()): Promise<HandoffLine[]> {
  const text = await readFile(handoffsLogPath(home), "utf8").catch(function () { return ""; });
  return parseHandoffLog(text);
}

export async function appendHandoffLog(line: HandoffLine, home: string = soopdoopHome()): Promise<void> {
  const file = handoffsLogPath(home);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify({ ...line, at: new Date(line.at).toISOString() }) + "\n");
}

// Whether this Mac already reported the hand-off back or failed it.
export function isSettled(lines: HandoffLine[], handoffId: string): boolean {
  return lines.some(function (l) { return l.handoffId === handoffId && (l.event === "reported" || l.event === "failed"); });
}

// What hand-offs cost this Mac in the last 24 hours, from the report-back lines.
export function spentOnHandoffs(lines: HandoffLine[], now: number): number {
  let total = 0;
  for (const l of lines) if (l.usd !== undefined && now - l.at < DAY_MS) total += l.usd;
  return total;
}

function dollars(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

// Why the allowance stops one more hand-off, or null when it may start. A hand-off starts only while less than the allowance
// was spent in the last 24 hours; one that is running is never stopped, so the last one of a day can take it over.
export function allowanceLimit(dailyUsd: number, spent: number): string | null {
  if (dailyUsd <= 0) return "This Mac's hand-off allowance is $0, so its agents run no hand-offs. Its owner can raise it with: soopdoop handoffs <dollars>.";
  if (spent >= dailyUsd) {
    return `This Mac's hand-off allowance (${dollars(dailyUsd)} a day) is spent: ${dollars(spent)} in the last 24 hours. Its owner can raise it with: soopdoop handoffs <dollars>.`;
  }
  return null;
}

// `soopdoop handoffs` shows the allowance and what hand-offs cost in the last 24 hours; `soopdoop handoffs <dollars>` sets it.
export async function handoffsCommand(args: string[], home: string = soopdoopHome(), print: (line: string) => void = console.log): Promise<void> {
  const [value] = args;
  const file = settingsPath(home);
  if (value !== undefined) {
    const usd = Number(value);
    if (value.trim() === "" || !Number.isFinite(usd) || usd < 0) throw new Error("usage: soopdoop handoffs <dollars a day, 0 or more>");
    await writeSettings({ handoffDailyUsd: usd }, file);
  }
  const { handoffDailyUsd } = await readSettings(file);
  const lines = await readHandoffLog(home);
  const now = Date.now();
  const ran = lines.filter(function (l) { return l.event === "delivered" && now - l.at < DAY_MS; }).length;
  print(handoffDailyUsd === 0
    ? "Hand-off allowance: $0, so this Mac's agents run no crewmates' hand-offs."
    : `Hand-off allowance: ${dollars(handoffDailyUsd)} in any 24 hours for crewmates' hand-offs run by this Mac's agents, at API prices.`);
  print(`Spent in the last 24 hours: ${dollars(spentOnHandoffs(lines, now))} (${ran} hand-off${ran === 1 ? "" : "s"} run).`);
  if (value === undefined) print("Change it with: soopdoop handoffs <dollars a day>");
}
