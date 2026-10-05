// ABOUTME: Flicks: a poke between friends. Flick back and the rally goes on. Catch one in its first 10 seconds and you take
// ABOUTME: XP from the flicker; 5 flicks in a row nobody catches earn a superflick, which takes XP and cannot be caught.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { areFriends } from "./friends";
import { requireHacker } from "./lib/auth";
import { xpOf } from "./play";

// Long enough to be seen, short enough that nothing waits around: every interruption expires.
export const FLICK_TTL_MS = 10 * 60 * 1000;
// A flick can be caught this long after it is sent, and catching it takes up to CATCH_XP from the flicker.
export const CATCH_MS = 10_000;
export const CATCH_XP = 5;
// This many flicks in a row that nobody catches earn one superflick, which takes up to SUPER_XP from its receiver.
export const SUPER_EVERY = 5;
export const SUPER_XP = 10;

async function friendByHandle(ctx: QueryCtx, me: Doc<"hackers">, raw: string): Promise<Doc<"hackers">> {
  const to = await ctx.db
    .query("hackers")
    .withIndex("by_handle", function (q) {
      return q.eq("handle", raw.replace(/^@/, "").toLowerCase());
    })
    .unique();
  if (to === null) throw new ConvexError("ain’t nobody with that handle");
  if (to._id === me._id) throw new ConvexError("You cannot flick yourself.");
  if (!(await areFriends(ctx, me._id, to._id))) throw new ConvexError("You can only flick a friend.");
  return to;
}

async function openFlick(ctx: QueryCtx, from: Id<"hackers">, to: Id<"hackers">, now: number): Promise<Doc<"flicks"> | null> {
  const open = await ctx.db
    .query("flicks")
    .withIndex("by_to_outcome", function (q) {
      return q.eq("toHackerId", to).eq("outcome", "open");
    })
    .collect();
  return open.find(function (f) { return f.fromHackerId === from && f.expiresAt > now; }) ?? null;
}

async function sentBy(ctx: QueryCtx, id: Id<"hackers">): Promise<Doc<"flicks">[]> {
  return await ctx.db
    .query("flicks")
    .withIndex("by_from_outcome", function (q) {
      return q.eq("fromHackerId", id);
    })
    .collect();
}

// Superflicks ready to use, and the clean flicks toward the next one. Every SUPER_EVERY flicks whose catch window
// closed without a catch earn one; being caught starts the count over. Superflicks themselves do not count.
export function superflicks(sent: Doc<"flicks">[]): { ready: number; clean: number } {
  let clean = 0;
  let earned = 0;
  let used = 0;
  // _creationTime, not createdAt: two flicks can share a millisecond, never a creation time.
  const inOrder = [...sent].sort(function (a, b) { return a._creationTime - b._creationTime; });
  for (const f of inOrder) {
    if (f.superflick === true) used += 1;
    else if (f.outcome === "caught") clean = 0;
    else if (f.safe === true) {
      clean += 1;
      if (clean === SUPER_EVERY) {
        earned += 1;
        clean = 0;
      }
    }
  }
  return { ready: Math.max(0, earned - used), clean };
}

export const send = mutation({
  args: { toHandle: v.string() },
  returns: v.object({ rally: v.number() }),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const to = await friendByHandle(ctx, me, args.toHandle);
    const now = Date.now();
    if (to.focusUntil !== undefined && to.focusUntil > now) throw new ConvexError(`@${to.handle} is in focus mode. The flick bounced.`);
    if ((await openFlick(ctx, me._id, to._id, now)) !== null) throw new ConvexError(`Wait for @${to.handle} to flick back.`);
    // Their open flick to me makes this a flick back: theirs ends and the rally goes on.
    const theirs = await openFlick(ctx, to._id, me._id, now);
    if (theirs !== null) await ctx.db.patch("flicks", theirs._id, { outcome: "flicked-back" });
    const rally = theirs === null ? 1 : theirs.rally + 1;
    const id = await ctx.db.insert("flicks", {
      fromHackerId: me._id,
      toHackerId: to._id,
      rally,
      outcome: "open",
      createdAt: now,
      expiresAt: now + FLICK_TTL_MS,
    });
    await ctx.scheduler.runAfter(CATCH_MS, internal.flicks.closeCatch, { flickId: id });
    await ctx.scheduler.runAfter(FLICK_TTL_MS, internal.flicks.expire, { flickId: id });
    return { rally };
  },
});

// The catch window closed: a flick nobody caught counts toward its sender's next superflick.
export const closeCatch = internalMutation({
  args: { flickId: v.id("flicks") },
  returns: v.null(),
  handler: async function (ctx, args) {
    const f = await ctx.db.get("flicks", args.flickId);
    if (f !== null && f.outcome !== "caught") await ctx.db.patch("flicks", f._id, { safe: true });
    return null;
  },
});

// Caught in time: the receiver takes up to CATCH_XP from the flicker, never more than they have.
export const catchFlick = mutation({
  args: { flickId: v.id("flicks") },
  returns: v.object({ fromHandle: v.string(), xp: v.number() }),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const f = await ctx.db.get("flicks", args.flickId);
    if (f === null || f.toHackerId !== me._id) throw new ConvexError("That is not your flick.");
    if (f.superflick === true) throw new ConvexError("Nobody catches a superflick.");
    const now = Date.now();
    if (f.outcome !== "open" || f.safe === true || now > f.createdAt + CATCH_MS) throw new ConvexError("Too slow. You can still flick back.");
    const xp = Math.min(CATCH_XP, await xpOf(ctx, f.fromHackerId));
    await ctx.db.patch("flicks", f._id, { outcome: "caught", caughtXp: xp, caughtAt: now });
    const from = await ctx.db.get("hackers", f.fromHackerId);
    return { fromHandle: from === null ? "" : from.handle, xp };
  },
});

// Uses one superflick on any friend: it takes up to SUPER_XP from them, focus mode or not, and cannot be caught.
export const superflick = mutation({
  args: { toHandle: v.string() },
  returns: v.object({ xp: v.number(), ready: v.number() }),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const to = await friendByHandle(ctx, me, args.toHandle);
    const { ready } = superflicks(await sentBy(ctx, me._id));
    if (ready === 0) throw new ConvexError(`No superflick yet. Flick ${SUPER_EVERY} times in a row without getting caught.`);
    const now = Date.now();
    const xp = Math.min(SUPER_XP, await xpOf(ctx, to._id));
    const id = await ctx.db.insert("flicks", {
      fromHackerId: me._id,
      toHackerId: to._id,
      rally: 0,
      outcome: "open",
      createdAt: now,
      expiresAt: now + FLICK_TTL_MS,
      superflick: true,
      superXp: xp,
    });
    await ctx.scheduler.runAfter(FLICK_TTL_MS, internal.flicks.expire, { flickId: id });
    return { xp, ready: ready - 1 };
  },
});

export const expire = internalMutation({
  args: { flickId: v.id("flicks") },
  returns: v.null(),
  handler: async function (ctx, args) {
    const f = await ctx.db.get("flicks", args.flickId);
    if (f !== null && f.outcome === "open") await ctx.db.patch("flicks", f._id, { outcome: "expired" });
    return null;
  },
});

// Who flicked me (newest first; a flick can be caught until catchUntil), whom I flicked and am waiting on, my flicks
// that were caught lately, and my superflicks.
export const mine = query({
  args: {},
  returns: v.object({
    incoming: v.array(v.object({
      _id: v.id("flicks"),
      fromHandle: v.string(),
      rally: v.number(),
      expiresAt: v.number(),
      catchUntil: v.number(),
      superflick: v.boolean(),
      xp: v.number(),
    })),
    waitingOn: v.array(v.string()),
    caught: v.array(v.object({ _id: v.id("flicks"), byHandle: v.string(), xp: v.number(), at: v.number() })),
    superflicks: v.object({ ready: v.number(), clean: v.number(), every: v.number() }),
  }),
  handler: async function (ctx) {
    const me = await requireHacker(ctx);
    const toMe = await ctx.db
      .query("flicks")
      .withIndex("by_to_outcome", function (q) {
        return q.eq("toHackerId", me._id).eq("outcome", "open");
      })
      .collect();
    const sent = await sentBy(ctx, me._id);
    toMe.sort(function (p, q) { return q.createdAt - p.createdAt; });
    const incoming = [];
    for (const f of toMe) {
      const from = await ctx.db.get("hackers", f.fromHackerId);
      if (from === null) continue;
      const catchable = f.superflick !== true && f.safe !== true;
      incoming.push({
        _id: f._id,
        fromHandle: from.handle,
        rally: f.rally,
        expiresAt: f.expiresAt,
        catchUntil: catchable ? f.createdAt + CATCH_MS : 0,
        superflick: f.superflick === true,
        xp: f.superXp ?? 0,
      });
    }
    const waitingOn: string[] = [];
    for (const f of sent) {
      if (f.outcome !== "open") continue;
      const to = await ctx.db.get("hackers", f.toHackerId);
      if (to !== null && !waitingOn.includes(to.handle)) waitingOn.push(to.handle);
    }
    const caughtRows = sent
      .filter(function (f) { return f.outcome === "caught"; })
      .sort(function (p, q) { return (q.caughtAt ?? 0) - (p.caughtAt ?? 0); })
      .slice(0, 5);
    const caught = [];
    for (const f of caughtRows) {
      const by = await ctx.db.get("hackers", f.toHackerId);
      caught.push({ _id: f._id, byHandle: by === null ? "" : by.handle, xp: f.caughtXp ?? 0, at: f.caughtAt ?? f.createdAt });
    }
    return { incoming, waitingOn, caught, superflicks: { ...superflicks(sent), every: SUPER_EVERY } };
  },
});
