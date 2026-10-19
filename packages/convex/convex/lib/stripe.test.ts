// ABOUTME: Tests for the Stripe calls: reading subscriptions and Checkout sessions from Stripe's JSON (new and old API shapes),
// ABOUTME: webhook signatures (against Node's own HMAC), which client a deployment gets, and the real client's requests on a local server.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { must } from "../testing.helpers";
import { fakeStripe, readCheckoutSession, readSubscription, realStripe, resetFakeStripe, stripeClient } from "./stripe";

const SECRET = "whsec_madeup_for_tests";

// Stripe's own example subscription (docs.stripe.com/api/subscriptions/object, API version 2026-09-30), with made-up ids.
const DOCS_SUBSCRIPTION = {
  id: "sub_madeup_docs",
  object: "subscription",
  application: null,
  billing_cycle_anchor: 1679609767,
  cancel_at: null,
  cancel_at_period_end: false,
  canceled_at: null,
  collection_method: "charge_automatically",
  created: 1679609767,
  currency: "usd",
  customer: "cus_madeup_docs",
  ended_at: null,
  items: {
    object: "list",
    data: [
      {
        id: "si_madeup_docs",
        object: "subscription_item",
        created: 1679609768,
        current_period_end: 1682288167,
        current_period_start: 1679609767,
        metadata: {},
        plan: { id: "price_madeup_docs", object: "plan", active: true, amount: 1000, currency: "usd", interval: "month", interval_count: 1, usage_type: "licensed" },
        price: {
          id: "price_madeup_docs",
          object: "price",
          active: true,
          currency: "usd",
          recurring: { interval: "month", interval_count: 1, trial_period_days: null, usage_type: "licensed" },
          type: "recurring",
          unit_amount: 1000,
        },
        quantity: 1,
        subscription: "sub_madeup_docs",
        tax_rates: [],
      },
    ],
    has_more: false,
    total_count: 1,
    url: "/v1/subscription_items?subscription=sub_madeup_docs",
  },
  latest_invoice: "in_madeup_docs",
  livemode: false,
  metadata: {},
  start_date: 1679609767,
  status: "active",
  trial_end: null,
};

function hmac(body: string, secret: string, at: number): string {
  return createHmac("sha256", secret).update(`${at}.${body}`).digest("hex");
}

function sign(body: string, secret: string = SECRET, at: number = Math.floor(Date.now() / 1000)): string {
  return `t=${at},v1=${hmac(body, secret, at)}`;
}

let saved: { fake?: string; key?: string } = {};

beforeEach(function () {
  saved = { fake: process.env.STRIPE_FAKE, key: process.env.STRIPE_SECRET_KEY };
  delete process.env.STRIPE_FAKE;
  delete process.env.STRIPE_SECRET_KEY;
  resetFakeStripe();
});

afterEach(function () {
  if (saved.fake === undefined) delete process.env.STRIPE_FAKE;
  else process.env.STRIPE_FAKE = saved.fake;
  if (saved.key === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = saved.key;
  resetFakeStripe();
});

describe("reading Stripe's JSON", function () {
  test("a subscription in today's shape: the period is on its item", function () {
    expect(readSubscription(DOCS_SUBSCRIPTION)).toEqual({
      id: "sub_madeup_docs",
      customerId: "cus_madeup_docs",
      status: "active",
      itemId: "si_madeup_docs",
      quantity: 1,
      yearly: false,
      periodStart: 1679609767000,
      periodEnd: 1682288167000,
      renews: true,
      crewId: undefined,
    });
  });

  test("a subscription in the older shape: the period on the subscription, the price as a plan, the customer expanded", function () {
    const old = {
      id: "sub_madeup_old",
      object: "subscription",
      customer: { id: "cus_madeup_old", object: "customer" },
      status: "past_due",
      current_period_start: 1700000000,
      current_period_end: 1731536000,
      cancel_at_period_end: true,
      cancel_at: 1731536000,
      metadata: { crewId: "crew_madeup" },
      items: { object: "list", data: [{ id: "si_madeup_old", object: "subscription_item", quantity: 4, plan: { interval: "year" } }] },
    };
    expect(readSubscription(old)).toEqual({
      id: "sub_madeup_old",
      customerId: "cus_madeup_old",
      status: "past_due",
      itemId: "si_madeup_old",
      quantity: 4,
      yearly: true,
      periodStart: 1700000000000,
      periodEnd: 1731536000000,
      renews: false,
      crewId: "crew_madeup",
    });
  });

  test("a cancel date set some other way also means it will not renew", function () {
    expect(readSubscription({ ...DOCS_SUBSCRIPTION, cancel_at: 1690000000 })?.renews).toBe(false);
  });

  test("anything else is not a subscription", function () {
    expect(readSubscription(null)).toBeNull();
    expect(readSubscription({ ...DOCS_SUBSCRIPTION, object: "invoice" })).toBeNull();
    expect(readSubscription({ ...DOCS_SUBSCRIPTION, items: { object: "list", data: [] } })).toBeNull();
    expect(readSubscription({ ...DOCS_SUBSCRIPTION, customer: null })).toBeNull();
    const noPeriod = { ...DOCS_SUBSCRIPTION, items: { object: "list", data: [{ id: "si_madeup", quantity: 1 }] } };
    expect(readSubscription(noPeriod)).toBeNull();
  });

  test("a finished Checkout session: the crew from client_reference_id or the metadata, ids plain or expanded", function () {
    const session = {
      id: "cs_madeup",
      object: "checkout.session",
      mode: "subscription",
      client_reference_id: "crew_madeup",
      metadata: { crewId: "crew_madeup" },
      customer: "cus_madeup",
      subscription: "sub_madeup",
    };
    expect(readCheckoutSession(session)).toEqual({ mode: "subscription", crewId: "crew_madeup", subscriptionId: "sub_madeup", customerId: "cus_madeup" });
    const expanded = { ...session, client_reference_id: null, subscription: { id: "sub_madeup", object: "subscription" }, customer: { id: "cus_madeup" } };
    expect(readCheckoutSession(expanded)).toEqual({ mode: "subscription", crewId: "crew_madeup", subscriptionId: "sub_madeup", customerId: "cus_madeup" });
    expect(readCheckoutSession({ ...session, client_reference_id: null, metadata: {}, subscription: null })).toEqual({
      mode: "subscription",
      crewId: undefined,
      subscriptionId: undefined,
      customerId: "cus_madeup",
    });
    expect(readCheckoutSession(DOCS_SUBSCRIPTION)).toBeNull();
  });
});

describe("webhook signatures", function () {
  test("an event is accepted only when signed with the endpoint's secret in the last 5 minutes", async function () {
    process.env.STRIPE_FAKE = "1";
    const stripe = must(stripeClient());
    const object = { id: "sub_madeup", object: "subscription" };
    const body = JSON.stringify({ id: "evt_madeup", object: "event", type: "customer.subscription.updated", data: { object } });
    expect(await stripe.constructEvent(body, sign(body), SECRET)).toEqual({ id: "evt_madeup", type: "customer.subscription.updated", object });
    // While a secret is being rolled, Stripe signs with the old and the new one.
    const at = Math.floor(Date.now() / 1000);
    expect((await stripe.constructEvent(body, `t=${at},v1=${hmac(body, "whsec_old", at)},v1=${hmac(body, SECRET, at)}`, SECRET)).id).toBe("evt_madeup");

    const refused = [
      sign(body, "whsec_someone_elses"),
      sign(body, SECRET, at - 6 * 60),
      sign(body).replace("v1=", "v0="),
      `t=${at}`,
      "",
    ];
    for (const header of refused) await expect(stripe.constructEvent(body, header, SECRET)).rejects.toThrow();
    await expect(stripe.constructEvent(`${body}\n`, sign(body), SECRET)).rejects.toThrow();
  });
});

describe("which Stripe a deployment gets", function () {
  test("STRIPE_FAKE=1 is the stand-in, even beside a key; a key alone is real Stripe; neither means no billing", async function () {
    expect(stripeClient()).toBeNull();
    process.env.STRIPE_SECRET_KEY = "   ";
    expect(stripeClient()).toBeNull();
    process.env.STRIPE_SECRET_KEY = "sk_test_madeup";
    expect(stripeClient()).not.toBeNull();
    process.env.STRIPE_FAKE = "1";
    await expect(must(stripeClient()).retrieveSubscription("sub_unknown")).rejects.toThrow("No such subscription: 'sub_unknown'");
    expect(fakeStripe.calls).toEqual([{ call: "retrieve", id: "sub_unknown" }]);
  });
});

describe("the real client, against a local server standing in for api.stripe.com", function () {
  test("sends the requests in Stripe's API reference and reads the replies", async function () {
    const seen: { method: string; path: string; form: Record<string, string>; auth: string | null; version: string | null }[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const form = Object.fromEntries(new URLSearchParams(await req.text()));
        seen.push({ method: req.method, path: url.pathname, form, auth: req.headers.get("authorization"), version: req.headers.get("stripe-version") });
        if (url.pathname === "/v1/checkout/sessions" && form["line_items[0][price]"] === "price_unknown") {
          return Response.json({ error: { type: "invalid_request_error", code: "resource_missing", message: "No such price: 'price_unknown'" } }, { status: 400 });
        }
        if (url.pathname === "/v1/checkout/sessions") {
          return Response.json({ id: "cs_test_madeup", object: "checkout.session", url: "https://checkout.stripe.com/c/pay/cs_test_madeup" });
        }
        if (url.pathname === "/v1/billing_portal/sessions") {
          return Response.json({ id: "bps_madeup", object: "billing_portal.session", url: "https://billing.stripe.com/p/session/test_madeup" });
        }
        if (url.pathname === "/v1/subscriptions/sub_madeup_docs") return Response.json(DOCS_SUBSCRIPTION);
        if (url.pathname === "/v1/subscription_items/si_madeup_docs") return Response.json({ id: "si_madeup_docs", object: "subscription_item", quantity: 4 });
        return Response.json({ error: { type: "invalid_request_error", message: `Unrecognized request URL (${req.method}: ${url.pathname})` } }, { status: 404 });
      },
    });
    try {
      const stripe = realStripe("sk_test_madeup", { host: "127.0.0.1", port: must(server.port), protocol: "http" });
      const checkout = {
        price: "price_monthly_madeup",
        quantity: 3,
        crewId: "crew_madeup",
        customerEmail: "tom@example.com",
        successUrl: "https://soopdoop.com/?billing=done",
        cancelUrl: "https://soopdoop.com/?billing=cancelled",
      };
      expect(await stripe.createCheckoutSession(checkout)).toEqual({ id: "cs_test_madeup", url: "https://checkout.stripe.com/c/pay/cs_test_madeup" });
      await stripe.createCheckoutSession({ ...checkout, customer: "cus_madeup" });
      expect(await stripe.createPortalSession({ customer: "cus_madeup", returnUrl: "https://soopdoop.com" })).toEqual({
        url: "https://billing.stripe.com/p/session/test_madeup",
      });
      expect(await stripe.retrieveSubscription("sub_madeup_docs")).toMatchObject({ id: "sub_madeup_docs", itemId: "si_madeup_docs", periodEnd: 1682288167000 });
      await stripe.updateQuantity("si_madeup_docs", 4);
      await expect(stripe.createCheckoutSession({ ...checkout, price: "price_unknown" })).rejects.toThrow("No such price: 'price_unknown'");

      const sessionForm = {
        mode: "subscription",
        "line_items[0][price]": "price_monthly_madeup",
        "line_items[0][quantity]": "3",
        client_reference_id: "crew_madeup",
        "metadata[crewId]": "crew_madeup",
        "subscription_data[metadata][crewId]": "crew_madeup",
        success_url: "https://soopdoop.com/?billing=done",
        cancel_url: "https://soopdoop.com/?billing=cancelled",
        ui_mode: "hosted_page",
        origin_context: "web",
        integration_identifier: "hosted_web_0001",
        billing_address_collection: "auto",
        "phone_number_collection[enabled]": "false",
        "automatic_tax[enabled]": "false",
        allow_promotion_codes: "false",
        payment_method_collection: "always",
        submit_type: "auto",
        "tax_id_collection[enabled]": "true",
      };
      expect(seen.slice(0, 5).map(function (r) { return [r.method, r.path]; })).toEqual([
        ["POST", "/v1/checkout/sessions"],
        ["POST", "/v1/checkout/sessions"],
        ["POST", "/v1/billing_portal/sessions"],
        ["GET", "/v1/subscriptions/sub_madeup_docs"],
        ["POST", "/v1/subscription_items/si_madeup_docs"],
      ]);
      expect(must(seen[0]).form).toEqual({ ...sessionForm, customer_email: "tom@example.com" });
      // With a customer, Checkout uses its email and no email is sent; the name and address typed go onto the customer.
      expect(must(seen[1]).form).toEqual({ ...sessionForm, customer: "cus_madeup", "customer_update[address]": "auto", "customer_update[name]": "auto" });
      expect(must(seen[2]).form).toEqual({ customer: "cus_madeup", return_url: "https://soopdoop.com" });
      expect(must(seen[4]).form).toEqual({ quantity: "4" });
      for (const r of seen) {
        expect(r.auth).toBe("Bearer sk_test_madeup");
        expect(r.version).toBe("2026-09-30.endive");
      }
    } finally {
      await server.stop(true);
    }
  });
});
