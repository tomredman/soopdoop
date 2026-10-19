// ABOUTME: Made-up crews for checking the menu bar by eye. `Soopdoop --sample` runs the app on one without connecting to this
// ABOUTME: Mac's rail; `--sample-open menu|handoff|shout|keys|keys-handoff` opens one; `--sample-shots <dir>` draws it to PNGs.
import AppKit
import SwiftUI

@MainActor
enum MenuSamples {
    // The state `--sample` starts with; nil when the app runs for real.
    static let launching: AppState? = CommandLine.arguments.contains("--sample") ? leader() : nil

    // Mr. Tom leads a free crew of five: Ada working, Jimmy idle and answering one of his questions, Grace in focus, Sam
    // off. Ada offered him a hand-off, and yesterday's digest is in.
    static func leader(now: Date = Date()) -> AppState {
        let ms = now.timeIntervalSince1970 * 1000
        var s = AppState()
        s.phase = "ready"
        s.version = "0.14.0"
        s.me = Me(handle: "tom", shareAgentNames: true, shareWorkspaceNames: true)
        s.board = [
            BoardRow(handle: "adalovelace", xp: 530, rank: "hacker", rankAt: 400, nextRankAt: 1_000, assists: 12, asks: 4),
            BoardRow(handle: "tom", me: true, xp: 412, rank: "hacker", rankAt: 400, nextRankAt: 1_000, assists: 9, asks: 14),
        ]
        s.crew = [
            Friend(handle: "adalovelace", led: "g", agentCount: 4,
                   summary: "quote-app@redesign · \"redo the quote page so the totals line up on phones\" · files: apps/web/quote/page.tsx",
                   lastSeenAt: ms - 20_000),
            Friend(handle: "grace", inFocus: true),
            Friend(handle: "jimmy", led: "b", agentCount: 2, relaying: true,
                   summary: "vibes@email-metrics · \"fix the double-counted bounces in delivery metrics\"", lastSeenAt: ms - 40_000),
            Friend(handle: "sam", led: "x", lastSeenAt: ms - 150 * 60_000),
        ]
        s.crewInfo = CrewInfo(
            id: "crew1", name: "tom's crew", plan: "free", leaderHandle: "tom", iAmLeader: true, digestHour: 9,
            timezone: "America/Toronto", slackConnected: true, slackMirror: false, slackPostedAt: ms - 26 * 3_600_000,
            intercomConnected: false, intercomWebhookUrl: "https://example-123.convex.site/intercom/webhook?crew=crew1",
            trustedNotePosters: ["adalovelace"],
            members: [
                CrewMember(handle: "tom", role: "leader", joinedAt: ms - 30 * 86_400_000),
                CrewMember(handle: "adalovelace", name: "Ada Lovelace", joinedAt: ms - 29 * 86_400_000),
                CrewMember(handle: "jimmy", name: "Jimmy", joinedAt: ms - 20 * 86_400_000),
                CrewMember(handle: "grace", name: "Grace Hopper", joinedAt: ms - 12 * 86_400_000),
                CrewMember(handle: "sam", joinedAt: ms - 3 * 86_400_000),
            ]
        )
        s.numbers = Numbers(answered: 41, tokensSaved: 9_200_000, handoffs: 2, headsups: 3, ships: 3, walkthroughs: 1, days: 7)
        s.costs = Costs(month: month(now), operatorUsd: 1.42, digestUsd: 0.31)
        s.handoffs = HandoffsList(incoming: [
            IncomingHandoff(id: "h1", fromHandle: "adalovelace", fromName: "Ada Lovelace",
                            text: "Add the VAT line to the quote PDF, the same way the web page shows it.",
                            targetAgentName: "pdf-export", status: "offered", createdAt: ms - 15 * 60_000, expiresAt: ms + 23 * 3_600_000, via: "menu"),
        ])
        s.consents = [
            Consent(handle: "adalovelace", name: "Ada Lovelace", mode: "ask"),
            Consent(handle: "grace", name: "Grace Hopper", mode: "ask"),
            Consent(handle: "jimmy", name: "Jimmy", mode: "auto"),
            Consent(handle: "sam", mode: "never"),
        ]
        s.digest = DigestInfo(daily: Digest(
            id: "d1", day: MenuLines.dayBefore(now, in: "America/Toronto"),
            text: "Yesterday in tom's crew: 3 ships, 2 hand-offs, 41 questions answered\nAda shipped the quote page on phones, with a walkthrough.",
            writtenAt: ms - 3 * 3_600_000
        ))
        s.local = LocalInfo(machine: "mbp16", paired: true, version: "0.14.0", autoUpdate: true, ledgerLines: true, scout: false, handoffDailyUsd: 10)
        return s
    }

    // Grace's view of a team crew she is a member of: no leader controls, the plan paid until next month, no digest yet.
    static func member(now: Date = Date()) -> AppState {
        let ms = now.timeIntervalSince1970 * 1000
        var s = leader(now: now)
        s.me = Me(handle: "grace")
        s.crew = [
            Friend(handle: "adalovelace", led: "g", agentCount: 3, summary: "\"move the invoice totals into one query\"", lastSeenAt: ms - 10_000),
            Friend(handle: "jimmy", led: "g", agentCount: 1, summary: "vibes@main · \"why do the bounce counts double\"", lastSeenAt: ms - 10_000),
            Friend(handle: "sam", led: "x", lastSeenAt: ms - 30 * 3_600_000),
            Friend(handle: "tom", led: "b", agentCount: 2, lastSeenAt: ms - 10_000),
        ]
        if var crew = s.crewInfo {
            crew.plan = "team"
            crew.planUntil = ms + 24 * 86_400_000
            crew.iAmLeader = false
            crew.intercomWebhookUrl = nil
            crew.slackError = "Slack said: channel_not_found"
            s.crewInfo = crew
        }
        s.handoffs = HandoffsList()
        s.digest = DigestInfo()
        s.consents = [
            Consent(handle: "adalovelace", name: "Ada Lovelace", mode: "auto"),
            Consent(handle: "jimmy", name: "Jimmy", mode: "ask"),
            Consent(handle: "sam", mode: "ask"),
            Consent(handle: "tom", mode: "ask"),
        ]
        s.local?.handoffDailyUsd = 15
        s.local?.scout = true
        return s
    }

    // Signed in, in no crew yet, with two friends.
    static func noCrew(now: Date = Date()) -> AppState {
        var s = leader(now: now)
        s.crewInfo = nil
        s.consents = []
        s.numbers = nil
        s.costs = nil
        s.digest = DigestInfo()
        s.handoffs = HandoffsList()
        s.crew = Array(s.crew.prefix(2))
        return s
    }

    // A crew of eleven: the icon shows 8 lights, and 12 hand-offs wait.
    static func big(now: Date = Date()) -> AppState {
        var s = leader(now: now)
        let more = ["ana", "bo", "cy", "di", "ed", "flo", "gus"].map { Friend(handle: $0, led: $0 < "d" ? "g" : "x", agentCount: 1) }
        s.crew += more
        s.handoffs = HandoffsList(incoming: (1...12).map { IncomingHandoff(id: "h\($0)", fromHandle: "sam", text: "task \($0)", status: "offered") })
        return s
    }

    private static func month(_ now: Date) -> String {
        let c = Calendar.current.dateComponents([.year, .month], from: now)
        return String(format: "%04d-%02d", c.year ?? 2026, c.month ?? 1)
    }

    // `--sample-open <what>`, a moment after launch. With `--sample-shots <dir>`, the app also draws its own windows (the
    // menu bar icon, the open menu, the composer) into PNG files there and quits: a screenshot of other apps' windows needs
    // a permission that drawing your own does not.
    static func afterLaunch() {
        let args = CommandLine.arguments
        let what = args.firstIndex(of: "--sample-open").flatMap { args.count > $0 + 1 ? args[$0 + 1] : nil }
        let shots = args.firstIndex(of: "--sample-shots").flatMap { args.count > $0 + 1 ? URL(fileURLWithPath: args[$0 + 1]) : nil }
        // A run that draws its windows always ends, whatever happens in it.
        if shots != nil {
            later(15) {
                print("sample: stopped after 15 seconds")
                exit(1)
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            if let shots {
                shoot(statusItem(), named: "icon-1", in: shots)
                // A third of the pulse later, so a relaying light shows at another brightness.
                later(0.45) { shoot(statusItem(), named: "icon-2", in: shots) }
            }
            switch what {
            case "menu":
                if let shots {
                    // The click below opens the menu and waits in it, so the shots are set up first.
                    later(1.2) {
                        for window in NSApp.windows where window.isVisible && window !== statusItem() {
                            shoot(window, named: "menu-\(window.className)", in: shots)
                        }
                        exit(0)
                    }
                }
                clickIcon()
            case "handoff", "shout":
                let kind = what == "handoff" ? "handoff" : "shout"
                MenuComposer.shared?.show(kind == "handoff" ? .handoff : .shout)
                if let shots, let panel = MenuComposer.shared?.panel {
                    later(1.0) {
                        shoot(panel, named: "composer-\(kind)", in: shots)
                        exit(0)
                    }
                }
            case "keys":
                tryKeys(.shout, shots: shots)
            case "keys-handoff":
                tryKeys(.handoff, shots: shots)
            case nil:
                if shots != nil { later(1.0) { exit(0) } }
            default:
                print("--sample-open: menu, handoff, shout, keys or keys-handoff")
            }
        }
    }

    // Runs after a delay even while a menu is open (a timer in the common modes).
    private static func later(_ seconds: Double, _ work: @escaping @MainActor () -> Void) {
        let timer = Timer(timeInterval: seconds, repeats: false) { _ in MainActor.assumeIsolated { work() } }
        RunLoop.main.add(timer, forMode: .common)
    }

    private static func statusItem() -> NSWindow? {
        NSApp.windows.first { $0.className.contains("NSStatusBarWindow") && $0.isVisible }
    }

    // Draws one of this app's windows into <dir>/<name>.png and says where it is and how it looks.
    private static func shoot(_ window: NSWindow?, named name: String, in dir: URL) {
        guard let window, let view = window.contentView else { return print("\(name): no window") }
        let button = find(in: view)
        let look = (button?.effectiveAppearance ?? view.effectiveAppearance).name.rawValue
        guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return print("\(name): cannot draw") }
        view.cacheDisplay(in: view.bounds, to: bitmap)
        let file = dir.appendingPathComponent("\(name).png")
        do {
            try bitmap.representation(using: .png, properties: [:])?.write(to: file)
            print("\(name): \(window.className) at \(window.frame), appearance \(look) → \(file.path)")
        } catch {
            print("\(name): cannot write \(file.path): \(error)")
        }
    }

    // Clicks soopdoop's own menu bar icon, so its menu opens. A click inside this app needs no permission.
    static func clickIcon() {
        guard let window = statusItem(), let button = find(in: window.contentView) else { return print("no menu bar icon found") }
        print("clicking the menu bar icon at \(window.frame)")
        button.performClick(nil)
    }

    private static func find(in view: NSView?) -> NSStatusBarButton? {
        guard let view else { return nil }
        if let button = view as? NSStatusBarButton { return button }
        for sub in view.subviews { if let found = find(in: sub) { return found } }
        return nil
    }

    // A composer typed into as a person would, through the app's own event queue: the shout gets "lunch?" and Return; the
    // hand-off gets "fix it", Option-Return, "now" and Return. With no rail behind the sample, Return shows the error under
    // the field. Then Escape closes the panel. Prints what it saw, and draws the panel after Return.
    //
    // Run from a shell, the sample is a background app that macOS gives no keyboard focus without a click, so this check
    // makes it the active app first; in real use the click on "Shout…" or "Hand off…" in the menu is that click.
    static func tryKeys(_ kind: MenuComposer.Kind, shots: URL?) {
        guard let composer = MenuComposer.shared else { return }
        composer.show(kind)
        let panel = composer.panel
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKey()
        later(0.8) {
            print("panel key: \(panel.isKeyWindow), first responder: \(panel.firstResponder.map { String(describing: type(of: $0)) } ?? "none")")
            if kind == .shout {
                typeText("lunch?", in: panel)
            } else {
                typeText("fix it", in: panel)
                press(36, "\r", option: true, in: panel)
                typeText("now", in: panel)
            }
            print("typed: \((panel.firstResponder as? NSTextView)?.string.debugDescription ?? "?")")
            press(36, "\r", in: panel)
            print("pressed Return")
            later(1.0) {
                if let shots { shoot(panel, named: "keys-\(kind == .shout ? "shout" : "handoff")-after-return", in: shots) }
                press(53, "\u{1b}", in: panel)
                print("pressed Escape; panel visible: \(panel.isVisible)")
                if shots != nil { later(0.5) { exit(0) } }
            }
        }
    }

    private static func typeText(_ text: String, in window: NSWindow) {
        for character in text { press(0, String(character), in: window) }
    }

    private static func press(_ code: UInt16, _ characters: String, option: Bool = false, in window: NSWindow) {
        for type in [NSEvent.EventType.keyDown, .keyUp] {
            guard let event = NSEvent.keyEvent(
                with: type, location: .zero, modifierFlags: option ? [.option] : [], timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber, context: nil, characters: characters,
                charactersIgnoringModifiers: characters, isARepeat: false, keyCode: code
            ) else { continue }
            NSApp.sendEvent(event)
        }
    }
}
