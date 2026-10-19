// ABOUTME: Server-side. The native app's backend: holds the Superset session and a live Convex connection, keeps one state
// ABOUTME: object current from subscriptions and this machine's files, pairs the machine, and runs the app's actions.
import { unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ConvexClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
import { api } from "@soopdoop/convex/convex/_generated/api";
import { configPath, invitePath, readConfig, settingsPath, writeConfig, writeSettings, type Settings } from "@soopdoop/daemon/src/config";
import { DAEMON_PORT, startNow, UPDATER_LABEL } from "@soopdoop/daemon/src/service";
import { requestUpdate } from "@soopdoop/daemon/src/update";
import { RAIL_ORIGIN } from "./config";
import { cleanError } from "./format";
import { inviteLink, inviteMessage } from "./invite";
import { readLocalInfo, type LocalInfo, type LocalServer } from "./local";
import { idToken, readSession, saveSession, signIn } from "./session";

type Me = NonNullable<FunctionReturnType<typeof api.hackers.me>>;
type Friend = FunctionReturnType<typeof api.friends.list>[number];
type Relay = FunctionReturnType<typeof api.operator.log>[number];
type LedgerLine = FunctionReturnType<typeof api.ledger.mine>[number];

export type Phase = "signed-out" | "signing-in" | "connecting" | "needs-handle" | "ready";

// Everything the app shows. The app decodes this JSON; add fields freely, but do not rename or remove them.
export interface AppState {
  version: string;
  phase: Phase;
  message: string | null;
  me: Me | null;
  board: FunctionReturnType<typeof api.play.board>;
  // Friends, with `relaying` while one of my questions is reading their agent (purple). A crewmate's row also says what
  // their newest open agent is on (`summary`) and when one of their machines last reported (`lastSeenAt`).
  crew: (Friend & { relaying: boolean })[];
  requests: FunctionReturnType<typeof api.friends.pending>;
  incoming: FunctionReturnType<typeof api.knocks.incoming>;
  sent: FunctionReturnType<typeof api.knocks.sent>;
  subset: FunctionReturnType<typeof api.subsets.mine>;
  // What the Operator knows about each of my open agents: the one line it routes questions with.
  routing: FunctionReturnType<typeof api.routing.mine>;
  wire: Relay[];
  local: LocalInfo | null;
  inviteWaiting: boolean;
  // Who flicked me (catchable until catchUntil), whom I flicked and wait on, my flicks caught lately, my superflicks.
  flicks: FunctionReturnType<typeof api.flicks.mine>;
  // The Operator chat: my messages and its replies, oldest first.
  chat: Relay[];
  // The wire: the crew's last day (answers between agents, new agents, flicks, ships, hand-offs, notes, shouts, props,
  // digests), newest first.
  feed: FunctionReturnType<typeof api.feed.recent>;
  // Tokens the crew's answers saved, all time, as an estimate: mine, my agents' for crewmates, the crew's. Null until read.
  saved: FunctionReturnType<typeof api.feed.saved> | null;
  // My crew: its name, plan, leader, members and settings. Never the Slack webhook or Intercom's token and secret, only
  // whether they are set. Null when I am in no crew (and until read).
  crewInfo: FunctionReturnType<typeof api.crews.mine>;
  // The crew's four numbers for the last 7 days. Totals, never per person. Null until read.
  numbers: FunctionReturnType<typeof api.crews.numbers> | null;
  // What the crew's Operator cost this month at API prices. Null until read.
  costs: FunctionReturnType<typeof api.crews.costs> | null;
  // My ledger: one line per finished task, newest first, the last 50.
  ledger: LedgerLine[];
  // The crew's notes: the live ones, the proposals waiting for me, the last 10 retired.
  notes: FunctionReturnType<typeof api.notes.list>;
  // Hand-offs offered to me (waiting or accepted), and my last 20 offers.
  handoffs: FunctionReturnType<typeof api.handoffs.mine>;
  // What I let each crewmate do with hand-offs: ask me each time, run when my agent is idle, or never.
  consents: FunctionReturnType<typeof api.handoffs.consents>;
  // Open heads-up cards: a crewmate's agent is on the same area or files as one of mine.
  headsups: FunctionReturnType<typeof api.headsups.cards>;
  // The crew's latest daily digest and latest weekly numbers.
  digest: FunctionReturnType<typeof api.digests.latest>;
}

export interface Agent {
  state(): AppState;
  subscribe(listener: (state: AppState) => void): () => void;
  act(action: string, args: unknown): Promise<unknown>;
  start(): Promise<void>;
  // Stops following the backend and this Mac's files (tests use it; serve.ts runs until the process ends).
  stop(): void;
}

const EMPTY = {
  me: null,
  board: [],
  crew: [],
  requests: [],
  incoming: { current: null, pending: 0 },
  sent: [],
  subset: [],
  routing: [],
  wire: [],
  flicks: { incoming: [], waitingOn: [], caught: [], superflicks: { ready: 0, clean: 0, every: 5 } },
  chat: [],
  feed: [],
  saved: null,
  crewInfo: null,
  numbers: null,
  costs: null,
  ledger: [],
  notes: { live: [], proposed: [], retired: [] },
  handoffs: { incoming: [], outgoing: [] },
  consents: [],
  headsups: [],
  digest: { daily: null, weekly: null },
};

// Where the app offered a hand-off from. The backend takes these four; anything else counts as the HUD.
const HANDOFF_VIA: readonly ("hud" | "menu" | "headsup" | "operator")[] = ["hud", "menu", "headsup", "operator"];

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function field(args: unknown, key: string): unknown {
  return isRecord(args) ? args[key] : undefined;
}

function text(args: unknown, key: string): string {
  const value = field(args, key);
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Missing ${key}.`);
  return value.trim();
}

function optionalText(args: unknown, key: string): string | undefined {
  const value = field(args, key);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function flag(args: unknown, key: string): boolean {
  const value = field(args, key);
  if (typeof value !== "boolean") throw new Error(`Missing ${key}.`);
  return value;
}

function optionalFlag(args: unknown, key: string): boolean | undefined {
  const value = field(args, key);
  return typeof value === "boolean" ? value : undefined;
}

// A number the app sends: an hour, dollars, a date in milliseconds.
function amount(args: unknown, key: string): number {
  const value = field(args, key);
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Missing ${key}.`);
  return value;
}

function optionalAmount(args: unknown, key: string): number | undefined {
  const value = field(args, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// A setting the app never sees again once it is set (a webhook, a token): null takes it off, and an empty box or no
// value at all leaves it as it is.
function secretChange(args: unknown, key: string): string | null | undefined {
  return field(args, key) === null ? null : optionalText(args, key);
}

// A field the app shows and lets the hacker empty: null or an empty box clears it, no value at all leaves it.
function clearable(args: unknown, key: string): string | null | undefined {
  const value = field(args, key);
  if (value === null || (typeof value === "string" && value.trim() === "")) return null;
  return optionalText(args, key);
}

function numberOrNull(args: unknown, key: string): number | null | undefined {
  return field(args, key) === null ? null : optionalAmount(args, key);
}

// Short words such as tags or handles: a list of strings, or one string split at commas and spaces.
function words(args: unknown, key: string): string[] | undefined {
  const value = field(args, key);
  const raw: unknown[] | undefined = typeof value === "string" ? value.split(/[\s,]+/) : Array.isArray(value) ? value : undefined;
  if (raw === undefined) return undefined;
  return raw.flatMap(function (w) { return typeof w === "string" && w.trim() !== "" ? [w.trim()] : []; });
}

function handleOf(args: unknown, key = "handle"): string {
  return text(args, key).replace(/^@/, "");
}

// One of a few words; anything else is missing.
function choice<T extends string>(args: unknown, key: string, options: readonly T[]): T {
  const value = field(args, key);
  const found = options.find(function (o) { return o === value; });
  if (found === undefined) throw new Error(`Missing ${key}.`);
  return found;
}

function knockKind(value: unknown): "link" | "file" | "session" | "page" {
  return value === "file" || value === "session" || value === "page" ? value : "link";
}

// The app acts only on what it was shown: an id it sends must be one in the current state, as for knocks and flicks.
function shown<T extends { _id: string }>(list: T[], id: string, gone: string): T {
  const found = list.find(function (x) { return x._id === id; });
  if (found === undefined) throw new Error(gone);
  return found;
}

// Friends a question of mine is reading right now.
export function relayingTo(wire: Relay[]): Set<string> {
  return new Set(wire.flatMap(function (r) {
    return r.role === "asked" && (r.status === "routing" || r.status === "reading") && r.targetHandle !== undefined ? [r.targetHandle] : [];
  }));
}

// The Mac's IANA time zone, such as America/Toronto. Null when the system does not say.
function localTimezone(): string | null {
  const zone: unknown = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return typeof zone === "string" && zone !== "" ? zone : null;
}

// This Mac's daemon. SOOPDOOP_PORT moves it, as it moves the daemon itself (tests, a second daemon).
function daemonUrl(route: string): string {
  return `http://127.0.0.1:${process.env.SOOPDOOP_PORT ?? String(DAEMON_PORT)}${route}`;
}

// The daemon answers JSON, or one line of plain text that says what is wrong.
async function postDaemon(route: string, body: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(daemonUrl(route), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error("soopdoop's daemon is not answering on this Mac. Run `soopdoop status` in Terminal.");
  }
  if (!res.ok) {
    const said = (await res.text()).trim();
    throw new Error(said === "" ? `The daemon answered ${res.status}.` : said);
  }
  return await res.json();
}

// The daemon's answer to POST /walkthrough: the page it wrote on this Mac, and a web link to it once there is one.
function walkthroughFrom(raw: unknown): { file: string; web: string | undefined } {
  const file = field(raw, "path");
  if (typeof file !== "string" || !path.isAbsolute(file) || !file.endsWith(".html")) throw new Error("The daemon did not make a walkthrough.");
  const web = field(raw, "url");
  return { file, web: typeof web === "string" && /^https?:\/\/\S+$/i.test(web) ? web : undefined };
}

async function openInBrowser(url: string): Promise<void> {
  await Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url]).exited;
}

function connectConvex(url: string): ConvexClient {
  return new ConvexClient(url);
}

// `connect` makes the Convex client; tests hand in a stand-in.
export function createAgent(
  server: LocalServer,
  open: (url: string) => Promise<void> = openInBrowser,
  connect: (url: string) => ConvexClient = connectConvex,
): Agent {
  let state: AppState = { version: server.version, phase: "signed-out", message: null, local: null, inviteWaiting: false, ...EMPTY };
  let friends: Friend[] = [];
  const listeners = new Set<(state: AppState) => void>();
  let client: ConvexClient | null = null;
  let stops: (() => void)[] = [];
  let following = false;
  let pairing = false;
  let redeeming = false;
  let timezoneSent = false;
  let pending: ReturnType<typeof setTimeout> | null = null;
  let ticking: ReturnType<typeof setInterval> | null = null;

  // Changes arrive in bursts (several subscriptions at once); the app gets one state per burst.
  function set(patch: Partial<AppState>): void {
    state = { ...state, ...patch };
    const relaying = relayingTo(state.wire);
    state.crew = friends.map(function (f) { return { ...f, relaying: relaying.has(f.handle) }; });
    if (pending !== null) return;
    pending = setTimeout(function () {
      pending = null;
      for (const listener of listeners) listener(state);
    }, 25);
  }

  function stopClient(): void {
    for (const stop of stops) stop();
    stops = [];
    following = false;
    if (client !== null) void client.close();
    client = null;
  }

  function signedOut(message: string | null): void {
    stopClient();
    friends = [];
    set({ phase: "signed-out", message, ...EMPTY });
  }

  function live(): ConvexClient {
    if (client === null) throw new Error("Sign in first.");
    return client;
  }

  function logError(e: Error): void {
    console.error("subscription:", cleanError(e));
  }

  // The rest needs a handle: every query below asks for the caller's hacker row.
  function follow(c: ConvexClient): void {
    if (following) return;
    following = true;
    stops.push(
      c.onUpdate(api.play.board, {}, function (board) { set({ board }); }, logError),
      c.onUpdate(api.friends.list, {}, function (list) { friends = list; set({}); }, logError),
      c.onUpdate(api.friends.pending, {}, function (requests) { set({ requests }); }, logError),
      c.onUpdate(api.knocks.incoming, {}, function (incoming) { set({ incoming }); }, logError),
      c.onUpdate(api.knocks.sent, {}, function (sent) { set({ sent }); }, logError),
      c.onUpdate(api.subsets.mine, {}, function (subset) { set({ subset }); }, logError),
      c.onUpdate(api.routing.mine, {}, function (routing) { set({ routing }); }, logError),
      c.onUpdate(api.operator.log, {}, function (wire) { set({ wire }); }, logError),
      c.onUpdate(api.flicks.mine, {}, function (flicks) { set({ flicks }); }, logError),
      c.onUpdate(api.operator.chatLog, {}, function (chat) { set({ chat }); }, logError),
      c.onUpdate(api.feed.recent, {}, function (feed) { set({ feed }); }, logError),
      c.onUpdate(api.feed.saved, {}, function (saved) { set({ saved }); }, logError),
      c.onUpdate(api.crews.mine, {}, function (crewInfo) { set({ crewInfo }); }, logError),
      c.onUpdate(api.crews.numbers, {}, function (numbers) { set({ numbers }); }, logError),
      c.onUpdate(api.crews.costs, {}, function (costs) { set({ costs }); }, logError),
      c.onUpdate(api.ledger.mine, {}, function (ledger) { set({ ledger }); }, logError),
      c.onUpdate(api.notes.list, {}, function (notes) { set({ notes }); }, logError),
      c.onUpdate(api.handoffs.mine, {}, function (handoffs) { set({ handoffs }); }, logError),
      c.onUpdate(api.handoffs.consents, {}, function (consents) { set({ consents }); }, logError),
      c.onUpdate(api.headsups.cards, {}, function (headsups) { set({ headsups }); }, logError),
      c.onUpdate(api.digests.latest, {}, function (digest) { set({ digest }); }, logError),
    );
  }

  // Once per start: the Mac's time zone, so the crew's digest goes out at the hour its leader picked, in their time.
  function sendTimezone(c: ConvexClient): void {
    const timezone = localTimezone();
    if (timezoneSent || timezone === null) return;
    timezoneSent = true;
    void c.mutation(api.hackers.setTimezone, { timezone }).catch(function (e: unknown) {
      console.error("time zone:", cleanError(e));
    });
  }

  function startClient(): void {
    stopClient();
    const c = connect(server.convexUrl);
    client = c;
    timezoneSent = false;
    set({ phase: "connecting", message: null });
    c.setAuth(
      function (args) { return idToken(args.forceRefreshToken); },
      function (authenticated) {
        if (!authenticated) {
          void saveSession(null);
          signedOut("Your Superset sign-in ended. Sign in again.");
          return;
        }
        if (stops.length > 0) return;
        stops.push(c.onUpdate(api.hackers.me, {}, function (me) {
          set({ me, phase: me === null ? "needs-handle" : "ready" });
          if (me === null) return;
          follow(c);
          sendTimezone(c);
          void pairIfNeeded(c);
          void redeemWaitingInvite(c);
        }, logError));
      },
    );
  }

  async function refreshLocal(): Promise<void> {
    const local = await readLocalInfo(server);
    const inviteWaiting = await Bun.file(invitePath()).exists();
    if (JSON.stringify(local) !== JSON.stringify(state.local) || inviteWaiting !== state.inviteWaiting) set({ local, inviteWaiting });
  }

  // This Mac's settings file (the daemon and the watcher read it too); then the state shows the change.
  async function changeSettings(change: Partial<Settings>): Promise<null> {
    await writeSettings(change, server.settingsFile ?? settingsPath());
    await refreshLocal();
    return null;
  }

  // Signed in with a handle, but this machine is not paired with this deployment: pair it, as the web rail does.
  async function pairIfNeeded(c: ConvexClient): Promise<void> {
    if (pairing) return;
    const local = await readLocalInfo(server);
    if (local.paired) return;
    pairing = true;
    try {
      const token = await c.mutation(api.subsets.pairDaemon, { machineName: local.machine });
      const existing = await readConfig(server.configFile ?? configPath()).catch(function () { return null; });
      await writeConfig({ convexUrl: server.convexUrl, token, privateDirs: existing?.privateDirs ?? [] }, server.configFile ?? configPath());
      await refreshLocal();
    } catch (e) {
      console.error("pairing failed:", cleanError(e));
    } finally {
      pairing = false;
    }
  }

  // `soopdoop setup --invite <code>` leaves the code for the first sign-in.
  async function redeemWaitingInvite(c: ConvexClient): Promise<void> {
    const file = Bun.file(invitePath());
    if (redeeming || !(await file.exists())) return;
    redeeming = true;
    try {
      const code = (await file.text()).trim();
      const from = await c.mutation(api.friends.redeemInvite, { token: code });
      set({ message: `You and @${from} are friends now.` });
    } catch (e) {
      set({ message: cleanError(e) });
    } finally {
      await unlink(invitePath()).catch(function () { /* already gone */ });
      redeeming = false;
      await refreshLocal();
    }
  }

  function ledgerLine(args: unknown): LedgerLine {
    return shown(state.ledger, text(args, "ledgerId"), "That ledger line is gone.");
  }

  async function act(action: string, args: unknown): Promise<unknown> {
    switch (action) {
      case "signIn": {
        if (state.phase !== "signed-out") return null;
        set({ phase: "signing-in", message: null });
        try {
          await signIn(open);
          startClient();
        } catch (e) {
          set({ phase: "signed-out", message: cleanError(e) });
        }
        return null;
      }
      case "signOut":
        await saveSession(null);
        signedOut(null);
        return null;
      case "claimHandle": {
        const handle = text(args, "handle").replace(/^@/, "");
        await live().mutation(api.hackers.claimHandle, { handle });
        // Superset handles have the same shape; link the profile when the names match. Quiet otherwise. Linking also
        // redeems invites made for that Superset handle, so whoever sent them is a friend now.
        void live().action(api.superset.linkProfile, { handle, auto: true }).then(function (linked) {
          if (linked.invitedBy.length > 0) set({ message: `You and ${linked.invitedBy.map(function (h) { return `@${h}`; }).join(", ")} are friends now: they invited you.` });
        }).catch(function () { /* not theirs */ });
        return null;
      }
      case "knock":
        await live().mutation(api.knocks.send, {
          toHandle: text(args, "toHandle"),
          item: { kind: knockKind(field(args, "kind")), title: text(args, "title"), url: optionalText(args, "url") },
          note: optionalText(args, "note"),
          lifetimeMs: typeof field(args, "lifetimeMs") === "number" ? Number(field(args, "lifetimeMs")) : undefined,
        });
        return null;
      case "decideKnock": {
        // Always the knock on screen, so the app never sends ids.
        const current = state.incoming.current;
        if (current === null) return null;
        const outcome = field(args, "outcome") === "opened" ? "opened" : "not-now";
        await live().mutation(api.knocks.decide, { knockId: current._id, outcome });
        if (outcome === "opened" && current.item.url !== undefined) await open(current.item.url);
        return null;
      }
      case "setFocus": {
        const minutes = field(args, "minutes");
        await live().mutation(api.hackers.setFocus, { minutes: typeof minutes === "number" ? minutes : null });
        return null;
      }
      case "updateSharing":
        await live().mutation(api.hackers.updateSharing, {
          shareAgentNames: flag(args, "shareAgentNames"),
          shareWorkspaceNames: flag(args, "shareWorkspaceNames"),
        });
        return null;
      case "addFriend":
        await live().mutation(api.friends.request, { handle: text(args, "handle").replace(/^@/, "") });
        return null;
      // Newer apps: someone not on soopdoop gets an invite instead of an error, found on Superset when possible.
      case "addOrInvite": {
        const added = await live().action(api.friends.addByHandle, { handle: text(args, "handle") });
        if (added.kind === "asked") return added;
        return {
          kind: "invited",
          handle: added.handle,
          onSuperset: added.onSuperset,
          name: added.name,
          link: inviteLink(added.token),
          message: inviteMessage(added.token, state.me?.handle ?? "a friend", added.name),
        };
      }
      case "flick":
        return await live().mutation(api.flicks.send, { toHandle: text(args, "handle") });
      case "catchFlick": {
        // Only a flick on screen: the app's id is checked against them, as knocks are.
        const id = text(args, "flickId");
        const flick = state.flicks.incoming.find(function (f) { return f._id === id; });
        if (flick === undefined) throw new Error("That flick is gone.");
        return await live().mutation(api.flicks.catchFlick, { flickId: flick._id });
      }
      case "superflick":
        return await live().mutation(api.flicks.superflick, { toHandle: text(args, "handle") });
      // The daemon knows each agent's folder and repository, and keeps the list; folders never pass through here.
      case "setPrivate":
        return await postDaemon("/private", { agentId: text(args, "agentId"), private: flag(args, "private") });
      case "acceptFriend": {
        const handle = text(args, "handle");
        const request = state.requests.find(function (r) { return r.handle === handle; });
        if (request === undefined) throw new Error(`No friend request from @${handle}.`);
        await live().mutation(api.friends.accept, { friendshipId: request.friendshipId });
        return null;
      }
      case "invite": {
        const code = await live().mutation(api.friends.createInvite, {});
        return inviteMessage(code, state.me?.handle ?? "a friend");
      }
      case "linkSuperset":
        return await live().action(api.superset.linkProfile, { handle: text(args, "handle") });
      case "unlinkSuperset":
        await live().mutation(api.superset.unlinkProfile, {});
        return null;
      case "ask":
        await live().mutation(api.operator.askAsHacker, { question: text(args, "question") });
        return null;
      case "chat":
        await live().mutation(api.operator.chat, { text: text(args, "text") });
        return null;
      case "setHideFromBoards":
        await live().mutation(api.hackers.setHideFromBoards, { hide: flag(args, "hide") });
        return null;
      case "setAutoUpdate":
        return await changeSettings({ autoUpdate: flag(args, "on") });
      // Whether the watcher opens the app when Superset opens. It reads the settings file each time.
      case "setAutoOpen":
        return await changeSettings({ autoOpen: flag(args, "on") });
      case "updateNow":
        if (!server.canUpdate) throw new Error("Run `soopdoop update` in Terminal.");
        await requestUpdate();
        await startNow(UPDATER_LABEL);
        return null;
      case "openRail":
        await open(`${RAIL_ORIGIN}/`);
        return null;

      // The crew. The backend decides who may change what; most of it is the leader's.
      case "createCrew":
        return await live().mutation(api.crews.create, { name: text(args, "name") });
      case "renameCrew":
        return await live().mutation(api.crews.rename, { name: text(args, "name") });
      case "setDigest": {
        // Without a time zone the crew keeps its own, or takes this Mac's.
        const timezone = optionalText(args, "timezone") ?? state.crewInfo?.timezone ?? localTimezone();
        if (timezone === null) throw new Error("Missing timezone.");
        return await live().mutation(api.crews.setDigest, { digestHour: amount(args, "digestHour"), timezone });
      }
      // The app never sees the webhook again once it is set: an empty box changes only the mirror, null takes it off.
      case "setSlackWebhook":
        return await live().mutation(api.crews.setSlack, { webhook: secretChange(args, "webhook"), mirror: optionalFlag(args, "mirror") });
      case "testSlack":
        return await live().mutation(api.crews.testSlack, {});
      case "setIntercom":
        return await live().mutation(api.crews.setIntercom, { token: secretChange(args, "token"), secret: secretChange(args, "secret") });
      case "addToCrew":
        return await live().mutation(api.crews.add, { handle: handleOf(args) });
      case "removeFromCrew":
        return await live().mutation(api.crews.remove, { handle: handleOf(args) });
      case "leaveCrew":
        return await live().mutation(api.crews.leave, {});
      case "handLeadership":
        return await live().mutation(api.crews.handLeadership, { handle: handleOf(args) });
      case "setTrustedNotePosters": {
        const handles = words(args, "handles");
        if (handles === undefined) throw new Error("Missing handles.");
        return await live().mutation(api.crews.setTrustedNotePosters, { handles: handles.map(function (h) { return h.replace(/^@/, ""); }) });
      }

      // My ledger. The ids are the lines on screen.
      case "editLedger": {
        const line = ledgerLine(args);
        return await live().mutation(api.ledger.edit, { ledgerId: line._id, did: text(args, "did") });
      }
      case "forgetLedger":
        return await live().mutation(api.ledger.forget, { ledgerId: ledgerLine(args)._id });
      // This Mac's daemon writes the walkthrough from the session (the conversation never leaves the Mac), and the owner
      // sees it at once. The backend keeps only web links, so a page on this Mac only marks the line as asked; a web
      // link, once the daemon gives one, goes on the line and the wire.
      case "makeWalkthrough": {
        const line = ledgerLine(args);
        const made = walkthroughFrom(await postDaemon("/walkthrough", { ledgerId: line._id, sessionKey: line.sessionKey }));
        const page = pathToFileURL(made.file).href;
        await open(page);
        if (made.web === undefined) await live().mutation(api.ledger.markWalkthroughAsked, { ledgerId: line._id });
        else await live().mutation(api.ledger.setWalkthrough, { ledgerId: line._id, url: made.web });
        return made.web ?? page;
      }
      case "skipWalkthrough":
        return await live().mutation(api.ledger.markWalkthroughAsked, { ledgerId: ledgerLine(args)._id });

      // Crew notes. The ids are the notes on screen: the live ones, and the proposals waiting for me.
      case "addNote": {
        const replaces = optionalText(args, "replaces");
        return await live().mutation(api.notes.add, {
          text: text(args, "text"),
          tags: words(args, "tags"),
          confirmBy: optionalAmount(args, "confirmBy"),
          appliesWhen: optionalText(args, "appliesWhen"),
          replaces: replaces === undefined ? undefined : shown(state.notes.live, replaces, "The note it replaces is gone.")._id,
        });
      }
      case "editNote": {
        const note = shown([...state.notes.live, ...state.notes.proposed], text(args, "noteId"), "That note is gone.");
        // The backend counts any edit as "still true", so an emptied text box is an error, not a confirmation.
        return await live().mutation(api.notes.edit, {
          noteId: note._id,
          text: field(args, "text") === undefined ? undefined : text(args, "text"),
          tags: words(args, "tags"),
          confirmBy: numberOrNull(args, "confirmBy"),
          appliesWhen: clearable(args, "appliesWhen"),
        });
      }
      case "confirmNote":
        return await live().mutation(api.notes.confirm, { noteId: shown(state.notes.live, text(args, "noteId"), "That note is gone.")._id });
      case "retireNote": {
        const note = shown([...state.notes.live, ...state.notes.proposed], text(args, "noteId"), "That note is gone.");
        return await live().mutation(api.notes.retire, { noteId: note._id });
      }
      case "approveNote":
        return await live().mutation(api.notes.approve, { noteId: shown(state.notes.proposed, text(args, "noteId"), "That proposal is gone.")._id });
      case "rejectNote":
        return await live().mutation(api.notes.reject, { noteId: shown(state.notes.proposed, text(args, "noteId"), "That proposal is gone.")._id });

      // Hand-offs: a task offered to a crewmate's agent, and my answer to one offered to mine.
      case "offerHandoff": {
        const via = HANDOFF_VIA.find(function (v) { return v === field(args, "via"); }) ?? "hud";
        return await live().mutation(api.handoffs.offer, {
          toHandle: handleOf(args, "toHandle"),
          text: text(args, "text"),
          why: optionalText(args, "why"),
          targetAgentId: optionalText(args, "targetAgentId"),
          via,
        });
      }
      case "decideHandoff": {
        const handoff = shown(state.handoffs.incoming, text(args, "handoffId"), "That hand-off is gone.");
        return await live().mutation(api.handoffs.decide, {
          handoffId: handoff._id,
          outcome: choice(args, "outcome", ["accept", "decline"]),
          targetAgentId: optionalText(args, "targetAgentId"),
          targetMachine: optionalText(args, "targetMachine"),
          note: optionalText(args, "note"),
        });
      }
      case "setConsent":
        return await live().mutation(api.handoffs.setConsent, { handle: handleOf(args), mode: choice(args, "mode", ["ask", "auto", "never"]) });

      // Heads-ups and the wire.
      case "dismissHeadsup":
        return await live().mutation(api.headsups.dismiss, { headsupId: shown(state.headsups, text(args, "headsupId"), "That heads-up is gone.")._id });
      case "shout":
        return await live().mutation(api.feed.shout, { text: text(args, "text") });
      case "props":
        return await live().mutation(api.feed.props, { feedId: shown(state.feed, text(args, "feedId"), "That line is no longer on the wire.")._id });

      // Settings → This Mac. The daemon reads these from the settings file.
      case "setLedgerLines":
        return await changeSettings({ ledgerLines: flag(args, "on") });
      case "setScout":
        return await changeSettings({ scout: flag(args, "on") });
      case "setHandoffAllowance": {
        const usd = amount(args, "usd");
        if (usd < 0) throw new Error("The hand-off allowance is 0 dollars or more.");
        return await changeSettings({ handoffDailyUsd: Math.round(usd * 100) / 100 });
      }
      default:
        throw new Error(`Unknown action ${action}.`);
    }
  }

  return {
    state: function () { return state; },
    subscribe: function (listener) {
      listeners.add(listener);
      return function () { listeners.delete(listener); };
    },
    act,
    start: async function () {
      await refreshLocal();
      ticking = setInterval(function () { void refreshLocal().catch(function () { /* next time */ }); }, 3_000);
      if ((await readSession()) !== null) startClient();
    },
    stop: function () {
      if (ticking !== null) clearInterval(ticking);
      ticking = null;
      stopClient();
    },
  };
}
