// ABOUTME: Friendship writes shared by invite links and by invites made for a Superset handle. One row per pair, in
// ABOUTME: either direction; "accepted" makes two hackers friends.
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

export async function friendshipBetween(ctx: QueryCtx, x: Id<"hackers">, y: Id<"hackers">): Promise<Doc<"friendships"> | null> {
  const xy = await ctx.db
    .query("friendships")
    .withIndex("by_a_b", function (q) {
      return q.eq("a", x).eq("b", y);
    })
    .unique();
  if (xy !== null) return xy;
  return await ctx.db
    .query("friendships")
    .withIndex("by_a_b", function (q) {
      return q.eq("a", y).eq("b", x);
    })
    .unique();
}

// Friends now: accepts a waiting request in either direction, or adds an accepted row.
export async function makeFriends(ctx: MutationCtx, inviter: Id<"hackers">, invitee: Id<"hackers">): Promise<void> {
  const row = await friendshipBetween(ctx, inviter, invitee);
  if (row === null) await ctx.db.insert("friendships", { a: inviter, b: invitee, status: "accepted", createdAt: Date.now() });
  else if (row.status !== "accepted") await ctx.db.patch("friendships", row._id, { status: "accepted" });
}

// Invites made for this Superset handle before its owner joined. Linking the profile shows who they are, so each open
// invite becomes a friendship, as if they had used the link. Returns the inviters' handles.
export async function redeemInvitesFor(ctx: MutationCtx, me: Doc<"hackers">, supersetHandle: string): Promise<string[]> {
  const now = Date.now();
  const invites = await ctx.db
    .query("invites")
    .withIndex("by_forHandle", function (q) {
      return q.eq("forHandle", supersetHandle);
    })
    .collect();
  const from: string[] = [];
  for (const invite of invites) {
    if (invite.usedByHackerId !== undefined || invite.expiresAt < now || invite.fromHackerId === me._id) continue;
    await ctx.db.patch("invites", invite._id, { usedByHackerId: me._id });
    await makeFriends(ctx, invite.fromHackerId, me._id);
    const inviter = await ctx.db.get("hackers", invite.fromHackerId);
    if (inviter !== null && !from.includes(inviter.handle)) from.push(inviter.handle);
  }
  return from;
}
