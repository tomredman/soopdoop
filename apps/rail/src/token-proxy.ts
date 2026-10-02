// ABOUTME: Server-side. The rail's local stand-in for Superset's token endpoint, which a browser page cannot call
// ABOUTME: because it sends no CORS headers. Forwards only the two grants the rail uses, with client id and redirect fixed.
import { REDIRECT_URI, SUPERSET_CLIENT_ID, SUPERSET_ISSUER } from "./config";

// From https://api.superset.sh/.well-known/openid-configuration (29 Sep 2026).
export const TOKEN_ENDPOINT = `${SUPERSET_ISSUER}/api/auth/oauth2/token`;

// What the rail page posts to /oauth/token. Tokens travel page → this machine's rail server → Superset, never our cloud.
export type TokenRequest =
  | { grant: "authorization_code"; code: string; codeVerifier: string }
  | { grant: "refresh_token"; refreshToken: string };

type Upstream = (url: string, init: RequestInit) => Promise<Response>;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function filled(x: unknown): x is string {
  return typeof x === "string" && x !== "";
}

export function parseTokenRequest(raw: unknown): TokenRequest | null {
  if (!isRecord(raw)) return null;
  if (raw.grant === "authorization_code" && filled(raw.code) && filled(raw.codeVerifier)) {
    return { grant: "authorization_code", code: raw.code, codeVerifier: raw.codeVerifier };
  }
  if (raw.grant === "refresh_token" && filled(raw.refreshToken)) {
    return { grant: "refresh_token", refreshToken: raw.refreshToken };
  }
  return null;
}

// The form Superset expects. The client id and redirect are ours and fixed, so this cannot be used as an open relay.
export function tokenForm(req: TokenRequest): URLSearchParams {
  const form = new URLSearchParams({ grant_type: req.grant, client_id: SUPERSET_CLIENT_ID });
  if (req.grant === "authorization_code") {
    form.set("code", req.code);
    form.set("code_verifier", req.codeVerifier);
    form.set("redirect_uri", REDIRECT_URI);
  } else {
    form.set("refresh_token", req.refreshToken);
  }
  return form;
}

// Only the rail's own page may use the proxy. Browsers always send Origin on a POST, so no Origin means not our page.
export function originAllowed(origin: string | null, railOrigin: string): boolean {
  return origin === railOrigin;
}

function json(status: number, body: Record<string, string>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

// Handles POST /oauth/token. Passes Superset's status and JSON straight back. Logs nothing: bodies hold tokens.
export async function exchange(req: Request, railOrigin: string, upstream: Upstream = fetch): Promise<Response> {
  if (!originAllowed(req.headers.get("origin"), railOrigin)) {
    return json(403, { error: "forbidden_origin", error_description: "Only the rail's own page may use this." });
  }
  const raw: unknown = await req.json().catch(function () {
    return null;
  });
  const parsed = parseTokenRequest(raw);
  if (parsed === null) {
    return json(400, { error: "invalid_request", error_description: "Expected an authorization_code or refresh_token grant." });
  }
  try {
    const res = await upstream(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: tokenForm(parsed).toString(),
    });
    return new Response(await res.text(), {
      status: res.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch (e) {
    return json(502, { error: "upstream_unreachable", error_description: e instanceof Error ? e.message : String(e) });
  }
}
