// ABOUTME: Props from customers through Intercom's conversation.rating.added webhook, signed with the crew's Intercom client
// ABOUTME: secret. A rating of 4 or 5 goes on the wire for whoever's ledger line names the conversation, else for the whole crew.
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { httpAction, internalMutation, internalQuery } from "./_generated/server";
import { addToFeed } from "./feed";
import { memberIdsOf } from "./lib/crew";
import { CREW_CUSTOMER_PROPS, CUSTOMER_PROPS } from "./lib/digest";
import { DAY_MS } from "./lib/localTime";
import { limitsFor } from "./lib/plan";
import { redactSecrets } from "./lib/summaries";

// Intercom's ratings run 1 to 5; 4 and 5 are thanks.
export const GOOD_RATING = 4;
// How much of the customer's remark goes on the wire.
const REMARK_CHARS = 120;
// How far back a ledger line can name the conversation.
const LOOKBACK_MS = 30 * DAY_MS;
// Intercom sends a notification again when it is not sure the first one arrived; one within this long is the same.
const REPEAT_MS = 10 * 60 * 1000;

function bytesOfHex(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Whether `signature` (Intercom's X-Hub-Signature header, "sha1=<hex>") is the HMAC-SHA1 of the raw body with the crew's
// client secret. Web Crypto's verify compares in constant time.
export async function checkSignature(body: string, signature: string | null, secret: string): Promise<boolean> {
  const hex = /^sha1=([0-9a-fA-F]{40})$/.exec((signature ?? "").trim())?.[1];
  if (hex === undefined) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["verify"]);
  return await crypto.subtle.verify("HMAC", key, bytesOfHex(hex), encoder.encode(body));
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// The rating in an Intercom notification: the conversation's id, the stars and the customer's remark. Null for any other
// topic (Intercom also sends "ping" when the webhook is set up).
export function ratingOf(payload: unknown): { conversationId: string; rating: number; remark?: string } | null {
  if (!isRecord(payload) || payload.topic !== "conversation.rating.added") return null;
  const data = payload.data;
  const item = isRecord(data) ? data.item : undefined;
  if (!isRecord(item)) return null;
  const id = typeof item.id === "string" || typeof item.id === "number" ? String(item.id) : "";
  const rating = item.conversation_rating;
  if (id === "" || !isRecord(rating) || typeof rating.rating !== "number") return null;
  const remark = typeof rating.remark === "string" && rating.remark.trim() !== "" ? rating.remark : undefined;
  return { conversationId: id, rating: rating.rating, remark };
}

// Whether `text` names the conversation id as a whole word: "fixed #4521 export" names 4521; "45210" does not.
export function namesConversation(text: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}($|[^A-Za-z0-9])`).test(text);
}

// What the customer said, fit for the wire: no keys, no email addresses, at most 120 characters.
export function cleanRemark(remark: string | undefined): string | undefined {
  if (remark === undefined) return undefined;
  const clean = redactSecrets(remark.replace(/\s+/g, " ").trim()).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]");
  if (clean === "") return undefined;
  return clean.length <= REMARK_CHARS ? clean : `${clean.slice(0, REMARK_CHARS - 1).trimEnd()}…`;
}

// For the webhook: the crew named in the URL and its client secret. Null for an unknown crew.
export const secretFor = internalQuery({
  args: { crew: v.string() },
  returns: v.union(v.null(), v.object({ crewId: v.id("crews"), secret: v.optional(v.string()) })),
  handler: async function (ctx, args) {
    const crewId = ctx.db.normalizeId("crews", args.crew);
    const crew = crewId === null ? null : await ctx.db.get("crews", crewId);
    if (crew === null) return null;
    return { crewId: crew._id, secret: crew.intercomSecret };
  },
});

// A good rating: props from a customer for the crew member whose ledger line (its "did" or its PR) names the
// conversation in the last 30 days, or for the whole crew (on the leader's line) when none does. Team plan.
export const rated = internalMutation({
  args: { crewId: v.id("crews"), conversationId: v.string(), rating: v.number(), remark: v.optional(v.string()) },
  returns: v.union(v.null(), v.object({ handle: v.string(), matched: v.boolean() })),
  handler: async function (ctx, args) {
    const crew = await ctx.db.get("crews", args.crewId);
    if (crew === null || !limitsFor(crew).scout || args.rating < GOOD_RATING) return null;
    const now = Date.now();
    let best: Doc<"ledger"> | null = null;
    for (const id of await memberIdsOf(ctx, crew._id)) {
      const lines = await ctx.db
        .query("ledger")
        .withIndex("by_hacker_at", function (q) {
          return q.eq("hackerId", id).gte("at", now - LOOKBACK_MS);
        })
        .collect();
      for (const line of lines) {
        const names = namesConversation(line.did, args.conversationId) || namesConversation(line.pr ?? "", args.conversationId);
        if (names && (best === null || line.at > best.at)) best = line;
      }
    }
    const remark = cleanRemark(args.remark);
    const lead = best === null ? CREW_CUSTOMER_PROPS : CUSTOMER_PROPS;
    const text = remark === undefined ? lead : `${lead}: ${remark}`;
    const hackerId: Id<"hackers"> = best?.hackerId ?? crew.leaderId;
    const recent = await ctx.db
      .query("feed")
      .withIndex("by_hacker_at", function (q) {
        return q.eq("hackerId", hackerId).gt("at", now - REPEAT_MS);
      })
      .collect();
    const again = recent.some(function (e) { return e.kind === "props" && e.fromCustomer === true && e.text === text; });
    if (!again) await addToFeed(ctx, { kind: "props", hackerId, fromCustomer: true, text, ledgerId: best?._id, at: now });
    const who = await ctx.db.get("hackers", hackerId);
    return { handle: who?.handle ?? "", matched: best !== null };
  },
});

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// POST /intercom/webhook?crew=<crewId> (http.ts). 404 for an unknown crew, 401 for a missing or wrong signature, and 200
// for everything else, so Intercom does not retry what soopdoop chose to ignore.
export const webhook = httpAction(async function (ctx, req) {
  const body = await req.text();
  const found = await ctx.runQuery(internal.intercom.secretFor, { crew: new URL(req.url).searchParams.get("crew") ?? "" });
  if (found === null) return reply(404, { error: "No such crew." });
  if (found.secret === undefined || !(await checkSignature(body, req.headers.get("x-hub-signature"), found.secret))) {
    return reply(401, { error: "The signature does not match this crew's Intercom secret." });
  }
  let payload: unknown = null;
  try {
    payload = JSON.parse(body);
  } catch {
    payload = null;
  }
  const rating = ratingOf(payload);
  if (rating !== null && rating.rating >= GOOD_RATING) {
    await ctx.runMutation(internal.intercom.rated, { crewId: found.crewId, ...rating });
  }
  return reply(200, { ok: true });
});
