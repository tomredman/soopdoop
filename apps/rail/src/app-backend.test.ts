import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSettings } from "@soopdoop/daemon/src/config";
import { createAgent, relayingTo } from "./agent";
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
      expect(await readSettings(settingsFile)).toEqual({ autoUpdate: false, autoOpen: false });
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
