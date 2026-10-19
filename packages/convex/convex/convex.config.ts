// ABOUTME: The Convex app definition. Declares the deployment's environment variables, so functions read them typed (env).
// ABOUTME: ANTHROPIC_API_KEY pays for the Operator, OPERATOR_FAKE=1 answers without Claude (tests); STRIPE_* and SITE_URL are billing's.
import { defineApp } from "convex/server";
import { v } from "convex/values";

const app = defineApp({
  env: {
    ANTHROPIC_API_KEY: v.optional(v.string()),
    OPERATOR_FAKE: v.optional(v.string()),
    // Billing (billing.ts, docs/billing.md). Without the key and the two prices, Upgrade says billing is not set up.
    STRIPE_SECRET_KEY: v.optional(v.string()),
    // The signing secret of the Stripe webhook endpoint that posts to /stripe/webhook.
    STRIPE_WEBHOOK_SECRET: v.optional(v.string()),
    // The two prices of the team plan, per member: $10 a month, and $100 a year.
    STRIPE_PRICE_MONTHLY: v.optional(v.string()),
    STRIPE_PRICE_YEARLY: v.optional(v.string()),
    // STRIPE_FAKE=1 answers with a stand-in Stripe that makes up ids and links, for tests.
    STRIPE_FAKE: v.optional(v.string()),
    // Where Checkout and the billing portal send the leader back to. https://soopdoop.com when unset.
    SITE_URL: v.optional(v.string()),
  },
});

export default app;
