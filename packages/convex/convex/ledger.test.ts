import { afterEach, describe, expect, test } from "bun:test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type Actor, befriend, hackerNamed, harness, type Harness, must, settleScheduled } from "./testing.helpers";

const DAY = 24 * 60 * 60 * 1000;

afterEach(async function () {
  await settleScheduled();
});

async function machine(t: Harness, as: Actor, name: string): Promise<string> {
  const token = await as.mutation(api.subsets.pairDaemon, { machineName: name });
  await t.mutation(api.subsets.report, { token, agents: [] });
  return token;
}

async function idOf(t: Harness, handle: string): Promise<Id<"hackers">> {
  const row = await t.run(async function (ctx) {
    return await ctx.db.query("hackers").withIndex("by_handle", function (q) { return q.eq("handle", handle); }).unique();
  });
  return must(row)._id;
}

// A line as Jimmy's daemon sends it at the end of a session.
function line(sessionKey: string, did: string, extra: Record<string, unknown> = {}) {
  return { sessionKey, harness: "claude-code", workspace: "vibes", branch: "email-metrics", did, areas: ["packages/email", "apps/web/metrics"], files: 6, ...extra };
}

async function feedOf(t: Harness) {
  return await t.run(async function (ctx) { return await ctx.db.query("feed").collect(); });
}

// Runs the scheduled functions named `name` until none is left: a prune that schedules its next page, and so on.
async function drain(t: Harness, name: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise(function (resolve) { setTimeout(resolve, 5); });
    await t.finishInProgressScheduledFunctions();
    const waiting = await t.run(async function (ctx) {
      const jobs = await ctx.db.system.query("_scheduled_functions").collect();
      return jobs.filter(function (j) { return j.name.includes(name) && (j.state.kind === "pending" || j.state.kind === "inProgress"); });
    });
    if (waiting.length === 0) return;
  }
  throw new Error(`${name} kept scheduling itself`);
}

// Tom and Jimmy are crewmates; each has a paired Mac.
async function crew(t: Harness) {
  const tom = await hackerNamed(t, "tom");
  const jimmy = await hackerNamed(t, "jimmy");
  await befriend(tom, jimmy, "jimmy");
  const tomToken = await machine(t, tom, "mbp16");
  const jimmyToken = await machine(t, jimmy, "jm");
  return { tom, jimmy, tomToken, jimmyToken };
}

describe("the ledger", function () {
  test("a line per session: secrets out, cut at 240, sent again it replaces the old one, and its first ship is on the wire once", async function () {
    const t = harness();
    const { jimmy, jimmyToken } = await crew(t);
    const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const id = await t.mutation(api.ledger.report, { token: jimmyToken, ...line("s1", `fixed bounce counts with ${key} ${"x".repeat(300)}`) });
    const [first] = await jimmy.query(api.ledger.mine, {});
    expect(first).toMatchObject({ _id: id, harness: "claude-code", machineName: "jm", sessionKey: "s1", workspace: "vibes", branch: "email-metrics", files: 6 });
    expect(first?.did).toHaveLength(240);
    expect(first?.did).not.toContain("sk-ant");
    expect(first?.did).toContain("[secret]");

    // The session went on: the same line, with a PR that merged.
    const again = await t.mutation(api.ledger.report, {
      token: jimmyToken,
      ...line("s1", "fixed delivery counts double-counting bounces", { pr: "https://github.com/vibes/vibes/pull/418", shipped: true, areas: ["packages/email", "packages/email", " "], files: 7.4 }),
    });
    expect(again).toBe(id);
    const lines = await jimmy.query(api.ledger.mine, {});
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ did: "fixed delivery counts double-counting bounces", pr: "https://github.com/vibes/vibes/pull/418", shipped: true, areas: ["packages/email"], files: 7 });
    const ships = (await feedOf(t)).filter(function (e) { return e.kind === "ship"; });
    expect(ships).toMatchObject([{ text: "fixed delivery counts double-counting bounces", url: "https://github.com/vibes/vibes/pull/418", ledgerId: id }]);

    // Sent again without the PR, and without "shipped": the PR stays, it stays shipped, and it is not news twice.
    await t.mutation(api.ledger.report, { token: jimmyToken, ...line("s1", "fixed delivery counts double-counting bounces") });
    expect((await jimmy.query(api.ledger.mine, {}))[0]).toMatchObject({ pr: "https://github.com/vibes/vibes/pull/418", shipped: true });
    expect((await feedOf(t)).filter(function (e) { return e.kind === "ship"; })).toHaveLength(1);

    // Another session is another line.
    await t.mutation(api.ledger.report, { token: jimmyToken, ...line("s2", "tuned the bounce webhook") });
    expect((await jimmy.query(api.ledger.mine, {})).map(function (l) { return l.sessionKey; })).toEqual(["s2", "s1"]);
  });

  test("a line needs a token, a session key and what was done", async function () {
    const t = harness();
    const { jimmyToken } = await crew(t);
    await expect(t.mutation(api.ledger.report, { token: "sd_nope", ...line("s1", "did it") })).rejects.toThrow("Unknown daemon token");
    await expect(t.mutation(api.ledger.report, { token: jimmyToken, ...line("s1", "   ") })).rejects.toThrow("says what was done");
    await expect(t.mutation(api.ledger.report, { token: jimmyToken, ...line(" ", "did it") })).rejects.toThrow("session's key");
    // A time in the future is now.
    const before = Date.now();
    await t.mutation(api.ledger.report, { token: jimmyToken, ...line("s1", "did it", { at: Date.now() + 10 * DAY }) });
    const stored = await t.run(async function (ctx) { return await ctx.db.query("ledger").collect(); });
    expect(must(stored[0]).at).toBeLessThan(before + DAY);
  });

  test("the owner's last 50 lines, newest first, and nobody else's", async function () {
    const t = harness();
    const { tom, jimmy, jimmyToken, tomToken } = await crew(t);
    for (let i = 0; i < 52; i++) await t.mutation(api.ledger.report, { token: jimmyToken, ...line(`s${i}`, `piece ${i}`, { at: Date.now() - (52 - i) * 60_000 }) });
    await t.mutation(api.ledger.report, { token: tomToken, ...line("t1", "tom's work") });
    const mine = await jimmy.query(api.ledger.mine, {});
    expect(mine).toHaveLength(50);
    expect(mine[0]?.did).toBe("piece 51");
    expect(mine.some(function (l) { return l.did === "tom's work"; })).toBe(false);
    expect((await tom.query(api.ledger.mine, {})).map(function (l) { return l.did; })).toEqual(["tom's work"]);
  });

  test("the owner edits a line: the daemon never overwrites it again, and the wire says it their way", async function () {
    const t = harness();
    const { tom, jimmy, jimmyToken } = await crew(t);
    const id = await t.mutation(api.ledger.report, { token: jimmyToken, ...line("s1", "fixd bounces", { shipped: true }) });
    await expect(tom.mutation(api.ledger.edit, { ledgerId: id, did: "mine now" })).rejects.toThrow("Not your ledger line");
    await expect(jimmy.mutation(api.ledger.edit, { ledgerId: id, did: "  " })).rejects.toThrow("forget the line");
    await jimmy.mutation(api.ledger.edit, { ledgerId: id, did: "fixed the double-counted bounces (VIB-123)" });
    await t.mutation(api.ledger.report, { token: jimmyToken, ...line("s1", "fixd bounces again", { files: 9 }) });
    expect((await jimmy.query(api.ledger.mine, {}))[0]).toMatchObject({ did: "fixed the double-counted bounces (VIB-123)", editedByOwner: true, files: 9 });
    expect((await feedOf(t)).find(function (e) { return e.kind === "ship"; })?.text).toBe("fixed the double-counted bounces (VIB-123)");
  });

  test("the owner forgets a line, and its ship and walkthrough leave the wire with it", async function () {
    const t = harness();
    const { tom, jimmy, jimmyToken } = await crew(t);
    const id = await t.mutation(api.ledger.report, { token: jimmyToken, ...line("s1", "fixed bounces", { shipped: true }) });
    await jimmy.mutation(api.ledger.setWalkthrough, { ledgerId: id, url: "https://example.com/walkthrough/418" });
    expect(await feedOf(t)).toHaveLength(2);
    await expect(tom.mutation(api.ledger.forget, { ledgerId: id })).rejects.toThrow("Not your ledger line");
    await jimmy.mutation(api.ledger.forget, { ledgerId: id });
    expect(await jimmy.query(api.ledger.mine, {})).toEqual([]);
    expect(await feedOf(t)).toEqual([]);
  });

  test("a forgotten line stays forgotten when the daemon sends it again, and keeps none of its words", async function () {
    const t = harness();
    const { tom, jimmy, jimmyToken, tomToken } = await crew(t);
    const id = await t.mutation(api.ledger.report, { token: jimmyToken, ...line("s1", "fixed bounces", { shipped: true, pr: "https://example.com/pr/1" }) });
    await jimmy.mutation(api.ledger.forget, { ledgerId: id });
    expect(await t.mutation(api.ledger.report, { token: jimmyToken, ...line("s1", "fixed bounces", { shipped: true }) })).toBe(id);
    expect(await jimmy.query(api.ledger.mine, {})).toEqual([]);
    expect(await feedOf(t)).toEqual([]);
    expect(await t.query(api.ledger.crewRecent, { token: tomToken })).toEqual([]);
    expect(await t.query(internal.ledger.search, { hackerId: await idOf(t, "tom"), query: "bounces", days: 14 })).toEqual([]);
    const stored = must(await t.run(async function (ctx) { return await ctx.db.get("ledger", id); }));
    expect(stored).toMatchObject({ forgotten: true, did: "", areas: [], files: 0 });
    expect(stored.pr).toBeUndefined();
    expect(stored.workspace).toBeUndefined();
    await expect(jimmy.mutation(api.ledger.edit, { ledgerId: id, did: "back again" })).rejects.toThrow("Not your ledger line");
    // Another session is a new line as usual.
    await t.mutation(api.ledger.report, { token: jimmyToken, ...line("s2", "tuned the webhook") });
    expect((await jimmy.query(api.ledger.mine, {})).map(function (l) { return l.did; })).toEqual(["tuned the webhook"]);
    void tom;
  });

  test("a walkthrough goes on the line and on the wire once; asking about one is remembered", async function () {
    const t = harness();
    const { tom, jimmy, jimmyToken } = await crew(t);
    const id = await t.mutation(api.ledger.report, { token: jimmyToken, ...line("s1", "redesigned the quote page", { shipped: true }) });
    await expect(jimmy.mutation(api.ledger.setWalkthrough, { ledgerId: id, url: "javascript:alert(1)" })).rejects.toThrow("web link");
    await expect(tom.mutation(api.ledger.setWalkthrough, { ledgerId: id, url: "https://example.com/w" })).rejects.toThrow("Not your ledger line");
    await jimmy.mutation(api.ledger.setWalkthrough, { ledgerId: id, url: "https://example.com/w1" });
    await jimmy.mutation(api.ledger.setWalkthrough, { ledgerId: id, url: "https://example.com/w2" });
    expect((await jimmy.query(api.ledger.mine, {}))[0]).toMatchObject({ walkthrough: "https://example.com/w2", walkthroughAsked: true });
    const walkthroughs = (await feedOf(t)).filter(function (e) { return e.kind === "walkthrough"; });
    expect(walkthroughs).toMatchObject([{ url: "https://example.com/w2", ledgerId: id, text: "redesigned the quote page" }]);

    const other = await t.mutation(api.ledger.report, { token: jimmyToken, ...line("s2", "small fix") });
    await jimmy.mutation(api.ledger.markWalkthroughAsked, { ledgerId: other });
    expect((await jimmy.query(api.ledger.mine, {})).find(function (l) { return l._id === other; })).toMatchObject({ walkthroughAsked: true });
    expect((await jimmy.query(api.ledger.mine, {})).find(function (l) { return l._id === other; })?.walkthrough).toBeUndefined();
  });

  test("crewmates' recent lines for the daemon: not mine, not strangers', newest first, two weeks by default, folders only when shared", async function () {
    const t = harness();
    const { tom, jimmy, tomToken, jimmyToken } = await crew(t);
    const stranger = await hackerNamed(t, "sam");
    const samToken = await machine(t, stranger, "sm");
    await t.mutation(api.ledger.report, { token: jimmyToken, ...line("j1", "fixed bounces", { at: Date.now() - 2 * DAY, shipped: true }) });
    await t.mutation(api.ledger.report, { token: jimmyToken, ...line("j2", "tuned the webhook", { at: Date.now() - DAY }) });
    await t.mutation(api.ledger.report, { token: jimmyToken, ...line("j3", "old work", { at: Date.now() - 20 * DAY }) });
    await t.mutation(api.ledger.report, { token: tomToken, ...line("t1", "my own work") });
    await t.mutation(api.ledger.report, { token: samToken, ...line("x1", "a stranger's work") });

    const recent = await t.query(api.ledger.crewRecent, { token: tomToken });
    expect(recent.map(function (l) { return l.did; })).toEqual(["tuned the webhook", "fixed bounces"]);
    expect(recent[1]).toMatchObject({ handle: "jimmy", harness: "claude-code", areas: ["packages/email", "apps/web/metrics"], shipped: true });
    expect(recent[1]?.workspace).toBeUndefined();
    expect((await t.query(api.ledger.crewRecent, { token: tomToken, days: 30 })).map(function (l) { return l.did; })).toContain("old work");

    await jimmy.mutation(api.hackers.updateSharing, { shareWorkspaceNames: true, shareAgentNames: false });
    expect((await t.query(api.ledger.crewRecent, { token: tomToken }))[0]?.workspace).toBe("vibes");
    await expect(t.query(api.ledger.crewRecent, { token: "sd_nope" })).rejects.toThrow("Unknown daemon token");
    void tom;
  });

  test("the Operator's search: crewmates' lines that fit, best first, at most 8, never the asker's own", async function () {
    const t = harness();
    const { tom, tomToken, jimmyToken } = await crew(t);
    const ada = await hackerNamed(t, "adalovelace");
    await befriend(tom, ada, "adalovelace");
    const adaToken = await machine(t, ada, "al");
    await t.run(async function (ctx) {
      const adaId = must(await ctx.db.query("hackers").withIndex("by_handle", function (q) { return q.eq("handle", "adalovelace"); }).unique())._id;
      await ctx.db.insert("supersetProfiles", { hackerId: adaId, handle: "alovelace", name: "Ada Lovelace", achievements: [], models: [], fetchedAt: Date.now() });
    });
    await t.mutation(api.ledger.report, { token: adaToken, ...line("a1", "new pricing table", { areas: ["apps/web/pricing"] }) });
    await t.mutation(api.ledger.report, { token: adaToken, ...line("a2", "pricing plans copy", { areas: ["docs"] }) });
    for (let i = 0; i < 9; i++) await t.mutation(api.ledger.report, { token: jimmyToken, ...line(`j${i}`, `bounce fix ${i}`) });
    await t.mutation(api.ledger.report, { token: tomToken, ...line("t1", "pricing experiments of my own") });

    const tomId = await idOf(t, "tom");
    const hits = await t.query(internal.ledger.search, { hackerId: tomId, query: "who knows about pricing?", days: 14 });
    // The line whose folder is about pricing too comes first.
    expect(hits.map(function (h) { return [h.handle, h.did, h.name]; })).toEqual([
      ["adalovelace", "new pricing table", "Ada Lovelace"],
      ["adalovelace", "pricing plans copy", "Ada Lovelace"],
    ]);
    expect(hits[0]?.workspace).toBeUndefined();
    expect(await t.query(internal.ledger.search, { hackerId: tomId, query: "email bounces", days: 14 })).toHaveLength(8);
    expect(await t.query(internal.ledger.search, { hackerId: tomId, query: "the coupon code", days: 14 })).toEqual([]);
  });

  test("the daily prune keeps a week on the free plan and with no crew, 90 days on the team plan", async function () {
    const t = harness();
    const { tomToken, jimmyToken } = await crew(t);
    const tomId = await idOf(t, "tom");
    // Tom's crew is on the team plan; Jimmy is in no crew.
    await t.run(async function (ctx) {
      const crewId = await ctx.db.insert("crews", { name: "vibes", leaderId: tomId, plan: "team", digestHour: 9, timezone: "America/Toronto", createdAt: Date.now() });
      await ctx.db.insert("crewMembers", { crewId, hackerId: tomId, role: "leader", joinedAt: Date.now() });
    });
    for (const [key, days] of [["t6", 6], ["t30", 30], ["t91", 91]] as const) {
      await t.mutation(api.ledger.report, { token: tomToken, ...line(key, `tom ${days} days ago`, { at: Date.now() - days * DAY }) });
    }
    for (const [key, days] of [["j6", 6], ["j8", 8]] as const) {
      await t.mutation(api.ledger.report, { token: jimmyToken, ...line(key, `jimmy ${days} days ago`, { at: Date.now() - days * DAY }) });
    }
    // Many old lines take more than one page.
    for (let i = 0; i < 230; i++) {
      await t.mutation(api.ledger.report, { token: jimmyToken, ...line(`old${i}`, "old", { at: Date.now() - (10 + i / 100) * DAY }) });
    }
    await t.mutation(internal.ledger.prune, {});
    await drain(t, "prune");
    const left = await t.run(async function (ctx) { return await ctx.db.query("ledger").collect(); });
    expect(left.map(function (l) { return l.did; }).sort()).toEqual(["jimmy 6 days ago", "tom 30 days ago", "tom 6 days ago"]);
  });
});
