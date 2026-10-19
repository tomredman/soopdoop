// ABOUTME: Crews as objects: a name, a leader, up to 8 members, settings (the digest's hour and time zone, Slack, Intercom,
// ABOUTME: trusted note posters) and a plan; the crew's four numbers and cost line; and the one-time move from friends to crews.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { env, internalMutation, mutation, query } from "./_generated/server";
import { checkHacker, requireDaemon, requireHacker } from "./lib/auth";
import { subscriptionOf, subscriptionView } from "./lib/billing";
import { addMember, crewmateIds, crewOf, joinOnInvite, MAX_CREW, memberIdsOf, requireLeader, seatsChanged, startCrew } from "./lib/crew";
import { areFriends } from "./lib/friendships";
import { canonicalTimezone, DAY_MS, localMonth } from "./lib/localTime";
import { crewNumbers } from "./lib/numbers";
import { crewPlan } from "./schema";
import { supersetCard } from "./superset";

const MAX_NAME = 60;
const MAX_SECRET = 500;
export const SLACK_TEST = "soopdoop is connected to this channel. The crew's digest and news will show up here.";

const role = v.union(v.literal("leader"), v.literal("member"));
const NOTE_STATUSES: Doc<"notes">["status"][] = ["live", "proposed", "retired"];

const crewView = v.object({
  _id: v.id("crews"),
  name: v.string(),
  plan: crewPlan,
  planUntil: v.optional(v.number()),
  leaderHandle: v.string(),
  iAmLeader: v.boolean(),
  digestHour: v.number(),
  timezone: v.string(),
  slackConnected: v.boolean(),
  slackMirror: v.boolean(),
  // The last post to Slack that failed (cleared by one that works), and when a post last went through.
  slackError: v.optional(v.string()),
  slackPostedAt: v.optional(v.number()),
  intercomConnected: v.boolean(),
  // The address the leader pastes into Intercom's webhook settings. Only for the leader.
  intercomWebhookUrl: v.optional(v.string()),
  trustedNotePosters: v.array(v.string()),
  members: v.array(v.object({ handle: v.string(), name: v.optional(v.string()), role, joinedAt: v.number() })),
  // The team plan's subscription (billing.status has the same), for "Team plan, 4 members, renews 12 Nov". None on free.
  subscription: v.optional(subscriptionView),
});

function crewName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (name === "" || name.length > MAX_NAME) throw new ConvexError(`A crew name is 1 to ${MAX_NAME} characters.`);
  return name;
}

async function hackerByHandle(ctx: QueryCtx, raw: string): Promise<Doc<"hackers">> {
  const hacker = await ctx.db
    .query("hackers")
    .withIndex("by_handle", function (q) {
      return q.eq("handle", raw.trim().replace(/^@/, "").toLowerCase());
    })
    .unique();
  if (hacker === null) throw new ConvexError("ain’t nobody with that handle");
  return hacker;
}

async function membershipOf(ctx: QueryCtx, crewId: Id<"crews">, hackerId: Id<"hackers">): Promise<Doc<"crewMembers"> | null> {
  const row = await ctx.db
    .query("crewMembers")
    .withIndex("by_hacker", function (q) {
      return q.eq("hackerId", hackerId);
    })
    .first();
  return row !== null && row.crewId === crewId ? row : null;
}

// Takes someone out of a crew: their membership, and the leader's trust in their agents' notes. A paying crew's seat
// count follows.
async function dropMember(ctx: MutationCtx, crew: Doc<"crews">, row: Doc<"crewMembers">): Promise<void> {
  await ctx.db.delete("crewMembers", row._id);
  const trusted = crew.trustedNotePosters ?? [];
  if (trusted.includes(row.hackerId)) {
    await ctx.db.patch("crews", crew._id, { trustedNotePosters: trusted.filter(function (id) { return id !== row.hackerId; }) });
  }
  await seatsChanged(ctx, crew._id);
}

// The caller's crew with its settings and members. Null when they are signed out or in no crew. Never the Slack webhook
// or Intercom's token and secret: only whether they are set.
export const mine = query({
  args: {},
  returns: v.union(v.null(), crewView),
  handler: async function (ctx) {
    const me = await checkHacker(ctx);
    if (me === null) return null;
    const crew = await crewOf(ctx, me._id);
    if (crew === null) return null;
    const rows = await ctx.db
      .query("crewMembers")
      .withIndex("by_crew", function (q) {
        return q.eq("crewId", crew._id);
      })
      .collect();
    const members: { id: Id<"hackers">; handle: string; name?: string; role: Doc<"crewMembers">["role"]; joinedAt: number }[] = [];
    for (const row of rows) {
      const hacker = await ctx.db.get("hackers", row.hackerId);
      if (hacker === null) continue;
      members.push({
        id: hacker._id,
        handle: hacker.handle,
        name: (await supersetCard(ctx, hacker._id))?.name,
        role: hacker._id === crew.leaderId ? "leader" : "member",
        joinedAt: row.joinedAt,
      });
    }
    members.sort(function (a, b) { return (a.role === "leader" ? 0 : 1) - (b.role === "leader" ? 0 : 1) || a.joinedAt - b.joinedAt; });
    const leader = await ctx.db.get("hackers", crew.leaderId);
    const iAmLeader = crew.leaderId === me._id;
    const site = env.CONVEX_SITE_URL;
    return {
      _id: crew._id,
      name: crew.name,
      plan: crew.plan,
      planUntil: crew.planUntil,
      leaderHandle: leader?.handle ?? "",
      iAmLeader,
      digestHour: crew.digestHour,
      timezone: crew.timezone,
      slackConnected: crew.slackWebhook !== undefined,
      slackMirror: crew.slackMirror === true,
      slackError: crew.slackError,
      slackPostedAt: crew.slackPostedAt,
      intercomConnected: crew.intercomSecret !== undefined,
      intercomWebhookUrl: iAmLeader && site !== undefined && site !== "" ? `${site}/intercom/webhook?crew=${crew._id}` : undefined,
      trustedNotePosters: members
        .filter(function (m) { return (crew.trustedNotePosters ?? []).includes(m.id); })
        .map(function (m) { return m.handle; }),
      members: members.map(function (m) { return { handle: m.handle, name: m.name, role: m.role, joinedAt: m.joinedAt }; }),
      subscription: subscriptionOf(crew) ?? undefined,
    };
  },
});

// Starts a crew with the caller as its leader and only member. Add friends to it with `add`.
export const create = mutation({
  args: { name: v.string() },
  returns: v.id("crews"),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    if ((await crewOf(ctx, me._id)) !== null) throw new ConvexError("You are already in a crew. Leave it first.");
    return await startCrew(ctx, me, crewName(args.name));
  },
});

export const rename = mutation({
  args: { name: v.string() },
  returns: v.null(),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const crew = await requireLeader(ctx, me);
    await ctx.db.patch("crews", crew._id, { name: crewName(args.name) });
    return null;
  },
});

// When the daily digest goes out: an hour (0 to 23) in a time zone (an IANA name such as America/Toronto).
export const setDigest = mutation({
  args: { digestHour: v.number(), timezone: v.string() },
  returns: v.null(),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const crew = await requireLeader(ctx, me);
    if (!Number.isInteger(args.digestHour) || args.digestHour < 0 || args.digestHour > 23) {
      throw new ConvexError("The digest hour is a whole hour from 0 to 23.");
    }
    const timezone = canonicalTimezone(args.timezone);
    if (timezone === null) throw new ConvexError("That is not a time zone soopdoop knows. Use a name like America/Toronto.");
    await ctx.db.patch("crews", crew._id, { digestHour: args.digestHour, timezone });
    return null;
  },
});

// The crew's Slack incoming webhook (null takes it off) and the live mirror. Leave the webhook out to change only the
// mirror: the app never sees the webhook again once it is set.
export const setSlack = mutation({
  args: { webhook: v.optional(v.union(v.string(), v.null())), mirror: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const crew = await requireLeader(ctx, me);
    const patch: Partial<Doc<"crews">> = {};
    if (args.webhook === null) {
      patch.slackWebhook = undefined;
      patch.slackError = undefined;
      patch.slackPostedAt = undefined;
    } else if (args.webhook !== undefined) {
      const webhook = args.webhook.trim();
      let url: URL | null = null;
      try {
        url = new URL(webhook);
      } catch {
        url = null;
      }
      if (url === null || url.protocol !== "https:" || webhook.length > MAX_SECRET) {
        throw new ConvexError("That is not a Slack webhook. It starts with https://hooks.slack.com/services/.");
      }
      patch.slackWebhook = webhook;
      patch.slackError = undefined;
    }
    if (args.mirror !== undefined) patch.slackMirror = args.mirror;
    await ctx.db.patch("crews", crew._id, patch);
    return null;
  },
});

// Posts a test line to the crew's Slack channel. Whether it went through shows in `mine` (slackPostedAt, slackError).
export const testSlack = mutation({
  args: {},
  returns: v.null(),
  handler: async function (ctx) {
    const me = await requireHacker(ctx);
    const crew = await requireLeader(ctx, me);
    if (crew.slackWebhook === undefined) throw new ConvexError("Add the crew's Slack webhook first.");
    await ctx.scheduler.runAfter(0, internal.slack.post, { crewId: crew._id, text: SLACK_TEST });
    return null;
  },
});

// A token or secret as stored: trimmed, and nothing for null or an empty string.
function secretOrNothing(value: string | null): string | undefined {
  const clean = value === null ? "" : value.trim();
  if (clean.length > MAX_SECRET) throw new ConvexError("That is too long for an Intercom token or secret.");
  return clean === "" ? undefined : clean;
}

// Intercom's access token and the app's client secret (it signs the webhooks). Null takes one off; leave one out to keep it.
export const setIntercom = mutation({
  args: { token: v.optional(v.union(v.string(), v.null())), secret: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const crew = await requireLeader(ctx, me);
    const patch: Partial<Doc<"crews">> = {};
    if (args.token !== undefined) patch.intercomToken = secretOrNothing(args.token);
    if (args.secret !== undefined) patch.intercomSecret = secretOrNothing(args.secret);
    await ctx.db.patch("crews", crew._id, patch);
    return null;
  },
});

// The crewmates whose agents may post crew notes without their owner's approval (on the team plan).
export const setTrustedNotePosters = mutation({
  args: { handles: v.array(v.string()) },
  returns: v.null(),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const crew = await requireLeader(ctx, me);
    const members = await memberIdsOf(ctx, crew._id);
    const trusted: Id<"hackers">[] = [];
    for (const handle of args.handles) {
      const hacker = await hackerByHandle(ctx, handle);
      if (!members.includes(hacker._id)) throw new ConvexError(`@${hacker.handle} is not in the crew.`);
      if (!trusted.includes(hacker._id)) trusted.push(hacker._id);
    }
    await ctx.db.patch("crews", crew._id, { trustedNotePosters: trusted });
    return null;
  },
});

// The leader adds a friend who is in no crew yet. At most 8 people.
export const add = mutation({
  args: { handle: v.string() },
  returns: v.null(),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const crew = await requireLeader(ctx, me);
    const other = await hackerByHandle(ctx, args.handle);
    if (other._id === me._id) throw new ConvexError("You are already in the crew.");
    if (!(await areFriends(ctx, me._id, other._id))) throw new ConvexError(`Add @${other.handle} as a friend first.`);
    const theirs = await crewOf(ctx, other._id);
    if (theirs !== null) {
      throw new ConvexError(theirs._id === crew._id ? `@${other.handle} is already in the crew.` : `@${other.handle} is in another crew.`);
    }
    if ((await memberIdsOf(ctx, crew._id)).length >= MAX_CREW) throw new ConvexError(`The crew is full: ${MAX_CREW} people at most.`);
    await addMember(ctx, crew._id, other._id, "member");
    return null;
  },
});

// The leader takes someone out of the crew. They stay friends.
export const remove = mutation({
  args: { handle: v.string() },
  returns: v.null(),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const crew = await requireLeader(ctx, me);
    const other = await hackerByHandle(ctx, args.handle);
    if (other._id === me._id) throw new ConvexError("You lead this crew. Hand the lead to someone else first, or leave.");
    const row = await membershipOf(ctx, crew._id, other._id);
    if (row === null) throw new ConvexError(`@${other.handle} is not in the crew.`);
    await dropMember(ctx, crew, row);
    return null;
  },
});

// Leaves the crew. The leader hands the lead on first while others are in it. The last one out ends the crew: its notes
// and digests go too, unless it still has a paid subscription (billing needs the crew to find it).
export const leave = mutation({
  args: {},
  returns: v.null(),
  handler: async function (ctx) {
    const me = await requireHacker(ctx);
    const crew = await crewOf(ctx, me._id);
    if (crew === null) throw new ConvexError("You are not in a crew.");
    const row = await membershipOf(ctx, crew._id, me._id);
    if (row === null) throw new ConvexError("You are not in a crew.");
    const members = await memberIdsOf(ctx, crew._id);
    if (crew.leaderId === me._id && members.length > 1) {
      throw new ConvexError("You lead this crew. Hand the lead to someone else first.");
    }
    await dropMember(ctx, crew, row);
    if (members.length > 1 || crew.stripeSubscriptionId !== undefined) return null;
    for (const status of NOTE_STATUSES) {
      const notes = await ctx.db
        .query("notes")
        .withIndex("by_crew_status", function (q) {
          return q.eq("crewId", crew._id).eq("status", status);
        })
        .collect();
      for (const note of notes) await ctx.db.delete("notes", note._id);
    }
    const digests = await ctx.db
      .query("digests")
      .withIndex("by_crew", function (q) {
        return q.eq("crewId", crew._id);
      })
      .collect();
    for (const digest of digests) await ctx.db.delete("digests", digest._id);
    await ctx.db.delete("crews", crew._id);
    return null;
  },
});

// The leader makes another member the leader.
export const handLeadership = mutation({
  args: { handle: v.string() },
  returns: v.null(),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const crew = await requireLeader(ctx, me);
    const other = await hackerByHandle(ctx, args.handle);
    if (other._id === me._id) throw new ConvexError("You already lead this crew.");
    const theirs = await membershipOf(ctx, crew._id, other._id);
    const mine = await membershipOf(ctx, crew._id, me._id);
    if (theirs === null) throw new ConvexError(`@${other.handle} is not in the crew.`);
    await ctx.db.patch("crews", crew._id, { leaderId: other._id });
    await ctx.db.patch("crewMembers", theirs._id, { role: "leader" });
    if (mine !== null) await ctx.db.patch("crewMembers", mine._id, { role: "member" });
    return null;
  },
});

// The crew's four numbers for the last 7 days (for a hacker in no crew: them and their friends). Totals, never per person.
export const numbers = query({
  args: {},
  returns: v.object({
    answered: v.number(),
    tokensSaved: v.number(),
    handoffs: v.number(),
    headsups: v.number(),
    ships: v.number(),
    walkthroughs: v.number(),
    days: v.number(),
  }),
  handler: async function (ctx) {
    const me = await requireHacker(ctx);
    const members = [me._id, ...(await crewmateIds(ctx, me._id))];
    const now = Date.now();
    const days = 7;
    return { ...(await crewNumbers(ctx, members, now - days * DAY_MS, now + 1)), days };
  },
});

function cents(usd: number): number {
  return Math.round(usd * 10_000) / 10_000;
}

// What the crew's Operator cost this month at API prices, in US dollars: its calls for the crew's questions, and the
// digest. The month is the crew's (its time zone). Shown in Settings → Crew; on the team plan it is included.
export const costs = query({
  args: {},
  returns: v.object({ month: v.string(), operatorUsd: v.number(), digestUsd: v.number() }),
  handler: async function (ctx) {
    const me = await requireHacker(ctx);
    const crew = await crewOf(ctx, me._id);
    const { month, from } = localMonth(Date.now(), crew?.timezone ?? me.timezone ?? "UTC");
    const askers = crew === null ? [me._id, ...(await crewmateIds(ctx, me._id))] : await memberIdsOf(ctx, crew._id);
    let operatorUsd = 0;
    for (const id of askers) {
      const relays = await ctx.db
        .query("relays")
        .withIndex("by_asker", function (q) {
          return q.eq("askerHackerId", id).gte("_creationTime", from);
        })
        .collect();
      for (const r of relays) if (r.createdAt >= from) operatorUsd += r.usd ?? 0;
    }
    let digestUsd = 0;
    if (crew !== null) {
      const digests = await ctx.db
        .query("digests")
        .withIndex("by_crew", function (q) {
          return q.eq("crewId", crew._id).gte("writtenAt", from);
        })
        .collect();
      for (const d of digests) digestUsd += d.usd ?? 0;
    }
    return { month, operatorUsd: cents(operatorUsd), digestUsd: cents(digestUsd) };
  },
});

// The crew as a machine's daemon sees it (for crew.md and the MCP tools): its name, plan, leader, and the crewmates.
// For a hacker in no crew: their friends, on the free plan.
export const forDaemon = query({
  args: { token: v.string() },
  returns: v.object({
    crewName: v.optional(v.string()),
    plan: crewPlan,
    leaderHandle: v.optional(v.string()),
    members: v.array(v.object({ handle: v.string(), name: v.optional(v.string()) })),
  }),
  handler: async function (ctx, args) {
    const { hacker } = await requireDaemon(ctx, args.token);
    const crew = await crewOf(ctx, hacker._id);
    const members = [];
    for (const id of await crewmateIds(ctx, hacker._id)) {
      const mate = await ctx.db.get("hackers", id);
      if (mate !== null) members.push({ handle: mate.handle, name: (await supersetCard(ctx, id))?.name });
    }
    members.sort(function (a, b) { return a.handle.localeCompare(b.handle); });
    const leader = crew === null ? null : await ctx.db.get("hackers", crew.leaderId);
    return { crewName: crew?.name, plan: crew?.plan ?? "free", leaderHandle: leader?.handle, members };
  },
});

function pairKey(a: Id<"hackers">, b: Id<"hackers">): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

// One time, for the hackers who were friends before crews: replays every friendship as the invite it was, oldest first
// (the oldest row of a pair says who asked: its `a`), so the first inviter of each group leads its crew. Safe to run
// again: someone already in a crew is left alone. npx convex run --prod crews:migrate
export const migrate = internalMutation({
  args: {},
  returns: v.object({ pairs: v.number(), started: v.number(), joined: v.number() }),
  handler: async function (ctx) {
    const rows = await ctx.db.query("friendships").collect();
    rows.sort(function (x, y) { return x.createdAt - y.createdAt || x._creationTime - y._creationTime; });
    const friends = new Set(rows.filter(function (r) { return r.status === "accepted"; }).map(function (r) { return pairKey(r.a, r.b); }));
    const done = new Set<string>();
    let started = 0;
    let joined = 0;
    for (const r of rows) {
      const key = pairKey(r.a, r.b);
      if (done.has(key) || !friends.has(key)) continue;
      done.add(key);
      const before = await crewOf(ctx, r.a);
      if ((await joinOnInvite(ctx, r.a, r.b)) === null) continue;
      joined += 1;
      if (before === null) started += 1;
    }
    return { pairs: done.size, started, joined };
  },
});
