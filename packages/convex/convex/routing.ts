// ABOUTME: Routing summaries: one line per open agent, sent by its owner's daemon after each turn, that the Operator routes
// ABOUTME: with. Only for agents the machine reports as open. Owners read their own; crewmates' agents are introduced to them.
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { addToFeed, announcedAgents } from "./feed";
import { acceptedFriendIds } from "./friends";
import { requireDaemon, requireHacker } from "./lib/auth";
import { redactSecrets, summaryForCrew } from "./lib/summaries";
import { supersetCard } from "./superset";

export const MAX_SUMMARY = 600;
// A machine that reported in the last 90 seconds is live, as for presence and the Operator.
const LIVE_MS = 90_000;
// The most agents one introduction lists, most recently active first.
const MAX_INTRODUCED = 20;

export const update = mutation({
  args: { token: v.string(), agentId: v.string(), summary: v.string() },
  returns: v.null(),
  handler: async function (ctx, args) {
    const { hacker, daemon } = await requireDaemon(ctx, args.token);
    // Only an agent this machine reported, and only if it is open. A private agent's summary never leaves the machine,
    // and this refuses one that somehow did.
    const subset = await ctx.db
      .query("subsets")
      .withIndex("by_hacker_machine", function (q) {
        return q.eq("hackerId", hacker._id).eq("machineName", daemon.machineName);
      })
      .unique();
    const agent = subset?.agents.find(function (a) { return a.agentId === args.agentId; });
    if (agent === undefined || !agent.open) return null;
    const row = {
      hackerId: hacker._id,
      machineName: daemon.machineName,
      agentId: args.agentId,
      // Crewmates' agents read these, so nothing that looks like a key is kept.
      summary: redactSecrets(args.summary.trim()).slice(0, MAX_SUMMARY),
      updatedAt: Date.now(),
    };
    const existing = await ctx.db
      .query("routingSummaries")
      .withIndex("by_hacker_agent", function (q) {
        return q.eq("hackerId", hacker._id).eq("agentId", args.agentId);
      })
      .unique();
    if (existing === null) {
      await ctx.db.insert("routingSummaries", row);
      // Its first summary: the crew's wire hears that this hacker started an agent, unless it already did this week.
      if (!(await announcedAgents(ctx, hacker._id)).has(args.agentId)) {
        await addToFeed(ctx, { kind: "agent", hackerId: hacker._id, agentId: args.agentId, at: row.updatedAt });
      }
    } else {
      await ctx.db.replace("routingSummaries", existing._id, row);
    }
    return null;
  },
});

// What the Operator knows about each of my agents.
export const mine = query({
  args: {},
  returns: v.array(v.object({ machineName: v.string(), agentId: v.string(), summary: v.string(), updatedAt: v.number() })),
  handler: async function (ctx) {
    const me = await requireHacker(ctx);
    const rows = await ctx.db
      .query("routingSummaries")
      .withIndex("by_hacker_agent", function (q) {
        return q.eq("hackerId", me._id);
      })
      .collect();
    return rows.map(function (r) {
      return { machineName: r.machineName, agentId: r.agentId, summary: r.summary, updatedAt: r.updatedAt };
    });
  },
});

// What a hacker's agents are told about the crew, through their machine's token: each crewmate's open agents that are
// running now and have a summary, most recently active first. Nobody in focus mode. The folder and branch only when the
// owner shares folder names. `key` stays the same while its summary is kept; `since` is when the agent was first on the
// wire, so a session can be told about agents that started after it was introduced. `now` is the server's clock.
export const crew = query({
  args: { token: v.string() },
  returns: v.object({
    now: v.number(),
    agents: v.array(v.object({
      key: v.string(),
      handle: v.string(),
      name: v.optional(v.string()),
      status: v.string(),
      summary: v.string(),
      since: v.number(),
    })),
  }),
  handler: async function (ctx, args) {
    const { hacker } = await requireDaemon(ctx, args.token);
    const now = Date.now();
    const found = [];
    for (const id of await acceptedFriendIds(ctx, hacker._id)) {
      const friend = await ctx.db.get("hackers", id);
      if (friend === null || (friend.focusUntil !== undefined && friend.focusUntil > now)) continue;
      const subsets = await ctx.db
        .query("subsets")
        .withIndex("by_hacker_machine", function (q) {
          return q.eq("hackerId", id);
        })
        .collect();
      const name = (await supersetCard(ctx, id))?.name;
      const announced = await announcedAgents(ctx, id);
      for (const subset of subsets) {
        if (now - subset.updatedAt >= LIVE_MS) continue;
        for (const agent of subset.agents) {
          if (!agent.open) continue;
          const row = await ctx.db
            .query("routingSummaries")
            .withIndex("by_hacker_agent", function (q) {
              return q.eq("hackerId", id).eq("agentId", agent.agentId);
            })
            .unique();
          if (row === null) continue;
          const summary = summaryForCrew(row.summary, friend.shareWorkspaceNames);
          if (summary === "") continue;
          const since = announced.get(agent.agentId) ?? row._creationTime;
          found.push({ key: row._id, handle: friend.handle, name, status: agent.status, summary, since, active: row.updatedAt });
        }
      }
    }
    found.sort(function (a, b) { return b.active - a.active; });
    return {
      now,
      agents: found.slice(0, MAX_INTRODUCED).map(function (a) {
        return { key: a.key, handle: a.handle, name: a.name, status: a.status, summary: a.summary, since: a.since };
      }),
    };
  },
});
