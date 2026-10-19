// ABOUTME: Tests for the Slack bridge: the text the mirror posts, escaping, recording a post on the crew and the digest,
// ABOUTME: and the lines the mirror leaves alone. Slack is a stand-in fetch; no real webhook is called.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { api, internal } from "./_generated/api";
import { mirrorText, slackEscape } from "./slack";
import { crewIdOf, hackerNamed, harness, idOf, invite, must, settleScheduled, teamPlan } from "./testing.helpers";

const WEBHOOK = "https://hooks.slack.com/services/T0/B0/madeup";

afterEach(async function () {
  await settleScheduled();
  const f = globalThis.fetch as unknown as { mockRestore?: () => void };
  f.mockRestore?.();
});

function slackSays(status: number, body: string): string[] {
  const sent: string[] = [];
  spyOn(globalThis, "fetch").mockImplementation(async function (_input: string | URL | Request, init?: RequestInit) {
    sent.push(String(init?.body));
    return new Response(body, { status });
  } as unknown as typeof fetch);
  return sent;
}

describe("the Slack bridge", function () {
  test("Slack's markup characters are written as entities", function () {
    expect(slackEscape("a & b <c> d")).toBe("a &amp; b &lt;c&gt; d");
  });

  test("the mirror says who shipped, who gave props, and what customers said", function () {
    expect(mirrorText({ kind: "ship", who: "Ada", text: "the quote page redesign", url: "https://github.com/acme/web/pull/412" })).toBe("Ada shipped: the quote page redesign https://github.com/acme/web/pull/412");
    expect(mirrorText({ kind: "props", who: "Tom", other: "Ada", aboutText: "the quote page redesign" })).toBe("Tom gave Ada props for: the quote page redesign");
    expect(mirrorText({ kind: "props", who: "Tom", other: "Ada" })).toBe("Tom gave Ada props");
    expect(mirrorText({ kind: "props", who: "Grace", fromCustomer: true, text: "thanked for fixing their CSV export" })).toBe("Grace got props from a customer: thanked for fixing their CSV export");
    expect(mirrorText({ kind: "props", who: "Grace", fromCustomer: true, text: "got props from a customer: fast and kind" })).toBe("Grace got props from a customer: fast and kind");
    expect(mirrorText({ kind: "props", who: "Tom", fromCustomer: true, text: "the crew got props from a customer" })).toBe("The crew got props from a customer");
    expect(mirrorText({ kind: "save", who: "Grace", text: "a customer went from upset to thanks" })).toBe("Grace may have just saved a customer: a customer went from upset to thanks");
    expect(mirrorText({ kind: "shout", who: "Tom", text: "lunch?" })).toBeNull();
    expect(mirrorText({ kind: "answer", who: "Ada" })).toBeNull();
  });

  test("a post is recorded on the crew and on the digest it carried", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    await invite(tom, await hackerNamed(t, "adalovelace"));
    const crewId = await crewIdOf(t, "tom");
    const digestId = await t.run(async function (ctx) {
      return await ctx.db.insert("digests", { crewId, day: "2026-10-17", kind: "daily", text: "Yesterday in tom's crew", writtenAt: Date.now() });
    });

    // No webhook: the digest says so.
    await t.action(internal.slack.post, { crewId, text: "Yesterday in tom's crew", digestId });
    expect((await t.run(async function (ctx) { return await ctx.db.get("digests", digestId); }))?.postError).toBe("The crew has no Slack webhook.");

    await tom.mutation(api.crews.setSlack, { webhook: WEBHOOK });
    const sent = slackSays(200, "ok");
    await t.action(internal.slack.post, { crewId, text: "Yesterday in tom's crew: 1 ship & 2 hand-offs", digestId });
    expect(sent).toEqual([JSON.stringify({ text: "Yesterday in tom's crew: 1 ship &amp; 2 hand-offs" })]);
    const digest = must(await t.run(async function (ctx) { return await ctx.db.get("digests", digestId); }));
    expect(digest.postedAt).toBeGreaterThan(0);
    expect(digest.postError).toBeUndefined();
    expect(must(await tom.query(api.crews.mine, {})).slackPostedAt).toBeGreaterThan(0);

    (globalThis.fetch as unknown as { mockRestore: () => void }).mockRestore();
    slackSays(404, "no_service");
    await t.action(internal.slack.post, { crewId, text: "again", digestId });
    expect((await t.run(async function (ctx) { return await ctx.db.get("digests", digestId); }))?.postError).toBe("Slack answered 404: no_service");
    expect(must(await tom.query(api.crews.mine, {})).slackError).toBe("Slack answered 404: no_service");
  });

  test("the mirror leaves out lines about someone who hides from the board, and lines it does not mirror", async function () {
    const t = harness();
    const tom = await hackerNamed(t, "tom");
    const ada = await hackerNamed(t, "adalovelace");
    await invite(tom, ada);
    const crewId = await crewIdOf(t, "tom");
    await teamPlan(t, crewId);
    await tom.mutation(api.crews.setSlack, { webhook: WEBHOOK, mirror: true });
    const [tomId, adaId] = [await idOf(t, "tom"), await idOf(t, "adalovelace")];
    const ids = await t.run(async function (ctx) {
      const ship = await ctx.db.insert("feed", { kind: "ship", hackerId: adaId, text: "the quote page", at: Date.now() });
      const props = await ctx.db.insert("feed", { kind: "props", hackerId: tomId, otherHackerId: adaId, about: ship, at: Date.now() });
      const shout = await ctx.db.insert("feed", { kind: "shout", hackerId: tomId, text: "lunch?", at: Date.now() });
      return { ship, props, shout };
    });
    expect(await t.query(internal.slack.mirrorLine, { feedId: ids.ship })).toEqual({ crewId, webhook: WEBHOOK, text: "@adalovelace shipped: the quote page" });
    expect(await t.query(internal.slack.mirrorLine, { feedId: ids.props })).toEqual({ crewId, webhook: WEBHOOK, text: "@tom gave @adalovelace props for: the quote page" });
    expect(await t.query(internal.slack.mirrorLine, { feedId: ids.shout })).toBeNull();
    await ada.mutation(api.hackers.setHideFromBoards, { hide: true });
    expect(await t.query(internal.slack.mirrorLine, { feedId: ids.ship })).toBeNull();
    expect(await t.query(internal.slack.mirrorLine, { feedId: ids.props })).toBeNull();
    await t.run(async function (ctx) { await ctx.db.delete("feed", ids.shout); });
    expect(await t.query(internal.slack.mirrorLine, { feedId: ids.shout })).toBeNull();
  });
});
