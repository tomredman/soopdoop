// ABOUTME: The menu bar: an icon with one light per crewmate (green working, blue idle, grey off, a ring in focus, a purple
// ABOUTME: pulse while my question reads their agent) and a count of hand-offs waiting for me, and the glance menu under it.
import AppKit
import Combine
import SwiftUI

// One crewmate's light.
struct CrewLight: Equatable {
    enum Kind: Equatable { case working, idle, off, focus }
    var kind: Kind
    // A question of mine is reading one of their agents right now: purple, pulsing.
    var relaying = false
}

// What the menu bar icon shows.
enum MenuGlyph: Equatable {
    // Not connected, signed out, or nobody in the crew yet.
    case hexagon
    // A knock is on screen.
    case bell
    // A question of mine is out, and there is no crewmate light to show it on.
    case antenna
    // One light per crewmate (8 at most), and how many hand-offs wait for my answer.
    case lights([CrewLight], waiting: Int)
}

// Who gets a light, in what order, and what it says.
enum CrewDots {
    // With more crewmates than this, the first 8 show: the icon stays about 80 points wide.
    static let most = 8

    static func glyph(_ state: AppState?, connected: Bool, now: Date = Date()) -> MenuGlyph {
        guard connected, let state, state.phase == "ready", state.me != nil else { return .hexagon }
        if state.incoming.current != nil { return .bell }
        let lights = ordered(state.crew).prefix(most).map(light)
        if lights.isEmpty {
            return state.wire.contains { $0.inFlight && $0.role == "asked" } ? .antenna : .hexagon
        }
        return .lights(Array(lights), waiting: waiting(state, now: now).count)
    }

    static func light(_ friend: Friend) -> CrewLight {
        if friend.inFocus { return CrewLight(kind: .focus, relaying: friend.relaying) }
        switch friend.led {
        case "g": return CrewLight(kind: .working, relaying: friend.relaying)
        case "b": return CrewLight(kind: .idle, relaying: friend.relaying)
        default: return CrewLight(kind: .off, relaying: friend.relaying)
        }
    }

    // Working first, then idle, in focus and off; inside each, the order the agent sent (by handle).
    static func ordered(_ crew: [Friend]) -> [Friend] {
        crew.enumerated()
            .sorted { a, b in
                let ra = rank(light(a.element)), rb = rank(light(b.element))
                return ra != rb ? ra < rb : a.offset < b.offset
            }
            .map(\.element)
    }

    static func rank(_ light: CrewLight?) -> Int {
        switch light?.kind {
        case .working: return 0
        case .idle: return 1
        case .focus: return 2
        case .off: return 3
        case nil: return 4
        }
    }

    // Hand-offs offered to me that wait for my answer. Accepted ones wait for my agent, not for me.
    static func waiting(_ state: AppState, now: Date) -> [IncomingHandoff] {
        let ms = now.timeIntervalSince1970 * 1000
        return state.handoffs.incoming.filter { $0.status == "offered" && ($0.expiresAt == 0 || $0.expiresAt > ms) }
    }

    // A light for a line in the menu, the same colours as the icon's.
    static func menuDot(_ light: CrewLight) -> NSImage {
        let size: CGFloat = 10
        let image = NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            MenuIcon.drawLight(light, in: rect.insetBy(dx: 1.5, dy: 1.5), pulse: 1, palette: .current)
            return true
        }
        image.isTemplate = false
        image.accessibilityDescription = MenuIcon.word(light)
        return image
    }
}

// The menu bar's colours. On a dark menu bar, the HUD's LED colours; on a light one, deeper shades, so a light still stands
// out against it (3:1 or more on white). Grey and the badge follow the menu bar's own text colour.
struct MenuPalette {
    let working: NSColor
    let idle: NSColor
    let relay: NSColor
    let off: NSColor
    let ring: NSColor
    let badge: NSColor
    let badgeText: NSColor

    static let dark = MenuPalette(
        working: NSColor(Theme.green), idle: NSColor(Theme.blue), relay: NSColor(Theme.purple),
        off: NSColor(white: 1, alpha: 0.45), ring: NSColor(white: 1, alpha: 0.7),
        badge: NSColor(white: 1, alpha: 0.92), badgeText: NSColor(white: 0, alpha: 0.88)
    )

    static let light = MenuPalette(
        working: NSColor(srgbRed: 0.10, green: 0.62, blue: 0.30, alpha: 1),
        idle: NSColor(srgbRed: 0.14, green: 0.45, blue: 0.88, alpha: 1),
        relay: NSColor(srgbRed: 0.50, green: 0.34, blue: 0.90, alpha: 1),
        off: NSColor(white: 0, alpha: 0.4), ring: NSColor(white: 0, alpha: 0.6),
        badge: NSColor(white: 0, alpha: 0.82), badgeText: NSColor(white: 1, alpha: 1)
    )

    // The palette for what is being drawn on right now: the menu bar's appearance while the menu bar draws the icon, the
    // menu's while a menu draws a line's light.
    static var current: MenuPalette {
        let match = NSAppearance.currentDrawing().bestMatch(from: [.darkAqua, .vibrantDark, .aqua, .vibrantLight])
        return match == .darkAqua || match == .vibrantDark ? dark : light
    }
}

// Draws the lights. The image draws itself each time the menu bar draws it, so its colours follow the menu bar.
enum MenuIcon {
    static let height: CGFloat = 18
    static let dot: CGFloat = 6
    static let gap: CGFloat = 2.5
    static let badge: CGFloat = 11
    // Room on each side, so the round edges are not cut off.
    static let edge: CGFloat = 1

    static func badgeWidth(_ waiting: Int) -> CGFloat {
        waiting > 9 ? 15 : badge
    }

    static func width(lights: Int, waiting: Int) -> CGFloat {
        var width = CGFloat(lights) * dot + CGFloat(max(0, lights - 1)) * gap
        if waiting > 0 { width += gap + badgeWidth(waiting) }
        return ceil(width + 2 * edge)
    }

    // `pulse` (0 to 1) is how bright a relaying light is right now.
    static func image(_ lights: [CrewLight], waiting: Int, pulse: Double) -> NSImage {
        let size = NSSize(width: width(lights: lights.count, waiting: waiting), height: height)
        let image = NSImage(size: size, flipped: false) { _ in
            draw(lights, waiting: waiting, pulse: pulse, palette: .current)
            return true
        }
        image.isTemplate = false
        image.accessibilityDescription = describe(lights, waiting: waiting)
        return image
    }

    static func draw(_ lights: [CrewLight], waiting: Int, pulse: Double, palette: MenuPalette) {
        var x = edge
        let y = (height - dot) / 2
        for light in lights {
            drawLight(light, in: NSRect(x: x, y: y, width: dot, height: dot), pulse: pulse, palette: palette)
            x += dot + gap
        }
        guard waiting > 0 else { return }
        let rect = NSRect(x: x, y: (height - badge) / 2, width: badgeWidth(waiting), height: badge)
        palette.badge.setFill()
        NSBezierPath(roundedRect: rect, xRadius: badge / 2, yRadius: badge / 2).fill()
        let label = NSAttributedString(string: waiting > 9 ? "9+" : "\(waiting)", attributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 8.5, weight: .bold),
            .foregroundColor: palette.badgeText,
        ])
        let text = label.size()
        label.draw(at: NSPoint(x: rect.midX - text.width / 2, y: rect.midY - text.height / 2 + 0.25))
    }

    static func drawLight(_ light: CrewLight, in rect: NSRect, pulse: Double, palette: MenuPalette) {
        if light.relaying {
            palette.relay.withAlphaComponent(0.35 + 0.65 * pulse).setFill()
            NSBezierPath(ovalIn: rect).fill()
            return
        }
        switch light.kind {
        case .working:
            palette.working.setFill()
            NSBezierPath(ovalIn: rect).fill()
        case .idle:
            palette.idle.setFill()
            NSBezierPath(ovalIn: rect).fill()
        case .off:
            palette.off.setFill()
            NSBezierPath(ovalIn: rect).fill()
        case .focus:
            // Grey with a ring: a small grey light inside a circle.
            let ring = NSBezierPath(ovalIn: rect.insetBy(dx: 0.6, dy: 0.6))
            ring.lineWidth = 1.2
            palette.ring.setStroke()
            ring.stroke()
            palette.off.setFill()
            NSBezierPath(ovalIn: rect.insetBy(dx: rect.width * 0.32, dy: rect.height * 0.32)).fill()
        }
    }

    static func word(_ light: CrewLight) -> String {
        if light.relaying { return "answering your question" }
        switch light.kind {
        case .working: return "working"
        case .idle: return "idle"
        case .off: return "off"
        case .focus: return "in focus"
        }
    }

    // For VoiceOver: "soopdoop: 2 working, 1 idle, 1 off. 1 hand-off waiting for you."
    static func describe(_ lights: [CrewLight], waiting: Int) -> String {
        var counts: [(String, Int)] = []
        for light in lights {
            let w = word(light)
            if let i = counts.firstIndex(where: { $0.0 == w }) { counts[i].1 += 1 } else { counts.append((w, 1)) }
        }
        var text = "soopdoop: " + counts.map { "\($0.1) \($0.0)" }.joined(separator: ", ") + "."
        if waiting > 0 { text += " " + MenuLines.waitingLine(waiting) + "." }
        return text
    }
}

// What the icon shows right now. A relaying light pulses: the image is drawn again about 12 times a second, only while
// one of my questions reads a crewmate's agent.
@MainActor
final class MenuIconModel: ObservableObject {
    @Published private(set) var glyph: MenuGlyph = .hexagon
    // How bright a relaying light is right now, 0 to 1. Steady at 1 while nothing relays.
    @Published private(set) var pulse: Double = 1
    private var watcher: AnyCancellable?
    private var timer: Timer?
    private let start = Date()

    init(client: AgentClient) {
        watcher = client.$state.combineLatest(client.$connected).sink { [weak self] state, connected in
            let next = CrewDots.glyph(state, connected: connected)
            DispatchQueue.main.async { self?.show(next) }
        }
    }

    private func show(_ next: MenuGlyph) {
        if next != glyph { glyph = next }
        if case .lights(let lights, _) = next, lights.contains(where: \.relaying) { startPulse() } else { stopPulse() }
    }

    private func startPulse() {
        guard timer == nil else { return }
        let timer = Timer(timeInterval: 1.0 / 12, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        // Common modes: the light keeps pulsing while the menu is open.
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    // From bright to dim and back in 1.4 seconds, like the HUD's lights.
    private func tick() {
        let t = Date().timeIntervalSince(start)
        pulse = 0.5 + 0.5 * cos(2 * Double.pi * t / 1.4)
    }

    private func stopPulse() {
        timer?.invalidate()
        timer = nil
        if pulse != 1 { pulse = 1 }
    }
}

struct MenuLabel: View {
    @EnvironmentObject var icon: MenuIconModel

    var body: some View {
        switch icon.glyph {
        case .hexagon:
            Image(systemName: "circle.hexagongrid.fill")
        case .bell:
            Image(systemName: "bell.badge.fill")
        case .antenna:
            Image(systemName: "antenna.radiowaves.left.and.right")
        case .lights(let lights, let waiting):
            Image(nsImage: MenuIcon.image(lights, waiting: waiting, pulse: icon.pulse))
                .accessibilityLabel(MenuIcon.describe(lights, waiting: waiting))
        }
    }
}

// The lines of the glance menu.
enum MenuLines {
    struct Mate: Identifiable {
        let id: String
        let light: CrewLight
        let text: String
    }

    // Someone I can hand work to.
    struct Target: Identifiable {
        let handle: String
        let name: String?
        // Nil when they are in my crew but not among my friends, so the app has no light for them.
        let light: CrewLight?
        var id: String { handle }
    }

    // Crewmate lines in the menu; a longer list of friends ends with "N more in the HUD".
    static let shown = 12
    static let topicLength = 60

    static func crewmates(_ state: AppState, now: Date) -> [Mate] {
        CrewDots.ordered(state.crew).prefix(shown).map { f in
            Mate(id: f.handle, light: CrewDots.light(f), text: line(f, now: now))
        }
    }

    // "@adalovelace · 4 agents · the quote page", "@jimmy · 2 agents · email metrics, idle", "@sam · off since 17:40".
    static func line(_ f: Friend, now: Date) -> String {
        let who = "@\(f.handle)"
        if f.inFocus { return "\(who) · in focus" }
        if f.relaying { return "\(who) · \(agents(f.agentCount)) · answering your question" }
        if f.led != "g" && f.led != "b" {
            guard let seen = f.lastSeenAt else { return "\(who) · off" }
            return "\(who) · off since \(since(seen, now: now))"
        }
        if f.agentCount == 0 { return "\(who) · online, no agents open" }
        var text = "\(who) · \(agents(f.agentCount))"
        if let summary = f.summary {
            let about = topic(summary)
            if !about.isEmpty { text += " · \(about)" }
        }
        return f.led == "b" ? text + ", idle" : text
    }

    static func agents(_ n: Int) -> String {
        n == 1 ? "1 agent" : "\(n) agents"
    }

    // A summary as a short topic: its folder and prompt, without the list of files or the quote marks around the prompt,
    // cut at about 60 characters.
    static func topic(_ summary: String) -> String {
        let parts = summary.components(separatedBy: " · ").filter { !$0.hasPrefix("files:") }.map { part in
            var text = part
            if text.hasPrefix("\"") {
                text.removeFirst()
                if text.hasSuffix("\"") { text.removeLast() }
            }
            return text
        }
        return cut(parts.joined(separator: " · "), topicLength)
    }

    // One line of at most `max` characters, cut at a space when there is one in its second half.
    static func cut(_ text: String, _ max: Int) -> String {
        let clean = text.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        guard clean.count > max else { return clean }
        var head = String(clean.prefix(max - 1))
        if let space = head.lastIndex(of: " "), head.distance(from: head.startIndex, to: space) > max / 2 {
            head = String(head[..<space])
        }
        while let last = head.last, " ·,;:".contains(last) { head.removeLast() }
        return head + "…"
    }

    // "17:40" within the last 12 hours (in this Mac's clock style), "yesterday", a weekday within the week, else "14 Oct".
    static func since(_ ms: Double, now: Date, calendar: Calendar = .current) -> String {
        let date = Date(timeIntervalSince1970: ms / 1000)
        if calendar.isDate(date, inSameDayAs: now) || now.timeIntervalSince(date) < 12 * 3_600 { return clock.string(from: date) }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
            return "yesterday"
        }
        if now.timeIntervalSince(date) < 6 * 86_400 { return weekday.string(from: date) }
        return day.string(from: date)
    }

    private static let clock: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .none
        f.timeStyle = .short
        return f
    }()

    private static let weekday: DateFormatter = {
        let f = DateFormatter()
        f.setLocalizedDateFormatFromTemplate("EEEE")
        return f
    }()

    private static let day: DateFormatter = {
        let f = DateFormatter()
        f.setLocalizedDateFormatFromTemplate("d MMM")
        return f
    }()

    // The crew's recent work in one line: the headline of yesterday's digest when there is one (team plan), else the crew's
    // numbers for the last 7 days. Nil when there is nothing to count yet.
    static func recap(_ state: AppState, now: Date) -> String? {
        if let crew = state.crewInfo, let daily = state.digest.daily, daily.day == dayBefore(now, in: crew.timezone),
           let first = daily.text.split(whereSeparator: \.isNewline).first {
            var line = String(first).trimmingCharacters(in: .whitespaces)
            // "Yesterday in tom's crew: 3 ships, …" reads "Yesterday: 3 ships, …" here; the menu is about the crew already.
            let long = "Yesterday in \(crew.name)"
            if line.hasPrefix(long) { line = "Yesterday" + line.dropFirst(long.count) }
            if line == "Yesterday" { line = "Yesterday's digest is in the HUD" }
            if !line.isEmpty { return cut(line, 66) }
        }
        guard let n = state.numbers else { return nil }
        var parts: [String] = []
        if n.ships > 0 { parts.append(n.ships == 1 ? "1 ship" : "\(n.ships) ships") }
        if n.handoffs > 0 { parts.append(n.handoffs == 1 ? "1 hand-off" : "\(n.handoffs) hand-offs") }
        if n.answered > 0 { parts.append(n.answered == 1 ? "1 question answered" : "\(n.answered) questions answered") }
        guard !parts.isEmpty else { return nil }
        return "Last \(n.days) days: " + parts.joined(separator: ", ")
    }

    // The day before `now` in a time zone, as a digest names it: "2026-10-17".
    static func dayBefore(_ now: Date, in zone: String) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: zone) ?? .current
        let before = calendar.date(byAdding: .day, value: -1, to: now) ?? now
        let c = calendar.dateComponents([.year, .month, .day], from: before)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    static func waitingLine(_ n: Int) -> String {
        n == 1 ? "1 hand-off waiting for you" : "\(n) hand-offs waiting for you"
    }

    // Who I can hand work to: my crew's other members, or my friends when I am in no crew. Working and idle ones first.
    static func handoffTargets(_ state: AppState?) -> [Target] {
        guard let state, let me = state.me else { return [] }
        var friends: [String: Friend] = [:]
        for f in state.crew where friends[f.handle] == nil { friends[f.handle] = f }
        let people: [(String, String?)]
        if let crew = state.crewInfo {
            people = crew.members.filter { $0.handle != me.handle }.map { ($0.handle, $0.name) }
        } else {
            people = state.crew.map { ($0.handle, $0.superset?.name) }
        }
        let targets = people.map { handle, name in Target(handle: handle, name: name, light: friends[handle].map(CrewDots.light)) }
        return targets.enumerated()
            .sorted { a, b in
                let ra = CrewDots.rank(a.element.light), rb = CrewDots.rank(b.element.light)
                return ra != rb ? ra < rb : a.offset < b.offset
            }
            .map(\.element)
    }
}

// The menu under the icon: me, one line per crewmate, the crew's recent work and the hand-offs waiting for me, then the
// composers (ask, hand off, shout), the HUD, focus, invite, settings and signing in or out.
struct MenuContent: View {
    @EnvironmentObject var client: AgentClient
    @EnvironmentObject var style: HUDStyle
    let show: () -> Void

    var body: some View {
        if let state = client.state, let me = state.me {
            Text("@\(me.handle)\(state.myRow.map { " · \($0.rank) · \($0.xp) XP" } ?? "")")
        } else {
            Text(client.connected ? "soopdoop · not signed in" : "soopdoop is not running")
        }
        if let state = client.state, state.phase == "ready", state.me != nil {
            glance(state, now: Date())
        }
        Divider()
        Button("Show the HUD") { show() }
        Picker("HUD", selection: Binding(get: { style.mode }, set: { style.mode = $0 })) {
            ForEach(HUDMode.allCases) { Text($0.label).tag($0) }
        }
        if client.state?.phase == "ready" {
            Menu("Focus") {
                Button("25 minutes") { client.run("setFocus", ["minutes": 25], done: "Focus on: you are off the rail and knocks bounce.") }
                Button("50 minutes") { client.run("setFocus", ["minutes": 50], done: "Focus on for 50 minutes.") }
                Button("90 minutes") { client.run("setFocus", ["minutes": 90], done: "Focus on for 90 minutes.") }
                Button("Off") { client.run("setFocus", [:], done: "Focus off. Friends can knock again.") }
            }
            Button("Invite someone new") { invite() }
        }
        Divider()
        SettingsLink { Text("Settings…") }
        if client.state?.phase == "signed-out" {
            Button("Sign in with Superset") {
                show()
                client.run("signIn")
            }
        } else if client.state?.me != nil {
            Button("Sign out") { client.run("signOut") }
        }
        Divider()
        Button("Quit soopdoop") { NSApp.terminate(nil) }
    }

    @ViewBuilder private func glance(_ state: AppState, now: Date) -> some View {
        let mates = MenuLines.crewmates(state, now: now)
        if !mates.isEmpty {
            Divider()
            ForEach(mates) { mate in
                Button { show() } label: {
                    Label { Text(mate.text) } icon: { Image(nsImage: CrewDots.menuDot(mate.light)) }
                }
            }
            if state.crew.count > mates.count {
                Button("\(state.crew.count - mates.count) more in the HUD") { show() }
            }
        }
        let recap = MenuLines.recap(state, now: now)
        let waiting = CrewDots.waiting(state, now: now).count
        if recap != nil || waiting > 0 {
            Divider()
            if let recap { Button(recap) { show() } }
            if waiting > 0 { Button(MenuLines.waitingLine(waiting)) { show() } }
        }
        Divider()
        Button("Ask the crew…") { ChatWindow.shared?.show() }
        Button("Hand off…") { MenuComposer.shared?.show(.handoff) }
            .disabled(MenuLines.handoffTargets(state).isEmpty)
        Button("Shout…") { MenuComposer.shared?.show(.shout) }
    }

    private func invite() {
        Task {
            do {
                guard let message = try await client.act("invite") as? String else { return }
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(message, forType: .string)
                client.toast = "Invite link copied. Send it to one person; it works once, for 7 days."
            } catch {
                client.toast = (error as? AgentError)?.message ?? error.localizedDescription
            }
            show()
        }
    }
}
