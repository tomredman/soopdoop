import { describe, expect, test } from "bun:test";
import { REDIRECT_URI, SUPERSET_CLIENT_ID } from "./config";
import { exchange, originAllowed, parseTokenRequest, TOKEN_ENDPOINT, tokenForm } from "./token-proxy";

const ORIGIN = "http://127.0.0.1:47312";

function post(body: unknown, origin: string | null = ORIGIN): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin !== null) headers.origin = origin;
  return new Request(`${ORIGIN}/oauth/token`, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("token proxy", function () {
  test("reads only the two grants the rail uses", function () {
    expect(parseTokenRequest({ grant: "authorization_code", code: "c", codeVerifier: "v", extra: 1 })).toEqual({ grant: "authorization_code", code: "c", codeVerifier: "v" });
    expect(parseTokenRequest({ grant: "refresh_token", refreshToken: "r" })).toEqual({ grant: "refresh_token", refreshToken: "r" });
    expect(parseTokenRequest({ grant: "authorization_code", code: "c" })).toBeNull();
    expect(parseTokenRequest({ grant: "authorization_code", code: "", codeVerifier: "v" })).toBeNull();
    expect(parseTokenRequest({ grant: "client_credentials", client_secret: "s" })).toBeNull();
    expect(parseTokenRequest("grant=refresh_token")).toBeNull();
    expect(parseTokenRequest(null)).toBeNull();
  });

  test("builds Superset's form with our client id and redirect, whatever the page sent", function () {
    const code = tokenForm({ grant: "authorization_code", code: "c", codeVerifier: "v" });
    expect(Object.fromEntries(code)).toEqual({ grant_type: "authorization_code", client_id: SUPERSET_CLIENT_ID, code: "c", code_verifier: "v", redirect_uri: REDIRECT_URI });
    const refresh = tokenForm({ grant: "refresh_token", refreshToken: "r" });
    expect(Object.fromEntries(refresh)).toEqual({ grant_type: "refresh_token", client_id: SUPERSET_CLIENT_ID, refresh_token: "r" });
  });

  test("only the rail's own origin may use it", function () {
    expect(originAllowed(ORIGIN, ORIGIN)).toBe(true);
    expect(originAllowed("http://localhost:47312", ORIGIN)).toBe(false);
    expect(originAllowed("https://evil.example", ORIGIN)).toBe(false);
    expect(originAllowed(null, ORIGIN)).toBe(false);
  });

  test("forwards a good request and passes Superset's answer straight back", async function () {
    const calls: { url: string; init: RequestInit }[] = [];
    const upstream = async function (url: string, init: RequestInit) {
      calls.push({ url, init });
      return new Response('{"access_token":"a","id_token":"i"}', { status: 200 });
    };
    const res = await exchange(post({ grant: "authorization_code", code: "c", codeVerifier: "v" }), ORIGIN, upstream);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ access_token: "a", id_token: "i" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(TOKEN_ENDPOINT);
    expect(calls[0]?.init.method).toBe("POST");
    expect(String(calls[0]?.init.body)).toContain("code_verifier=v");
    expect(String(calls[0]?.init.body)).toContain(`client_id=${SUPERSET_CLIENT_ID}`);
  });

  test("passes Superset's refusal through with its status", async function () {
    const upstream = async function () {
      return new Response('{"error":"invalid_grant","error_description":"invalid code"}', { status: 401 });
    };
    const res = await exchange(post({ grant: "authorization_code", code: "bad", codeVerifier: "v" }), ORIGIN, upstream);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_grant", error_description: "invalid code" });
  });

  test("refuses other origins and bad bodies without calling Superset", async function () {
    let called = 0;
    const upstream = async function () {
      called += 1;
      return new Response("{}");
    };
    const good = { grant: "refresh_token", refreshToken: "r" };
    expect((await exchange(post(good, "https://evil.example"), ORIGIN, upstream)).status).toBe(403);
    expect((await exchange(post(good, null), ORIGIN, upstream)).status).toBe(403);
    expect((await exchange(post({ grant: "password" }), ORIGIN, upstream)).status).toBe(400);
    const notJson = new Request(`${ORIGIN}/oauth/token`, { method: "POST", headers: { origin: ORIGIN }, body: "grant=refresh_token" });
    expect((await exchange(notJson, ORIGIN, upstream)).status).toBe(400);
    expect(called).toBe(0);
  });

  test("says so when Superset cannot be reached", async function () {
    const upstream = async function (): Promise<Response> {
      throw new Error("getaddrinfo ENOTFOUND");
    };
    const res = await exchange(post({ grant: "refresh_token", refreshToken: "r" }), ORIGIN, upstream);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream_unreachable", error_description: "getaddrinfo ENOTFOUND" });
  });
});
