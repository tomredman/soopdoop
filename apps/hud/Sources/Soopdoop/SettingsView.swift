// ABOUTME: The Settings window: how the HUD looks and when it shows, your crew (CrewSettings.swift), what this Mac does for
// ABOUTME: the crew, what friends see, the Superset profile, updates, and signing out. HUD choices stay in this app; the rest go to the agent.
import AppKit
import SwiftUI

struct SettingsView: View {
    var body: some View {
        TabView {
            LookSettings().tabItem { Label("HUD", systemImage: "rectangle.inset.filled") }
            CrewSettings().tabItem { Label("Crew", systemImage: "person.3") }
            MacSettings().tabItem { Label("This Mac", systemImage: "laptopcomputer") }
            AccountSettings().tabItem { Label("Account", systemImage: "person.crop.circle") }
            AboutSettings().tabItem { Label("Updates", systemImage: "arrow.down.circle") }
        }
        .frame(width: 460, height: 520)
        .onAppear { NSApp.activate(ignoringOtherApps: true) }
    }
}

// What this Mac does for the crew, on its owner's own accounts: the Haiku ledger line, the scout, and what hand-offs from
// crewmates may cost. The daemon reads these from ~/.soopdoop/settings.json, so they go through the agent.
struct MacSettings: View {
    @EnvironmentObject var client: AgentClient

    // Dollars a day; the one set now is added when it is not among them (`soopdoop handoffs 15` in Terminal).
    static let allowances: [Double] = [0, 1, 2, 5, 10, 20, 50, 100]

    var body: some View {
        Form {
            if let local = client.state?.local {
                Section {
                    Toggle("Write ledger lines with Haiku on my account", isOn: Binding(get: { local.ledgerLines }, set: { on in
                        client.run("setLedgerLines", ["on": on], done: on
                            ? "Haiku writes this Mac's ledger lines from now on."
                            : "Ledger lines come from the prompts and files from now on, with no model call.")
                    }))
                    CrewCaption("When an agent finishes a task, a short Haiku call on your own Claude account writes its line for the crew's ledger: about a fiftieth of a cent a line. Off, the line is made from the first and last prompts and the files. Either way you can edit or delete it.")
                } header: {
                    Text("Ledger")
                }
                Section {
                    Toggle("The scout: props from customers from my Intercom", isOn: Binding(get: { local.scout }, set: { on in
                        client.run("setScout", ["on": on], done: on
                            ? "The scout looks at your Intercom once an hour."
                            : "The scout is off.")
                    }))
                    CrewCaption("Once an hour, Claude on Haiku reads your newest Intercom replies for thanks and saves, and puts one line on the wire, with no customer names. A few cents a day on your own plan. Off until you turn it on. Sign in to Intercom once in Claude Code with /mcp first."
                        + (client.state?.crewInfo?.plan == "team" ? "" : " The scout is part of the Team plan."))
                } header: {
                    Text("Scout")
                }
                Section {
                    Picker("Hand-offs may cost my agents up to", selection: Binding(get: { local.handoffDailyUsd }, set: { usd in
                        client.run("setHandoffAllowance", ["usd": usd], done: "Hand-offs may cost this Mac's agents up to \(Self.dollars(usd)) a day.")
                    })) {
                        ForEach(choices(local.handoffDailyUsd), id: \.self) { usd in Text("\(Self.dollars(usd)) a day").tag(usd) }
                    }
                    CrewCaption("What crewmates' hand-offs may cost on this Mac in any 24 hours, counted from what each finished one reports. This Mac checks it, so neither a crewmate nor the backend can go past it. Who may hand off to you is in Settings → Crew.")
                } header: {
                    Text("Hand-offs")
                }
            } else {
                Text("soopdoop is not running on this Mac. Run `soopdoop setup` in Terminal.").foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }

    private func choices(_ now: Double) -> [Double] {
        Self.allowances.contains(now) ? Self.allowances : (Self.allowances + [now]).sorted()
    }

    // "$10", or "$2.50" for a part of a dollar.
    static func dollars(_ usd: Double) -> String {
        usd == usd.rounded() ? "$\(Int(usd))" : String(format: "$%.2f", usd)
    }
}

struct LookSettings: View {
    @EnvironmentObject var style: HUDStyle
    @EnvironmentObject var client: AgentClient

    var body: some View {
        Form {
            Picker("Show the HUD", selection: Binding(get: { style.mode }, set: { style.mode = $0 })) {
                ForEach(HUDMode.allCases) { Text($0.label).tag($0) }
            }
            // The watcher reads it from ~/.soopdoop/settings.json, so it goes through the agent.
            if let local = client.state?.local {
                Toggle("Open soopdoop when Superset opens", isOn: Binding(get: { local.autoOpen }, set: { on in
                    client.run("setAutoOpen", ["on": on])
                }))
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
            Toggle("Real names next to handles", isOn: $style.showNames)
            Section("Sections") {
                ForEach(Array(style.order.enumerated()), id: \.element) { index, section in
                    HStack {
                        Toggle(section.label, isOn: Binding(get: { style.shows(section) }, set: { style.setShows(section, $0) }))
                        Button { style.move(section, by: -1) } label: { Image(systemName: "chevron.up") }
                            .buttonStyle(.borderless)
                            .disabled(index == 0)
                            .help("Move \(section.label) up")
                        Button { style.move(section, by: 1) } label: { Image(systemName: "chevron.down") }
                            .buttonStyle(.borderless)
                            .disabled(index == style.order.count - 1)
                            .help("Move \(section.label) down")
                    }
                }
                Text("Knocks, hand-offs, heads-ups, friend requests and flicks always show at the top.").font(.caption).foregroundStyle(.secondary)
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
                        // A box with a border and a hint: a bare text field in a grouped form looks like a label, and
                        // Link stayed grey with nothing to show where to type.
                        LabeledContent("Superset handle") {
                            HStack(spacing: 6) {
                                TextField("Superset handle", text: $superset, prompt: Text("e.g. ada-lovelace"))
                                    .labelsHidden()
                                    .textFieldStyle(.roundedBorder)
                                    .multilineTextAlignment(.leading)
                                    .frame(width: 150)
                                    .onSubmit(link)
                                Button("Link", action: link).disabled(superset.trimmingCharacters(in: .whitespaces).isEmpty)
                            }
                        }
                        Text("The handle on your public profile, superset.sh/handle. Publish it in Superset first.")
                            .font(.caption).foregroundStyle(.secondary)
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

    // "redman", "@redman" or a superset.sh link: the backend reads any of them.
    private func link() {
        let handle = superset.trimmingCharacters(in: .whitespaces)
        guard !handle.isEmpty else { return }
        client.run("linkSuperset", ["handle": handle], done: "Linked your Superset profile.")
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
