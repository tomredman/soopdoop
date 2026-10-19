// ABOUTME: Tests for billing's rules on their own: what each subscription status does to a crew, when a subscription that is
// ABOUTME: not the crew's counts, the subscription as the app shows it, and the links Checkout sends the leader back to.
import { describe, expect, test } from "bun:test";
import { afterSubscription, checkoutReturn, type CrewBilling, DEFAULT_SITE_URL, hasEnded, isOpen, isPaid, siteUrl, subscriptionOf } from "./billing";

const SUB = { id: "sub_1", customerId: "cus_1", status: "active", itemId: "si_1", quantity: 3, yearly: false, periodStart: 1_000, periodEnd: 2_000, renews: true };

function billingAfter(crew: CrewBilling, status: string, fromCheckout = false, id = SUB.id): CrewBilling {
  const outcome = afterSubscription(crew, { ...SUB, id, status }, fromCheckout);
  if (outcome.kind !== "set") throw new Error(`ignored: ${outcome.why}`);
  return outcome.billing;
}

const FREE: CrewBilling = { plan: "free" };
const TEAM = billingAfter(FREE, "active", true);

describe("what a subscription does to a crew", function () {
  test("paid: the team plan until the period's end, with everything the app shows", function () {
    expect(TEAM).toEqual({
      plan: "team",
      planUntil: 2_000,
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      subscriptionStatus: "active",
      subscriptionQuantity: 3,
      subscriptionYearly: false,
      subscriptionUntil: 2_000,
      subscriptionRenews: true,
    });
    expect(billingAfter(FREE, "trialing")).toMatchObject({ plan: "team", planUntil: 2_000 });
  });

  test("each status, for a crew on the team plan", function () {
    const plans = ["active", "trialing", "past_due", "incomplete", "unpaid", "paused", "canceled", "incomplete_expired"].map(function (status) {
      const after = billingAfter(TEAM, status);
      return [status, after.plan, after.planUntil ?? null, after.stripeSubscriptionId ?? null];
    });
    expect(plans).toEqual([
      ["active", "team", 2_000, "sub_1"],
      ["trialing", "team", 2_000, "sub_1"],
      // The end of the last paid period is the start of the unpaid one.
      ["past_due", "team", 1_000, "sub_1"],
      ["incomplete", "team", 2_000, "sub_1"],
      ["unpaid", "free", null, "sub_1"],
      ["paused", "free", null, "sub_1"],
      ["canceled", "free", null, null],
      ["incomplete_expired", "free", null, null],
    ]);
    // An ended subscription leaves only the customer, for the next checkout.
    expect(billingAfter(TEAM, "canceled")).toEqual({
      plan: "free",
      planUntil: undefined,
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: undefined,
      subscriptionStatus: undefined,
      subscriptionQuantity: undefined,
      subscriptionYearly: undefined,
      subscriptionUntil: undefined,
      subscriptionRenews: undefined,
    });
  });

  test("past_due and incomplete never lift a free crew to the team plan", function () {
    expect(billingAfter(FREE, "past_due")).toMatchObject({ plan: "free", planUntil: undefined, subscriptionStatus: "past_due" });
    expect(billingAfter(FREE, "incomplete")).toMatchObject({ plan: "free", planUntil: undefined, subscriptionStatus: "incomplete" });
  });

  test("an ended subscription changes nothing for a crew with none (one it never had, or a replay after it ended)", function () {
    expect(afterSubscription(FREE, { ...SUB, status: "canceled" }, true)).toEqual({
      kind: "ignore",
      why: "it has ended, and the crew has no subscription to end",
    });
  });

  test("another subscription counts only when paid, and either from the leader's new checkout or after the crew's own one ended", function () {
    const other = "sub_2";
    expect(afterSubscription(TEAM, { ...SUB, id: other }, false)).toMatchObject({ kind: "ignore" });
    expect(afterSubscription(TEAM, { ...SUB, id: other, status: "incomplete" }, true)).toMatchObject({ kind: "ignore" });
    // A new checkout while the crew's own still bills: it takes over, and names the one still billing.
    expect(afterSubscription(TEAM, { ...SUB, id: other }, true)).toMatchObject({ kind: "set", replaces: "sub_1", billing: { stripeSubscriptionId: other } });
    // The crew's own is waiting for its first payment: a paid one takes over without a checkout event.
    const waiting = billingAfter(FREE, "incomplete");
    expect(afterSubscription(waiting, { ...SUB, id: other }, false)).toMatchObject({ kind: "set", billing: { plan: "team", stripeSubscriptionId: other } });
    expect(afterSubscription(waiting, { ...SUB, id: other }, false)).not.toHaveProperty("replaces", "sub_1");
  });

  test("statuses sort into paid, still on the books, and ended", function () {
    expect(["active", "trialing"].every(isPaid)).toBe(true);
    expect(["past_due", "unpaid", "incomplete", undefined].some(isPaid)).toBe(false);
    expect(["active", "trialing", "past_due", "unpaid", "paused"].every(isOpen)).toBe(true);
    expect(["incomplete", "incomplete_expired", "canceled", undefined].some(isOpen)).toBe(false);
    expect(["canceled", "incomplete_expired"].every(hasEnded)).toBe(true);
    expect(["unpaid", "past_due", undefined].some(hasEnded)).toBe(false);
  });
});

describe("the subscription as the app shows it", function () {
  test("only when the crew has one", function () {
    expect(subscriptionOf(TEAM)).toEqual({ status: "active", yearly: false, quantity: 3, until: 2_000, renews: true });
    expect(subscriptionOf({ ...TEAM, subscriptionRenews: false, subscriptionYearly: true })).toMatchObject({ yearly: true, renews: false });
    expect(subscriptionOf(FREE)).toBeNull();
    expect(subscriptionOf({ plan: "team" })).toBeNull();
  });
});

describe("links back from Stripe", function () {
  test("SITE_URL, or soopdoop.com, with ?billing=done or ?billing=cancelled", function () {
    expect(siteUrl(undefined)).toBe(DEFAULT_SITE_URL);
    expect(siteUrl("  ")).toBe(DEFAULT_SITE_URL);
    expect(siteUrl(" https://example.com/teams ")).toBe("https://example.com/teams");
    expect(function () { siteUrl("soopdoop dot com"); }).toThrow("SITE_URL on this deployment is not a link");
    expect(checkoutReturn(DEFAULT_SITE_URL, "done")).toBe("https://soopdoop.com/?billing=done");
    expect(checkoutReturn("https://example.com/teams?from=app", "cancelled")).toBe("https://example.com/teams?from=app&billing=cancelled");
  });
});
