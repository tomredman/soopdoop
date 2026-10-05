// ABOUTME: HTTP routes. POST /operator/answer: the daemon a relay waits on sends its agent's own answer, once. Older daemons
// ABOUTME: send a slice of the conversation instead, which goes straight into an answer call and is never stored.
import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction } from "./_generated/server";
import { agentAnswer, answerFrom, describeError } from "./lib/claude";

// About 60k tokens: older daemons send far less; anything bigger is not from our daemon.
const MAX_CONTEXT_CHARS = 240_000;
// The daemon cuts an agent's answer at 2,000 characters.
const MAX_ANSWER_CHARS = 4_000;

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

// What the asker reads when the answering Mac's anti-hijacking fund stops a question. Null for any other refusal.
function limitNote(limit: unknown, owner: string): string | null {
  if (limit === "off") return `@${owner} has turned off answering questions.`;
  if (limit === "fund") return `@${owner}'s agents have spent today's answering fund.`;
  if (limit === "share") return `You have used your share of @${owner}'s answering fund for today.`;
  return null;
}

const http = httpRouter();

http.route({
  path: "/operator/answer",
  method: "POST",
  handler: httpAction(async function (ctx, req) {
    const body: unknown = await req.json().catch(function () { return null; });
    if (!isRecord(body) || typeof body.token !== "string" || typeof body.relayId !== "string") {
      return json(400, { error: "Expected { token, relayId, answer }, { token, relayId, context } or { token, relayId, refused }." });
    }
    const { token } = body;
    const answer = typeof body.answer === "string" ? body.answer : null;
    const context = typeof body.context === "string" ? body.context : null;
    const refused = typeof body.refused === "string" ? body.refused : null;
    if (answer === null && context === null && refused === null) return json(400, { error: "Send the answer, or why there is none." });
    if (answer !== null && answer.length > MAX_ANSWER_CHARS) return json(413, { error: "That answer is too long." });
    if (context !== null && context.length > MAX_CONTEXT_CHARS) return json(413, { error: "That context is too long." });

    let found: { relayId: Id<"relays">; question: string; owner: { handle: string; name?: string } } | null = null;
    try {
      found = await ctx.runQuery(internal.operator.relayForDaemon, { token, relayId: body.relayId });
    } catch {
      // An unknown daemon token.
      found = null;
    }
    if (found === null) return json(404, { error: "This machine has no read waiting for that relay." });
    const { relayId } = found;

    if (answer !== null) {
      const read = typeof body.tokensRead === "number" && Number.isFinite(body.tokensRead) && body.tokensRead > 0 ? Math.round(body.tokensRead) : 0;
      const result = agentAnswer(found.question, answer, found.owner, read);
      await ctx.runMutation(internal.operator.finish, {
        relayId,
        status: result.text === null ? "not-found" : "answered",
        answer: result.text ?? undefined,
        note: result.text === null ? "It has not worked on this." : undefined,
        tokensRead: result.tokensRead,
        tokensSent: result.tokensSent,
      });
      return json(200, { ok: true });
    }
    if (context === null) {
      // The daemon's anti-hijacking fund said no: nobody could answer, and the note names whose fund it was.
      const limit = limitNote(body.limit, found.owner.handle);
      await ctx.runMutation(internal.operator.finish, limit === null
        ? { relayId, status: "not-found", note: refused ?? undefined }
        : { relayId, status: "nobody", note: limit });
      return json(200, { ok: true });
    }
    try {
      const fromSlice = await answerFrom(found.question, context, found.owner);
      await ctx.runMutation(internal.operator.finish, {
        relayId,
        status: fromSlice.text === null ? "not-found" : "answered",
        answer: fromSlice.text ?? undefined,
        note: fromSlice.text === null ? (fromSlice.note ?? "The agent's conversation did not cover this.") : undefined,
        tokensRead: fromSlice.tokensRead,
        tokensSent: fromSlice.tokensSent,
      });
    } catch (e) {
      await ctx.runMutation(internal.operator.finish, { relayId, status: "error", note: describeError(e) });
    }
    return json(200, { ok: true });
  }),
});

export default http;
