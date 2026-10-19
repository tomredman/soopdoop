// ABOUTME: The agent's state as the app reads it (apps/rail/src/agent.ts AppState). Decoding is lenient: a missing field takes
// ABOUTME: its default and unknown fields are ignored, so a newer agent never breaks an older app.
import Foundation

extension KeyedDecodingContainer {
    func value<T: Decodable>(_ key: Key, _ fallback: T) -> T {
        (try? decodeIfPresent(T.self, forKey: key)) ?? fallback
    }

    func maybe<T: Decodable>(_ key: Key) -> T? {
        (try? decodeIfPresent(T.self, forKey: key)) ?? nil
    }
}

struct Achievement: Decodable, Hashable {
    var slug = ""
    var level: Int?
    var of: Int?
}

struct SupersetCard: Decodable {
    var handle = ""
    var name: String?
    var tier: String?
    var achievements: [Achievement] = []
    var models: [String] = []
}

struct Me: Decodable {
    var handle = ""
    var shareAgentNames = false
    var shareWorkspaceNames = false
    var focusUntil: Double?
    var hideFromBoards = false
    var superset: SupersetCard?
}

struct BoardRow: Decodable, Identifiable {
    var handle = ""
    var me = false
    var xp = 0
    var rank = "n00b"
    var rankAt = 0
    var nextRankAt: Int?
    var assists = 0
    var asks = 0
    var tier: String?
    // Hand-offs done for crewmates, and props received. Older agents send neither.
    var handoffs = 0
    var props = 0
    var id: String { handle }
}

struct FriendAgent: Decodable, Hashable {
    var name = ""
    var workspace: String?
    var status = "idle"
}

struct Friend: Decodable, Identifiable {
    var handle = ""
    // "g" working, "b" idle, "x" off.
    var led = "x"
    var inFocus = false
    var agentCount = 0
    var agents: [FriendAgent]?
    var superset: SupersetCard?
    // A question of mine is reading one of their agents right now.
    var relaying = false
    // What their newest open agent is on, as crewmates' agents read it. Only for crewmates, not while they focus.
    var summary: String?
    // When one of their machines last reported, in milliseconds since 1970. Not while they focus.
    var lastSeenAt: Double?
    var id: String { handle }
}

struct FriendRequest: Decodable, Identifiable {
    var handle = ""
    var id: String { handle }
}

struct KnockItem: Decodable {
    var kind = "link"
    var title = ""
    var url: String?
}

struct Knock: Decodable, Identifiable {
    var id = ""
    var fromHandle = ""
    var item = KnockItem()
    var note: String?
    var expiresAt: Double = 0
    var lifetimeMs: Double = 30_000
}

struct Incoming: Decodable {
    var current: Knock?
    var pending = 0
}

struct SentKnock: Decodable, Identifiable {
    var id = ""
    var toHandle = ""
    var outcome = "open"
    var expiresAt: Double = 0
}

// A friend's flick, waiting for a flick back. The backend expires it after 10 minutes.
struct IncomingFlick: Decodable, Identifiable {
    var id = ""
    var fromHandle = ""
    var rally = 1
    var expiresAt: Double = 0
    // Until when catching it takes the flicker's XP; 0 once that is over, and for a superflick.
    var catchUntil: Double = 0
    var superflick = false
    // What a superflick took from me.
    var xp = 0
}

// One of my flicks that a friend caught, and what they took.
struct CaughtFlick: Decodable, Identifiable {
    var id = ""
    var byHandle = ""
    var xp = 0
    var at: Double = 0
}

// Superflicks ready to use, and clean flicks toward the next one (one every `every`).
struct Superflicks: Decodable {
    var ready = 0
    var clean = 0
    var every = 5
}

// Who flicked me, whom I flicked and am waiting on, my flicks caught lately, and my superflicks.
struct Flicks: Decodable {
    var incoming: [IncomingFlick] = []
    var waitingOn: [String] = []
    var caught: [CaughtFlick] = []
    var superflicks = Superflicks()
}

// The one line the Operator routes questions with, for one of my open agents.
struct RoutingSummary: Decodable {
    var agentId = ""
    var summary = ""
}

struct AgentState: Decodable, Identifiable {
    var agentId = ""
    var name = ""
    var workspace: String?
    var status = "idle"
    var open = true
    // Which tool runs it: "claude-code", "codex" or "grok".
    var harness: String?
    var id: String { agentId }
}

struct Machine: Decodable, Identifiable {
    var machineName = ""
    var updatedAt: Double = 0
    var agents: [AgentState] = []
    var id: String { machineName }
}

struct Relay: Decodable, Identifiable {
    var id = ""
    var question = ""
    // routing, reading, answered, not-found, nobody, timeout, error
    var status = "routing"
    var answer: String?
    var note: String?
    var askerHandle = ""
    var targetHandle: String?
    var targetAgentName: String?
    var tokensRead: Double?
    var createdAt: Double = 0
    // "asked" or "answered"
    var role = "asked"
    // "chat" when typed in the Operator chat.
    var via: String?
    // The Operator answered itself: no agent was asked.
    var byOperator = false
    // The Operator offered it as a hand-off (a work order) instead of asking an agent.
    var handoffId: String?

    var inFlight: Bool { status == "routing" || status == "reading" }
}

// One event on the wire (feed.recent): an answer between agents, a crewmate's new agent, a caught flick, a superflick, a
// rally, and with crews a ship, a walkthrough, a hand-off done, a heads-up, a note, a shout, props, a save or the digest.
// `me`: the viewer did it. `otherMe`: it was done to, or for, the viewer.
struct FeedEvent: Decodable, Identifiable {
    var id = ""
    // answer, agent, catch, superflick, rally, ship, walkthrough, handoff, headsup, note, shout, props, save, digest
    var kind = ""
    var handle = ""
    // Nil for whoever asked a question between two other crewmates.
    var otherHandle: String?
    var me = false
    var otherMe = false
    var tokensSaved: Double?
    var xp: Int?
    var rally: Int?
    var at: Double = 0
    // The line itself (a shout, what shipped, the start of a note, a props line) and its link.
    var text: String?
    var url: String?
    // Props or a save from a customer (the scout), not from a crewmate.
    var fromCustomer = false
    var handoffId: String?
    var ledgerId: String?
    var noteId: String?
    var dropId: String?
    var digestId: String?
    // Props: the wire line they were given on.
    var about: String?
    // A shout: when it leaves the wire.
    var expiresAt: Double?
}

// Tokens the crew's answers saved, all time, as an estimate (feed.saved): mine, my agents' for crewmates, the crew's.
struct Saved: Decodable {
    var you: Double = 0
    var yourAgents: Double = 0
    var crew: Double = 0
}

struct LocalInfo: Decodable {
    var machine = ""
    var paired = false
    var version = ""
    var latest: String?
    var newer = false
    var releaseUrl: String?
    var autoUpdate = true
    var canUpdate = false
    var updating = false
    var updateError: String?
    // The watcher opens the app when Superset opens.
    var autoOpen = true
    // Settings → This Mac: a Haiku call on the hacker's own Claude account writes each ledger line; the scout reads their
    // help-desk connector for props and saves; what hand-offs may cost this Mac's agents in any 24 hours, in US dollars.
    var ledgerLines = true
    var scout = false
    var handoffDailyUsd: Double = 10
}

// One member of my crew (crews.mine): the leader first, then by when they joined.
struct CrewMember: Decodable, Identifiable {
    var handle = ""
    var name: String?
    // "leader" or "member"
    var role = "member"
    var joinedAt: Double = 0
    var id: String { handle }
}

// My crew (crews.mine). Never the Slack webhook or Intercom's token and secret, only whether they are set.
struct CrewInfo: Decodable, Identifiable {
    var id = ""
    var name = ""
    // "free" or "team"
    var plan = "free"
    var planUntil: Double?
    var leaderHandle = ""
    var iAmLeader = false
    // The hour (0 to 23) the daily digest goes out, in `timezone` (an IANA name such as America/Toronto).
    var digestHour = 9
    var timezone = "UTC"
    var slackConnected = false
    // Ships, props and saves go to the crew's Slack channel as they happen.
    var slackMirror = false
    // The last post to Slack that failed (cleared by one that works), and when a post last went through.
    var slackError: String?
    var slackPostedAt: Double?
    var intercomConnected = false
    // The address the leader pastes into Intercom's webhook settings. Only for the leader.
    var intercomWebhookUrl: String?
    // Handles of the crewmates whose agents post crew notes without asking.
    var trustedNotePosters: [String] = []
    var members: [CrewMember] = []
}

// The crew's four numbers for the last `days` days (crews.numbers). Totals, never per person.
struct Numbers: Decodable {
    var answered = 0
    var tokensSaved: Double = 0
    var handoffs = 0
    var headsups = 0
    var ships = 0
    var walkthroughs = 0
    var days = 7
}

// What the crew's Operator cost this month at API prices, in US dollars (crews.costs).
struct Costs: Decodable {
    // "2026-10", in the crew's time zone.
    var month = ""
    var operatorUsd: Double = 0
    var digestUsd: Double = 0
}

// One finished task in my ledger (ledger.mine), newest first.
struct LedgerLine: Decodable, Identifiable {
    var id = ""
    var at: Double = 0
    var harness = ""
    var machineName = ""
    // The daemon's key for the session. The agent sends it to this Mac's daemon for a walkthrough.
    var sessionKey = ""
    var workspace: String?
    var branch: String?
    // What was done, in one line (at most 240 characters). Its owner can edit it.
    var did = ""
    var areas: [String] = []
    var files = 0
    var pr: String?
    var shipped = false
    // The walkthrough's web link, once there is one.
    var walkthrough: String?
    // "Make a walkthrough?" has been answered (made or skipped).
    var walkthroughAsked = false
    var editedByOwner = false
}

// A crew note (notes.list).
struct Note: Decodable, Identifiable {
    var id = ""
    var text = ""
    var tags: [String] = []
    var authorHandle = ""
    var authorName: String?
    // "live", "proposed" (an agent's, waiting for approval) or "retired"
    var status = "live"
    var proposedByAgent = false
    var appliesWhen: String?
    var confirmBy: Double?
    // The live note it replaces when it goes live.
    var replaces: String?
    var createdAt: Double = 0
    var updatedAt: Double = 0
    var confirmedAt: Double?
    var retiredAt: Double?
    // Time to ask its author "still true?": 30 days since it was confirmed, or its confirm-by date passed.
    var nudge = false
    // 45 days without a confirmation: still listed, no longer delivered to agents.
    var stale = false
}

// The crew's notes: the live ones, the proposals waiting for me (all of them for the leader), the last 10 retired.
struct NotesList: Decodable {
    var live: [Note] = []
    var proposed: [Note] = []
    var retired: [Note] = []
}

// A hand-off offered to me (handoffs.mine): waiting for my answer, or accepted and waiting to run.
struct IncomingHandoff: Decodable, Identifiable {
    var id = ""
    var fromHandle = ""
    var fromName: String?
    var text = ""
    var why: String?
    var targetAgentId: String?
    var targetAgentName: String?
    var targetMachine: String?
    // offered, accepted, declined, expired, running, done, failed
    var status = "offered"
    var createdAt: Double = 0
    var expiresAt: Double = 0
    // Where it was offered from: agent, hud, menu, operator, headsup.
    var via: String?
}

// A hand-off I offered (handoffs.mine), the last 20.
struct OutgoingHandoff: Decodable, Identifiable {
    var id = ""
    var toHandle = ""
    var text = ""
    // offered, accepted, declined, expired, running, done, failed
    var status = "offered"
    // What the agent that ran it reported back, and its links (a PR).
    var summary: String?
    var links: [String] = []
    var note: String?
    var createdAt: Double = 0
    var decidedAt: Double?
    var finishedAt: Double?
    // Only when the receiver shares agent names.
    var targetAgentName: String?
}

struct HandoffsList: Decodable {
    var incoming: [IncomingHandoff] = []
    var outgoing: [OutgoingHandoff] = []
}

// What I let one crewmate do with hand-offs (handoffs.consents): "ask" me each time, "auto" (run when my agent is idle),
// or "never".
struct Consent: Decodable, Identifiable {
    var handle = ""
    var name: String?
    var mode = "ask"
    var id: String { handle }
}

// A heads-up card (headsups.cards): a crewmate's agent is on the same area ("area") or files ("files") as one of mine.
// The backend expires it.
struct Headsup: Decodable, Identifiable {
    var id = ""
    var otherHandle = ""
    var otherName: String?
    var otherAgentId = ""
    var otherAgentName: String?
    var kind = "area"
    var line = ""
    var at: Double = 0
    var expiresAt: Double = 0
}

// One digest (digests.latest): "Yesterday in <crew>", or the week's numbers.
struct Digest: Decodable, Identifiable {
    var id = ""
    // The local day it covers, such as "2026-10-17".
    var day = ""
    var text = ""
    var writtenAt: Double = 0
    var postedAt: Double?
    var postError: String?
}

// The crew's latest daily digest and latest weekly numbers.
struct DigestInfo: Decodable {
    var daily: Digest?
    var weekly: Digest?
}

// One drop on the crew's shelf (drops.list): a walkthrough or page soopdoop stores, or a link kept for the crew.
struct Drop: Decodable, Identifiable {
    var id = ""
    var title = ""
    // walkthrough, page, file
    var kind = "page"
    var url = ""
    var byHandle = ""
    var byName: String?
    var createdAt: Double = 0
    var size: Double = 0
    var ledgerId: String?
    var canForget = false
}

struct AppState: Decodable {
    var version = ""
    // signed-out, signing-in, connecting, needs-handle, ready
    var phase = "signed-out"
    var message: String?
    var me: Me?
    var board: [BoardRow] = []
    var crew: [Friend] = []
    var requests: [FriendRequest] = []
    var incoming = Incoming()
    var sent: [SentKnock] = []
    var subset: [Machine] = []
    var routing: [RoutingSummary] = []
    var wire: [Relay] = []
    var local: LocalInfo?
    var inviteWaiting = false
    var flicks = Flicks()
    // The Operator chat, oldest first.
    var chat: [Relay] = []
    // The wire, newest first, and the tokens saved. Older agents send neither.
    var feed: [FeedEvent] = []
    var saved: Saved?
    // The crew. Older agents send none of these. `crewInfo` is nil when I am in no crew.
    var crewInfo: CrewInfo?
    var numbers: Numbers?
    var costs: Costs?
    var ledger: [LedgerLine] = []
    var notes = NotesList()
    var handoffs = HandoffsList()
    var consents: [Consent] = []
    var headsups: [Headsup] = []
    var digest = DigestInfo()
    var drops: [Drop] = []

    var myRow: BoardRow? { board.first { $0.me } }
}

extension Achievement {
    enum CodingKeys: String, CodingKey { case slug, level, of }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        slug = c.value(.slug, ""); level = c.maybe(.level); of = c.maybe(.of)
    }
}

extension SupersetCard {
    enum CodingKeys: String, CodingKey { case handle, name, tier, achievements, models }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        handle = c.value(.handle, ""); name = c.maybe(.name); tier = c.maybe(.tier)
        achievements = c.value(.achievements, []); models = c.value(.models, [])
    }
}

extension Me {
    enum CodingKeys: String, CodingKey { case handle, shareAgentNames, shareWorkspaceNames, focusUntil, hideFromBoards, superset }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        handle = c.value(.handle, ""); shareAgentNames = c.value(.shareAgentNames, false)
        shareWorkspaceNames = c.value(.shareWorkspaceNames, false); focusUntil = c.maybe(.focusUntil)
        hideFromBoards = c.value(.hideFromBoards, false); superset = c.maybe(.superset)
    }
}

extension BoardRow {
    enum CodingKeys: String, CodingKey { case handle, me, xp, rank, rankAt, nextRankAt, assists, asks, tier, handoffs, props }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        handle = c.value(.handle, ""); me = c.value(.me, false); xp = c.value(.xp, 0); rank = c.value(.rank, "n00b")
        rankAt = c.value(.rankAt, 0); nextRankAt = c.maybe(.nextRankAt); assists = c.value(.assists, 0)
        asks = c.value(.asks, 0); tier = c.maybe(.tier); handoffs = c.value(.handoffs, 0); props = c.value(.props, 0)
    }
}

extension FriendAgent {
    enum CodingKeys: String, CodingKey { case name, workspace, status }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = c.value(.name, ""); workspace = c.maybe(.workspace); status = c.value(.status, "idle")
    }
}

extension Friend {
    enum CodingKeys: String, CodingKey { case handle, led, inFocus, agentCount, agents, superset, relaying, summary, lastSeenAt }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        handle = c.value(.handle, ""); led = c.value(.led, "x"); inFocus = c.value(.inFocus, false)
        agentCount = c.value(.agentCount, 0); agents = c.maybe(.agents); superset = c.maybe(.superset)
        relaying = c.value(.relaying, false); summary = c.maybe(.summary); lastSeenAt = c.maybe(.lastSeenAt)
    }
}

extension FriendRequest {
    enum CodingKeys: String, CodingKey { case handle }
    init(from decoder: Decoder) throws {
        handle = try decoder.container(keyedBy: CodingKeys.self).value(.handle, "")
    }
}

extension KnockItem {
    enum CodingKeys: String, CodingKey { case kind, title, url }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = c.value(.kind, "link"); title = c.value(.title, ""); url = c.maybe(.url)
    }
}

extension Knock {
    enum CodingKeys: String, CodingKey { case id = "_id", fromHandle, item, note, expiresAt, lifetimeMs }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.value(.id, ""); fromHandle = c.value(.fromHandle, ""); item = c.value(.item, KnockItem())
        note = c.maybe(.note); expiresAt = c.value(.expiresAt, 0); lifetimeMs = c.value(.lifetimeMs, 30_000)
    }
}

extension Incoming {
    enum CodingKeys: String, CodingKey { case current, pending }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        current = c.maybe(.current); pending = c.value(.pending, 0)
    }
}

extension SentKnock {
    enum CodingKeys: String, CodingKey { case id = "_id", toHandle, outcome, expiresAt }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.value(.id, ""); toHandle = c.value(.toHandle, ""); outcome = c.value(.outcome, "open")
        expiresAt = c.value(.expiresAt, 0)
    }
}

extension IncomingFlick {
    enum CodingKeys: String, CodingKey { case id = "_id", fromHandle, rally, expiresAt, catchUntil, superflick, xp }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.value(.id, ""); fromHandle = c.value(.fromHandle, ""); rally = c.value(.rally, 1); expiresAt = c.value(.expiresAt, 0)
        catchUntil = c.value(.catchUntil, 0); superflick = c.value(.superflick, false); xp = c.value(.xp, 0)
    }
}

extension CaughtFlick {
    enum CodingKeys: String, CodingKey { case id = "_id", byHandle, xp, at }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.value(.id, ""); byHandle = c.value(.byHandle, ""); xp = c.value(.xp, 0); at = c.value(.at, 0)
    }
}

extension Superflicks {
    enum CodingKeys: String, CodingKey { case ready, clean, every }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ready = c.value(.ready, 0); clean = c.value(.clean, 0); every = c.value(.every, 5)
    }
}

extension Flicks {
    enum CodingKeys: String, CodingKey { case incoming, waitingOn, caught, superflicks }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        incoming = c.value(.incoming, []); waitingOn = c.value(.waitingOn, []); caught = c.value(.caught, [])
        superflicks = c.value(.superflicks, Superflicks())
    }
}

extension RoutingSummary {
    enum CodingKeys: String, CodingKey { case agentId, summary }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agentId = c.value(.agentId, ""); summary = c.value(.summary, "")
    }
}

extension AgentState {
    enum CodingKeys: String, CodingKey { case agentId, name, workspace, status, open, harness }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agentId = c.value(.agentId, ""); name = c.value(.name, ""); workspace = c.maybe(.workspace)
        status = c.value(.status, "idle"); open = c.value(.open, true); harness = c.maybe(.harness)
    }
}

extension Machine {
    enum CodingKeys: String, CodingKey { case machineName, updatedAt, agents }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        machineName = c.value(.machineName, ""); updatedAt = c.value(.updatedAt, 0); agents = c.value(.agents, [])
    }
}

extension Relay {
    enum CodingKeys: String, CodingKey {
        case id = "_id", question, status, answer, note, askerHandle, targetHandle, targetAgentName, tokensRead, createdAt, role, via, byOperator
        case handoffId
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.value(.id, ""); question = c.value(.question, ""); status = c.value(.status, "routing")
        answer = c.maybe(.answer); note = c.maybe(.note); askerHandle = c.value(.askerHandle, "")
        targetHandle = c.maybe(.targetHandle); targetAgentName = c.maybe(.targetAgentName)
        tokensRead = c.maybe(.tokensRead); createdAt = c.value(.createdAt, 0); role = c.value(.role, "asked")
        via = c.maybe(.via); byOperator = c.value(.byOperator, false); handoffId = c.maybe(.handoffId)
    }
}

extension FeedEvent {
    enum CodingKeys: String, CodingKey {
        case id = "_id", kind, handle, otherHandle, me, otherMe, tokensSaved, xp, rally, at
        case text, url, fromCustomer, handoffId, ledgerId, noteId, dropId, digestId, about, expiresAt
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.value(.id, ""); kind = c.value(.kind, ""); handle = c.value(.handle, ""); otherHandle = c.maybe(.otherHandle)
        me = c.value(.me, false); otherMe = c.value(.otherMe, false); tokensSaved = c.maybe(.tokensSaved)
        xp = c.maybe(.xp); rally = c.maybe(.rally); at = c.value(.at, 0)
        text = c.maybe(.text); url = c.maybe(.url); fromCustomer = c.value(.fromCustomer, false)
        handoffId = c.maybe(.handoffId); ledgerId = c.maybe(.ledgerId); noteId = c.maybe(.noteId); dropId = c.maybe(.dropId)
        digestId = c.maybe(.digestId); about = c.maybe(.about); expiresAt = c.maybe(.expiresAt)
    }
}

extension Saved {
    enum CodingKeys: String, CodingKey { case you, yourAgents, crew }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        you = c.value(.you, 0); yourAgents = c.value(.yourAgents, 0); crew = c.value(.crew, 0)
    }
}

extension LocalInfo {
    enum CodingKeys: String, CodingKey {
        case machine, paired, version, latest, newer, releaseUrl, autoUpdate, canUpdate, updating, updateError, autoOpen
        case ledgerLines, scout, handoffDailyUsd
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        machine = c.value(.machine, ""); paired = c.value(.paired, false); version = c.value(.version, "")
        latest = c.maybe(.latest); newer = c.value(.newer, false); releaseUrl = c.maybe(.releaseUrl)
        autoUpdate = c.value(.autoUpdate, true); canUpdate = c.value(.canUpdate, false)
        updating = c.value(.updating, false); updateError = c.maybe(.updateError); autoOpen = c.value(.autoOpen, true)
        ledgerLines = c.value(.ledgerLines, true); scout = c.value(.scout, false); handoffDailyUsd = c.value(.handoffDailyUsd, 10)
    }
}

extension CrewMember {
    enum CodingKeys: String, CodingKey { case handle, name, role, joinedAt }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        handle = c.value(.handle, ""); name = c.maybe(.name); role = c.value(.role, "member"); joinedAt = c.value(.joinedAt, 0)
    }
}

extension CrewInfo {
    enum CodingKeys: String, CodingKey {
        case id = "_id", name, plan, planUntil, leaderHandle, iAmLeader, digestHour, timezone, slackConnected, slackMirror
        case slackError, slackPostedAt, intercomConnected, intercomWebhookUrl, trustedNotePosters, members
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.value(.id, ""); name = c.value(.name, ""); plan = c.value(.plan, "free"); planUntil = c.maybe(.planUntil)
        leaderHandle = c.value(.leaderHandle, ""); iAmLeader = c.value(.iAmLeader, false)
        digestHour = c.value(.digestHour, 9); timezone = c.value(.timezone, "UTC")
        slackConnected = c.value(.slackConnected, false); slackMirror = c.value(.slackMirror, false)
        slackError = c.maybe(.slackError); slackPostedAt = c.maybe(.slackPostedAt)
        intercomConnected = c.value(.intercomConnected, false); intercomWebhookUrl = c.maybe(.intercomWebhookUrl)
        trustedNotePosters = c.value(.trustedNotePosters, []); members = c.value(.members, [])
    }
}

extension Numbers {
    enum CodingKeys: String, CodingKey { case answered, tokensSaved, handoffs, headsups, ships, walkthroughs, days }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        answered = c.value(.answered, 0); tokensSaved = c.value(.tokensSaved, 0); handoffs = c.value(.handoffs, 0)
        headsups = c.value(.headsups, 0); ships = c.value(.ships, 0); walkthroughs = c.value(.walkthroughs, 0)
        days = c.value(.days, 7)
    }
}

extension Costs {
    enum CodingKeys: String, CodingKey { case month, operatorUsd, digestUsd }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        month = c.value(.month, ""); operatorUsd = c.value(.operatorUsd, 0); digestUsd = c.value(.digestUsd, 0)
    }
}

extension LedgerLine {
    enum CodingKeys: String, CodingKey {
        case id = "_id", at, harness, machineName, sessionKey, workspace, branch, did, areas, files, pr, shipped
        case walkthrough, walkthroughAsked, editedByOwner
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.value(.id, ""); at = c.value(.at, 0); harness = c.value(.harness, ""); machineName = c.value(.machineName, "")
        sessionKey = c.value(.sessionKey, ""); workspace = c.maybe(.workspace); branch = c.maybe(.branch)
        did = c.value(.did, ""); areas = c.value(.areas, []); files = c.value(.files, 0); pr = c.maybe(.pr)
        shipped = c.value(.shipped, false); walkthrough = c.maybe(.walkthrough)
        walkthroughAsked = c.value(.walkthroughAsked, false); editedByOwner = c.value(.editedByOwner, false)
    }
}

extension Note {
    enum CodingKeys: String, CodingKey {
        case id = "_id", text, tags, authorHandle, authorName, status, proposedByAgent, appliesWhen, confirmBy, replaces
        case createdAt, updatedAt, confirmedAt, retiredAt, nudge, stale
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.value(.id, ""); text = c.value(.text, ""); tags = c.value(.tags, [])
        authorHandle = c.value(.authorHandle, ""); authorName = c.maybe(.authorName); status = c.value(.status, "live")
        proposedByAgent = c.value(.proposedByAgent, false); appliesWhen = c.maybe(.appliesWhen)
        confirmBy = c.maybe(.confirmBy); replaces = c.maybe(.replaces)
        createdAt = c.value(.createdAt, 0); updatedAt = c.value(.updatedAt, 0)
        confirmedAt = c.maybe(.confirmedAt); retiredAt = c.maybe(.retiredAt)
        nudge = c.value(.nudge, false); stale = c.value(.stale, false)
    }
}

extension NotesList {
    enum CodingKeys: String, CodingKey { case live, proposed, retired }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        live = c.value(.live, []); proposed = c.value(.proposed, []); retired = c.value(.retired, [])
    }
}

extension IncomingHandoff {
    enum CodingKeys: String, CodingKey {
        case id = "_id", fromHandle, fromName, text, why, targetAgentId, targetAgentName, targetMachine, status
        case createdAt, expiresAt, via
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.value(.id, ""); fromHandle = c.value(.fromHandle, ""); fromName = c.maybe(.fromName)
        text = c.value(.text, ""); why = c.maybe(.why); targetAgentId = c.maybe(.targetAgentId)
        targetAgentName = c.maybe(.targetAgentName); targetMachine = c.maybe(.targetMachine)
        status = c.value(.status, "offered"); createdAt = c.value(.createdAt, 0); expiresAt = c.value(.expiresAt, 0)
        via = c.maybe(.via)
    }
}

extension OutgoingHandoff {
    enum CodingKeys: String, CodingKey {
        case id = "_id", toHandle, text, status, summary, links, note, createdAt, decidedAt, finishedAt, targetAgentName
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.value(.id, ""); toHandle = c.value(.toHandle, ""); text = c.value(.text, "")
        status = c.value(.status, "offered"); summary = c.maybe(.summary); links = c.value(.links, [])
        note = c.maybe(.note); createdAt = c.value(.createdAt, 0); decidedAt = c.maybe(.decidedAt)
        finishedAt = c.maybe(.finishedAt); targetAgentName = c.maybe(.targetAgentName)
    }
}

extension HandoffsList {
    enum CodingKeys: String, CodingKey { case incoming, outgoing }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        incoming = c.value(.incoming, []); outgoing = c.value(.outgoing, [])
    }
}

extension Consent {
    enum CodingKeys: String, CodingKey { case handle, name, mode }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        handle = c.value(.handle, ""); name = c.maybe(.name); mode = c.value(.mode, "ask")
    }
}

extension Headsup {
    enum CodingKeys: String, CodingKey {
        case id = "_id", otherHandle, otherName, otherAgentId, otherAgentName, kind, line, at, expiresAt
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.value(.id, ""); otherHandle = c.value(.otherHandle, ""); otherName = c.maybe(.otherName)
        otherAgentId = c.value(.otherAgentId, ""); otherAgentName = c.maybe(.otherAgentName)
        kind = c.value(.kind, "area"); line = c.value(.line, ""); at = c.value(.at, 0); expiresAt = c.value(.expiresAt, 0)
    }
}

extension Digest {
    enum CodingKeys: String, CodingKey { case id = "_id", day, text, writtenAt, postedAt, postError }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.value(.id, ""); day = c.value(.day, ""); text = c.value(.text, ""); writtenAt = c.value(.writtenAt, 0)
        postedAt = c.maybe(.postedAt); postError = c.maybe(.postError)
    }
}

extension DigestInfo {
    enum CodingKeys: String, CodingKey { case daily, weekly }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        daily = c.maybe(.daily); weekly = c.maybe(.weekly)
    }
}

extension Drop {
    enum CodingKeys: String, CodingKey { case id = "_id", title, kind, url, byHandle, byName, createdAt, size, ledgerId, canForget }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.value(.id, ""); title = c.value(.title, ""); kind = c.value(.kind, "page"); url = c.value(.url, "")
        byHandle = c.value(.byHandle, ""); byName = c.maybe(.byName); createdAt = c.value(.createdAt, 0); size = c.value(.size, 0)
        ledgerId = c.maybe(.ledgerId); canForget = c.value(.canForget, false)
    }
}

extension AppState {
    enum CodingKeys: String, CodingKey {
        case version, phase, message, me, board, crew, requests, incoming, sent, subset, routing, wire, local, inviteWaiting, flicks, chat, feed, saved
        case crewInfo, numbers, costs, ledger, notes, handoffs, consents, headsups, digest, drops
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = c.value(.version, ""); phase = c.value(.phase, "signed-out"); message = c.maybe(.message)
        me = c.maybe(.me); board = c.value(.board, []); crew = c.value(.crew, []); requests = c.value(.requests, [])
        incoming = c.value(.incoming, Incoming()); sent = c.value(.sent, []); subset = c.value(.subset, [])
        routing = c.value(.routing, []); wire = c.value(.wire, []); local = c.maybe(.local); inviteWaiting = c.value(.inviteWaiting, false)
        flicks = c.value(.flicks, Flicks()); chat = c.value(.chat, []); feed = c.value(.feed, []); saved = c.maybe(.saved)
        crewInfo = c.maybe(.crewInfo); numbers = c.maybe(.numbers); costs = c.maybe(.costs); ledger = c.value(.ledger, [])
        notes = c.value(.notes, NotesList()); handoffs = c.value(.handoffs, HandoffsList()); consents = c.value(.consents, [])
        headsups = c.value(.headsups, []); digest = c.value(.digest, DigestInfo()); drops = c.value(.drops, [])
    }
}
