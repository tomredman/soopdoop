// ABOUTME: Presence from the daemon. The daemon reports the full agent list of one machine; the server replaces it.
// ABOUTME: Also pairing: the rail mints a daemon token, the daemon presents it on every report.
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { hashToken, requireDaemon, requireHacker } from "./lib/auth";
import { agentState } from "./schema";

// The rail calls this; the hacker pastes the token into the daemon once.
export const pairDaemon = mutation({
  args: { machineName: v.string() },
  returns: v.string(),
  handler: async function (ctx, args) {
    const me = await requireHacker(ctx);
    const token = "sd_" + crypto.randomUUID().replace(/-/g, "");
    await ctx.db.insert("daemonTokens", {
      hackerId: me._id,
      tokenHash: await hashToken(token),
      machineName: args.machineName,
      lastSeenAt: Date.now(),
    });
    return token;
  },
});

export const report = mutation({
  args: { token: v.string(), agents: v.array(agentState) },
  returns: v.null(),
  handler: async function (ctx, args) {
    const { hacker, daemon } = await requireDaemon(ctx, args.token);
    const now = Date.now();
    await ctx.db.patch("daemonTokens", daemon._id, { lastSeenAt: now });
    const existing = await ctx.db
      .query("subsets")
      .withIndex("by_hacker_machine", function (q) {
        return q.eq("hackerId", hacker._id).eq("machineName", daemon.machineName);
      })
      .unique();
    if (existing === null) {
      await ctx.db.insert("subsets", {
        hackerId: hacker._id,
        machineName: daemon.machineName,
        agents: args.agents,
        updatedAt: now,
      });
    } else {
      await ctx.db.replace("subsets", existing._id, {
        hackerId: hacker._id,
        machineName: daemon.machineName,
        agents: args.agents,
        updatedAt: now,
      });
    }
    // Routing summaries live only as long as their agent is open on this machine.
    const keep = new Set(args.agents.flatMap(function (a) { return a.open ? [a.agentId] : []; }));
    const summaries = await ctx.db
      .query("routingSummaries")
      .withIndex("by_hacker_agent", function (q) {
        return q.eq("hackerId", hacker._id);
      })
      .collect();
    for (const s of summaries) {
      if (s.machineName === daemon.machineName && !keep.has(s.agentId)) await ctx.db.delete("routingSummaries", s._id);
    }
    return null;
  },
});

// The hacker's own subset, unfiltered (private agents included, marked).
export const mine = query({
  args: {},
  returns: v.array(v.object({ machineName: v.string(), updatedAt: v.number(), agents: v.array(agentState) })),
  handler: async function (ctx) {
    const me = await requireHacker(ctx);
    const rows = await ctx.db
      .query("subsets")
      .withIndex("by_hacker_machine", function (q) {
        return q.eq("hackerId", me._id);
      })
      .collect();
    return rows.map(function (s) {
      return { machineName: s.machineName, updatedAt: s.updatedAt, agents: s.agents };
    });
  },
});
