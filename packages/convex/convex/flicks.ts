// ABOUTME: Flicks: a poke between friends, pointless and for fun. Flick a friend, they flick back, and each flick back adds
// ABOUTME: one to the rally. An open flick expires through a scheduled function, so an ignored one goes away by itself.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { areFriends } from "./friends";
import { requireHacker } from "./lib/auth";

// Long enough to be seen, short enough that nothing waits around: every interruption expires.
export const FLICK_TTL_MS = 10 * 60 * 1000;

async function openFlick(ctx: QueryCtx, from: Id<"hackers">, to: Id<"hackers">, now: number): Promise<Doc<"flicks"> | null> {
  const open = await ctx.db
    .query("flicks")
    .withIndex("by_to_outcome", function (q) {
      return q.eq("toHackerId", to).eq("outcome", "open");
    })
    .collect();
  return open.find(function (f) { return f.fromHackerId === from && f.expiresAt > now; }) ?? null;
}

export const send = mutation({
  args: { toHandle: v.string() },
  returns: v.object({ rally: v.number() }),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const to = await ctx.db
      .query("hackers")
      .withIndex("by_handle", function (q) {
        return q.eq("handle", args.toHandle.replace(/^@/, "").toLowerCase());
      })
      .unique();
    if (to === null) throw new ConvexError("ain’t nobody with that handle");
    if (to._id === me._id) throw new ConvexError("You cannot flick yourself.");
    if (!(await areFriends(ctx, me._id, to._id))) throw new ConvexError("You can only flick a friend.");
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
    await ctx.scheduler.runAfter(FLICK_TTL_MS, internal.flicks.expire, { flickId: id });
    return { rally };
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

// Who flicked me and is waiting for a flick back (newest first), and whom I flicked and am waiting on.
export const mine = query({
  args: {},
  returns: v.object({
    incoming: v.array(v.object({ _id: v.id("flicks"), fromHandle: v.string(), rally: v.number(), expiresAt: v.number() })),
    waitingOn: v.array(v.string()),
  }),
  handler: async function (ctx) {
    const me = await requireHacker(ctx);
    const toMe = await ctx.db
      .query("flicks")
      .withIndex("by_to_outcome", function (q) {
        return q.eq("toHackerId", me._id).eq("outcome", "open");
      })
      .collect();
    const fromMe = await ctx.db
      .query("flicks")
      .withIndex("by_from_outcome", function (q) {
        return q.eq("fromHackerId", me._id).eq("outcome", "open");
      })
      .collect();
    toMe.sort(function (p, q) { return q.createdAt - p.createdAt; });
    const incoming = [];
    for (const f of toMe) {
      const from = await ctx.db.get("hackers", f.fromHackerId);
      if (from !== null) incoming.push({ _id: f._id, fromHandle: from.handle, rally: f.rally, expiresAt: f.expiresAt });
    }
    const waitingOn = [];
    for (const f of fromMe) {
      const to = await ctx.db.get("hackers", f.toHackerId);
      if (to !== null) waitingOn.push(to.handle);
    }
    return { incoming, waitingOn };
  },
});
