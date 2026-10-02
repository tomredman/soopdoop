// ABOUTME: Routing summaries: one line per open agent, sent by its owner's daemon after each turn, that the Operator routes
// ABOUTME: with. Only for agents the machine reports as open. Owners can read their own.
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireDaemon, requireHacker } from "./lib/auth";

export const MAX_SUMMARY = 600;

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
      summary: args.summary.trim().slice(0, MAX_SUMMARY),
      updatedAt: Date.now(),
    };
    const existing = await ctx.db
      .query("routingSummaries")
      .withIndex("by_hacker_agent", function (q) {
        return q.eq("hackerId", hacker._id).eq("agentId", args.agentId);
      })
      .unique();
    if (existing === null) await ctx.db.insert("routingSummaries", row);
    else await ctx.db.replace("routingSummaries", existing._id, row);
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
