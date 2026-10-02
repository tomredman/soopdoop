// ABOUTME: Superset token responses turned into sessions, for both sign-ins: the web rail's (in the browser) and the app's
// ABOUTME: (in the rail server). Pure, so the rules (an ID token is required; a refresh may keep the old one) live once.
import { jwtExpiresAt } from "./pkce";

export interface Session {
  idToken: string;
  accessToken: string;
  refreshToken: string | null;
  // When the ID token stops being valid, in ms. Convex checks the ID token, so this is the expiry that matters.
  expiresAt: number;
}

// Refresh this long before the ID token runs out.
export const REFRESH_MARGIN_MS = 60_000;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function parseSession(raw: unknown): Session | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.idToken !== "string" || typeof raw.accessToken !== "string" || typeof raw.expiresAt !== "number") return null;
  return {
    idToken: raw.idToken,
    accessToken: raw.accessToken,
    refreshToken: typeof raw.refreshToken === "string" ? raw.refreshToken : null,
    expiresAt: raw.expiresAt,
  };
}

// Turns a token response into a session, or throws a plain message.
// On a refresh Superset may send no new ID token; then the old one is kept until it runs out.
export function sessionFromTokens(raw: unknown, previous: Session | null): Session {
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
  if (previous === null) throw new Error("Superset sent no ID token. soopdoop needs the openid scope to prove who you are.");
  return { idToken: previous.idToken, accessToken, refreshToken, expiresAt: previous.expiresAt };
}
