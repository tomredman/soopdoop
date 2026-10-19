// ABOUTME: Tests for drops: the team-plan gate, the 5 GB quota, sizes from file storage, walkthroughs on the ledger and the
// ABOUTME: wire, links on any plan, the shelf's scope, forgetting, the crew's end, and what GET and HEAD /d/<token> answer.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { amount, newToken, PAGE_POLICY, SERVE_MAX, siteUrl } from "./drops";
import { befriend, crewIdOf, hackerNamed, harness, type Harness, idOf, invite, must, settleScheduled, teamPlan } from "./testing.helpers";

const SITE = "https://made-up-deployment.convex.site";
const PAGE = "<!doctype html><title>The quote page</title><h1>Before and after</h1><script>document.title += ' (seen)'</script>";
const TARGET = "https://pages.example.com/ada/quote-walkthrough";
const LINK = /^https:\/\/made-up-deployment\.convex\.site\/d\/([A-Za-z0-9_-]{32})$/;

let savedSite: string | undefined;
let savedCloud: string | undefined;

beforeEach(function () {
  savedSite = process.env.CONVEX_SITE_URL;
  savedCloud = process.env.CONVEX_CLOUD_URL;
  process.env.CONVEX_SITE_URL = SITE;
});

afterEach(async function () {
  if (savedSite === undefined) delete process.env.CONVEX_SITE_URL;
  else process.env.CONVEX_SITE_URL = savedSite;
  if (savedCloud === undefined) delete process.env.CONVEX_CLOUD_URL;
  else process.env.CONVEX_CLOUD_URL = savedCloud;
  await settleScheduled();
});

function bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

// Tom leads a crew with Ada in it (an accepted invite starts it), on the team plan unless `free`.
async function crew(t: Harness, plan: "team" | "free" = "team") {
  const tom = await hackerNamed(t, "tom");
  const ada = await hackerNamed(t, "adalovelace");
  await invite(tom, ada);
  const crewId = await crewIdOf(t, "tom");
  if (plan === "team") await teamPlan(t, crewId);
  return { tom, ada, crewId, tomId: await idOf(t, "tom"), adaId: await idOf(t, "adalovelace") };
}

// A file as the upload URL leaves it in file storage.
async function stored(t: Harness, body: string | Uint8Array<ArrayBuffer>, type = "text/html"): Promise<Id<"_storage">> {
  return await t.run(async function (ctx) {
    return await ctx.storage.store(new Blob([body], { type }));
  });
}

async function fileGone(t: Harness, storageId: Id<"_storage">): Promise<boolean> {
  return await t.run(async function (ctx) {
    return (await ctx.db.system.get("_storage", storageId)) === null;
  });
}

// A finished, shipped piece of work on someone's ledger.
async function ledgerLine(t: Harness, hackerId: Id<"hackers">, did: string): Promise<Id<"ledger">> {
  return await t.run(async function (ctx) {
    return await ctx.db.insert("ledger", {
      hackerId,
      at: Date.now(),
      harness: "claude-code",
      machineName: "mbp16",
      sessionKey: `s-${did}`,
      did,
      areas: ["apps/web/quote"],
      files: 14,
      pr: "https://github.com/example/vibes/pull/412",
      shipped: true,
    });
  });
}

async function walkthroughEvents(t: Harness) {
  return await t.run(async function (ctx) {
    return (await ctx.db.query("feed").collect()).filter(function (e) { return e.kind === "walkthrough"; });
  });
}

function pathOf(url: string): string {
  return new URL(url).pathname;
}

describe("drops", function () {
  test("a drop's link is 32 random url-safe characters", function () {
    const tokens = new Set(Array.from({ length: 500 }, newToken));
    expect(tokens.size).toBe(500);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(amount(5e9)).toBe("5 GB");
    expect(amount(1_234_567)).toBe("1.2 MB");
    expect(amount(SERVE_MAX)).toBe("20 MB");
    expect(amount(512)).toBe("512 bytes");
  });

  test("the site comes from CONVEX_SITE_URL, else from the deployment's .convex.cloud URL", function () {
    expect(siteUrl()).toBe(SITE);
    process.env.CONVEX_SITE_URL = `${SITE}/`;
    expect(siteUrl()).toBe(SITE);
    delete process.env.CONVEX_SITE_URL;
    process.env.CONVEX_CLOUD_URL = "https://made-up-deployment.convex.cloud";
    expect(siteUrl()).toBe(SITE);
    process.env.CONVEX_CLOUD_URL = "https://api.example.com";
    expect(siteUrl()).toBeNull();
    delete process.env.CONVEX_CLOUD_URL;
    expect(siteUrl()).toBeNull();
  });

  test("hosting is on the team plan: no upload link on free or outside a crew, and nothing saved there", async function () {
    const t = harness();
    const { tom } = await crew(t, "free");
    const sam = await hackerNamed(t, "sam");
    await expect(tom.mutation(api.drops.uploadUrl, {})).rejects.toThrow("Drops hosting is on the team plan; share a link instead.");
    await expect(sam.mutation(api.drops.uploadUrl, {})).rejects.toThrow("Drops hosting is on the team plan");
    const storageId = await stored(t, PAGE);
    const args = { storageId, title: "Quote page", kind: "page" as const, contentType: "text/html", size: bytes(PAGE) };
    await expect(tom.mutation(api.drops.save, args)).rejects.toThrow("Drops hosting is on the team plan");
    await expect(sam.mutation(api.drops.save, args)).rejects.toThrow("Drops hosting is on the team plan");
    expect(await tom.query(api.drops.usage, {})).toEqual({ used: 0, limit: 0 });
    expect(await sam.query(api.drops.usage, {})).toEqual({ used: 0, limit: 0 });

    await teamPlan(t, await crewIdOf(t, "tom"));
    const url = await tom.mutation(api.drops.uploadUrl, { size: bytes(PAGE), contentType: "text/html;charset=utf-8" });
    expect(url).toStartWith("https://");
  });

  test("a saved page is on the crew's shelf and served at its link with its type, under the no-network policy", async function () {
    const t = harness();
    const { tom, ada } = await crew(t);
    const size = bytes(PAGE);
    const storageId = await stored(t, PAGE);
    const { dropId, url } = await tom.mutation(api.drops.save, { storageId, title: "  The quote page,\n before and after ", kind: "page", contentType: "text/html; charset=utf-8", size });
    expect(url).toMatch(LINK);

    const shelf = await ada.query(api.drops.list, {});
    expect(shelf).toHaveLength(1);
    expect(shelf[0]).toMatchObject({ _id: dropId, title: "The quote page, before and after", kind: "page", url, byHandle: "tom", size, canForget: false });
    expect(must((await tom.query(api.drops.list, {}))[0]).canForget).toBe(true);
    expect(await ada.query(api.drops.usage, {})).toEqual({ used: size, limit: 5e9 });

    const res = await t.fetch(pathOf(url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toBe(PAGE_POLICY);
    expect(PAGE_POLICY).toContain("default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:");
    expect(await res.text()).toBe(PAGE);

    const head = await t.fetch(pathOf(url), { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(size));
    expect(head.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(head.headers.get("content-security-policy")).toBe(PAGE_POLICY);
    expect(await head.text()).toBe("");
  });

  test("unknown and malformed links are 404s", async function () {
    const t = harness();
    for (const path of [`/d/${newToken()}`, "/d/", "/d/short", `/d/${newToken()}/more`, `/d/${newToken().slice(1)}!`]) {
      const res = await t.fetch(path);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect((await t.fetch(`/d/${newToken()}`, { method: "HEAD" })).status).toBe(404);
  });

  test("a file that is not a page has no page policy; a big one goes on to its storage URL; a big page is refused", async function () {
    const t = harness();
    const { tom } = await crew(t);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const small = await tom.mutation(api.drops.save, { storageId: await stored(t, png, "image/png"), title: "Before", kind: "file", contentType: "image/png", size: png.length });
    const res = await t.fetch(pathOf(small.url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);

    const big = new Uint8Array(SERVE_MAX + 1);
    const bigId = await stored(t, big, "application/octet-stream");
    await expect(tom.mutation(api.drops.uploadUrl, { size: big.length, contentType: "text/html" })).rejects.toThrow("A page is at most 20 MB");
    await expect(tom.mutation(api.drops.save, { storageId: bigId, title: "A huge page", kind: "page", contentType: "text/html", size: big.length })).rejects.toThrow("A page is at most 20 MB");
    await expect(tom.mutation(api.drops.save, { storageId: bigId, title: "A huge drawing", kind: "file", contentType: "image/svg+xml", size: big.length })).rejects.toThrow("A page is at most 20 MB");
    const recording = await tom.mutation(api.drops.save, { storageId: bigId, title: "Session recording", kind: "file", contentType: "application/octet-stream", size: big.length });
    const sent = await t.fetch(pathOf(recording.url));
    expect(sent.status).toBe(302);
    expect(sent.headers.get("location")).toStartWith("https://some-deployment.convex.cloud/api/storage/");
    expect((await t.fetch(pathOf(recording.url), { method: "HEAD" })).status).toBe(302);
  });

  test("the quota: the crew's drops plus this one fit in 5 GB, checked before the upload and again at save", async function () {
    const t = harness();
    const { tom, ada, crewId, tomId } = await crew(t);
    await t.run(async function (ctx) {
      await ctx.db.insert("drops", { crewId, hackerId: tomId, title: "Old recordings", kind: "file", token: newToken(), size: 5e9 - 10, contentType: "video/mp4", createdAt: Date.now() - 1000 });
    });
    await expect(ada.mutation(api.drops.uploadUrl, { size: 11 })).rejects.toThrow("That would put the crew over its 5 GB of drops (5 GB used)");
    expect(await ada.mutation(api.drops.uploadUrl, { size: 10 })).toStartWith("https://");

    const eleven = await stored(t, "eleven byte", "text/plain");
    await expect(ada.mutation(api.drops.save, { storageId: eleven, title: "Notes", kind: "file", contentType: "text/plain", size: 11 })).rejects.toThrow("over its 5 GB of drops");
    await ada.mutation(api.drops.save, { storageId: await stored(t, "ten bytes!", "text/plain"), title: "Notes", kind: "file", contentType: "text/plain", size: 10 });
    expect(await tom.query(api.drops.usage, {})).toEqual({ used: 5e9, limit: 5e9 });

    // Another crew's drops are its own.
    const grace = await hackerNamed(t, "grace");
    const jimmy = await hackerNamed(t, "jimmy");
    await invite(grace, jimmy);
    await teamPlan(t, await crewIdOf(t, "grace"));
    expect(await grace.query(api.drops.usage, {})).toEqual({ used: 0, limit: 5e9 });
    expect(await jimmy.mutation(api.drops.uploadUrl, { size: 11 })).toStartWith("https://");
  });

  test("the size is file storage's: a wrong size, a missing upload, a bad type or title are refused", async function () {
    const t = harness();
    const { tom } = await crew(t);
    const storageId = await stored(t, PAGE);
    const size = bytes(PAGE);
    const good = { storageId, title: "Quote page", kind: "page" as const, contentType: "text/html", size };
    await expect(tom.mutation(api.drops.save, { ...good, size: size + 1 })).rejects.toThrow(`That upload is ${size} bytes, not ${size + 1}`);
    await expect(tom.mutation(api.drops.save, { ...good, size: -1 })).rejects.toThrow("whole number of bytes");
    await expect(tom.mutation(api.drops.save, { ...good, contentType: "text/html\r\nX-Made-Up: 1" })).rejects.toThrow("content type");
    await expect(tom.mutation(api.drops.save, { ...good, contentType: "text/html\r\n;charset=utf-8" })).rejects.toThrow("content type");
    await expect(tom.mutation(api.drops.save, { ...good, contentType: 'text/html; charset="utf-8\r\n"' })).rejects.toThrow("content type");
    await expect(tom.mutation(api.drops.save, { ...good, contentType: "" })).rejects.toThrow("content type");
    await expect(tom.mutation(api.drops.save, { ...good, title: "   " })).rejects.toThrow("title is 1 to 200 characters");
    await expect(tom.mutation(api.drops.save, { ...good, title: "x".repeat(201) })).rejects.toThrow("title is 1 to 200 characters");
    await expect(tom.mutation(api.drops.uploadUrl, { size: 1.5 })).rejects.toThrow("whole number of bytes");
    await t.run(async function (ctx) {
      await ctx.storage.delete(storageId);
    });
    await expect(tom.mutation(api.drops.save, good)).rejects.toThrow("That upload is not there");
    expect(await tom.query(api.drops.list, {})).toEqual([]);
  });

  test("saving the same upload again returns the same drop, and nobody else can claim it", async function () {
    const t = harness();
    const { tom, ada } = await crew(t);
    const args = { storageId: await stored(t, PAGE), title: "Quote page", kind: "page" as const, contentType: "text/html", size: bytes(PAGE) };
    const first = await tom.mutation(api.drops.save, args);
    expect(await tom.mutation(api.drops.save, args)).toEqual(first);
    await expect(ada.mutation(api.drops.save, args)).rejects.toThrow("someone else's drop");
    expect(await tom.query(api.drops.list, {})).toHaveLength(1);
  });

  test("a walkthrough drop goes on its ledger line and on the wire, once", async function () {
    const t = harness();
    const { tom, ada, tomId } = await crew(t);
    const lineId = await ledgerLine(t, tomId, "redesigned the quote page; new M09/M10 mocks");
    const first = await tom.mutation(api.drops.save, { storageId: await stored(t, PAGE), title: "Walkthrough: the quote page", kind: "walkthrough", contentType: "text/html", size: bytes(PAGE), ledgerId: lineId });
    expect(must((await tom.query(api.ledger.mine, {}))[0])).toMatchObject({ walkthrough: first.url, walkthroughAsked: true });
    expect(await walkthroughEvents(t)).toMatchObject([{ hackerId: tomId, url: first.url, dropId: first.dropId, ledgerId: lineId, text: "redesigned the quote page; new M09/M10 mocks" }]);
    expect(must((await ada.query(api.feed.recent, {})).find(function (e) { return e.kind === "walkthrough"; }))).toMatchObject({ handle: "tom", url: first.url, dropId: first.dropId });

    // A second one for the same line moves the one event; the app saying the same link again keeps its drop.
    const second = await tom.mutation(api.drops.save, { storageId: await stored(t, `${PAGE}<p>v2</p>`), title: "Walkthrough v2", kind: "walkthrough", contentType: "text/html", size: bytes(`${PAGE}<p>v2</p>`), ledgerId: lineId });
    await tom.mutation(api.ledger.setWalkthrough, { ledgerId: lineId, url: second.url });
    expect(await walkthroughEvents(t)).toMatchObject([{ url: second.url, dropId: second.dropId }]);
    expect(await walkthroughEvents(t)).toHaveLength(1);
    expect(must((await tom.query(api.ledger.mine, {}))[0]).walkthrough).toBe(second.url);

    // A link that is not a drop leaves the drop behind.
    await tom.mutation(api.ledger.setWalkthrough, { ledgerId: lineId, url: "https://pages.example.com/tom/w3" });
    expect(must((await walkthroughEvents(t))[0]).dropId).toBeUndefined();

    // Only my own lines; a page about a line is not a walkthrough.
    await expect(ada.mutation(api.drops.save, { storageId: await stored(t, PAGE), title: "Not mine", kind: "walkthrough", contentType: "text/html", size: bytes(PAGE), ledgerId: lineId })).rejects.toThrow("Not your ledger line");
    const page = await tom.mutation(api.drops.save, { storageId: await stored(t, "<p>notes</p>"), title: "Notes on the ship", kind: "page", contentType: "text/html", size: bytes("<p>notes</p>"), ledgerId: lineId });
    expect(must((await tom.query(api.drops.list, {})).find(function (d) { return d._id === page.dropId; })).ledgerId).toBe(lineId);
    expect(must((await tom.query(api.ledger.mine, {}))[0]).walkthrough).toBe("https://pages.example.com/tom/w3");
  });

  test("a link drop works on any plan, takes https links only, and its link sends the browser on", async function () {
    const t = harness();
    const { tom, tomId } = await crew(t, "free");
    const sam = await hackerNamed(t, "sam");
    const linked = await tom.mutation(api.drops.link, { title: "Quote page walkthrough", url: ` ${TARGET} ` });
    expect(linked.url).toMatch(LINK);
    expect(await sam.mutation(api.drops.link, { title: "A page", url: "https://pages.example.com/sam" })).toMatchObject({ url: expect.stringMatching(LINK) });
    expect(must((await tom.query(api.drops.list, {}))[0])).toMatchObject({ kind: "page", size: 0, byHandle: "tom", url: linked.url });
    expect(await tom.query(api.drops.usage, {})).toEqual({ used: 0, limit: 0 });

    const res = await t.fetch(pathOf(linked.url));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(TARGET);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");

    for (const bad of ["http://pages.example.com/x", "javascript:alert(1)", "ftp://example.com/x", "not a link", "https://pages.example.com/a b"]) {
      await expect(tom.mutation(api.drops.link, { title: "Bad", url: bad })).rejects.toThrow("https://");
    }
    await expect(tom.mutation(api.drops.link, { title: "Bad", url: "https://ada:hunter2@pages.example.com/x" })).rejects.toThrow("user name and password");
    await expect(tom.mutation(api.drops.link, { title: "Bad", url: `https://pages.example.com/${"x".repeat(2000)}` })).rejects.toThrow("at most 2000 characters");

    // With a ledger line it is a walkthrough, unless it says it is a page.
    const lineId = await ledgerLine(t, tomId, "fixed delivery counts double-counting bounces");
    const walk = await tom.mutation(api.drops.link, { title: "Walkthrough: bounces", url: TARGET, ledgerId: lineId });
    expect(must((await tom.query(api.drops.list, {})).find(function (d) { return d._id === walk.dropId; })).kind).toBe("walkthrough");
    expect(must((await tom.query(api.ledger.mine, {}))[0]).walkthrough).toBe(walk.url);
    expect(await walkthroughEvents(t)).toMatchObject([{ url: walk.url, dropId: walk.dropId, ledgerId: lineId }]);
    const notes = await tom.mutation(api.drops.link, { title: "Notes", url: TARGET, ledgerId: lineId, kind: "page" });
    expect(must((await tom.query(api.drops.list, {})).find(function (d) { return d._id === notes.dropId; })).kind).toBe("page");
    expect(must((await tom.query(api.ledger.mine, {}))[0]).walkthrough).toBe(walk.url);
  });

  test("without a site URL nothing is saved", async function () {
    const t = harness();
    const { tom } = await crew(t);
    delete process.env.CONVEX_SITE_URL;
    delete process.env.CONVEX_CLOUD_URL;
    await expect(tom.mutation(api.drops.link, { title: "A page", url: TARGET })).rejects.toThrow("no site URL");
    await expect(tom.mutation(api.drops.save, { storageId: await stored(t, PAGE), title: "A page", kind: "page", contentType: "text/html", size: bytes(PAGE) })).rejects.toThrow("no site URL");
    expect(await tom.query(api.drops.list, {})).toEqual([]);
  });

  test("the shelf is the crew's: another crew never sees it; outside a crew, my friends' links made outside a crew", async function () {
    const t = harness();
    const { tom, ada, crewId, tomId } = await crew(t);
    const grace = await hackerNamed(t, "grace");
    const jimmy = await hackerNamed(t, "jimmy");
    await invite(grace, jimmy);
    await tom.mutation(api.drops.save, { storageId: await stored(t, PAGE), title: "Tom's page", kind: "page", contentType: "text/html", size: bytes(PAGE) });
    await grace.mutation(api.drops.link, { title: "Grace's link", url: TARGET });
    expect((await ada.query(api.drops.list, {})).map(function (d) { return d.title; })).toEqual(["Tom's page"]);
    expect((await jimmy.query(api.drops.list, {})).map(function (d) { return d.title; })).toEqual(["Grace's link"]);

    // Sam and Pat are friends in no crew; Ada is Sam's friend too, but her crew's shelf is not Sam's.
    const sam = await hackerNamed(t, "sam");
    const pat = await hackerNamed(t, "pat");
    await befriend(sam, pat, "pat");
    await befriend(sam, ada, "adalovelace");
    await pat.mutation(api.drops.link, { title: "Pat's link", url: TARGET });
    await sam.mutation(api.drops.link, { title: "Sam's link", url: TARGET });
    expect((await sam.query(api.drops.list, {})).map(function (d) { return d.title; })).toEqual(["Sam's link", "Pat's link"]);
    expect((await ada.query(api.drops.list, {})).map(function (d) { return d.title; })).toEqual(["Tom's page"]);
    expect(must((await sam.query(api.drops.list, {})).find(function (d) { return d.title === "Pat's link"; })).canForget).toBe(false);

    // The newest 100.
    await t.run(async function (ctx) {
      for (let i = 0; i < 105; i++) {
        await ctx.db.insert("drops", { crewId, hackerId: tomId, title: `Link ${i}`, kind: "page", url: TARGET, token: newToken(), size: 0, contentType: "text/uri-list", createdAt: Date.now() + i + 1 });
      }
    });
    const shelf = await ada.query(api.drops.list, {});
    expect(shelf).toHaveLength(100);
    expect(must(shelf[0]).title).toBe("Link 104");
    expect(must(shelf[99]).title).toBe("Link 5");
  });

  test("forgetting a drop deletes its file and its link, and takes its walkthrough off the line and the wire", async function () {
    const t = harness();
    const { tom, ada, tomId } = await crew(t);
    const lineId = await ledgerLine(t, tomId, "redesigned the quote page");
    const storageId = await stored(t, PAGE);
    const walk = await tom.mutation(api.drops.save, { storageId, title: "Walkthrough", kind: "walkthrough", contentType: "text/html", size: bytes(PAGE), ledgerId: lineId });
    await expect(ada.mutation(api.drops.forget, { dropId: walk.dropId })).rejects.toThrow("Only whoever dropped it, or the crew's leader");

    await tom.mutation(api.drops.forget, { dropId: walk.dropId });
    expect(await tom.query(api.drops.list, {})).toEqual([]);
    expect(await fileGone(t, storageId)).toBe(true);
    expect((await t.fetch(pathOf(walk.url))).status).toBe(404);
    expect(must((await tom.query(api.ledger.mine, {}))[0])).toMatchObject({ walkthroughAsked: true });
    expect(must((await tom.query(api.ledger.mine, {}))[0]).walkthrough).toBeUndefined();
    expect(await walkthroughEvents(t)).toEqual([]);
    expect(await tom.query(api.drops.usage, {})).toEqual({ used: 0, limit: 5e9 });
    // Already gone: nothing to do.
    expect(await tom.mutation(api.drops.forget, { dropId: walk.dropId })).toBeNull();

    // The leader may forget a crewmate's drop; a link drop's link stops sending anyone on.
    const adas = await ada.mutation(api.drops.link, { title: "Ada's link", url: TARGET });
    expect(must((await tom.query(api.drops.list, {}))[0]).canForget).toBe(true);
    await tom.mutation(api.drops.forget, { dropId: adas.dropId });
    expect(await ada.query(api.drops.list, {})).toEqual([]);
    expect((await t.fetch(pathOf(adas.url))).status).toBe(404);
  });

  test("the last one out ends the crew, and its drops and stored files go with it", async function () {
    const t = harness();
    const { tom, ada } = await crew(t);
    const storageId = await stored(t, PAGE);
    const page = await ada.mutation(api.drops.save, { storageId, title: "Ada's page", kind: "page", contentType: "text/html", size: bytes(PAGE) });
    await ada.mutation(api.crews.leave, {});
    // Ada's drop stays with the crew she left.
    expect((await tom.query(api.drops.list, {})).map(function (d) { return d.title; })).toEqual(["Ada's page"]);
    expect(await ada.query(api.drops.list, {})).toEqual([]);
    expect((await t.fetch(pathOf(page.url))).status).toBe(200);

    await tom.mutation(api.crews.leave, {});
    expect(await fileGone(t, storageId)).toBe(true);
    expect((await t.fetch(pathOf(page.url))).status).toBe(404);
    expect(await t.run(async function (ctx) { return await ctx.db.query("drops").collect(); })).toEqual([]);
  });
});
