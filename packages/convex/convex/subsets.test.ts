import { describe, expect, setSystemTime, test } from "bun:test";
import { api } from "./_generated/api";
import { befriend, hackerNamed, harness, must } from "./testing.helpers";

const working = { agentId: "s1", harness: "claude-code", name: "listing-cards", workspace: "vibes", status: "working" as const, open: true, lastTurnAt: 1 };
const idle = { ...working, agentId: "s2", name: "tests", status: "idle" as const };
const secret = { ...working, agentId: "s3", name: "taxes-2026", workspace: "taxes", open: false };

describe("subsets and presence", function () {
  test("the daemon reports with its token; friends see only what the owner shares", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const mira = await hackerNamed(t, "mira");
    await befriend(tom, mira, "mira");

    await expect(t.mutation(api.subsets.report, { token: "sd_nope", agents: [] })).rejects.toThrow("Unknown daemon token");
    const token = await tom.mutation(api.subsets.pairDaemon, { machineName: "tom-mbp" });
    expect(token.startsWith("sd_")).toBe(true);

    await t.mutation(api.subsets.report, { token, agents: [working, idle, secret] });
    // The owner sees everything, private agents included.
    const mine = await tom.query(api.subsets.mine, {});
    expect(mine).toHaveLength(1);
    expect(must(mine[0]).machineName).toBe("tom-mbp");
    expect(must(mine[0]).agents.map((a) => a.name)).toEqual(["listing-cards", "tests", "taxes-2026"]);

    // A friend sees the LED and the count of open agents, no names by default.
    let [view] = await mira.query(api.friends.list, {});
    expect(view?.led).toBe("g");
    expect(view?.agentCount).toBe(2);
    expect(view?.agents).toBeUndefined();

    await tom.mutation(api.hackers.updateSharing, { shareAgentNames: true, shareWorkspaceNames: false });
    [view] = await mira.query(api.friends.list, {});
    expect(view?.agents?.map((a) => a.name)).toEqual(["listing-cards", "tests"]);
    expect(view?.agents?.every((a) => a.workspace === undefined)).toBe(true);

    await tom.mutation(api.hackers.updateSharing, { shareAgentNames: true, shareWorkspaceNames: true });
    [view] = await mira.query(api.friends.list, {});
    expect(view?.agents?.[0]?.workspace).toBe("vibes");

    // A second report replaces the list. Only idle agents left: blue.
    await t.mutation(api.subsets.report, { token, agents: [idle] });
    [view] = await mira.query(api.friends.list, {});
    expect(view?.led).toBe("b");
    expect(view?.agentCount).toBe(1);
    expect(await tom.query(api.subsets.mine, {})).toHaveLength(1);

    // An empty subset is online but ∅.
    await t.mutation(api.subsets.report, { token, agents: [] });
    [view] = await mira.query(api.friends.list, {});
    expect(view?.led).toBe("b");
    expect(view?.agentCount).toBe(0);
  });

  test("a silent daemon goes dark after 90 s, and focus hides everything", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const mira = await hackerNamed(t, "mira");
    await befriend(tom, mira, "mira");
    const token = await tom.mutation(api.subsets.pairDaemon, { machineName: "tom-mbp" });
    await t.mutation(api.subsets.report, { token, agents: [working] });
    expect((await mira.query(api.friends.list, {}))[0]?.led).toBe("g");

    const reported = Date.now();
    setSystemTime(new Date(reported + 100_000));
    try {
      expect((await mira.query(api.friends.list, {}))[0]?.led).toBe("x");
      expect((await mira.query(api.friends.list, {}))[0]?.agentCount).toBe(0);
    } finally {
      setSystemTime();
    }

    await tom.mutation(api.hackers.setFocus, { minutes: 45 });
    await tom.mutation(api.hackers.updateSharing, { shareAgentNames: true, shareWorkspaceNames: true });
    const [view] = await mira.query(api.friends.list, {});
    expect(view?.inFocus).toBe(true);
    expect(view?.led).toBe("x");
    expect(view?.agentCount).toBe(0);
    expect(view?.agents).toBeUndefined();
  });
});
