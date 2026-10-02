import { describe, expect, test } from "bun:test";
import { authorizeUrl, base64url, codeChallenge, jwtExpiresAt, jwtPayload, randomToken } from "./pkce";

describe("pkce", function () {
  test("base64url has no padding and uses - and _", function () {
    expect(base64url(new Uint8Array([251, 255, 191]))).toBe("-_-_");
    expect(base64url(new Uint8Array([0]))).toBe("AA");
    expect(base64url(new Uint8Array([]))).toBe("");
  });

  test("code challenge matches the RFC 7636 example", async function () {
    expect(await codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("random tokens are long and different", function () {
    const a = randomToken(32);
    const b = randomToken(32);
    expect(a).not.toBe(b);
    expect(a.length).toBe(43);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("authorize url carries every PKCE parameter", function () {
    const url = new URL(authorizeUrl({
      endpoint: "https://api.superset.sh/api/auth/oauth2/authorize",
      clientId: "cid",
      redirectUri: "http://127.0.0.1:47312/",
      scope: "openid profile",
      state: "st",
      codeChallenge: "ch",
    }));
    expect(url.origin + url.pathname).toBe("https://api.superset.sh/api/auth/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:47312/");
    expect(url.searchParams.get("scope")).toBe("openid profile");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("code_challenge")).toBe("ch");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  test("jwt payload and expiry are read without a signature check", function () {
    const payload = { sub: "u1", exp: 1_800_000_000, name: "Tóm" };
    const b64 = function (s: string) { return base64url(new TextEncoder().encode(s)); };
    const jwt = `${b64('{"alg":"RS256"}')}.${b64(JSON.stringify(payload))}.sig`;
    expect(jwtPayload(jwt)).toEqual(payload);
    expect(jwtExpiresAt(jwt)).toBe(1_800_000_000_000);
    expect(jwtPayload("not.a.jwt.at.all")).toBeNull();
    expect(jwtPayload("nope")).toBeNull();
    expect(jwtExpiresAt(`${b64("{}")}.${b64('{"sub":"x"}')}.s`)).toBeNull();
  });
});
