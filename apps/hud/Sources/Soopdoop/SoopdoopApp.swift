// ABOUTME: The app: the menu bar item (crew lights and the glance menu, MenuBar.swift), the HUD panel, the composers,
// ABOUTME: notifications and the Settings window. No Dock icon (LSUIElement); it starts at login via a LaunchAgent.
import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    // `--sample`: a made-up crew, and no connection to this Mac's rail (MenuSamples.swift).
    let client: AgentClient = MenuSamples.launching.map { AgentClient(preview: $0) } ?? AgentClient()
    let style = HUDStyle()
    lazy var icon = MenuIconModel(client: client)
    var hud: HUDController?
    var notifier: Notifier?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        if MenuSamples.launching == nil { client.connect() }
        let controller = HUDController(client: client, style: style)
        hud = controller
        ChatWindow.shared = ChatWindow(client: client, style: style)
        MenuComposer.shared = MenuComposer(client: client, style: style)
        // Notifications need a real app bundle; a bare build (swift run) has none. A sample has nothing to notify about.
        if Bundle.main.bundleIdentifier != nil && MenuSamples.launching == nil {
            let notifier = Notifier(client: client, style: style)
            notifier.hud = controller
            self.notifier = notifier
        }
        if MenuSamples.launching != nil { MenuSamples.afterLaunch() }
    }

    // `open soopdoop.app` (or `soopdoop open`) while it runs: show the HUD.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        hud?.peek()
        return false
    }
}

struct SoopdoopApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate

    init() {
        // `Soopdoop --snapshot-menu <dir>`: the menu bar icon, the composers and the crew's Settings tabs as PNG files.
        if let dir = MenuSnapshot.requested {
            MenuSnapshot.run(into: dir)
            exit(0)
        }
    }

    var body: some Scene {
        MenuBarExtra {
            MenuContent(show: { delegate.hud?.peek() })
                .environmentObject(delegate.client)
                .environmentObject(delegate.style)
        } label: {
            MenuLabel().environmentObject(delegate.icon)
        }
        Settings {
            SettingsView()
                .environmentObject(delegate.client)
                .environmentObject(delegate.style)
        }
    }
}
