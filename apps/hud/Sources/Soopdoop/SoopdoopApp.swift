// ABOUTME: The app: a menu bar item (who you are, show the HUD, focus, invite, settings, sign in/out, quit), the HUD panel,
// ABOUTME: notifications and the Settings window. No Dock icon (LSUIElement); it starts at login via a LaunchAgent.
import AppKit
import SwiftUI

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let client = AgentClient()
    let style = HUDStyle()
    var hud: HUDController?
    var notifier: Notifier?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        client.connect()
        let controller = HUDController(client: client, style: style)
        hud = controller
        ChatWindow.shared = ChatWindow(client: client, style: style)
        // Notifications need a real app bundle; a bare build (swift run) has none.
        if Bundle.main.bundleIdentifier != nil {
            let notifier = Notifier(client: client, style: style)
            notifier.hud = controller
            self.notifier = notifier
        }
    }

    // `open soopdoop.app` (or `soopdoop open`) while it runs: show the HUD.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        hud?.peek()
        return false
    }
}

struct SoopdoopApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate

    var body: some Scene {
        MenuBarExtra {
            MenuContent(show: { delegate.hud?.peek() })
                .environmentObject(delegate.client)
                .environmentObject(delegate.style)
        } label: {
            MenuLabel().environmentObject(delegate.client)
        }
        Settings {
            SettingsView()
                .environmentObject(delegate.client)
                .environmentObject(delegate.style)
        }
    }
}

struct MenuLabel: View {
    @EnvironmentObject var client: AgentClient

    var body: some View {
        if client.state?.incoming.current != nil {
            Image(systemName: "bell.badge.fill")
        } else if client.state?.wire.contains(where: { $0.inFlight && $0.role == "asked" }) == true {
            Image(systemName: "antenna.radiowaves.left.and.right")
        } else {
            Image(systemName: "circle.hexagongrid.fill")
        }
    }
}

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
            Button("Chat with the Operator…") { ChatWindow.shared?.show() }
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
