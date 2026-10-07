import { describe, expect, test } from "bun:test";
import { api } from "./_generated/api";
import { redactSecrets, summaryForCrew, withoutFolder } from "./lib/summaries";
import { type Actor, befriend, hackerNamed, harness, type Harness, must } from "./testing.helpers";

function agent(agentId: string, open: boolean, status: "working" | "idle" = "working") {
  return { agentId, harness: "claude-code", name: "cannonballs", workspace: "listingleads", status, open, lastTurnAt: Date.now() };
}

async function machine(t: Harness, as: Actor, name: string, agents: ReturnType<typeof agent>[]): Promise<string> {
  const token = await as.mutation(api.subsets.pairDaemon, { machineName: name });
  await t.mutation(api.subsets.report, { token, agents });
  return token;
}

const CANNONBALLS = "listingleads@tom/cannonballs · \"build MLS-based email cannonballs for each contact\" · files: convex/cannonballs.ts";

describe("summaries for crewmates' agents", function () {
  test("take out strings that look like keys and tokens", function () {
    expect(redactSecrets("use sk-ant-api03-AbCdEf0123456789xyz to call it")).toBe("use [secret] to call it");
    expect(redactSecrets("token ghp_0123456789abcdefABCDEF0123 and sd_0123456789abcdef0123456789abcdef")).toBe("token [secret] and [secret]");
    expect(redactSecrets("key AKIAABCDEFGHIJKLMNOP, jwt eyJhbGciOiJI.eyJzdWIiOiIx.c2lnbmF0dXJl")).toBe("key [secret], jwt [secret]");
    expect(redactSecrets("hash 3f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a")).toBe("hash [secret]");
    expect(redactSecrets("Q2xhdWRlQ29kZVNlY3JldEtleTEyMw")).toBe("[secret]");
    // Ordinary words, paths, branches and session ids stay.
    const plain = "fix-the-knock-composer-layout-on-small-screens in apps/hud/Sources/Soopdoop/HUDView.swift, session 2f1c9a4e-1b2c-4d3e-8f90-123456789abc";
    expect(redactSecrets(plain)).toBe(plain);
  });

  test("leave off the folder and branch unless the owner shares folder names", function () {
    expect(withoutFolder(CANNONBALLS)).toBe("\"build MLS-based email cannonballs for each contact\" · files: convex/cannonballs.ts");
    expect(withoutFolder("\"just a prompt\"")).toBe("\"just a prompt\"");
    expect(withoutFolder("files: a.ts")).toBe("files: a.ts");
    expect(withoutFolder("listingleads@main")).toBe("");
    expect(summaryForCrew(CANNONBALLS, true)).toBe(CANNONBALLS);
    expect(summaryForCrew("vibes · \"call it with sk-ant-api03-AbCdEf0123456789xyz\"", false)).toBe("\"call it with [secret]\"");
  });
});

describe("introducing crewmates' agents", function () {
  test("lists friends' open, running agents with a summary, newest first, without private ones", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const jimmy = await hackerNamed(t, "jimmy");
    const hedy = await hackerNamed(t, "hedy");
    const stranger = await hackerNamed(t, "stranger");
    await befriend(tom, jimmy, "jimmy");
    await befriend(hedy, jimmy, "jimmy");
    const jimmyToken = await jimmy.mutation(api.subsets.pairDaemon, { machineName: "jm" });

    const tomToken = await machine(t, tom, "mbp", [agent("t1", true), agent("t2", false), agent("t3", true, "idle")]);
    await t.mutation(api.routing.update, { token: tomToken, agentId: "t1", summary: CANNONBALLS });
    await t.mutation(api.routing.update, { token: tomToken, agentId: "t2", summary: "taxes · \"my private thing\"" });
    // t3 has no summary yet: there is nothing to say about it. Hedy's agent is the one active last.
    await Bun.sleep(5);
    const hedyToken = await machine(t, hedy, "vm", [agent("v1", true, "idle")]);
    await t.mutation(api.routing.update, { token: hedyToken, agentId: "v1", summary: "vibes · \"why does the knock ring jump?\"" });
    const strangerToken = await machine(t, stranger, "sm", [agent("s1", true)]);
    await t.mutation(api.routing.update, { token: strangerToken, agentId: "s1", summary: "secret · \"not a friend\"" });

    const view = await t.query(api.routing.crew, { token: jimmyToken });
    expect(view.agents.map(function (a) { return [a.handle, a.status, a.summary]; })).toEqual([
      ["hedy", "idle", "\"why does the knock ring jump?\""],
      ["tom", "working", "\"build MLS-based email cannonballs for each contact\" · files: convex/cannonballs.ts"],
    ]);
    const first = must(view.agents[1]);
    expect(first.since).toBeLessThanOrEqual(view.now);
    expect(first.key).not.toContain("t1");

    // The key and the time it was first heard of stay the same as its summary changes.
    await Bun.sleep(5);
    await t.mutation(api.routing.update, { token: tomToken, agentId: "t1", summary: `${CANNONBALLS}, convex/mls.ts` });
    const later = must((await t.query(api.routing.crew, { token: jimmyToken })).agents[0]);
    expect([later.handle, later.key, later.since]).toEqual(["tom", first.key, first.since]);
  });

  test("an agent whose summary comes back after its owner's daemon restarted is not new", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const jimmy = await hackerNamed(t, "jimmy");
    await befriend(tom, jimmy, "jimmy");
    const jimmyToken = await jimmy.mutation(api.subsets.pairDaemon, { machineName: "jm" });
    const tomToken = await machine(t, tom, "mbp", [agent("t1", true)]);
    await t.mutation(api.routing.update, { token: tomToken, agentId: "t1", summary: CANNONBALLS });
    const first = must((await t.query(api.routing.crew, { token: jimmyToken })).agents[0]);

    // The daemon restarts: its first report has no agents, so the summary goes; then the agent is back with a new one.
    await t.mutation(api.subsets.report, { token: tomToken, agents: [] });
    expect((await t.query(api.routing.crew, { token: jimmyToken })).agents).toEqual([]);
    await Bun.sleep(5);
    await t.mutation(api.subsets.report, { token: tomToken, agents: [agent("t1", true)] });
    await t.mutation(api.routing.update, { token: tomToken, agentId: "t1", summary: CANNONBALLS });
    const back = must((await t.query(api.routing.crew, { token: jimmyToken })).agents[0]);
    expect(back.since).toBe(first.since);
    // And the wire said it started only once.
    expect((await jimmy.query(api.feed.recent, {})).filter(function (e) { return e.kind === "agent"; })).toHaveLength(1);
  });

  test("shows the folder and branch only when shared, a linked name, and nobody in focus mode", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const jimmy = await hackerNamed(t, "jimmy");
    await befriend(tom, jimmy, "jimmy");
    const jimmyToken = await jimmy.mutation(api.subsets.pairDaemon, { machineName: "jm" });
    const tomToken = await machine(t, tom, "mbp", [agent("t1", true)]);
    await t.mutation(api.routing.update, { token: tomToken, agentId: "t1", summary: CANNONBALLS });
    await t.run(async function (ctx) {
      const row = must(await ctx.db.query("hackers").withIndex("by_handle", function (q) { return q.eq("handle", "tom"); }).unique());
      await ctx.db.insert("supersetProfiles", { hackerId: row._id, handle: "redman", name: "Tom Redman", achievements: [], models: [], fetchedAt: Date.now() });
    });

    await tom.mutation(api.hackers.updateSharing, { shareAgentNames: false, shareWorkspaceNames: true });
    const shared = must((await t.query(api.routing.crew, { token: jimmyToken })).agents[0]);
    expect([shared.name, shared.summary]).toEqual(["Tom Redman", CANNONBALLS]);

    await tom.mutation(api.hackers.setFocus, { minutes: 25 });
    expect((await t.query(api.routing.crew, { token: jimmyToken })).agents).toEqual([]);
  });

  test("a summary that comes in with a key in it is kept without the key", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const token = await machine(t, tom, "mbp", [agent("t1", true)]);
    await t.mutation(api.routing.update, { token, agentId: "t1", summary: "vibes · \"deploy with sk-ant-api03-AbCdEf0123456789xyz\"" });
    expect((await tom.query(api.routing.mine, {}))[0]?.summary).toBe("vibes · \"deploy with [secret]\"");
  });

  test("needs a machine's token", async function () {
    const t = harness();
    await expect(t.query(api.routing.crew, { token: "sd_nope" })).rejects.toThrow("Unknown daemon token");
  });
});
