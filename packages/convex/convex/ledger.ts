// ABOUTME: The ledger: one line per finished piece of work, per person, made on the owner's Mac and sent by their daemon.
// ABOUTME: Owners read, edit and forget their own lines; crewmates' daemons and the Operator read the crew's. Kept by the plan's days.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { addToFeed } from "./feed";
import { acceptedFriendIds } from "./friends";
import { requireDaemon, requireHacker } from "./lib/auth";
import { search as rankLines } from "./lib/ledgerSearch";
import { crewOf, limitsFor } from "./lib/plan";
import { redactSecrets } from "./lib/summaries";
import { supersetCard } from "./superset";

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_DID = 240;
const MAX_AREAS = 12;
// A workspace, a branch, a folder.
const MAX_NAME = 200;
const MAX_URL = 500;
const MAX_SESSION_KEY = 200;
// Every plan keeps a line at least a week (the free plan), so the daily prune only looks at older ones.
const MIN_KEPT_DAYS = 7;
const PRUNE_PAGE = 200;
// How far back crewmates' daemons and the Operator look, by default and at most (the team plan's 90 days).
const DEFAULT_DAYS = 14;
const MAX_DAYS = 90;
const CREW_RECENT_MAX = 200;
// The most lines read per crewmate for one search: two weeks of a busy hacker's work, many times over.
const SEARCHED_PER_CREWMATE = 300;
const TOP_HITS = 8;

// Text from a daemon: trimmed, anything that looks like a key taken out, and cut short.
function clean(text: string, max: number): string {
  return redactSecrets(text.trim()).slice(0, max);
}

function optionalText(text: string | undefined, max: number): string | undefined {
  if (text === undefined) return undefined;
  const c = clean(text, max);
  return c === "" ? undefined : c;
}

function cleanAreas(areas: string[]): string[] {
  const out: string[] = [];
  for (const a of areas) {
    const c = clean(a, MAX_NAME);
    if (c !== "" && !out.includes(c)) out.push(c);
    if (out.length === MAX_AREAS) break;
  }
  return out;
}

function daysWithin(days: number | undefined): number {
  const d = days ?? DEFAULT_DAYS;
  return Number.isFinite(d) ? Math.min(MAX_DAYS, Math.max(1, d)) : DEFAULT_DAYS;
}

// The sessions a hacker's Macs list as private now. A line's sessionKey is its agent's session id, so a private agent's
// lines can be told apart: its daemon never sends one, and one sent before it went private is no longer shown to the crew.
async function privateSessions(ctx: QueryCtx, hackerId: Id<"hackers">, machineName?: string): Promise<Set<string>> {
  const subsets = await ctx.db
    .query("subsets")
    .withIndex("by_hacker_machine", function (q) {
      return q.eq("hackerId", hackerId);
    })
    .collect();
  const out = new Set<string>();
  for (const s of subsets) {
    if (machineName !== undefined && s.machineName !== machineName) continue;
    for (const a of s.agents) if (!a.open) out.add(a.agentId);
  }
  return out;
}

const lineView = v.object({
  _id: v.id("ledger"),
  at: v.number(),
  harness: v.string(),
  machineName: v.string(),
  // The daemon's key for the session, so the app can ask this Mac's daemon for a walkthrough of it.
  sessionKey: v.string(),
  workspace: v.optional(v.string()),
  branch: v.optional(v.string()),
  did: v.string(),
  areas: v.array(v.string()),
  files: v.number(),
  pr: v.optional(v.string()),
  shipped: v.optional(v.boolean()),
  walkthrough: v.optional(v.string()),
  walkthroughAsked: v.optional(v.boolean()),
  editedByOwner: v.optional(v.boolean()),
});

function lineOf(l: Doc<"ledger">) {
  return {
    _id: l._id,
    at: l.at,
    harness: l.harness,
    machineName: l.machineName,
    sessionKey: l.sessionKey,
    workspace: l.workspace,
    branch: l.branch,
    did: l.did,
    areas: l.areas,
    files: l.files,
    pr: l.pr,
    shipped: l.shipped,
    walkthrough: l.walkthrough,
    walkthroughAsked: l.walkthroughAsked,
    editedByOwner: l.editedByOwner,
  };
}

// One line per session: the daemon sends the line again as the session goes on, and it replaces the old one, except
// the words of a line its owner rewrote. A line's first ship is news on the wire.
export const report = mutation({
  args: {
    token: v.string(),
    sessionKey: v.string(),
    harness: v.string(),
    workspace: v.optional(v.string()),
    branch: v.optional(v.string()),
    did: v.string(),
    areas: v.array(v.string()),
    files: v.number(),
    pr: v.optional(v.string()),
    shipped: v.optional(v.boolean()),
    at: v.optional(v.number()),
  },
  returns: v.id("ledger"),
  handler: async function (ctx, args) {
    const { hacker, daemon } = await requireDaemon(ctx, args.token);
    const sessionKey = args.sessionKey.trim();
    if (sessionKey === "" || sessionKey.length > MAX_SESSION_KEY) throw new ConvexError("A ledger line needs its session's key.");
    if ((await privateSessions(ctx, hacker._id, daemon.machineName)).has(sessionKey)) {
      throw new ConvexError("A private agent's work stays on its Mac, so it has no ledger line.");
    }
    const did = clean(args.did, MAX_DID);
    if (did === "") throw new ConvexError("A ledger line says what was done.");
    const now = Date.now();
    const existing = await ctx.db
      .query("ledger")
      .withIndex("by_hacker_session", function (q) {
        return q.eq("hackerId", hacker._id).eq("sessionKey", sessionKey);
      })
      .unique();
    // Its owner forgot this session's line: it stays forgotten.
    if (existing?.forgotten === true) return existing._id;
    const harness = clean(args.harness, 40);
    const at = args.at !== undefined && Number.isFinite(args.at) ? Math.min(args.at, now) : now;
    // A PR link stays once seen, and a ship stays a ship.
    const pr = optionalText(args.pr, MAX_URL) ?? existing?.pr;
    const shipped = existing?.shipped === true || args.shipped === true;
    const fields = {
      at,
      harness: harness === "" ? "claude-code" : harness,
      machineName: daemon.machineName,
      workspace: optionalText(args.workspace, MAX_NAME),
      branch: optionalText(args.branch, MAX_NAME),
      areas: cleanAreas(args.areas),
      files: Number.isFinite(args.files) ? Math.max(0, Math.round(args.files)) : 0,
      pr,
      shipped: shipped ? true : undefined,
    };
    if (existing === null) {
      const id = await ctx.db.insert("ledger", { hackerId: hacker._id, sessionKey, did, ...fields });
      if (shipped) await addToFeed(ctx, { kind: "ship", hackerId: hacker._id, text: did, url: pr, ledgerId: id, at });
      return id;
    }
    const words = existing.editedByOwner === true ? existing.did : did;
    await ctx.db.patch("ledger", existing._id, { ...fields, did: words });
    if (shipped && existing.shipped !== true) {
      await addToFeed(ctx, { kind: "ship", hackerId: hacker._id, text: words, url: pr, ledgerId: existing._id, at });
    }
    return existing._id;
  },
});

// My last 50 lines, newest first, for This Mac → Ledger.
export const mine = query({
  args: {},
  returns: v.array(lineView),
  handler: async function (ctx) {
    const me = await requireHacker(ctx);
    const lines = [];
    const newestFirst = ctx.db
      .query("ledger")
      .withIndex("by_hacker_at", function (q) {
        return q.eq("hackerId", me._id);
      })
      .order("desc");
    for await (const l of newestFirst) {
      if (l.forgotten === true) continue;
      lines.push(lineOf(l));
      if (lines.length === 50) break;
    }
    return lines;
  },
});

async function ownLine(ctx: QueryCtx, me: Doc<"hackers">, id: Id<"ledger">): Promise<Doc<"ledger">> {
  const line = await ctx.db.get("ledger", id);
  if (line === null || line.hackerId !== me._id || line.forgotten === true) throw new ConvexError("Not your ledger line.");
  return line;
}

// The wire's events about one line (its ship and walkthrough), from its owner's week of events.
async function eventsOf(ctx: QueryCtx, line: Doc<"ledger">): Promise<Doc<"feed">[]> {
  const rows = await ctx.db
    .query("feed")
    .withIndex("by_hacker_at", function (q) {
      return q.eq("hackerId", line.hackerId);
    })
    .collect();
  return rows.filter(function (e) { return e.ledgerId === line._id; });
}

// The owner rewrites a line. The daemon never replaces their words again, and the wire says it their way too.
export const edit = mutation({
  args: { ledgerId: v.id("ledger"), did: v.string() },
  returns: v.null(),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const line = await ownLine(ctx, me, args.ledgerId);
    const did = clean(args.did, MAX_DID);
    if (did === "") throw new ConvexError("Write what was done, or forget the line.");
    await ctx.db.patch("ledger", line._id, { did, editedByOwner: true });
    for (const e of await eventsOf(ctx, line)) if (e.text !== undefined) await ctx.db.patch("feed", e._id, { text: did });
    return null;
  },
});

// The owner deletes a line: its words go, and its ship and walkthrough leave the wire with it. A marker for its session
// stays (no words, no folders), so the daemon sending the line again does not bring it back. The daily prune drops the
// marker with the plan's other old lines.
export const forget = mutation({
  args: { ledgerId: v.id("ledger") },
  returns: v.null(),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const line = await ownLine(ctx, me, args.ledgerId);
    for (const e of await eventsOf(ctx, line)) await ctx.db.delete("feed", e._id);
    await ctx.db.replace("ledger", line._id, {
      hackerId: line.hackerId,
      at: line.at,
      harness: line.harness,
      machineName: line.machineName,
      sessionKey: line.sessionKey,
      did: "",
      areas: [],
      files: 0,
      forgotten: true,
    });
    return null;
  },
});

// The owner's agent wrote a walkthrough page for the line: it goes on the line and on the wire.
export const setWalkthrough = mutation({
  args: { ledgerId: v.id("ledger"), url: v.string() },
  returns: v.null(),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const line = await ownLine(ctx, me, args.ledgerId);
    const url = args.url.trim();
    if (!/^https?:\/\/\S+$/i.test(url) || url.length > MAX_URL) throw new ConvexError("A walkthrough is a web link.");
    await ctx.db.patch("ledger", line._id, { walkthrough: url, walkthroughAsked: true });
    const shown = (await eventsOf(ctx, line)).find(function (e) { return e.kind === "walkthrough"; });
    if (shown !== undefined) await ctx.db.patch("feed", shown._id, { url });
    else await addToFeed(ctx, { kind: "walkthrough", hackerId: me._id, url, ledgerId: line._id, text: line.did, at: Date.now() });
    return null;
  },
});

// The HUD asked "Make a walkthrough?" once for this line; it does not ask again.
export const markWalkthroughAsked = mutation({
  args: { ledgerId: v.id("ledger") },
  returns: v.null(),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const line = await ownLine(ctx, me, args.ledgerId);
    if (line.walkthroughAsked !== true) await ctx.db.patch("ledger", line._id, { walkthroughAsked: true });
    return null;
  },
});

// Crewmates' lines (never mine), newest first, for the daemon to score prompts against on the Mac (heads-ups). The
// folder and branch only when their owner shares folder names, as for routing summaries.
export const crewRecent = query({
  args: { token: v.string(), days: v.optional(v.number()) },
  returns: v.array(v.object({
    handle: v.string(),
    name: v.optional(v.string()),
    did: v.string(),
    areas: v.array(v.string()),
    at: v.number(),
    workspace: v.optional(v.string()),
    harness: v.string(),
    shipped: v.optional(v.boolean()),
  })),
  handler: async function (ctx, args) {
    const { hacker } = await requireDaemon(ctx, args.token);
    const since = Date.now() - daysWithin(args.days) * DAY_MS;
    const out = [];
    // TODO(crews): crewmateIds
    for (const id of await acceptedFriendIds(ctx, hacker._id)) {
      const owner = await ctx.db.get("hackers", id);
      if (owner === null) continue;
      const name = (await supersetCard(ctx, id))?.name;
      const hidden = await privateSessions(ctx, id);
      const rows = await ctx.db
        .query("ledger")
        .withIndex("by_hacker_at", function (q) {
          return q.eq("hackerId", id).gt("at", since);
        })
        .order("desc")
        .take(CREW_RECENT_MAX);
      for (const l of rows) {
        if (l.forgotten === true || hidden.has(l.sessionKey)) continue;
        out.push({
          handle: owner.handle,
          name,
          did: l.did,
          areas: l.areas,
          at: l.at,
          workspace: owner.shareWorkspaceNames ? l.workspace : undefined,
          harness: l.harness,
          shipped: l.shipped,
        });
      }
    }
    out.sort(function (a, b) { return b.at - a.at; });
    return out.slice(0, CREW_RECENT_MAX);
  },
});

// A ledger line as the Operator sees it.
export const hitView = v.object({
  hackerId: v.id("hackers"),
  handle: v.string(),
  name: v.optional(v.string()),
  did: v.string(),
  areas: v.array(v.string()),
  at: v.number(),
  workspace: v.optional(v.string()),
});

export interface LedgerHit {
  hackerId: Id<"hackers">;
  handle: string;
  name?: string;
  did: string;
  areas: string[];
  at: number;
  workspace?: string;
}

// The crewmates' lines of the last `days` that best match the query, best first, at most 8. Never the asker's own:
// the Operator only tells a hacker about their crewmates' work. With `among`, only those crewmates' lines (a question
// about @someone), so other crewmates' newer work cannot crowd theirs out. The folder and branch count, and show, only
// when their owner shares folder names.
export async function searchLedger(
  ctx: QueryCtx,
  hackerId: Id<"hackers">,
  queryText: string,
  days: number,
  among?: Id<"hackers">[],
): Promise<LedgerHit[]> {
  const now = Date.now();
  const since = now - daysWithin(days) * DAY_MS;
  const lines = [];
  // TODO(crews): crewmateIds
  for (const id of await acceptedFriendIds(ctx, hackerId)) {
    if (among !== undefined && !among.includes(id)) continue;
    const owner = await ctx.db.get("hackers", id);
    if (owner === null) continue;
    const hidden = await privateSessions(ctx, id);
    const rows = await ctx.db
      .query("ledger")
      .withIndex("by_hacker_at", function (q) {
        return q.eq("hackerId", id).gt("at", since);
      })
      .order("desc")
      .take(SEARCHED_PER_CREWMATE);
    for (const row of rows) {
      if (row.forgotten === true || hidden.has(row.sessionKey)) continue;
      const shared = owner.shareWorkspaceNames;
      lines.push({ row, owner, did: row.did, areas: row.areas, at: row.at, workspace: shared ? row.workspace : undefined, branch: shared ? row.branch : undefined });
    }
  }
  const out: LedgerHit[] = [];
  const names = new Map<Id<"hackers">, string | undefined>();
  for (const { line } of rankLines(queryText, lines, now).slice(0, TOP_HITS)) {
    const id = line.owner._id;
    if (!names.has(id)) names.set(id, (await supersetCard(ctx, id))?.name);
    out.push({ hackerId: id, handle: line.owner.handle, name: names.get(id), did: line.did, areas: line.areas, at: line.at, workspace: line.workspace });
  }
  return out;
}

// For the Operator's chat, which searches the ledger as a tool.
export const search = internalQuery({
  args: { hackerId: v.id("hackers"), query: v.string(), days: v.number() },
  returns: v.array(hitView),
  handler: async function (ctx, args) {
    return await searchLedger(ctx, args.hackerId, args.query, args.days);
  },
});

// Drops lines past their crew's plan (a week on free and for a hacker in no crew, 90 days on team), oldest first, a page
// at a time. crons.ts runs it daily; a full page schedules the next one, from where it stopped. Pages go by the line's
// time rather than a cursor, because lines on a team plan stay and lines on free go, so a page's last line may be gone.
// A line that shares its millisecond with the last line of a full page waits for the next day's run.
export const prune = internalMutation({
  args: { after: v.optional(v.number()), before: v.optional(v.number()) },
  returns: v.null(),
  handler: async function (ctx, args) {
    const now = Date.now();
    const before = args.before ?? now - MIN_KEPT_DAYS * DAY_MS;
    const after = args.after ?? 0;
    const page = await ctx.db
      .query("ledger")
      .withIndex("by_at", function (q) {
        return q.gt("at", after).lt("at", before);
      })
      .take(PRUNE_PAGE);
    const keptDays = new Map<Id<"hackers">, number>();
    for (const line of page) {
      let days = keptDays.get(line.hackerId);
      if (days === undefined) {
        days = limitsFor(await crewOf(ctx, line.hackerId)).ledgerDays;
        keptDays.set(line.hackerId, days);
      }
      // A forgotten line's marker (no words) is kept the longest any plan keeps a line, so a long session sent again
      // late is not brought back.
      const keep = line.forgotten === true ? MAX_DAYS : days;
      if (line.at < now - keep * DAY_MS) await ctx.db.delete("ledger", line._id);
    }
    const last = page[page.length - 1];
    if (page.length === PRUNE_PAGE && last !== undefined) await ctx.scheduler.runAfter(0, internal.ledger.prune, { after: last.at, before });
    return null;
  },
});
