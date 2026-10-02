// ABOUTME: The rail itself: your subset, the friends roster, the incoming knock card, sent knocks, focus, settings,
// ABOUTME: pairing this machine and redeeming a waiting invite. Reads Convex subscriptions; nothing expires on the client.
import type { ConvexClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
import { api } from "@soopdoop/convex/convex/_generated/api";
import { profilePageUrl } from "@soopdoop/convex/convex/lib/supersetProfile";
import { byId, el, input, replaceChildren, ring, select } from "./dom";
import { cleanError, countdown, initials, minutesLeft, ringOffset } from "./format";
import { inviteMessage, takeInvite } from "./invite";

type Me = NonNullable<FunctionReturnType<typeof api.hackers.me>>;
type Friend = FunctionReturnType<typeof api.friends.list>[number];
type PendingRequest = FunctionReturnType<typeof api.friends.pending>[number];
type Machine = FunctionReturnType<typeof api.subsets.mine>[number];
type Incoming = FunctionReturnType<typeof api.knocks.incoming>;
type SentKnock = FunctionReturnType<typeof api.knocks.sent>[number];
type KnockKind = "link" | "file" | "session" | "page";
type SupersetCard = NonNullable<Friend["superset"]>;

export interface RailOptions {
  onSignOut: () => void;
}

const RING = 69.1; // 2π · r11, as in the prototype
const FLASH_MS = 5_000;
const LIVE_MS = 90_000;

let started = false;
let me: Me | null = null;
let friends: Friend[] = [];
let lastSent: SentKnock[] = [];
let ringTimer: ReturnType<typeof setInterval> | null = null;
let flashTimer: ReturnType<typeof setTimeout> | null = null;

export function mountRail(client: ConvexClient, current: Me, options: RailOptions): void {
  me = current;
  renderMe();
  if (started) return;
  started = true;
  client.onUpdate(api.friends.list, {}, function (rows) { friends = rows; renderRoster(); }, fail);
  client.onUpdate(api.friends.pending, {}, function (rows) { renderPendingRequests(client, rows); }, fail);
  client.onUpdate(api.subsets.mine, {}, renderMine, fail);
  client.onUpdate(api.knocks.incoming, {}, function (inbox) { renderIncoming(client, inbox); }, fail);
  client.onUpdate(api.knocks.sent, {}, function (rows) { lastSent = rows; renderSent(); }, fail);
  wireFocus(client);
  wireSettings(client, options);
  wireComposer(client);
  void redeemSavedInvite(client);
  void connectThisMachine(client);
  setInterval(renderMe, 30_000);
  setInterval(renderSent, 1_000);
}

export function flash(message: string): void {
  const node = byId("flash");
  node.textContent = message;
  node.hidden = false;
  if (flashTimer !== null) clearTimeout(flashTimer);
  flashTimer = setTimeout(function () { node.hidden = true; }, FLASH_MS);
}

function fail(e: unknown): void {
  flash(cleanError(e));
}

function ledFor(status: string): string {
  return status === "working" ? "g" : "b";
}

// Header: handle, focus state, and the sharing switches in settings.
function renderMe(): void {
  if (me === null) return;
  const now = Date.now();
  const who = byId("who");
  who.textContent = "@" + me.handle;
  who.hidden = false;
  const inFocus = me.focusUntil !== undefined && me.focusUntil > now;
  const focusBtn = byId("focusBtn");
  focusBtn.hidden = false;
  focusBtn.textContent = inFocus ? `focus · ${minutesLeft(me.focusUntil ?? now, now)}m` : "focus";
  focusBtn.classList.toggle("on", inFocus);
  byId("settingsBtn").hidden = false;
  input("shareAgentNames").checked = me.shareAgentNames;
  input("shareWorkspaceNames").checked = me.shareWorkspaceNames;
  const s = me.superset;
  byId("supersetNow").textContent = s === undefined
    ? "Not linked."
    : `Linked: superset.sh/${s.handle}${s.name === undefined ? "" : ` (${s.name})`}${s.tier === undefined ? "" : ` · ${s.tier}`}`;
  byId("supersetForm").hidden = s !== undefined;
  byId("supersetUnlink").hidden = s === undefined;
}

function renderMine(machines: Machine[]): void {
  const host = byId("mine");
  if (machines.length === 0) {
    replaceChildren(host, el("p", { class: "note" }, "No daemon paired yet. Open ⚙ and pair this machine."));
    return;
  }
  const now = Date.now();
  replaceChildren(host, ...machines.map(function (m) {
    const live = now - m.updatedAt < LIVE_MS;
    const anyWorking = m.agents.some(function (a) { return a.status === "working"; });
    const head = el("div", { class: "machine" },
      el("span", { class: `led ${live ? (anyWorking ? "g" : "b") : "x"}` }),
      el("span", { class: "ell" }, m.machineName),
      el("span", { class: "count" }, live ? `${m.agents.length} agent${m.agents.length === 1 ? "" : "s"}` : "daemon off"),
    );
    const rows = m.agents.length === 0
      ? [el("div", { class: "zeroset" }, "∅ no agents running")]
      : m.agents.map(function (a) {
        return el("div", { class: "ws" },
          a.open ? el("span", { class: `led ${ledFor(a.status)}` }) : el("span", { class: "lock", title: "Private. Only you can see this." }, "◇"),
          el("span", { class: "ell" }, a.name, a.workspace === undefined || a.workspace === a.name ? "" : ` · ${a.workspace}`),
          el("span", { class: "st" }, a.open ? a.status : "private"),
        );
      });
    return el("div", { class: "list" }, head, ...rows);
  }));
}

function renderRoster(): void {
  const host = byId("roster");
  byId("friendCount").textContent = friends.length === 0 ? "" : String(friends.length);
  if (friends.length === 0) {
    replaceChildren(host, el("p", { class: "note" }, "No friends yet. Open ⚙ to add one by handle or make an invite link."));
    return;
  }
  replaceChildren(host, ...friends.map(friendRow));
}

function friendRow(f: Friend): HTMLElement {
  const state = f.inFocus ? "in focus"
    : f.led === "x" ? "offline"
    : f.agentCount === 0 ? "∅ empty subset"
    : `${f.agentCount} agent${f.agentCount === 1 ? "" : "s"}`;
  const s = f.superset;
  const canKnock = f.led !== "x" && !f.inFocus;
  const knockBtn = el("button", { class: "btn tiny", type: "button", disabled: !canKnock, title: canKnock ? `Knock on @${f.handle}` : "Not reachable right now" }, "knock");
  knockBtn.addEventListener("click", function () { openComposer(f.handle); });
  const row = el("div", { class: "person" },
    el("span", { class: "av" }, initials(f.handle), el("span", { class: `led ${f.led}` })),
    el("span", { class: "ell" },
      el("div", { class: "nm ell" }, "@" + f.handle, s?.name === undefined ? null : el("span", { class: "real" }, " " + s.name)),
      el("div", { class: `st ell${f.agentCount === 0 && f.led !== "x" && !f.inFocus ? " zero" : ""}` }, state, s?.tier === undefined ? "" : ` · ${s.tier}`),
    ),
    knockBtn,
  );
  const agents = f.agents === undefined || f.agents.length === 0 ? null : el("div", { class: "agents" }, ...f.agents.map(function (a) {
    return el("div", { class: "agent" },
      el("span", { class: `led ${ledFor(a.status)}` }),
      el("span", { class: "ell" }, el("b", {}, a.name), a.workspace === undefined || a.workspace === a.name ? "" : ` · ${a.workspace}`),
    );
  }));
  return el("div", {}, row, s === undefined ? null : supersetDetails(s), agents);
}

// A friend's public Superset profile, folded away until asked for: the rail stays quiet by default.
function supersetDetails(s: SupersetCard): HTMLElement {
  const badges = s.achievements.map(function (a) {
    const label = a.level === undefined ? a.slug : `${a.slug} ${a.level}/${a.of ?? a.level}`;
    return el("span", { class: "badge" }, label);
  });
  return el("details", { class: "ss" },
    el("summary", {}, "on Superset"),
    el("div", { class: "ss-body" },
      s.models.length === 0 ? null : el("div", { class: "ell" }, el("span", { class: "k" }, "models "), s.models.join(" · ")),
      badges.length === 0 ? null : el("div", { class: "badges" }, ...badges),
      el("a", { href: profilePageUrl(s.handle), target: "_blank", rel: "noopener noreferrer" }, `superset.sh/${s.handle}`),
    ),
  );
}

function renderPendingRequests(client: ConvexClient, rows: PendingRequest[]): void {
  const host = byId("pendingRequests");
  replaceChildren(host, ...rows.map(function (r) {
    const accept = el("button", { class: "btn tiny primary", type: "button" }, "Accept");
    accept.addEventListener("click", function () {
      client.mutation(api.friends.accept, { friendshipId: r.friendshipId }).then(function () { flash(`You and @${r.handle} are friends now.`); }).catch(fail);
    });
    return el("div", { class: "request" }, el("span", { class: "ell" }, el("b", {}, "@" + r.handle), " wants to be friends"), accept);
  }));
}

function stopRing(): void {
  if (ringTimer !== null) clearInterval(ringTimer);
  ringTimer = null;
}

// One card at a time. The server decides when it is gone; the ring only draws the time the server gave.
function renderIncoming(client: ConvexClient, inbox: Incoming): void {
  const stack = byId("stack");
  const pending = byId("pending");
  stopRing();
  if (inbox.current === null) {
    replaceChildren(stack);
    pending.hidden = true;
    return;
  }
  const k = inbox.current;
  pending.hidden = inbox.pending === 0;
  pending.textContent = `+${inbox.pending} more waiting`;

  const dial = ring(RING);
  const show = el("button", { class: "btn primary", type: "button" }, k.item.url === undefined ? "Got it" : "Show me");
  show.addEventListener("click", function () {
    if (k.item.url !== undefined) window.open(k.item.url, "_blank", "noopener");
    client.mutation(api.knocks.decide, { knockId: k._id, outcome: "opened" }).catch(fail);
  });
  const later = el("button", { class: "btn", type: "button" }, "Not now");
  later.addEventListener("click", function () {
    client.mutation(api.knocks.decide, { knockId: k._id, outcome: "not-now" }).catch(fail);
  });
  const card = el("div", { class: "note-card knock rap", role: "status" },
    el("div", { class: "top" }, el("div", {}, el("b", {}, "@" + k.fromHandle), " wants you to see this"), dial.svg),
    el("div", { class: "item" },
      el("span", { class: "kind" }, k.item.kind),
      el("span", { class: "ell", title: k.item.title }, k.item.title),
      k.note === undefined ? null : el("span", { class: "st" }, `“${k.note}”`),
    ),
    el("div", { class: "acts" }, show, later),
  );
  replaceChildren(stack, card);

  function tick(): void {
    const now = Date.now();
    dial.arc.setAttribute("stroke-dashoffset", String(ringOffset(RING, k.expiresAt, k.lifetimeMs, now)));
    dial.text.textContent = countdown(k.expiresAt, now);
    dial.svg.classList.toggle("low", k.expiresAt - now <= 10_000);
  }
  tick();
  ringTimer = setInterval(tick, 1_000);
}

// What you sent: waiting with a countdown, "they're looking", or "not now". Expired knocks make no noise.
function renderSent(): void {
  const now = Date.now();
  const rows = lastSent.filter(function (r) {
    return r.outcome === "open" ? r.expiresAt > now - 1_000 : r.outcome !== "expired" && now - r.expiresAt < 10 * 60_000;
  });
  byId("sentHead").hidden = rows.length === 0;
  replaceChildren(byId("sent"), ...rows.map(function (r) {
    const label = r.outcome === "open" ? `waiting · ${countdown(r.expiresAt, now)}`
      : r.outcome === "opened" ? "they're looking"
      : "not now";
    return el("div", { class: "sentrow" }, el("span", { class: "ell" }, el("b", {}, "@" + r.toHandle)), el("span", { class: r.outcome === "opened" ? "looking" : "" }, label));
  }));
}

function wireFocus(client: ConvexClient): void {
  const menu = byId("focusMenu");
  byId("focusBtn").addEventListener("click", function () { menu.hidden = !menu.hidden; });
  for (const btn of menu.querySelectorAll("button")) {
    btn.addEventListener("click", function () {
      const min = btn.dataset.min;
      const minutes = min === undefined || min === "off" ? null : Number(min);
      menu.hidden = true;
      client.mutation(api.hackers.setFocus, { minutes }).then(function () {
        flash(minutes === null ? "Focus off. Friends can knock again." : `Focus on for ${minutes} minutes. You are off the rail and knocks bounce.`);
      }).catch(fail);
    });
  }
}

function wireSettings(client: ConvexClient, options: RailOptions): void {
  const panel = byId("settings");
  const toggle = byId("settingsBtn");
  toggle.addEventListener("click", function () {
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
  });
  for (const id of ["shareAgentNames", "shareWorkspaceNames"]) {
    input(id).addEventListener("change", function () {
      client.mutation(api.hackers.updateSharing, {
        shareAgentNames: input("shareAgentNames").checked,
        shareWorkspaceNames: input("shareWorkspaceNames").checked,
      }).catch(fail);
    });
  }
  byId("addFriend").addEventListener("submit", function (event) {
    event.preventDefault();
    const handle = input("addHandle").value.trim().replace(/^@/, "");
    client.mutation(api.friends.request, { handle }).then(function () {
      input("addHandle").value = "";
      flash(`Asked @${handle}. If they already asked you, you are friends now.`);
    }).catch(fail);
  });
  byId("inviteBtn").addEventListener("click", function () {
    client.mutation(api.friends.createInvite, {}).then(function (code) {
      const message = inviteMessage(code, me?.handle ?? "a friend");
      const out = byId("inviteOut");
      out.textContent = message;
      out.hidden = false;
      navigator.clipboard.writeText(message)
        .then(function () { flash("Invite copied. Send it to one person."); })
        .catch(function () { flash("Copy the invite below and send it to one person."); });
    }).catch(fail);
  });
  byId("supersetForm").addEventListener("submit", function (event) {
    event.preventDefault();
    byId("supersetNow").textContent = "Checking Superset…";
    client.action(api.superset.linkProfile, { handle: input("supersetHandle").value }).then(function (linked) {
      input("supersetHandle").value = "";
      flash(`Linked superset.sh/${linked.handle}. Friends see it on your row.`);
    }).catch(function (e: unknown) {
      renderMe();
      fail(e);
    });
  });
  byId("supersetUnlink").addEventListener("click", function () {
    client.mutation(api.superset.unlinkProfile, {}).then(function () {
      flash("Unlinked. Friends no longer see your Superset profile.");
    }).catch(fail);
  });
  byId("connectBtn").addEventListener("click", function () { void connectThisMachine(client); });
  byId("signout").addEventListener("click", options.onSignOut);
}

function openComposer(handle: string): void {
  byId("knockTo").textContent = "@" + handle;
  byId("knockTo").dataset.handle = handle;
  input("knockTitle").value = "";
  input("knockUrl").value = "";
  input("knockNote").value = "";
  byId("knockError").hidden = true;
  byId("composer").hidden = false;
  input("knockTitle").focus();
}

function knockKind(value: string): KnockKind {
  return value === "file" || value === "session" || value === "page" ? value : "link";
}

function wireComposer(client: ConvexClient): void {
  const composer = byId("composer");
  byId("knockCancel").addEventListener("click", function () { composer.hidden = true; });
  byId("knockForm").addEventListener("submit", function (event) {
    event.preventDefault();
    const toHandle = byId("knockTo").dataset.handle ?? "";
    const url = input("knockUrl").value.trim();
    const note = input("knockNote").value.trim();
    const err = byId("knockError");
    err.hidden = true;
    client.mutation(api.knocks.send, {
      toHandle,
      item: { kind: knockKind(select("knockKind").value), title: input("knockTitle").value.trim(), url: url === "" ? undefined : url },
      note: note === "" ? undefined : note,
      lifetimeMs: Number(select("knockLife").value),
    }).then(function () {
      composer.hidden = true;
      flash(`Knocked on @${toHandle}.`);
    }).catch(function (e: unknown) {
      err.textContent = cleanError(e);
      err.hidden = false;
    });
  });
}

// main.ts kept the code from the invite link through sign-in. Redeem it now that there is a handle.
async function redeemSavedInvite(client: ConvexClient): Promise<void> {
  const token = takeInvite(localStorage);
  if (token === null) return;
  try {
    const from = await client.mutation(api.friends.redeemInvite, { token });
    flash(`You and @${from} are friends now.`);
  } catch (e) {
    fail(e);
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// What this machine's rail server says about pairing. Null when the page is not served by a soopdoop rail server.
async function readLocal(): Promise<{ machine: string; paired: boolean } | null> {
  try {
    const res = await fetch("/local", { cache: "no-store" });
    if (!res.ok) return null;
    const raw: unknown = await res.json();
    if (!isRecord(raw) || typeof raw.machine !== "string" || typeof raw.paired !== "boolean") return null;
    return { machine: raw.machine, paired: raw.paired };
  } catch {
    return null;
  }
}

// Pairs this machine with no terminal step: Convex mints a daemon token, this machine's rail server writes it
// where the daemon reads it, and the daemon starts reporting within a second. Runs once per page load.
async function connectThisMachine(client: ConvexClient): Promise<void> {
  const note = byId("machineNow");
  const button = byId("connectBtn");
  const local = await readLocal();
  if (local === null) {
    note.textContent = "Not served by soopdoop on this machine. Run `soopdoop setup` here to connect it.";
    button.hidden = true;
    return;
  }
  const connected = `${local.machine} · connected. Claude Code sessions here show under Your subset.`;
  if (local.paired) {
    note.textContent = connected;
    button.hidden = true;
    return;
  }
  note.textContent = `${local.machine} · connecting…`;
  try {
    const token = await client.mutation(api.subsets.pairDaemon, { machineName: local.machine });
    const res = await fetch("/local/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    // 409: another tab paired it first. Connected either way.
    if (!res.ok && res.status !== 409) {
      const body: unknown = await res.json().catch(function () { return null; });
      throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : `the rail server answered ${res.status}`);
    }
    note.textContent = connected;
    button.hidden = true;
    flash(`${local.machine} is connected. Claude Code sessions show up here on their next prompt or tool call.`);
  } catch (e) {
    note.textContent = `${local.machine} · not connected: ${cleanError(e)}`;
    button.hidden = false;
  }
}
