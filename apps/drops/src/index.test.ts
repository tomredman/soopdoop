// ABOUTME: Tests for the drops Worker against a stand-in origin (Bun.serve): GET and HEAD pass through with the origin's
// ABOUTME: status and headers, redirects come back unfollowed, nothing else of the visitor's goes on, other paths are 404s.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import worker, { handle } from "./index";

const PAGE_TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz012-_9";
const LINK_TOKEN = "linkLINKlinkLINKlinkLINKlink0123";
const GONE_TOKEN = "goneGONEgoneGONEgoneGONEgone0123";
const POLICY = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:";

let server: ReturnType<typeof Bun.serve>;
let originUrl = "";
const seen: { method: string; path: string; search: string; cookie: string | null; referer: string | null }[] = [];

beforeAll(function () {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push({ method: req.method, path: url.pathname, search: url.search, cookie: req.headers.get("cookie"), referer: req.headers.get("referer") });
      if (url.pathname === `/d/${PAGE_TOKEN}`) {
        return new Response("<h1>Before and after</h1>", {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": POLICY,
            "Cache-Control": "private, max-age=300",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
          },
        });
      }
      if (url.pathname === `/d/${LINK_TOKEN}`) {
        return new Response(null, { status: 302, headers: { Location: "https://pages.example.com/ada/quote", "Referrer-Policy": "no-referrer" } });
      }
      return new Response("No such drop.", { status: 404, headers: { "Cache-Control": "no-store" } });
    },
  });
  originUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(function () {
  void server.stop(true);
});

beforeEach(function () {
  seen.length = 0;
});

function visit(path: string, init: RequestInit = {}): Request {
  return new Request(`https://soopdoop.com${path}`, init);
}

describe("the drops Worker", function () {
  test("GET passes the origin's page through with its status and headers", async function () {
    const res = await handle(visit(`/d/${PAGE_TOKEN}`), { DROPS_ORIGIN: originUrl });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>Before and after</h1>");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe(POLICY);
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(seen).toEqual([{ method: "GET", path: `/d/${PAGE_TOKEN}`, search: "", cookie: null, referer: null }]);
  });

  test("HEAD passes through without a body", async function () {
    const res = await handle(visit(`/d/${PAGE_TOKEN}`, { method: "HEAD" }), { DROPS_ORIGIN: originUrl });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe("");
    expect(seen.map(function (s) { return s.method; })).toEqual(["HEAD"]);
  });

  test("a redirect comes back to the browser unfollowed, and a 404 stays a 404", async function () {
    const sent = await handle(visit(`/d/${LINK_TOKEN}`), { DROPS_ORIGIN: originUrl });
    expect(sent.status).toBe(302);
    expect(sent.headers.get("location")).toBe("https://pages.example.com/ada/quote");
    const gone = await handle(visit(`/d/${GONE_TOKEN}`), { DROPS_ORIGIN: originUrl });
    expect(gone.status).toBe(404);
    expect(seen.map(function (s) { return s.path; })).toEqual([`/d/${LINK_TOKEN}`, `/d/${GONE_TOKEN}`]);
  });

  test("nothing of the visitor's goes on: no query, no cookie, no referer", async function () {
    const res = await handle(
      visit(`/d/${PAGE_TOKEN}?utm=made-up`, { headers: { cookie: "session=made-up", referer: "https://example.com/somewhere" } }),
      { DROPS_ORIGIN: `${originUrl}/` },
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ method: "GET", path: `/d/${PAGE_TOKEN}`, search: "", cookie: null, referer: null }]);
  });

  test("other paths are 404s and other methods 405s, and neither reaches the origin", async function () {
    for (const path of ["/", "/d/", "/d/short", `/d/${PAGE_TOKEN}/more`, `/x/${PAGE_TOKEN}`, `/d/${PAGE_TOKEN.slice(1)}!`]) {
      expect((await handle(visit(path), { DROPS_ORIGIN: originUrl })).status).toBe(404);
    }
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await handle(visit(`/d/${PAGE_TOKEN}`, { method, body: method === "DELETE" ? undefined : "x" }), { DROPS_ORIGIN: originUrl });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD");
    }
    expect(seen).toEqual([]);
  });

  test("without an origin it says drops are not set up, and asks nothing", async function () {
    for (const env of [{}, { DROPS_ORIGIN: "" }, { DROPS_ORIGIN: "fleet-skunk-723.convex.site" }]) {
      const res = await handle(visit(`/d/${PAGE_TOKEN}`), env);
      expect(res.status).toBe(503);
    }
    expect(seen).toEqual([]);
  });

  test("the Worker's fetch handler is the same, with the runtime's own fetch", async function () {
    const res = await worker.fetch(visit(`/d/${PAGE_TOKEN}`), { DROPS_ORIGIN: originUrl });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>Before and after</h1>");
  });
});
