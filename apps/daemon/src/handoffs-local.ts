// ABOUTME: Hand-offs on this Mac: runs each hand-off its owner accepted in the agent it is for (once, when that agent may take it,
// ABOUTME: within the allowance), reports back for an agent that stopped without doing so, and tells an offering session how its hand-off ended.
import type { FunctionReference } from "convex/server";
import { makeFunctionReference } from "convex/server";
import { forkAgent, type Asked } from "./ask";
import { readSettings, settingsPath, soopdoopHome } from "./config";
import { awayChannelsFor, defaultDeliverDeps, deliver, type DeliverDeps, type Delivery, type Target } from "./deliver";
import { fundLimit, fundPath, readFund, readSpends } from "./fund";
import { handoffCost } from "./handoff-cost";
import { allowanceLimit, appendHandoffLog, DAY_MS, isSettled, readHandoffLog, spentOnHandoffs, type HandoffLine } from "./handoff-log";
import { logRead } from "./operator";
import { isRecord, type AgentRecord, type AgentStatus, type HookEvent, type Subset } from "./state";
import { findTranscript, readTail } from "./transcripts/index";
import { prUrls } from "./transcripts/parsed";

export const toRunRef = makeFunctionReference<"query">("handoffs:toRun");
export const finishedRef = makeFunctionReference<"query">("handoffs:finishedForDaemon");
export const startedRef = makeFunctionReference<"mutation">("handoffs:started");
export const failedRef = makeFunctionReference<"mutation">("handoffs:failed");
export const reportBackRef = makeFunctionReference<"mutation">("handoffs:reportBack");

// A hand-off accepted for one of this Mac's agents (handoffs:toRun).
export interface ToRun {
  handoffId: string;
  targetAgentId: string;
  text: string;
  fromHandle: string;
  why?: string;
  targetHarness?: string;
  // True when the receiver's "run when my agent is idle" accepted it; false when the receiver approved it. Older backends
  // do not say.
  autoAccepted?: boolean;
}

export function parseToRun(raw: unknown): ToRun[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(function (r) {
    if (!isRecord(r) || typeof r.handoffId !== "string" || typeof r.targetAgentId !== "string" || typeof r.text !== "string") return [];
    const item: ToRun = { handoffId: r.handoffId, targetAgentId: r.targetAgentId, text: r.text, fromHandle: typeof r.fromHandle === "string" ? r.fromHandle : "" };
    if (typeof r.why === "string") item.why = r.why;
    if (typeof r.targetHarness === "string") item.targetHarness = r.targetHarness;
    if (typeof r.autoAccepted === "boolean") item.autoAccepted = r.autoAccepted;
    return [item];
  });
}

// A hand-off this Mac's agents offered that ended (handoffs:finishedForDaemon).
export interface Finished {
  handoffId: string;
  fromAgentId?: string;
  toHandle: string;
  status: "done" | "failed" | "declined" | "expired";
  summary?: string;
  links?: string[];
  note?: string;
  finishedAt: number;
}

export function parseFinished(raw: unknown): Finished[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(function (r) {
    if (!isRecord(r) || typeof r.handoffId !== "string" || typeof r.toHandle !== "string" || typeof r.finishedAt !== "number") return [];
    const status = r.status;
    if (status !== "done" && status !== "failed" && status !== "declined" && status !== "expired") return [];
    const f: Finished = { handoffId: r.handoffId, toHandle: r.toHandle, status, finishedAt: r.finishedAt };
    if (typeof r.fromAgentId === "string") f.fromAgentId = r.fromAgentId;
    if (typeof r.summary === "string") f.summary = r.summary;
    if (Array.isArray(r.links)) f.links = r.links.filter(function (l): l is string { return typeof l === "string"; });
    if (typeof r.note === "string") f.note = r.note;
    return [f];
  });
}

// The line the session that offered a hand-off reads at its next prompt.
export function finishedLine(f: Finished): string {
  const who = `@${f.toHandle}`;
  if (f.status === "done") {
    const links = (f.links ?? []).join(" ");
    return `soopdoop: your hand-off to ${who} is done: ${f.summary ?? "it was done."}${links === "" ? "" : ` ${links}`}`;
  }
  if (f.status === "declined") return `soopdoop: ${who} declined your hand-off${f.note === undefined ? "." : `: ${f.note}`}`;
  if (f.status === "expired") return `soopdoop: your hand-off to ${who} expired${f.note === undefined ? ": nobody ran it within a day." : `: ${f.note}`}`;
  return `soopdoop: your hand-off to ${who} was not done${f.note === undefined ? "." : `: ${f.note}`}`;
}

// What the agent is given. The text is the sender's, exactly as both people approved it.
export function handoffPrompt(fromHandle: string, text: string, handoffId: string): string {
  return `soopdoop hand-off from @${fromHandle} (they approved this text, you approved running it): ${text}\n\n` +
    `When you are done, call the report_back tool with handoff_id ${handoffId}, a short summary of what you did and any PR link. ` +
    "If you cannot do it, call report_back with what stopped you.";
}

// What a copy of the session is asked when the agent stopped without calling report_back.
export function reportPrompt(handoffId: string): string {
  return [
    `soopdoop needs a report on the hand-off you were given in this conversation (handoff_id ${handoffId}): the report_back tool was not called.`,
    "What did you do for it? Answer in at most two short sentences, in plain words, with the link to any pull request you opened. If you did not do it, say what stopped you.",
    "You have no tools for this reply, and it does not go back into your session. Never include secrets, keys, tokens or credentials.",
  ].join("\n");
}

// Whether a waiting hand-off may go to its agent now. Never while the agent waits on its owner (a permission prompt or a
// question): text typed into its terminal could answer the prompt. One accepted by the receiver's "run when my agent is
// idle" waits for idle, and so does one from a backend that does not say how it was accepted; one the receiver approved
// goes now, also into a working session (Claude Code reads it between tool calls; Codex after the running turn).
export function mayDeliver(item: ToRun, status: AgentStatus): boolean {
  if (status === "waiting") return false;
  return item.autoAccepted === false || status === "idle";
}

function roleOf(row: Record<string, unknown>): "user" | "assistant" | null {
  if (row.type === "user" || row.type === "assistant") return row.type;
  const p = isRecord(row.payload) ? row.payload : null;
  if (row.type === "response_item" && p !== null && p.type === "message" && (p.role === "user" || p.role === "assistant")) return p.role;
  return null;
}

// Whether the transcript (Claude Code's or Codex's) shows the hand-off reached the agent (a user message naming its id),
// and whether the agent replied after it.
export function handoffSeen(text: string, handoffId: string): { asked: boolean; answered: boolean } {
  let asked = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(row)) continue;
    const role = roleOf(row);
    if (!asked) {
      if (role === "user" && line.includes(handoffId)) asked = true;
      continue;
    }
    if (role === "assistant") return { asked: true, answered: true };
  }
  return { asked, answered: false };
}

// The live backend, as the daemon reaches it.
export interface Backend {
  watch(query: FunctionReference<"query">, args: Record<string, unknown>, onUpdate: (raw: unknown) => void): () => void;
  mutation(fn: FunctionReference<"mutation">, args: Record<string, unknown>): Promise<unknown>;
}

export interface LocalOptions {
  backend: Backend;
  token: string;
  subset: Subset;
  home?: string;
  deliverDeps?: () => DeliverDeps;
  // A copy of the session answering one prompt (ask.ts forkAgent).
  fork?: (agent: AgentRecord, prompt: string) => Promise<Asked>;
  now?: () => number;
  // How often hand-offs for agents not running here, and held ones, are looked at again. 0: only on events.
  tickMs?: number;
  say?: (line: string) => void;
}

export interface HandoffsLocal {
  // After every hook event: a waiting hand-off may run now, and an agent with a running one may have stopped or ended.
  // `before` is the agent as it was before the event (SessionEnd removes it).
  onHook(ev: HookEvent, before: AgentRecord | undefined): void;
  // What the session should hear at this event: how the hand-offs it offered ended, each once. Null when nothing.
  contextFor(ev: HookEvent): Promise<string | null>;
  // Resolves when the work already started has finished (for tests).
  settle(): Promise<void>;
  stop(): void;
}

// A hand-off that reached its agent here and was not reported back yet.
interface Running {
  handoffId: string;
  agentId: string;
  harness: string;
  fromHandle?: string;
  deliveredAt: number;
  held: boolean;
  reporting: boolean;
}

// An agent not running here is looked for again this often (claude agents, codex queue).
const AWAY_EVERY_MS = 2 * 60 * 1000;
// Claude Code drops a held message nobody approved after five minutes (its dialogExpiry).
const HELD_MS = 6 * 60 * 1000;
const MAX_SUMMARY = 1_000;
// A running hand-off is given up locally after this long; the backend fails it after 24 hours.
const RUNNING_FOR_MS = DAY_MS + 60 * 60 * 1000;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function handoffsLocal(opts: LocalOptions): HandoffsLocal {
  const home = opts.home ?? soopdoopHome();
  const now = opts.now ?? Date.now;
  const say = opts.say ?? function (line: string) { console.error(line); };
  const fork = opts.fork ?? function (agent: AgentRecord, prompt: string) { return forkAgent(agent, prompt, { maxChars: MAX_SUMMARY }); };
  let deps: DeliverDeps | null = null;
  function deliverDeps(): DeliverDeps {
    deps ??= (opts.deliverDeps ?? defaultDeliverDeps)();
    return deps;
  }
  let waiting = new Map<string, ToRun>();
  let finished: Finished[] = [];
  const busy = new Set<string>();
  // Delivered or failed here, by this daemon or one before it (the log).
  const done = new Set<string>();
  // Delivered here but still "accepted" on the backend: started is called again once.
  const resynced = new Set<string>();
  const running = new Map<string, Running>();
  const told = new Set<string>();
  const awayTried = new Map<string, number>();
  const pending = new Set<Promise<void>>();

  function track(p: Promise<void>): void {
    const tracked = p.catch(function (e: unknown) { say(`hand-offs: ${message(e)}`); }).finally(function () { pending.delete(tracked); });
    pending.add(tracked);
  }

  // What the log says this Mac did before (this daemon may have just started).
  async function load(): Promise<void> {
    const lines = await readHandoffLog(home);
    const t = now();
    for (const l of lines) {
      if (l.event === "delivered" || l.event === "failed") done.add(l.handoffId);
      if (l.event === "told") told.add(l.handoffId);
      if (l.event === "delivered" && l.agentId !== undefined && t - l.at < RUNNING_FOR_MS && !isSettled(lines, l.handoffId)) {
        running.set(l.handoffId, { handoffId: l.handoffId, agentId: l.agentId, harness: l.harness ?? "claude-code", fromHandle: l.fromHandle, deliveredAt: l.at, held: l.held === true, reporting: false });
      }
    }
  }
  const ready = load();

  async function log(line: HandoffLine): Promise<void> {
    await appendHandoffLog(line, home);
  }

  async function fail(handoffId: string, agentId: string, note: string): Promise<void> {
    done.add(handoffId);
    running.delete(handoffId);
    try {
      await opts.backend.mutation(failedRef, { token: opts.token, handoffId, note });
    } catch (e) {
      say(`hand-off ${handoffId}: could not mark it failed: ${message(e)}`);
    }
    await log({ at: now(), event: "failed", handoffId, agentId, note });
  }

  // handoffs:started, with a note when there is one. A backend from before the note takes it without.
  async function markStarted(handoffId: string, note: string | undefined): Promise<void> {
    if (note !== undefined) {
      try {
        await opts.backend.mutation(startedRef, { token: opts.token, handoffId, note });
        return;
      } catch {
        // Tried again without the note below.
      }
    }
    await opts.backend.mutation(startedRef, { token: opts.token, handoffId });
  }

  function targetFor(item: ToRun, agent: AgentRecord | undefined): Target {
    if (agent === undefined) return { agentId: item.targetAgentId, harness: item.targetHarness ?? "claude-code" };
    return {
      agentId: agent.agentId,
      harness: agent.harness,
      name: agent.name,
      permissionMode: agent.permissionMode,
      inboxSocket: agent.inboxSocket,
      inboxToken: agent.inboxToken,
      supersetTerminalId: agent.supersetTerminalId,
      supersetWorkspaceId: agent.supersetWorkspaceId,
      transcriptPath: agent.transcriptPath,
    };
  }

  async function run(item: ToRun): Promise<void> {
    await ready;
    if (done.has(item.handoffId)) return;
    const agent = opts.subset.get(item.targetAgentId);
    const lines = await readHandoffLog(home);
    const { handoffDailyUsd } = await readSettings(settingsPath(home));
    const limit = allowanceLimit(handoffDailyUsd, spentOnHandoffs(lines, now()));
    if (limit !== null) {
      await fail(item.handoffId, item.targetAgentId, limit);
      return;
    }
    const target = targetFor(item, agent);
    const prompt = handoffPrompt(item.fromHandle, item.text, item.handoffId);
    // Followed from before it goes: an agent can finish the turn it starts before the channel's command returns (Codex
    // with an idle session does), and its Stop must find the hand-off.
    const at = now();
    const r: Running = { handoffId: item.handoffId, agentId: target.agentId, harness: target.harness, fromHandle: item.fromHandle, deliveredAt: at, held: false, reporting: false };
    running.set(item.handoffId, r);
    const got: Delivery | { failed: string } = agent === undefined
      ? await deliver(target, prompt, item.fromHandle, deliverDeps(), awayChannelsFor(target.harness))
      : await deliver(target, prompt, item.fromHandle, deliverDeps());
    if ("failed" in got) {
      running.delete(item.handoffId);
      // An agent not running here may come back (or wake); the backend ends the hand-off after 24 hours.
      if (agent === undefined) return;
      await fail(item.handoffId, item.targetAgentId, `Could not reach that agent on its Mac (${got.failed}).`);
      return;
    }
    done.add(item.handoffId);
    r.held = got.held === true;
    // Logged before handoffs:started, so a daemon that stops in between never delivers it twice.
    await log({
      at, event: "delivered", handoffId: item.handoffId, fromHandle: item.fromHandle, agentId: target.agentId, harness: target.harness,
      channel: got.channel, chars: prompt.length, ...(got.held === true ? { held: true } : {}),
    });
    try {
      await markStarted(item.handoffId, got.note);
    } catch (e) {
      say(`hand-off ${item.handoffId}: delivered by ${got.channel}, but handoffs:started failed: ${message(e)}`);
    }
  }

  function tryRun(): void {
    const t = now();
    for (const item of waiting.values()) {
      if (busy.has(item.handoffId) || done.has(item.handoffId)) continue;
      const agent = opts.subset.get(item.targetAgentId);
      if (agent !== undefined && (!agent.open || !mayDeliver(item, agent.status))) continue;
      if (agent === undefined) {
        const last = awayTried.get(item.handoffId);
        if (last !== undefined && t - last < AWAY_EVERY_MS) continue;
        awayTried.set(item.handoffId, t);
      }
      busy.add(item.handoffId);
      track(run(item).finally(function () { busy.delete(item.handoffId); }));
    }
  }

  // Hand-offs this Mac delivered that the backend still lists as accepted (started did not get through): say so again.
  async function resync(): Promise<void> {
    await ready;
    for (const item of waiting.values()) {
      if (!done.has(item.handoffId) || resynced.has(item.handoffId)) continue;
      resynced.add(item.handoffId);
      if (!running.has(item.handoffId)) continue;
      await markStarted(item.handoffId, undefined).catch(function (e: unknown) { say(`hand-off ${item.handoffId}: ${message(e)}`); });
    }
  }

  async function transcriptOf(agent: AgentRecord): Promise<string | null> {
    return agent.transcriptPath ?? (await findTranscript(agent.harness, agent.agentId, agent.cwd));
  }

  // The agent stopped: when its transcript shows it took the hand-off and replied, and no report came, a copy of the
  // session is asked what it did (within the fund), and that is reported back.
  async function reportFor(r: Running, agent: AgentRecord): Promise<void> {
    if (r.reporting) return;
    if (isSettled(await readHandoffLog(home), r.handoffId)) {
      running.delete(r.handoffId);
      return;
    }
    const transcript = await transcriptOf(agent);
    if (transcript === null) return;
    if (!handoffSeen(await readTail(transcript, 8_000_000), r.handoffId).answered) return;
    r.reporting = true;
    try {
      const limit = fundLimit(await readFund(fundPath(home)), await readSpends(home), { agentId: agent.agentId }, now());
      if (limit !== null) {
        say(`hand-off ${r.handoffId}: no report back, and the answering fund stops asking (${limit.kind})`);
        return;
      }
      const asked = await fork({ ...agent, transcriptPath: transcript }, reportPrompt(r.handoffId));
      await logRead({
        kind: "handoff-report", handoffId: r.handoffId, agentId: agent.agentId, agent: agent.name, model: asked.model,
        sentChars: "answer" in asked ? asked.answer.length : 0, tokensRead: asked.tokensRead, usd: asked.usd,
        refused: "refused" in asked ? asked.refused : undefined,
      }, home);
      if (!("answer" in asked)) return;
      // A report the agent made while the copy was asked wins.
      if (isSettled(await readHandoffLog(home), r.handoffId)) return;
      const summary = asked.answer.slice(0, MAX_SUMMARY);
      const cost = await handoffCost(agent.harness, transcript, r.deliveredAt);
      const links = prUrls(asked.answer);
      await opts.backend.mutation(reportBackRef, {
        token: opts.token, handoffId: r.handoffId, summary, ...(links.length > 0 ? { links } : {}), ...(cost === null ? {} : { usd: cost.usd }),
      });
      await log({ at: now(), event: "reported", handoffId: r.handoffId, agentId: agent.agentId, by: "fork", chars: summary.length, ...(cost === null ? {} : { usd: cost.usd }) });
      running.delete(r.handoffId);
    } finally {
      r.reporting = false;
    }
  }

  async function ended(r: Running): Promise<void> {
    if (r.reporting) return;
    if (isSettled(await readHandoffLog(home), r.handoffId)) {
      running.delete(r.handoffId);
      return;
    }
    await fail(r.handoffId, r.agentId, "the session ended without reporting back");
  }

  // A hand-off Claude Code held for approval in a session that bypasses permissions: if it never reached the agent, nobody
  // approved it (Claude Code drops it after five minutes; a background session with no terminal keeps asking).
  async function heldCheck(r: Running): Promise<void> {
    r.held = false;
    const agent = opts.subset.get(r.agentId);
    const transcript = agent === undefined ? await findTranscript(r.harness, r.agentId) : await transcriptOf(agent);
    if (transcript !== null && handoffSeen(await readTail(transcript, 8_000_000), r.handoffId).asked) return;
    if (r.reporting || isSettled(await readHandoffLog(home), r.handoffId)) return;
    await fail(r.handoffId, r.agentId, "It waited in the receiver's session for their approval, and nobody approved it.");
  }

  async function onEvent(ev: HookEvent, before: AgentRecord | undefined): Promise<void> {
    await ready;
    const event = ev.hook_event_name;
    for (const r of [...running.values()]) {
      if (r.agentId !== ev.session_id) continue;
      if (event === "Stop") {
        const agent = opts.subset.get(r.agentId) ?? before;
        if (agent !== undefined) await reportFor(r, agent);
      }
      if (event === "SessionEnd") await ended(r);
    }
  }

  function tick(): void {
    tryRun();
    const t = now();
    for (const r of running.values()) if (r.held && !r.reporting && t - r.deliveredAt >= HELD_MS) track(heldCheck(r));
  }

  const stopToRun = opts.backend.watch(toRunRef, { token: opts.token }, function (raw) {
    waiting = new Map(parseToRun(raw).map(function (item) { return [item.handoffId, item]; }));
    track(resync().then(tryRun));
  });
  const stopFinished = opts.backend.watch(finishedRef, { token: opts.token }, function (raw) {
    finished = parseFinished(raw);
  });
  const tickMs = opts.tickMs ?? 60_000;
  const timer = tickMs > 0 ? setInterval(tick, tickMs) : null;

  return {
    onHook(ev, before) {
      track(onEvent(ev, before));
      tryRun();
    },
    async contextFor(ev) {
      if (ev.hook_event_name !== "UserPromptSubmit") return null;
      await ready;
      const lines: string[] = [];
      for (const f of finished) {
        if (f.fromAgentId !== ev.session_id || told.has(f.handoffId)) continue;
        told.add(f.handoffId);
        lines.push(finishedLine(f));
        track(log({ at: now(), event: "told", handoffId: f.handoffId, agentId: ev.session_id }));
      }
      return lines.length === 0 ? null : lines.join("\n");
    },
    async settle() {
      await ready;
      while (pending.size > 0) await Promise.all([...pending]);
    },
    stop() {
      stopToRun();
      stopFinished();
      if (timer !== null) clearInterval(timer);
    },
  };
}
