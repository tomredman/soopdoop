// ABOUTME: Small, dependency-free pieces of OAuth 2.1 with PKCE and JWT reading, used by the Superset sign-in.
// ABOUTME: Pure functions so the sign-in math is testable without a browser.

export function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(byteLength: number = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export interface AuthorizeParams {
  endpoint: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
}

export function authorizeUrl(p: AuthorizeParams): string {
  const url = new URL(p.endpoint);
  url.searchParams.set("client_id", p.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", p.redirectUri);
  url.searchParams.set("scope", p.scope);
  url.searchParams.set("state", p.state);
  url.searchParams.set("code_challenge", p.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// Reads a JWT's payload without checking the signature. Convex checks signatures; the rail only needs `exp`.
export function jwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  const b64 = parts[1];
  if (parts.length !== 3 || b64 === undefined) return null;
  try {
    const std = b64.replace(/-/g, "+").replace(/_/g, "/");
    const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), function (c) {
      return c.charCodeAt(0);
    });
    const json: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isRecord(json) ? json : null;
  } catch {
    return null;
  }
}

// Expiry in milliseconds since the epoch, or null when the token has no usable `exp`.
export function jwtExpiresAt(jwt: string): number | null {
  const exp = jwtPayload(jwt)?.exp;
  return typeof exp === "number" ? exp * 1000 : null;
}
