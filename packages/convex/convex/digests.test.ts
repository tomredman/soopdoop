// ABOUTME: Tests for the digest: when it is due in a crew's time zone, the hourly tick, what goes into a day's material,
// ABOUTME: writing, keeping and posting the daily digest (OPERATOR_FAKE, a stand-in Slack), the weekly numbers and `latest`.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { due, isDigestHour } from "./digests";
import { plainDigest } from "./lib/digest";
import { dayWindow, localTime } from "./lib/localTime";
import { crewIdOf, hackerNamed, harness, type Harness, idOf, invite, must, settleScheduled, teamPlan } from "./testing.helpers";

const WEBHOOK = "https://hooks.slack.com/services/T0/B0/madeup";
const TORONTO = "America/Toronto";

let savedFake: string | undefined;
beforeEach(function () {
  savedFake = process.env.OPERATOR_FAKE;
  process.env.OPERATOR_FAKE = "1";
});
afterEach(async function () {
  await settleScheduled();
  if (savedFake === undefined) delete process.env.OPERATOR_FAKE;
  else process.env.OPERATOR_FAKE = savedFake;
  const f = globalThis.fetch as unknown as { mockRestore?: () => void };
  f.mockRestore?.();
});

// Lets the functions scheduled at once run (a few rounds, for ones that schedule more).
async function drain(t: Harness): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise(function (resolve) { setTimeout(resolve, 5); });
    await t.finishInProgressScheduledFunctions();
  }
}

function slack(): string[] {
  const sent: string[] = [];
  spyOn(globalThis, "fetch").mockImplementation(async function (_input: string | URL | Request, init?: RequestInit) {
    sent.push(String(init?.body));
    return new Response("ok", { status: 200 });
  } as unknown as typeof fetch);
  return sent;
}

// Tom leads a team-plan crew in Toronto with Ada, Jimmy and Grace in it. Sam is Tom's friend, outside the crew.
async function teamCrew(t: Harness) {
  const tom = await hackerNamed(t, "tom");
  const ada = await hackerNamed(t, "adalovelace");
  const jimmy = await hackerNamed(t, "jimmy");
  const grace = await hackerNamed(t, "grace");
  const sam = await hackerNamed(t, "sam");
  for (const who of [ada, jimmy, grace]) await invite(tom, who);
  const crewId = await crewIdOf(t, "tom");
  await teamPlan(t, crewId);
  await tom.mutation(api.crews.setDigest, { digestHour: 9, timezone: TORONTO });
  const ids = {
    tom: await idOf(t, "tom"),
    ada: await idOf(t, "adalovelace"),
    jimmy: await idOf(t, "jimmy"),
    grace: await idOf(t, "grace"),
    sam: await idOf(t, "sam"),
  };
  await t.run(async function (ctx) {
    await ctx.db.insert("supersetProfiles", { hackerId: ids.ada, handle: "ada-lovelace", name: "Ada Lovelace", achievements: [], models: [], fetchedAt: Date.now() });
  });
  return { tom, ada, jimmy, grace, sam, crewId, ids };
}

describe("when the digest is due", function () {
  test("at the crew's hour, or the hour after when a tick was missed, never past midnight", function () {
    expect(isDigestHour(9, 9)).toBe(true);
    expect(isDigestHour(10, 9)).toBe(true);
    expect(isDigestHour(11, 9)).toBe(false);
    expect(isDigestHour(8, 9)).toBe(false);
    expect(isDigestHour(23, 23)).toBe(true);
    expect(isDigestHour(0, 23)).toBe(false);
  });

  test("the day before, in the crew's time zone, and the weekly numbers on its Monday", function () {
    const toronto = { digestHour: 9, timezone: TORONTO };
    // 13:30 UTC on Monday 19 Oct 2026 is 9:30 in Toronto.
    expect(due(toronto, Date.UTC(2026, 9, 19, 13, 30))).toEqual({ day: "2026-10-18", weekly: true });
    expect(due(toronto, Date.UTC(2026, 9, 19, 14, 30))).toEqual({ day: "2026-10-18", weekly: true });
    expect(due(toronto, Date.UTC(2026, 9, 19, 15, 30))).toBeNull();
    expect(due(toronto, Date.UTC(2026, 9, 18, 13, 30))).toEqual({ day: "2026-10-17", weekly: false });
    // The same instant is 22:30 in Tokyo; Tokyo's 9:30 on Monday is 00:30 UTC.
    const tokyo = { digestHour: 9, timezone: "Asia/Tokyo" };
    expect(due(tokyo, Date.UTC(2026, 9, 19, 13, 30))).toBeNull();
    expect(due(tokyo, Date.UTC(2026, 9, 19, 0, 30))).toEqual({ day: "2026-10-18", weekly: true });
    expect(due({ digestHour: 9, timezone: "Nowhere/Land" }, Date.UTC(2026, 9, 19, 13, 30))).toBeNull();
  });

  test("the hourly tick schedules the crews that are due, once, on the team plan only", async function () {
    const t = harness();
    const leaders = ["tom", "adalovelace", "jimmy", "grace"];
    const crews: Id<"crews">[] = [];
    for (const handle of leaders) {
      const as = await hackerNamed(t, handle);
      crews.push(await as.mutation(api.crews.create, { name: `${handle}'s crew` }));
    }
    const [due1, free, tokyo, written] = crews.map(must);
    await t.run(async function (ctx) {
      for (const id of [due1, tokyo, written]) await ctx.db.patch("crews", must(id), { plan: "team" });
      for (const id of [due1, free, written]) await ctx.db.patch("crews", must(id), { timezone: TORONTO });
      await ctx.db.patch("crews", must(tokyo), { timezone: "Asia/Tokyo" });
      await ctx.db.insert("digests", { crewId: must(written), day: "2026-10-18", kind: "daily", text: "Yesterday in grace's crew", writtenAt: Date.now() });
    });
    const now = Date.UTC(2026, 9, 19, 13, 30);
    expect(await t.mutation(internal.digests.tick, { now })).toEqual({ daily: 1, weekly: 2 });
    const jobs = await t.run(async function (ctx) { return await ctx.db.system.query("_scheduled_functions").collect(); });
    const planned = jobs
      .filter(function (j) { return j.name.startsWith("digests:"); })
      .map(function (j) { return [j.name, crews.indexOf(must(j.args[0]).crewId), must(j.args[0]).day]; })
      .sort();
    expect(planned).toEqual([
      ["digests:writeDaily", 0, "2026-10-18"],
      ["digests:writeWeekly", 0, "2026-10-18"],
      ["digests:writeWeekly", 3, "2026-10-18"],
    ]);
    // Outside the hour, nothing.
    expect(await t.mutation(internal.digests.tick, { now: now + 3 * 60 * 60 * 1000 })).toEqual({ daily: 0, weekly: 0 });
  });
});

describe("the daily digest", function () {
  test("a day's material: the crew's events in its local day, by first name, without anyone hidden or outside", async function () {
    const t = harness();
    const { grace, crewId, ids } = await teamCrew(t);
    await grace.mutation(api.hackers.setHideFromBoards, { hide: true });
    const day = localTime(Date.now(), TORONTO).day;
    const { from } = dayWindow(day, TORONTO);
    const at = Math.max(from, Date.now() - 60_000);
    await t.run(async function (ctx) {
      const line = { harness: "claude-code", machineName: "m", areas: ["apps/web"], files: 2 };
      const shipped = await ctx.db.insert("ledger", { ...line, hackerId: ids.ada, at, sessionKey: "s1", did: "the quote page redesign", pr: "https://github.com/acme/web/pull/412", shipped: true, walkthrough: "https://example.com/d/w1" });
      const earlier = await ctx.db.insert("ledger", { ...line, hackerId: ids.jimmy, at: from - 3 * 86_400_000, sessionKey: "s0", did: "the export fix", shipped: true });
      await ctx.db.insert("ledger", { ...line, hackerId: ids.jimmy, at, sessionKey: "s2", did: "fixed delivery counts double-counting bounces" });
      await ctx.db.insert("ledger", { ...line, hackerId: ids.grace, at, sessionKey: "s3", did: "grace's quiet work" });
      const ship = await ctx.db.insert("feed", { kind: "ship", hackerId: ids.ada, text: "the quote page redesign", url: "https://github.com/acme/web/pull/412", ledgerId: shipped, at: at + 1 });
      await ctx.db.insert("feed", { kind: "walkthrough", hackerId: ids.ada, url: "https://example.com/d/w1", ledgerId: shipped, text: "the quote page redesign", at: at + 2 });
      await ctx.db.insert("feed", { kind: "walkthrough", hackerId: ids.jimmy, url: "https://example.com/d/w0", ledgerId: earlier, text: "the export fix", at: at + 3 });
      await ctx.db.insert("feed", { kind: "handoff", hackerId: ids.jimmy, otherHackerId: ids.tom, text: "VIB-123 fixed", url: "https://github.com/acme/web/pull/413", at: at + 4 });
      await ctx.db.insert("feed", { kind: "headsup", hackerId: ids.tom, otherHackerId: ids.jimmy, at: at + 5 });
      await ctx.db.insert("feed", { kind: "props", hackerId: ids.jimmy, fromCustomer: true, text: "got props from a customer: fast fix", at: at + 6 });
      await ctx.db.insert("feed", { kind: "props", hackerId: ids.tom, otherHackerId: ids.ada, about: ship, at: at + 7 });
      await ctx.db.insert("feed", { kind: "save", hackerId: ids.jimmy, text: "a customer went from upset to thanks", at: at + 8 });
      await ctx.db.insert("feed", { kind: "note", hackerId: ids.ada, text: "the quote page uses the M10 components", at: at + 9 });
      await ctx.db.insert("feed", { kind: "shout", hackerId: ids.tom, text: "CI is green again", at: at + 10 });
      await ctx.db.insert("feed", { kind: "agent", hackerId: ids.ada, agentId: "a1", at: at + 11 });
      // Left out: Grace hides from the board; Sam is outside the crew; one line is from the day before.
      await ctx.db.insert("feed", { kind: "shout", hackerId: ids.grace, text: "grace's shout", at: at + 12 });
      await ctx.db.insert("feed", { kind: "props", hackerId: ids.tom, otherHackerId: ids.grace, at: at + 13 });
      await ctx.db.insert("feed", { kind: "shout", hackerId: ids.sam, text: "sam's shout", at: at + 14 });
      await ctx.db.insert("feed", { kind: "handoff", hackerId: ids.ada, otherHackerId: ids.sam, text: "for someone outside", at: at + 15 });
      await ctx.db.insert("feed", { kind: "ship", hackerId: ids.ada, text: "the day before", at: from - 1 });
      // Ada's agent answered Tom; the Operator answered Jimmy itself.
      await ctx.db.insert("relays", { askerHackerId: ids.tom, question: "where is the quote total computed?", status: "answered", targetHackerId: ids.ada, tokensRead: 2_000, tokensSent: 100, createdAt: Date.now() });
      await ctx.db.insert("relays", { askerHackerId: ids.jimmy, question: "hi", status: "answered", byOperator: true, createdAt: Date.now() });
    });
    expect(await t.query(internal.digests.material, { crewId, day })).toEqual({
      crew: "tom's crew",
      day,
      ships: [{ who: "Ada", text: "the quote page redesign", url: "https://github.com/acme/web/pull/412", walkthrough: "https://example.com/d/w1" }],
      walkthroughs: [{ who: "@jimmy", text: "the export fix", url: "https://example.com/d/w0" }],
      handoffs: [{ who: "@jimmy", forWho: "@tom", text: "VIB-123 fixed", url: "https://github.com/acme/web/pull/413" }],
      headsups: [{ who: "@tom", other: "@jimmy" }],
      props: [
        { who: "@jimmy", text: "fast fix", fromCustomer: true },
        { who: "Ada", from: "@tom", text: "the quote page redesign", fromCustomer: false },
      ],
      saves: [{ who: "@jimmy", text: "a customer went from upset to thanks" }],
      notes: [{ who: "Ada", text: "the quote page uses the M10 components" }],
      shouts: [{ who: "@tom", text: "CI is green again" }],
      work: [{ who: "@jimmy", did: "fixed delivery counts double-counting bounces" }],
      numbers: { answered: 1, tokensSaved: 1_900, handoffs: 0, headsups: 0, ships: 1, walkthroughs: 1 },
    });
  });

  test("is written, kept once, put on the wire and posted to the crew's Slack", async function () {
    const t = harness();
    const { tom, ada, crewId, ids } = await teamCrew(t);
    await tom.mutation(api.crews.setSlack, { webhook: WEBHOOK });
    const sent = slack();
    const day = localTime(Date.now(), TORONTO).day;
    await t.run(async function (ctx) {
      await ctx.db.insert("feed", { kind: "shout", hackerId: ids.ada, text: "the M10 migration is done & merged", at: Date.now() - 1000 });
      await ctx.db.insert("ledger", { hackerId: ids.ada, at: Date.now() - 1000, harness: "claude-code", machineName: "am", sessionKey: "s1", did: "the M10 migration", areas: ["apps/web"], files: 9, shipped: true });
    });
    const material = must(await t.query(internal.digests.material, { crewId, day }));
    await t.action(internal.digests.writeDaily, { crewId, day });
    await drain(t);
    const digests = await t.run(async function (ctx) { return await ctx.db.query("digests").collect(); });
    expect(digests).toHaveLength(1);
    const digest = must(digests[0]);
    expect(digest).toMatchObject({ crewId, day, kind: "daily", text: plainDigest(material) });
    expect(digest.text.split("\n")[0]).toBe("Yesterday in tom's crew: 1 ship");
    expect(digest.usd).toBeUndefined();
    expect(digest.postedAt).toBeGreaterThan(0);
    expect(sent).toEqual([JSON.stringify({ text: plainDigest(material).replace(/&/g, "&amp;") })]);
    const line = must((await ada.query(api.feed.recent, {})).find(function (e) { return e.kind === "digest"; }));
    expect(line).toMatchObject({ handle: "tom", text: "Yesterday in tom's crew: 1 ship", digestId: digest._id });

    // Written once: a second run (a later tick) keeps the first and posts nothing.
    await t.action(internal.digests.writeDaily, { crewId, day });
    await drain(t);
    expect(await t.run(async function (ctx) { return (await ctx.db.query("digests").collect()).length; })).toBe(1);
    expect(sent).toHaveLength(1);
    expect(await ada.query(api.digests.latest, {})).toEqual({
      daily: { _id: digest._id, day, text: digest.text, writtenAt: digest.writtenAt, postedAt: must(digest.postedAt), postError: undefined },
      weekly: null,
    });
  });

  test("a quiet day has no digest, and a crew on the free plan gets none", async function () {
    const t = harness();
    const { crewId, ids } = await teamCrew(t);
    const sent = slack();
    const day = localTime(Date.now(), TORONTO).day;
    await t.action(internal.digests.writeDaily, { crewId, day });
    expect(await t.run(async function (ctx) { return await ctx.db.query("digests").collect(); })).toEqual([]);

    await t.run(async function (ctx) {
      await ctx.db.patch("crews", crewId, { plan: "free" });
      await ctx.db.insert("feed", { kind: "shout", hackerId: ids.ada, text: "busy now", at: Date.now() - 1000 });
    });
    expect(await t.query(internal.digests.material, { crewId, day })).toBeNull();
    await t.action(internal.digests.writeDaily, { crewId, day });
    await drain(t);
    expect(await t.run(async function (ctx) { return await ctx.db.query("digests").collect(); })).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe("the weekly numbers", function () {
  test("the week's four numbers are kept, posted and on the wire, once; a week of zeros says nothing", async function () {
    const t = harness();
    const { tom, ada, crewId, ids } = await teamCrew(t);
    await tom.mutation(api.crews.setSlack, { webhook: WEBHOOK });
    const sent = slack();
    const day = localTime(Date.now(), TORONTO).day;
    expect(await t.mutation(internal.digests.writeWeekly, { crewId, day })).toBeNull();

    await t.run(async function (ctx) {
      const now = Date.now();
      await ctx.db.insert("relays", { askerHackerId: ids.tom, question: "q", status: "answered", targetHackerId: ids.ada, tokensRead: 50_000, tokensSent: 1_000, createdAt: now });
      await ctx.db.insert("handoffs", { fromId: ids.tom, toId: ids.jimmy, text: "fix VIB-123", status: "done", createdAt: now - 86_400_000, expiresAt: now, finishedAt: now - 1000 });
      await ctx.db.insert("ledger", { hackerId: ids.ada, at: now - 3 * 86_400_000, harness: "codex", machineName: "am", sessionKey: "s1", did: "the quote page", areas: [], files: 1, shipped: true, walkthrough: "https://example.com/d/1" });
      await ctx.db.insert("ledger", { hackerId: ids.ada, at: now - 10 * 86_400_000, harness: "codex", machineName: "am", sessionKey: "s0", did: "too long ago", areas: [], files: 1, shipped: true });
    });
    const digestId = must(await t.mutation(internal.digests.writeWeekly, { crewId, day }));
    await drain(t);
    const text = [
      "This week in tom's crew",
      "• 1 question answered by crewmates' agents, about 49k tokens saved",
      "• 1 hand-off done by the agent that knew the area",
      "• 1 ship, 1 with a walkthrough",
    ].join("\n");
    expect(await t.run(async function (ctx) { return (await ctx.db.get("digests", digestId))?.text; })).toBe(text);
    expect(sent).toEqual([JSON.stringify({ text })]);
    expect(must((await ada.query(api.feed.recent, {})).find(function (e) { return e.kind === "digest"; })).text).toBe("This week in tom's crew");
    expect(await t.mutation(internal.digests.writeWeekly, { crewId, day })).toBeNull();
    expect((await ada.query(api.digests.latest, {})).weekly?.text).toBe(text);
  });

  test("someone in no crew has no digest", async function () {
    const t = harness();
    const sam = await hackerNamed(t, "sam");
    expect(await sam.query(api.digests.latest, {})).toEqual({ daily: null, weekly: null });
  });
});
