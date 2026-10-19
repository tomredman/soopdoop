import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ConvexClient } from "convex/browser";
import { getFunctionName, type FunctionReference, type FunctionReturnType } from "convex/server";
import { api } from "@soopdoop/convex/convex/_generated/api";
import type { Id } from "@soopdoop/convex/convex/_generated/dataModel";
import { readSettings, writeConfig } from "@soopdoop/daemon/src/config";
import { createAgent, relayingTo, type Agent, type AppState } from "./agent";
import { ensureAppToken, parseCommand, upgradeAllowed } from "./app-api";
import { base64url } from "./pkce";
import { CALLBACK_URI, idToken, readSession, saveSession, signIn } from "./session";

const dirs: string[] = [];
async function tempFile(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "soopdoop-app-"));
  dirs.push(dir);
  return path.join(dir, "home", name);
}
afterAll(async function () {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function jwt(expiresAtMs: number, tag: string): string {
  function part(o: unknown): string {
    return base64url(new TextEncoder().encode(JSON.stringify(o)));
  }
  return `${part({ alg: "RS256" })}.${part({ sub: "u1", exp: Math.floor(expiresAtMs / 1000), tag })}.sig`;
}

describe("the app's socket", function () {
  test("the token file is made once, owner-only, and reused", async function () {
    const file = await tempFile("app-token");
    const token = await ensureAppToken(file);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await ensureAppToken(file)).toBe(token);
  });

  test("only the app gets in: the token, and no browser Origin", function () {
    const token = "a".repeat(64);
    function req(headers: Record<string, string>): Request {
      return new Request("http://127.0.0.1:47312/app", { headers });
    }
    expect(upgradeAllowed(req({ authorization: `Bearer ${token}` }), token)).toBe(true);
    expect(upgradeAllowed(req({ authorization: `Bearer ${token}`, origin: "https://evil.example" }), token)).toBe(false);
    expect(upgradeAllowed(req({ authorization: "Bearer nope" }), token)).toBe(false);
    expect(upgradeAllowed(req({}), token)).toBe(false);
  });

  test("reads commands defensively", function () {
    expect(parseCommand('{"id":1,"action":"knock","args":{"toHandle":"jimmy"}}')).toEqual({ id: 1, action: "knock", args: { toHandle: "jimmy" } });
    expect(parseCommand('{"id":2,"action":"signOut"}')).toEqual({ id: 2, action: "signOut", args: undefined });
    for (const bad of ["nope", "[]", '{"id":"1","action":"x"}', '{"id":1}']) expect(parseCommand(bad)).toBeNull();
  });

  test("a friend is purple while one of my questions is reading their agent", function () {
    const base = { _id: "r", question: "q", askerHandle: "tom", createdAt: 0 };
    const wire = [
      { ...base, status: "reading" as const, role: "asked" as const, targetHandle: "jimmy" },
      { ...base, status: "answered" as const, role: "asked" as const, targetHandle: "mira" },
      { ...base, status: "reading" as const, role: "answered" as const, targetHandle: "tom" },
    ];
    expect([...relayingTo(wire as unknown as Parameters<typeof relayingTo>[0])]).toEqual(["jimmy"]);
  });
});

describe("the app's settings", function () {
  test("the auto-open and auto-update switches write the settings file and come back in the state", async function () {
    const saved = process.env.SOOPDOOP_HOME;
    const settingsFile = await tempFile("settings.json");
    // Update state is read from SOOPDOOP_HOME; keep it out of the real ~/.soopdoop.
    process.env.SOOPDOOP_HOME = path.dirname(settingsFile);
    try {
      const agent = createAgent({
        railOrigin: "http://127.0.0.1:47312",
        convexUrl: "https://x.convex.cloud",
        version: "0.1.0",
        canUpdate: false,
        configFile: path.join(path.dirname(settingsFile), "config.json"),
        settingsFile,
      }, async function () { /* no browser */ });
      await agent.act("setAutoOpen", { on: false });
      expect(agent.state().local?.autoOpen).toBe(false);
      await agent.act("setAutoUpdate", { on: false });
      expect(await readSettings(settingsFile)).toEqual({ autoUpdate: false, autoOpen: false, ledgerLines: true, scout: false, handoffDailyUsd: 10 });
      expect(agent.state().local).toMatchObject({ autoUpdate: false, autoOpen: false });
      await expect(agent.act("setAutoOpen", { on: "no" })).rejects.toThrow("Missing on.");
    } finally {
      if (saved === undefined) delete process.env.SOOPDOOP_HOME;
      else process.env.SOOPDOOP_HOME = saved;
    }
  });
});

describe("the app's Superset session", function () {
  test("is kept owner-only and can be cleared", async function () {
    const file = await tempFile("session.json");
    await saveSession({ idToken: "i", accessToken: "a", refreshToken: "r", expiresAt: 1 }, file);
    expect(await readSession(file)).toEqual({ idToken: "i", accessToken: "a", refreshToken: "r", expiresAt: 1 });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await saveSession(null, file);
    expect(await readSession(file)).toBeNull();
  });

  test("hands Convex a fresh ID token, refreshing near expiry, and signs out only when nothing is left", async function () {
    const file = await tempFile("session.json");
    let calls = 0;
    async function superset(url: string, init: RequestInit): Promise<Response> {
      calls += 1;
      expect(String(init.body)).toContain("grant_type=refresh_token");
      return Response.json({ access_token: "a2", id_token: jwt(Date.now() + 3_600_000, "fresh"), refresh_token: "r2" });
    }
    const good = jwt(Date.now() + 3_600_000, "good");
    await saveSession({ idToken: good, accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000 }, file);
    expect(await idToken(false, file, superset)).toBe(good);
    expect(calls).toBe(0);

    await saveSession({ idToken: "old", accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 10_000 }, file);
    expect(await idToken(false, file, superset)).toContain(".");
    expect(calls).toBe(1);
    expect((await readSession(file))?.refreshToken).toBe("r2");

    async function refused(): Promise<Response> {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    await saveSession({ idToken: "old", accessToken: "a", refreshToken: "r", expiresAt: Date.now() - 1 }, file);
    expect(await idToken(false, file, refused)).toBeNull();
    expect(await readSession(file)).toBeNull();
  });

  test("signs in through Superset's page and a loopback callback on 47313", async function () {
    const file = await tempFile("session.json");
    let landed = "";
    // The "browser": follows Superset's consent straight back to the redirect with a code.
    async function browser(url: string): Promise<void> {
      const authorize = new URL(url);
      expect(authorize.searchParams.get("redirect_uri")).toBe(CALLBACK_URI);
      expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
      const back = new URL(CALLBACK_URI);
      back.searchParams.set("code", "c1");
      back.searchParams.set("state", authorize.searchParams.get("state") ?? "");
      back.searchParams.set("iss", "https://api.superset.sh");
      landed = await (await fetch(back)).text();
    }
    async function superset(url: string, init: RequestInit): Promise<Response> {
      const form = new URLSearchParams(String(init.body));
      expect(form.get("grant_type")).toBe("authorization_code");
      expect(form.get("code")).toBe("c1");
      expect(form.get("redirect_uri")).toBe(CALLBACK_URI);
      expect(form.get("code_verifier")?.length).toBeGreaterThan(40);
      return Response.json({ access_token: "a", id_token: jwt(Date.now() + 3_600_000, "me"), refresh_token: "r" });
    }
    const session = await signIn(browser, file, superset);
    expect(session.refreshToken).toBe("r");
    expect(landed).toContain("Signed in");
    expect((await readSession(file))?.accessToken).toBe("a");
  });
});

// The backend's types list each optional field as present but undefined; the JSON the app gets leaves it out. This
// makes those fields optional again, all the way down, so a sample can leave them out and is still checked field by
// field against the Convex function's own type.
type Sample<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends (infer E)[]
    ? Sample<E>[]
    : { [K in keyof T as undefined extends T[K] ? never : K]: Sample<T[K]> } & { [K in keyof T as undefined extends T[K] ? K : never]?: Sample<T[K]> };

// What the backend sends, in its exact shapes. Made-up people throughout.
const CONVEX = "https://example-crew-1.convex.cloud";
type Note = Sample<FunctionReturnType<typeof api.notes.list>["live"][number]>;
const ME: Sample<NonNullable<FunctionReturnType<typeof api.hackers.me>>> = {
  _id: "k_tom" as Id<"hackers">,
  handle: "tom",
  shareWorkspaceNames: true,
  shareAgentNames: true,
  hideFromBoards: false,
};
const CREW: Sample<NonNullable<FunctionReturnType<typeof api.crews.mine>>> = {
  _id: "c_1" as Id<"crews">,
  name: "Night shift",
  plan: "team",
  leaderHandle: "tom",
  iAmLeader: true,
  digestHour: 9,
  timezone: "Europe/Paris",
  slackConnected: true,
  slackMirror: false,
  slackPostedAt: 1_760_000_000_000,
  intercomConnected: false,
  intercomWebhookUrl: "https://example-crew-1.convex.site/intercom/webhook?crew=c_1",
  trustedNotePosters: ["grace"],
  members: [
    { handle: "tom", role: "leader", joinedAt: 1 },
    { handle: "grace", name: "Grace Hopper", role: "member", joinedAt: 2 },
    { handle: "jimmy", name: "Jimmy", role: "member", joinedAt: 3 },
  ],
};
const NUMBERS: Sample<FunctionReturnType<typeof api.crews.numbers>> = { answered: 41, tokensSaved: 380_000, handoffs: 2, headsups: 5, ships: 3, walkthroughs: 1, days: 7 };
const COSTS: Sample<FunctionReturnType<typeof api.crews.costs>> = { month: "2026-10", operatorUsd: 1.25, digestUsd: 0.4 };
const LINE: Sample<FunctionReturnType<typeof api.ledger.mine>[number]> = {
  _id: "l_1" as Id<"ledger">,
  at: 1_760_000_000_000,
  harness: "claude-code",
  machineName: "mbp16",
  sessionKey: "s_1",
  workspace: "shop",
  branch: "tom/coupons",
  did: "Fixed the coupon rounding in checkout",
  areas: ["checkout"],
  files: 3,
  pr: "https://github.com/example/shop/pull/7",
  shipped: true,
};
function note(over: Partial<Note>): Note {
  return {
    _id: "n_1" as Id<"notes">,
    text: "Use the staging Stripe keys in previews",
    tags: ["payments"],
    authorHandle: "grace",
    authorName: "Grace Hopper",
    status: "live",
    proposedByAgent: false,
    createdAt: 1,
    updatedAt: 1,
    nudge: false,
    stale: false,
    ...over,
  };
}
const NOTES: Sample<FunctionReturnType<typeof api.notes.list>> = {
  live: [note({})],
  proposed: [note({ _id: "n_2" as Id<"notes">, status: "proposed", proposedByAgent: true, authorHandle: "tom", text: "Run bun test before pushing" })],
  retired: [note({ _id: "n_3" as Id<"notes">, status: "retired", retiredAt: 5 })],
};
const HANDOFFS: Sample<FunctionReturnType<typeof api.handoffs.mine>> = {
  incoming: [{
    _id: "h_1" as Id<"handoffs">,
    fromHandle: "jimmy",
    fromName: "Jimmy",
    text: "Add a test for the coupon rounding",
    why: "Your agent wrote it",
    targetAgentId: "a_1",
    targetAgentName: "checkout",
    targetMachine: "mbp16",
    status: "offered",
    createdAt: 1,
    expiresAt: 2,
    via: "hud",
  }],
  outgoing: [{
    _id: "h_2" as Id<"handoffs">,
    toHandle: "grace",
    text: "Review the pricing page copy",
    status: "done",
    summary: "Reviewed it and fixed two typos",
    links: ["https://github.com/example/shop/pull/8"],
    createdAt: 1,
    decidedAt: 2,
    finishedAt: 3,
    targetAgentName: "site",
  }],
};
const CONSENTS: Sample<FunctionReturnType<typeof api.handoffs.consents>> = [{ handle: "grace", name: "Grace Hopper", mode: "auto" }, { handle: "jimmy", mode: "ask" }];
const HEADSUPS: Sample<FunctionReturnType<typeof api.headsups.cards>> = [{
  _id: "u_1" as Id<"headsups">,
  otherHandle: "jimmy",
  otherName: "Jimmy",
  otherAgentId: "a_9",
  otherAgentName: "email-metrics",
  kind: "area",
  line: "@jimmy's agent is on packages/email now",
  at: 1,
  expiresAt: 2,
}];
const DIGEST: Sample<FunctionReturnType<typeof api.digests.latest>> = {
  daily: { _id: "d_1" as Id<"digests">, day: "2026-10-17", text: "Yesterday in Night shift: 3 ships and 2 hand-offs.", writtenAt: 1, postedAt: 2 },
  weekly: null,
};
const FEED: Sample<FunctionReturnType<typeof api.feed.recent>> = [{
  _id: "f_1" as Id<"feed">,
  kind: "ship",
  handle: "grace",
  me: false,
  otherMe: false,
  text: "Shipped the new pricing page",
  url: "https://github.com/example/shop/pull/9",
  ledgerId: "l_9" as Id<"ledger">,
  at: 1,
}];
const GRACE: Sample<FunctionReturnType<typeof api.friends.list>[number]> = {
  hackerId: "k_grace" as Id<"hackers">,
  handle: "grace",
  led: "g",
  inFocus: false,
  agentCount: 2,
  summary: "shop@grace/pricing · \"tidy the pricing page\"",
  lastSeenAt: 1_760_000_000_000,
};
const FRIENDS: Sample<FunctionReturnType<typeof api.friends.list>> = [GRACE];

interface Call {
  name: string;
  args: unknown;
}

// A stand-in for the Convex client: it signs in at once, keeps each subscription so a test can push the backend's
// answers, and records every mutation and action, answering from `answers` (an Error there is thrown).
function fakeBackend() {
  const subscriptions = new Map<string, (value: unknown) => unknown>();
  const calls: Call[] = [];
  const answers = new Map<string, unknown>();
  async function call(fn: FunctionReference<"mutation" | "action">, args: unknown): Promise<unknown> {
    const name = getFunctionName(fn);
    calls.push({ name, args });
    const answer = answers.get(name);
    if (answer instanceof Error) throw answer;
    return answer ?? null;
  }
  const client = {
    setAuth(_fetchToken: unknown, onChange: (authenticated: boolean) => void): void {
      onChange(true);
    },
    onUpdate(query: FunctionReference<"query">, _args: unknown, callback: (value: unknown) => unknown): () => void {
      const name = getFunctionName(query);
      subscriptions.set(name, callback);
      return function () { subscriptions.delete(name); };
    },
    mutation: call,
    action: call,
    async close(): Promise<void> { /* nothing to close */ },
  };
  return {
    client: client as unknown as ConvexClient,
    calls,
    answers,
    followed(): string[] {
      return [...subscriptions.keys()].sort();
    },
    push<Q extends FunctionReference<"query">>(query: Q, value: Sample<FunctionReturnType<Q>>): void {
      const callback = subscriptions.get(getFunctionName(query));
      if (callback === undefined) throw new Error(`nothing follows ${getFunctionName(query)}`);
      callback(value);
    },
    last(): Call | undefined {
      return calls[calls.length - 1];
    },
  };
}
type Backend = ReturnType<typeof fakeBackend>;

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("the crew in the app's state and actions", function () {
  const savedHome = process.env.SOOPDOOP_HOME;
  const savedPort = process.env.SOOPDOOP_PORT;
  let home = "";
  const running: Agent[] = [];
  beforeAll(async function () {
    // Sessions, settings, update state and the invite file live in SOOPDOOP_HOME; keep them out of the real ~/.soopdoop.
    home = await mkdtemp(path.join(tmpdir(), "soopdoop-crew-"));
    dirs.push(home);
    process.env.SOOPDOOP_HOME = home;
  });
  afterEach(function () {
    for (const agent of running.splice(0)) agent.stop();
  });
  afterAll(function () {
    restoreEnv("SOOPDOOP_HOME", savedHome);
    restoreEnv("SOOPDOOP_PORT", savedPort);
  });

  // A signed-in agent on a Mac already paired with this deployment, over the stand-in backend. No handle yet.
  async function connected(): Promise<{ agent: Agent; backend: Backend; opened: string[]; settingsFile: string }> {
    const backend = fakeBackend();
    const opened: string[] = [];
    const mac = await mkdtemp(path.join(home, "mac-"));
    const configFile = path.join(mac, "config.json");
    const settingsFile = path.join(mac, "settings.json");
    await writeConfig({ convexUrl: CONVEX, token: "sd_" + "0123456789abcdef".repeat(2), privateDirs: [] }, configFile);
    await saveSession({ idToken: "i", accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000 });
    const agent = createAgent(
      { railOrigin: "http://127.0.0.1:47312", convexUrl: CONVEX, version: "0.1.0", canUpdate: false, configFile, settingsFile },
      async function (url) { opened.push(url); },
      function (url) {
        expect(url).toBe(CONVEX);
        return backend.client;
      },
    );
    running.push(agent);
    await agent.start();
    return { agent, backend, opened, settingsFile };
  }

  // The same, with a handle: everything is followed.
  async function ready(): Promise<{ agent: Agent; backend: Backend; opened: string[]; settingsFile: string }> {
    const made = await connected();
    made.backend.push(api.hackers.me, ME);
    return made;
  }

  test("starts empty, and follows the crew's queries once there is a handle", async function () {
    const { agent, backend } = await connected();
    expect(agent.state()).toMatchObject({
      phase: "connecting",
      crewInfo: null,
      numbers: null,
      costs: null,
      ledger: [],
      notes: { live: [], proposed: [], retired: [] },
      handoffs: { incoming: [], outgoing: [] },
      consents: [],
      headsups: [],
      digest: { daily: null, weekly: null },
    });
    expect(backend.followed()).toEqual(["hackers:me"]);
    // No handle yet: nothing else is followed, nothing is sent.
    backend.push(api.hackers.me, null);
    expect(agent.state().phase).toBe("needs-handle");
    expect(backend.followed()).toEqual(["hackers:me"]);
    expect(backend.calls).toEqual([]);

    backend.push(api.hackers.me, ME);
    expect(agent.state().phase).toBe("ready");
    expect(backend.followed()).toEqual(expect.arrayContaining([
      "crews:mine", "crews:numbers", "crews:costs", "ledger:mine", "notes:list", "handoffs:mine", "handoffs:consents",
      "headsups:cards", "digests:latest", "friends:list", "feed:recent", "operator:log",
    ]));
    backend.push(api.crews.mine, CREW);
    backend.push(api.crews.numbers, NUMBERS);
    backend.push(api.crews.costs, COSTS);
    backend.push(api.ledger.mine, [LINE]);
    backend.push(api.notes.list, NOTES);
    backend.push(api.handoffs.mine, HANDOFFS);
    backend.push(api.handoffs.consents, CONSENTS);
    backend.push(api.headsups.cards, HEADSUPS);
    backend.push(api.digests.latest, DIGEST);
    backend.push(api.feed.recent, FEED);
    expect(agent.state()).toMatchObject({
      crewInfo: CREW,
      numbers: NUMBERS,
      costs: COSTS,
      ledger: [LINE],
      notes: NOTES,
      handoffs: HANDOFFS,
      consents: CONSENTS,
      headsups: HEADSUPS,
      digest: DIGEST,
      feed: FEED,
    });
    // A crewmate's row says what their newest open agent is on and when one of their machines last reported.
    backend.push(api.friends.list, FRIENDS);
    expect(agent.state().crew).toEqual([{ ...GRACE, relaying: false }]);
    expect(agent.state().crew[0]).toMatchObject({ summary: "shop@grace/pricing · \"tidy the pricing page\"", lastSeenAt: 1_760_000_000_000 });
    // Leaving the crew: back to none.
    backend.push(api.crews.mine, null);
    expect(agent.state().crewInfo).toBeNull();
  });

  test("tells the backend the Mac's time zone once per start, after the handle, and shrugs off a refusal", async function () {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const { backend } = await ready();
    expect(backend.calls.filter(function (c) { return c.name === "hackers:setTimezone"; })).toEqual([{ name: "hackers:setTimezone", args: { timezone: zone } }]);
    backend.push(api.hackers.me, ME);
    backend.push(api.hackers.me, { ...ME, focusUntil: 5 });
    expect(backend.calls.filter(function (c) { return c.name === "hackers:setTimezone"; })).toHaveLength(1);

    const other = await connected();
    other.backend.answers.set("hackers:setTimezone", new Error("That is not a time zone soopdoop knows."));
    other.backend.push(api.hackers.me, ME);
    await Bun.sleep(10);
    expect(other.agent.state().phase).toBe("ready");
    expect(other.backend.calls.map(function (c) { return c.name; })).toEqual(["hackers:setTimezone"]);
  });

  test("the app gets one state for a burst of changes", async function () {
    const { agent, backend } = await ready();
    await Bun.sleep(60);
    const seen: AppState[] = [];
    agent.subscribe(function (s) { seen.push(s); });
    backend.push(api.crews.mine, CREW);
    backend.push(api.ledger.mine, [LINE]);
    backend.push(api.headsups.cards, HEADSUPS);
    await Bun.sleep(60);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ crewInfo: CREW, ledger: [LINE], headsups: HEADSUPS });
  });

  test("signing out empties the crew's part of the state and stops following", async function () {
    const { agent, backend } = await ready();
    backend.push(api.crews.mine, CREW);
    backend.push(api.ledger.mine, [LINE]);
    backend.push(api.notes.list, NOTES);
    backend.push(api.handoffs.mine, HANDOFFS);
    backend.push(api.friends.list, FRIENDS);
    await agent.act("signOut", {});
    expect(agent.state()).toMatchObject({
      phase: "signed-out",
      crew: [],
      crewInfo: null,
      numbers: null,
      ledger: [],
      notes: { live: [], proposed: [], retired: [] },
      handoffs: { incoming: [], outgoing: [] },
      digest: { daily: null, weekly: null },
    });
    expect(backend.followed()).toEqual([]);
    await expect(agent.act("createCrew", { name: "Night shift" })).rejects.toThrow("Sign in first.");
  });

  test("crew actions go to the crew's functions, checked and trimmed", async function () {
    const { agent, backend } = await ready();
    backend.push(api.crews.mine, CREW);
    backend.answers.set("crews:create", "c_2");
    expect(await agent.act("createCrew", { name: "  Night shift " })).toBe("c_2");
    expect(backend.last()).toEqual({ name: "crews:create", args: { name: "Night shift" } });
    await agent.act("renameCrew", { name: "Day shift" });
    expect(backend.last()).toEqual({ name: "crews:rename", args: { name: "Day shift" } });
    await agent.act("setDigest", { digestHour: 17, timezone: "America/Toronto" });
    expect(backend.last()).toEqual({ name: "crews:setDigest", args: { digestHour: 17, timezone: "America/Toronto" } });
    // Only the hour: the crew keeps its time zone.
    await agent.act("setDigest", { digestHour: 8 });
    expect(backend.last()).toEqual({ name: "crews:setDigest", args: { digestHour: 8, timezone: "Europe/Paris" } });
    await agent.act("setSlackWebhook", { webhook: "https://hooks.slack.com/services/T0/B0/xyz", mirror: true });
    expect(backend.last()).toEqual({ name: "crews:setSlack", args: { webhook: "https://hooks.slack.com/services/T0/B0/xyz", mirror: true } });
    // The app never sees the webhook again: an empty box changes only the mirror, and null takes the webhook off.
    await agent.act("setSlackWebhook", { webhook: "", mirror: false });
    expect(backend.last()).toEqual({ name: "crews:setSlack", args: { mirror: false } });
    await agent.act("setSlackWebhook", { webhook: null, mirror: false });
    expect(backend.last()).toEqual({ name: "crews:setSlack", args: { webhook: null, mirror: false } });
    await agent.act("testSlack", undefined);
    expect(backend.last()).toEqual({ name: "crews:testSlack", args: {} });
    await agent.act("setIntercom", { token: " tok_1 ", secret: null });
    expect(backend.last()).toEqual({ name: "crews:setIntercom", args: { token: "tok_1", secret: null } });
    await agent.act("setIntercom", { secret: "  " });
    expect(backend.last()).toEqual({ name: "crews:setIntercom", args: {} });
    await agent.act("addToCrew", { handle: "@sam" });
    expect(backend.last()).toEqual({ name: "crews:add", args: { handle: "sam" } });
    await agent.act("removeFromCrew", { handle: "jimmy" });
    expect(backend.last()).toEqual({ name: "crews:remove", args: { handle: "jimmy" } });
    await agent.act("handLeadership", { handle: "grace" });
    expect(backend.last()).toEqual({ name: "crews:handLeadership", args: { handle: "grace" } });
    await agent.act("leaveCrew", {});
    expect(backend.last()).toEqual({ name: "crews:leave", args: {} });
    await agent.act("setTrustedNotePosters", { handles: ["@grace", "jimmy", " ", 7] });
    expect(backend.last()).toEqual({ name: "crews:setTrustedNotePosters", args: { handles: ["grace", "jimmy"] } });
    await agent.act("setTrustedNotePosters", { handles: [] });
    expect(backend.last()).toEqual({ name: "crews:setTrustedNotePosters", args: { handles: [] } });

    const sent = backend.calls.length;
    await expect(agent.act("createCrew", {})).rejects.toThrow("Missing name.");
    await expect(agent.act("setDigest", { digestHour: "nine", timezone: "UTC" })).rejects.toThrow("Missing digestHour.");
    await expect(agent.act("addToCrew", { handle: " " })).rejects.toThrow("Missing handle.");
    await expect(agent.act("setTrustedNotePosters", { handles: 3 })).rejects.toThrow("Missing handles.");
    expect(backend.calls.length).toBe(sent);
    // The backend's own words come back as they are.
    backend.answers.set("crews:add", new Error("Add @sam as a friend first."));
    await expect(agent.act("addToCrew", { handle: "sam" })).rejects.toThrow("Add @sam as a friend first.");
  });

  test("ledger actions take only lines on screen", async function () {
    const { agent, backend } = await ready();
    backend.push(api.ledger.mine, [LINE]);
    await agent.act("editLedger", { ledgerId: "l_1", did: " Fixed rounding for coupons " });
    expect(backend.last()).toEqual({ name: "ledger:edit", args: { ledgerId: "l_1", did: "Fixed rounding for coupons" } });
    await agent.act("skipWalkthrough", { ledgerId: "l_1" });
    expect(backend.last()).toEqual({ name: "ledger:markWalkthroughAsked", args: { ledgerId: "l_1" } });
    await agent.act("forgetLedger", { ledgerId: "l_1" });
    expect(backend.last()).toEqual({ name: "ledger:forget", args: { ledgerId: "l_1" } });
    const sent = backend.calls.length;
    await expect(agent.act("editLedger", { ledgerId: "l_2", did: "Something else" })).rejects.toThrow("That ledger line is gone.");
    await expect(agent.act("editLedger", { ledgerId: "l_1" })).rejects.toThrow("Missing did.");
    await expect(agent.act("forgetLedger", {})).rejects.toThrow("Missing ledgerId.");
    expect(backend.calls.length).toBe(sent);
  });

  test("a walkthrough comes from this Mac's daemon, opens for its owner, and marks the line", async function () {
    const { agent, backend, opened } = await ready();
    backend.push(api.ledger.mine, [LINE]);
    const page = path.join(home, "walkthroughs", "l_1.html");
    const asked: { route: string; body: unknown; origin: string | null }[] = [];
    let reply = function (): Response { return Response.json({ path: page }); };
    const daemon = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        asked.push({ route: new URL(req.url).pathname, body: await req.json(), origin: req.headers.get("origin") });
        return reply();
      },
    });
    process.env.SOOPDOOP_PORT = String(daemon.port);
    try {
      expect(await agent.act("makeWalkthrough", { ledgerId: "l_1" })).toBe(pathToFileURL(page).href);
      expect(asked).toEqual([{ route: "/walkthrough", body: { ledgerId: "l_1", sessionKey: "s_1" }, origin: null }]);
      expect(opened).toEqual([pathToFileURL(page).href]);
      expect(backend.last()).toEqual({ name: "ledger:markWalkthroughAsked", args: { ledgerId: "l_1" } });
      expect(backend.calls.some(function (c) { return c.name === "ledger:setWalkthrough"; })).toBe(false);

      // Once the daemon also gives a web link, that goes on the line and the wire.
      reply = function () { return Response.json({ path: page, url: "https://soopdoop.com/d/abc123" }); };
      expect(await agent.act("makeWalkthrough", { ledgerId: "l_1" })).toBe("https://soopdoop.com/d/abc123");
      expect(backend.last()).toEqual({ name: "ledger:setWalkthrough", args: { ledgerId: "l_1", url: "https://soopdoop.com/d/abc123" } });

      // When the daemon cannot, its own words; nothing opens and the line is left alone.
      const sent = backend.calls.length;
      const shownBefore = opened.length;
      reply = function () { return new Response("That session is not on this Mac.", { status: 404 }); };
      await expect(agent.act("makeWalkthrough", { ledgerId: "l_1" })).rejects.toThrow("That session is not on this Mac.");
      reply = function () { return new Response("", { status: 500 }); };
      await expect(agent.act("makeWalkthrough", { ledgerId: "l_1" })).rejects.toThrow("The daemon answered 500.");
      // Only a page on this Mac opens.
      for (const bad of ["relative/l_1.html", "/Applications/Calculator.app", 42]) {
        reply = function () { return Response.json({ path: bad }); };
        await expect(agent.act("makeWalkthrough", { ledgerId: "l_1" })).rejects.toThrow("The daemon did not make a walkthrough.");
      }
      expect(backend.calls.length).toBe(sent);
      expect(opened.length).toBe(shownBefore);
      // A line that is not on screen never reaches the daemon.
      const daemonCalls = asked.length;
      await expect(agent.act("makeWalkthrough", { ledgerId: "l_2" })).rejects.toThrow("That ledger line is gone.");
      expect(asked.length).toBe(daemonCalls);

      // The private switch goes to the same daemon.
      reply = function () { return Response.json({ private: true, folder: "/r/shop" }); };
      expect(await agent.act("setPrivate", { agentId: "a_1", private: true })).toEqual({ private: true, folder: "/r/shop" });
      expect(asked[asked.length - 1]).toEqual({ route: "/private", body: { agentId: "a_1", private: true }, origin: null });
    } finally {
      await daemon.stop(true);
    }
    await expect(agent.act("makeWalkthrough", { ledgerId: "l_1" })).rejects.toThrow("soopdoop's daemon is not answering on this Mac.");
  });

  test("note actions take only notes on screen: live ones, and proposals waiting for me", async function () {
    const { agent, backend } = await ready();
    backend.push(api.notes.list, NOTES);
    backend.answers.set("notes:add", "n_4");
    expect(await agent.act("addNote", {
      text: " Deploys wait for the release script ",
      tags: "release, infra",
      confirmBy: 1_800_000_000_000,
      appliesWhen: "packages/convex",
      replaces: "n_1",
    })).toBe("n_4");
    expect(backend.last()).toEqual({
      name: "notes:add",
      args: { text: "Deploys wait for the release script", tags: ["release", "infra"], confirmBy: 1_800_000_000_000, appliesWhen: "packages/convex", replaces: "n_1" },
    });
    await agent.act("addNote", { text: "Lunch is at noon", tags: ["food", ""] });
    expect(backend.last()).toEqual({ name: "notes:add", args: { text: "Lunch is at noon", tags: ["food"] } });
    // An emptied box or null clears a field; a field left out stays as it is.
    await agent.act("editNote", { noteId: "n_1", text: "Use the test Stripe keys in previews", appliesWhen: "", confirmBy: null });
    expect(backend.last()).toEqual({ name: "notes:edit", args: { noteId: "n_1", text: "Use the test Stripe keys in previews", appliesWhen: null, confirmBy: null } });
    await agent.act("editNote", { noteId: "n_2", tags: [], appliesWhen: "apps/web", confirmBy: 1_800_000_000_000 });
    expect(backend.last()).toEqual({ name: "notes:edit", args: { noteId: "n_2", tags: [], appliesWhen: "apps/web", confirmBy: 1_800_000_000_000 } });
    await agent.act("confirmNote", { noteId: "n_1" });
    expect(backend.last()).toEqual({ name: "notes:confirm", args: { noteId: "n_1" } });
    await agent.act("retireNote", { noteId: "n_2" });
    expect(backend.last()).toEqual({ name: "notes:retire", args: { noteId: "n_2" } });
    await agent.act("approveNote", { noteId: "n_2" });
    expect(backend.last()).toEqual({ name: "notes:approve", args: { noteId: "n_2" } });
    await agent.act("rejectNote", { noteId: "n_2" });
    expect(backend.last()).toEqual({ name: "notes:reject", args: { noteId: "n_2" } });

    const sent = backend.calls.length;
    await expect(agent.act("addNote", { text: "Old news", replaces: "n_3" })).rejects.toThrow("The note it replaces is gone.");
    await expect(agent.act("addNote", { tags: ["food"] })).rejects.toThrow("Missing text.");
    await expect(agent.act("editNote", { noteId: "n_3", text: "Back again" })).rejects.toThrow("That note is gone.");
    await expect(agent.act("editNote", { noteId: "n_1", text: "  " })).rejects.toThrow("Missing text.");
    await expect(agent.act("confirmNote", { noteId: "n_2" })).rejects.toThrow("That note is gone.");
    await expect(agent.act("retireNote", { noteId: "n_9" })).rejects.toThrow("That note is gone.");
    await expect(agent.act("approveNote", { noteId: "n_1" })).rejects.toThrow("That proposal is gone.");
    await expect(agent.act("rejectNote", { noteId: "n_9" })).rejects.toThrow("That proposal is gone.");
    expect(backend.calls.length).toBe(sent);
  });

  test("hand-off actions: offers go out as asked, and answers only to hand-offs offered to me", async function () {
    const { agent, backend } = await ready();
    backend.push(api.handoffs.mine, HANDOFFS);
    backend.answers.set("handoffs:offer", "h_3");
    expect(await agent.act("offerHandoff", { toHandle: "@jimmy", text: " Add the missing test ", why: "Your agent wrote it", targetAgentId: "a_9", via: "headsup" })).toBe("h_3");
    expect(backend.last()).toEqual({
      name: "handoffs:offer",
      args: { toHandle: "jimmy", text: "Add the missing test", why: "Your agent wrote it", targetAgentId: "a_9", via: "headsup" },
    });
    await agent.act("offerHandoff", { toHandle: "grace", text: "Review the copy", via: "menu" });
    expect(backend.last()).toEqual({ name: "handoffs:offer", args: { toHandle: "grace", text: "Review the copy", via: "menu" } });
    // Anywhere else counts as the HUD.
    await agent.act("offerHandoff", { toHandle: "grace", text: "Review the copy", via: "carrier pigeon" });
    expect(backend.last()).toEqual({ name: "handoffs:offer", args: { toHandle: "grace", text: "Review the copy", via: "hud" } });
    await agent.act("decideHandoff", { handoffId: "h_1", outcome: "accept", targetAgentId: "a_2", targetMachine: "mbp16", note: "On it" });
    expect(backend.last()).toEqual({
      name: "handoffs:decide",
      args: { handoffId: "h_1", outcome: "accept", targetAgentId: "a_2", targetMachine: "mbp16", note: "On it" },
    });
    await agent.act("decideHandoff", { handoffId: "h_1", outcome: "decline" });
    expect(backend.last()).toEqual({ name: "handoffs:decide", args: { handoffId: "h_1", outcome: "decline" } });
    await agent.act("setConsent", { handle: "@grace", mode: "never" });
    expect(backend.last()).toEqual({ name: "handoffs:setConsent", args: { handle: "grace", mode: "never" } });

    const sent = backend.calls.length;
    await expect(agent.act("decideHandoff", { handoffId: "h_2", outcome: "accept" })).rejects.toThrow("That hand-off is gone.");
    await expect(agent.act("decideHandoff", { handoffId: "h_1", outcome: "maybe" })).rejects.toThrow("Missing outcome.");
    await expect(agent.act("offerHandoff", { toHandle: "jimmy" })).rejects.toThrow("Missing text.");
    await expect(agent.act("offerHandoff", { text: "Do the thing" })).rejects.toThrow("Missing toHandle.");
    await expect(agent.act("setConsent", { handle: "grace", mode: "sometimes" })).rejects.toThrow("Missing mode.");
    expect(backend.calls.length).toBe(sent);
    backend.answers.set("handoffs:offer", new Error("@jimmy has turned hand-offs from you off."));
    await expect(agent.act("offerHandoff", { toHandle: "jimmy", text: "Add the missing test" })).rejects.toThrow("@jimmy has turned hand-offs from you off.");
  });

  test("heads-ups, shouts and props: ids from the screen only", async function () {
    const { agent, backend } = await ready();
    backend.push(api.headsups.cards, HEADSUPS);
    backend.push(api.feed.recent, FEED);
    await agent.act("dismissHeadsup", { headsupId: "u_1" });
    expect(backend.last()).toEqual({ name: "headsups:dismiss", args: { headsupId: "u_1" } });
    await agent.act("shout", { text: " CI is red, looking " });
    expect(backend.last()).toEqual({ name: "feed:shout", args: { text: "CI is red, looking" } });
    await agent.act("props", { feedId: "f_1" });
    expect(backend.last()).toEqual({ name: "feed:props", args: { feedId: "f_1" } });
    const sent = backend.calls.length;
    await expect(agent.act("dismissHeadsup", { headsupId: "u_2" })).rejects.toThrow("That heads-up is gone.");
    await expect(agent.act("props", { feedId: "f_2" })).rejects.toThrow("That line is no longer on the wire.");
    await expect(agent.act("shout", { text: "   " })).rejects.toThrow("Missing text.");
    expect(backend.calls.length).toBe(sent);
  });

  test("This Mac's switches write the settings file and come back in the state, signed in or not", async function () {
    const settingsFile = path.join(await mkdtemp(path.join(home, "mac-")), "settings.json");
    const agent = createAgent({
      railOrigin: "http://127.0.0.1:47312",
      convexUrl: CONVEX,
      version: "0.1.0",
      canUpdate: false,
      configFile: path.join(path.dirname(settingsFile), "config.json"),
      settingsFile,
    }, async function () { /* no browser */ });
    await agent.act("setLedgerLines", { on: false });
    expect(agent.state().local?.ledgerLines).toBe(false);
    await agent.act("setScout", { on: true });
    await agent.act("setHandoffAllowance", { usd: 2.499 });
    expect(await readSettings(settingsFile)).toEqual({ autoUpdate: true, autoOpen: true, ledgerLines: false, scout: true, handoffDailyUsd: 2.5 });
    expect(agent.state().local).toMatchObject({ ledgerLines: false, scout: true, handoffDailyUsd: 2.5, autoUpdate: true, autoOpen: true });
    await agent.act("setHandoffAllowance", { usd: 0 });
    expect((await readSettings(settingsFile)).handoffDailyUsd).toBe(0);
    await expect(agent.act("setScout", { on: "yes" })).rejects.toThrow("Missing on.");
    await expect(agent.act("setHandoffAllowance", { usd: "5" })).rejects.toThrow("Missing usd.");
    await expect(agent.act("setHandoffAllowance", { usd: -1 })).rejects.toThrow("The hand-off allowance is 0 dollars or more.");
    expect((await readSettings(settingsFile)).handoffDailyUsd).toBe(0);
  });

  test("unknown actions still throw", async function () {
    const { agent } = await ready();
    await expect(agent.act("nope", {})).rejects.toThrow("Unknown action nope.");
  });
});
