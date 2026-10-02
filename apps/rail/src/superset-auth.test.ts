import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { base64url } from "./pkce";
import { currentSession, fetchIdToken, signOut } from "./superset-auth";

// A Map behind the Storage methods the rail uses. bun has no localStorage of its own.
class MemoryStorage {
  private items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

function jwt(expiresAtMs: number, tag: string): string {
  const part = function (o: unknown) {
    return base64url(new TextEncoder().encode(JSON.stringify(o)));
  };
  return `${part({ alg: "RS256", kid: "k", typ: "JWT" })}.${part({ sub: "u1", iss: "https://api.superset.sh", exp: Math.floor(expiresAtMs / 1000), tag })}.sig`;
}

function seed(session: { idToken: string; accessToken: string; refreshToken: string | null; expiresAt: number }): void {
  localStorage.setItem("soopdoop.session", JSON.stringify(session));
}

const HOUR = 3600_000;
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
let calls: unknown[] = [];

// Makes the token proxy answer with `body`, and records what the rail asked for.
function proxyAnswers(body: unknown, status: number = 200): void {
  fetchSpy.mockImplementation((async function (_url: unknown, init?: RequestInit) {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch);
}

beforeEach(function () {
  Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });
  Object.defineProperty(globalThis, "sessionStorage", { value: new MemoryStorage(), configurable: true });
  calls = [];
  fetchSpy = spyOn(globalThis, "fetch");
  fetchSpy.mockImplementation((async function () {
    throw new Error("unexpected fetch");
  }) as unknown as typeof fetch);
});

afterEach(function () {
  fetchSpy.mockRestore();
});

describe("fetchIdToken", function () {
  test("no session means no token", async function () {
    expect(await fetchIdToken({ forceRefreshToken: false })).toBeNull();
    expect(await fetchIdToken({ forceRefreshToken: true })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("a fresh token is handed over without calling anyone", async function () {
    const idToken = jwt(Date.now() + HOUR, "first");
    seed({ idToken, accessToken: "a", refreshToken: "r1", expiresAt: Date.now() + HOUR });
    expect(await fetchIdToken({ forceRefreshToken: false })).toBe(idToken);
    expect(calls).toHaveLength(0);
  });

  test("a forced call refreshes through the proxy and saves the new tokens", async function () {
    seed({ idToken: jwt(Date.now() + HOUR, "first"), accessToken: "a", refreshToken: "r1", expiresAt: Date.now() + HOUR });
    const next = jwt(Date.now() + 2 * HOUR, "second");
    proxyAnswers({ access_token: "a2", id_token: next, refresh_token: "r2", expires_in: 3600 });
    expect(await fetchIdToken({ forceRefreshToken: true })).toBe(next);
    expect(calls).toEqual([{ grant: "refresh_token", refreshToken: "r1" }]);
    const saved = currentSession();
    expect(saved?.idToken).toBe(next);
    expect(saved?.accessToken).toBe("a2");
    expect(saved?.refreshToken).toBe("r2");
  });

  test("Convex forces a refresh on every page load: many forced calls never sign anyone out", async function () {
    seed({ idToken: jwt(Date.now() + HOUR, "t0"), accessToken: "a", refreshToken: "r", expiresAt: Date.now() + HOUR });
    for (let i = 1; i <= 6; i++) {
      const next = jwt(Date.now() + HOUR + i * 1000, `t${i}`);
      proxyAnswers({ access_token: "a", id_token: next, refresh_token: "r" });
      expect(await fetchIdToken({ forceRefreshToken: true })).toBe(next);
    }
    expect(currentSession()).not.toBeNull();
  });

  test("when a forced refresh fails, a still-good token is kept", async function () {
    const idToken = jwt(Date.now() + HOUR, "first");
    seed({ idToken, accessToken: "a", refreshToken: "r1", expiresAt: Date.now() + HOUR });
    proxyAnswers({ error: "invalid_grant", error_description: "refresh token used" }, 401);
    expect(await fetchIdToken({ forceRefreshToken: true })).toBe(idToken);
    expect(currentSession()?.idToken).toBe(idToken);
  });

  test("a refresh that brings no new ID token keeps the old one and the new refresh token", async function () {
    const idToken = jwt(Date.now() + HOUR, "first");
    seed({ idToken, accessToken: "a", refreshToken: "r1", expiresAt: Date.now() + HOUR });
    proxyAnswers({ access_token: "a2", refresh_token: "r2", expires_in: 3600 });
    expect(await fetchIdToken({ forceRefreshToken: true })).toBe(idToken);
    expect(currentSession()?.accessToken).toBe("a2");
    expect(currentSession()?.refreshToken).toBe("r2");
  });

  test("a token about to expire is refreshed even when not forced", async function () {
    seed({ idToken: jwt(Date.now() + 10_000, "old"), accessToken: "a", refreshToken: "r1", expiresAt: Date.now() + 10_000 });
    const next = jwt(Date.now() + HOUR, "new");
    proxyAnswers({ access_token: "a2", id_token: next });
    expect(await fetchIdToken({ forceRefreshToken: false })).toBe(next);
    expect(currentSession()?.refreshToken).toBe("r1");
  });

  test("an expired token that cannot be refreshed ends the session", async function () {
    seed({ idToken: jwt(Date.now() - 1000, "old"), accessToken: "a", refreshToken: "r1", expiresAt: Date.now() - 1000 });
    proxyAnswers({ error: "invalid_grant" }, 401);
    expect(await fetchIdToken({ forceRefreshToken: false })).toBeNull();
    expect(currentSession()).toBeNull();

    seed({ idToken: jwt(Date.now() - 1000, "old"), accessToken: "a", refreshToken: null, expiresAt: Date.now() - 1000 });
    expect(await fetchIdToken({ forceRefreshToken: true })).toBeNull();
    expect(currentSession()).toBeNull();
  });

  test("the rail's own server being down does not sign anyone out early", async function () {
    const idToken = jwt(Date.now() + HOUR, "first");
    seed({ idToken, accessToken: "a", refreshToken: "r1", expiresAt: Date.now() + HOUR });
    expect(await fetchIdToken({ forceRefreshToken: true })).toBe(idToken);
  });

  test("signOut clears the session", function () {
    seed({ idToken: jwt(Date.now() + HOUR, "x"), accessToken: "a", refreshToken: null, expiresAt: Date.now() + HOUR });
    signOut();
    expect(currentSession()).toBeNull();
  });
});
