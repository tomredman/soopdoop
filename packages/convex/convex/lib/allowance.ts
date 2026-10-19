// ABOUTME: Who shares a plan's daily allowance of questions and hand-offs: the hacker's crew, or for a hacker in no crew,
// ABOUTME: themselves and their friends who are in no crew either, so a crew's use never counts against a friend outside it.
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { crewOf, memberIdsOf } from "./crew";
import { acceptedFriendIds } from "./friendships";

export async function allowanceGroup(ctx: QueryCtx, hackerId: Id<"hackers">): Promise<{ crew: Doc<"crews"> | null; ids: Id<"hackers">[] }> {
  const crew = await crewOf(ctx, hackerId);
  if (crew !== null) {
    const ids = await memberIdsOf(ctx, crew._id);
    return { crew, ids: ids.includes(hackerId) ? ids : [hackerId, ...ids] };
  }
  const ids = [hackerId];
  for (const id of await acceptedFriendIds(ctx, hackerId)) if ((await crewOf(ctx, id)) === null) ids.push(id);
  return { crew: null, ids };
}
