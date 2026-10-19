// ABOUTME: Crew scope for the whole backend: a hacker's crew, their crewmates (crew members, or friends when in no crew),
// ABOUTME: the leader check, and joining a crew through an invite. One crew per hacker, at most 8 people (docs/plan-crews.html §11).
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { acceptedFriendIds, areFriends } from "./friendships";

// A crew has at most 8 people, the leader included (docs/spec.md §6).
export const MAX_CREW = 8;
// The digest goes out at 9:00 in the crew's time zone until the leader picks another hour.
export const DEFAULT_DIGEST_HOUR = 9;
export const DEFAULT_TIMEZONE = "UTC";

// The crew this hacker is in, or null.
export async function crewOf(ctx: QueryCtx, hackerId: Id<"hackers">): Promise<Doc<"crews"> | null> {
  const row = await ctx.db
    .query("crewMembers")
    .withIndex("by_hacker", function (q) {
      return q.eq("hackerId", hackerId);
    })
    .first();
  if (row === null) return null;
  return await ctx.db.get("crews", row.crewId);
}

// Everyone in a crew, the leader included, in the order they joined.
export async function memberIdsOf(ctx: QueryCtx, crewId: Id<"crews">): Promise<Id<"hackers">[]> {
  const rows = await ctx.db
    .query("crewMembers")
    .withIndex("by_crew", function (q) {
      return q.eq("crewId", crewId);
    })
    .collect();
  rows.sort(function (a, b) { return a.joinedAt - b.joinedAt; });
  return rows.map(function (r) { return r.hackerId; });
}

// The people this hacker's things are shared with: their crew minus themselves; their friends when they are in no crew
// (how soopdoop worked before crews).
export async function crewmateIds(ctx: QueryCtx, hackerId: Id<"hackers">): Promise<Id<"hackers">[]> {
  const crew = await crewOf(ctx, hackerId);
  if (crew === null) return await acceptedFriendIds(ctx, hackerId);
  const members = await memberIdsOf(ctx, crew._id);
  return members.filter(function (id) { return id !== hackerId; });
}

// Whether `b` is one of `a`'s crewmates: in the same crew, or friends when `a` is in no crew. Never yourself.
export async function isCrewmate(ctx: QueryCtx, a: Id<"hackers">, b: Id<"hackers">): Promise<boolean> {
  if (a === b) return false;
  const crew = await crewOf(ctx, a);
  if (crew === null) return await areFriends(ctx, a, b);
  const theirs = await crewOf(ctx, b);
  return theirs !== null && theirs._id === crew._id;
}

// The crew this hacker leads. Throws for anyone who is not a crew leader.
export async function requireLeader(ctx: QueryCtx, hacker: Doc<"hackers">): Promise<Doc<"crews">> {
  const crew = await crewOf(ctx, hacker._id);
  if (crew === null) throw new ConvexError("You are not in a crew.");
  if (crew.leaderId !== hacker._id) throw new ConvexError("Only the crew leader can do that.");
  return crew;
}

// Puts a hacker in a crew. The caller has checked that they are in no crew and that the crew has room.
export async function addMember(ctx: MutationCtx, crewId: Id<"crews">, hackerId: Id<"hackers">, role: "leader" | "member"): Promise<void> {
  await ctx.db.insert("crewMembers", { crewId, hackerId, role, joinedAt: Date.now() });
}

// A new crew on the free plan, led by `leader`, who is its first member. The digest's time zone starts as the leader's.
export async function startCrew(ctx: MutationCtx, leader: Doc<"hackers">, name: string): Promise<Id<"crews">> {
  const crewId = await ctx.db.insert("crews", {
    name,
    leaderId: leader._id,
    plan: "free",
    digestHour: DEFAULT_DIGEST_HOUR,
    timezone: leader.timezone ?? DEFAULT_TIMEZONE,
    createdAt: Date.now(),
  });
  await addMember(ctx, crewId, leader._id, "leader");
  return crewId;
}

// What an accepted invite does to crews. The invitee joins the inviter's crew when it has room; when neither of them is
// in a crew, the inviter starts one ("<handle>'s crew") with both in it, and leads it (the first person to invite others
// is the leader). Someone already in a crew stays where they are, and a full crew stays full: they are still friends.
// Returns the crew the invitee joined, or null.
export async function joinOnInvite(ctx: MutationCtx, inviterId: Id<"hackers">, inviteeId: Id<"hackers">): Promise<Id<"crews"> | null> {
  if (inviterId === inviteeId) return null;
  if ((await crewOf(ctx, inviteeId)) !== null) return null;
  const crew = await crewOf(ctx, inviterId);
  if (crew !== null) {
    if ((await memberIdsOf(ctx, crew._id)).length >= MAX_CREW) return null;
    await addMember(ctx, crew._id, inviteeId, "member");
    return crew._id;
  }
  const inviter = await ctx.db.get("hackers", inviterId);
  if (inviter === null || (await ctx.db.get("hackers", inviteeId)) === null) return null;
  const crewId = await startCrew(ctx, inviter, `${inviter.handle}'s crew`);
  await addMember(ctx, crewId, inviteeId, "member");
  return crewId;
}
