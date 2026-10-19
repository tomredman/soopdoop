import { afterEach, describe, expect, jest, test } from "bun:test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { OFFER_MS, pickAgent } from "./handoffs";
import { XP } from "./play";
import { type Actor, befriend, hackerNamed, harness, type Harness, must, settleScheduled } from "./testing.helpers";

afterEach(async function () {
  await settleScheduled();
});

function agent(agentId: string, name: string, open = true) {
  return { agentId, harness: "claude-code", name, workspace: "vibes", status: "idle" as const, open, lastTurnAt: Date.now() };
}

async function machine(t: Harness, as: Actor, name: string, agents: ReturnType<typeof agent>[]): Promise<string> {
  const token = await as.mutation(api.subsets.pairDaemon, { machineName: name });
  await t.mutation(api.subsets.report, { token, agents });
  return token;
}

async function idOf(t: Harness, handle: string): Promise<Id<"hackers">> {
  const row = await t.run(async function (ctx) {
    return await ctx.db.query("hackers").withIndex("by_handle", function (q) { return q.eq("handle", handle); }).unique();
  });
  return must(row)._id;
}

async function handoff(t: Harness, id: Id<"handoffs">) {
  return must(await t.run(async function (ctx) { return await ctx.db.get("handoffs", id); }));
}

// Tom and Jimmy are crewmates. Jimmy's Mac runs an agent on email metrics, one on the quote page and a private one.
async function crew(t: Harness) {
  const tom = await hackerNamed(t, "tom");
  const jimmy = await hackerNamed(t, "jimmy");
  await befriend(tom, jimmy, "jimmy");
  const tomToken = await machine(t, tom, "mbp16", [agent("t1", "rail"), agent("t2", "secret-stuff", false)]);
  const jimmyToken = await machine(t, jimmy, "jm", [agent("a1", "email-metrics"), agent("a2", "taxes", false), agent("a3", "quote-page")]);
  await t.mutation(api.routing.update, { token: jimmyToken, agentId: "a1", summary: "vibes@email-metrics · \"fix bounce counts in delivery metrics\" · files: packages/email/send.ts" });
  await t.mutation(api.routing.update, { token: jimmyToken, agentId: "a3", summary: "vibes@quote · \"redesign the quote page\" · files: apps/web/quote/Form.tsx" });
  return { tom, jimmy, tomToken, jimmyToken };
}

const TASK = "Fix the double-counted bounces in delivery metrics (VIB-123)";

describe("hand-offs", function () {
  test("an offer goes to the receiver's open agent that fits the task, waits a day, and both of them see it", async function () {
    const t = harness();
    const { tom, jimmy } = await crew(t);
    const before = Date.now();
    const id = await tom.mutation(api.handoffs.offer, { toHandle: "@Jimmy", text: `  ${TASK}  `, why: "your agent knows the metrics", via: "hud" });
    const { incoming } = await jimmy.query(api.handoffs.mine, {});
    expect(incoming).toMatchObject([{
      _id: id, fromHandle: "tom", text: TASK, why: "your agent knows the metrics", status: "offered",
      targetAgentId: "a1", targetAgentName: "email-metrics", targetMachine: "jm", via: "hud",
    }]);
    expect(must(incoming[0]).expiresAt - must(incoming[0]).createdAt).toBe(OFFER_MS);
    // The sender sees the agent's name only when Jimmy shares agent names.
    expect((await tom.query(api.handoffs.mine, {})).outgoing).toMatchObject([{ _id: id, toHandle: "jimmy", text: TASK, status: "offered" }]);
    expect((await tom.query(api.handoffs.mine, {})).outgoing[0]?.targetAgentName).toBeUndefined();
    await jimmy.mutation(api.hackers.updateSharing, { shareAgentNames: true, shareWorkspaceNames: false });
    expect((await tom.query(api.handoffs.mine, {})).outgoing[0]?.targetAgentName).toBe("email-metrics");
    // The day is ended by a scheduled function, and no knock was needed.
    const jobs = await t.run(async function (ctx) { return await ctx.db.system.query("_scheduled_functions").collect(); });
    expect(must(jobs.find(function (j) { return j.name === "handoffs:expire"; })).scheduledTime).toBeGreaterThanOrEqual(before + OFFER_MS);
    expect((await jimmy.query(api.knocks.incoming, {})).current).toBeNull();
    expect((await jimmy.query(api.handoffs.mine, {})).outgoing).toEqual([]);
  });

  test("the agent asked for is used when it is open; a private agent is never chosen", async function () {
    const t = harness();
    const { tom } = await crew(t);
    const toQuote = await tom.mutation(api.handoffs.offer, { toHandle: "jimmy", text: TASK, targetAgentId: "a3", via: "hud" });
    expect((await handoff(t, toQuote)).targetAgentId).toBe("a3");
    const toPrivate = await tom.mutation(api.handoffs.offer, { toHandle: "jimmy", text: TASK, targetAgentId: "a2", via: "hud" });
    expect((await handoff(t, toPrivate)).targetAgentId).toBe("a1");
  });

  test("with no agent of theirs that fits, it has no agent, and a knock carries the start of the task; not in focus mode", async function () {
    const t = harness();
    const { tom, jimmy } = await crew(t);
    const text = `Translate the onboarding guide into French. ${"Then check every heading. ".repeat(10)}`;
    const id = await tom.mutation(api.handoffs.offer, { toHandle: "jimmy", text, via: "menu" });
    const row = await handoff(t, id);
    expect(row.targetAgentId).toBeUndefined();
    expect(row.knockId).toBeDefined();
    const knock = (await jimmy.query(api.knocks.incoming, {})).current;
    expect(knock).toMatchObject({ fromHandle: "tom", item: { kind: "session", title: "a hand-off from @tom" }, note: text.trim().slice(0, 120) });
    // Sent for Tom, not by him: no knock XP.
    expect((await tom.query(api.play.board, {})).find(function (r) { return r.handle === "tom"; })?.xp).toBe(0);

    // Jimmy in focus mode: the offer still waits for him, but nothing knocks.
    const sam = await hackerNamed(t, "sam");
    await befriend(sam, jimmy, "jimmy");
    await jimmy.mutation(api.hackers.setFocus, { minutes: 30 });
    const quiet = await sam.mutation(api.handoffs.offer, { toHandle: "jimmy", text: "Translate the guide into Spanish", via: "hud" });
    expect((await handoff(t, quiet)).knockId).toBeUndefined();
    expect((await jimmy.query(api.handoffs.mine, {})).incoming.map(function (h) { return h._id; })).toContain(quiet);
  });

  test("consent per crewmate: ask by default, never refuses, auto accepts at once when an agent fits", async function () {
    const t = harness();
    const { tom, jimmy, jimmyToken } = await crew(t);
    expect(await jimmy.query(api.handoffs.consents, {})).toEqual([{ handle: "tom", name: undefined, mode: "ask" }]);
    await jimmy.mutation(api.handoffs.setConsent, { handle: "tom", mode: "never" });
    await expect(tom.mutation(api.handoffs.offer, { toHandle: "jimmy", text: TASK, via: "hud" })).rejects.toThrow("@jimmy has turned hand-offs from you off.");
    await jimmy.mutation(api.handoffs.setConsent, { handle: "@tom", mode: "auto" });
    expect(await jimmy.query(api.handoffs.consents, {})).toMatchObject([{ handle: "tom", mode: "auto" }]);
    const auto = await tom.mutation(api.handoffs.offer, { toHandle: "jimmy", text: TASK, via: "hud" });
    expect(await handoff(t, auto)).toMatchObject({ status: "accepted", targetAgentId: "a1" });
    expect(await t.query(api.handoffs.toRun, { token: jimmyToken })).toEqual([
      { handoffId: auto, targetAgentId: "a1", text: TASK, fromHandle: "tom", why: undefined, targetHarness: "claude-code", autoAccepted: true },
    ]);
    // Without an agent to run in, it waits for Jimmy to pick one.
    const noAgent = await tom.mutation(api.handoffs.offer, { toHandle: "jimmy", text: "Translate the onboarding guide", via: "hud" });
    expect((await handoff(t, noAgent)).status).toBe("offered");
    // Only about a crewmate.
    await hackerNamed(t, "sam");
    await expect(jimmy.mutation(api.handoffs.setConsent, { handle: "sam", mode: "auto" })).rejects.toThrow("Only for a crewmate");
    await expect(jimmy.mutation(api.handoffs.setConsent, { handle: "jimmy", mode: "auto" })).rejects.toThrow("Only for a crewmate");
  });

  test("only to a crewmate, never to yourself, and a task under 2,000 characters", async function () {
    const t = harness();
    const { tom } = await crew(t);
    await hackerNamed(t, "sam");
    await expect(tom.mutation(api.handoffs.offer, { toHandle: "sam", text: TASK, via: "hud" })).rejects.toThrow("only hand work to a crewmate");
    await expect(tom.mutation(api.handoffs.offer, { toHandle: "nobody", text: TASK, via: "hud" })).rejects.toThrow("nobody with that handle");
    await expect(tom.mutation(api.handoffs.offer, { toHandle: "tom", text: TASK, via: "hud" })).rejects.toThrow("That is you");
    await expect(tom.mutation(api.handoffs.offer, { toHandle: "jimmy", text: "   ", via: "hud" })).rejects.toThrow("Say what the task is");
    await expect(tom.mutation(api.handoffs.offer, { toHandle: "jimmy", text: "x".repeat(2_001), via: "hud" })).rejects.toThrow("under 2,000");
  });

  test("the free plan allows 5 hand-offs a day per crew, counted across the crew", async function () {
    const t = harness();
    const { tom, jimmy } = await crew(t);
    for (let i = 0; i < 3; i++) await tom.mutation(api.handoffs.offer, { toHandle: "jimmy", text: `${TASK} ${i}`, via: "hud" });
    for (let i = 0; i < 2; i++) await jimmy.mutation(api.handoffs.offer, { toHandle: "tom", text: `Review the rail ${i}`, via: "hud" });
    await expect(tom.mutation(api.handoffs.offer, { toHandle: "jimmy", text: TASK, via: "hud" })).rejects.toThrow(
      "Your crew has made today's hand-offs (5 a day on the free plan).",
    );
  });

  test("the team plan has no daily limit on hand-offs", async function () {
    const t = harness();
    const { tom } = await crew(t);
    const tomId = await idOf(t, "tom");
    const jimmyId = await idOf(t, "jimmy");
    await t.run(async function (ctx) {
      const crewId = await ctx.db.insert("crews", { name: "vibes", leaderId: tomId, plan: "team", digestHour: 9, timezone: "America/Toronto", createdAt: Date.now() });
      await ctx.db.insert("crewMembers", { crewId, hackerId: tomId, role: "leader", joinedAt: Date.now() });
      await ctx.db.insert("crewMembers", { crewId, hackerId: jimmyId, role: "member", joinedAt: Date.now() });
    });
    for (let i = 0; i < 7; i++) await tom.mutation(api.handoffs.offer, { toHandle: "jimmy", text: `${TASK} ${i}`, via: "hud" });
    expect((await tom.query(api.handoffs.mine, {})).outgoing).toHaveLength(7);
  });

  test("from an agent: the machine's token, the offering session kept, and never from a private agent", async function () {
    const t = harness();
    const { jimmy, tomToken } = await crew(t);
    const made = await t.mutation(api.handoffs.offerFromAgent, { token: tomToken, toHandle: "jimmy", text: TASK, why: "it knows the metrics", agentId: "t1" });
    expect(made).toEqual({ handoffId: made.handoffId, status: "offered", toHandle: "jimmy", targetAgentName: undefined });
    expect(await handoff(t, made.handoffId)).toMatchObject({ via: "agent", fromMachine: "mbp16", fromAgentId: "t1", targetAgentId: "a1", why: "it knows the metrics" });
    await expect(t.mutation(api.handoffs.offerFromAgent, { token: tomToken, toHandle: "jimmy", text: TASK, agentId: "t2" })).rejects.toThrow("private agent");
    await jimmy.mutation(api.hackers.updateSharing, { shareAgentNames: true, shareWorkspaceNames: false });
    expect((await t.mutation(api.handoffs.offerFromAgent, { token: tomToken, toHandle: "jimmy", text: TASK })).targetAgentName).toBe("email-metrics");
    await expect(t.mutation(api.handoffs.offerFromAgent, { token: "sd_nope", toHandle: "jimmy", text: TASK })).rejects.toThrow("Unknown daemon token");
  });

  test("the receiver accepts into one of their open agents, or declines with a note; nobody else decides", async function () {
    const t = harness();
    const { tom, jimmy, jimmyToken } = await crew(t);
    const id = await tom.mutation(api.handoffs.offer, { toHandle: "jimmy", text: TASK, via: "hud" });
    await expect(tom.mutation(api.handoffs.decide, { handoffId: id, outcome: "accept" })).rejects.toThrow("Not your hand-off");
    await expect(jimmy.mutation(api.handoffs.decide, { handoffId: id, outcome: "accept", targetAgentId: "a2" })).rejects.toThrow("not open right now");
    await jimmy.mutation(api.handoffs.decide, { handoffId: id, outcome: "accept", targetAgentId: "a3", note: "the quote agent has the context" });
    expect(await handoff(t, id)).toMatchObject({ status: "accepted", targetAgentId: "a3", targetMachine: "jm", targetAgentName: "quote-page", note: "the quote agent has the context" });
    expect((await t.query(api.handoffs.toRun, { token: jimmyToken })).map(function (h) { return h.targetAgentId; })).toEqual(["a3"]);
    // Changed his mind before it ran.
    await jimmy.mutation(api.handoffs.decide, { handoffId: id, outcome: "decline", note: "busy today" });
    expect(await handoff(t, id)).toMatchObject({ status: "declined", note: "busy today" });
    await expect(jimmy.mutation(api.handoffs.decide, { handoffId: id, outcome: "accept" })).rejects.toThrow("not waiting any more");
    expect(await t.query(api.handoffs.toRun, { token: jimmyToken })).toEqual([]);

    // An offer with no agent: accepting needs one.
    const loose = await tom.mutation(api.handoffs.offer, { toHandle: "jimmy", text: "Translate the onboarding guide", via: "hud" });
    await expect(jimmy.mutation(api.handoffs.decide, { handoffId: loose, outcome: "accept" })).rejects.toThrow("Pick one of your agents");
    await jimmy.mutation(api.handoffs.decide, { handoffId: loose, outcome: "accept", targetAgentId: "a1", targetMachine: "jm" });
    expect((await handoff(t, loose)).targetAgentId).toBe("a1");
  });

  test("the daemon runs it on the right machine and the agent reports back: done, on the wire, and 20 XP for the receiver", async function () {
    const t = harness();
    const { tom, jimmy, jimmyToken } = await crew(t);
    const otherMac = await machine(t, jimmy, "jm2", []);
    const id = await tom.mutation(api.handoffs.offer, { toHandle: "jimmy", text: TASK, via: "hud" });
    await jimmy.mutation(api.handoffs.decide, { handoffId: id, outcome: "accept" });
    expect(await t.query(api.handoffs.toRun, { token: otherMac })).toEqual([]);
    await expect(t.mutation(api.handoffs.started, { token: otherMac, handoffId: id })).rejects.toThrow("no such hand-off");
    await t.mutation(api.handoffs.started, { token: jimmyToken, handoffId: id });
    await t.mutation(api.handoffs.started, { token: jimmyToken, handoffId: id });
    const running = await handoff(t, id);
    expect(running.status).toBe("running");
    expect(running.expiresAt).toBe(must(running.startedAt) + OFFER_MS);
    expect(await t.query(api.handoffs.toRun, { token: jimmyToken })).toEqual([]);

    await t.mutation(api.handoffs.reportBack, {
      token: jimmyToken,
      handoffId: id,
      summary: `  Fixed VIB-123: bounces counted once. Key was ghp_${"b".repeat(36)}  `,
      links: ["https://github.com/vibes/vibes/pull/418", "not a link", "https://github.com/vibes/vibes/pull/418"],
      usd: 0.42,
    });
    const done = await handoff(t, id);
    expect(done).toMatchObject({ status: "done", links: ["https://github.com/vibes/vibes/pull/418"], usd: 0.42 });
    expect(done.summary).toBe("Fixed VIB-123: bounces counted once. Key was [secret]");
    const wire = await t.run(async function (ctx) { return await ctx.db.query("feed").collect(); });
    const tomId = await idOf(t, "tom");
    const jimmyId = await idOf(t, "jimmy");
    expect(wire.filter(function (e) { return e.kind === "handoff"; })).toMatchObject([{
      hackerId: jimmyId, otherHackerId: tomId, handoffId: id, text: done.summary, url: "https://github.com/vibes/vibes/pull/418",
    }]);
    const board = await tom.query(api.play.board, {});
    expect(board.find(function (r) { return r.handle === "jimmy"; })).toMatchObject({ xp: XP.handoff, handoffs: 1 });
    expect(board.find(function (r) { return r.handle === "tom"; })).toMatchObject({ xp: 0, handoffs: 0 });
    expect((await tom.query(api.handoffs.mine, {})).outgoing[0]).toMatchObject({ status: "done", summary: done.summary });
    await expect(t.mutation(api.handoffs.reportBack, { token: jimmyToken, handoffId: id, summary: "again" })).rejects.toThrow("already reported back");
    // Only the receiver's daemon reports back.
    const tomToken = await machine(t, tom, "mb2", []);
    const another = await tom.mutation(api.handoffs.offer, { toHandle: "jimmy", text: `${TASK} again`, via: "hud" });
    await expect(t.mutation(api.handoffs.reportBack, { token: tomToken, handoffId: another, summary: "done" })).rejects.toThrow("no such hand-off");
    await expect(t.mutation(api.handoffs.reportBack, { token: jimmyToken, handoffId: another, summary: "done" })).rejects.toThrow("not running");
  });

  test("the offering machine hears when its hand-offs finish, done or failed; other machines do not", async function () {
    const t = harness();
    const { jimmy, tomToken, jimmyToken } = await crew(t);
    const failing = await t.mutation(api.handoffs.offerFromAgent, { token: tomToken, toHandle: "jimmy", text: TASK, agentId: "t1" });
    await jimmy.mutation(api.handoffs.decide, { handoffId: failing.handoffId, outcome: "accept" });
    await t.mutation(api.handoffs.started, { token: jimmyToken, handoffId: failing.handoffId });
    await t.mutation(api.handoffs.failed, { token: jimmyToken, handoffId: failing.handoffId, note: "The session ended before it could run." });
    await expect(t.mutation(api.handoffs.failed, { token: jimmyToken, handoffId: failing.handoffId, note: "again" })).rejects.toThrow("not running");
    const working = await t.mutation(api.handoffs.offerFromAgent, { token: tomToken, toHandle: "jimmy", text: `${TASK} 2`, agentId: "t1" });
    await jimmy.mutation(api.handoffs.decide, { handoffId: working.handoffId, outcome: "accept" });
    await t.mutation(api.handoffs.reportBack, { token: jimmyToken, handoffId: working.handoffId, summary: "Fixed it", links: ["https://example.com/pr/2"] });

    const heard = await t.query(api.handoffs.finishedForDaemon, { token: tomToken });
    expect(heard.map(function (h) { return [h.handoffId, h.status, h.fromAgentId, h.toHandle]; }).sort()).toEqual([
      [failing.handoffId, "failed", "t1", "jimmy"],
      [working.handoffId, "done", "t1", "jimmy"],
    ].sort());
    expect(heard.find(function (h) { return h.status === "failed"; })?.note).toBe("The session ended before it could run.");
    expect(heard.find(function (h) { return h.status === "done"; })).toMatchObject({ summary: "Fixed it", links: ["https://example.com/pr/2"] });
    const otherMac = await machine(t, await hackerNamed(t, "sam"), "sm", []);
    expect(await t.query(api.handoffs.finishedForDaemon, { token: otherMac })).toEqual([]);
    expect(await t.query(api.handoffs.finishedForDaemon, { token: jimmyToken })).toEqual([]);
  });

  test("an agent that went private after accepting neither runs the hand-off nor reports it back", async function () {
    const t = harness();
    const { tom, jimmy, jimmyToken } = await crew(t);
    const id = await tom.mutation(api.handoffs.offer, { toHandle: "jimmy", text: TASK, via: "hud" });
    await jimmy.mutation(api.handoffs.decide, { handoffId: id, outcome: "accept" });
    const all = [agent("a1", "email-metrics", false), agent("a2", "taxes", false), agent("a3", "quote-page")];
    await t.mutation(api.subsets.report, { token: jimmyToken, agents: all });
    expect(await t.query(api.handoffs.toRun, { token: jimmyToken })).toEqual([]);
    await expect(t.mutation(api.handoffs.started, { token: jimmyToken, handoffId: id })).rejects.toThrow("private now");
    await expect(t.mutation(api.handoffs.reportBack, { token: jimmyToken, handoffId: id, summary: "done" })).rejects.toThrow("private now");
    // Open again: it runs.
    await t.mutation(api.subsets.report, { token: jimmyToken, agents: [agent("a1", "email-metrics"), ...all.slice(1)] });
    expect((await t.query(api.handoffs.toRun, { token: jimmyToken })).map(function (h) { return h.handoffId; })).toEqual([id]);
  });

  test("accepting gives a hand-off a day from then; the reason and notes lose anything that looks like a key", async function () {
    const t = harness();
    const { tom, jimmy } = await crew(t);
    const key = `ghp_${"c".repeat(36)}`;
    const id = await tom.mutation(api.handoffs.offer, { toHandle: "jimmy", text: TASK, why: `you have the token ${key}`, via: "hud" });
    await t.run(async function (ctx) { await ctx.db.patch("handoffs", id, { expiresAt: Date.now() + 60_000 }); });
    const before = Date.now();
    await jimmy.mutation(api.handoffs.decide, { handoffId: id, outcome: "accept", note: `using ${key}` });
    const accepted = await handoff(t, id);
    expect(accepted.expiresAt).toBeGreaterThanOrEqual(before + OFFER_MS);
    expect(accepted.why).toBe("you have the token [secret]");
    expect(accepted.note).toBe("using [secret]");
  });

  test("a crew's hand-offs never count against a friend outside the crew", async function () {
    const t = harness();
    const { tom, jimmy } = await crew(t);
    const tomId = await idOf(t, "tom");
    const jimmyId = await idOf(t, "jimmy");
    const sam = await hackerNamed(t, "sam");
    await befriend(sam, tom, "tom");
    await befriend(sam, jimmy, "jimmy");
    await t.run(async function (ctx) {
      const crewId = await ctx.db.insert("crews", { name: "vibes", leaderId: tomId, plan: "free", digestHour: 9, timezone: "America/Toronto", createdAt: Date.now() });
      await ctx.db.insert("crewMembers", { crewId, hackerId: tomId, role: "leader", joinedAt: Date.now() });
      await ctx.db.insert("crewMembers", { crewId, hackerId: jimmyId, role: "member", joinedAt: Date.now() });
    });
    for (let i = 0; i < 5; i++) await tom.mutation(api.handoffs.offer, { toHandle: "jimmy", text: `${TASK} ${i}`, via: "hud" });
    await expect(jimmy.mutation(api.handoffs.offer, { toHandle: "tom", text: "Review the rail", via: "hud" })).rejects.toThrow("today's hand-offs");
    // Sam is in no crew: his own allowance.
    await sam.mutation(api.handoffs.offer, { toHandle: "jimmy", text: "Translate the guide", via: "hud" });
  });

  test("the Operator's offer for a question that ran out of time is not made", async function () {
    const t = harness();
    const { tom } = await crew(t);
    const tomId = await idOf(t, "tom");
    const jimmyId = await idOf(t, "jimmy");
    const relayId = await t.run(async function (ctx) {
      return await ctx.db.insert("relays", { askerHackerId: tomId, question: TASK, status: "timeout", createdAt: Date.now() });
    });
    await expect(t.mutation(internal.handoffs.offerInternal, { fromId: tomId, toId: jimmyId, text: TASK, relayId })).rejects.toThrow("ran out of time");
    expect((await tom.query(api.handoffs.mine, {})).outgoing).toEqual([]);
  });

  test("turning \"run when idle\" off takes back what it accepted and did not start: to ask again, or declined with never", async function () {
    const t = harness();
    const { tom, jimmy, jimmyToken } = await crew(t);
    await jimmy.mutation(api.handoffs.setConsent, { handle: "tom", mode: "auto" });
    const first = await tom.mutation(api.handoffs.offer, { toHandle: "jimmy", text: `${TASK} 1`, via: "hud" });
    const started = await tom.mutation(api.handoffs.offer, { toHandle: "jimmy", text: `${TASK} 2`, via: "hud" });
    await t.mutation(api.handoffs.started, { token: jimmyToken, handoffId: started });
    await jimmy.mutation(api.handoffs.setConsent, { handle: "tom", mode: "ask" });
    expect(await handoff(t, first)).toMatchObject({ status: "offered" });
    expect((await handoff(t, first)).autoAccepted).toBeUndefined();
    expect((await handoff(t, started)).status).toBe("running");
    expect(await t.query(api.handoffs.toRun, { token: jimmyToken })).toEqual([]);

    // Accepted by Jimmy himself, it stays when he turns hand-offs from Tom off; one "auto" accepted is declined.
    await jimmy.mutation(api.handoffs.decide, { handoffId: first, outcome: "accept" });
    await jimmy.mutation(api.handoffs.setConsent, { handle: "tom", mode: "auto" });
    const third = await tom.mutation(api.handoffs.offer, { toHandle: "jimmy", text: `${TASK} 3`, via: "hud" });
    await jimmy.mutation(api.handoffs.setConsent, { handle: "tom", mode: "never" });
    expect((await handoff(t, first)).status).toBe("accepted");
    expect(await handoff(t, third)).toMatchObject({ status: "declined", note: "Hand-offs from you are off now." });
  });

  test("only the Mac a hand-off runs on fails it or reports it back", async function () {
    const t = harness();
    const { tom, jimmy, jimmyToken } = await crew(t);
    const otherMac = await machine(t, jimmy, "jm2", []);
    const id = await tom.mutation(api.handoffs.offer, { toHandle: "jimmy", text: TASK, via: "hud" });
    await jimmy.mutation(api.handoffs.decide, { handoffId: id, outcome: "accept" });
    await t.mutation(api.handoffs.started, { token: jimmyToken, handoffId: id });
    await expect(t.mutation(api.handoffs.failed, { token: otherMac, handoffId: id, note: "no" })).rejects.toThrow("no such hand-off");
    await expect(t.mutation(api.handoffs.reportBack, { token: otherMac, handoffId: id, summary: "done" })).rejects.toThrow("no such hand-off");
    expect((await handoff(t, id)).status).toBe("running");
  });

  test("the offering Mac also hears when a hand-off was declined or expired; neither goes on the wire", async function () {
    const t = harness();
    const { jimmy, tomToken } = await crew(t);
    const declined = await t.mutation(api.handoffs.offerFromAgent, { token: tomToken, toHandle: "jimmy", text: TASK, agentId: "t1" });
    await jimmy.mutation(api.handoffs.decide, { handoffId: declined.handoffId, outcome: "decline", note: "busy today" });
    const expired = await t.mutation(api.handoffs.offerFromAgent, { token: tomToken, toHandle: "jimmy", text: `${TASK} 2`, agentId: "t1" });
    await t.run(async function (ctx) { await ctx.db.patch("handoffs", expired.handoffId, { expiresAt: Date.now() - 1 }); });
    await t.mutation(internal.handoffs.expire, { handoffId: expired.handoffId });
    const heard = await t.query(api.handoffs.finishedForDaemon, { token: tomToken });
    expect(heard.map(function (h) { return [h.handoffId, h.status, h.note]; }).sort()).toEqual([
      [declined.handoffId, "declined", "busy today"],
      [expired.handoffId, "expired", undefined],
    ].sort());
    const wire = await t.run(async function (ctx) { return await ctx.db.query("feed").collect(); });
    expect(wire.filter(function (e) { return e.kind === "handoff"; })).toEqual([]);
  });

  test("an offer the sender did not aim at the receiver themselves waits for their yes, even under run when idle", async function () {
    const t = harness();
    const { jimmy } = await crew(t);
    await jimmy.mutation(api.handoffs.setConsent, { handle: "tom", mode: "auto" });
    const tomId = await idOf(t, "tom");
    const jimmyId = await idOf(t, "jimmy");
    const picked = await t.mutation(internal.handoffs.offerInternal, { fromId: tomId, toId: jimmyId, text: TASK, autoOk: false });
    expect(picked.status).toBe("offered");
    const named = await t.mutation(internal.handoffs.offerInternal, { fromId: tomId, toId: jimmyId, text: `${TASK} again`, autoOk: true });
    expect(named.status).toBe("accepted");
    expect((await handoff(t, named.handoffId)).autoAccepted).toBe(true);
  });

  test("an offer nobody takes expires after 24 hours through its scheduled function", async function () {
    jest.useFakeTimers();
    try {
      const t = harness();
      const { tom, jimmy } = await crew(t);
      const id = await tom.mutation(api.handoffs.offer, { toHandle: "jimmy", text: TASK, via: "hud" });
      await t.finishAllScheduledFunctions(function () {
        jest.advanceTimersByTime(OFFER_MS + 1);
      });
      expect((await handoff(t, id)).status).toBe("expired");
      expect((await jimmy.query(api.handoffs.mine, {})).incoming).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("the end of a day: offered or accepted and never run expires; running with no report back fails; a later start waits", async function () {
    const t = harness();
    const { tom, jimmy, jimmyToken } = await crew(t);
    async function made(n: number) {
      return await tom.mutation(api.handoffs.offer, { toHandle: "jimmy", text: `${TASK} ${n}`, via: "hud" });
    }
    const offered = await made(1);
    const accepted = await made(2);
    await jimmy.mutation(api.handoffs.decide, { handoffId: accepted, outcome: "accept" });
    const running = await made(3);
    await jimmy.mutation(api.handoffs.decide, { handoffId: running, outcome: "accept" });
    await t.mutation(api.handoffs.started, { token: jimmyToken, handoffId: running });
    const startedLater = await made(4);
    await jimmy.mutation(api.handoffs.decide, { handoffId: startedLater, outcome: "accept" });
    await t.mutation(api.handoffs.started, { token: jimmyToken, handoffId: startedLater });
    await t.run(async function (ctx) {
      for (const id of [offered, accepted, running]) await ctx.db.patch("handoffs", id, { expiresAt: Date.now() - 1 });
    });
    for (const id of [offered, accepted, running, startedLater]) await t.mutation(internal.handoffs.expire, { handoffId: id });
    expect((await handoff(t, offered)).status).toBe("expired");
    expect(await handoff(t, accepted)).toMatchObject({ status: "expired", note: "It did not run within 24 hours." });
    expect(await handoff(t, running)).toMatchObject({ status: "failed", note: "No report back in 24 hours." });
    expect((await handoff(t, startedLater)).status).toBe("running");
    // A report that comes late still counts.
    await t.mutation(api.handoffs.reportBack, { token: jimmyToken, handoffId: running, summary: "Done after all" });
    expect(await handoff(t, running)).toMatchObject({ status: "done", summary: "Done after all" });
    expect((await handoff(t, running)).note).toBeUndefined();
  });

  test("props count toward XP: from a crewmate on one of your lines, and from a customer", async function () {
    const t = harness();
    const { tom } = await crew(t);
    const tomId = await idOf(t, "tom");
    const jimmyId = await idOf(t, "jimmy");
    await t.run(async function (ctx) {
      const ship = await ctx.db.insert("feed", { kind: "ship", hackerId: jimmyId, text: "fixed bounces", at: Date.now() });
      await ctx.db.insert("feed", { kind: "props", hackerId: tomId, otherHackerId: jimmyId, about: ship, at: Date.now() });
      await ctx.db.insert("feed", { kind: "props", hackerId: jimmyId, fromCustomer: true, text: "got props from a customer", at: Date.now() });
      await ctx.db.insert("feed", { kind: "save", hackerId: jimmyId, fromCustomer: true, text: "may have saved an account", at: Date.now() });
    });
    const board = await tom.query(api.play.board, {});
    expect(board.find(function (r) { return r.handle === "jimmy"; })).toMatchObject({ props: 2, xp: 2 * XP.props });
    expect(board.find(function (r) { return r.handle === "tom"; })).toMatchObject({ props: 0, xp: 0 });
  });

  test("picking an agent: the one asked for when it is open, else the best fit by words, else none", function () {
    const agents = [
      { machineName: "jm", agentId: "a1", agentName: "email-metrics", harness: "claude-code", summary: "fix bounce counts in delivery metrics" },
      { machineName: "jm", agentId: "a3", agentName: "quote-page", harness: "codex", summary: "redesign the quote page" },
    ];
    expect(pickAgent(agents, TASK)?.agentId).toBe("a1");
    expect(pickAgent(agents, TASK, "a3")?.agentId).toBe("a3");
    expect(pickAgent(agents, TASK, "gone")?.agentId).toBe("a1");
    expect(pickAgent(agents, "Translate the onboarding guide")).toBeUndefined();
  });
});
