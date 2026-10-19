// ABOUTME: Billing's rules, apart from Stripe and the database: which subscription statuses mean the team plan, what a
// ABOUTME: subscription from Stripe does to a crew's row, the subscription as the app shows it, and Checkout's return links.
import { ConvexError, type Infer, v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { DAY_MS } from "./localTime";
import type { Subscription } from "./stripe";

export const DEFAULT_SITE_URL = "https://soopdoop.com";
// A crew whose renewal is not paid keeps the team plan this long after the end of its last paid period.
export const GRACE_MS = 3 * DAY_MS;

// Paid up: the crew is on the team plan.
export function isPaid(status: string | undefined): boolean {
  return status === "active" || status === "trialing";
}

// Stripe still has it on the books (paid, or waiting for a payment it keeps asking for): the leader fixes or changes it
// in the billing portal, and never buys a second one.
export function isOpen(status: string | undefined): boolean {
  return isPaid(status) || status === "past_due" || status === "unpaid" || status === "paused";
}

// Over for good: canceled, or the first payment never went through in Stripe's 23 hours.
export function hasEnded(status: string | undefined): boolean {
  return status === "canceled" || status === "incomplete_expired";
}

// The billing part of a crew's row.
export type CrewBilling = Pick<
  Doc<"crews">,
  | "plan"
  | "planUntil"
  | "stripeCustomerId"
  | "stripeSubscriptionId"
  | "subscriptionStatus"
  | "subscriptionQuantity"
  | "subscriptionYearly"
  | "subscriptionUntil"
  | "subscriptionRenews"
  | "endedSubscriptions"
  | "spareSubscriptionId"
>;

const SINGLE_FIELDS: (keyof Omit<CrewBilling, "endedSubscriptions">)[] = [
  "plan",
  "planUntil",
  "stripeCustomerId",
  "stripeSubscriptionId",
  "subscriptionStatus",
  "subscriptionQuantity",
  "subscriptionYearly",
  "subscriptionUntil",
  "subscriptionRenews",
  "spareSubscriptionId",
];
// How many ended subscriptions a crew remembers. Old news arrives within days, not years.
const ENDED_KEPT = 20;

export function sameBilling(a: CrewBilling, b: CrewBilling): boolean {
  const endedA = a.endedSubscriptions ?? [];
  const endedB = b.endedSubscriptions ?? [];
  const sameEnded = endedA.length === endedB.length && endedA.every(function (id, i) { return id === endedB[i]; });
  return sameEnded && SINGLE_FIELDS.every(function (field) { return a[field] === b[field]; });
}

export type Outcome =
  | { kind: "ignore"; why: string }
  // `replaces`: the crew's own subscription, still billing, that a new checkout took over from (the leader paid twice).
  // `fallback`: when the crew's subscription ended, a spare one that may still be paid, to read from Stripe now.
  | { kind: "set"; billing: CrewBilling; replaces?: string; fallback?: string };

// What a subscription, as Stripe has it now, does to a crew: the crew's billing fields afterwards, or why it changes
// nothing. The answer depends only on the crew and the subscription, never on which event brought it, so a replayed or
// late event sets the same thing again.
//
// - Paid (active, trialing): the team plan until the period's end.
// - past_due: the plan stays as it is; the team plan runs to the end of the last paid period (the start of the unpaid
//   one), and the daily cron moves the crew to free 3 days after that unless Stripe gets paid.
// - incomplete (the first payment is pending): the plan stays as it is.
// - unpaid, paused: free, and the subscription stays on record so paying it brings the team plan back.
// - canceled, incomplete_expired: free, and the subscription is forgotten except for its id in endedSubscriptions, so
//   older news about it changes nothing. The Stripe customer is kept for next time.
//
// A subscription that is not the crew's own changes nothing, unless it is paid and either comes from a checkout the leader
// just finished or the crew's own one is no longer on the books. When a checkout takes over from a subscription that
// still bills, that one becomes the spare: if the new one ends first, the crew falls back to it.
export function afterSubscription(crew: CrewBilling, sub: Omit<Subscription, "crewId">, fromCheckout: boolean): Outcome {
  const ended = crew.endedSubscriptions ?? [];
  if (ended.includes(sub.id) && !hasEnded(sub.status)) return { kind: "ignore", why: "it ended already; this is older news" };
  const own = crew.stripeSubscriptionId;
  let replaces: string | undefined;
  if (own !== undefined && own !== sub.id) {
    const ownOpen = isOpen(crew.subscriptionStatus);
    if (!isPaid(sub.status) || (ownOpen && !fromCheckout)) return { kind: "ignore", why: "it is not the crew's subscription" };
    if (ownOpen) replaces = own;
  } else if (own === undefined && hasEnded(sub.status)) {
    return { kind: "ignore", why: "it has ended, and the crew has no subscription to end" };
  }
  if (hasEnded(sub.status)) {
    const spare = crew.spareSubscriptionId;
    return {
      kind: "set",
      fallback: spare !== undefined && spare !== sub.id ? spare : undefined,
      billing: {
        plan: "free",
        planUntil: undefined,
        stripeCustomerId: sub.customerId,
        stripeSubscriptionId: undefined,
        subscriptionStatus: undefined,
        subscriptionQuantity: undefined,
        subscriptionYearly: undefined,
        subscriptionUntil: undefined,
        subscriptionRenews: undefined,
        endedSubscriptions: [...ended.filter(function (id) { return id !== sub.id; }), sub.id].slice(-ENDED_KEPT),
        spareSubscriptionId: undefined,
      },
    };
  }
  const keeps = sub.status === "past_due" || sub.status === "incomplete";
  const plan: CrewBilling["plan"] = isPaid(sub.status) ? "team" : keeps ? crew.plan : "free";
  let planUntil: number | undefined = crew.planUntil;
  if (plan === "free") planUntil = undefined;
  else if (isPaid(sub.status)) planUntil = sub.periodEnd;
  else if (sub.status === "past_due") planUntil = sub.periodStart;
  // The spare: the subscription this checkout took over from; else the one kept before, unless it is this one now.
  const spare = replaces ?? (crew.spareSubscriptionId === sub.id ? undefined : crew.spareSubscriptionId);
  return {
    kind: "set",
    replaces,
    billing: {
      plan,
      planUntil,
      stripeCustomerId: sub.customerId,
      stripeSubscriptionId: sub.id,
      subscriptionStatus: sub.status,
      subscriptionQuantity: sub.quantity,
      subscriptionYearly: sub.yearly,
      subscriptionUntil: sub.periodEnd,
      subscriptionRenews: sub.renews,
      endedSubscriptions: crew.endedSubscriptions,
      spareSubscriptionId: spare,
    },
  };
}

// The crew's subscription in Settings → Crew: "Team plan, 4 members, renews 12 Nov". `until` is the end of the current
// period, when it renews (or, with renews false, ends).
export const subscriptionView = v.object({
  status: v.string(),
  yearly: v.boolean(),
  quantity: v.number(),
  until: v.number(),
  renews: v.boolean(),
});

export function subscriptionOf(crew: CrewBilling): Infer<typeof subscriptionView> | null {
  if (crew.stripeSubscriptionId === undefined || crew.subscriptionStatus === undefined) return null;
  return {
    status: crew.subscriptionStatus,
    yearly: crew.subscriptionYearly === true,
    quantity: crew.subscriptionQuantity ?? 0,
    until: crew.subscriptionUntil ?? crew.planUntil ?? 0,
    renews: crew.subscriptionRenews !== false,
  };
}

// The site the leader comes back to from Checkout and the billing portal: SITE_URL, or soopdoop.com when it is unset.
export function siteUrl(configured: string | undefined): string {
  const site = (configured ?? "").trim();
  if (site === "") return DEFAULT_SITE_URL;
  try {
    new URL(site);
  } catch {
    throw new ConvexError(`SITE_URL on this deployment is not a link: ${site}`);
  }
  return site;
}

// Where Checkout sends the leader back to: the site with ?billing=done when they paid, ?billing=cancelled when they did not.
export function checkoutReturn(site: string, outcome: "done" | "cancelled"): string {
  const url = new URL(site);
  url.searchParams.set("billing", outcome);
  return url.toString();
}
