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

    var inFlight: Bool { status == "routing" || status == "reading" }
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
    enum CodingKeys: String, CodingKey { case handle, me, xp, rank, rankAt, nextRankAt, assists, asks, tier }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        handle = c.value(.handle, ""); me = c.value(.me, false); xp = c.value(.xp, 0); rank = c.value(.rank, "n00b")
        rankAt = c.value(.rankAt, 0); nextRankAt = c.maybe(.nextRankAt); assists = c.value(.assists, 0)
        asks = c.value(.asks, 0); tier = c.maybe(.tier)
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
    enum CodingKeys: String, CodingKey { case handle, led, inFocus, agentCount, agents, superset, relaying }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        handle = c.value(.handle, ""); led = c.value(.led, "x"); inFocus = c.value(.inFocus, false)
        agentCount = c.value(.agentCount, 0); agents = c.maybe(.agents); superset = c.maybe(.superset)
        relaying = c.value(.relaying, false)
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

extension RoutingSummary {
    enum CodingKeys: String, CodingKey { case agentId, summary }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agentId = c.value(.agentId, ""); summary = c.value(.summary, "")
    }
}

extension AgentState {
    enum CodingKeys: String, CodingKey { case agentId, name, workspace, status, open }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agentId = c.value(.agentId, ""); name = c.value(.name, ""); workspace = c.maybe(.workspace)
        status = c.value(.status, "idle"); open = c.value(.open, true)
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
        case id = "_id", question, status, answer, note, askerHandle, targetHandle, targetAgentName, tokensRead, createdAt, role
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.value(.id, ""); question = c.value(.question, ""); status = c.value(.status, "routing")
        answer = c.maybe(.answer); note = c.maybe(.note); askerHandle = c.value(.askerHandle, "")
        targetHandle = c.maybe(.targetHandle); targetAgentName = c.maybe(.targetAgentName)
        tokensRead = c.maybe(.tokensRead); createdAt = c.value(.createdAt, 0); role = c.value(.role, "asked")
    }
}

extension LocalInfo {
    enum CodingKeys: String, CodingKey {
        case machine, paired, version, latest, newer, releaseUrl, autoUpdate, canUpdate, updating, updateError
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        machine = c.value(.machine, ""); paired = c.value(.paired, false); version = c.value(.version, "")
        latest = c.maybe(.latest); newer = c.value(.newer, false); releaseUrl = c.maybe(.releaseUrl)
        autoUpdate = c.value(.autoUpdate, true); canUpdate = c.value(.canUpdate, false)
        updating = c.value(.updating, false); updateError = c.maybe(.updateError)
    }
}

extension AppState {
    enum CodingKeys: String, CodingKey {
        case version, phase, message, me, board, crew, requests, incoming, sent, subset, routing, wire, local, inviteWaiting
    }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = c.value(.version, ""); phase = c.value(.phase, "signed-out"); message = c.maybe(.message)
        me = c.maybe(.me); board = c.value(.board, []); crew = c.value(.crew, []); requests = c.value(.requests, [])
        incoming = c.value(.incoming, Incoming()); sent = c.value(.sent, []); subset = c.value(.subset, [])
        routing = c.value(.routing, []); wire = c.value(.wire, []); local = c.maybe(.local); inviteWaiting = c.value(.inviteWaiting, false)
    }
}
