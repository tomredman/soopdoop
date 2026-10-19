// ABOUTME: The Slack bridge: posts to the crew's incoming webhook (the digest, the test line, and the live mirror of ships,
// ABOUTME: props and saves) and records whether Slack took it. The webhook never leaves the backend, not even in an error.
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { crewOf } from "./lib/crew";
import { customerProps, shortName } from "./lib/digest";
import { limitsFor } from "./lib/plan";
import { supersetCard } from "./superset";

// Slack reads &, < and > as markup; written as entities they show as themselves.
export function slackEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// What the mirror posts for one wire line, or null for a kind it does not mirror.
export function mirrorText(e: { kind: string; who: string; other?: string; text?: string; url?: string; fromCustomer?: boolean; aboutText?: string }): string | null {
  if (e.kind === "ship") return `${e.who} shipped${e.text === undefined ? "" : `: ${e.text}`}${e.url === undefined ? "" : ` ${e.url}`}`;
  if (e.kind === "save") return `${e.who} may have just saved a customer${e.text === undefined ? "" : `: ${e.text}`}`;
  if (e.kind !== "props") return null;
  if (e.fromCustomer === true) {
    const { toCrew, words } = customerProps(e.text);
    return `${toCrew ? "The crew" : e.who} got props from a customer${words === undefined ? "" : `: ${words}`}`;
  }
  return `${e.who} gave ${e.other ?? "a crewmate"} props${e.aboutText === undefined ? "" : ` for: ${e.aboutText}`}`;
}

// Posts one message. Slack's own error words come back ("invalid_token", "no_service"); never the webhook itself.
async function send(webhook: string, text: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: slackEscape(text) }),
    });
    if (res.ok) return { ok: true };
    const said = (await res.text().catch(function () { return ""; })).split(webhook).join("the webhook").trim().slice(0, 120);
    return { ok: false, error: `Slack answered ${res.status}${said === "" ? "" : `: ${said}`}` };
  } catch {
    return { ok: false, error: "Slack could not be reached." };
  }
}

async function nameOf(ctx: QueryCtx, id: Id<"hackers">, handle: string): Promise<string> {
  return shortName({ handle, name: (await supersetCard(ctx, id))?.name });
}

// The crew's webhook, for the post action.
export const target = internalQuery({
  args: { crewId: v.id("crews") },
  returns: v.union(v.null(), v.string()),
  handler: async function (ctx, args) {
    return (await ctx.db.get("crews", args.crewId))?.slackWebhook ?? null;
  },
});

// Whether a post went through: on the crew (Settings → Crew shows it) and on the digest it carried, if any.
export const record = internalMutation({
  args: { crewId: v.id("crews"), digestId: v.optional(v.id("digests")), ok: v.boolean(), error: v.optional(v.string()) },
  returns: v.null(),
  handler: async function (ctx, args) {
    const now = Date.now();
    const crew = await ctx.db.get("crews", args.crewId);
    if (crew !== null) {
      await ctx.db.patch("crews", crew._id, args.ok ? { slackPostedAt: now, slackError: undefined } : { slackError: args.error });
    }
    const digest = args.digestId === undefined ? null : await ctx.db.get("digests", args.digestId);
    if (digest !== null) {
      await ctx.db.patch("digests", digest._id, args.ok ? { postedAt: now, postError: undefined } : { postError: args.error });
    }
    return null;
  },
});

// Posts text to the crew's channel (the digest, the weekly numbers, the test line) and records the outcome.
export const post = internalAction({
  args: { crewId: v.id("crews"), text: v.string(), digestId: v.optional(v.id("digests")) },
  returns: v.null(),
  handler: async function (ctx, args): Promise<null> {
    const webhook: string | null = await ctx.runQuery(internal.slack.target, { crewId: args.crewId });
    if (webhook === null) {
      if (args.digestId !== undefined) {
        await ctx.runMutation(internal.slack.record, { crewId: args.crewId, digestId: args.digestId, ok: false, error: "The crew has no Slack webhook." });
      }
      return null;
    }
    const result = await send(webhook, args.text);
    await ctx.runMutation(internal.slack.record, { crewId: args.crewId, digestId: args.digestId, ok: result.ok, error: result.error });
    return null;
  },
});

// One wire line as the mirror posts it, with where to: null when the line is gone, the mirror is off, the plan has no
// Slack bridge, or the line names someone who hides from the board.
export const mirrorLine = internalQuery({
  args: { feedId: v.id("feed") },
  returns: v.union(v.null(), v.object({ crewId: v.id("crews"), webhook: v.string(), text: v.string() })),
  handler: async function (ctx, args) {
    const e = await ctx.db.get("feed", args.feedId);
    if (e === null) return null;
    const crew = await crewOf(ctx, e.hackerId);
    if (crew === null || crew.slackMirror !== true || crew.slackWebhook === undefined || !limitsFor(crew).digest) return null;
    const who = await ctx.db.get("hackers", e.hackerId);
    if (who === null || who.hideFromBoards === true) return null;
    let other: string | undefined;
    if (e.otherHackerId !== undefined) {
      const o = await ctx.db.get("hackers", e.otherHackerId);
      const theirs = o === null ? null : await crewOf(ctx, o._id);
      if (o === null || o.hideFromBoards === true || theirs === null || theirs._id !== crew._id) return null;
      other = await nameOf(ctx, o._id, o.handle);
    }
    const about = e.about === undefined ? null : await ctx.db.get("feed", e.about);
    const text = mirrorText({
      kind: e.kind,
      who: await nameOf(ctx, who._id, who.handle),
      other,
      text: e.text,
      url: e.url,
      fromCustomer: e.fromCustomer,
      aboutText: about?.text,
    });
    return text === null ? null : { crewId: crew._id, webhook: crew.slackWebhook, text };
  },
});

// The live mirror: a ship, props or a save goes to the crew's channel as it happens (feed.ts addToFeed schedules it).
export const mirror = internalAction({
  args: { feedId: v.id("feed") },
  returns: v.null(),
  handler: async function (ctx, args): Promise<null> {
    const line: { crewId: Id<"crews">; webhook: string; text: string } | null = await ctx.runQuery(internal.slack.mirrorLine, { feedId: args.feedId });
    if (line === null) return null;
    const result = await send(line.webhook, line.text);
    await ctx.runMutation(internal.slack.record, { crewId: line.crewId, ok: result.ok, error: result.error });
    return null;
  },
});
