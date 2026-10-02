// ABOUTME: The Settings window: how the HUD looks and when it shows, notifications, what friends see, the Superset profile,
// ABOUTME: the board, updates, and signing out. HUD choices stay in this app; account choices go to the agent.
import AppKit
import SwiftUI

struct SettingsView: View {
    var body: some View {
        TabView {
            LookSettings().tabItem { Label("HUD", systemImage: "rectangle.inset.filled") }
            AccountSettings().tabItem { Label("Account", systemImage: "person.crop.circle") }
            AboutSettings().tabItem { Label("Updates", systemImage: "arrow.down.circle") }
        }
        .frame(width: 460, height: 420)
        .onAppear { NSApp.activate(ignoringOtherApps: true) }
    }
}

struct LookSettings: View {
    @EnvironmentObject var style: HUDStyle

    var body: some View {
        Form {
            Picker("Show the HUD", selection: Binding(get: { style.mode }, set: { style.mode = $0 })) {
                ForEach(HUDMode.allCases) { Text($0.label).tag($0) }
            }
            Picker("Material", selection: Binding(get: { style.material }, set: { style.material = $0 })) {
                ForEach(HUDMaterial.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            LabeledContent("Background") {
                HStack {
                    Slider(value: $style.opacity, in: 0.2...1)
                    Text("\(Int(style.opacity * 100))%").monospacedDigit().frame(width: 40, alignment: .trailing)
                }
            }
            Toggle("Compact", isOn: $style.compact)
            Section("Sections") {
                Toggle("Crew", isOn: $style.showCrew)
                Toggle("Operator", isOn: $style.showOperator)
                Toggle("Board", isOn: $style.showBoard)
                Toggle("This Mac", isOn: $style.showMachine)
            }
            Picker("Notifications", selection: Binding(get: { style.notify }, set: { style.notify = $0 })) {
                ForEach(NotifyMode.allCases) { Text($0.label).tag($0) }
            }
        }
        .formStyle(.grouped)
    }
}

struct AccountSettings: View {
    @EnvironmentObject var client: AgentClient
    @State private var superset = ""

    var body: some View {
        Form {
            if let state = client.state, let me = state.me {
                LabeledContent("Handle", value: "@\(me.handle)")
                if let row = state.myRow { LabeledContent("Rank", value: "\(row.rank) · \(row.xp) XP") }
                Section("Friends can see") {
                    Toggle("Agent names", isOn: Binding(get: { me.shareAgentNames }, set: { on in
                        client.run("updateSharing", ["shareAgentNames": on, "shareWorkspaceNames": me.shareWorkspaceNames])
                    }))
                    Toggle("Folder names", isOn: Binding(get: { me.shareWorkspaceNames }, set: { on in
                        client.run("updateSharing", ["shareAgentNames": me.shareAgentNames, "shareWorkspaceNames": on])
                    }))
                    Text("Friends always see whether you are online and how many agents run. Private agents are never shown.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("Board") {
                    Toggle("Hide me from the board", isOn: Binding(get: { me.hideFromBoards }, set: { on in
                        client.run("setHideFromBoards", ["hide": on])
                    }))
                }
                Section("Superset profile") {
                    if let card = me.superset {
                        LabeledContent("Linked", value: "superset.sh/\(card.handle)")
                        Button("Unlink") { client.run("unlinkSuperset") }
                    } else {
                        TextField("Your Superset handle", text: $superset)
                        Button("Link") { client.run("linkSuperset", ["handle": superset], done: "Linked your Superset profile.") }
                            .disabled(superset.isEmpty)
                    }
                    Text("Friends see your public Superset name, tier, achievements and models. Never token counts or cost.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Button("Sign out") { client.run("signOut") }
            } else {
                Text("Sign in from the HUD first.").foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}

struct AboutSettings: View {
    @EnvironmentObject var client: AgentClient

    var body: some View {
        Form {
            if let local = client.state?.local {
                LabeledContent("Version", value: "v\(local.version)")
                LabeledContent("Newest release", value: local.latest ?? "not checked yet")
                Toggle("Install new releases automatically", isOn: Binding(get: { local.autoUpdate }, set: { on in
                    client.run("setAutoUpdate", ["on": on])
                }))
                if local.newer && local.canUpdate {
                    Button(local.updating ? "Updating…" : "Update now") { client.run("updateNow") }.disabled(local.updating)
                }
                if let error = local.updateError { Text(error).font(.caption).foregroundStyle(.orange) }
                LabeledContent("This Mac", value: "\(local.machine) · \(local.paired ? "connected" : "not connected yet")")
            } else {
                Text("soopdoop is not running on this Mac. Run `soopdoop setup` in Terminal.").foregroundStyle(.secondary)
            }
            Button("Open the web rail") { client.run("openRail") }
        }
        .formStyle(.grouped)
    }
}
