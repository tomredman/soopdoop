// ABOUTME: Friends: request by handle, accept, invite links (7 days, one use), and the friend list with live presence.
// ABOUTME: Presence shown to a friend respects the owner's sharing settings and focus mode.
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { requireHacker } from "./lib/auth";
import { supersetCard, supersetCardView } from "./superset";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function acceptedFriendIds(ctx: QueryCtx, me: Id<"hackers">): Promise<Id<"hackers">[]> {
  const asA = await ctx.db
    .query("friendships")
    .withIndex("by_a_b", function (q) {
      return q.eq("a", me);
    })
    .collect();
  const asB = await ctx.db
    .query("friendships")
    .withIndex("by_b", function (q) {
      return q.eq("b", me);
    })
    .collect();
  const ids: Id<"hackers">[] = [];
  for (const f of asA) if (f.status === "accepted") ids.push(f.b);
  for (const f of asB) if (f.status === "accepted") ids.push(f.a);
  return ids;
}

export async function areFriends(ctx: QueryCtx, x: Id<"hackers">, y: Id<"hackers">): Promise<boolean> {
  const ids = await acceptedFriendIds(ctx, x);
  return ids.includes(y);
}

const presenceView = v.object({
  hackerId: v.id("hackers"),
  handle: v.string(),
  led: v.union(v.literal("g"), v.literal("b"), v.literal("x")),
  inFocus: v.boolean(),
  agentCount: v.number(),
  // Only present when the owner linked their public Superset profile.
  superset: v.optional(supersetCardView),
  // Only present when the owner shares them.
  agents: v.optional(
    v.array(
      v.object({
        name: v.string(),
        workspace: v.optional(v.string()),
        status: v.string(),
      }),
    ),
  ),
});

function presenceFor(hacker: Doc<"hackers">, subsets: Doc<"subsets">[], now: number, superset: Awaited<ReturnType<typeof supersetCard>>) {
  const inFocus = hacker.focusUntil !== undefined && hacker.focusUntil > now;
  // A subset is live if the daemon reported within the last 90 s.
  const live = subsets.filter(function (s) {
    return now - s.updatedAt < 90_000;
  });
  const agents = live.flatMap(function (s) {
    return s.agents.filter(function (a) {
      return a.open;
    });
  });
  const anyWorking = agents.some(function (a) {
    return a.status === "working";
  });
  const led: "g" | "b" | "x" = inFocus || live.length === 0 ? "x" : anyWorking ? "g" : "b";
  return {
    hackerId: hacker._id,
    handle: hacker.handle,
    led,
    inFocus,
    agentCount: inFocus ? 0 : agents.length,
    superset,
    agents:
      inFocus || !hacker.shareAgentNames
        ? undefined
        : agents.map(function (a) {
            return {
              name: a.name,
              workspace: hacker.shareWorkspaceNames ? a.workspace : undefined,
              status: a.status,
            };
          }),
  };
}

export const list = query({
  args: {},
  returns: v.array(presenceView),
  handler: async function (ctx) {
    const me = await requireHacker(ctx);
    const ids = await acceptedFriendIds(ctx, me._id);
    const now = Date.now();
    const out = [];
    for (const id of ids) {
      const hacker = await ctx.db.get("hackers", id);
      if (hacker === null) continue;
      const subsets = await ctx.db
        .query("subsets")
        .withIndex("by_hacker_machine", function (q) {
          return q.eq("hackerId", id);
        })
        .collect();
      out.push(presenceFor(hacker, subsets, now, await supersetCard(ctx, id)));
    }
    out.sort(function (p, q) {
      return p.handle.localeCompare(q.handle);
    });
    return out;
  },
});

export const request = mutation({
  args: { handle: v.string() },
  returns: v.null(),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const other = await ctx.db
      .query("hackers")
      .withIndex("by_handle", function (q) {
        return q.eq("handle", args.handle.toLowerCase());
      })
      .unique();
    if (other === null) throw new Error("No hacker with that handle.");
    if (other._id === me._id) throw new Error("That is you.");
    if (await areFriends(ctx, me._id, other._id)) return null;
    // A request in the other direction becomes an acceptance.
    const theirs = await ctx.db
      .query("friendships")
      .withIndex("by_a_b", function (q) {
        return q.eq("a", other._id).eq("b", me._id);
      })
      .unique();
    if (theirs !== null) {
      await ctx.db.patch("friendships", theirs._id, { status: "accepted" });
      return null;
    }
    const mine = await ctx.db
      .query("friendships")
      .withIndex("by_a_b", function (q) {
        return q.eq("a", me._id).eq("b", other._id);
      })
      .unique();
    if (mine === null) {
      await ctx.db.insert("friendships", { a: me._id, b: other._id, status: "requested", createdAt: Date.now() });
    }
    return null;
  },
});

export const accept = mutation({
  args: { friendshipId: v.id("friendships") },
  returns: v.null(),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const f = await ctx.db.get("friendships", args.friendshipId);
    if (f === null || f.b !== me._id) throw new Error("No such request.");
    await ctx.db.patch("friendships", f._id, { status: "accepted" });
    return null;
  },
});

export const pending = query({
  args: {},
  returns: v.array(v.object({ friendshipId: v.id("friendships"), handle: v.string() })),
  handler: async function (ctx) {
    const me = await requireHacker(ctx);
    const rows = await ctx.db
      .query("friendships")
      .withIndex("by_b", function (q) {
        return q.eq("b", me._id);
      })
      .collect();
    const out = [];
    for (const f of rows) {
      if (f.status !== "requested") continue;
      const other = await ctx.db.get("hackers", f.a);
      if (other !== null) out.push({ friendshipId: f._id, handle: other.handle });
    }
    return out;
  },
});

export const createInvite = mutation({
  args: {},
  returns: v.string(),
  handler: async function (ctx) {
    const me = await requireHacker(ctx);
    const token = crypto.randomUUID().replace(/-/g, "");
    await ctx.db.insert("invites", { fromHackerId: me._id, token, expiresAt: Date.now() + INVITE_TTL_MS });
    return token;
  },
});

export const redeemInvite = mutation({
  args: { token: v.string() },
  returns: v.string(),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const invite = await ctx.db
      .query("invites")
      .withIndex("by_token", function (q) {
        return q.eq("token", args.token);
      })
      .unique();
    if (invite === null || invite.usedByHackerId !== undefined || invite.expiresAt < Date.now()) {
      throw new Error("This invite link is no longer valid.");
    }
    if (invite.fromHackerId === me._id) throw new Error("That is your own invite.");
    await ctx.db.patch("invites", invite._id, { usedByHackerId: me._id });
    if (!(await areFriends(ctx, me._id, invite.fromHackerId))) {
      await ctx.db.insert("friendships", { a: invite.fromHackerId, b: me._id, status: "accepted", createdAt: Date.now() });
    }
    const from = await ctx.db.get("hackers", invite.fromHackerId);
    return from === null ? "" : from.handle;
  },
});
