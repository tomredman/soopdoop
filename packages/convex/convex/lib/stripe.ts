// ABOUTME: The five Stripe calls billing makes (a Checkout session, a billing portal session, a subscription, a seat count, a
// ABOUTME: verified webhook event), on the stripe package's fetch client for Convex's default runtime. STRIPE_FAKE=1 swaps in a stand-in.
import { ConvexError } from "convex/values";
import Stripe from "stripe";
import { env } from "../_generated/server";

// A subscription as soopdoop reads it from Stripe.
export interface Subscription {
  id: string;
  customerId: string;
  // Stripe's status: active, trialing, past_due, unpaid, incomplete, incomplete_expired, canceled or paused.
  status: string;
  // Its one item: the team plan's price, with the crew's member count as its quantity.
  itemId: string;
  quantity: number;
  yearly: boolean;
  // The current billing period, in milliseconds.
  periodStart: number;
  periodEnd: number;
  // False once it is set to stop (the leader canceled it in the billing portal): it ends instead of renewing.
  renews: boolean;
  // The crew it pays for: checkout writes the crew's id into the subscription's metadata.
  crewId?: string;
}

// The parts of a finished Checkout session that billing reads.
export interface CheckoutSession {
  mode: string;
  crewId?: string;
  subscriptionId?: string;
  customerId?: string;
}

export interface CheckoutRequest {
  price: string;
  quantity: number;
  crewId: string;
  // The crew's Stripe customer once it has one; before that, the leader's email fills in Checkout's email field.
  customer?: string;
  customerEmail?: string;
  successUrl: string;
  cancelUrl: string;
}

// A webhook event whose signature checked out: its id, its type, and the object it is about.
export interface StripeEvent {
  id: string;
  type: string;
  object: unknown;
}

export interface StripeApi {
  createCheckoutSession(request: CheckoutRequest): Promise<{ id: string; url: string }>;
  createPortalSession(request: { customer: string; returnUrl: string }): Promise<{ url: string }>;
  retrieveSubscription(id: string): Promise<Subscription>;
  // Sets a subscription item's quantity. Stripe prorates it by default.
  updateQuantity(itemId: string, quantity: number): Promise<void>;
  // Throws unless `signature` (the Stripe-Signature header) signs `body` with `secret`, and was made in the last 5 minutes.
  constructEvent(body: string, signature: string, secret: string): Promise<StripeEvent>;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// An id that Stripe sends as a string, or as the whole object when it was expanded.
function idOf(x: unknown): string | undefined {
  if (typeof x === "string" && x !== "") return x;
  if (isRecord(x) && typeof x.id === "string" && x.id !== "") return x.id;
  return undefined;
}

function numberOf(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}

function crewIdIn(metadata: unknown): string | undefined {
  if (!isRecord(metadata)) return undefined;
  const id = metadata.crewId;
  return typeof id === "string" && id !== "" ? id : undefined;
}

// A subscription from Stripe's JSON: an API reply, or a webhook event's object. Since API version 2025-03-31 the billing
// period is on each item; older versions had it on the subscription, so both places are read. Null for anything else.
export function readSubscription(raw: unknown): Subscription | null {
  if (!isRecord(raw) || raw.object !== "subscription") return null;
  const id = idOf(raw.id);
  const customerId = idOf(raw.customer);
  const status = typeof raw.status === "string" ? raw.status : undefined;
  const items = isRecord(raw.items) && Array.isArray(raw.items.data) ? raw.items.data : [];
  const item: unknown = items[0];
  if (id === undefined || customerId === undefined || status === undefined || !isRecord(item)) return null;
  const itemId = idOf(item.id);
  const periodStart = numberOf(item.current_period_start) ?? numberOf(raw.current_period_start);
  const periodEnd = numberOf(item.current_period_end) ?? numberOf(raw.current_period_end);
  if (itemId === undefined || periodStart === undefined || periodEnd === undefined) return null;
  // The price says how often it bills; older payloads also carry the same thing as `plan`.
  const price = isRecord(item.price) ? item.price : undefined;
  const recurring = price !== undefined && isRecord(price.recurring) ? price.recurring : undefined;
  const plan = isRecord(item.plan) ? item.plan : undefined;
  const interval = recurring?.interval ?? plan?.interval;
  const cancelAt = raw.cancel_at;
  return {
    id,
    customerId,
    status,
    itemId,
    quantity: numberOf(item.quantity) ?? 1,
    yearly: interval === "year",
    periodStart: periodStart * 1000,
    periodEnd: periodEnd * 1000,
    renews: raw.cancel_at_period_end !== true && (cancelAt === null || cancelAt === undefined),
    crewId: crewIdIn(raw.metadata),
  };
}

// A Checkout session from a webhook event's object. Null for anything else.
export function readCheckoutSession(raw: unknown): CheckoutSession | null {
  if (!isRecord(raw) || raw.object !== "checkout.session") return null;
  const ref = typeof raw.client_reference_id === "string" && raw.client_reference_id !== "" ? raw.client_reference_id : undefined;
  return {
    mode: typeof raw.mode === "string" ? raw.mode : "",
    crewId: ref ?? crewIdIn(raw.metadata),
    subscriptionId: idOf(raw.subscription),
    customerId: idOf(raw.customer),
  };
}

// Checks the signature with Web Crypto (no Node crypto in Convex's default runtime) and the library's 5-minute tolerance.
async function verifyEvent(body: string, signature: string, secret: string): Promise<StripeEvent> {
  const event = await Stripe.webhooks.constructEventAsync(body, signature, secret, undefined, Stripe.createSubtleCryptoProvider());
  return { id: event.id, type: event.type, object: event.data.object };
}

// Real Stripe. `connection` is for tests, which point it at a local server instead of api.stripe.com.
export function realStripe(secretKey: string, connection?: { host: string; port: number; protocol: "http" | "https" }): StripeApi {
  // The fetch client is what the package's worker build uses anyway; naming it keeps Node's http out of the picture.
  const stripe = new Stripe(secretKey, { httpClient: Stripe.createFetchHttpClient(), ...connection });
  return {
    async createCheckoutSession(request) {
      const params: Stripe.Checkout.SessionCreateParams = {
        mode: "subscription",
        line_items: [{ price: request.price, quantity: request.quantity }],
        client_reference_id: request.crewId,
        metadata: { crewId: request.crewId },
        // The subscription carries the crew's id too, so its own events find the crew.
        subscription_data: { metadata: { crewId: request.crewId } },
        success_url: request.successUrl,
        cancel_url: request.cancelUrl,
        // The page as Checkout Studio set it on 19 Oct 2026 (STRIPE_INTEGRATION_TODO.md): the hosted page for the web, a
        // billing address when the payment method needs one, no phone number, no promotion codes, always a card for the
        // subscription. Automatic tax stays off until the head office address is in Stripe (docs/billing.md, step 6);
        // then `enabled: true` puts the tax for the leader's address on top of the price wherever soopdoop is registered.
        ui_mode: "hosted_page",
        origin_context: "web",
        integration_identifier: "hosted_web_0001",
        billing_address_collection: "auto",
        phone_number_collection: { enabled: false },
        automatic_tax: { enabled: false },
        allow_promotion_codes: false,
        payment_method_collection: "always",
        submit_type: "auto",
        // A business gives its VAT or GST number: for its invoices, and for a reverse charge once automatic tax is on.
        tax_id_collection: { enabled: true },
      };
      if (request.customer !== undefined) {
        params.customer = request.customer;
        // The name and address typed in Checkout go onto the existing customer, so the tax and the invoices use them.
        params.customer_update = { address: "auto", name: "auto" };
      } else if (request.customerEmail !== undefined) {
        params.customer_email = request.customerEmail;
      }
      const session = await stripe.checkout.sessions.create(params);
      if (session.url === null) throw new ConvexError("Stripe made a Checkout session without a link.");
      return { id: session.id, url: session.url };
    },
    async createPortalSession(request) {
      const session = await stripe.billingPortal.sessions.create({ customer: request.customer, return_url: request.returnUrl });
      return { url: session.url };
    },
    async retrieveSubscription(id) {
      const subscription = readSubscription(await stripe.subscriptions.retrieve(id));
      if (subscription === null) throw new ConvexError(`Stripe sent subscription ${id} in a shape soopdoop cannot read.`);
      return subscription;
    },
    async updateQuantity(itemId, quantity) {
      await stripe.subscriptionItems.update(itemId, { quantity });
    },
    constructEvent: verifyEvent,
  };
}

// What the stand-in was asked to do, in order.
export type FakeCall =
  | { call: "checkout"; request: CheckoutRequest }
  | { call: "portal"; customer: string; returnUrl: string }
  | { call: "retrieve"; id: string }
  | { call: "updateQuantity"; itemId: string; quantity: number };

// The stand-in's memory, for tests: every call, the subscriptions it knows (tests add them, as if a leader had paid), and
// whether Stripe is down. Webhook signatures are checked for real, the same way as with real Stripe.
export const fakeStripe: { calls: FakeCall[]; subscriptions: Map<string, Subscription>; down: boolean } = {
  calls: [],
  subscriptions: new Map(),
  down: false,
};

export function resetFakeStripe(): void {
  fakeStripe.calls.length = 0;
  fakeStripe.subscriptions.clear();
  fakeStripe.down = false;
}

// Down, the stand-in throws the stripe package's own connection error, as real Stripe does: not a ConvexError.
function fakeUp(): void {
  if (fakeStripe.down) {
    throw new Stripe.errors.StripeConnectionError({ message: "An error occurred with our connection to Stripe (the stand-in is set to down)." });
  }
}

const fake: StripeApi = {
  async createCheckoutSession(request) {
    fakeUp();
    fakeStripe.calls.push({ call: "checkout", request });
    const id = `cs_fake_${fakeStripe.calls.length}`;
    return { id, url: `https://stripe.test/checkout/${id}` };
  },
  async createPortalSession(request) {
    fakeUp();
    fakeStripe.calls.push({ call: "portal", customer: request.customer, returnUrl: request.returnUrl });
    return { url: `https://stripe.test/portal/bps_fake_${fakeStripe.calls.length}` };
  },
  async retrieveSubscription(id) {
    fakeUp();
    fakeStripe.calls.push({ call: "retrieve", id });
    const subscription = fakeStripe.subscriptions.get(id);
    if (subscription === undefined) throw new ConvexError(`No such subscription: '${id}'`);
    return { ...subscription };
  },
  async updateQuantity(itemId, quantity) {
    fakeUp();
    fakeStripe.calls.push({ call: "updateQuantity", itemId, quantity });
    for (const [id, subscription] of fakeStripe.subscriptions) {
      if (subscription.itemId === itemId) {
        fakeStripe.subscriptions.set(id, { ...subscription, quantity });
        return;
      }
    }
    throw new ConvexError(`No such subscription item: '${itemId}'`);
  },
  constructEvent: verifyEvent,
};

// Stripe for this deployment: the stand-in when STRIPE_FAKE=1, the real one when STRIPE_SECRET_KEY is set, else null.
export function stripeClient(): StripeApi | null {
  if (env.STRIPE_FAKE === "1") return fake;
  const key = (env.STRIPE_SECRET_KEY ?? "").trim();
  return key === "" ? null : realStripe(key);
}
