// ABOUTME: Billing for crews (docs/billing.md): the leader pays per member, monthly or yearly, through Stripe Checkout, and
// ABOUTME: manages it in Stripe's billing portal. Stripe's webhook sets the plan; member changes update the seat count.
import { ConvexError, type Infer, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { action, env, httpAction, internalAction, internalMutation, internalQuery, query } from "./_generated/server";
import { checkHacker, hackerFor, requireIdentity } from "./lib/auth";
import {
  afterSubscription,
  checkoutReturn,
  GRACE_MS,
  isOpen,
  isPaid,
  sameBilling,
  siteUrl,
  subscriptionOf,
  subscriptionView,
} from "./lib/billing";
import { crewOf, memberIdsOf, requireLeader } from "./lib/crew";
import { readCheckoutSession, readSubscription, type StripeApi, type StripeEvent, stripeClient, type Subscription } from "./lib/stripe";
import { crewPlan } from "./schema";

export const NOT_SET_UP = "Billing is not set up on this deployment yet.";
// A seat count that Stripe did not take is tried again after 5 minutes, then 20.
const SYNC_TRIES = 3;
const SYNC_RETRY_MS = 5 * 60 * 1000;
// After the webhook changes a crew, the subscription is read from Stripe once more this much later. Two events handled
// at the same moment can finish in either order, so the older read could land last; this puts the crew right.
export const RECHECK_MS = 60 * 1000;

// A subscription (lib/stripe.ts) as an argument to the functions below. The crew is passed on its own.
const subscriptionArg = v.object({
  id: v.string(),
  customerId: v.string(),
  status: v.string(),
  itemId: v.string(),
  quantity: v.number(),
  yearly: v.boolean(),
  periodStart: v.number(),
  periodEnd: v.number(),
  renews: v.boolean(),
});

function argOf(sub: Subscription) {
  return {
    id: sub.id,
    customerId: sub.customerId,
    status: sub.status,
    itemId: sub.itemId,
    quantity: sub.quantity,
    yearly: sub.yearly,
    periodStart: sub.periodStart,
    periodEnd: sub.periodEnd,
    renews: sub.renews,
  };
}

function requireStripe(): StripeApi {
  const stripe = stripeClient();
  if (stripe === null) throw new ConvexError(NOT_SET_UP);
  return stripe;
}

// Stripe's own errors are plain Errors, which production hides from the app ("Server Error"). The leader reads Stripe's
// reason instead (a wrong price id, a key without the right permission): what Mr. Tom needs while setting billing up.
async function fromStripe<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (e) {
    if (e instanceof ConvexError) throw e;
    throw new ConvexError(`Stripe said: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// The crew the signed-in leader pays for, for checkout and the portal. Throws for anyone who does not lead a crew.
export const leaderCrew = internalQuery({
  args: { supersetUserId: v.string() },
  returns: v.object({
    crewId: v.id("crews"),
    plan: crewPlan,
    members: v.number(),
    stripeCustomerId: v.optional(v.string()),
    subscriptionStatus: v.optional(v.string()),
  }),
  handler: async function (ctx, args) {
    const me = await hackerFor(ctx, args.supersetUserId);
    if (me === null) throw new ConvexError("No hacker for this sign-in. Pick a handle first.");
    const crew = await requireLeader(ctx, me);
    return {
      crewId: crew._id,
      plan: crew.plan,
      members: (await memberIdsOf(ctx, crew._id)).length,
      stripeCustomerId: crew.stripeCustomerId,
      subscriptionStatus: crew.subscriptionStatus,
    };
  },
});

// The leader's Upgrade button: a Stripe Checkout link for the team plan, $10 a member a month or $100 a member a year,
// for as many members as the crew has now. A crew that already pays gets a billing portal link instead, so nobody pays twice.
export const checkout = action({
  args: { yearly: v.boolean() },
  returns: v.string(),
  handler: async function (ctx, args): Promise<string> {
    const identity = await requireIdentity(ctx);
    const crew = await ctx.runQuery(internal.billing.leaderCrew, { supersetUserId: identity.subject });
    const stripe = requireStripe();
    const site = siteUrl(env.SITE_URL);
    if (crew.stripeCustomerId !== undefined && isOpen(crew.subscriptionStatus)) {
      return (await fromStripe(stripe.createPortalSession({ customer: crew.stripeCustomerId, returnUrl: site }))).url;
    }
    if (crew.plan === "team") throw new ConvexError("The crew is on the team plan already.");
    const price = ((args.yearly ? env.STRIPE_PRICE_YEARLY : env.STRIPE_PRICE_MONTHLY) ?? "").trim();
    if (price === "") throw new ConvexError(NOT_SET_UP);
    const session = await fromStripe(
      stripe.createCheckoutSession({
        price,
        quantity: crew.members,
        crewId: crew.crewId,
        customer: crew.stripeCustomerId,
        customerEmail: crew.stripeCustomerId === undefined ? identity.email : undefined,
        successUrl: checkoutReturn(site, "done"),
        cancelUrl: checkoutReturn(site, "cancelled"),
      }),
    );
    return session.url;
  },
});

// The leader's Manage billing button: a Stripe billing portal link (card, invoices, monthly or yearly, cancel).
export const portal = action({
  args: {},
  returns: v.string(),
  handler: async function (ctx): Promise<string> {
    const identity = await requireIdentity(ctx);
    const crew = await ctx.runQuery(internal.billing.leaderCrew, { supersetUserId: identity.subject });
    if (crew.stripeCustomerId === undefined) throw new ConvexError("The crew has no billing yet. Upgrade first.");
    const stripe = requireStripe();
    return (await fromStripe(stripe.createPortalSession({ customer: crew.stripeCustomerId, returnUrl: siteUrl(env.SITE_URL) }))).url;
  },
});

const statusView = v.object({ plan: crewPlan, planUntil: v.optional(v.number()), subscription: v.union(v.null(), subscriptionView) });

// The caller's crew's plan and subscription, for every member. A hacker in no crew is on the free plan.
export const status = query({
  args: {},
  returns: statusView,
  handler: async function (ctx): Promise<Infer<typeof statusView>> {
    const me = await checkHacker(ctx);
    const crew = me === null ? null : await crewOf(ctx, me._id);
    if (crew === null) return { plan: "free", subscription: null };
    return { plan: crew.plan, planUntil: crew.planUntil, subscription: subscriptionOf(crew) };
  },
});

// The crew a Stripe object is about: the crew id checkout wrote into it, else the crew that has this subscription. Null
// for anything else (another product on the same Stripe account, a crew that is gone).
export const crewFor = internalQuery({
  args: { crewRef: v.optional(v.string()), subscriptionId: v.optional(v.string()) },
  returns: v.union(v.null(), v.id("crews")),
  handler: async function (ctx, args) {
    if (args.crewRef !== undefined) {
      const crewId = ctx.db.normalizeId("crews", args.crewRef);
      if (crewId !== null && (await ctx.db.get("crews", crewId)) !== null) return crewId;
    }
    const subscriptionId = args.subscriptionId;
    if (subscriptionId === undefined) return null;
    const crew = await ctx.db
      .query("crews")
      .withIndex("by_stripeSubscriptionId", function (q) {
        return q.eq("stripeSubscriptionId", subscriptionId);
      })
      .first();
    return crew?._id ?? null;
  },
});

// Writes what a subscription, as Stripe has it now, means for a crew (lib/billing.ts afterSubscription). The same
// subscription twice changes nothing the second time. Then, when it bills for another number of people than the crew
// has (someone joined while Checkout was open, a quantity changed in Stripe), the seat count is set again. `recheck`
// (the webhook) reads the subscription from Stripe once more a minute after a change.
export const applySubscription = internalMutation({
  args: { crewId: v.id("crews"), subscription: subscriptionArg, fromCheckout: v.boolean(), recheck: v.optional(v.boolean()) },
  returns: v.object({ changed: v.boolean(), note: v.string() }),
  handler: async function (ctx, args) {
    const crew = await ctx.db.get("crews", args.crewId);
    if (crew === null) return { changed: false, note: "no such crew" };
    const sub = args.subscription;
    const outcome = afterSubscription(crew, sub, args.fromCheckout);
    if (outcome.kind === "ignore") return { changed: false, note: outcome.why };
    if (outcome.replaces !== undefined) {
      console.warn(`Crew ${crew._id} paid twice: it now follows ${sub.id}. Cancel ${outcome.replaces} in the Stripe Dashboard; until then the crew falls back to it if ${sub.id} ends first.`);
    }
    const changed = !sameBilling(crew, outcome.billing);
    if (changed) await ctx.db.patch("crews", crew._id, outcome.billing);
    if (outcome.fallback !== undefined) {
      await ctx.scheduler.runAfter(0, internal.billing.refresh, { crewId: crew._id, subscriptionId: outcome.fallback });
    }
    if (changed && args.recheck === true) await ctx.scheduler.runAfter(RECHECK_MS, internal.billing.refresh, { crewId: crew._id });
    if (outcome.billing.stripeSubscriptionId === sub.id && isOpen(sub.status)) {
      const members = (await memberIdsOf(ctx, crew._id)).length;
      if (members > 0 && members !== sub.quantity) await ctx.scheduler.runAfter(0, internal.billing.syncQuantity, { crewId: crew._id });
    }
    return { changed, note: changed ? `${outcome.billing.plan} plan, ${sub.status}` : "no change" };
  },
});

// Reads the crew's subscription (or the one named) from Stripe again and writes it. For the recheck after the webhook,
// and for falling back to a spare subscription when the crew's own one ended. A failure only logs: it is a second look.
export const refresh = internalAction({
  args: { crewId: v.id("crews"), subscriptionId: v.optional(v.string()) },
  returns: v.null(),
  handler: async function (ctx, args) {
    const stripe = stripeClient();
    if (stripe === null) return null;
    const subscriptionId = args.subscriptionId ?? (await ctx.runQuery(internal.billing.seats, { crewId: args.crewId }))?.subscriptionId;
    if (subscriptionId === undefined) return null;
    try {
      const sub = await stripe.retrieveSubscription(subscriptionId);
      await ctx.runMutation(internal.billing.applySubscription, { crewId: args.crewId, subscription: argOf(sub), fromCheckout: false });
    } catch (e) {
      console.warn(`Crew ${args.crewId}: could not read subscription ${subscriptionId} from Stripe again.`, e);
    }
    return null;
  },
});

// What one verified event does. Subscriptions are read from Stripe again rather than from the event, because Stripe does
// not send events in order: the crew always ends up as Stripe has it now. A deleted subscription is final, so its event
// is enough on its own.
async function handleEvent(ctx: ActionCtx, stripe: StripeApi, event: StripeEvent): Promise<string> {
  let crewRef: string | undefined;
  let subscriptionId: string | undefined;
  let deleted: Subscription | null = null;
  if (event.type === "checkout.session.completed") {
    const session = readCheckoutSession(event.object);
    if (session === null || session.mode !== "subscription") return "not a subscription checkout";
    crewRef = session.crewId;
    subscriptionId = session.subscriptionId;
  } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const sub = readSubscription(event.object);
    if (sub === null) return "not a subscription soopdoop can read";
    crewRef = sub.crewId;
    subscriptionId = sub.id;
    if (event.type === "customer.subscription.deleted") deleted = sub;
  } else {
    return "not an event billing uses";
  }
  if (subscriptionId === undefined) return "no subscription";
  const crewId: Id<"crews"> | null = await ctx.runQuery(internal.billing.crewFor, { crewRef, subscriptionId });
  if (crewId === null) return "no crew for it";
  const sub = deleted ?? (await stripe.retrieveSubscription(subscriptionId));
  const result: { changed: boolean; note: string } = await ctx.runMutation(internal.billing.applySubscription, {
    crewId,
    subscription: argOf(sub),
    fromCheckout: event.type === "checkout.session.completed",
    recheck: true,
  });
  return result.note;
}

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// POST /stripe/webhook (http.ts): checkout.session.completed, customer.subscription.updated and .deleted, signed with
// STRIPE_WEBHOOK_SECRET. 400 for a bad signature; 200 for everything else billing reads or chooses to skip (an unknown
// crew, another kind of event); 500 when Stripe cannot be read, so Stripe sends the event again later.
export const webhook = httpAction(async function (ctx, req) {
  const secret = (env.STRIPE_WEBHOOK_SECRET ?? "").trim();
  const stripe = stripeClient();
  if (secret === "" || stripe === null) return reply(500, { error: NOT_SET_UP });
  const body = await req.text();
  let event: StripeEvent;
  try {
    event = await stripe.constructEvent(body, req.headers.get("stripe-signature") ?? "", secret);
  } catch {
    return reply(400, { error: "The Stripe-Signature header does not match this endpoint's signing secret." });
  }
  try {
    const note = await handleEvent(ctx, stripe, event);
    console.log(`Stripe ${event.type} ${event.id}: ${note}`);
    return reply(200, { ok: true, note });
  } catch (e) {
    console.error(`Stripe ${event.type} ${event.id} failed:`, e);
    return reply(500, { error: "soopdoop could not read the subscription from Stripe. Stripe will send this event again." });
  }
});

// The crew's subscription and how many people are in the crew now, for the seat count.
export const seats = internalQuery({
  args: { crewId: v.id("crews") },
  returns: v.union(v.null(), v.object({ subscriptionId: v.string(), members: v.number() })),
  handler: async function (ctx, args) {
    const crew = await ctx.db.get("crews", args.crewId);
    if (crew === null || crew.stripeSubscriptionId === undefined) return null;
    return { subscriptionId: crew.stripeSubscriptionId, members: (await memberIdsOf(ctx, crew._id)).length };
  },
});

// The seat count Stripe now bills, on the crew's row. Only the count, and only while the crew still has that
// subscription: everything else comes from the webhook, which reads the whole subscription fresh.
export const setQuantity = internalMutation({
  args: { crewId: v.id("crews"), subscriptionId: v.string(), quantity: v.number() },
  returns: v.null(),
  handler: async function (ctx, args) {
    const crew = await ctx.db.get("crews", args.crewId);
    if (crew === null || crew.stripeSubscriptionId !== args.subscriptionId || crew.subscriptionQuantity === args.quantity) return null;
    await ctx.db.patch("crews", crew._id, { subscriptionQuantity: args.quantity });
    return null;
  },
});

// Someone joined or left a crew that pays, or the subscription bills for another number of people than the crew has:
// the subscription's quantity is set to the member count (Stripe prorates the difference). Tried 3 times. If the count
// moved again while Stripe was being updated, it runs once more.
export const syncQuantity = internalAction({
  args: { crewId: v.id("crews"), attempt: v.optional(v.number()) },
  returns: v.null(),
  handler: async function (ctx, args) {
    const seats = await ctx.runQuery(internal.billing.seats, { crewId: args.crewId });
    if (seats === null) return null;
    const stripe = stripeClient();
    if (stripe === null) {
      console.warn(`Crew ${args.crewId} changed members, but ${NOT_SET_UP}`);
      return null;
    }
    if (seats.members < 1) {
      console.warn(`Crew ${args.crewId} has nobody in it and still has subscription ${seats.subscriptionId}. Cancel it in the Stripe Dashboard.`);
      return null;
    }
    const attempt = args.attempt ?? 0;
    try {
      const sub = await stripe.retrieveSubscription(seats.subscriptionId);
      if (!isOpen(sub.status)) return null;
      if (sub.quantity !== seats.members) await stripe.updateQuantity(sub.itemId, seats.members);
      await ctx.runMutation(internal.billing.setQuantity, { crewId: args.crewId, subscriptionId: sub.id, quantity: seats.members });
      const now = await ctx.runQuery(internal.billing.seats, { crewId: args.crewId });
      if (now !== null && now.subscriptionId === sub.id && now.members > 0 && now.members !== seats.members) {
        await ctx.scheduler.runAfter(0, internal.billing.syncQuantity, { crewId: args.crewId });
      }
    } catch (e) {
      if (attempt + 1 >= SYNC_TRIES) throw e;
      console.warn(`Crew ${args.crewId}: Stripe did not take the seat count (try ${attempt + 1}); trying again.`, e);
      await ctx.scheduler.runAfter(SYNC_RETRY_MS * 4 ** attempt, internal.billing.syncQuantity, { crewId: args.crewId, attempt: attempt + 1 });
    }
    return null;
  },
});

// Daily: a crew whose paid period ended more than 3 days ago, and whose subscription is not paid up, goes back to the free
// plan. Its data stays; the free plan's limits apply from now on. Paying brings the team plan back (the webhook).
export const expire = internalMutation({
  args: {},
  returns: v.number(),
  handler: async function (ctx) {
    const cutoff = Date.now() - GRACE_MS;
    const lapsed = await ctx.db
      .query("crews")
      .withIndex("by_planUntil", function (q) {
        return q.gt("planUntil", 0).lt("planUntil", cutoff);
      })
      .collect();
    let moved = 0;
    for (const crew of lapsed) {
      if (crew.plan !== "team" || isPaid(crew.subscriptionStatus)) continue;
      await ctx.db.patch("crews", crew._id, { plan: "free", planUntil: undefined });
      moved += 1;
    }
    return moved;
  },
});
