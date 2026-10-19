// ABOUTME: Tests for props from customers through Intercom: the X-Hub-Signature check (against Node's own HMAC), reading the
// ABOUTME: rating, crediting the person whose ledger line names the conversation or else the crew, and the webhook's replies.
import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { checkSignature, cleanRemark, namesConversation, ratingOf } from "./intercom";
import { crewIdOf, hackerNamed, harness, type Harness, idOf, invite, must, settleScheduled, teamPlan } from "./testing.helpers";

const SECRET = "made-up-intercom-client-secret";

afterEach(async function () {
  await settleScheduled();
});

function signed(body: string, secret: string = SECRET): string {
  return `sha1=${createHmac("sha1", secret).update(body).digest("hex")}`;
}

function rating(conversationId: string | number, stars: number, remark?: string): string {
  return JSON.stringify({
    type: "notification_event",
    app_id: "madeup",
    topic: "conversation.rating.added",
    id: "notif_1",
    created_at: 1792000000,
    data: {
      type: "notification_event_data",
      item: {
        type: "conversation",
        id: conversationId,
        conversation_rating: { rating: stars, remark, created_at: 1792000000, contact: { id: "c1", type: "contact" } },
      },
    },
  });
}

async function post(t: Harness, crew: string, body: string, signature: string | null): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== null) headers["x-hub-signature"] = signature;
  return await t.fetch(`/intercom/webhook?crew=${crew}`, { method: "POST", headers, body });
}

// Tom leads a team-plan crew with Ada in it, with Intercom's secret set.
async function crewWithIntercom(t: Harness) {
  const tom = await hackerNamed(t, "tom");
  const ada = await hackerNamed(t, "adalovelace");
  await invite(tom, ada);
  const crewId = await crewIdOf(t, "tom");
  await teamPlan(t, crewId);
  await tom.mutation(api.crews.setIntercom, { secret: SECRET });
  return { tom, ada, crewId, adaId: await idOf(t, "adalovelace"), tomId: await idOf(t, "tom") };
}

async function customerProps(t: Harness) {
  return await t.run(async function (ctx) {
    return (await ctx.db.query("feed").collect()).filter(function (e) { return e.kind === "props" && e.fromCustomer === true; });
  });
}

async function line(t: Harness, hackerId: Id<"hackers">, did: string, daysAgo: number, pr?: string): Promise<Id<"ledger">> {
  return await t.run(async function (ctx) {
    return await ctx.db.insert("ledger", { hackerId, at: Date.now() - daysAgo * 86_400_000, harness: "claude-code", machineName: "m", sessionKey: `s-${did}`, did, areas: [], files: 1, pr });
  });
}

describe("Intercom's webhook", function () {
  test("the signature is the HMAC-SHA1 of the raw body with the client secret", async function () {
    const body = rating("4521", 5, "fast");
    expect(await checkSignature(body, signed(body), SECRET)).toBe(true);
    expect(await checkSignature(body, signed(body).toUpperCase().replace("SHA1=", "sha1="), SECRET)).toBe(true);
    expect(await checkSignature(body, signed(body, "another-secret"), SECRET)).toBe(false);
    expect(await checkSignature(`${body} `, signed(body), SECRET)).toBe(false);
    expect(await checkSignature(body, signed(body).replace("sha1=", "sha256="), SECRET)).toBe(false);
    expect(await checkSignature(body, null, SECRET)).toBe(false);
  });

  test("reads the conversation, the stars and the remark, and nothing else", function () {
    expect(ratingOf(JSON.parse(rating("4521", 5, "fast and kind")))).toEqual({ conversationId: "4521", rating: 5, remark: "fast and kind" });
    expect(ratingOf(JSON.parse(rating(4521, 4)))).toEqual({ conversationId: "4521", rating: 4 });
    expect(ratingOf({ topic: "ping", data: { item: {} } })).toBeNull();
    expect(ratingOf({ topic: "conversation.rating.added", data: { item: { id: "1" } } })).toBeNull();
    expect(ratingOf(null)).toBeNull();
  });

  test("a ledger line names a conversation by its id as a whole word", function () {
    expect(namesConversation("fixed the CSV export for conversation #4521", "4521")).toBe(true);
    expect(namesConversation("4521: export fix", "4521")).toBe(true);
    expect(namesConversation("fixed 45210", "4521")).toBe(false);
    expect(namesConversation("https://app.intercom.com/a/inbox/x/conversation/4521?view=1", "4521")).toBe(true);
    expect(namesConversation("a.b", "a.b")).toBe(true);
    expect(namesConversation("axb", "a.b")).toBe(false);
  });

  test("the customer's remark loses keys and email addresses, and is cut at 120 characters", function () {
    expect(cleanRemark("thanks! write to ada@example.com, key sk-ant-api03-AbCdEf0123456789xyz")).toBe("thanks! write to [email], key [secret]");
    expect(cleanRemark("   ")).toBeUndefined();
    expect(cleanRemark(undefined)).toBeUndefined();
    const long = must(cleanRemark("great ".repeat(40)));
    expect(long.length).toBe(120);
    expect(long.endsWith("…")).toBe(true);
  });

  test("a good rating is props for the person whose ledger line names the conversation", async function () {
    const t = harness();
    const { tom, adaId, crewId } = await crewWithIntercom(t);
    const named = await line(t, adaId, "fixed the CSV export (Intercom 4521)", 2);
    await line(t, adaId, "an older fix for 4521", 40);
    const body = rating("4521", 5, "Thank you, Ada fixed it fast");
    const res = await post(t, crewId, body, signed(body));
    expect(res.status).toBe(200);
    expect(await customerProps(t)).toMatchObject([{ hackerId: adaId, fromCustomer: true, text: "got props from a customer: Thank you, Ada fixed it fast", ledgerId: named }]);
    const wire = must((await tom.query(api.feed.recent, {})).find(function (e) { return e.kind === "props"; }));
    expect(wire).toMatchObject({ handle: "adalovelace", fromCustomer: true });

    // Intercom sends it again: still one.
    expect((await post(t, crewId, body, signed(body))).status).toBe(200);
    expect(await customerProps(t)).toHaveLength(1);
  });

  test("with no line naming it, the crew gets the props, on the leader's line; a PR link counts as naming it", async function () {
    const t = harness();
    const { tomId, adaId, crewId } = await crewWithIntercom(t);
    const body = rating("777", 4);
    expect((await post(t, crewId, body, signed(body))).status).toBe(200);
    expect(await customerProps(t)).toMatchObject([{ hackerId: tomId, text: "the crew got props from a customer" }]);

    const withPr = await line(t, adaId, "the refund flow", 1, "https://github.com/acme/web/pull/88?intercom=9001");
    const second = rating("9001", 5, "lovely");
    await post(t, crewId, second, signed(second));
    expect((await customerProps(t)).find(function (e) { return e.ledgerId === withPr; })).toMatchObject({ hackerId: adaId, text: "got props from a customer: lovely" });
  });

  test("a low rating, another topic, or a crew on the free plan puts nothing on the wire, and still gets a 200", async function () {
    const t = harness();
    const { crewId } = await crewWithIntercom(t);
    const low = rating("4521", 3, "meh");
    expect((await post(t, crewId, low, signed(low))).status).toBe(200);
    const ping = JSON.stringify({ topic: "ping", data: { item: { type: "ping", message: "hello" } } });
    expect((await post(t, crewId, ping, signed(ping))).status).toBe(200);
    const junk = "not json";
    expect((await post(t, crewId, junk, signed(junk))).status).toBe(200);
    await t.run(async function (ctx) { await ctx.db.patch("crews", crewId, { plan: "free" }); });
    const good = rating("4521", 5);
    expect((await post(t, crewId, good, signed(good))).status).toBe(200);
    expect(await customerProps(t)).toEqual([]);
  });

  test("an unknown crew is a 404; a missing or wrong signature, or no secret set, is a 401", async function () {
    const t = harness();
    const { tom, crewId } = await crewWithIntercom(t);
    const body = rating("4521", 5);
    expect((await post(t, "not-a-crew", body, signed(body))).status).toBe(404);
    expect((await t.fetch("/intercom/webhook", { method: "POST", body })).status).toBe(404);
    expect((await post(t, crewId, body, null)).status).toBe(401);
    expect((await post(t, crewId, body, signed(body, "guessed"))).status).toBe(401);
    await tom.mutation(api.crews.setIntercom, { secret: null });
    expect((await post(t, crewId, body, signed(body))).status).toBe(401);
    expect(await customerProps(t)).toEqual([]);
  });
});
