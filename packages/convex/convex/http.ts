// ABOUTME: HTTP routes. POST /operator/answer: the daemon a relay waits on sends a slice of one agent's conversation, once.
// ABOUTME: The slice goes straight into the answer call and is never stored; only the short answer and two token counts are.
import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction } from "./_generated/server";
import { answerFrom, describeError } from "./lib/claude";

// About 60k tokens: the daemon sends far less; anything bigger is not from our daemon.
const MAX_CONTEXT_CHARS = 240_000;

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

const http = httpRouter();

http.route({
  path: "/operator/answer",
  method: "POST",
  handler: httpAction(async function (ctx, req) {
    const body: unknown = await req.json().catch(function () { return null; });
    if (!isRecord(body) || typeof body.token !== "string" || typeof body.relayId !== "string") {
      return json(400, { error: "Expected { token, relayId, context } or { token, relayId, refused }." });
    }
    const { token } = body;
    const context = typeof body.context === "string" ? body.context : null;
    const refused = typeof body.refused === "string" ? body.refused : null;
    if (context === null && refused === null) return json(400, { error: "Send the context, or why it cannot be read." });
    if (context !== null && context.length > MAX_CONTEXT_CHARS) return json(413, { error: "That context is too long." });

    let found: { relayId: Id<"relays">; question: string } | null = null;
    try {
      found = await ctx.runQuery(internal.operator.relayForDaemon, { token, relayId: body.relayId });
    } catch {
      // An unknown daemon token.
      found = null;
    }
    if (found === null) return json(404, { error: "This machine has no read waiting for that relay." });
    const { relayId } = found;

    if (context === null) {
      await ctx.runMutation(internal.operator.finish, { relayId, status: "not-found", note: refused ?? undefined });
      return json(200, { ok: true });
    }
    try {
      const answer = await answerFrom(found.question, context);
      await ctx.runMutation(internal.operator.finish, {
        relayId,
        status: answer.text === null ? "not-found" : "answered",
        answer: answer.text ?? undefined,
        note: answer.text === null ? (answer.note ?? "The agent's conversation did not cover this.") : undefined,
        tokensRead: answer.tokensRead,
        tokensSent: answer.tokensSent,
      });
    } catch (e) {
      await ctx.runMutation(internal.operator.finish, { relayId, status: "error", note: describeError(e) });
    }
    return json(200, { ok: true });
  }),
});

export default http;
