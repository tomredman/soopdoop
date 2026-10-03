// ABOUTME: `Soopdoop --check-window`: checks that the HUD window keeps its size when its content changes (a toast)
// ABOUTME: and that a frame taller than the screen is pulled back onto it. Prints what it saw; exits 1 if either fails.
import AppKit

@MainActor
enum WindowCheck {
    static func run() -> Int32 {
        _ = NSApplication.shared
        let style = HUDStyle()
        // Never on screen during the check.
        style.mode = .hidden
        let state = Snapshot.samples().first { $0.0 == "ready" }?.1 ?? AppState()
        let client = AgentClient(preview: state)
        let hud = HUDController(client: client, style: style, remember: false)
        hud.panel.layoutIfNeeded()
        let before = hud.panel.frame.size

        client.toast = "Invite copied. Send it to one person; it works once, for 7 days."
        RunLoop.current.run(until: Date().addingTimeInterval(0.4))
        hud.panel.layoutIfNeeded()
        let after = hud.panel.frame.size
        let kept = after == before
        print("toast: \(Int(before.width))×\(Int(before.height)) → \(Int(after.width))×\(Int(after.height)) \(kept ? "kept its size" : "GREW")")

        guard let area = NSScreen.main?.visibleFrame else {
            print("no screen: skipped the on-screen check")
            return kept ? 0 : 1
        }
        hud.panel.setFrame(NSRect(x: area.maxX - 120, y: area.minY - 400, width: 300, height: area.height + 700), display: false)
        hud.fitOnScreen()
        let frame = hud.panel.frame
        let inside = area.contains(frame)
        print("too tall a frame: now \(Int(frame.height)) tall in a \(Int(area.height)) screen, \(inside ? "fully on screen" : "STILL OFF SCREEN")")
        return kept && inside ? 0 : 1
    }
}
