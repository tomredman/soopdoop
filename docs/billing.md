# Billing

How a crew pays for the team plan, and what Mr. Tom sets up in Stripe and on the production deployment before the Upgrade button works. The code is `packages/convex/convex/billing.ts` (the functions), `lib/billing.ts` (the rules) and `lib/stripe.ts` (the Stripe calls).

## What happens

- The plan is per crew, and the leader pays: $10 a member a month, or $100 a member a year (ten months). The leader counts as a member.
- **Upgrade** (Settings → Crew, leader only) opens Stripe Checkout for as many members as the crew has now. Checkout fills in the leader's Superset sign-in email.
- When the payment goes through, Stripe calls the webhook and the crew moves to the team plan until the end of the period it paid for.
- When someone joins or leaves the crew, soopdoop sets the subscription's quantity to the new member count. Stripe prorates the difference on the next invoice (its default). It does the same whenever Stripe bills for another number of people than the crew has: someone joined while the Checkout page was open, or a quantity was changed in the Dashboard.
- **Manage billing** (leader only) opens Stripe's billing portal: the card, invoices, monthly or yearly, cancel. A crew that already pays and presses Upgrade gets the portal too, so nobody pays twice.
- A canceled plan runs to the end of its paid period. Then Stripe ends the subscription and the crew goes back to the free plan.
- A renewal that fails: Stripe retries on its own schedule. The crew keeps the team plan for 3 days after the end of its last paid period, then a daily job moves it to free. Paying brings the team plan back.
- Going back to free deletes nothing by itself, but the free plan's limits apply from then on (`lib/plan.ts`): no digest, 10 live notes, 5 hand-offs a day, and the daily ledger prune keeps 7 days instead of 90, so older ledger lines are gone after the next prune.

## Set up in Stripe

Do it in test mode first (see the end of this page), then again in live mode. The links go to the Stripe Dashboard pages; their menu names change from time to time.

1. **The product and its two prices** (dashboard.stripe.com/products). Add a product, for example "soopdoop Team", with two recurring prices in USD, each priced per unit (one unit is one member):
   - $10.00 every month. Its id (`price_...`) is `STRIPE_PRICE_MONTHLY`.
   - $100.00 every year. Its id is `STRIPE_PRICE_YEARLY`.
2. **The webhook endpoint** (dashboard.stripe.com/webhooks):
   - URL: `https://fleet-skunk-723.convex.site/stripe/webhook` for production. Any other deployment uses its own `https://<deployment>.convex.site/stripe/webhook`.
   - Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`. Nothing else is needed.
   - API version: `2026-09-30.endive`, the version of the `stripe` package soopdoop uses (23.0.0). soopdoop also reads the older shape, where the billing period sits on the subscription instead of its item.
   - Its signing secret (`whsec_...`) is `STRIPE_WEBHOOK_SECRET`.
3. **The billing portal** (dashboard.stripe.com/settings/billing/portal). Turn on payment methods, invoice history, and canceling at the end of the billing period. To let leaders switch between monthly and yearly, let customers switch plans and add the product with both prices. Do not let customers change the quantity: soopdoop sets it to the member count and sets it back at the next change. Let customers update their name, email, address and tax ID, so invoices and tax stay right. Without a saved portal configuration, Manage billing fails with "No configuration provided". The sandbox has one (made through Stripe's API on 19 Oct 2026); live mode needs its own.
4. **Failed payments** (dashboard.stripe.com/settings/billing/subscriptions, "Manage failed payments"). Choose the retry schedule and what happens after the last retry. "Cancel the subscription" and "mark it unpaid" both move the crew to free at once; with "unpaid", paying the open invoice in the portal brings the team plan back. "Leave it past due" also works: the daily job moves the crew to free 3 days after its paid period.
5. **The secret key** (`sk_live_...`) is `STRIPE_SECRET_KEY`. A restricted key is safer. It needs write access to Checkout Sessions, the Customer portal and Subscriptions; this was not tried with a restricted key.
6. **Stripe Tax** (dashboard.stripe.com/settings/tax). Add the head office address, then turn automatic tax on in Checkout: `automatic_tax: { enabled: true }` in `lib/stripe.ts`. Checkout Studio set it off on 19 Oct 2026, because Stripe refuses to make any Checkout session with it on until the head office is set, in test mode too (Upgrade then says "Stripe said: You must have a valid head office address to enable automatic tax calculation"). Then add a registration for each place where soopdoop must collect tax: Canada's GST/HST first, once the small-supplier threshold is passed (ask an accountant), then other countries as their thresholds are reached. Stripe watches the thresholds and adds tax only where a registration exists, so with none it adds nothing and charges nothing. The product's tax code is `txcd_10103001` (software as a service, business use) and both prices are tax-exclusive: tax goes on top of the $10 and $100. With automatic tax on, Checkout asks for the billing address it needs, and a business gives its VAT or GST number, which makes the sale a reverse charge where that applies. The sandbox has the tax code, the tax behavior and the default settings already; live mode needs the same.
7. **Invoices and failed payments.** Under Billing → Invoices, turn on emailing finalized invoices and receipts, and fill in the business name, address and tax number for the invoice footer. Under Billing → Revenue recovery, turn on Smart Retries, the failed-payment emails and automatic card updates. Stripe's Managed Payments (Stripe as the seller of record, handling tax everywhere) is open to Canadian businesses; soopdoop uses Stripe Tax instead, so soopdoop stays the seller on every invoice.

## Set on the production deployment

The billing code must be in a release first (`bun run release`), so the webhook URL exists before Stripe sends to it. Then, from `packages/convex` in a checkout set up as in RELEASING.md:

```sh
pbpaste | npx convex env set --prod STRIPE_SECRET_KEY        # copy the key first; keeps it out of the shell history
pbpaste | npx convex env set --prod STRIPE_WEBHOOK_SECRET
npx convex env set --prod STRIPE_PRICE_MONTHLY price_...
npx convex env set --prod STRIPE_PRICE_YEARLY price_...
# Optional. Where Checkout and the portal send the leader back. Without it: https://soopdoop.com
npx convex env set --prod SITE_URL https://soopdoop.com
```

Checkout sends the leader back to `SITE_URL` with `?billing=done` after paying, or `?billing=cancelled` after backing out; the site can show a line for each. The portal sends them back to `SITE_URL` as it is.

Never set `STRIPE_FAKE` on production. It replaces Stripe with a stand-in that makes up links, for tests.

Until the key and both prices are set, Upgrade answers "Billing is not set up on this deployment yet." Until the key and the webhook's signing secret are set, the webhook answers 500, and Stripe keeps retrying for 3 days.

## What the app calls

- Upgrade: the action `billing.checkout` with `{ yearly }`. It returns a link to open in the browser.
- Manage billing: the action `billing.portal` with `{}`. It returns a link.
- The plan, for every member: the query `billing.status`, and `subscription` in `crews.mine`. A subscription looks like `{ status, yearly, quantity, until, renews }`: `until` is when the current period ends, and `renews` is false once the leader canceled it.

## Things to know

- Stripe can send events in any order and more than once. soopdoop reads the subscription from Stripe again for each event, and once more a minute after an event changed the crew, so the crew ends up as Stripe has it now and a repeated event changes nothing. A crew remembers the subscriptions it had that ended (Stripe never brings one back), so late news about them changes nothing.
- The crew's id is in the Checkout session (`client_reference_id` and `metadata.crewId`) and in the subscription's metadata (`crewId`). Do not edit it in the Dashboard.
- If a leader pays twice (two Checkout tabs), the crew follows the checkout whose event arrived last, and the Convex logs name the other subscription: "Cancel sub_... in the Stripe Dashboard". Cancel that one. Until then, if the one the crew follows ends first, the crew falls back to the other while it still bills.
- If the last member leaves a crew that still pays, the subscription keeps billing and the Convex logs say so. Cancel it in the Dashboard.
- Handing the lead to someone else hands over billing too: the new leader's Manage billing opens the same Stripe customer, with the old leader's card and invoices. The old leader may want to change the card first.
- A crew can be put on the team plan by hand, for a comped crew or for trying the team plan before billing is set up: from `packages/convex`, `npx convex run --prod crews:setPlanByHand '{"crewId":"<crew id from the dashboard>","plan":"team"}'` (or `plan: "team"` with no `planUntil` on the row in the dashboard). Nothing ends it, its Upgrade button says it is on the team plan already, and the same command with `"free"` puts it back.

## Try it in test mode

On a dev deployment, with Stripe in test mode (keys `sk_test_...`, test prices):

1. Set the four variables without `--prod`. For the webhook, the Stripe CLI can forward test events and prints a signing secret for that session:
   `stripe listen --forward-to https://<dev deployment>.convex.site/stripe/webhook --events checkout.session.completed,customer.subscription.updated,customer.subscription.deleted`
2. Press Upgrade and pay with the test card 4242 4242 4242 4242. The crew shows the team plan.
3. Add and remove a member; the subscription's quantity follows in the Dashboard.
4. Switch to yearly in the portal, then cancel there: `billing.status` shows `yearly: true`, then `renews: false`.
5. To see a period end without waiting a month, use a Stripe test clock. It moves time only for customers made on the clock: make one in the Dashboard, put its id in the crew's `stripeCustomerId` (Convex dashboard, Data → crews) before pressing Upgrade, and pay with 4242 4242 4242 4242. Advance the clock past the period's end: a canceled subscription moves the crew to free. For a failed renewal, change the card in the portal to 4000 0000 0000 0341 (it attaches, then every charge fails) and advance past the renewal: past_due, then free 3 days after the paid period (the daily job).

## Checked so far

Not checked: a Checkout, a portal session or a webhook against real Stripe, even in test mode. There were no Stripe keys, prices or account for soopdoop when this was built.

Checked (19 Oct 2026), in the "soopdoop sandbox" Stripe account (test mode): Mr. Tom made the product, the two prices and the webhook endpoint for the dev deployment (steps 1 and 2); through Stripe's API tools the prices became tax-exclusive, the product got its tax code, the tax settings got their defaults, and the billing portal configuration was made (steps 3 and 6). The Checkout fields (Checkout Studio's page settings, tax ID collection, and the customer update for an existing customer) were checked against the local stand-in for api.stripe.com. Then Mr. Tom set the test key, the webhook's signing secret, the price ids and SITE_URL on the dev deployment, and the first real Checkout call went to Stripe with the key and was refused for the missing head office address (above), so the key, the client and the error path work. With automatic tax off (Checkout Studio's setting), Mr. Tom paid a real test-mode Checkout for a test crew of two with the test card: Stripe's webhook reached the dev deployment, the crew moved to the team plan with its subscription (2 seats, monthly, active, renews), `billing.status` showed it to the leader and to a member, and `billing.portal` made a real billing portal link. Removing a member and adding them back set the subscription's quantity to 1 and then 2 in Stripe (two `customer.subscription.updated` events from soopdoop's own requests, prorated), and the crew row followed.

Checked (18 Oct 2026):

- Tests against a stand-in Stripe (`STRIPE_FAKE=1`): Checkout and the portal for the leader only, the webhook setting and clearing the plan, repeats and late events changing nothing, an older read landing last being put right, bad signatures refused, seat counts following members (also someone joining while Checkout is open), paying twice, and lapsed plans going to free.
- The real client's requests (Checkout, the portal, reading a subscription, setting a quantity), sent by the `stripe` package to a local server standing in for api.stripe.com: the form fields, the key and the API version header.
- In Convex's own runtime, on a local backend (`precompiled-2026-10-10`): the modules load with the `stripe` package without `"use node"`; the webhook accepts a correctly signed event and refuses a wrong secret, a changed body, a missing signature and a signature older than 5 minutes; Checkout and the portal answer the leader and refuse a member; a deleted subscription moves the crew to free, the same event again changes nothing, and an older "active" written after it is ignored.
