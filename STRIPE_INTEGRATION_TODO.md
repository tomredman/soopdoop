# Stripe integration: what is left

Checkout Studio's settings from 19 Oct 2026 are in the one place soopdoop makes a Checkout Session:
[packages/convex/convex/lib/stripe.ts](packages/convex/convex/lib/stripe.ts), `createCheckoutSession`. The full setup lives
in [docs/billing.md](docs/billing.md). This file lists what the Studio export asked for and what is still open.

## Values to Replace

Nothing in the code is a placeholder. The sample-only parameters already have real values:

| Field | Current value | Where it comes from |
|-------|---------------|---------------------|
| mode | subscription | the team plan is recurring |
| success_url | `<SITE_URL>/?billing=done` | `SITE_URL` on the deployment, default https://soopdoop.com |
| cancel_url | `<SITE_URL>/?billing=cancelled` | the same |
| line_items[].price | the monthly or yearly price id | `STRIPE_PRICE_MONTHLY` and `STRIPE_PRICE_YEARLY` on the deployment |
| line_items[].quantity | the crew's member count | the crew |

The dev deployment has the test-mode values. Production has none yet: set them as docs/billing.md says.

## Configured Parameters

These came from Checkout Studio and are set as given.

**Files containing these parameters:**
- [packages/convex/convex/lib/stripe.ts](packages/convex/convex/lib/stripe.ts)

| Parameter | Value |
|-----------|-------|
| ui_mode | hosted_page (the `stripe` package is 23.0.0; 21.0.0 and above use this name) |
| origin_context | web |
| integration_identifier | hosted_web_0001 |
| billing_address_collection | auto |
| phone_number_collection.enabled | false |
| automatic_tax.enabled | false |
| allow_promotion_codes | false |
| payment_method_collection | always |
| submit_type | auto |

Kept beside them because the integration needs them (they are not Studio settings): `client_reference_id` and
`metadata.crewId` (how the webhook finds the crew), `subscription_data.metadata.crewId`, `customer` or `customer_email`,
`customer_update` (the name and address typed in Checkout go onto an existing customer), and `tax_id_collection` (a
business's VAT or GST number).

## Setup

- Environment variables live on the Convex deployment, not in a file: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY`, and optionally `SITE_URL`. The code reads exactly these names; names
  such as `STRIPE_WEBHOOK_SIGNING_SECRET` or `STRIPE_PUBLISHABLE_KEY` are not read. No API version is set in code; the
  `stripe` package sends its own.
- No new files or routes. Checkout is the action `billing.checkout`; the webhook is `POST /stripe/webhook` for
  `checkout.session.completed`, `customer.subscription.updated` and `customer.subscription.deleted`; Manage billing is
  the action `billing.portal`.

## How it works

Upgrade in the Mac app calls `billing.checkout`, which makes a hosted Checkout Session for the crew's member count. The
leader pays on Stripe's page. Stripe calls the webhook; soopdoop reads the subscription from Stripe again and moves the
crew to the team plan until the end of the paid period. Members joining or leaving change the seat count. Manage billing
opens Stripe's Customer Portal.

## Testing

Test mode, on the dev deployment. Card 4242 4242 4242 4242 with any future expiry, any CVC and any postal code pays;
4000 0000 0000 0002 is declined. A test Checkout was paid on 19 Oct 2026 and the webhook moved the crew to the team plan (docs/billing.md, "Checked so far").

## Next steps

1. Put the head office address in Stripe (Settings → Tax), set `automatic_tax: { enabled: true }` in lib/stripe.ts, then
   add registrations as they are needed.
2. Set the live keys, prices and webhook on production (docs/billing.md).
3. Require the terms of service in Checkout once soopdoop.com/terms is live (`consent_collection`).

Resources: https://support.stripe.com and https://docs.stripe.com/mcp
