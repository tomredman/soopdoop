// ABOUTME: Tests for billing against the stand-in Stripe (STRIPE_FAKE=1): Checkout and the billing portal for the leader, the
// ABOUTME: signed webhook setting and clearing the plan (replays change nothing), seat counts following members, lapsed plans.
import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { NOT_SET_UP } from "./billing";
import crons from "./crons";
import { limitsFor } from "./lib/plan";
import { fakeStripe, resetFakeStripe, type Subscription } from "./lib/stripe";
import { befriend, crewIdOf, hackerNamed, harness, type Harness, invite, must, settleScheduled, teamPlan } from "./testing.helpers";

const SECRET = "whsec_madeup_for_tests";
const MONTHLY = "price_monthly_madeup";
const YEARLY = "price_yearly_madeup";
const ISSUER = "https://api.superset.sh";
const DAY = 86_400_000;
const ENV = ["STRIPE_FAKE", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_MONTHLY", "STRIPE_PRICE_YEARLY", "SITE_URL"];
// Whole seconds, as Stripe sends them.
const NOW = Math.floor(Date.now() / 1000) * 1000;

let saved: Record<string, string | undefined> = {};
let quiet: Mock<(...args: unknown[]) => void>[] = [];

beforeEach(function () {
  saved = {};
  for (const name of ENV) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  process.env.STRIPE_FAKE = "1";
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  process.env.STRIPE_PRICE_MONTHLY = MONTHLY;
  process.env.STRIPE_PRICE_YEARLY = YEARLY;
  resetFakeStripe();
  // The webhook logs every event (and the failures these tests cause on purpose); keep the test output to the tests.
  quiet = [
    spyOn(console, "log").mockImplementation(function () {}),
    spyOn(console, "warn").mockImplementation(function () {}),
    spyOn(console, "error").mockImplementation(function () {}),
  ];
});

afterEach(async function () {
  // Scheduled seat counts finish while the stand-in is still switched on.
  await settleScheduled();
  for (const spy of quiet) spy.mockRestore();
  for (const name of ENV) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetFakeStripe();
});

// Lets the functions scheduled at once run (a few rounds, for ones that schedule more).
async function drain(t: Harness): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise(function (resolve) { setTimeout(resolve, 5); });
    await t.finishInProgressScheduledFunctions();
  }
}

// Tom leads a crew of three: Ada and Jimmy joined through his invites.
async function crewOfThree(t: Harness) {
  const tom = await hackerNamed(t, "tom");
  const ada = await hackerNamed(t, "adalovelace");
  const jimmy = await hackerNamed(t, "jimmy");
  await invite(tom, ada);
  await invite(tom, jimmy);
  return { tom, ada, jimmy, crewId: await crewIdOf(t, "tom") };
}

// A paid monthly subscription for three members, ten days into its month, as the stand-in keeps it.
function paidSubscription(crewId: string, change: Partial<Subscription> = {}): Subscription {
  return {
    id: "sub_madeup_1",
    customerId: "cus_madeup_1",
    status: "active",
    itemId: "si_madeup_1",
    quantity: 3,
    yearly: false,
    periodStart: NOW - 10 * DAY,
    periodEnd: NOW + 20 * DAY,
    renews: true,
    crewId,
    ...change,
  };
}

// The same subscription as Stripe's JSON (API version 2026-09-30: the period is on the item).
function subscriptionJson(sub: Subscription) {
  return {
    id: sub.id,
    object: "subscription",
    customer: sub.customerId,
    status: sub.status,
    cancel_at: sub.renews ? null : sub.periodEnd / 1000,
    cancel_at_period_end: !sub.renews,
    metadata: sub.crewId === undefined ? {} : { crewId: sub.crewId },
    items: {
      object: "list",
      data: [
        {
          id: sub.itemId,
          object: "subscription_item",
          quantity: sub.quantity,
          current_period_start: sub.periodStart / 1000,
          current_period_end: sub.periodEnd / 1000,
          price: { id: sub.yearly ? YEARLY : MONTHLY, object: "price", recurring: { interval: sub.yearly ? "year" : "month", interval_count: 1 } },
        },
      ],
    },
  };
}

function checkoutJson(crewRef: string, sub: Subscription, mode = "subscription") {
  return {
    id: "cs_madeup_1",
    object: "checkout.session",
    mode,
    status: "complete",
    payment_status: "paid",
    client_reference_id: crewRef,
    metadata: { crewId: crewRef },
    customer: sub.customerId,
    subscription: sub.id,
  };
}

let events = 0;
function eventBody(type: string, object: unknown): string {
  events += 1;
  const created = Math.floor(Date.now() / 1000);
  return JSON.stringify({ id: `evt_madeup_${events}`, object: "event", api_version: "2026-09-30.endive", created, type, data: { object }, livemode: false });
}

// The Stripe-Signature header for a body, the way Stripe makes it (docs.stripe.com/webhooks: HMAC-SHA256 of "t.body").
function signature(body: string, secret: string = SECRET, at: number = Math.floor(Date.now() / 1000)): string {
  return `t=${at},v1=${createHmac("sha256", secret).update(`${at}.${body}`).digest("hex")}`;
}

async function post(t: Harness, body: string, sig: string | null = signature(body)): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sig !== null) headers["stripe-signature"] = sig;
  return await t.fetch("/stripe/webhook", { method: "POST", headers, body });
}

async function crewRow(t: Harness, crewId: Id<"crews">): Promise<Doc<"crews">> {
  return must(await t.run(async function (ctx) { return await ctx.db.get("crews", crewId); }));
}

// Stripe has `sub` now, and sends `type` about it (the event's own copy is `sent`, which can be older).
async function stripeSays(t: Harness, type: string, sub: Subscription, sent: Subscription = sub): Promise<Response> {
  fakeStripe.subscriptions.set(sub.id, sub);
  return await post(t, eventBody(type, subscriptionJson(sent)));
}

// The leader finished Checkout and paid: Stripe has the subscription, and sends checkout.session.completed.
async function pays(t: Harness, crewId: Id<"crews">, sub: Subscription = paidSubscription(crewId)): Promise<Response> {
  fakeStripe.subscriptions.set(sub.id, sub);
  return await post(t, eventBody("checkout.session.completed", checkoutJson(crewId, sub)));
}

describe("checkout and the billing portal", function () {
  test("the leader gets a monthly Checkout link for every member, carrying the crew's id and their sign-in email", async function () {
    const t = harness();
    const { crewId } = await crewOfThree(t);
    const tom = t.withIdentity({ subject: "superset|tom", issuer: ISSUER, email: "tom@example.com" });
    expect(await tom.action(api.billing.checkout, { yearly: false })).toBe("https://stripe.test/checkout/cs_fake_1");
    expect(fakeStripe.calls).toEqual([
      {
        call: "checkout",
        request: {
          price: MONTHLY,
          quantity: 3,
          crewId,
          customer: undefined,
          customerEmail: "tom@example.com",
          successUrl: "https://soopdoop.com/?billing=done",
          cancelUrl: "https://soopdoop.com/?billing=cancelled",
        },
      },
    ]);
  });

  test("yearly uses the yearly price, links go back to SITE_URL, and without an email in the sign-in Checkout asks for one", async function () {
    const t = harness();
    const { tom } = await crewOfThree(t);
    process.env.SITE_URL = "https://example.com/teams";
    await tom.action(api.billing.checkout, { yearly: true });
    const call = must(fakeStripe.calls[0]);
    if (call.call !== "checkout") throw new Error("expected a checkout");
    expect(call.request).toMatchObject({
      price: YEARLY,
      quantity: 3,
      successUrl: "https://example.com/teams?billing=done",
      cancelUrl: "https://example.com/teams?billing=cancelled",
    });
    expect(call.request.customerEmail).toBeUndefined();
    process.env.SITE_URL = "not a link";
    await expect(tom.action(api.billing.checkout, { yearly: true })).rejects.toThrow("SITE_URL on this deployment is not a link");
  });

  test("only the leader can upgrade or manage billing", async function () {
    const t = harness();
    const { ada } = await crewOfThree(t);
    const sam = await hackerNamed(t, "sam");
    await expect(ada.action(api.billing.checkout, { yearly: false })).rejects.toThrow("Only the crew leader");
    await expect(ada.action(api.billing.portal, {})).rejects.toThrow("Only the crew leader");
    await expect(sam.action(api.billing.checkout, { yearly: false })).rejects.toThrow("You are not in a crew");
    await expect(t.action(api.billing.checkout, { yearly: false })).rejects.toThrow("Not signed in");
    await expect(t.action(api.billing.portal, {})).rejects.toThrow("Not signed in");
    expect(fakeStripe.calls).toEqual([]);
  });

  test("a crew that pays gets the billing portal instead of a second subscription; a free crew has no portal yet", async function () {
    const t = harness();
    const { tom, crewId } = await crewOfThree(t);
    await expect(tom.action(api.billing.portal, {})).rejects.toThrow("The crew has no billing yet. Upgrade first.");
    expect((await pays(t, crewId)).status).toBe(200);
    fakeStripe.calls.length = 0;

    expect(await tom.action(api.billing.checkout, { yearly: true })).toMatch(/^https:\/\/stripe\.test\/portal\/bps_fake_/);
    expect(await tom.action(api.billing.portal, {})).toMatch(/^https:\/\/stripe\.test\/portal\/bps_fake_/);
    expect(fakeStripe.calls).toEqual([
      { call: "portal", customer: "cus_madeup_1", returnUrl: "https://soopdoop.com" },
      { call: "portal", customer: "cus_madeup_1", returnUrl: "https://soopdoop.com" },
    ]);
  });

  test("after the plan ends, paying again uses the crew's Stripe customer", async function () {
    const t = harness();
    const { tom, crewId } = await crewOfThree(t);
    const sub = paidSubscription(crewId);
    await pays(t, crewId, sub);
    await stripeSays(t, "customer.subscription.deleted", { ...sub, status: "canceled" });
    fakeStripe.calls.length = 0;
    const withEmail = t.withIdentity({ subject: "superset|tom", issuer: ISSUER, email: "tom@example.com" });
    await withEmail.action(api.billing.checkout, { yearly: false });
    expect(fakeStripe.calls).toMatchObject([{ call: "checkout", request: { customer: "cus_madeup_1", customerEmail: undefined, quantity: 3 } }]);
    expect(await tom.action(api.billing.portal, {})).toMatch(/portal/);
  });

  test("a crew put on the team plan by hand has nothing to buy", async function () {
    const t = harness();
    const { tom, crewId } = await crewOfThree(t);
    await teamPlan(t, crewId);
    await expect(tom.action(api.billing.checkout, { yearly: false })).rejects.toThrow("The crew is on the team plan already.");
  });

  test("without Stripe set up, Upgrade says so and the webhook answers 500", async function () {
    const t = harness();
    const { tom, crewId } = await crewOfThree(t);
    delete process.env.STRIPE_FAKE;
    await expect(tom.action(api.billing.checkout, { yearly: false })).rejects.toThrow(NOT_SET_UP);
    const body = eventBody("checkout.session.completed", checkoutJson(crewId, paidSubscription(crewId)));
    expect((await post(t, body)).status).toBe(500);

    process.env.STRIPE_FAKE = "1";
    delete process.env.STRIPE_PRICE_YEARLY;
    await expect(tom.action(api.billing.checkout, { yearly: true })).rejects.toThrow(NOT_SET_UP);
    expect(await tom.action(api.billing.checkout, { yearly: false })).toMatch(/checkout/);
    delete process.env.STRIPE_WEBHOOK_SECRET;
    expect((await post(t, body)).status).toBe(500);
    expect((await crewRow(t, crewId)).plan).toBe("free");
  });

  test("when Stripe does not answer, the leader reads why", async function () {
    const t = harness();
    const { tom } = await crewOfThree(t);
    fakeStripe.down = true;
    await expect(tom.action(api.billing.checkout, { yearly: false })).rejects.toThrow("Stripe is not answering");
  });
});

describe("the Stripe webhook", function () {
  test("a finished checkout puts the crew on the team plan until the period's end, for every member to see; a replay changes nothing", async function () {
    const t = harness();
    const { ada, crewId } = await crewOfThree(t);
    const sub = paidSubscription(crewId);
    const res = await pays(t, crewId, sub);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, note: "team plan, active" });
    const row = await crewRow(t, crewId);
    expect(row).toMatchObject({
      plan: "team",
      planUntil: sub.periodEnd,
      stripeCustomerId: "cus_madeup_1",
      stripeSubscriptionId: "sub_madeup_1",
      subscriptionStatus: "active",
      subscriptionQuantity: 3,
      subscriptionYearly: false,
      subscriptionUntil: sub.periodEnd,
      subscriptionRenews: true,
    });
    expect(limitsFor(row).digest).toBe(true);
    const shown = { status: "active", yearly: false, quantity: 3, until: sub.periodEnd, renews: true };
    expect(await ada.query(api.billing.status, {})).toEqual({ plan: "team", planUntil: sub.periodEnd, subscription: shown });
    expect(must(await ada.query(api.crews.mine, {})).subscription).toEqual(shown);

    // Stripe sends the same event again (a new delivery, so a new signature): nothing changes.
    const again = await post(t, eventBody("checkout.session.completed", checkoutJson(crewId, sub)));
    expect(await again.json()).toEqual({ ok: true, note: "no change" });
    expect(await crewRow(t, crewId)).toEqual(row);
  });

  test("a crew on the free plan, or a hacker in no crew, sees no subscription", async function () {
    const t = harness();
    const { ada } = await crewOfThree(t);
    const sam = await hackerNamed(t, "sam");
    expect(await ada.query(api.billing.status, {})).toEqual({ plan: "free", subscription: null });
    expect(must(await ada.query(api.crews.mine, {})).subscription).toBeUndefined();
    expect(await sam.query(api.billing.status, {})).toEqual({ plan: "free", subscription: null });
    expect(await t.query(api.billing.status, {})).toEqual({ plan: "free", subscription: null });
  });

  test("changes follow Stripe: yearly and more seats, a failed renewal, unpaid, then paid again", async function () {
    const t = harness();
    const { tom, crewId } = await crewOfThree(t);
    const sub = paidSubscription(crewId);
    await pays(t, crewId, sub);

    // The leader switched to yearly in the portal; Stripe started a new period of a year, for four.
    const yearly = { ...sub, yearly: true, quantity: 4, periodStart: NOW, periodEnd: NOW + 365 * DAY };
    expect((await stripeSays(t, "customer.subscription.updated", yearly)).status).toBe(200);
    expect(await crewRow(t, crewId)).toMatchObject({ plan: "team", planUntil: yearly.periodEnd, subscriptionYearly: true, subscriptionQuantity: 4 });

    // The next renewal fails: the team plan runs to the end of the last paid period (the start of the unpaid one).
    const late = { ...yearly, status: "past_due", periodStart: yearly.periodEnd, periodEnd: yearly.periodEnd + 365 * DAY };
    await stripeSays(t, "customer.subscription.updated", late);
    expect(await crewRow(t, crewId)).toMatchObject({ plan: "team", planUntil: late.periodStart, subscriptionStatus: "past_due", subscriptionUntil: late.periodEnd });

    // Stripe gives up and marks it unpaid: the free plan, with the subscription kept so paying it brings the team back.
    await stripeSays(t, "customer.subscription.updated", { ...late, status: "unpaid" });
    const unpaid = await crewRow(t, crewId);
    expect(unpaid).toMatchObject({ plan: "free", subscriptionStatus: "unpaid", stripeSubscriptionId: "sub_madeup_1" });
    expect(unpaid.planUntil).toBeUndefined();
    // Upgrade sends the leader to the portal to pay what is owed, not to a second subscription.
    expect(await tom.action(api.billing.checkout, { yearly: false })).toMatch(/portal/);

    await stripeSays(t, "customer.subscription.updated", { ...late, status: "active" });
    expect(await crewRow(t, crewId)).toMatchObject({ plan: "team", planUntil: late.periodEnd, subscriptionStatus: "active" });
  });

  test("the subscription is read from Stripe, not from the event, so a late event cannot undo a newer change", async function () {
    const t = harness();
    const { crewId } = await crewOfThree(t);
    const sub = paidSubscription(crewId);
    await pays(t, crewId, sub);
    // Stripe has five seats now; an older event that still says three arrives late.
    await stripeSays(t, "customer.subscription.updated", { ...sub, quantity: 5 }, sub);
    expect((await crewRow(t, crewId)).subscriptionQuantity).toBe(5);
    expect(fakeStripe.calls.filter(function (c) { return c.call === "retrieve"; })).toHaveLength(2);
  });

  test("canceled in the portal: it shows as ending, then the deleted event moves the crew to free and keeps the customer", async function () {
    const t = harness();
    const { ada, crewId } = await crewOfThree(t);
    const sub = paidSubscription(crewId);
    await pays(t, crewId, sub);
    await stripeSays(t, "customer.subscription.updated", { ...sub, renews: false });
    expect(must((await ada.query(api.billing.status, {})).subscription).renews).toBe(false);
    expect((await crewRow(t, crewId)).plan).toBe("team");

    const canceled = { ...sub, renews: false, status: "canceled" };
    const res = await stripeSays(t, "customer.subscription.deleted", canceled);
    expect(res.status).toBe(200);
    const row = await crewRow(t, crewId);
    expect(row).toMatchObject({ plan: "free", stripeCustomerId: "cus_madeup_1" });
    for (const gone of ["planUntil", "stripeSubscriptionId", "subscriptionStatus", "subscriptionQuantity", "subscriptionYearly", "subscriptionUntil", "subscriptionRenews"]) {
      expect(row).not.toHaveProperty(gone);
    }
    expect(await ada.query(api.billing.status, {})).toEqual({ plan: "free", subscription: null });

    // The deleted event again, and a late "updated" from before the cancel: nothing changes.
    await stripeSays(t, "customer.subscription.deleted", canceled);
    await stripeSays(t, "customer.subscription.updated", canceled, sub);
    expect(await crewRow(t, crewId)).toEqual(row);
  });

  test("events come in any order: the subscription's own event can come before the checkout's", async function () {
    const t = harness();
    const { crewId } = await crewOfThree(t);
    const sub = paidSubscription(crewId);
    await stripeSays(t, "customer.subscription.updated", sub);
    const row = await crewRow(t, crewId);
    expect(row).toMatchObject({ plan: "team", stripeSubscriptionId: sub.id });
    const late = await pays(t, crewId, sub);
    expect(await late.json()).toEqual({ ok: true, note: "no change" });
    expect(await crewRow(t, crewId)).toEqual(row);
  });

  test("another subscription than the crew's changes nothing, until a new paid checkout replaces one that ended", async function () {
    const t = harness();
    const { crewId } = await crewOfThree(t);
    const first = paidSubscription(crewId);
    await pays(t, crewId, first);
    const before = await crewRow(t, crewId);

    // A second checkout the leader gave up on: its subscription never got paid.
    const abandoned = paidSubscription(crewId, { id: "sub_madeup_2", itemId: "si_madeup_2", status: "incomplete" });
    const res = await stripeSays(t, "customer.subscription.updated", abandoned);
    expect(await res.json()).toEqual({ ok: true, note: "it is not the crew's subscription" });
    expect(await crewRow(t, crewId)).toEqual(before);

    await stripeSays(t, "customer.subscription.deleted", { ...first, status: "canceled" });
    const second = paidSubscription(crewId, { id: "sub_madeup_3", itemId: "si_madeup_3", yearly: true, periodEnd: NOW + 365 * DAY });
    await pays(t, crewId, second);
    expect(await crewRow(t, crewId)).toMatchObject({ plan: "team", stripeSubscriptionId: "sub_madeup_3", subscriptionYearly: true, planUntil: second.periodEnd });
    // The first one's late events are about a subscription the crew no longer has.
    await stripeSays(t, "customer.subscription.updated", { ...first, status: "canceled" }, first);
    expect((await crewRow(t, crewId)).stripeSubscriptionId).toBe("sub_madeup_3");
  });

  test("a second paid checkout while the first still bills: the crew follows the new one, and the log says to cancel one", async function () {
    const t = harness();
    const { crewId } = await crewOfThree(t);
    await pays(t, crewId);
    await pays(t, crewId, paidSubscription(crewId, { id: "sub_madeup_2", itemId: "si_madeup_2" }));
    expect((await crewRow(t, crewId)).stripeSubscriptionId).toBe("sub_madeup_2");
    const warned = quiet[1]?.mock.calls.map(function (args) { return String(args[0]); }) ?? [];
    expect(warned.some(function (line) { return line.includes("sub_madeup_1 still bills too"); })).toBe(true);
  });

  test("unknown crews, other products' subscriptions and other kinds of events get a 200 and change nothing", async function () {
    const t = harness();
    const { crewId } = await crewOfThree(t);
    const stranger = paidSubscription("not-a-crew", { id: "sub_someone_else", crewId: undefined });
    const notes: unknown[] = [];
    for (const body of [
      eventBody("checkout.session.completed", checkoutJson("not-a-crew", stranger)),
      eventBody("customer.subscription.updated", subscriptionJson(stranger)),
      eventBody("customer.subscription.deleted", subscriptionJson({ ...stranger, status: "canceled" })),
      eventBody("checkout.session.completed", checkoutJson(crewId, paidSubscription(crewId), "payment")),
      eventBody("invoice.paid", { id: "in_madeup", object: "invoice" }),
      eventBody("customer.subscription.updated", { id: "sub_x", object: "subscription" }),
    ]) {
      const res = await post(t, body);
      expect(res.status).toBe(200);
      notes.push((await res.json()).note);
    }
    expect(notes).toEqual([
      "no crew for it",
      "no crew for it",
      "no crew for it",
      "not a subscription checkout",
      "not an event billing uses",
      "not a subscription soopdoop can read",
    ]);
    // Nothing was read from Stripe for any of them.
    expect(fakeStripe.calls).toEqual([]);
    expect((await crewRow(t, crewId)).plan).toBe("free");
  });

  test("a bad signature is a 400 and changes nothing", async function () {
    const t = harness();
    const { crewId } = await crewOfThree(t);
    fakeStripe.subscriptions.set("sub_madeup_1", paidSubscription(crewId));
    const body = eventBody("checkout.session.completed", checkoutJson(crewId, paidSubscription(crewId)));
    const tenMinutesAgo = Math.floor(Date.now() / 1000) - 600;
    for (const sig of [
      null,
      "",
      "garbage",
      signature(body, "whsec_someone_elses"),
      signature(`${body} `),
      signature(body, SECRET, tenMinutesAgo),
      signature(body).replace("v1=", "v0="),
    ]) {
      expect((await post(t, body, sig)).status).toBe(400);
    }
    expect(fakeStripe.calls).toEqual([]);
    expect((await crewRow(t, crewId)).plan).toBe("free");
    // Signed right, the same body goes through.
    expect((await post(t, body)).status).toBe(200);
    expect((await crewRow(t, crewId)).plan).toBe("team");
  });

  test("when Stripe cannot be read, the webhook answers 500 so Stripe sends the event again", async function () {
    const t = harness();
    const { crewId } = await crewOfThree(t);
    fakeStripe.down = true;
    expect((await pays(t, crewId)).status).toBe(500);
    expect((await crewRow(t, crewId)).plan).toBe("free");
    fakeStripe.down = false;
    expect((await pays(t, crewId)).status).toBe(200);
    expect((await crewRow(t, crewId)).plan).toBe("team");
  });
});

describe("seats follow the members", function () {
  test("joining and leaving a paying crew changes the subscription's quantity; a crew that does not pay never calls Stripe", async function () {
    const t = harness();
    const { tom, ada, crewId } = await crewOfThree(t);
    const sam = await hackerNamed(t, "sam");
    const grace = await hackerNamed(t, "grace");
    await befriend(tom, sam, "sam");
    await tom.mutation(api.crews.add, { handle: "sam" });
    await drain(t);
    expect(fakeStripe.calls).toEqual([]);

    await pays(t, crewId, paidSubscription(crewId, { quantity: 4 }));
    fakeStripe.calls.length = 0;
    // Grace joins through Ada's invite (a member's invite adds to the crew).
    await invite(ada, grace);
    await drain(t);
    expect(fakeStripe.calls).toEqual([
      { call: "retrieve", id: "sub_madeup_1" },
      { call: "updateQuantity", itemId: "si_madeup_1", quantity: 5 },
    ]);
    expect((await crewRow(t, crewId)).subscriptionQuantity).toBe(5);

    await tom.mutation(api.crews.remove, { handle: "sam" });
    await drain(t);
    expect(must(fakeStripe.subscriptions.get("sub_madeup_1")).quantity).toBe(4);
    await ada.mutation(api.crews.leave, {});
    await drain(t);
    expect(must(fakeStripe.subscriptions.get("sub_madeup_1")).quantity).toBe(3);
    expect((await crewRow(t, crewId)).subscriptionQuantity).toBe(3);
  });

  test("a count Stripe already has is not sent again", async function () {
    const t = harness();
    const { crewId } = await crewOfThree(t);
    await pays(t, crewId);
    fakeStripe.calls.length = 0;
    await t.action(internal.billing.syncQuantity, { crewId });
    expect(fakeStripe.calls).toEqual([{ call: "retrieve", id: "sub_madeup_1" }]);
  });

  test("a count Stripe did not take is tried again later", async function () {
    const t = harness();
    const { tom, crewId } = await crewOfThree(t);
    const sam = await hackerNamed(t, "sam");
    await befriend(tom, sam, "sam");
    await pays(t, crewId);
    fakeStripe.down = true;
    await tom.mutation(api.crews.add, { handle: "sam" });
    await drain(t);
    const jobs = await t.run(async function (ctx) { return await ctx.db.system.query("_scheduled_functions").collect(); });
    const retry = must(jobs.find(function (j) { return j.name.includes("syncQuantity") && j.state.kind === "pending"; }));
    expect(retry.args).toEqual([{ crewId, attempt: 1 }]);
    expect(retry.scheduledTime).toBeGreaterThan(Date.now() + 4 * 60 * 1000);

    fakeStripe.down = false;
    await t.action(internal.billing.syncQuantity, { crewId, attempt: 1 });
    expect(must(fakeStripe.subscriptions.get("sub_madeup_1")).quantity).toBe(4);
    expect((await crewRow(t, crewId)).subscriptionQuantity).toBe(4);
  });
});

describe("lapsed team plans", function () {
  test("a crew whose renewal stays unpaid goes to free 3 days after its paid period; paid and hand-set ones stay", async function () {
    const t = harness();
    const ids: Id<"crews">[] = [];
    for (const handle of ["tom", "adalovelace", "jimmy", "grace"]) {
      const leader = await hackerNamed(t, handle);
      await leader.mutation(api.crews.create, { name: `${handle}'s crew` });
      ids.push(await crewIdOf(t, handle));
    }
    const [overdue, inGrace, paid, byHand] = ids.map(must);
    const now = Date.now();
    await t.run(async function (ctx) {
      const owing = { plan: "team" as const, stripeSubscriptionId: "sub_madeup", subscriptionStatus: "past_due" };
      await ctx.db.patch("crews", must(overdue), { ...owing, planUntil: now - 4 * DAY });
      await ctx.db.patch("crews", must(inGrace), { ...owing, planUntil: now - 2 * DAY });
      // Paid up, though its renewal's event never arrived: Stripe says active, so it stays.
      await ctx.db.patch("crews", must(paid), { plan: "team", stripeSubscriptionId: "sub_paid", subscriptionStatus: "active", planUntil: now - 10 * DAY });
      await ctx.db.patch("crews", must(byHand), { plan: "team" });
    });
    expect(await t.mutation(internal.billing.expire, {})).toBe(1);
    const lapsed = await crewRow(t, must(overdue));
    expect(lapsed).toMatchObject({ plan: "free", subscriptionStatus: "past_due", stripeSubscriptionId: "sub_madeup" });
    expect(lapsed.planUntil).toBeUndefined();
    expect(limitsFor(lapsed).digest).toBe(false);
    for (const id of [inGrace, paid, byHand]) expect((await crewRow(t, must(id))).plan).toBe("team");
    // Running it again moves nobody else.
    expect(await t.mutation(internal.billing.expire, {})).toBe(0);
  });

  test("paying a lapsed crew's subscription brings the team plan back", async function () {
    const t = harness();
    const { crewId } = await crewOfThree(t);
    const sub = paidSubscription(crewId);
    await pays(t, crewId, sub);
    const owed = { ...sub, status: "past_due", periodStart: NOW - 5 * DAY, periodEnd: NOW + 25 * DAY };
    await stripeSays(t, "customer.subscription.updated", owed);
    expect(await t.mutation(internal.billing.expire, {})).toBe(1);
    expect((await crewRow(t, crewId)).plan).toBe("free");
    await stripeSays(t, "customer.subscription.updated", { ...owed, status: "active" });
    expect(await crewRow(t, crewId)).toMatchObject({ plan: "team", planUntil: owed.periodEnd });
  });

  test("the expiry is a daily cron", function () {
    expect(crons.crons["end lapsed team plans"]).toMatchObject({ name: "billing:expire", schedule: { type: "interval", hours: 24 } });
  });
});
