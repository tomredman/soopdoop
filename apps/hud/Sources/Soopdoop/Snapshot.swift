// ABOUTME: Draws the HUD with sample states into PNG files (`Soopdoop --snapshot <dir>`), to check the layout without a screen.
// ABOUTME: Each is drawn on a dark and on a light backdrop: glass shows what is behind it, so text must read on both.
import AppKit
import SwiftUI

@MainActor
enum Snapshot {
    static func run(into dir: String) {
        _ = NSApplication.shared
        let style = HUDStyle()
        // This Mac is off by default; the snapshot shows it, private switches included, and the Operator opened. The crew
        // sections keep their defaults: hand-offs and notes open, the ledger folded.
        style.showMachine = true
        style.machineFolded = false
        style.operatorOpen = true
        style.handoffsOpen = true
        style.notesOpen = true
        style.ledgerOpen = false
        // Off screen there is no desktop to blur, so the backdrop stands in for what is behind the glass.
        let backdrops: [(String, Color)] = [("", Theme.ground), ("-light", Color(white: 0.82))]
        func file(_ name: String) -> URL { URL(fileURLWithPath: dir).appendingPathComponent(name) }
        for (name, state) in samples() {
            for (suffix, backdrop) in backdrops {
                draw(state, height: name == "ready" ? 1260 : 420, on: backdrop, style: style, to: file("hud-\(name)\(suffix).png"),
                     toast: name == "ready" ? "@mira flicked you. You gonna just take that? Catch it!" : nil)
            }
        }
        let ready = samples().first { $0.0 == "ready" }?.1 ?? AppState()
        // The whole HUD with every section on, tall enough that nothing scrolls away: what a long day looks like.
        for (suffix, backdrop) in backdrops {
            draw(ready, height: 3000, on: backdrop, style: style, to: file("hud-ready-full\(suffix).png"))
        }
        // The same HUD with the Operator and This Mac folded to their headers.
        style.operatorOpen = false
        style.machineFolded = true
        draw(ready, height: 1000, on: Theme.ground, style: style, to: file("hud-folded.png"))
        style.operatorOpen = true
        style.machineFolded = false
        // No request on screen: the walkthrough question for the newest ship waits at the top instead.
        var quiet = ready
        quiet.incoming = Incoming()
        quiet.headsups = []
        quiet.handoffs.incoming = ready.handoffs.incoming.filter { $0.status != "offered" }
        for (suffix, backdrop) in backdrops {
            draw(quiet, height: 640, on: backdrop, style: style, to: file("hud-notice\(suffix).png"))
        }
        // The request cards at the HUD's default and narrowest widths: a hand-off for a named agent, one that names none
        // (pick an agent), one being answered with a note, a heads-up, and a heads-up being handed off.
        let client = AgentClient(preview: ready)
        for width in [300.0, 260.0] {
            let cards = VStack(alignment: .leading, spacing: 10) {
                ForEach(ready.handoffs.incoming.filter { $0.status == "offered" }) { offer in
                    HandoffCard(offer: offer, state: ready, pending: 2)
                }
                HandoffCard(offer: unnamedOffer(now: Date().timeIntervalSince1970 * 1000), state: ready, pending: 0)
                if let offer = ready.handoffs.incoming.first(where: { $0.status == "offered" }) {
                    HandoffCard(offer: offer, state: ready, pending: 0, replying: true)
                }
                if let card = ready.headsups.first {
                    HeadsupCard(headsup: card, pending: 1)
                    HeadsupCard(headsup: card, pending: 0, handingOff: true)
                }
            }
            for (suffix, backdrop) in backdrops {
                let page = ZStack(alignment: .top) {
                    backdrop
                    Background()
                    cards.padding(11)
                }
                render(page.environmentObject(client).environmentObject(style), size: NSSize(width: width, height: 1500),
                       to: file("hud-cards-\(Int(width))\(suffix).png"))
            }
        }
        // The crew sections opened all the way: the wire's every kind, yesterday's digest, hand-offs, crew notes with the add
        // box and an edit open, and This Mac's ledger with an edit, a delete to confirm and a walkthrough being written.
        style.ledgerOpen = true
        if let line = ready.ledger.first(where: { LedgerRow.asks($0) }) { HUDWork.shared.writing = [line.id] }
        let wire = VStack(alignment: .leading, spacing: style.pad) {
            WireSection(state: ready, all: true)
            YesterdaySection(digest: ready.digest, open: true)
        }
        let crew = VStack(alignment: .leading, spacing: style.pad) {
            HandoffsSection(state: ready, composing: true)
            NotesSection(state: ready, adding: true, editing: "n2")
        }
        // This Mac with its ledger open (the newest ship's walkthrough being written), then a line being edited and one
        // waiting for its delete to be confirmed.
        let mac = VStack(alignment: .leading, spacing: style.pad) {
            MachineSection(state: ready)
            Rectangle().fill(Theme.line).frame(height: 1)
            ForEach(ready.ledger.dropFirst().prefix(1)) { line in LedgerRow(line: line, editing: true) }
            ForEach(ready.ledger.dropFirst(2).prefix(1)) { line in LedgerRow(line: line, forgetting: true) }
        }
        for (name, view, height) in [("wire", AnyView(wire), 1200.0), ("crew", AnyView(crew), 1300.0), ("mac", AnyView(mac), 1300.0)] {
            for (suffix, backdrop) in backdrops {
                let page = ZStack(alignment: .top) {
                    backdrop
                    Background()
                    view.padding(11)
                }
                render(page.environmentObject(client).environmentObject(style), size: NSSize(width: 300, height: height),
                       to: file("hud-\(name)\(suffix).png"))
            }
        }
        HUDWork.shared.writing = []
        style.ledgerOpen = false
        // Drops at the HUD's default and narrowest widths: the whole shelf opened, my own link waiting for its forget to be
        // confirmed; the link box filled in, and after Enter with a link that is not https; the leader forgetting a
        // crewmate's stored page; then an empty shelf on the free plan. (hud-ready-full shows it folded to four.)
        var free = ready
        free.drops = []
        free.crewInfo?.plan = "free"
        var stored = ready.drops.first { $0.id == "dr4" } ?? Drop()
        stored.canForget = true
        for width in [300.0, 260.0] {
            let drops = VStack(alignment: .leading, spacing: style.pad) {
                DropsSection(state: ready, all: true, forgetting: "dr2")
                Rectangle().fill(Theme.line).frame(height: 1)
                DropLinkBox(link: "https://superset.sh/pages/menu-redesign", title: "the menu page walkthrough")
                DropLinkBox(link: "http://example.com/notes", title: "old notes", tried: true)
                Rectangle().fill(Theme.line).frame(height: 1)
                DropRow(drop: stored, mine: false, now: Date().timeIntervalSince1970 * 1000, forgetting: .constant(stored.id))
                Rectangle().fill(Theme.line).frame(height: 1)
                DropsSection(state: free)
            }
            for (suffix, backdrop) in backdrops {
                let page = ZStack(alignment: .top) {
                    backdrop
                    Background()
                    drops.padding(11)
                }
                render(page.environmentObject(client).environmentObject(style), size: NSSize(width: width, height: 1000),
                       to: file("hud-drops-\(Int(width))\(suffix).png"))
            }
        }
        // The Operator chat, with a reply of its own, an answer from a crewmate's agent, and a question on its way.
        var chatting = AppState()
        chatting.phase = "ready"
        let now = Date().timeIntervalSince1970 * 1000
        chatting.chat = [
            Relay(id: "c1", question: "who's around?", status: "answered", answer: "Jimmy's two agents are on the market update, and Mira is fixing checkout. Dev is offline.",
                  askerHandle: "tom", createdAt: now - 120_000, role: "asked", via: "chat", byOperator: true),
            Relay(id: "c2", question: "where does jimmy filter expired listings?", status: "answered",
                  answer: "In convex/marketUpdate/select.ts: expired listings are dropped by listDate before the closest six are picked.",
                  askerHandle: "tom", targetHandle: "jimmy", targetAgentName: "listing-cards", createdAt: now - 60_000, role: "asked", via: "chat"),
            Relay(id: "c3", question: "and is that tested?", status: "reading", askerHandle: "tom", targetHandle: "jimmy", createdAt: now - 2_000, role: "asked", via: "chat"),
        ]
        let chat = OperatorChat().environmentObject(AgentClient(preview: chatting)).environmentObject(style)
        render(chat, size: NSSize(width: 380, height: 520), to: file("chat.png"))
        // A heads-up's Ask: the chat opens with the crewmate's handle typed in.
        let draft = ChatDraft()
        draft.text = "@jimmy: "
        let asking = OperatorChat(draft: draft).environmentObject(AgentClient(preview: chatting)).environmentObject(style)
        render(asking, size: NSSize(width: 380, height: 520), to: file("chat-ask.png"))
        // Settings → HUD: opening with Superset, and the sections, which can be hidden and put in order.
        let look = LookSettings().environmentObject(AgentClient(preview: ready)).environmentObject(style)
        render(look, size: NSSize(width: 460, height: 700), to: file("settings-hud.png"))
        // Settings → Account before a Superset profile is linked: the box to type the handle in has to show.
        var signedIn = AppState()
        signedIn.phase = "ready"
        signedIn.me = Me(handle: "tom")
        let account = AccountSettings().environmentObject(AgentClient(preview: signedIn)).environmentObject(style)
        render(account, size: NSSize(width: 460, height: 560), to: file("settings-account.png"))
        // The knock composer at the HUD's default and narrowest widths: its buttons must never wrap.
        let empty = AgentClient(preview: AppState())
        for width in [300.0, 260.0] {
            let composer = ZStack(alignment: .top) {
                Theme.ground
                KnockComposer(handle: "jimmy", composing: .constant("jimmy")).padding(11)
            }
            render(composer.environmentObject(empty).environmentObject(style), size: NSSize(width: width, height: 170),
                   to: file("hud-knock-\(Int(width)).png"))
        }
    }

    private static func draw(_ state: AppState, height: CGFloat, on backdrop: Color, style: HUDStyle, to file: URL, toast: String? = nil) {
        let client = AgentClient(preview: state)
        client.toast = toast
        let root = ZStack {
            backdrop
            HUDRoot().environmentObject(client).environmentObject(style)
        }
        render(root, size: NSSize(width: 300, height: height), to: file)
    }

    private static func render(_ root: some View, size: NSSize, to file: URL) {
        // A real (off-screen) window, so AppKit-backed views (scrolling, text fields) draw as they do on screen.
        let host = NSHostingView(rootView: root.frame(width: size.width, height: size.height))
        host.frame = NSRect(origin: .zero, size: size)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        window.appearance = NSAppearance(named: .darkAqua)
        host.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        guard let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else {
            print("could not draw \(file.lastPathComponent)")
            return
        }
        host.cacheDisplay(in: host.bounds, to: bitmap)
        guard let png = bitmap.representation(using: .png, properties: [:]) else { return }
        do {
            try png.write(to: file)
            print(file.path)
        } catch {
            print("could not write \(file.path): \(error)")
        }
    }

    // A hand-off that names none of my agents: I pick one before it can run.
    static func unnamedOffer(now: Double) -> IncomingHandoff {
        IncomingHandoff(id: "ho2", fromHandle: "grace", fromName: "Grace Hopper",
                        text: "Add a retry with backoff to the webhook sender in packages/email/send.ts, and a test that fails without it.",
                        status: "offered", createdAt: now - 20 * 60_000, expiresAt: now + 23 * 3_600_000 + 40 * 60_000, via: "operator")
    }

    static func samples() -> [(String, AppState)] {
        let now = Date().timeIntervalSince1970 * 1000
        let minute = 60_000.0
        let hour = 3_600_000.0
        let day = 24 * hour
        var signedOut = AppState()
        signedOut.phase = "signed-out"
        signedOut.inviteWaiting = true

        var handle = AppState()
        handle.phase = "needs-handle"

        var ready = AppState()
        ready.phase = "ready"
        ready.version = "0.2.0"
        ready.me = Me(handle: "tom", shareAgentNames: true, shareWorkspaceNames: false, focusUntil: nil, hideFromBoards: false, superset: nil)
        ready.board = [
            BoardRow(handle: "jimmy", me: false, xp: 31, rank: "script kiddie", rankAt: 20, nextRankAt: 100, assists: 3, asks: 1, tier: "Plant Manager"),
            BoardRow(handle: "tom", me: true, xp: 12, rank: "n00b", rankAt: 0, nextRankAt: 20, assists: 1, asks: 2, tier: nil),
            BoardRow(handle: "mira", me: false, xp: 2, rank: "n00b", rankAt: 0, nextRankAt: 20, assists: 0, asks: 2, tier: nil),
        ]
        let jimmyCard = SupersetCard(handle: "jimmyvibes", name: "Jimmy Mackin", tier: "Plant Manager",
                                     achievements: [Achievement(slug: "ship-it", level: 2, of: 4), Achievement(slug: "two-hands", level: 1, of: 3)],
                                     models: ["gpt-5.6-sol", "claude-opus-5", "claude-opus-5-5"])
        ready.crew = [
            Friend(handle: "jimmy", led: "g", inFocus: false, agentCount: 3,
                   agents: [FriendAgent(name: "listing-cards", workspace: "vibes", status: "working"), FriendAgent(name: "market-update", workspace: "vibes", status: "idle")],
                   superset: jimmyCard, relaying: false),
            Friend(handle: "mira", led: "b", inFocus: false, agentCount: 1, agents: nil, superset: nil, relaying: true),
            Friend(handle: "dev", led: "x", inFocus: false, agentCount: 0, agents: nil, superset: nil, relaying: false),
        ]
        ready.requests = [FriendRequest(handle: "ada-lovelace")]
        ready.flicks = Flicks(
            incoming: [
                IncomingFlick(id: "f2", fromHandle: "jimmy", rally: 0, expiresAt: now + 500_000, superflick: true, xp: 10),
                IncomingFlick(id: "f1", fromHandle: "mira", rally: 3, expiresAt: now + 400_000, catchUntil: now + 7_000),
            ],
            waitingOn: ["jimmy"],
            superflicks: Superflicks(ready: 1, clean: 0, every: 5)
        )
        ready.sent = [
            SentKnock(id: "s2", toHandle: "mira", outcome: "open", expiresAt: now + 18_000),
            SentKnock(id: "s1", toHandle: "jimmy", outcome: "opened", expiresAt: now - 60_000),
        ]
        ready.incoming = Incoming(
            current: Knock(id: "k1", fromHandle: "jimmy", item: KnockItem(kind: "link", title: "the coupon fix", url: "https://example.com/pr/1"),
                           note: "rounds half up now", expiresAt: now + 22_000, lifetimeMs: 30_000),
            pending: 1
        )
        ready.wire = [
            Relay(id: "r2", question: "How does the market update pick listings?", status: "reading", answer: nil, note: nil,
                  askerHandle: "tom", targetHandle: "mira", targetAgentName: nil, tokensRead: nil, createdAt: now - 4_000, role: "asked"),
            Relay(id: "r1", question: "Where are expired listings filtered?", status: "answered",
                  answer: "In convex/marketUpdate/select.ts: expired listings are dropped by listDate before the closest six are picked.",
                  note: nil, askerHandle: "tom", targetHandle: "jimmy", targetAgentName: "listing-cards", tokensRead: 14_200,
                  createdAt: now - 60_000, role: "asked"),
            Relay(id: "r0", question: "Which Convex index does knocks.send use?", status: "answered", answer: "by_to_outcome.",
                  note: nil, askerHandle: "jimmy", targetHandle: "tom", targetAgentName: "rail", tokensRead: 9_000,
                  createdAt: now - 600_000, role: "answered"),
        ]
        // Agents on all three tools, and one private project.
        ready.subset = [Machine(machineName: "mbp16", updatedAt: now, agents: [
            AgentState(agentId: "a", name: "seamless-onboarding", workspace: "soopdoop", status: "working", open: true, harness: "claude-code"),
            AgentState(agentId: "c", name: "email-metrics", workspace: "vibes", status: "idle", open: true, harness: "codex"),
            AgentState(agentId: "d", name: "release-notes", workspace: "vibes", status: "waiting", open: true, harness: "grok"),
            AgentState(agentId: "b", name: "taxes", workspace: nil, status: "idle", open: false, harness: "claude-code"),
        ])]
        ready.routing = [
            RoutingSummary(agentId: "a", summary: "soopdoop@claude/hud-operator · \"make onboarding seamless\" · files: apps/daemon/src/cli.ts"),
            RoutingSummary(agentId: "c", summary: "vibes@email-metrics · \"bounces counted twice\" · files: packages/email/metrics.ts"),
        ]
        ready.local = LocalInfo(machine: "mbp16", paired: true, version: "0.2.0", latest: "v0.2.1", newer: true,
                                releaseUrl: nil, autoUpdate: true, canUpdate: true, updating: false, updateError: nil)
        // The wire: every kind of line, newest first.
        ready.feed = [
            FeedEvent(id: "w1", kind: "shout", handle: "sam", at: now - 40_000, text: "CI is red on main, looking", expiresAt: now + 23 * hour),
            FeedEvent(id: "w2", kind: "answer", handle: "jimmy", otherHandle: "tom", me: false, otherMe: true, tokensSaved: 38_400, at: now - 70_000),
            FeedEvent(id: "w3", kind: "walkthrough", handle: "adalovelace", at: now - 2 * minute, text: "the quote page redesign",
                      url: "https://soopdoop.com/d/q412", ledgerId: "x412"),
            FeedEvent(id: "w4", kind: "ship", handle: "adalovelace", at: now - 3 * minute, text: "the quote page redesign",
                      url: "https://github.com/acme/vibes/pull/412", ledgerId: "x412"),
            FeedEvent(id: "w5", kind: "agent", handle: "mira", at: now - 4 * minute),
            FeedEvent(id: "w6", kind: "handoff", handle: "jimmy", otherHandle: "tom", otherMe: true, at: now - 12 * minute,
                      text: "fixed VIB-123: bounces are counted once now", url: "https://github.com/acme/vibes/pull/418", handoffId: "o1"),
            FeedEvent(id: "w7", kind: "props", handle: "tom", otherHandle: "jimmy", me: true, at: now - 11 * minute, about: "w6"),
            FeedEvent(id: "w8", kind: "headsup", handle: "tom", otherHandle: "jimmy", me: true, at: now - 20 * minute,
                      text: "Jimmy's agent is on email metrics right now (packages/email, apps/web/metrics)"),
            FeedEvent(id: "w9", kind: "note", handle: "adalovelace", at: now - 25 * minute,
                      text: "The quote page uses the M10 components. Do not touch the old Form.tsx.", noteId: "n1"),
            FeedEvent(id: "w10", kind: "catch", handle: "dev", otherHandle: "mira", xp: 5, at: now - 26 * minute),
            FeedEvent(id: "w11", kind: "props", handle: "grace", otherHandle: "adalovelace", at: now - 50 * minute, about: "w4"),
            FeedEvent(id: "w12", kind: "props", handle: "tom", me: true, at: now - 70 * minute, text: "thanked us for fixing their CSV export", fromCustomer: true),
            FeedEvent(id: "w13", kind: "props", handle: "grace", at: now - 80 * minute,
                      text: "got props from a customer: the export works again, thank you", fromCustomer: true),
            FeedEvent(id: "w14", kind: "save", handle: "grace", at: now - 100 * minute, text: "a long billing thread ended with thanks"),
            FeedEvent(id: "w15", kind: "answer", handle: "tom", otherHandle: "dev", me: true, tokensSaved: 52_000, at: now - 2 * hour),
            FeedEvent(id: "w16", kind: "rally", handle: "mira", otherHandle: "jimmy", rally: 5, at: now - 3 * hour),
            FeedEvent(id: "w17", kind: "digest", handle: "tom", me: true, at: now - 5 * hour,
                      text: "Yesterday in tom's crew: 3 ships, 2 hand-offs, 41 questions answered", digestId: "d1"),
        ].sorted { $0.at > $1.at }
        // All time, so more than the crew's last 7 days below.
        ready.saved = Saved(you: 3_240_000, yourAgents: 5_100_000, crew: 24_800_000)
        // The crew, its four numbers, and what it is doing together.
        ready.crewInfo = CrewInfo(id: "crew1", name: "tom's crew", plan: "team", leaderHandle: "adalovelace", iAmLeader: false,
                                  slackConnected: true, members: [
                                      CrewMember(handle: "adalovelace", name: "Ada Lovelace", role: "leader"),
                                      CrewMember(handle: "tom"), CrewMember(handle: "jimmy"), CrewMember(handle: "grace", name: "Grace Hopper"),
                                  ])
        ready.numbers = Numbers(answered: 212, tokensSaved: 9_100_000, handoffs: 14, headsups: 3, ships: 27, walkthroughs: 9, days: 7)
        ready.headsups = [
            Headsup(id: "h1", otherHandle: "jimmy", otherName: "Jimmy", otherAgentId: "jimmy-email", otherAgentName: "email-metrics", kind: "area",
                    line: "Jimmy's agent is on email metrics right now (packages/email, apps/web/metrics)", at: now - minute, expiresAt: now + 9 * minute),
            Headsup(id: "h2", otherHandle: "adalovelace", otherName: "Ada Lovelace", otherAgentId: "ada-quote", otherAgentName: "quote-redesign",
                    kind: "files", line: "Ada's agent is editing apps/web/quote/Form.tsx too", at: now - 4 * minute, expiresAt: now + 6 * minute),
        ]
        ready.handoffs = HandoffsList(
            incoming: [
                IncomingHandoff(id: "ho1", fromHandle: "adalovelace", fromName: "Ada Lovelace",
                                text: "Fix the double-counted bounces in delivery metrics (VIB-123)",
                                why: "your email-metrics agent has been in packages/email all morning",
                                targetAgentId: "c", targetAgentName: "email-metrics", targetMachine: "mbp16",
                                status: "offered", createdAt: now - 2 * hour, expiresAt: now + 22 * hour, via: "hud"),
                IncomingHandoff(id: "ho0", fromHandle: "jimmy", text: "Add the missing index on knocks by_to_outcome",
                                targetAgentId: "a", targetAgentName: "seamless-onboarding", targetMachine: "mbp16",
                                status: "accepted", createdAt: now - 3 * hour, expiresAt: now + 21 * hour, via: "headsup"),
            ],
            outgoing: [
                OutgoingHandoff(id: "o2", toHandle: "adalovelace", text: "Move the quote form to the M10 components", status: "running",
                                createdAt: now - hour, decidedAt: now - 50 * minute, targetAgentName: "quote-redesign"),
                OutgoingHandoff(id: "o1", toHandle: "jimmy", text: "Fix VIB-123: bounces counted twice in delivery metrics", status: "done",
                                summary: "Fixed VIB-123: bounces are counted once now, with a test for it.",
                                links: ["https://github.com/acme/vibes/pull/418"], createdAt: now - 5 * hour, decidedAt: now - 4 * hour,
                                finishedAt: now - 12 * minute, targetAgentName: "email-metrics"),
                OutgoingHandoff(id: "o3", toHandle: "grace", text: "Review the retry logic in the email sender", status: "declined",
                                note: "Out today, back Monday", createdAt: now - 20 * hour, decidedAt: now - 19 * hour),
                OutgoingHandoff(id: "o4", toHandle: "sam", text: "Write the changelog for v0.14", status: "expired", createdAt: now - 30 * hour),
            ]
        )
        ready.notes = NotesList(
            live: [
                Note(id: "n1", text: "The quote page uses the M10 components. Do not touch the old Form.tsx.", tags: ["design"],
                     authorHandle: "adalovelace", authorName: "Ada Lovelace", appliesWhen: "apps/web/quote", createdAt: now - 3 * day, updatedAt: now - 3 * day),
                Note(id: "n2", text: "Lob prices changed on Tuesday: postcards are $0.61, letters $0.89. Use lib/pricing.ts; never type a price in.",
                     tags: ["pricing"], authorHandle: "tom", createdAt: now - 5 * day, updatedAt: now - 5 * day),
                Note(id: "n5", text: "Ship small PRs, one area each.", tags: ["process"], authorHandle: "sam", createdAt: now - 10 * day, updatedAt: now - 10 * day),
                Note(id: "n6", text: "Jimmy is on call for the email sender until Friday.", tags: ["people"], authorHandle: "jimmy",
                     createdAt: now - 12 * day, updatedAt: now - 12 * day),
                Note(id: "n3", text: "Staging resets every Sunday at 02:00 UTC.", tags: ["infra"], authorHandle: "tom",
                     createdAt: now - 34 * day, updatedAt: now - 34 * day, nudge: true),
                Note(id: "n4", text: "Grace owns the email sender this week; ask her agent before changing retries.", tags: ["people"],
                     authorHandle: "grace", authorName: "Grace Hopper", createdAt: now - 50 * day, updatedAt: now - 50 * day, nudge: true, stale: true),
            ],
            proposed: [
                Note(id: "p1", text: "Run bun run lint before every commit in packages/convex.", tags: ["process"], authorHandle: "tom",
                     status: "proposed", proposedByAgent: true, appliesWhen: "packages/convex", createdAt: now - hour, updatedAt: now - hour),
            ]
        )
        ready.ledger = [
            LedgerLine(id: "l1", at: now - 2 * hour, harness: "codex", machineName: "mbp16", sessionKey: "s1", workspace: "vibes", branch: "email-metrics",
                       did: "fixed delivery counts double-counting bounces", areas: ["packages/email", "apps/web/metrics"], files: 6,
                       pr: "https://github.com/acme/vibes/pull/418", shipped: true),
            LedgerLine(id: "l2", at: now - day, harness: "claude-code", machineName: "mbp16", sessionKey: "s2", workspace: "soopdoop", branch: "main",
                       did: "v0.13.1: Settings → Account box for the Superset handle", areas: ["apps/hud"], files: 2,
                       pr: "https://github.com/acme/soopdoop/pull/88", shipped: true, walkthrough: "https://soopdoop.com/d/s88", walkthroughAsked: true),
            LedgerLine(id: "l3", at: now - 2 * day, harness: "grok", machineName: "mbp16", sessionKey: "s3", workspace: "vibes", branch: "release-notes",
                       did: "drafted the October release notes", areas: ["docs"], files: 1, editedByOwner: true),
        ]
        // The crew's shelf, newest first: walkthroughs and pages soopdoop keeps on Team, and links to pages elsewhere (size
        // 0). The leader is Ada, so only my own drops can be forgotten here.
        ready.drops = [
            Drop(id: "dr1", title: "the quote page redesign", kind: "walkthrough", url: "https://soopdoop.com/d/q412",
                 byHandle: "adalovelace", byName: "Ada Lovelace", createdAt: now - 2 * minute, size: 184_000, ledgerId: "x412"),
            Drop(id: "dr2", title: "Pricing page draft", kind: "page", url: "https://soopdoop.com/d/p207", byHandle: "tom",
                 createdAt: now - 2 * hour, canForget: true),
            Drop(id: "dr3", title: "VIB-123: bounces are counted once now", kind: "walkthrough", url: "https://soopdoop.com/d/v123",
                 byHandle: "jimmy", createdAt: now - 5 * hour, size: 96_000),
            Drop(id: "dr4", title: "Onboarding checklist for a new crewmate, with the steps for Codex and Grok", kind: "page",
                 url: "https://soopdoop.com/d/o118", byHandle: "grace", byName: "Grace Hopper", createdAt: now - day - 3 * hour, size: 41_000),
            Drop(id: "dr5", title: "Design review notes", kind: "page", url: "https://soopdoop.com/d/r31", byHandle: "sam",
                 createdAt: now - 3 * day),
            Drop(id: "dr6", title: "export-sample.csv", kind: "file", url: "https://soopdoop.com/d/e9", byHandle: "tom",
                 createdAt: now - 9 * day, size: 1_200_000, canForget: true),
        ]
        let yesterday = DateFormatter()
        yesterday.locale = Locale(identifier: "en_US_POSIX")
        yesterday.dateFormat = "yyyy-MM-dd"
        ready.digest = DigestInfo(
            daily: Digest(id: "d1", day: yesterday.string(from: Date(timeIntervalSince1970: (now - day) / 1000)), text: """
                Yesterday in tom's crew: 3 ships, 2 hand-offs, 41 questions answered
                • Ada shipped the quote page redesign (https://github.com/acme/vibes/pull/412) · walkthrough: https://soopdoop.com/d/q412
                • Jimmy's agent did Tom's hand-off: fixed VIB-123 (https://github.com/acme/vibes/pull/418)
                • 41 questions answered by crewmates' agents, about 2.1M tokens saved
                • 1 heads-up acted on: Tom checked with Jimmy first
                • Grace got props from a customer: the export works again
                • Ada added a crew note: the quote page uses M10 components
                """, writtenAt: now - 5 * hour, postedAt: now - 5 * hour),
            weekly: Digest(id: "d0", day: yesterday.string(from: Date(timeIntervalSince1970: (now - 6 * day) / 1000)), text: """
                This week in tom's crew
                • 212 questions answered by crewmates' agents, about 9.1M tokens saved
                • 14 hand-offs done by the agent that knew the area
                • 3 heads-ups acted on: duplicate or clashing work caught early
                • 27 ships, 9 with walkthroughs
                """, writtenAt: now - 6 * day, postedAt: now - 6 * day)
        )
        return [("signed-out", signedOut), ("handle", handle), ("ready", ready)]
    }
}
