// ABOUTME: Hacker identity: pick a handle, read your own profile, change presence-sharing settings, focus mode, and the
// ABOUTME: Mac's time zone. A hacker row is created on first sign-in when the handle is chosen.
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { checkHacker, requireHacker, requireIdentity } from "./lib/auth";
import { crewOf, DEFAULT_TIMEZONE } from "./lib/crew";
import { canonicalTimezone } from "./lib/localTime";
import { supersetCard, supersetCardView } from "./superset";

const HANDLE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const me = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id("hackers"),
      handle: v.string(),
      shareWorkspaceNames: v.boolean(),
      shareAgentNames: v.boolean(),
      focusUntil: v.optional(v.number()),
      hideFromBoards: v.boolean(),
      superset: v.optional(supersetCardView),
    }),
  ),
  handler: async function (ctx) {
    // Signed out, or signed in without a handle yet: null, so the rail can show the right screen.
    const hacker = await checkHacker(ctx);
    if (hacker === null) return null;
    return {
      _id: hacker._id,
      handle: hacker.handle,
      shareWorkspaceNames: hacker.shareWorkspaceNames,
      shareAgentNames: hacker.shareAgentNames,
      focusUntil: hacker.focusUntil,
      hideFromBoards: hacker.hideFromBoards === true,
      superset: await supersetCard(ctx, hacker._id),
    };
  },
});

export const claimHandle = mutation({
  args: { handle: v.string() },
  returns: v.id("hackers"),
  handler: async function (ctx, args) {
    const identity = await requireIdentity(ctx);
    const handle = args.handle.toLowerCase();
    if (handle.length < 2 || handle.length > 39 || !HANDLE.test(handle)) {
      throw new ConvexError("A handle is 2 to 39 characters: lowercase letters, digits, single hyphens.");
    }
    const taken = await ctx.db
      .query("hackers")
      .withIndex("by_handle", function (q) {
        return q.eq("handle", handle);
      })
      .unique();
    if (taken !== null) throw new ConvexError("That handle is taken.");
    const existing = await ctx.db
      .query("hackers")
      .withIndex("by_supersetUserId", function (q) {
        return q.eq("supersetUserId", identity.subject);
      })
      .unique();
    if (existing !== null) throw new ConvexError("You already have a handle.");
    return await ctx.db.insert("hackers", {
      handle,
      supersetUserId: identity.subject,
      shareWorkspaceNames: false,
      shareAgentNames: false,
      createdAt: Date.now(),
    });
  },
});

export const updateSharing = mutation({
  args: { shareWorkspaceNames: v.boolean(), shareAgentNames: v.boolean() },
  returns: v.null(),
  handler: async function (ctx, args) {
    const hacker = await requireHacker(ctx);
    await ctx.db.patch("hackers", hacker._id, args);
    return null;
  },
});

// Focus mode hides the hacker from the rail and blocks knocks until it ends.
export const setFocus = mutation({
  args: { minutes: v.union(v.number(), v.null()) },
  returns: v.null(),
  handler: async function (ctx, args) {
    const hacker = await requireHacker(ctx);
    await ctx.db.patch("hackers", hacker._id, {
      focusUntil: args.minutes === null ? undefined : Date.now() + args.minutes * 60_000,
    });
    return null;
  },
});

// The Mac's time zone (an IANA name), sent by the rail when it starts. A crew's digest follows its leader's clock until
// the leader picks another time zone for it in Settings → Crew.
export const setTimezone = mutation({
  args: { timezone: v.string() },
  returns: v.null(),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const timezone = canonicalTimezone(args.timezone);
    if (timezone === null) throw new ConvexError("That is not a time zone soopdoop knows. Use a name like America/Toronto.");
    if (me.timezone === timezone) return null;
    await ctx.db.patch("hackers", me._id, { timezone });
    const crew = await crewOf(ctx, me._id);
    if (crew !== null && crew.leaderId === me._id && crew.timezone === (me.timezone ?? DEFAULT_TIMEZONE)) {
      await ctx.db.patch("crews", crew._id, { timezone });
    }
    return null;
  },
});

// Off the crew board for everyone else; the hacker still sees their own row.
export const setHideFromBoards = mutation({
  args: { hide: v.boolean() },
  returns: v.null(),
  handler: async function (ctx, args) {
    const hacker = await requireHacker(ctx);
    await ctx.db.patch("hackers", hacker._id, { hideFromBoards: args.hide });
    return null;
  },
});
