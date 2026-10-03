// ABOUTME: Resolves the caller for public functions: the daemon by its token, the rail by its Superset sign-in.
// ABOUTME: Every public function calls one of these first (the require-access-control lint rule checks it).
import { ConvexError } from "convex/values";
import type { Auth, UserIdentity } from "convex/server";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), function (b) {
    return b.toString(16).padStart(2, "0");
  }).join("");
}

export async function hashToken(token: string): Promise<string> {
  return sha256Hex(token);
}

// The rail signs in with Superset. The identity's subject is the Superset user id. Actions have ctx.auth too.
export async function requireIdentity(ctx: { auth: Auth }): Promise<UserIdentity> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) throw new ConvexError("Not signed in");
  return identity;
}

export async function hackerFor(ctx: QueryCtx | MutationCtx, supersetUserId: string): Promise<Doc<"hackers"> | null> {
  return await ctx.db
    .query("hackers")
    .withIndex("by_supersetUserId", function (q) {
      return q.eq("supersetUserId", supersetUserId);
    })
    .unique();
}

// The caller's own hacker row, or null when signed out or before a handle is picked.
// For reads that only ever show callers their own row.
export async function checkHacker(ctx: QueryCtx | MutationCtx): Promise<Doc<"hackers"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) return null;
  return await hackerFor(ctx, identity.subject);
}

export async function requireHacker(ctx: QueryCtx | MutationCtx): Promise<Doc<"hackers">> {
  const identity = await requireIdentity(ctx);
  const hacker = await hackerFor(ctx, identity.subject);
  if (hacker === null) throw new ConvexError("No hacker for this sign-in. Pick a handle first.");
  return hacker;
}

// The daemon presents a token it was given at pairing time. Tokens are stored hashed.
export async function requireDaemon(
  ctx: QueryCtx | MutationCtx,
  token: string,
): Promise<{ hacker: Doc<"hackers">; daemon: Doc<"daemonTokens"> }> {
  const tokenHash = await hashToken(token);
  const daemon = await ctx.db
    .query("daemonTokens")
    .withIndex("by_tokenHash", function (q) {
      return q.eq("tokenHash", tokenHash);
    })
    .unique();
  if (daemon === null) throw new ConvexError("Unknown daemon token");
  const hacker = await ctx.db.get("hackers", daemon.hackerId);
  if (hacker === null) throw new ConvexError("Daemon token has no hacker");
  return { hacker, daemon };
}
