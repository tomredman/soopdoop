// ABOUTME: The soopdoop data model: hackers, friendships, invites, subsets (presence), knocks, flicks, supersetProfiles, and
// ABOUTME: the Operator's routingSummaries and relays. Later phases add crews, treeNodes, eyes, jackIns and companyTokens.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// LED grammar. Green = working. Blue = idle, open to knocks. Purple = a relay in flight (Phase 2).
export const ledColor = v.union(v.literal("g"), v.literal("b"), v.literal("p"));

export const agentState = v.object({
  agentId: v.string(), // harness session id
  harness: v.string(), // "claude-code" | "codex" | ...
  name: v.string(), // what the rail shows, e.g. "listing-cards"
  workspace: v.optional(v.string()), // repo or worktree name, only if the hacker shares it
  status: v.union(v.literal("working"), v.literal("idle"), v.literal("waiting")),
  open: v.boolean(), // false = private: never listed to others, never read by the Operator
  lastTurnAt: v.number(),
});

// Where a question to the Operator stands. routing: picking the agent; reading: waiting for its owner's daemon;
// then answered, not-found (the agent did not know), nobody (no agent to ask), timeout or error.
export const relayStatus = v.union(
  v.literal("routing"),
  v.literal("reading"),
  v.literal("answered"),
  v.literal("not-found"),
  v.literal("nobody"),
  v.literal("timeout"),
  v.literal("error"),
);

// What soopdoop keeps from a hacker's public Superset leaderboard profile (lib/supersetProfile.ts reads it).
// No token counts, cost or rank: AGENTS.md keeps token counts off personal and crew boards.
export const supersetProfileFields = {
  handle: v.string(),
  name: v.optional(v.string()),
  tier: v.optional(v.string()),
  achievements: v.array(v.object({ slug: v.string(), level: v.optional(v.number()), of: v.optional(v.number()) })),
  models: v.array(v.string()), // most tokens first, names only
};

export default defineSchema({
  hackers: defineTable({
    handle: v.string(),
    supersetUserId: v.optional(v.string()),
    supersetOrgId: v.optional(v.string()),
    // Presence sharing. Default: online state and agent count only.
    shareWorkspaceNames: v.boolean(),
    shareAgentNames: v.boolean(),
    focusUntil: v.optional(v.number()),
    // Off the crew board for everyone but themselves.
    hideFromBoards: v.optional(v.boolean()),
    // A per-sender knock limit is Phase 1.5; quiet hours Phase 3.
    createdAt: v.number(),
  })
    .index("by_handle", ["handle"])
    .index("by_supersetUserId", ["supersetUserId"]),

  // The daemon's session token. One row per machine the hacker runs the daemon on.
  daemonTokens: defineTable({
    hackerId: v.id("hackers"),
    tokenHash: v.string(),
    machineName: v.string(),
    lastSeenAt: v.number(),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_hacker", ["hackerId"]),

  friendships: defineTable({
    a: v.id("hackers"), // requester
    b: v.id("hackers"), // receiver
    status: v.union(v.literal("requested"), v.literal("accepted")),
    createdAt: v.number(),
  })
    .index("by_a_b", ["a", "b"])
    .index("by_b", ["b"]),

  invites: defineTable({
    fromHackerId: v.id("hackers"),
    token: v.string(),
    expiresAt: v.number(), // 7 days
    usedByHackerId: v.optional(v.id("hackers")),
    // Made for someone not on soopdoop yet who has a public Superset profile: linking that profile redeems it too.
    forHandle: v.optional(v.string()),
    forName: v.optional(v.string()),
  })
    .index("by_token", ["token"])
    .index("by_forHandle", ["forHandle"]),

  // A flick: a poke between friends, for fun. Open until it is flicked back or a scheduled function expires it. A
  // sender has at most one open flick per friend. Each flick back adds one to the rally. Caught in its first 10 seconds,
  // the receiver takes XP from the sender; every 5 flicks in a row nobody catches earn a superflick, which takes XP from
  // the receiver and cannot be caught.
  flicks: defineTable({
    fromHackerId: v.id("hackers"),
    toHackerId: v.id("hackers"),
    rally: v.number(),
    outcome: v.union(v.literal("open"), v.literal("flicked-back"), v.literal("caught"), v.literal("expired")),
    createdAt: v.number(),
    expiresAt: v.number(),
    // The catch window closed without a catch (a scheduled function sets it): it counts toward a superflick.
    safe: v.optional(v.boolean()),
    // What the receiver took from the sender by catching it.
    caughtXp: v.optional(v.number()),
    caughtAt: v.optional(v.number()),
    // A superflick, and what the sender took from the receiver with it.
    superflick: v.optional(v.boolean()),
    superXp: v.optional(v.number()),
  })
    .index("by_to_outcome", ["toHackerId", "outcome"])
    .index("by_from_outcome", ["fromHackerId", "outcome"]),

  // One hacker's session and its agents. ∅ when agents is empty.
  subsets: defineTable({
    hackerId: v.id("hackers"),
    machineName: v.string(),
    agents: v.array(agentState),
    updatedAt: v.number(),
  }).index("by_hacker_machine", ["hackerId", "machineName"]),

  // One row per hacker who linked their Superset profile. Refreshed every 6 hours; dropped when the owner unpublishes it.
  supersetProfiles: defineTable({
    hackerId: v.id("hackers"),
    ...supersetProfileFields,
    fetchedAt: v.number(),
  })
    .index("by_hacker", ["hackerId"])
    .index("by_handle", ["handle"]),

  // One line per open agent, from its owner's daemon after each turn: what it works on, the files it touched.
  // The Operator routes questions with these. Owners can read their own. Dropped when the agent ends.
  routingSummaries: defineTable({
    hackerId: v.id("hackers"),
    machineName: v.string(),
    agentId: v.string(),
    summary: v.string(),
    updatedAt: v.number(),
  }).index("by_hacker_agent", ["hackerId", "agentId"]),

  // One question to the Operator and what came of it. Keeps the question and the short answer, never what was read.
  relays: defineTable({
    askerHackerId: v.id("hackers"),
    question: v.string(),
    status: relayStatus,
    targetHackerId: v.optional(v.id("hackers")),
    targetMachine: v.optional(v.string()),
    targetAgentId: v.optional(v.string()),
    // Only when the owner shares agent names.
    targetAgentName: v.optional(v.string()),
    answer: v.optional(v.string()),
    note: v.optional(v.string()),
    tokensRead: v.optional(v.number()),
    tokensSent: v.optional(v.number()),
    createdAt: v.number(),
    finishedAt: v.optional(v.number()),
    // Typed in the Operator chat (the app), not asked by an agent's tool.
    via: v.optional(v.literal("chat")),
    // What the Operator asked the agent: a chat message rewritten to stand alone. The daemon asks this one.
    routedQuestion: v.optional(v.string()),
    // The Operator answered itself (crew news, small talk): no agent was asked.
    byOperator: v.optional(v.boolean()),
    // The question named someone the Operator could not place in the crew: the asker can fix the @handle and ask again.
    askAgain: v.optional(v.boolean()),
  })
    .index("by_asker", ["askerHackerId"])
    .index("by_target_status", ["targetHackerId", "status"]),

  knocks: defineTable({
    fromHackerId: v.id("hackers"),
    toHackerId: v.id("hackers"),
    item: v.object({
      kind: v.union(v.literal("link"), v.literal("file"), v.literal("session"), v.literal("page")),
      title: v.string(),
      url: v.optional(v.string()),
    }),
    note: v.optional(v.string()),
    lifetimeMs: v.number(), // 10 s, 30 s, or 2 min
    expiresAt: v.number(),
    outcome: v.union(v.literal("open"), v.literal("opened"), v.literal("not-now"), v.literal("expired")),
    createdAt: v.number(),
    decidedAt: v.optional(v.number()),
  })
    .index("by_to_outcome", ["toHackerId", "outcome"])
    .index("by_from_to", ["fromHackerId", "toHackerId"]),
});
