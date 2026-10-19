// ABOUTME: soopdoop.com/d/<token>: a thin Cloudflare Worker in front of the backend's drop links. It sends GET and HEAD for
// ABOUTME: /d/<token> on to DROPS_ORIGIN (the Convex deployment's site) and passes the answer back as it came, headers and all.

export interface Env {
  // The Convex deployment's site, for example https://fleet-skunk-723.convex.site (wrangler.jsonc sets it).
  DROPS_ORIGIN?: string;
}

export type Upstream = (url: string, init: RequestInit) => Promise<Response>;

// The shape of every drop link the backend gives out: /d/ and 32 url-safe characters.
const DROP_PATH = /^\/d\/[A-Za-z0-9_-]{32}$/;

function plain(status: number, text: string, extra: Record<string, string> = {}): Response {
  return new Response(text, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extra } });
}

// Only the method and the path go on: no cookies, no query, no other header from the visitor. A redirect (a link-only
// drop, or a big file going on to its storage URL) comes back to the browser as it is; this Worker never follows one.
export async function handle(request: Request, env: Env, upstream: Upstream = fetch): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (!DROP_PATH.test(pathname)) return plain(404, "No such drop.");
  if (request.method !== "GET" && request.method !== "HEAD") return plain(405, "Drops can only be read.", { Allow: "GET, HEAD" });
  const origin = (env.DROPS_ORIGIN ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/\s]+$/.test(origin)) return plain(503, "Drops are not set up here yet.");
  const answer = await upstream(`${origin}${pathname}`, { method: request.method, redirect: "manual" });
  return new Response(answer.body, { status: answer.status, statusText: answer.statusText, headers: answer.headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return await handle(request, env);
  },
};
