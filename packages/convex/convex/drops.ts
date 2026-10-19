// ABOUTME: Drops: pages a crew shares (walkthroughs first), kept in Convex file storage and served at an unguessable link,
// ABOUTME: /d/<token>, or links to pages hosted elsewhere, sent on from the same kind of link. Hosting is on the team plan.
import { ConvexError, type Infer, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { env, httpAction, internalQuery, mutation, query } from "./_generated/server";
import { ownLine, recordWalkthrough } from "./ledger";
import { requireHacker } from "./lib/auth";
import { crewmateIds, crewOf } from "./lib/crew";
import { limitsFor } from "./lib/plan";
import { dropKind } from "./schema";
import { supersetCard } from "./superset";

// A drop's link is /d/ and 32 characters from these 64, picked with crypto.getRandomValues: 192 bits, so a link cannot be
// guessed. 64 divides 256, so every character is equally likely.
const TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
export const TOKEN_LENGTH = 32;
const DROP_PATH = /^\/d\/([A-Za-z0-9_-]{32})$/;
const MAX_TITLE = 200;
const MAX_LINK = 2000;
const MAX_CONTENT_TYPE = 200;
// type/subtype and simple parameters; spaces and tabs only, so no line break can reach a header.
const CONTENT_TYPE = /^[a-z0-9][\w.+-]*\/[\w.+-]+([ \t]*;[ \t]*[\w.+-]+=("[^"\r\n]*"|[\w.+-]+))*$/i;
// The shelf shows the newest 100.
const LIST_MAX = 100;
// What a link-only drop says it is.
const LINK_TYPE = "text/uri-list";
// An HTTP action answers with at most 100 MiB and runs in 64 MiB of memory, so /d/ serves files up to this size itself
// and sends bigger ones on to their storage URL. Pages are always served by /d/, under PAGE_POLICY, so a page is at most
// this size.
export const SERVE_MAX = 20_000_000;
// A browser may keep a drop five minutes. Nothing else keeps it: a forgotten drop is gone everywhere else at once.
const CACHE = "private, max-age=300";
// A page runs its own inline styles and scripts, with its images and fonts inside it, and reaches nothing on the network:
// no requests, no forms, no frames.
export const PAGE_POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";
const NO_HOSTING = "Drops hosting is on the team plan; share a link instead.";

// 32 random url-safe characters.
export function newToken(): string {
  const bytes = new Uint8Array(TOKEN_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += TOKEN_ALPHABET.charAt(b % TOKEN_ALPHABET.length);
  return out;
}

function present(value: string | undefined): string | null {
  const text = (value ?? "").trim().replace(/\/+$/, "");
  return text === "" ? null : text;
}

// Where drops are served: this deployment's site, https://<name>.convex.site. Convex sets CONVEX_SITE_URL on every
// deployment; without it, the deployment's own URL with .convex.cloud swapped for .convex.site, the way the daemon finds
// the site (apps/daemon/src/operator.ts siteUrl). Null when neither is set, which happens only in tests.
export function siteUrl(): string | null {
  const site = present(env.CONVEX_SITE_URL);
  if (site !== null) return site;
  const cloud = present(env.CONVEX_CLOUD_URL);
  if (cloud !== null && /\.convex\.cloud$/.test(cloud)) return cloud.replace(/\.convex\.cloud$/, ".convex.site");
  return null;
}

function requireSite(): string {
  const site = siteUrl();
  if (site === null) throw new ConvexError("This deployment has no site URL to serve drops from.");
  return site;
}

function dropLink(site: string | null, token: string): string {
  return `${site ?? ""}/d/${token}`;
}

// 5000000000 is "5 GB" and 1234567 is "1.2 MB": decimal units, as the plan's 5 GB is.
export function amount(bytes: number): string {
  const units: [number, string][] = [[1e9, "GB"], [1e6, "MB"], [1e3, "KB"]];
  for (const [size, unit] of units) if (bytes >= size) return `${Math.round((bytes / size) * 10) / 10} ${unit}`;
  return `${bytes} bytes`;
}

// The type without its parameters, in lower case: "text/html; charset=utf-8" is "text/html".
function baseType(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

// Types a browser runs as a document, scripts and all: HTML, XHTML, SVG and the rest of XML. These get PAGE_POLICY.
export function isDocument(contentType: string): boolean {
  const base = baseType(contentType);
  return base === "text/html" || base === "text/xml" || base === "application/xml" || base.endsWith("+xml");
}

function cleanTitle(raw: string): string {
  const title = raw.trim().replace(/\s+/g, " ");
  if (title === "" || title.length > MAX_TITLE) throw new ConvexError(`A drop's title is 1 to ${MAX_TITLE} characters.`);
  return title;
}

// A content type that is safe to send back as a header: type/subtype and simple parameters, no line breaks.
function cleanContentType(raw: string): string {
  const type = raw.trim();
  if (type.length > MAX_CONTENT_TYPE || !CONTENT_TYPE.test(type)) throw new ConvexError("That is not a content type a browser knows.");
  return type;
}

function wholeBytes(n: number): number {
  if (!Number.isInteger(n) || n < 0) throw new ConvexError("A size is a whole number of bytes.");
  return n;
}

// A link to a page somewhere else: https only, no user name or password in it.
function httpsLink(raw: string): string {
  const text = raw.trim();
  let parsed: URL | null = null;
  try {
    parsed = new URL(text);
  } catch {
    parsed = null;
  }
  if (parsed === null || parsed.protocol !== "https:" || parsed.hostname === "" || /\s/.test(text)) {
    throw new ConvexError("A drop links to an https:// page.");
  }
  if (parsed.username !== "" || parsed.password !== "") throw new ConvexError("Take the user name and password out of that link.");
  if (parsed.href.length > MAX_LINK) throw new ConvexError(`A link is at most ${MAX_LINK} characters.`);
  return parsed.href;
}

// The caller's crew and its drops quota, when its plan hosts drops. Throws on the free plan and for a hacker in no crew.
async function hostingCrew(ctx: QueryCtx, me: Doc<"hackers">): Promise<{ crew: Doc<"crews">; limit: number }> {
  const crew = await crewOf(ctx, me._id);
  const limit = limitsFor(crew).dropBytes;
  if (crew === null || limit <= 0) throw new ConvexError(NO_HOSTING);
  return { crew, limit };
}

// Bytes a crew's drops hold, from the drops' own rows (each size was read from file storage when it was saved).
async function usedBytes(ctx: QueryCtx, crewId: Id<"crews">): Promise<number> {
  let used = 0;
  const drops = ctx.db.query("drops").withIndex("by_crew", function (q) {
    return q.eq("crewId", crewId);
  });
  for await (const drop of drops) used += drop.size;
  return used;
}

// Throws unless the crew has room for `size` more bytes, and unless a page that big can still be served under its policy.
async function checkRoom(ctx: QueryCtx, crewId: Id<"crews">, limit: number, size: number, contentType: string | null): Promise<void> {
  if (contentType !== null && isDocument(contentType) && size > SERVE_MAX) {
    throw new ConvexError(`A page is at most ${amount(SERVE_MAX)}. Share a bigger one as a file, or as a link.`);
  }
  const used = await usedBytes(ctx, crewId);
  if (used + size > limit) {
    throw new ConvexError(`That would put the crew over its ${amount(limit)} of drops (${amount(used)} used). Forget a drop, or share a link instead.`);
  }
}

// Whoever dropped it, or the leader of the crew it was dropped in.
async function canForget(ctx: QueryCtx, me: Doc<"hackers">, drop: Doc<"drops">): Promise<boolean> {
  if (drop.hackerId === me._id) return true;
  if (drop.crewId === undefined) return false;
  const crew = await ctx.db.get("crews", drop.crewId);
  return crew !== null && crew.leaderId === me._id;
}

// What a drop leaves behind when it goes: its ledger line's walkthrough link, when that link is this drop, and the
// wire's walkthrough event that points at it.
async function unlinkWalkthrough(ctx: MutationCtx, drop: Doc<"drops">): Promise<void> {
  if (drop.ledgerId !== undefined) {
    const line = await ctx.db.get("ledger", drop.ledgerId);
    if (line?.walkthrough !== undefined && line.walkthrough.endsWith(`/d/${drop.token}`)) {
      await ctx.db.patch("ledger", line._id, { walkthrough: undefined });
    }
  }
  const events = await ctx.db
    .query("feed")
    .withIndex("by_hacker_at", function (q) {
      return q.eq("hackerId", drop.hackerId);
    })
    .collect();
  for (const e of events) if (e.dropId === drop._id) await ctx.db.delete("feed", e._id);
}

// Deletes a drop, its stored file, and what pointed at it.
async function removeDrop(ctx: MutationCtx, drop: Doc<"drops">): Promise<void> {
  await unlinkWalkthrough(ctx, drop);
  if (drop.storageId !== undefined && (await ctx.db.system.get("_storage", drop.storageId)) !== null) {
    await ctx.storage.delete(drop.storageId);
  }
  await ctx.db.delete("drops", drop._id);
}

// A crew that ends takes its shelf with it: every drop and every stored file (crews.ts `leave`, for the last one out).
export async function forgetCrewDrops(ctx: MutationCtx, crewId: Id<"crews">): Promise<void> {
  const drops = await ctx.db
    .query("drops")
    .withIndex("by_crew", function (q) {
      return q.eq("crewId", crewId);
    })
    .collect();
  for (const drop of drops) await removeDrop(ctx, drop);
}

const saved = v.object({ dropId: v.id("drops"), url: v.string() });

// A link to upload one file to, for an hour (Convex file storage). Team plan only. With the file's size (and its type),
// the crew's room is checked first, so a file that would not fit is never sent.
export const uploadUrl = mutation({
  args: { size: v.optional(v.number()), contentType: v.optional(v.string()) },
  returns: v.string(),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const { crew, limit } = await hostingCrew(ctx, me);
    if (args.size !== undefined) {
      const type = args.contentType === undefined ? null : cleanContentType(args.contentType);
      await checkRoom(ctx, crew._id, limit, wholeBytes(args.size), type);
    }
    return await ctx.storage.generateUploadUrl();
  },
});

// Puts an uploaded file on the crew's shelf. The size is file storage's, checked against what the uploader says and
// against the crew's quota. A walkthrough for one of my ledger lines also goes on that line and on the wire. Saving the
// same upload again returns the drop it already made.
export const save = mutation({
  args: {
    storageId: v.id("_storage"),
    title: v.string(),
    kind: dropKind,
    contentType: v.string(),
    size: v.number(),
    ledgerId: v.optional(v.id("ledger")),
  },
  returns: saved,
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const { crew, limit } = await hostingCrew(ctx, me);
    const site = requireSite();
    const before = await ctx.db
      .query("drops")
      .withIndex("by_storage", function (q) {
        return q.eq("storageId", args.storageId);
      })
      .unique();
    if (before !== null) {
      if (before.hackerId !== me._id) throw new ConvexError("That upload is someone else's drop.");
      return { dropId: before._id, url: dropLink(site, before.token) };
    }
    const title = cleanTitle(args.title);
    const contentType = cleanContentType(args.contentType);
    const size = wholeBytes(args.size);
    const file = await ctx.db.system.get("_storage", args.storageId);
    if (file === null) throw new ConvexError("That upload is not there. An upload link lasts an hour; upload it again.");
    if (file.size !== size) throw new ConvexError(`That upload is ${file.size} bytes, not ${size}. Upload it again.`);
    await checkRoom(ctx, crew._id, limit, file.size, contentType);
    const line = args.ledgerId === undefined ? null : await ownLine(ctx, me, args.ledgerId);
    const token = newToken();
    const dropId = await ctx.db.insert("drops", {
      crewId: crew._id,
      hackerId: me._id,
      title,
      kind: args.kind,
      storageId: args.storageId,
      token,
      size: file.size,
      contentType,
      ledgerId: line?._id,
      createdAt: Date.now(),
    });
    const url = dropLink(site, token);
    if (args.kind === "walkthrough" && line !== null) await recordWalkthrough(ctx, me, line._id, url, dropId);
    return { dropId, url };
  },
});

// Puts a link to a page hosted elsewhere (a Superset Page, an Artifact) on the shelf, on any plan. Its drop link sends
// the browser on to it. With one of my ledger lines it is a walkthrough unless `kind` says otherwise, and a walkthrough
// goes on that line and on the wire.
export const link = mutation({
  args: { title: v.string(), url: v.string(), ledgerId: v.optional(v.id("ledger")), kind: v.optional(dropKind) },
  returns: saved,
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const title = cleanTitle(args.title);
    const target = httpsLink(args.url);
    const site = requireSite();
    const crew = await crewOf(ctx, me._id);
    const line = args.ledgerId === undefined ? null : await ownLine(ctx, me, args.ledgerId);
    const kind = args.kind ?? (line === null ? "page" : "walkthrough");
    const token = newToken();
    const dropId = await ctx.db.insert("drops", {
      crewId: crew?._id,
      hackerId: me._id,
      title,
      kind,
      url: target,
      token,
      size: 0,
      contentType: LINK_TYPE,
      ledgerId: line?._id,
      createdAt: Date.now(),
    });
    const url = dropLink(site, token);
    if (kind === "walkthrough" && line !== null) await recordWalkthrough(ctx, me, line._id, url, dropId);
    return { dropId, url };
  },
});

const dropView = v.object({
  _id: v.id("drops"),
  title: v.string(),
  kind: dropKind,
  // Where to open it: /d/<token> on this deployment's site, for a hosted file and for a link alike.
  url: v.string(),
  byHandle: v.string(),
  byName: v.optional(v.string()),
  createdAt: v.number(),
  // Bytes it takes from the crew's quota; 0 for a link.
  size: v.number(),
  ledgerId: v.optional(v.id("ledger")),
  // Whoever dropped it, or the crew's leader, may forget it.
  canForget: v.boolean(),
});

// The shelf: my crew's drops, newest first, at most 100. A hacker in no crew sees their own and their friends' drops
// made outside any crew (links: hosting needs a crew).
export const list = query({
  args: {},
  returns: v.array(dropView),
  handler: async function (ctx) {
    const me = await requireHacker(ctx);
    const crew = await crewOf(ctx, me._id);
    let rows: Doc<"drops">[] = [];
    if (crew !== null) {
      rows = await ctx.db
        .query("drops")
        .withIndex("by_crew", function (q) {
          return q.eq("crewId", crew._id);
        })
        .order("desc")
        .take(LIST_MAX);
    } else {
      for (const id of [me._id, ...(await crewmateIds(ctx, me._id))]) {
        const theirs = ctx.db
          .query("drops")
          .withIndex("by_hacker", function (q) {
            return q.eq("hackerId", id);
          })
          .order("desc");
        let taken = 0;
        for await (const drop of theirs) {
          if (drop.crewId !== undefined) continue;
          rows.push(drop);
          taken += 1;
          if (taken === LIST_MAX) break;
        }
      }
      rows.sort(function (a, b) { return b.createdAt - a.createdAt; });
      rows = rows.slice(0, LIST_MAX);
    }
    const site = siteUrl();
    const people = new Map<Id<"hackers">, { handle: string; name?: string } | null>();
    const out = [];
    for (const drop of rows) {
      let by = people.get(drop.hackerId);
      if (by === undefined) {
        const hacker = await ctx.db.get("hackers", drop.hackerId);
        by = hacker === null ? null : { handle: hacker.handle, name: (await supersetCard(ctx, hacker._id))?.name };
        people.set(drop.hackerId, by);
      }
      if (by === null) continue;
      out.push({
        _id: drop._id,
        title: drop.title,
        kind: drop.kind,
        url: dropLink(site, drop.token),
        byHandle: by.handle,
        byName: by.name,
        createdAt: drop.createdAt,
        size: drop.size,
        ledgerId: drop.ledgerId,
        canForget: drop.hackerId === me._id || (crew !== null && crew.leaderId === me._id && drop.crewId === crew._id),
      });
    }
    return out;
  },
});

// Takes a drop off the shelf and deletes its stored file, so its link stops working. Whoever dropped it, or the crew's
// leader. A walkthrough's link leaves its ledger line and the wire too. Forgetting a drop that is already gone does nothing.
export const forget = mutation({
  args: { dropId: v.id("drops") },
  returns: v.null(),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const drop = await ctx.db.get("drops", args.dropId);
    if (drop === null) return null;
    if (!(await canForget(ctx, me, drop))) throw new ConvexError("Only whoever dropped it, or the crew's leader, can forget a drop.");
    await removeDrop(ctx, drop);
    return null;
  },
});

// Bytes my crew's drops hold, and how many its plan allows (0 on free, and in no crew: links only).
export const usage = query({
  args: {},
  returns: v.object({ used: v.number(), limit: v.number() }),
  handler: async function (ctx) {
    const me = await requireHacker(ctx);
    const crew = await crewOf(ctx, me._id);
    return { used: crew === null ? 0 : await usedBytes(ctx, crew._id), limit: limitsFor(crew).dropBytes };
  },
});

const served = v.union(
  v.null(),
  v.object({ kind: v.literal("link"), url: v.string() }),
  v.object({ kind: v.literal("file"), storageId: v.id("_storage"), contentType: v.string(), size: v.number() }),
);

// What /d/<token> serves: a stored file (null once the file is gone), or the link a link-only drop sends the browser to.
export const byToken = internalQuery({
  args: { token: v.string() },
  returns: served,
  handler: async function (ctx, args): Promise<Infer<typeof served>> {
    const drop = await ctx.db
      .query("drops")
      .withIndex("by_token", function (q) {
        return q.eq("token", args.token);
      })
      .unique();
    if (drop === null) return null;
    if (drop.url !== undefined) return { kind: "link", url: drop.url };
    if (drop.storageId === undefined || (await ctx.db.system.get("_storage", drop.storageId)) === null) return null;
    return { kind: "file", storageId: drop.storageId, contentType: drop.contentType, size: drop.size };
  },
});

function notFound(): Response {
  return new Response("No such drop.", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

// The drop's link is the secret, so it is never sent on as a Referer, and search engines do not list it.
function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: location, "Cache-Control": CACHE, "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" },
  });
}

function servedHeaders(contentType: string): Headers {
  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": CACHE,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex",
  });
  if (isDocument(contentType)) headers.set("Content-Security-Policy", PAGE_POLICY);
  return headers;
}

// GET /d/<token> (and HEAD): the stored file with its content type, a page under PAGE_POLICY; a file bigger than an HTTP
// action can answer with goes on to its storage URL; a link-only drop sends the browser on to its page; 404 for anything
// else. The link is the only key, as the plan says (an unguessable link), so nothing here asks who is reading.
export const serve = httpAction(async function (ctx, req) {
  const token = DROP_PATH.exec(new URL(req.url).pathname)?.[1];
  const drop = token === undefined ? null : await ctx.runQuery(internal.drops.byToken, { token });
  if (drop === null) return notFound();
  if (drop.kind === "link") return redirect(drop.url);
  if (drop.size > SERVE_MAX && !isDocument(drop.contentType)) {
    const direct = await ctx.storage.getUrl(drop.storageId);
    return direct === null ? notFound() : redirect(direct);
  }
  const headers = servedHeaders(drop.contentType);
  if (req.method === "HEAD") {
    headers.set("Content-Length", String(drop.size));
    return new Response(null, { status: 200, headers });
  }
  const blob = await ctx.storage.get(drop.storageId);
  if (blob === null) return notFound();
  return new Response(blob, { status: 200, headers });
});
