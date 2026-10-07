// ABOUTME: Server-side. The native app's backend: holds the Superset session and a live Convex connection, keeps one state
// ABOUTME: object current from subscriptions and this machine's files, pairs the machine, and runs the app's actions.
import { unlink } from "node:fs/promises";
import { ConvexClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
import { api } from "@soopdoop/convex/convex/_generated/api";
import { configPath, invitePath, readConfig, settingsPath, writeConfig, writeSettings } from "@soopdoop/daemon/src/config";
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

export type Phase = "signed-out" | "signing-in" | "connecting" | "needs-handle" | "ready";

// Everything the app shows. The app decodes this JSON; add fields freely, but do not rename or remove them.
export interface AppState {
  version: string;
  phase: Phase;
  message: string | null;
  me: Me | null;
  board: FunctionReturnType<typeof api.play.board>;
  // Friends, with `relaying` while one of my questions is reading their agent (purple).
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
  // The wire: the crew's last day (answers between agents, new agents, caught flicks, superflicks, rallies), newest first.
  feed: FunctionReturnType<typeof api.feed.recent>;
  // Tokens the crew's answers saved, all time, as an estimate: mine, my agents' for crewmates, the crew's. Null until read.
  saved: FunctionReturnType<typeof api.feed.saved> | null;
}

export interface Agent {
  state(): AppState;
  subscribe(listener: (state: AppState) => void): () => void;
  act(action: string, args: unknown): Promise<unknown>;
  start(): Promise<void>;
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
};

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

function knockKind(value: unknown): "link" | "file" | "session" | "page" {
  return value === "file" || value === "session" || value === "page" ? value : "link";
}

// Friends a question of mine is reading right now.
export function relayingTo(wire: Relay[]): Set<string> {
  return new Set(wire.flatMap(function (r) {
    return r.role === "asked" && (r.status === "routing" || r.status === "reading") && r.targetHandle !== undefined ? [r.targetHandle] : [];
  }));
}

async function openInBrowser(url: string): Promise<void> {
  await Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url]).exited;
}

export function createAgent(server: LocalServer, open: (url: string) => Promise<void> = openInBrowser): Agent {
  let state: AppState = { version: server.version, phase: "signed-out", message: null, local: null, inviteWaiting: false, ...EMPTY };
  let friends: Friend[] = [];
  const listeners = new Set<(state: AppState) => void>();
  let client: ConvexClient | null = null;
  let stops: (() => void)[] = [];
  let following = false;
  let pairing = false;
  let redeeming = false;
  let pending: ReturnType<typeof setTimeout> | null = null;

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
    );
  }

  function startClient(): void {
    stopClient();
    const c = new ConvexClient(server.convexUrl);
    client = c;
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
      case "setPrivate": {
        // The daemon knows each agent's folder and repository, and keeps the list; folders never pass through here.
        const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/private`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ agentId: text(args, "agentId"), private: flag(args, "private") }),
        });
        if (!res.ok) throw new Error((await res.text()).trim() || `The daemon answered ${res.status}.`);
        return await res.json();
      }
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
        await writeSettings({ autoUpdate: flag(args, "on") }, server.settingsFile ?? settingsPath());
        await refreshLocal();
        return null;
      // Whether the watcher opens the app when Superset opens. It reads the settings file each time.
      case "setAutoOpen":
        await writeSettings({ autoOpen: flag(args, "on") }, server.settingsFile ?? settingsPath());
        await refreshLocal();
        return null;
      case "updateNow":
        if (!server.canUpdate) throw new Error("Run `soopdoop update` in Terminal.");
        await requestUpdate();
        await startNow(UPDATER_LABEL);
        return null;
      case "openRail":
        await open(`${RAIL_ORIGIN}/`);
        return null;
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
      setInterval(function () { void refreshLocal().catch(function () { /* next time */ }); }, 3_000);
      if ((await readSession()) !== null) startClient();
    },
  };
}
