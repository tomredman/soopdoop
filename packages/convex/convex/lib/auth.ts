// ABOUTME: Resolves the calling hacker for public functions.
// ABOUTME: Phase 1 uses the daemon token for the daemon and Convex auth identity for the rail; sign-in with Superset lands in Phase 1 step 4.
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

// The rail signs in through Convex auth. The identity's subject is the hacker's Superset user id
// once Superset OAuth is wired; until then it is the auth provider's subject.
export async function requireHacker(ctx: QueryCtx | MutationCtx): Promise<Doc<"hackers">> {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) throw new Error("Not signed in");
  const hacker = await ctx.db
    .query("hackers")
    .withIndex("by_supersetUserId", function (q) {
      return q.eq("supersetUserId", identity.subject);
    })
    .unique();
  if (hacker === null) throw new Error("No hacker for this sign-in. Pick a handle first.");
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
  if (daemon === null) throw new Error("Unknown daemon token");
  const hacker = await ctx.db.get(daemon.hackerId);
  if (hacker === null) throw new Error("Daemon token has no hacker");
  return { hacker, daemon };
}
