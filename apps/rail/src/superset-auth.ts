// ABOUTME: Sign in with Superset: OAuth 2.1 authorization code + PKCE against api.superset.sh, no client secret.
// ABOUTME: Keeps the ID, access and refresh tokens in localStorage and hands Convex a fresh ID token on demand.
import { REDIRECT_URI, SCOPES, SUPERSET_CLIENT_ID, SUPERSET_ISSUER } from "./config";
import { authorizeUrl, codeChallenge, jwtExpiresAt, randomToken } from "./pkce";
import type { TokenRequest } from "./token-proxy";

// From https://api.superset.sh/.well-known/openid-configuration (29 Sep 2026).
const AUTHORIZE_ENDPOINT = `${SUPERSET_ISSUER}/api/auth/oauth2/authorize`;
// Superset's token endpoint sends no CORS headers, so a page cannot call it. The rail's own server forwards the call.
const TOKEN_PROXY = "/oauth/token";
const SESSION_KEY = "soopdoop.session";
const FLOW_KEY = "soopdoop.signin";
const REFRESH_MARGIN_MS = 60_000;

export interface Session {
  idToken: string;
  accessToken: string;
  refreshToken: string | null;
  // When the ID token stops being valid, in ms. Convex checks the ID token, so this is the expiry that matters.
  expiresAt: number;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function readJson(storage: Storage, key: string): unknown {
  try {
    const raw = storage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseSession(raw: unknown): Session | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.idToken !== "string" || typeof raw.accessToken !== "string" || typeof raw.expiresAt !== "number") return null;
  return {
    idToken: raw.idToken,
    accessToken: raw.accessToken,
    refreshToken: typeof raw.refreshToken === "string" ? raw.refreshToken : null,
    expiresAt: raw.expiresAt,
  };
}

export function currentSession(): Session | null {
  return parseSession(readJson(localStorage, SESSION_KEY));
}

function saveSession(session: Session | null): void {
  if (session === null) localStorage.removeItem(SESSION_KEY);
  else localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

// Sends the browser to Superset. The verifier and state wait in sessionStorage for the way back.
export async function beginSignIn(): Promise<void> {
  const verifier = randomToken(48);
  const state = randomToken(16);
  sessionStorage.setItem(FLOW_KEY, JSON.stringify({ verifier, state }));
  location.assign(
    authorizeUrl({
      endpoint: AUTHORIZE_ENDPOINT,
      clientId: SUPERSET_CLIENT_ID,
      redirectUri: REDIRECT_URI,
      scope: SCOPES,
      state,
      codeChallenge: await codeChallenge(verifier),
    }),
  );
}

// Turns a token response into a session, or throws a plain message.
// On a refresh Superset may send no new ID token; then the old one is kept until it runs out.
function sessionFromTokens(raw: unknown, previous: Session | null): Session {
  if (!isRecord(raw)) throw new Error("Superset's token response was not an object.");
  if (typeof raw.error === "string") {
    const detail = typeof raw.error_description === "string" ? ` · ${raw.error_description}` : "";
    throw new Error(`Superset refused: ${raw.error}${detail}`);
  }
  const accessToken = raw.access_token;
  if (typeof accessToken !== "string") throw new Error("Superset sent no access token.");
  const refreshToken = typeof raw.refresh_token === "string" ? raw.refresh_token : (previous?.refreshToken ?? null);
  if (typeof raw.id_token === "string") {
    const fromEnvelope = typeof raw.expires_in === "number" ? Date.now() + raw.expires_in * 1000 : Date.now() + 3600_000;
    return { idToken: raw.id_token, accessToken, refreshToken, expiresAt: jwtExpiresAt(raw.id_token) ?? fromEnvelope };
  }
  if (previous === null) throw new Error("Superset sent no ID token. The rail needs the openid scope to prove who you are.");
  return { idToken: previous.idToken, accessToken, refreshToken, expiresAt: previous.expiresAt };
}

async function postToken(body: TokenRequest): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(TOKEN_PROXY, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Could not reach the rail's own server for the token exchange. Is `bun run rail` still running?");
  }
  const text = await res.text();
  try {
    const raw: unknown = JSON.parse(text);
    return raw;
  } catch {
    throw new Error(`The token exchange answered ${res.status} with something that is not JSON.`);
  }
}

// Call once on page load. If the URL carries ?code=&state= from Superset, finishes the sign-in and cleans the URL.
export async function completeSignIn(): Promise<"signed-in" | "no-code" | Error> {
  const url = new URL(location.href);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (code === null || state === null) return "no-code";
  const iss = url.searchParams.get("iss");
  const flow = readJson(sessionStorage, FLOW_KEY);
  sessionStorage.removeItem(FLOW_KEY);
  for (const key of ["code", "state", "iss"]) url.searchParams.delete(key);
  history.replaceState(null, "", url.toString());
  if (!isRecord(flow) || typeof flow.verifier !== "string" || flow.state !== state) {
    return new Error("The sign-in did not come back the way it left. Try again.");
  }
  // Superset names itself on the way back (RFC 9207). Anyone else's code is not ours to redeem.
  if (iss !== null && iss !== SUPERSET_ISSUER) {
    return new Error(`The sign-in came back from ${iss}, not Superset. Try again.`);
  }
  try {
    const raw = await postToken({ grant: "authorization_code", code, codeVerifier: flow.verifier });
    saveSession(sessionFromTokens(raw, null));
    return "signed-in";
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

// Trades the refresh token for new tokens and saves them. Quietly does nothing when that is not possible.
async function refresh(session: Session): Promise<void> {
  if (session.refreshToken === null) return;
  try {
    const raw = await postToken({ grant: "refresh_token", refreshToken: session.refreshToken });
    saveSession(sessionFromTokens(raw, session));
  } catch {
    // Offline, a used-up refresh token, or another tab got there first. The caller decides what is left.
  }
}

// For ConvexClient.setAuth. Returns an ID token Convex can use, or null when the hacker has to sign in again.
// Convex passes forceRefreshToken on every normal page load and before each expiry, not only after a rejection,
// so a forced call must never sign anyone out while the current ID token is still good.
export async function fetchIdToken(opts: { forceRefreshToken: boolean }): Promise<string | null> {
  const session = currentSession();
  if (session === null) return null;
  const fresh = session.expiresAt - Date.now() > REFRESH_MARGIN_MS;
  if (fresh && !opts.forceRefreshToken) return session.idToken;
  await refresh(session);
  // Read again: this tab's refresh may have saved a new session, or another tab's may have.
  const latest = currentSession();
  if (latest !== null && latest.expiresAt > Date.now()) return latest.idToken;
  saveSession(null);
  return null;
}

export function signOut(): void {
  saveSession(null);
  sessionStorage.removeItem(FLOW_KEY);
}
