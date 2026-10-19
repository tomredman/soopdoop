// ABOUTME: The crew's digest. Every hour a tick finds the crews whose digest hour it is in their time zone; the Operator writes
// ABOUTME: "Yesterday in <crew>" (and on Mondays the week's four numbers), which is kept, posted to Slack and put on the wire.
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalAction, internalMutation, internalQuery, query } from "./_generated/server";
import { addToFeed } from "./feed";
import { requireHacker } from "./lib/auth";
import { crewOf, memberIdsOf } from "./lib/crew";
import { clip, customerProps, type DigestMaterial, digestMaterial, isQuiet, shortName, weeklyText, writeDigest } from "./lib/digest";
import { dayWindow, localTime, shiftDay, startOfDay } from "./lib/localTime";
import { crewNumbers } from "./lib/numbers";
import { limitsFor } from "./lib/plan";
import { supersetCard } from "./superset";

const kind = v.union(v.literal("daily"), v.literal("weekly"));
// The ledger lines the writer gets as background, at most.
const MAX_WORK = 30;

// The digest's hour in the crew's time zone, or the hour after it, so a missed tick still sends it. Never past midnight:
// the day it covers would change.
export function isDigestHour(hour: number, digestHour: number): boolean {
  return hour === digestHour || (digestHour < 23 && hour === digestHour + 1);
}

// What is due for a crew at an instant: the daily digest for the local day before, and on a local Monday the week's
// numbers too (the seven days up to that day). Null when it is not the crew's digest hour, or its time zone is unknown.
export function due(crew: { digestHour: number; timezone: string }, now: number): { day: string; weekly: boolean } | null {
  let local: { day: string; hour: number; weekday: number };
  try {
    local = localTime(now, crew.timezone);
  } catch {
    return null;
  }
  if (!isDigestHour(local.hour, crew.digestHour)) return null;
  return { day: shiftDay(local.day, -1), weekly: local.weekday === 1 };
}

async function digestFor(ctx: QueryCtx, crewId: Id<"crews">, day: string, which: Doc<"digests">["kind"]): Promise<Doc<"digests"> | null> {
  const rows = await ctx.db
    .query("digests")
    .withIndex("by_crew_day", function (q) {
      return q.eq("crewId", crewId).eq("day", day);
    })
    .collect();
  return rows.find(function (d) { return d.kind === which; }) ?? null;
}

// Every hour (crons.ts). `now` is for tests and for running it by hand: npx convex run digests:tick '{"now": 1760000000000}'
export const tick = internalMutation({
  args: { now: v.optional(v.number()) },
  returns: v.object({ daily: v.number(), weekly: v.number() }),
  handler: async function (ctx, args) {
    const now = args.now ?? Date.now();
    let daily = 0;
    let weekly = 0;
    for (const crew of await ctx.db.query("crews").collect()) {
      if (!limitsFor(crew).digest) continue;
      const when = due(crew, now);
      if (when === null) continue;
      if ((await digestFor(ctx, crew._id, when.day, "daily")) === null) {
        await ctx.scheduler.runAfter(0, internal.digests.writeDaily, { crewId: crew._id, day: when.day });
        daily += 1;
      }
      if (when.weekly && (await digestFor(ctx, crew._id, when.day, "weekly")) === null) {
        await ctx.scheduler.runAfter(0, internal.digests.writeWeekly, { crewId: crew._id, day: when.day });
        weekly += 1;
      }
    }
    return { daily, weekly };
  },
});

// One local day of a crew for the writer: the wire's events (ships, walkthroughs, hand-offs, heads-ups, props, saves,
// notes, shouts), the day's other ledger lines and the day's numbers. Someone who hides from the board is left out by
// name, and so is anything with someone outside the crew. Null when the crew is gone or its plan has no digest.
export const material = internalQuery({
  args: { crewId: v.id("crews"), day: v.string() },
  returns: v.union(v.null(), digestMaterial),
  handler: async function (ctx, args): Promise<DigestMaterial | null> {
    const crew = await ctx.db.get("crews", args.crewId);
    if (crew === null || !limitsFor(crew).digest) return null;
    const { from, to } = dayWindow(args.day, crew.timezone);
    const members = await memberIdsOf(ctx, crew._id);
    const names = new Map<Id<"hackers">, string>();
    for (const id of members) {
      const hacker = await ctx.db.get("hackers", id);
      if (hacker === null || hacker.hideFromBoards === true) continue;
      names.set(id, shortName({ handle: hacker.handle, name: (await supersetCard(ctx, id))?.name }));
    }
    const m: DigestMaterial = {
      crew: crew.name,
      day: args.day,
      ships: [],
      walkthroughs: [],
      handoffs: [],
      headsups: [],
      props: [],
      saves: [],
      notes: [],
      shouts: [],
      work: [],
      numbers: await crewNumbers(ctx, members, from, to),
    };
    const events: Doc<"feed">[] = [];
    for (const id of names.keys()) {
      events.push(...(await ctx.db
        .query("feed")
        .withIndex("by_hacker_at", function (q) {
          return q.eq("hackerId", id).gte("at", from).lt("at", to);
        })
        .collect()));
    }
    events.sort(function (a, b) { return a.at - b.at; });
    const shippedLines = new Set<Id<"ledger">>();
    for (const e of events) {
      const who = names.get(e.hackerId);
      const other = e.otherHackerId === undefined ? undefined : names.get(e.otherHackerId);
      if (who === undefined || (e.otherHackerId !== undefined && other === undefined)) continue;
      if (e.kind === "ship") {
        const line = e.ledgerId === undefined ? null : await ctx.db.get("ledger", e.ledgerId);
        if (e.ledgerId !== undefined) shippedLines.add(e.ledgerId);
        m.ships.push({ who, text: e.text ?? line?.did ?? "", url: e.url ?? line?.pr, walkthrough: line?.walkthrough });
      } else if (e.kind === "walkthrough" && e.url !== undefined && (e.ledgerId === undefined || !shippedLines.has(e.ledgerId))) {
        m.walkthroughs.push({ who, text: e.text ?? "their ship", url: e.url });
      } else if (e.kind === "handoff") {
        m.handoffs.push({ who, forWho: other ?? "a crewmate", text: e.text ?? "", url: e.url });
      } else if (e.kind === "headsup") {
        m.headsups.push({ who, other: other ?? "a crewmate" });
      } else if (e.kind === "props" && e.fromCustomer === true) {
        const said = customerProps(e.text);
        m.props.push({ who: said.toCrew ? "The crew" : who, text: said.words, fromCustomer: true });
      } else if (e.kind === "props" && other !== undefined) {
        const about = e.about === undefined ? null : await ctx.db.get("feed", e.about);
        m.props.push({ who: other, from: who, text: about?.text, fromCustomer: false });
      } else if (e.kind === "save") {
        m.saves.push({ who, text: e.text ?? "" });
      } else if (e.kind === "note") {
        m.notes.push({ who, text: e.text ?? "" });
      } else if (e.kind === "shout") {
        m.shouts.push({ who, text: e.text ?? "" });
      }
    }
    for (const id of names.keys()) {
      const lines = await ctx.db
        .query("ledger")
        .withIndex("by_hacker_at", function (q) {
          return q.eq("hackerId", id).gte("at", from).lt("at", to);
        })
        .collect();
      for (const l of lines) {
        const who = names.get(id);
        if (who !== undefined && l.shipped !== true && m.work.length < MAX_WORK) m.work.push({ who, did: l.did });
      }
    }
    return m;
  },
});

// Keeps a digest once per crew, day and kind; puts its first line on the wire (as the leader's line, since the Operator
// has no row of its own) and posts it to Slack when the crew has a webhook. Null when it was already written.
async function keep(ctx: MutationCtx, crew: Doc<"crews">, day: string, which: Doc<"digests">["kind"], text: string, usd: number | undefined): Promise<Id<"digests"> | null> {
  if ((await digestFor(ctx, crew._id, day, which)) !== null) return null;
  const now = Date.now();
  const body = clip(text);
  const digestId = await ctx.db.insert("digests", { crewId: crew._id, day, kind: which, text: body, writtenAt: now, usd });
  const first = body.split("\n")[0] ?? body;
  await addToFeed(ctx, { kind: "digest", hackerId: crew.leaderId, text: first, digestId, at: now });
  if (crew.slackWebhook !== undefined) await ctx.scheduler.runAfter(0, internal.slack.post, { crewId: crew._id, text: body, digestId });
  return digestId;
}

export const save = internalMutation({
  args: { crewId: v.id("crews"), day: v.string(), kind, text: v.string(), usd: v.optional(v.number()) },
  returns: v.union(v.null(), v.id("digests")),
  handler: async function (ctx, args) {
    const crew = await ctx.db.get("crews", args.crewId);
    if (crew === null) return null;
    return await keep(ctx, crew, args.day, args.kind, args.text, args.usd);
  },
});

// Yesterday in <crew>: the day's material, written by the Operator (lib/digest.ts), kept and posted. A quiet day has
// no digest.
export const writeDaily = internalAction({
  args: { crewId: v.id("crews"), day: v.string() },
  returns: v.null(),
  handler: async function (ctx, args): Promise<null> {
    const m: DigestMaterial | null = await ctx.runQuery(internal.digests.material, { crewId: args.crewId, day: args.day });
    if (m === null || isQuiet(m)) return null;
    const written = await writeDigest(m);
    await ctx.runMutation(internal.digests.save, { crewId: args.crewId, day: args.day, kind: "daily", text: written.text, usd: written.usd });
    return null;
  },
});

// The week's four numbers, for the seven local days up to `day`. No model call. Nothing when all four are zero.
export const writeWeekly = internalMutation({
  args: { crewId: v.id("crews"), day: v.string() },
  returns: v.union(v.null(), v.id("digests")),
  handler: async function (ctx, args) {
    const crew = await ctx.db.get("crews", args.crewId);
    if (crew === null || !limitsFor(crew).digest) return null;
    const from = startOfDay(shiftDay(args.day, -6), crew.timezone);
    const { to } = dayWindow(args.day, crew.timezone);
    const text = weeklyText(crew.name, await crewNumbers(ctx, await memberIdsOf(ctx, crew._id), from, to));
    if (text === null) return null;
    return await keep(ctx, crew, args.day, "weekly", text, undefined);
  },
});

const digestView = v.object({
  _id: v.id("digests"),
  day: v.string(),
  text: v.string(),
  writtenAt: v.number(),
  postedAt: v.optional(v.number()),
  postError: v.optional(v.string()),
});

function viewOf(d: Doc<"digests">) {
  return { _id: d._id, day: d.day, text: d.text, writtenAt: d.writtenAt, postedAt: d.postedAt, postError: d.postError };
}

// My crew's latest daily digest and latest weekly numbers, for "Yesterday" in the HUD and the menu bar.
export const latest = query({
  args: {},
  returns: v.object({ daily: v.union(v.null(), digestView), weekly: v.union(v.null(), digestView) }),
  handler: async function (ctx) {
    const me = await requireHacker(ctx);
    const crew = await crewOf(ctx, me._id);
    if (crew === null) return { daily: null, weekly: null };
    const recent = await ctx.db
      .query("digests")
      .withIndex("by_crew", function (q) {
        return q.eq("crewId", crew._id);
      })
      .order("desc")
      .take(30);
    const daily = recent.find(function (d) { return d.kind === "daily"; });
    const weekly = recent.find(function (d) { return d.kind === "weekly"; });
    return { daily: daily === undefined ? null : viewOf(daily), weekly: weekly === undefined ? null : viewOf(weekly) };
  },
});
