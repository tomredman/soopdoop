// ABOUTME: The soopdoop data model: hackers, friendships, invites, subsets (presence), knocks, flicks, supersetProfiles, the
// ABOUTME: Operator's routingSummaries and relays, the wire (feed), and for crews: crews, the ledger, notes, hand-offs, heads-ups, digests, drops.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// LED grammar. Green = working. Blue = idle, open to knocks. Purple = a relay in flight (Phase 2).
export const ledColor = v.union(v.literal("g"), v.literal("b"), v.literal("p"));

export const agentState = v.object({
  agentId: v.string(), // harness session id
  harness: v.string(), // "claude-code" | "codex" | ...
  name: v.string(), // what the rail shows, e.g. "listing-cards"
  workspace: v.optional(v.string()), // repo or worktree name, only if the hacker shares it
  status: v.union(v.literal("working"), v.literal("idle"), v.literal("waiting")),
  open: v.boolean(), // false = private: never listed to others, never read by the Operator
  lastTurnAt: v.number(),
});

// Where a question to the Operator stands. routing: picking the agent; reading: waiting for its owner's daemon;
// then answered, not-found (the agent did not know), nobody (no agent to ask), timeout or error.
export const relayStatus = v.union(
  v.literal("routing"),
  v.literal("reading"),
  v.literal("answered"),
  v.literal("not-found"),
  v.literal("nobody"),
  v.literal("timeout"),
  v.literal("error"),
);

// What can be on the wire. The first five are from before crews; the rest come with crews (docs/plan-crews.html §8).
export const feedKind = v.union(
  v.literal("answer"),
  v.literal("agent"),
  v.literal("catch"),
  v.literal("superflick"),
  v.literal("rally"),
  v.literal("ship"),
  v.literal("walkthrough"),
  v.literal("handoff"),
  v.literal("headsup"),
  v.literal("note"),
  v.literal("shout"),
  v.literal("props"),
  v.literal("save"),
  v.literal("digest"),
);

// A crew's plan: free for friends, team at $10 a member a month (docs/plan-crews.html §12).
export const crewPlan = v.union(v.literal("free"), v.literal("team"));

// Where a hand-off stands: offered to its receiver; accepted or declined by them (or expired, 24 hours); running in
// their agent; done (report_back) or failed.
export const handoffStatus = v.union(
  v.literal("offered"),
  v.literal("accepted"),
  v.literal("declined"),
  v.literal("expired"),
  v.literal("running"),
  v.literal("done"),
  v.literal("failed"),
);

// What a hacker lets one crewmate do with hand-offs: ask me each time (the default), run when my agent is idle, never.
export const handoffMode = v.union(v.literal("ask"), v.literal("auto"), v.literal("never"));

// A crew note: proposed by an agent and waiting for its owner, live, or retired (replaced or past 45 days unconfirmed).
export const noteStatus = v.union(v.literal("proposed"), v.literal("live"), v.literal("retired"));

// What soopdoop keeps from a hacker's public Superset leaderboard profile (lib/supersetProfile.ts reads it).
// No token counts, cost or rank: AGENTS.md keeps token counts off personal and crew boards.
export const supersetProfileFields = {
  handle: v.string(),
  name: v.optional(v.string()),
  tier: v.optional(v.string()),
  achievements: v.array(v.object({ slug: v.string(), level: v.optional(v.number()), of: v.optional(v.number()) })),
  models: v.array(v.string()), // most tokens first, names only
};

export default defineSchema({
  hackers: defineTable({
    handle: v.string(),
    supersetUserId: v.optional(v.string()),
    supersetOrgId: v.optional(v.string()),
    // Presence sharing. Default: online state and agent count only.
    shareWorkspaceNames: v.boolean(),
    shareAgentNames: v.boolean(),
    focusUntil: v.optional(v.number()),
    // Off the crew board for everyone but themselves.
    hideFromBoards: v.optional(v.boolean()),
    // The app sends the Mac's time zone (IANA name), so a crew's digest hour can follow its leader.
    timezone: v.optional(v.string()),
    // A per-sender knock limit is Phase 1.5; quiet hours Phase 3.
    createdAt: v.number(),
  })
    .index("by_handle", ["handle"])
    .index("by_supersetUserId", ["supersetUserId"]),

  // The daemon's session token. One row per machine the hacker runs the daemon on.
  daemonTokens: defineTable({
    hackerId: v.id("hackers"),
    tokenHash: v.string(),
    machineName: v.string(),
    lastSeenAt: v.number(),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_hacker", ["hackerId"]),

  friendships: defineTable({
    a: v.id("hackers"), // requester
    b: v.id("hackers"), // receiver
    status: v.union(v.literal("requested"), v.literal("accepted")),
    createdAt: v.number(),
  })
    .index("by_a_b", ["a", "b"])
    .index("by_b", ["b"]),

  invites: defineTable({
    fromHackerId: v.id("hackers"),
    token: v.string(),
    expiresAt: v.number(), // 7 days
    usedByHackerId: v.optional(v.id("hackers")),
    // Made for someone not on soopdoop yet who has a public Superset profile: linking that profile redeems it too.
    forHandle: v.optional(v.string()),
    forName: v.optional(v.string()),
  })
    .index("by_token", ["token"])
    .index("by_forHandle", ["forHandle"]),

  // A flick: a poke between friends, for fun. Open until it is flicked back or a scheduled function expires it. A
  // sender has at most one open flick per friend. Each flick back adds one to the rally. Caught in its first 10 seconds,
  // the receiver takes XP from the sender; every 5 flicks in a row nobody catches earn a superflick, which takes XP from
  // the receiver and cannot be caught.
  flicks: defineTable({
    fromHackerId: v.id("hackers"),
    toHackerId: v.id("hackers"),
    rally: v.number(),
    outcome: v.union(v.literal("open"), v.literal("flicked-back"), v.literal("caught"), v.literal("expired")),
    createdAt: v.number(),
    expiresAt: v.number(),
    // The catch window closed without a catch (a scheduled function sets it): it counts toward a superflick.
    safe: v.optional(v.boolean()),
    // What the receiver took from the sender by catching it.
    caughtXp: v.optional(v.number()),
    caughtAt: v.optional(v.number()),
    // A superflick, and what the sender took from the receiver with it.
    superflick: v.optional(v.boolean()),
    superXp: v.optional(v.number()),
  })
    .index("by_to_outcome", ["toHackerId", "outcome"])
    .index("by_from_outcome", ["fromHackerId", "outcome"]),

  // One hacker's session and its agents. ∅ when agents is empty.
  subsets: defineTable({
    hackerId: v.id("hackers"),
    machineName: v.string(),
    agents: v.array(agentState),
    updatedAt: v.number(),
  }).index("by_hacker_machine", ["hackerId", "machineName"]),

  // One row per hacker who linked their Superset profile. Refreshed every 6 hours; dropped when the owner unpublishes it.
  supersetProfiles: defineTable({
    hackerId: v.id("hackers"),
    ...supersetProfileFields,
    fetchedAt: v.number(),
  })
    .index("by_hacker", ["hackerId"])
    .index("by_handle", ["handle"]),

  // One line per open agent, from its owner's daemon after each turn: what it works on, the files it touched.
  // The Operator routes questions with these. Owners can read their own. Dropped when the agent ends.
  routingSummaries: defineTable({
    hackerId: v.id("hackers"),
    machineName: v.string(),
    agentId: v.string(),
    summary: v.string(),
    updatedAt: v.number(),
  }).index("by_hacker_agent", ["hackerId", "agentId"]),

  // One question to the Operator and what came of it. Keeps the question and the short answer, never what was read.
  relays: defineTable({
    askerHackerId: v.id("hackers"),
    question: v.string(),
    status: relayStatus,
    targetHackerId: v.optional(v.id("hackers")),
    targetMachine: v.optional(v.string()),
    targetAgentId: v.optional(v.string()),
    // Only when the owner shares agent names.
    targetAgentName: v.optional(v.string()),
    answer: v.optional(v.string()),
    note: v.optional(v.string()),
    tokensRead: v.optional(v.number()),
    tokensSent: v.optional(v.number()),
    createdAt: v.number(),
    finishedAt: v.optional(v.number()),
    // Typed in the Operator chat (the app), not asked by an agent's tool.
    via: v.optional(v.literal("chat")),
    // What the Operator asked the agent: a chat message rewritten to stand alone. The daemon asks this one.
    routedQuestion: v.optional(v.string()),
    // The Operator answered itself (crew news, small talk): no agent was asked.
    byOperator: v.optional(v.boolean()),
    // The question named someone the Operator could not place in the crew: the asker can fix the @handle and ask again.
    askAgain: v.optional(v.boolean()),
    // A work order the Operator turned into a hand-off offer instead of refusing it.
    handoffId: v.optional(v.id("handoffs")),
    // What the Operator's own Claude calls for this relay cost, in US dollars at API prices (the crew's cost line).
    usd: v.optional(v.number()),
    // Asked by an agent: its machine (and its session, when the tool knows it), so a hand-off the Operator offers for
    // it can be reported back to that session at its next prompt.
    askerMachine: v.optional(v.string()),
    askerAgentId: v.optional(v.string()),
  })
    .index("by_asker", ["askerHackerId"])
    .index("by_target_status", ["targetHackerId", "status"]),

  // The wire: what happened in a crew lately, for the HUD's feed. An agent answered a crewmate, a crewmate started an
  // agent, a flick was caught, a superflick landed, a rally grew. Written when it happens (feed.ts); kept 7 days.
  feed: defineTable({
    kind: feedKind,
    // Who did it: whose agent answered, who started an agent, who caught the flick, who superflicked, who flicked back.
    hackerId: v.id("hackers"),
    // The other person: who was helped, whose flick was caught, who was superflicked, the rally partner.
    otherHackerId: v.optional(v.id("hackers")),
    // answer: what the asker's agent did not have to read (the tokens the answering copy read, minus the answer's).
    tokensSaved: v.optional(v.number()),
    // catch and superflick: the XP that moved. rally: how long it is.
    xp: v.optional(v.number()),
    rally: v.optional(v.number()),
    // agent: which session it is, so an agent whose summary comes back (its owner's daemon restarted) is not news again.
    agentId: v.optional(v.string()),
    // ship, walkthrough, handoff, headsup, note, shout, props, save, digest: one line of text for the wire (a shout,
    // what shipped, the props line), and a link when there is one (the PR, the walkthrough).
    text: v.optional(v.string()),
    url: v.optional(v.string()),
    // What the event is about, so the HUD can open it and so one thing is never news twice.
    handoffId: v.optional(v.id("handoffs")),
    ledgerId: v.optional(v.id("ledger")),
    noteId: v.optional(v.id("notes")),
    dropId: v.optional(v.id("drops")),
    digestId: v.optional(v.id("digests")),
    // props: the wire line it was given on; fromCustomer when the scout or a help-desk webhook brought it.
    about: v.optional(v.id("feed")),
    fromCustomer: v.optional(v.boolean()),
    // shout: gone from the wire after 24 hours (a scheduled function removes it).
    expiresAt: v.optional(v.number()),
    at: v.number(),
  })
    .index("by_hacker_at", ["hackerId", "at"])
    .index("by_at", ["at"])
    // Events done to or for a hacker: the props they were given count toward their XP.
    .index("by_other_at", ["otherHackerId", "at"]),

  knocks: defineTable({
    fromHackerId: v.id("hackers"),
    toHackerId: v.id("hackers"),
    item: v.object({
      kind: v.union(v.literal("link"), v.literal("file"), v.literal("session"), v.literal("page")),
      title: v.string(),
      url: v.optional(v.string()),
    }),
    note: v.optional(v.string()),
    lifetimeMs: v.number(), // 10 s, 30 s, or 2 min
    expiresAt: v.number(),
    outcome: v.union(v.literal("open"), v.literal("opened"), v.literal("not-now"), v.literal("expired")),
    createdAt: v.number(),
    decidedAt: v.optional(v.number()),
    // Sent for the sender, not by them (the knock that goes with a hand-off no agent fits): it earns no XP.
    automatic: v.optional(v.boolean()),
  })
    .index("by_to_outcome", ["toHackerId", "outcome"])
    .index("by_from_to", ["fromHackerId", "toHackerId"]),

  // A crew: a name, a leader, up to 8 members (crewMembers), settings and a plan. The scope for the ledger, notes,
  // hand-offs, heads-ups, the digest and billing. Friends stay the social graph; a hacker in no crew keeps the friends
  // behaviour. One crew per hacker. Secrets here (the Slack webhook, Intercom's token and secret) are never returned by
  // a query: queries say only whether one is set.
  crews: defineTable({
    name: v.string(),
    leaderId: v.id("hackers"),
    plan: crewPlan,
    // The digest's hour (0 to 23) in the crew's time zone (an IANA name).
    digestHour: v.number(),
    timezone: v.string(),
    slackWebhook: v.optional(v.string()),
    // Ships, props and saves go to Slack as they happen. Off by default.
    slackMirror: v.optional(v.boolean()),
    // What Slack said to the last post that failed (cleared by one that goes through), and when a post last went through.
    slackError: v.optional(v.string()),
    slackPostedAt: v.optional(v.number()),
    // Crewmates whose agents may post crew notes without their owner's approval (the leader's choice).
    trustedNotePosters: v.optional(v.array(v.id("hackers"))),
    intercomToken: v.optional(v.string()),
    intercomSecret: v.optional(v.string()),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),
    // The team plan runs until here (Stripe's current period end); unset on the free plan. While a renewal is unpaid
    // (past_due) it is the end of the last paid period, and a daily cron moves the crew to free 3 days after it.
    planUntil: v.optional(v.number()),
    // The subscription as soopdoop last read it from Stripe (billing.ts: the webhook, or a seat count change): its status
    // (active, trialing, past_due, unpaid, incomplete...), how many members it bills, monthly or yearly, when the current
    // period ends, and whether it renews then (false once the leader cancels it in the billing portal). Unset when it
    // ended or there never was one.
    subscriptionStatus: v.optional(v.string()),
    subscriptionQuantity: v.optional(v.number()),
    subscriptionYearly: v.optional(v.boolean()),
    subscriptionUntil: v.optional(v.number()),
    subscriptionRenews: v.optional(v.boolean()),
    // Subscriptions this crew had that ended. Stripe never brings one back, so later news about them that is not
    // "ended" is old news and changes nothing.
    endedSubscriptions: v.optional(v.array(v.string())),
    // A second subscription the leader also paid for (two Checkout tabs). The crew follows the checkout whose event
    // arrived last; if that one ends first, the crew falls back to this one while it is still paid.
    spareSubscriptionId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_leader", ["leaderId"])
    .index("by_stripeSubscriptionId", ["stripeSubscriptionId"])
    .index("by_planUntil", ["planUntil"]),

  crewMembers: defineTable({
    crewId: v.id("crews"),
    hackerId: v.id("hackers"),
    role: v.union(v.literal("leader"), v.literal("member")),
    joinedAt: v.number(),
  })
    .index("by_crew", ["crewId"])
    .index("by_hacker", ["hackerId"]),

  // The ledger: one line per finished piece of work, per person, built on the owner's Mac (docs/plan-crews.html §4).
  // At most 240 characters of "did". Kept 7 days on the free plan, 90 on team (a daily cron drops the rest). The owner
  // sees, edits and deletes their own lines; crewmates' agents search them through the Operator.
  ledger: defineTable({
    hackerId: v.id("hackers"),
    at: v.number(),
    harness: v.string(),
    machineName: v.string(),
    // One line per session: the daemon sends the line again as the session goes on, and it replaces the old one.
    sessionKey: v.string(),
    workspace: v.optional(v.string()),
    branch: v.optional(v.string()),
    did: v.string(),
    // Top-level folders of the files touched.
    areas: v.array(v.string()),
    files: v.number(),
    // A pull request the transcript showed being opened or merged, and whether it merged (a ship on the wire).
    pr: v.optional(v.string()),
    shipped: v.optional(v.boolean()),
    // A walkthrough page for the ship, once the owner had their agent write one; asked tracks the one-time prompt.
    walkthrough: v.optional(v.string()),
    walkthroughAsked: v.optional(v.boolean()),
    // The owner rewrote the line in the HUD: the daemon must not replace it again.
    editedByOwner: v.optional(v.boolean()),
    // The owner deleted the line: its words are gone, and this marker stops the daemon's next send from bringing it back.
    forgotten: v.optional(v.boolean()),
  })
    .index("by_hacker_at", ["hackerId", "at"])
    .index("by_hacker_session", ["hackerId", "sessionKey"])
    .index("by_at", ["at"]),

  // Crew notes: live shared instructions, up to 400 characters each, delivered to every running agent (§7). At most 60
  // live per crew on the team plan, 10 on free. An agent's proposal waits for its owner unless the leader trusts them.
  notes: defineTable({
    crewId: v.id("crews"),
    authorId: v.id("hackers"),
    text: v.string(),
    tags: v.array(v.string()),
    // "Still true by" date; after it, the author is nudged. Unconfirmed notes stop being delivered 45 days after
    // their last confirmation and stay in the history.
    confirmBy: v.optional(v.number()),
    // A folder, repository or word: the note is delivered only to sessions in that area.
    appliesWhen: v.optional(v.string()),
    replaces: v.optional(v.id("notes")),
    status: noteStatus,
    proposedByAgent: v.optional(v.boolean()),
    confirmedAt: v.optional(v.number()),
    retiredAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_crew_status", ["crewId", "status"])
    .index("by_author", ["authorId"]),

  // Hand-offs: a task offered to a crewmate's agent; the crewmate approves it and it runs on their account (§6). The
  // backend keeps the offer text, the status and the summary, nothing else; the receiver's Mac logs the rest.
  handoffs: defineTable({
    fromId: v.id("hackers"),
    toId: v.id("hackers"),
    // The receiver's agent it goes to, when one fits; without one it becomes a knock with the text attached.
    targetMachine: v.optional(v.string()),
    targetAgentId: v.optional(v.string()),
    targetAgentName: v.optional(v.string()),
    targetHarness: v.optional(v.string()),
    text: v.string(),
    why: v.optional(v.string()),
    status: handoffStatus,
    // Accepted by the receiver's "run when my agent is idle" for this sender, not by the receiver at the time: a change
    // of that setting takes it back.
    autoAccepted: v.optional(v.boolean()),
    // Where it was offered from.
    via: v.optional(v.union(v.literal("agent"), v.literal("hud"), v.literal("menu"), v.literal("operator"), v.literal("headsup"))),
    // The sender's agent that offered it, so its daemon can tell that session when it is done.
    fromMachine: v.optional(v.string()),
    fromAgentId: v.optional(v.string()),
    relayId: v.optional(v.id("relays")),
    knockId: v.optional(v.id("knocks")),
    summary: v.optional(v.string()),
    links: v.optional(v.array(v.string())),
    usd: v.optional(v.number()),
    note: v.optional(v.string()),
    createdAt: v.number(),
    expiresAt: v.number(),
    decidedAt: v.optional(v.number()),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
  })
    .index("by_to_status", ["toId", "status"])
    .index("by_from", ["fromId", "createdAt"]),

  // What a hacker lets each crewmate do with hand-offs. No row means "ask me each time".
  handoffConsents: defineTable({
    hackerId: v.id("hackers"),
    otherId: v.id("hackers"),
    mode: handoffMode,
  }).index("by_hacker_other", ["hackerId", "otherId"]),

  // Heads-ups: the owner's Mac saw a prompt about an area a crewmate's agent is on, or files it is changing (§5). Kept
  // a week for the "acted on" count; the card itself lasts 10 minutes (a scheduled function ends it).
  headsups: defineTable({
    hackerId: v.id("hackers"),
    otherId: v.id("hackers"),
    otherAgentId: v.string(),
    kind: v.union(v.literal("area"), v.literal("files")),
    // What the card says, built on the owner's Mac from what the crewmate shares.
    line: v.string(),
    // The session of the owner's that prompted it, so the acted-on check can match it.
    agentId: v.optional(v.string()),
    at: v.number(),
    expiresAt: v.number(),
    // Set by the scheduled function that ends the card, so the HUD's query drops it without a client's help.
    expiredAt: v.optional(v.number()),
    dismissedAt: v.optional(v.number()),
    actedAt: v.optional(v.number()),
    action: v.optional(v.union(v.literal("ask"), v.literal("handoff"), v.literal("knock"))),
  })
    .index("by_hacker_at", ["hackerId", "at"])
    .index("by_at", ["at"]),

  // The digest the Operator writes for a crew: "Yesterday in <crew>" once a day, the four numbers once a week (§8).
  digests: defineTable({
    crewId: v.id("crews"),
    // The day it covers, YYYY-MM-DD in the crew's time zone.
    day: v.string(),
    kind: v.union(v.literal("daily"), v.literal("weekly")),
    text: v.string(),
    writtenAt: v.number(),
    postedAt: v.optional(v.number()),
    postError: v.optional(v.string()),
    usd: v.optional(v.number()),
  })
    .index("by_crew_day", ["crewId", "day"])
    .index("by_crew", ["crewId", "writtenAt"]),

  // Drops: pages a crew shares (walkthroughs first), stored in Convex file storage and served at an unguessable link
  // (§12, R9). 5 GB per crew on the team plan; links only on free.
  drops: defineTable({
    crewId: v.optional(v.id("crews")),
    hackerId: v.id("hackers"),
    title: v.string(),
    kind: v.union(v.literal("walkthrough"), v.literal("page"), v.literal("file")),
    storageId: v.optional(v.id("_storage")),
    // A page hosted elsewhere (a Superset Page, an Artifact): the link only.
    url: v.optional(v.string()),
    token: v.string(),
    size: v.number(),
    contentType: v.string(),
    ledgerId: v.optional(v.id("ledger")),
    createdAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_crew", ["crewId", "createdAt"])
    .index("by_hacker", ["hackerId", "createdAt"]),
});
