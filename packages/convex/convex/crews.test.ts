// ABOUTME: Tests for crews: invites that start and join crews, crew scope against friends, the leader's settings, members
// ABOUTME: coming and going, the four numbers, the cost line, the daemon's view, the Slack test, the migration and time zones.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { api, internal } from "./_generated/api";
import crons from "./crons";
import { SLACK_TEST } from "./crews";
import { crewmateIds, crewOf, isCrewmate, memberIdsOf, requireLeader } from "./lib/crew";
import { localMonth } from "./lib/localTime";
import { type Actor, befriend, crewIdOf, hackerNamed, harness, type Harness, idOf, invite, link, must, settleScheduled } from "./testing.helpers";

const WEBHOOK = "https://hooks.slack.com/services/T0000/B0000/madeupsecret";
const DAY = 24 * 60 * 60 * 1000;

function agent(agentId: string) {
  return { agentId, harness: "claude-code", name: "pricing", workspace: "vibes", status: "working" as const, open: true, lastTurnAt: Date.now() };
}

// Pairs a machine for a hacker, reports one open agent with a summary, and returns the machine's token.
async function runsAgent(t: Harness, as: Actor, machine: string, agentId: string, summary: string): Promise<string> {
  const token = await as.mutation(api.subsets.pairDaemon, { machineName: machine });
  await t.mutation(api.subsets.report, { token, agents: [agent(agentId)] });
  await t.mutation(api.routing.update, { token, agentId, summary });
  return token;
}

// Lets the functions scheduled at once run (a few rounds, for ones that schedule more).
async function drain(t: Harness): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise(function (resolve) { setTimeout(resolve, 5); });
    await t.finishInProgressScheduledFunctions();
  }
}

afterEach(async function () {
  await settleScheduled();
  const f = globalThis.fetch as unknown as { mockRestore?: () => void };
  f.mockRestore?.();
});

describe("joining crews through invites", function () {
  test("an invite link starts a crew led by the inviter, and later invites from anyone in it add to it", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const ada = await hackerNamed(t, "adalovelace");
    const jimmy = await hackerNamed(t, "jimmy");
    const grace = await hackerNamed(t, "grace");
    expect(await tom.query(api.crews.mine, {})).toBeNull();

    await invite(tom, ada);
    const first = must(await ada.query(api.crews.mine, {}));
    expect(first).toMatchObject({
      name: "tom's crew",
      plan: "free",
      leaderHandle: "tom",
      iAmLeader: false,
      digestHour: 9,
      timezone: "UTC",
      slackConnected: false,
      slackMirror: false,
      intercomConnected: false,
      trustedNotePosters: [],
    });
    expect(first.members.map(function (m) { return [m.handle, m.role]; })).toEqual([["tom", "leader"], ["adalovelace", "member"]]);
    expect((await tom.query(api.crews.mine, {}))?.iAmLeader).toBe(true);

    await invite(tom, jimmy);
    // A member's invite adds to the crew too.
    await invite(ada, grace);
    expect(must(await grace.query(api.crews.mine, {})).members.map(function (m) { return m.handle; })).toEqual(["tom", "adalovelace", "jimmy", "grace"]);
    // The HUD's crew rows (friends.list) are the whole crew now, not only whoever invited them.
    expect((await grace.query(api.friends.list, {})).map(function (f) { return f.handle; })).toEqual(["adalovelace", "jimmy", "tom"]);
  });

  test("an invite made for a Superset handle puts its owner in the crew when they link that profile", async function () {
    const t = harness();
    await hackerNamed(t, "tom");
    await t.mutation(internal.friends.inviteFor, { supersetUserId: "superset|tom", forHandle: "grace-hopper", forName: "Grace Hopper" });
    const grace = await hackerNamed(t, "grace");
    const invitedBy = await t.mutation(internal.superset.save, {
      supersetUserId: "superset|grace",
      profile: { handle: "grace-hopper", name: "Grace Hopper", achievements: [], models: [] },
      fetchedAt: Date.now(),
    });
    expect(invitedBy).toEqual(["tom"]);
    expect(must(await grace.query(api.crews.mine, {})).members).toMatchObject([
      { handle: "tom", role: "leader" },
      { handle: "grace", name: "Grace Hopper", role: "member" },
    ]);
  });

  test("a full crew stays full, and someone already in a crew stays in it; either way they are friends", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    for (let i = 1; i <= 7; i++) await invite(tom, await hackerNamed(t, `member${i}`));
    expect(must(await tom.query(api.crews.mine, {})).members).toHaveLength(8);
    const sam = await hackerNamed(t, "sam");
    await invite(tom, sam);
    expect(await sam.query(api.crews.mine, {})).toBeNull();
    expect((await sam.query(api.friends.list, {})).map(function (f) { return f.handle; })).toEqual(["tom"]);

    const grace = await hackerNamed(t, "grace");
    await invite(grace, await hackerNamed(t, "jimmy"));
    await invite(tom, grace);
    expect(must(await grace.query(api.crews.mine, {})).name).toBe("grace's crew");
  });

  test("a friend request makes friends, not crewmates", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const ada = await hackerNamed(t, "adalovelace");
    await befriend(tom, ada, "adalovelace");
    expect(await tom.query(api.crews.mine, {})).toBeNull();
    expect(await ada.query(api.crews.mine, {})).toBeNull();
    expect((await tom.query(api.friends.list, {})).map(function (f) { return f.handle; })).toEqual(["adalovelace"]);
  });
});

describe("the scope helpers", function () {
  test("crewOf, memberIdsOf, crewmateIds, isCrewmate and requireLeader", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const ada = await hackerNamed(t, "adalovelace");
    const sam = await hackerNamed(t, "sam");
    const grace = await hackerNamed(t, "grace");
    await invite(tom, ada);
    await befriend(tom, sam, "sam");
    await befriend(sam, grace, "grace");
    const [tomId, adaId, samId, graceId] = [await idOf(t, "tom"), await idOf(t, "adalovelace"), await idOf(t, "sam"), await idOf(t, "grace")];
    const crewId = await crewIdOf(t, "tom");
    await t.run(async function (ctx) {
      expect((await crewOf(ctx, adaId))?._id).toBe(crewId);
      expect(await crewOf(ctx, samId)).toBeNull();
      expect(await memberIdsOf(ctx, crewId)).toEqual([tomId, adaId]);
      // In a crew: the crew, not friends. In no crew: friends.
      expect(await crewmateIds(ctx, tomId)).toEqual([adaId]);
      expect((await crewmateIds(ctx, samId)).sort()).toEqual([tomId, graceId].sort());
      expect(await isCrewmate(ctx, tomId, adaId)).toBe(true);
      expect(await isCrewmate(ctx, tomId, samId)).toBe(false);
      expect(await isCrewmate(ctx, samId, tomId)).toBe(true);
      expect(await isCrewmate(ctx, samId, adaId)).toBe(false);
      expect(await isCrewmate(ctx, tomId, tomId)).toBe(false);
      const tomRow = must(await ctx.db.get("hackers", tomId));
      expect((await requireLeader(ctx, tomRow))._id).toBe(crewId);
      await expect(requireLeader(ctx, must(await ctx.db.get("hackers", adaId)))).rejects.toThrow("Only the crew leader");
      await expect(requireLeader(ctx, must(await ctx.db.get("hackers", samId)))).rejects.toThrow("not in a crew");
    });
    void ada;
    void grace;
  });

  test("the digest tick is an hourly cron", function () {
    expect(crons.crons["write crew digests"]).toMatchObject({ name: "digests:tick", schedule: { type: "interval", hours: 1 } });
  });
});

describe("crew scope", function () {
  test("in a crew, crewmates are the crew: a friend outside it is off the board, the wire, introductions and knocks", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const ada = await hackerNamed(t, "adalovelace");
    const sam = await hackerNamed(t, "sam");
    await invite(tom, ada);
    await befriend(tom, sam, "sam");
    await runsAgent(t, ada, "am", "a1", "vibes · \"the quote page\"");
    await runsAgent(t, sam, "sm", "s1", "vibes · \"the pricing page\"");
    const tomToken = await tom.mutation(api.subsets.pairDaemon, { machineName: "tm" });

    expect((await tom.query(api.play.board, {})).map(function (r) { return r.handle; }).sort()).toEqual(["adalovelace", "tom"]);
    expect((await tom.query(api.feed.recent, {})).map(function (e) { return e.handle; })).toEqual(["adalovelace"]);
    expect((await t.query(api.routing.crew, { token: tomToken })).agents.map(function (a) { return a.handle; })).toEqual(["adalovelace"]);
    expect((await t.query(api.friends.crew, { token: tomToken })).crew.map(function (c) { return c.handle; })).toEqual(["adalovelace"]);
    await tom.mutation(api.knocks.send, { toHandle: "adalovelace", item: link });
    await expect(tom.mutation(api.knocks.send, { toHandle: "sam", item: link })).rejects.toThrow("only knock on a friend");

    // Sam is in no crew, so he keeps the friends behaviour: Tom is his crew.
    expect((await sam.query(api.play.board, {})).map(function (r) { return r.handle; }).sort()).toEqual(["sam", "tom"]);
    await sam.mutation(api.knocks.send, { toHandle: "tom", item: link });
    // Tom's HUD rows are his crew; Sam stays his friend (Sam's knock above went through), just not on Tom's crew list.
    expect((await tom.query(api.friends.list, {})).map(function (f) { return f.handle; })).toEqual(["adalovelace"]);
  });

  test("the friend list shows a crewmate's latest summary and when their Mac last reported, but not in focus", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const ada = await hackerNamed(t, "adalovelace");
    const grace = await hackerNamed(t, "grace");
    await invite(tom, ada);
    await befriend(grace, ada, "adalovelace");
    const before = Date.now();
    const token = await runsAgent(t, ada, "am", "a1", "vibes@main · \"the quote page\" · files: apps/web/quote.tsx");
    await Bun.sleep(5);
    await t.mutation(api.subsets.report, { token, agents: [agent("a1"), agent("a2")] });
    await t.mutation(api.routing.update, { token, agentId: "a2", summary: "vibes@pricing · \"the pricing table\"" });

    const seen = must((await tom.query(api.friends.list, {}))[0]);
    // Ada does not share folder names, so the folder and branch are left off, as for crewmates' agents.
    expect(seen.summary).toBe("\"the pricing table\"");
    expect(must(seen.lastSeenAt)).toBeGreaterThanOrEqual(before);
    // Grace is Ada's friend but not in her crew: no summary.
    const fromGrace = must((await grace.query(api.friends.list, {})).find(function (f) { return f.handle === "adalovelace"; }));
    expect(fromGrace.summary).toBeUndefined();

    await ada.mutation(api.hackers.setFocus, { minutes: 25 });
    const focused = must((await tom.query(api.friends.list, {}))[0]);
    expect([focused.summary, focused.lastSeenAt]).toEqual([undefined, undefined]);
  });
});

describe("the crew's settings", function () {
  test("only the leader changes them, and the secrets never come back", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const ada = await hackerNamed(t, "adalovelace");
    await hackerNamed(t, "sam");
    await invite(tom, ada);

    await tom.mutation(api.crews.rename, { name: "  the   vibes crew " });
    await tom.mutation(api.crews.setDigest, { digestHour: 8, timezone: "america/toronto" });
    await tom.mutation(api.crews.setSlack, { webhook: WEBHOOK, mirror: true });
    await tom.mutation(api.crews.setIntercom, { token: "made-up-access-token", secret: "made-up-client-secret" });
    await tom.mutation(api.crews.setTrustedNotePosters, { handles: ["@adalovelace", "adalovelace"] });
    const seen = must(await ada.query(api.crews.mine, {}));
    expect(seen).toMatchObject({
      name: "the vibes crew",
      digestHour: 8,
      timezone: "America/Toronto",
      slackConnected: true,
      slackMirror: true,
      intercomConnected: true,
      trustedNotePosters: ["adalovelace"],
    });
    const shown = JSON.stringify([seen, await tom.query(api.crews.mine, {})]);
    for (const secret of ["hooks.slack.com", "madeupsecret", "made-up-access-token", "made-up-client-secret"]) expect(shown).not.toContain(secret);

    // The mirror changes without the webhook; null takes a value off.
    await tom.mutation(api.crews.setSlack, { mirror: false });
    expect(must(await tom.query(api.crews.mine, {}))).toMatchObject({ slackConnected: true, slackMirror: false });
    await tom.mutation(api.crews.setSlack, { webhook: null });
    await tom.mutation(api.crews.setIntercom, { secret: null });
    expect(must(await tom.query(api.crews.mine, {}))).toMatchObject({ slackConnected: false, intercomConnected: false });

    await expect(tom.mutation(api.crews.setDigest, { digestHour: 24, timezone: "UTC" })).rejects.toThrow("0 to 23");
    await expect(tom.mutation(api.crews.setDigest, { digestHour: 8.5, timezone: "UTC" })).rejects.toThrow("0 to 23");
    await expect(tom.mutation(api.crews.setDigest, { digestHour: 9, timezone: "Nowhere/Land" })).rejects.toThrow("time zone");
    await expect(tom.mutation(api.crews.setSlack, { webhook: "http://hooks.slack.com/services/x" })).rejects.toThrow("Slack webhook");
    await expect(tom.mutation(api.crews.setSlack, { webhook: "not a url" })).rejects.toThrow("Slack webhook");
    await expect(tom.mutation(api.crews.rename, { name: "  " })).rejects.toThrow("1 to 60");
    await expect(tom.mutation(api.crews.setTrustedNotePosters, { handles: ["sam"] })).rejects.toThrow("not in the crew");

    const attempts = [
      function () { return ada.mutation(api.crews.rename, { name: "mine now" }); },
      function () { return ada.mutation(api.crews.setDigest, { digestHour: 7, timezone: "UTC" }); },
      function () { return ada.mutation(api.crews.setSlack, { mirror: true }); },
      function () { return ada.mutation(api.crews.setIntercom, { token: null }); },
      function () { return ada.mutation(api.crews.setTrustedNotePosters, { handles: [] }); },
      function () { return ada.mutation(api.crews.testSlack, {}); },
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toThrow("Only the crew leader");
  });

  test("the leader sees where Intercom sends ratings", async function () {
    const saved = process.env.CONVEX_SITE_URL;
    process.env.CONVEX_SITE_URL = "https://made-up-deployment.convex.site";
    try {
      const t = harness();
      const tom = await hackerNamed(t, "tom");
      const ada = await hackerNamed(t, "adalovelace");
      await invite(tom, ada);
      const crewId = await crewIdOf(t, "tom");
      expect(must(await tom.query(api.crews.mine, {})).intercomWebhookUrl).toBe(`https://made-up-deployment.convex.site/intercom/webhook?crew=${crewId}`);
      expect(must(await ada.query(api.crews.mine, {})).intercomWebhookUrl).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.CONVEX_SITE_URL;
      else process.env.CONVEX_SITE_URL = saved;
    }
  });

  test("the Slack test posts through the webhook, and the crew shows whether it went through, never the webhook", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    await invite(tom, await hackerNamed(t, "adalovelace"));
    await expect(tom.mutation(api.crews.testSlack, {})).rejects.toThrow("Slack webhook first");
    await tom.mutation(api.crews.setSlack, { webhook: WEBHOOK });

    const posted: { url: string; body: string }[] = [];
    spyOn(globalThis, "fetch").mockImplementation(async function (input: string | URL | Request, init?: RequestInit) {
      posted.push({ url: String(input), body: String(init?.body) });
      return new Response("ok", { status: 200 });
    } as unknown as typeof fetch);
    await tom.mutation(api.crews.testSlack, {});
    await drain(t);
    expect(posted).toEqual([{ url: WEBHOOK, body: JSON.stringify({ text: SLACK_TEST }) }]);
    expect(must(await tom.query(api.crews.mine, {})).slackPostedAt).toBeGreaterThan(0);

    (globalThis.fetch as unknown as { mockRestore: () => void }).mockRestore();
    spyOn(globalThis, "fetch").mockImplementation(async function () {
      return new Response(`invalid_token for ${WEBHOOK}`, { status: 403 });
    } as unknown as typeof fetch);
    await tom.mutation(api.crews.testSlack, {});
    await drain(t);
    const mine = must(await tom.query(api.crews.mine, {}));
    expect(mine.slackError).toBe("Slack answered 403: invalid_token for the webhook");
    expect(JSON.stringify(mine)).not.toContain("madeupsecret");

    (globalThis.fetch as unknown as { mockRestore: () => void }).mockRestore();
    spyOn(globalThis, "fetch").mockImplementation(async function () {
      throw new Error(`connect ECONNREFUSED ${WEBHOOK}`);
    } as unknown as typeof fetch);
    await tom.mutation(api.crews.testSlack, {});
    await drain(t);
    expect(must(await tom.query(api.crews.mine, {})).slackError).toBe("Slack could not be reached.");
  });
});

describe("members", function () {
  test("anyone in no crew can start one; they lead it and their invites fill it", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    await tom.mutation(api.crews.create, { name: "night shift" });
    expect(must(await tom.query(api.crews.mine, {}))).toMatchObject({ name: "night shift", leaderHandle: "tom", iAmLeader: true, members: [{ handle: "tom", role: "leader" }] });
    await expect(tom.mutation(api.crews.create, { name: "again" })).rejects.toThrow("already in a crew");
    const ada = await hackerNamed(t, "adalovelace");
    await invite(tom, ada);
    expect(must(await ada.query(api.crews.mine, {})).name).toBe("night shift");
    await expect(t.mutation(api.crews.create, { name: "nobody" })).rejects.toThrow("Not signed in");
  });

  test("the leader adds friends in no crew, up to 8, removes people, and hands the lead on", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const ada = await hackerNamed(t, "adalovelace");
    const jimmy = await hackerNamed(t, "jimmy");
    const sam = await hackerNamed(t, "sam");
    const grace = await hackerNamed(t, "grace");
    await invite(tom, ada);
    await befriend(tom, jimmy, "jimmy");
    await befriend(tom, sam, "sam");

    await tom.mutation(api.crews.add, { handle: "@Jimmy" });
    expect(must(await jimmy.query(api.crews.mine, {})).name).toBe("tom's crew");
    await expect(tom.mutation(api.crews.add, { handle: "grace" })).rejects.toThrow("friend first");
    await expect(tom.mutation(api.crews.add, { handle: "jimmy" })).rejects.toThrow("already in the crew");
    await expect(tom.mutation(api.crews.add, { handle: "nobody-here" })).rejects.toThrow("ain’t nobody");
    await expect(ada.mutation(api.crews.add, { handle: "sam" })).rejects.toThrow("Only the crew leader");
    await invite(sam, grace);
    await expect(tom.mutation(api.crews.add, { handle: "sam" })).rejects.toThrow("in another crew");

    await tom.mutation(api.crews.setTrustedNotePosters, { handles: ["jimmy"] });
    await tom.mutation(api.crews.remove, { handle: "jimmy" });
    expect(await jimmy.query(api.crews.mine, {})).toBeNull();
    expect(must(await tom.query(api.crews.mine, {})).trustedNotePosters).toEqual([]);
    expect((await jimmy.query(api.friends.list, {})).map(function (f) { return f.handle; })).toEqual(["tom"]);
    await expect(tom.mutation(api.crews.remove, { handle: "tom" })).rejects.toThrow("Hand the lead");
    await expect(tom.mutation(api.crews.remove, { handle: "jimmy" })).rejects.toThrow("not in the crew");

    await expect(tom.mutation(api.crews.handLeadership, { handle: "jimmy" })).rejects.toThrow("not in the crew");
    await tom.mutation(api.crews.handLeadership, { handle: "adalovelace" });
    const after = must(await tom.query(api.crews.mine, {}));
    expect([after.leaderHandle, after.iAmLeader]).toEqual(["adalovelace", false]);
    expect(after.members.map(function (m) { return [m.handle, m.role]; })).toEqual([["adalovelace", "leader"], ["tom", "member"]]);
    await expect(tom.mutation(api.crews.rename, { name: "x" })).rejects.toThrow("Only the crew leader");
    await ada.mutation(api.crews.rename, { name: "ada's crew now" });
  });

  test("a full crew takes nobody else", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    for (let i = 1; i <= 7; i++) await invite(tom, await hackerNamed(t, `member${i}`));
    const sam = await hackerNamed(t, "sam");
    await befriend(tom, sam, "sam");
    await expect(tom.mutation(api.crews.add, { handle: "sam" })).rejects.toThrow("full");
  });

  test("members leave; the leader hands the lead on first; the last one out ends the crew", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const ada = await hackerNamed(t, "adalovelace");
    await invite(tom, ada);
    const crewId = await crewIdOf(t, "tom");
    await tom.mutation(api.notes.add, { text: "the quote page uses the M10 components" });
    await expect(tom.mutation(api.crews.leave, {})).rejects.toThrow("Hand the lead");
    await ada.mutation(api.crews.leave, {});
    expect(await ada.query(api.crews.mine, {})).toBeNull();
    await expect(ada.mutation(api.crews.leave, {})).rejects.toThrow("not in a crew");
    // Tom is alone: he can leave, and the crew and its notes go with him.
    await tom.mutation(api.crews.leave, {});
    expect(await tom.query(api.crews.mine, {})).toBeNull();
    const left = await t.run(async function (ctx) {
      return { crew: await ctx.db.get("crews", crewId), notes: await ctx.db.query("notes").collect() };
    });
    expect(left).toEqual({ crew: null, notes: [] });
  });

  test("a crew with a paid subscription is kept when its last member leaves", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    await tom.mutation(api.crews.create, { name: "paid" });
    const crewId = await crewIdOf(t, "tom");
    await t.run(async function (ctx) { await ctx.db.patch("crews", crewId, { plan: "team", stripeSubscriptionId: "sub_madeup" }); });
    await tom.mutation(api.crews.leave, {});
    expect(await tom.query(api.crews.mine, {})).toBeNull();
    expect(await t.run(async function (ctx) { return (await ctx.db.get("crews", crewId))?.name; })).toBe("paid");
  });
});

describe("the crew's numbers and costs", function () {
  test("the four numbers count the last 7 days of work between crewmates", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const ada = await hackerNamed(t, "adalovelace");
    const sam = await hackerNamed(t, "sam");
    await invite(tom, ada);
    await befriend(tom, sam, "sam");
    const [tomId, adaId, samId] = [await idOf(t, "tom"), await idOf(t, "adalovelace"), await idOf(t, "sam")];
    const now = Date.now();
    await t.run(async function (ctx) {
      // Ada's agent answered Tom twice (once too long ago), Sam's agent once (outside the crew), the Operator once.
      await ctx.db.insert("relays", { askerHackerId: tomId, question: "q1", status: "answered", targetHackerId: adaId, tokensRead: 10_000, tokensSent: 500, createdAt: now - DAY });
      await ctx.db.insert("relays", { askerHackerId: tomId, question: "q2", status: "answered", targetHackerId: adaId, tokensRead: 10_000, tokensSent: 0, createdAt: now - 8 * DAY });
      await ctx.db.insert("relays", { askerHackerId: tomId, question: "q3", status: "answered", targetHackerId: samId, tokensRead: 5_000, tokensSent: 0, createdAt: now });
      await ctx.db.insert("relays", { askerHackerId: tomId, question: "q4", status: "answered", byOperator: true, createdAt: now });
      await ctx.db.insert("relays", { askerHackerId: adaId, question: "q5", status: "not-found", targetHackerId: tomId, createdAt: now });
      // Ada did a hand-off for Tom; another is still running; one finished too long ago.
      await ctx.db.insert("handoffs", { fromId: tomId, toId: adaId, text: "fix VIB-123", status: "done", createdAt: now - DAY, expiresAt: now, finishedAt: now - DAY / 2 });
      await ctx.db.insert("handoffs", { fromId: tomId, toId: adaId, text: "tidy the tests", status: "running", createdAt: now, expiresAt: now + DAY });
      await ctx.db.insert("handoffs", { fromId: tomId, toId: adaId, text: "old", status: "done", createdAt: now, expiresAt: now, finishedAt: now - 9 * DAY });
      // Tom acted on one heads-up about Ada's agent and dismissed another.
      await ctx.db.insert("headsups", { hackerId: tomId, otherId: adaId, otherAgentId: "a1", kind: "area", line: "Ada's agent is on pricing", at: now - 60_000, expiresAt: now + 540_000, actedAt: now - 30_000, action: "ask" });
      await ctx.db.insert("headsups", { hackerId: tomId, otherId: adaId, otherAgentId: "a2", kind: "files", line: "Ada's agent is changing quote.tsx", at: now - 60_000, expiresAt: now, dismissedAt: now });
      // Two ships this week (one with a walkthrough), one last month, and a line that did not ship.
      const line = { harness: "claude-code", machineName: "am", areas: ["apps/web"], files: 3 };
      await ctx.db.insert("ledger", { ...line, hackerId: adaId, at: now - DAY, sessionKey: "s1", did: "the quote page redesign", shipped: true, walkthrough: "https://example.com/d/1" });
      await ctx.db.insert("ledger", { ...line, hackerId: tomId, at: now - 2 * DAY, sessionKey: "s2", did: "the pricing table", shipped: true });
      await ctx.db.insert("ledger", { ...line, hackerId: tomId, at: now - 30 * DAY, sessionKey: "s3", did: "an old ship", shipped: true });
      await ctx.db.insert("ledger", { ...line, hackerId: tomId, at: now - DAY, sessionKey: "s4", did: "a spike" });
    });
    expect(await ada.query(api.crews.numbers, {})).toEqual({ answered: 1, tokensSaved: 9_500, handoffs: 1, headsups: 1, ships: 2, walkthroughs: 1, days: 7 });
    // Sam is in no crew: his scope is him and his friend Tom.
    expect(await sam.query(api.crews.numbers, {})).toEqual({ answered: 1, tokensSaved: 5_000, handoffs: 0, headsups: 0, ships: 1, walkthroughs: 0, days: 7 });
  });

  test("the cost line is this month's Operator and digest dollars for the crew", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const ada = await hackerNamed(t, "adalovelace");
    await hackerNamed(t, "sam");
    await invite(tom, ada);
    const crewId = await crewIdOf(t, "tom");
    const [tomId, adaId, samId] = [await idOf(t, "tom"), await idOf(t, "adalovelace"), await idOf(t, "sam")];
    const now = Date.now();
    const { month, from } = localMonth(now, "UTC");
    await t.run(async function (ctx) {
      await ctx.db.insert("relays", { askerHackerId: tomId, question: "q1", status: "answered", usd: 0.012, createdAt: now });
      await ctx.db.insert("relays", { askerHackerId: adaId, question: "q2", status: "nobody", usd: 0.003, createdAt: now });
      await ctx.db.insert("relays", { askerHackerId: tomId, question: "last month", status: "answered", usd: 1, createdAt: from - DAY });
      await ctx.db.insert("relays", { askerHackerId: samId, question: "not the crew", status: "answered", usd: 0.5, createdAt: now });
      await ctx.db.insert("digests", { crewId, day: "2026-10-17", kind: "daily", text: "Yesterday in tom's crew", writtenAt: now, usd: 0.05 });
      await ctx.db.insert("digests", { crewId, day: "2026-09-30", kind: "daily", text: "Yesterday in tom's crew", writtenAt: from - DAY, usd: 0.07 });
    });
    expect(await ada.query(api.crews.costs, {})).toEqual({ month, operatorUsd: 0.015, digestUsd: 0.05 });
  });
});

describe("the crew for a daemon", function () {
  test("a machine sees its crew's name, plan, leader and crewmates; in no crew, its friends", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const ada = await hackerNamed(t, "adalovelace");
    const sam = await hackerNamed(t, "sam");
    await invite(tom, ada);
    await befriend(sam, tom, "tom");
    const tomId = await idOf(t, "tom");
    await t.run(async function (ctx) {
      await ctx.db.insert("supersetProfiles", { hackerId: tomId, handle: "tom-redman", name: "Tom Redman", achievements: [], models: [], fetchedAt: Date.now() });
    });
    const adaToken = await ada.mutation(api.subsets.pairDaemon, { machineName: "am" });
    expect(await t.query(api.crews.forDaemon, { token: adaToken })).toEqual({ crewName: "tom's crew", plan: "free", leaderHandle: "tom", members: [{ handle: "tom", name: "Tom Redman" }] });
    const samToken = await sam.mutation(api.subsets.pairDaemon, { machineName: "sm" });
    expect(await t.query(api.crews.forDaemon, { token: samToken })).toEqual({ crewName: undefined, plan: "free", leaderHandle: undefined, members: [{ handle: "tom", name: "Tom Redman" }] });
    await expect(t.query(api.crews.forDaemon, { token: "sd_nope" })).rejects.toThrow("Unknown daemon token");
  });
});

describe("moving friends into crews", function () {
  test("replays friendships as the invites they were, oldest first, and is safe to run twice", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const ada = await hackerNamed(t, "adalovelace");
    const jimmy = await hackerNamed(t, "jimmy");
    const grace = await hackerNamed(t, "grace");
    const sam = await hackerNamed(t, "sam");
    await befriend(tom, ada, "adalovelace");
    await befriend(tom, jimmy, "jimmy");
    await befriend(ada, grace, "grace");
    // Sam asked Tom last: Tom is in a crew by then, so Sam stays out of it.
    await befriend(sam, tom, "tom");
    // A request nobody accepted is not a friendship.
    await jimmy.mutation(api.friends.request, { handle: "sam" });
    expect(await tom.query(api.crews.mine, {})).toBeNull();

    expect(await t.mutation(internal.crews.migrate, {})).toEqual({ pairs: 4, started: 1, joined: 3 });
    const crew = must(await grace.query(api.crews.mine, {}));
    expect([crew.name, crew.leaderHandle]).toEqual(["tom's crew", "tom"]);
    expect(crew.members.map(function (m) { return m.handle; }).sort()).toEqual(["adalovelace", "grace", "jimmy", "tom"]);
    expect(await sam.query(api.crews.mine, {})).toBeNull();

    expect(await t.mutation(internal.crews.migrate, {})).toEqual({ pairs: 4, started: 0, joined: 0 });
  });
});

describe("time zones", function () {
  test("the Mac's time zone is kept, and the crew's digest follows its leader until the leader picks one", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const ada = await hackerNamed(t, "adalovelace");
    await invite(tom, ada);
    async function crewZone(): Promise<string> {
      return must(await tom.query(api.crews.mine, {})).timezone;
    }
    expect(await crewZone()).toBe("UTC");
    await tom.mutation(api.hackers.setTimezone, { timezone: "america/toronto" });
    expect(await crewZone()).toBe("America/Toronto");
    const tomId = await idOf(t, "tom");
    expect(await t.run(async function (ctx) { return (await ctx.db.get("hackers", tomId))?.timezone; })).toBe("America/Toronto");
    // A member's Mac does not move the crew.
    await ada.mutation(api.hackers.setTimezone, { timezone: "Europe/Paris" });
    expect(await crewZone()).toBe("America/Toronto");
    // Once the leader picks the crew's own, the leader's travels do not move it.
    await tom.mutation(api.crews.setDigest, { digestHour: 9, timezone: "Asia/Tokyo" });
    await tom.mutation(api.hackers.setTimezone, { timezone: "Europe/London" });
    expect(await crewZone()).toBe("Asia/Tokyo");
    await expect(tom.mutation(api.hackers.setTimezone, { timezone: "Moon/Base" })).rejects.toThrow("time zone");

    // A crew starts in its leader's time zone.
    const sam = await hackerNamed(t, "sam");
    await sam.mutation(api.hackers.setTimezone, { timezone: "Asia/Kolkata" });
    await sam.mutation(api.crews.create, { name: "sam's crew" });
    expect(must(await sam.query(api.crews.mine, {})).timezone).toBe("Asia/Kolkata");
  });
});

describe("a plan set by hand", function () {
  test("setPlanByHand puts a crew on the team plan with no end, and back on free", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const ada = await hackerNamed(t, "adalovelace");
    await invite(tom, ada);
    const crewId = await crewIdOf(t, "tom");
    await t.mutation(internal.crews.setPlanByHand, { crewId, plan: "team" });
    expect(must(await tom.query(api.crews.mine, {})).plan).toBe("team");
    expect(await ada.query(api.billing.status, {})).toEqual({ plan: "team", planUntil: undefined, subscription: null });
    await t.mutation(internal.crews.setPlanByHand, { crewId, plan: "free" });
    expect(must(await tom.query(api.crews.mine, {})).plan).toBe("free");
  });
});
