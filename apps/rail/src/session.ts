// ABOUTME: Server-side. The app's sign-in with Superset: a loopback OAuth flow (RFC 8252) on 127.0.0.1:47313, tokens kept
// ABOUTME: in ~/.soopdoop/session.json (owner only) and refreshed here. The browser only shows Superset's consent page.
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { soopdoopHome } from "@soopdoop/daemon/src/config";
import { SCOPES, SUPERSET_CLIENT_ID, SUPERSET_ISSUER } from "./config";
import { authorizeUrl, codeChallenge, randomToken } from "./pkce";
import { parseSession, REFRESH_MARGIN_MS, sessionFromTokens, type Session } from "./tokens";
import { TOKEN_ENDPOINT } from "./token-proxy";

const AUTHORIZE_ENDPOINT = `${SUPERSET_ISSUER}/api/auth/oauth2/authorize`;
// Superset matches loopback redirects without the port (RFC 8252), so the client registered for 127.0.0.1:47312 may
// come back here: a separate port keeps the app's sign-in apart from the web rail page.
export const CALLBACK_PORT = 47313;
export const CALLBACK_URI = `http://127.0.0.1:${CALLBACK_PORT}/`;
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

export function sessionPath(home: string = soopdoopHome()): string {
  return path.join(home, "session.json");
}

export async function readSession(file: string = sessionPath()): Promise<Session | null> {
  try {
    return parseSession(await Bun.file(file).json());
  } catch {
    return null;
  }
}

// The tokens prove who the hacker is, so only the owner may read them. Null signs out.
export async function saveSession(session: Session | null, file: string = sessionPath()): Promise<void> {
  if (session === null) {
    await unlink(file).catch(function () { /* already signed out */ });
    return;
  }
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(session) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

async function postToken(form: URLSearchParams, fetchFn: Fetch): Promise<unknown> {
  const res = await fetchFn(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form.toString(),
  });
  try {
    const raw: unknown = JSON.parse(await res.text());
    return raw;
  } catch {
    throw new Error(`Superset's token endpoint answered ${res.status} with something that is not JSON.`);
  }
}

// A fresh ID token for Convex, refreshing when it is about to run out or Convex asks; null when the sign-in has ended.
// Like the web rail: a forced refresh that fails never signs anyone out while the current ID token is still good.
export async function idToken(forceRefresh: boolean, file: string = sessionPath(), fetchFn: Fetch = fetch): Promise<string | null> {
  const session = await readSession(file);
  if (session === null) return null;
  const fresh = session.expiresAt - Date.now() > REFRESH_MARGIN_MS;
  if (fresh && !forceRefresh) return session.idToken;
  if (session.refreshToken !== null) {
    try {
      const raw = await postToken(new URLSearchParams({ grant_type: "refresh_token", client_id: SUPERSET_CLIENT_ID, refresh_token: session.refreshToken }), fetchFn);
      await saveSession(sessionFromTokens(raw, session), file);
    } catch {
      // Offline, or the refresh token is used up. What is left decides below.
    }
  }
  const latest = await readSession(file);
  if (latest !== null && latest.expiresAt > Date.now()) return latest.idToken;
  await saveSession(null, file);
  return null;
}

function page(title: string, body: string): Response {
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<body style="font:15px -apple-system,system-ui;background:#0a0c10;color:#d5dbe3;display:grid;place-items:center;height:90vh">` +
    `<div><h2 style="font-family:ui-monospace,monospace">soop<span style="color:#a78bfa">doop</span></h2><p>${body}</p></div>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

let running: Promise<Session> | null = null;

// Opens Superset's consent page in the browser and waits for it to come back to 127.0.0.1:47313. One flow at a time.
export function signIn(open: (url: string) => Promise<void>, file: string = sessionPath(), fetchFn: Fetch = fetch): Promise<Session> {
  if (running !== null) return running;
  const flow = (async function (): Promise<Session> {
    const verifier = randomToken(48);
    const state = randomToken(16);
    let settle: (r: { code: string } | { error: string }) => void = function () { /* replaced below */ };
    const result = new Promise<{ code: string } | { error: string }>(function (resolve) { settle = resolve; });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: CALLBACK_PORT,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/") return new Response("Not found", { status: 404 });
        const error = url.searchParams.get("error");
        const code = url.searchParams.get("code");
        const iss = url.searchParams.get("iss");
        if (url.searchParams.get("state") !== state) return page("soopdoop", "This sign-in link is stale. Start again from the soopdoop app.");
        if (error !== null) {
          settle({ error: url.searchParams.get("error_description") ?? error });
          return page("soopdoop", "Sign-in was cancelled. You can close this tab.");
        }
        if (code === null || (iss !== null && iss !== SUPERSET_ISSUER)) {
          settle({ error: "The sign-in did not come back from Superset." });
          return page("soopdoop", "Something went wrong. Try again from the soopdoop app.");
        }
        settle({ code });
        return page("soopdoop · signed in", "Signed in. You can close this tab and go back to Superset.");
      },
    });
    const timer = setTimeout(function () { settle({ error: "Sign-in timed out. Try again." }); }, SIGN_IN_TIMEOUT_MS);
    try {
      await open(authorizeUrl({
        endpoint: AUTHORIZE_ENDPOINT,
        clientId: SUPERSET_CLIENT_ID,
        redirectUri: CALLBACK_URI,
        scope: SCOPES,
        state,
        codeChallenge: await codeChallenge(verifier),
      }));
      const back = await result;
      if ("error" in back) throw new Error(back.error);
      const raw = await postToken(new URLSearchParams({
        grant_type: "authorization_code",
        client_id: SUPERSET_CLIENT_ID,
        code: back.code,
        code_verifier: verifier,
        redirect_uri: CALLBACK_URI,
      }), fetchFn);
      const session = sessionFromTokens(raw, null);
      await saveSession(session, file);
      return session;
    } finally {
      clearTimeout(timer);
      // Let the browser get its "signed in" page before the port closes.
      setTimeout(function () { void server.stop(); }, 1_000);
    }
  })();
  running = flow;
  void flow.finally(function () { running = null; }).catch(function () { /* the caller handles the error */ });
  return flow;
}
