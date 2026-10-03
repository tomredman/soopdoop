// ABOUTME: Knocks: a short, expiring request for attention with one item attached.
// ABOUTME: Expiry is enforced by a scheduled function, so an ignored knock goes away even if no client is open.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";
import { areFriends } from "./friends";
import { requireHacker } from "./lib/auth";

const LIFETIMES = new Set([10_000, 30_000, 120_000]);

export const send = mutation({
  args: {
    toHandle: v.string(),
    item: v.object({
      kind: v.union(v.literal("link"), v.literal("file"), v.literal("session"), v.literal("page")),
      title: v.string(),
      url: v.optional(v.string()),
    }),
    note: v.optional(v.string()),
    lifetimeMs: v.optional(v.number()),
  },
  returns: v.id("knocks"),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const to = await ctx.db
      .query("hackers")
      .withIndex("by_handle", function (q) {
        return q.eq("handle", args.toHandle.toLowerCase());
      })
      .unique();
    if (to === null) throw new ConvexError("ain’t nobody with that handle");
    if (!(await areFriends(ctx, me._id, to._id))) throw new ConvexError("You can only knock on a friend.");
    const now = Date.now();
    if (to.focusUntil !== undefined && to.focusUntil > now) throw new ConvexError("They are in focus mode. Try later.");
    const lifetimeMs = args.lifetimeMs ?? 30_000;
    if (!LIFETIMES.has(lifetimeMs)) throw new ConvexError("A knock lasts 10 s, 30 s, or 2 min.");
    // At most one open knock from one sender to one receiver. A receiver has few open knocks: each ends within 2 min.
    const open = await ctx.db
      .query("knocks")
      .withIndex("by_to_outcome", function (q) {
        return q.eq("toHackerId", to._id).eq("outcome", "open");
      })
      .collect();
    if (open.some(function (k) { return k.fromHackerId === me._id; })) {
      throw new ConvexError("You already have a knock waiting with them.");
    }
    const id = await ctx.db.insert("knocks", {
      fromHackerId: me._id,
      toHackerId: to._id,
      item: args.item,
      note: args.note,
      lifetimeMs,
      expiresAt: now + lifetimeMs,
      outcome: "open",
      createdAt: now,
    });
    await ctx.scheduler.runAfter(lifetimeMs, internal.knocks.expire, { knockId: id });
    return id;
  },
});

export const expire = internalMutation({
  args: { knockId: v.id("knocks") },
  returns: v.null(),
  handler: async function (ctx, args) {
    const k = await ctx.db.get("knocks", args.knockId);
    if (k !== null && k.outcome === "open") {
      await ctx.db.patch("knocks", k._id, { outcome: "expired", decidedAt: Date.now() });
    }
    return null;
  },
});

export const decide = mutation({
  args: { knockId: v.id("knocks"), outcome: v.union(v.literal("opened"), v.literal("not-now")) },
  returns: v.null(),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const k = await ctx.db.get("knocks", args.knockId);
    if (k === null || k.toHackerId !== me._id) throw new ConvexError("Not your knock.");
    if (k.outcome !== "open") return null;
    await ctx.db.patch("knocks", k._id, { outcome: args.outcome, decidedAt: Date.now() });
    return null;
  },
});

const knockView = v.object({
  _id: v.id("knocks"),
  fromHandle: v.string(),
  item: v.object({
    kind: v.union(v.literal("link"), v.literal("file"), v.literal("session"), v.literal("page")),
    title: v.string(),
    url: v.optional(v.string()),
  }),
  note: v.optional(v.string()),
  expiresAt: v.number(),
  lifetimeMs: v.number(),
});

// The one knock the receiver should see now: the oldest open one. Others wait in the pending chip.
export const incoming = query({
  args: {},
  returns: v.object({ current: v.union(v.null(), knockView), pending: v.number() }),
  handler: async function (ctx) {
    const me = await requireHacker(ctx);
    const open = await ctx.db
      .query("knocks")
      .withIndex("by_to_outcome", function (q) {
        return q.eq("toHackerId", me._id).eq("outcome", "open");
      })
      .collect();
    open.sort(function (p, q) {
      return p.createdAt - q.createdAt;
    });
    const first = open[0];
    if (first === undefined) return { current: null, pending: 0 };
    const from = await ctx.db.get("hackers", first.fromHackerId);
    return {
      current: {
        _id: first._id,
        fromHandle: from === null ? "" : from.handle,
        item: first.item,
        note: first.note,
        expiresAt: first.expiresAt,
        lifetimeMs: first.lifetimeMs,
      },
      pending: open.length - 1,
    };
  },
});

// What the sender sees: "waiting", "they're looking", "not now", or nothing (expired knocks make no noise).
export const sent = query({
  args: {},
  returns: v.array(
    v.object({ _id: v.id("knocks"), toHandle: v.string(), outcome: v.string(), expiresAt: v.number() }),
  ),
  handler: async function (ctx) {
    const me = await requireHacker(ctx);
    const rows = await ctx.db
      .query("knocks")
      .withIndex("by_from_to", function (q) {
        return q.eq("fromHackerId", me._id);
      })
      .order("desc")
      .take(20);
    const out = [];
    for (const k of rows) {
      const to = await ctx.db.get("hackers", k.toHackerId);
      out.push({ _id: k._id, toHandle: to === null ? "" : to.handle, outcome: k.outcome, expiresAt: k.expiresAt });
    }
    return out;
  },
});
