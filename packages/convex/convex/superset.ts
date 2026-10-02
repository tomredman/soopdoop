// ABOUTME: Links a hacker to their public Superset leaderboard profile and keeps a small copy fresh for their friends.
// ABOUTME: Reads only the page its owner chose to publish (superset.sh/md/user/<handle>); keeps no token counts, cost or rank.
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { action, internalAction, internalMutation, internalQuery, mutation } from "./_generated/server";
import { hackerFor, requireHacker, requireIdentity } from "./lib/auth";
import { nameCheck, normalizeHandle, parseProfileMarkdown, profileMarkdownUrl, type SupersetProfile } from "./lib/supersetProfile";
import { supersetProfileFields } from "./schema";

const profileValidator = v.object(supersetProfileFields);

// What the rail shows for a linked hacker, to their friends and to themselves.
export const supersetCardView = v.object(supersetProfileFields);

export async function supersetCard(ctx: QueryCtx, hackerId: Id<"hackers">) {
  const row = await ctx.db
    .query("supersetProfiles")
    .withIndex("by_hacker", function (q) {
      return q.eq("hackerId", hackerId);
    })
    .unique();
  if (row === null) return undefined;
  return { handle: row.handle, name: row.name, tier: row.tier, achievements: row.achievements, models: row.models.slice(0, 3) };
}

// The profile, or null when Superset has no public profile for the handle. Throws when Superset cannot be read.
async function fetchProfile(handle: string): Promise<SupersetProfile | null> {
  const res = await fetch(profileMarkdownUrl(handle), { headers: { accept: "text/markdown" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Superset answered ${res.status} for @${handle}. Try again in a minute.`);
  const profile = parseProfileMarkdown(await res.text());
  if (profile === null) throw new Error("Superset's profile page has changed shape, so soopdoop could not read it.");
  return profile;
}

async function store(ctx: MutationCtx, hackerId: Id<"hackers">, profile: SupersetProfile, fetchedAt: number): Promise<void> {
  const row = { hackerId, ...profile, fetchedAt };
  const existing = await ctx.db
    .query("supersetProfiles")
    .withIndex("by_hacker", function (q) {
      return q.eq("hackerId", hackerId);
    })
    .unique();
  if (existing === null) await ctx.db.insert("supersetProfiles", row);
  else await ctx.db.replace("supersetProfiles", existing._id, row);
}

// The rail calls this with the Superset handle the hacker typed, or with `auto` right after they pick a soopdoop
// handle (Superset and soopdoop handles have the same shape, so many people will use the same one).
export const linkProfile = action({
  args: { handle: v.string(), auto: v.optional(v.boolean()) },
  returns: v.object({ handle: v.string(), name: v.optional(v.string()) }),
  handler: async function (ctx, args) {
    const identity = await requireIdentity(ctx);
    const handle = normalizeHandle(args.handle);
    if (handle === null) {
      throw new Error("A Superset handle is 2 to 39 lowercase letters, digits and single hyphens, like ada-lovelace.");
    }
    const profile = await fetchProfile(handle);
    if (profile === null) {
      throw new Error(`Superset has no public profile for @${handle}. Check the handle, or publish your profile in Superset first.`);
    }
    // A light check that this is the caller's own profile: the page's name must match the name in their Superset sign-in.
    const check = nameCheck(profile.name, identity.name);
    if (check === "mismatch") {
      throw new Error(`@${handle} on Superset is ${profile.name ?? "someone else"}, but you signed in as ${identity.name ?? "someone else"}. Link your own profile.`);
    }
    if (check === "unknown" && args.auto === true) throw new Error("Not linked: no name to compare.");
    await ctx.runMutation(internal.superset.save, { supersetUserId: identity.subject, profile, fetchedAt: Date.now() });
    return profile.name === undefined ? { handle: profile.handle } : { handle: profile.handle, name: profile.name };
  },
});

export const save = internalMutation({
  args: { supersetUserId: v.string(), profile: profileValidator, fetchedAt: v.number() },
  returns: v.null(),
  handler: async function (ctx, args) {
    const hacker = await hackerFor(ctx, args.supersetUserId);
    if (hacker === null) throw new Error("Pick a soopdoop handle first.");
    const taken = await ctx.db
      .query("supersetProfiles")
      .withIndex("by_handle", function (q) {
        return q.eq("handle", args.profile.handle);
      })
      .first();
    if (taken !== null && taken.hackerId !== hacker._id) {
      throw new Error(`@${args.profile.handle} is already linked to another soopdoop hacker.`);
    }
    await store(ctx, hacker._id, args.profile, args.fetchedAt);
    return null;
  },
});

export const unlinkProfile = mutation({
  args: {},
  returns: v.null(),
  handler: async function (ctx) {
    const me = await requireHacker(ctx);
    const rows = await ctx.db
      .query("supersetProfiles")
      .withIndex("by_hacker", function (q) {
        return q.eq("hackerId", me._id);
      })
      .collect();
    for (const row of rows) await ctx.db.delete("supersetProfiles", row._id);
    return null;
  },
});

export const linked = internalQuery({
  args: {},
  returns: v.array(v.object({ hackerId: v.id("hackers"), handle: v.string() })),
  handler: async function (ctx) {
    const rows = await ctx.db.query("supersetProfiles").collect();
    return rows.map(function (r) {
      return { hackerId: r.hackerId, handle: r.handle };
    });
  },
});

// Writes one refreshed profile. A null profile means the owner unpublished it, so soopdoop drops its copy too.
export const refreshed = internalMutation({
  args: { hackerId: v.id("hackers"), handle: v.string(), profile: v.union(profileValidator, v.null()), fetchedAt: v.number() },
  returns: v.null(),
  handler: async function (ctx, args) {
    const row = await ctx.db
      .query("supersetProfiles")
      .withIndex("by_hacker", function (q) {
        return q.eq("hackerId", args.hackerId);
      })
      .unique();
    // Unlinked, or linked to another handle, while the fetch ran.
    if (row === null || row.handle !== args.handle) return null;
    if (args.profile === null) await ctx.db.delete("supersetProfiles", row._id);
    else await store(ctx, args.hackerId, args.profile, args.fetchedAt);
    return null;
  },
});

// Every 6 hours (crons.ts). Superset caches these pages for an hour, so more often would not be fresher.
export const refreshAll = internalAction({
  args: {},
  returns: v.null(),
  handler: async function (ctx) {
    const rows = await ctx.runQuery(internal.superset.linked, {});
    for (const row of rows) {
      try {
        const profile = await fetchProfile(row.handle);
        await ctx.runMutation(internal.superset.refreshed, { hackerId: row.hackerId, handle: row.handle, profile, fetchedAt: Date.now() });
      } catch (e) {
        // Superset down or the page changed: keep the last good copy and try again next time.
        console.warn(`superset profile @${row.handle}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return null;
  },
});
