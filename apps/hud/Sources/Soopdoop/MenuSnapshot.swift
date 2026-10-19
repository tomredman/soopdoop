// ABOUTME: `Soopdoop --snapshot-menu <dir>` draws the menu bar icon on a light and a dark menu bar, the composers, and the crew's
// ABOUTME: Settings tabs into PNG files, to check them without a screen. The menu itself is AppKit's: see it with --sample.
import AppKit
import SwiftUI

@MainActor
enum MenuSnapshot {
    // The folder after --snapshot-menu, or nil when the app runs for real.
    static var requested: String? {
        let args = CommandLine.arguments
        guard let at = args.firstIndex(of: "--snapshot-menu") else { return nil }
        return args.count > at + 1 ? args[at + 1] : "."
    }

    static func run(into dir: String) {
        _ = NSApplication.shared
        let out = URL(fileURLWithPath: dir)
        icons(to: out.appendingPathComponent("menubar-icons.png"))
        checkAppearance()
        let style = HUDStyle()
        let client = AgentClient(preview: MenuSamples.leader())
        let dark = Theme.ground
        render(ZStack(alignment: .top) { dark; MenuHandoffForm(close: {}).padding(10) }.environmentObject(client).environmentObject(style),
               size: NSSize(width: 400, height: 330), to: out.appendingPathComponent("menu-handoff.png"))
        render(ZStack(alignment: .top) { dark; MenuShoutForm(close: {}).padding(10) }.environmentObject(client).environmentObject(style),
               size: NSSize(width: 400, height: 170), to: out.appendingPathComponent("menu-shout.png"))
        let settings: [(String, AppState, NSSize, NSAppearance.Name)] = [
            ("settings-crew-leader", MenuSamples.leader(), NSSize(width: 460, height: 2240), .aqua),
            ("settings-crew-leader-dark", MenuSamples.leader(), NSSize(width: 460, height: 2240), .darkAqua),
            ("settings-crew-member", MenuSamples.member(), NSSize(width: 460, height: 1300), .aqua),
            ("settings-crew-none", MenuSamples.noCrew(), NSSize(width: 460, height: 360), .aqua),
        ]
        for (name, state, size, look) in settings {
            render(CrewSettings().environmentObject(AgentClient(preview: state)).environmentObject(style),
                   size: size, appearance: look, to: out.appendingPathComponent("\(name).png"))
        }
        render(MacSettings().environmentObject(AgentClient(preview: MenuSamples.leader())).environmentObject(style),
               size: NSSize(width: 460, height: 640), appearance: .aqua, to: out.appendingPathComponent("settings-mac.png"))
        render(MacSettings().environmentObject(AgentClient(preview: MenuSamples.member())).environmentObject(style),
               size: NSSize(width: 460, height: 640), appearance: .aqua, to: out.appendingPathComponent("settings-mac-member.png"))
        // The whole window at its real size, on the Crew tab's neighbour (the first tab), to see the five tabs fit.
        render(SettingsView().environmentObject(AgentClient(preview: MenuSamples.leader())).environmentObject(style),
               size: NSSize(width: 460, height: 520), appearance: .aqua, to: out.appendingPathComponent("settings-window.png"))
    }

    // Every kind of icon, at its real size and four times as big, on a light menu bar (left) and a dark one (right).
    private static func icons(to file: URL) {
        let leader = MenuSamples.leader()
        var bell = leader
        bell.incoming.current = Knock(id: "k1", fromHandle: "jimmy", item: KnockItem(kind: "link", title: "the coupon fix"))
        var focus = leader
        focus.crew = [Friend(handle: "grace", inFocus: true), Friend(handle: "sam", led: "x")]
        var one = leader
        one.crew = [Friend(handle: "adalovelace", led: "g", agentCount: 1)]
        one.handoffs = HandoffsList()
        var asking = leader
        asking.crew = []
        asking.wire = [Relay(id: "r1", question: "who knows the pricing page?", status: "routing", role: "asked")]
        var signedOut = AppState()
        signedOut.phase = "signed-out"
        let rows: [(String, AppState, Double)] = [
            ("crew of 4, Jimmy answering (bright), 1 hand-off", leader, 1),
            ("the same, the pulse at its dimmest", leader, 0),
            ("11 crewmates: 8 lights, 12 hand-offs", MenuSamples.big(), 1),
            ("one crewmate working", one, 1),
            ("in focus and off", focus, 1),
            ("a knock on screen", bell, 1),
            ("my question out, no crew", asking, 1),
            ("signed out", signedOut, 1),
        ]
        let column = { (appearance: NSAppearance.Name, backdrop: NSColor) -> NSView in
            let stack = NSStackView()
            stack.orientation = .vertical
            stack.alignment = .leading
            stack.spacing = 6
            stack.edgeInsets = NSEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
            stack.appearance = NSAppearance(named: appearance)
            stack.wantsLayer = true
            stack.layer?.backgroundColor = backdrop.cgColor
            for (name, state, pulse) in rows {
                let label = NSTextField(labelWithString: name)
                label.font = .systemFont(ofSize: 10)
                label.textColor = .secondaryLabelColor
                let image = picture(CrewDots.glyph(state, connected: true), pulse: pulse)
                let line = NSStackView(views: [symbol("wifi"), view(image, scale: 1), symbol("battery.75percent"), view(image, scale: 4)])
                line.spacing = 10
                line.alignment = .centerY
                stack.addArrangedSubview(label)
                stack.addArrangedSubview(line)
            }
            let dots = NSStackView(views: [CrewLight(kind: .working), CrewLight(kind: .idle), CrewLight(kind: .off), CrewLight(kind: .focus),
                                           CrewLight(kind: .idle, relaying: true)].map { view(CrewDots.menuDot($0), scale: 3) })
            dots.spacing = 8
            let label = NSTextField(labelWithString: "the menu's lights: working, idle, off, in focus, answering")
            label.font = .systemFont(ofSize: 10)
            label.textColor = .secondaryLabelColor
            stack.addArrangedSubview(label)
            stack.addArrangedSubview(dots)
            return stack
        }
        let left = column(.aqua, NSColor(white: 0.93, alpha: 1))
        let right = column(.darkAqua, NSColor(white: 0.13, alpha: 1))
        let both = NSStackView(views: [left, right])
        both.spacing = 0
        both.alignment = .top
        both.distribution = .fillEqually
        let size = NSSize(width: 860, height: 760)
        both.frame = NSRect(origin: .zero, size: size)
        renderView(both, size: size, to: file)
    }

    // The icon as the menu bar gets it: the lights image, or a symbol drawn in the menu bar's text colour.
    private static func picture(_ glyph: MenuGlyph, pulse: Double) -> NSImage {
        switch glyph {
        case .lights(let lights, let waiting): return MenuIcon.image(lights, waiting: waiting, pulse: pulse)
        case .bell: return template("bell.badge.fill")
        case .antenna: return template("antenna.radiowaves.left.and.right")
        case .hexagon: return template("circle.hexagongrid.fill")
        }
    }

    private static func template(_ name: String) -> NSImage {
        let image = NSImage(systemSymbolName: name, accessibilityDescription: name)?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 14, weight: .regular)) ?? NSImage()
        image.isTemplate = true
        return image
    }

    private static func symbol(_ name: String) -> NSView {
        view(template(name), scale: 1)
    }

    private static func view(_ image: NSImage, scale: CGFloat) -> NSImageView {
        let view = NSImageView(image: image)
        view.imageScaling = .scaleProportionallyUpOrDown
        view.contentTintColor = image.isTemplate ? .labelColor : nil
        let size = NSSize(width: image.size.width * scale, height: image.size.height * scale)
        view.translatesAutoresizingMaskIntoConstraints = false
        view.widthAnchor.constraint(equalToConstant: size.width).isActive = true
        view.heightAnchor.constraint(equalToConstant: size.height).isActive = true
        return view
    }

    // The same icon image drawn on a light and then a dark menu bar must come out in two colours: the menu bar draws one
    // image until the crew changes, so the image has to follow the menu bar by itself.
    private static func checkAppearance() {
        let image = MenuIcon.image([CrewLight(kind: .working)], waiting: 0, pulse: 1)
        let light = centre(of: image, on: .aqua)
        let dark = centre(of: image, on: .darkAqua)
        print("one icon image on a light menu bar: \(light); on a dark one: \(dark): \(light != dark ? "it follows the menu bar" : "IT DOES NOT FOLLOW THE MENU BAR")")
    }

    private static func centre(of image: NSImage, on appearance: NSAppearance.Name) -> String {
        let view = NSImageView(frame: NSRect(origin: .zero, size: image.size))
        view.image = image
        view.appearance = NSAppearance(named: appearance)
        guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return "?" }
        view.cacheDisplay(in: view.bounds, to: bitmap)
        let x = Int((MenuIcon.edge + MenuIcon.dot / 2) * CGFloat(bitmap.pixelsWide) / image.size.width)
        let y = bitmap.pixelsHigh / 2
        guard let c = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { return "?" }
        return String(format: "#%02X%02X%02X", Int(c.redComponent * 255), Int(c.greenComponent * 255), Int(c.blueComponent * 255))
    }

    private static func render(_ root: some View, size: NSSize, appearance: NSAppearance.Name = .darkAqua, to file: URL) {
        let host = NSHostingView(rootView: root.frame(width: size.width, height: size.height))
        host.frame = NSRect(origin: .zero, size: size)
        renderView(host, size: size, appearance: appearance, to: file)
    }

    private static func renderView(_ view: NSView, size: NSSize, appearance: NSAppearance.Name = .darkAqua, to file: URL) {
        // A real (off-screen) window, so AppKit-backed views (forms, text fields, pickers) draw as they do on screen.
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = view
        window.appearance = NSAppearance(named: appearance)
        view.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        guard let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
            print("could not draw \(file.lastPathComponent)")
            return
        }
        view.cacheDisplay(in: view.bounds, to: bitmap)
        guard let png = bitmap.representation(using: .png, properties: [:]) else { return }
        do {
            try png.write(to: file)
            print(file.path)
        } catch {
            print("could not write \(file.path): \(error)")
        }
    }
}
