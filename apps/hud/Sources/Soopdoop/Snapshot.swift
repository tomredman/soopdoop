// ABOUTME: Draws the HUD with sample states into PNG files (`Soopdoop --snapshot <dir>`), to check the layout without a screen.
// ABOUTME: Each is drawn on a dark and on a light backdrop: glass shows what is behind it, so text must read on both.
import AppKit
import SwiftUI

@MainActor
enum Snapshot {
    static func run(into dir: String) {
        _ = NSApplication.shared
        let style = HUDStyle()
        // This Mac is off by default; the snapshot shows it, private switches included.
        style.showMachine = true
        // Off screen there is no desktop to blur, so the backdrop stands in for what is behind the glass.
        let backdrops: [(String, Color)] = [("", Theme.ground), ("-light", Color(white: 0.82))]
        for (name, state) in samples() {
            for (suffix, backdrop) in backdrops {
                let file = URL(fileURLWithPath: dir).appendingPathComponent("hud-\(name)\(suffix).png")
                draw(state, height: name == "ready" ? 1260 : 420, on: backdrop, style: style, to: file)
            }
        }
        // Settings → HUD: the sections, which can be hidden and put in order.
        let look = LookSettings().environmentObject(style)
        render(look, size: NSSize(width: 460, height: 520), to: URL(fileURLWithPath: dir).appendingPathComponent("settings-hud.png"))
        // The knock composer at the HUD's default and narrowest widths: its buttons must never wrap.
        let client = AgentClient(preview: AppState())
        for width in [300.0, 260.0] {
            let composer = ZStack(alignment: .top) {
                Theme.ground
                KnockComposer(handle: "jimmy", composing: .constant("jimmy")).padding(11)
            }
            let file = URL(fileURLWithPath: dir).appendingPathComponent("hud-knock-\(Int(width)).png")
            render(composer.environmentObject(client).environmentObject(style), size: NSSize(width: width, height: 170), to: file)
        }
    }

    private static func draw(_ state: AppState, height: CGFloat, on backdrop: Color, style: HUDStyle, to file: URL) {
        let client = AgentClient(preview: state)
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

    static func samples() -> [(String, AppState)] {
        let now = Date().timeIntervalSince1970 * 1000
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
        ready.subset = [Machine(machineName: "mbp16", updatedAt: now, agents: [
            AgentState(agentId: "a", name: "seamless-onboarding", workspace: "soopdoop", status: "working", open: true),
            AgentState(agentId: "b", name: "taxes", workspace: nil, status: "idle", open: false),
        ])]
        ready.routing = [RoutingSummary(agentId: "a", summary: "soopdoop@claude/hud-operator · \"make onboarding seamless\" · files: apps/daemon/src/cli.ts")]
        ready.local = LocalInfo(machine: "mbp16", paired: true, version: "0.2.0", latest: "v0.2.1", newer: true,
                                releaseUrl: nil, autoUpdate: true, canUpdate: true, updating: false, updateError: nil)
        return [("signed-out", signedOut), ("handle", handle), ("ready", ready)]
    }
}
