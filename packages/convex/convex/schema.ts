// ABOUTME: The soopdoop data model. Phase 1 tables: hackers, friendships, subsets (presence), knocks.
// ABOUTME: Later phases add crews, treeNodes, routingSummaries, relays, eyes, jackIns, play and companyTokens.
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

export default defineSchema({
  hackers: defineTable({
    handle: v.string(),
    supersetUserId: v.optional(v.string()),
    supersetOrgId: v.optional(v.string()),
    // Presence sharing. Default: online state and agent count only.
    shareWorkspaceNames: v.boolean(),
    shareAgentNames: v.boolean(),
    focusUntil: v.optional(v.number()),
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
    .index("by_a", ["a"])
    .index("by_b", ["b"]),

  invites: defineTable({
    fromHackerId: v.id("hackers"),
    token: v.string(),
    expiresAt: v.number(), // 7 days
    usedByHackerId: v.optional(v.id("hackers")),
  }).index("by_token", ["token"]),

  // One hacker's session and its agents. ∅ when agents is empty.
  subsets: defineTable({
    hackerId: v.id("hackers"),
    machineName: v.string(),
    agents: v.array(agentState),
    updatedAt: v.number(),
  }).index("by_hacker", ["hackerId"]),

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
