// ABOUTME: Settings → Crew: start a crew, or see yours: its name, plan and billing, members, the daily digest, Slack, Intercom,
// ABOUTME: who may hand work to your agents, whose agents post notes without asking, and what the Operator cost this month.
import AppKit
import SwiftUI

struct CrewSettings: View {
    @EnvironmentObject var client: AgentClient

    var body: some View {
        Form {
            if let state = client.state, let me = state.me, state.phase == "ready" {
                if let crew = state.crewInfo {
                    CrewAboutSection(crew: crew)
                    CrewMembersSection(crew: crew, me: me.handle)
                    CrewDigestSection(crew: crew)
                    CrewSlackSection(crew: crew)
                    if crew.iAmLeader { CrewIntercomSection(crew: crew) }
                    CrewConsentSection(consents: state.consents)
                    if crew.iAmLeader { CrewNotesSection(crew: crew) }
                    CrewCostSection(costs: state.costs, team: crew.plan == "team")
                } else {
                    NoCrewSection(me: me.handle)
                }
            } else if client.state == nil {
                Text("soopdoop is not running on this Mac. Run `soopdoop setup` in Terminal.").foregroundStyle(.secondary)
            } else {
                Text("Sign in from the HUD first.").foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }
}

// Runs a Settings action. The toast says how it went, as for every action; the problem also comes back, to show under the
// control it is about.
@MainActor
enum CrewActions {
    static func run(_ client: AgentClient, _ action: String, _ args: [String: Any] = [:], done: String? = nil) async -> String? {
        do {
            try await client.act(action, args)
            if let done { client.toast = done }
            return nil
        } catch {
            let message = (error as? AgentError)?.message ?? error.localizedDescription
            client.toast = message
            return message
        }
    }

    // Billing actions answer with a web page (Stripe's checkout or billing portal), which opens in the browser.
    static func openPage(_ client: AgentClient, _ action: String, _ args: [String: Any] = [:]) async -> String? {
        do {
            let value = try await client.act(action, args)
            guard let text = value as? String, let url = URL(string: text), url.scheme == "https" || url.scheme == "http" else {
                throw AgentError(message: "Billing did not answer with a page to open. Try again in a minute.")
            }
            NSWorkspace.shared.open(url)
            return nil
        } catch {
            let message = (error as? AgentError)?.message ?? error.localizedDescription
            client.toast = message
            return message
        }
    }
}

// A caption under a group: small, grey, wrapping.
struct CrewCaption: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        Text(text).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }
}

// What went wrong with the control above it.
struct CrewProblem: View {
    let text: String?

    var body: some View {
        if let text { Text(text).font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
    }
}

enum CrewFormat {
    // "9:00 AM" or "09:00", as this Mac writes times.
    static func hour(_ hour: Int) -> String {
        var c = DateComponents()
        c.hour = hour
        c.minute = 0
        guard let date = Calendar.current.date(from: c) else { return "\(hour):00" }
        return clock.string(from: date)
    }

    private static let clock: DateFormatter = {
        let f = DateFormatter()
        f.setLocalizedDateFormatFromTemplate("jmm")
        return f
    }()

    // "18 Nov 2026".
    static func date(_ ms: Double) -> String {
        Date(timeIntervalSince1970: ms / 1000).formatted(date: .abbreviated, time: .omitted)
    }

    // "2 hours ago".
    static func ago(_ ms: Double) -> String {
        relative.localizedString(for: Date(timeIntervalSince1970: ms / 1000), relativeTo: Date())
    }

    private static let relative: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .full
        return f
    }()

    // "$1.42"; under half a cent but more than nothing reads "under a cent".
    static func usd(_ value: Double) -> String {
        if value > 0 && value < 0.005 { return "under a cent" }
        return String(format: "$%.2f", value)
    }

    // "this month", or the month's name when the numbers are for another one ("2026-09" → "in September").
    static func month(_ month: String) -> String {
        let now = Date()
        let parts = month.split(separator: "-").compactMap { Int($0) }
        let c = Calendar.current.dateComponents([.year, .month], from: now)
        guard parts.count == 2 else { return "this month" }
        if parts[0] == c.year && parts[1] == c.month { return "this month" }
        let names = DateFormatter().standaloneMonthSymbols ?? []
        return names.indices.contains(parts[1] - 1) ? "in \(names[parts[1] - 1])" : "this month"
    }

    static func handle(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "^@", with: "", options: .regularExpression)
    }
}

// No crew yet: what a crew is, and a box to start one.
struct NoCrewSection: View {
    @EnvironmentObject var client: AgentClient
    let me: String
    @State private var name = ""
    @State private var busy = false
    @State private var problem: String?

    private var trimmed: String { name.trimmingCharacters(in: .whitespaces) }

    var body: some View {
        Section {
            Text("A crew is up to 8 people who work together: they share a ledger of who did what, crew notes, hand-offs between your agents, and a daily digest.")
                .fixedSize(horizontal: false, vertical: true)
            LabeledContent("Name") {
                HStack(spacing: 6) {
                    TextField("Crew name", text: $name, prompt: Text("e.g. \(me)'s crew"))
                        .labelsHidden()
                        .textFieldStyle(.roundedBorder)
                        .multilineTextAlignment(.leading)
                        .frame(width: 170)
                        .onSubmit(create)
                    Button("Create a crew", action: create).disabled(trimmed.isEmpty || busy)
                }
            }
            CrewProblem(text: problem)
            CrewCaption("You lead it. Add friends to it here, and people you invite join it when they sign in. Friends stay friends either way.")
        } header: {
            Text("Crew")
        }
        .onChange(of: name) { problem = nil }
    }

    private func create() {
        let crew = trimmed
        guard !crew.isEmpty, !busy else { return }
        busy = true
        Task {
            problem = await CrewActions.run(client, "createCrew", ["name": crew], done: "Started \(crew). Add your crewmates in Settings → Crew.")
            if problem == nil { name = "" }
            busy = false
        }
    }
}

// The crew's name, its plan, and (for the leader) the way to pay for it.
struct CrewAboutSection: View {
    @EnvironmentObject var client: AgentClient
    let crew: CrewInfo
    @State private var name = ""
    @State private var yearly = false
    @State private var busy = false
    @State private var problem: String?

    private var team: Bool { crew.plan == "team" }
    private var trimmed: String { name.trimmingCharacters(in: .whitespaces) }

    var body: some View {
        Section {
            if crew.iAmLeader {
                LabeledContent("Name") {
                    HStack(spacing: 6) {
                        TextField("Name", text: $name)
                            .labelsHidden()
                            .textFieldStyle(.roundedBorder)
                            .multilineTextAlignment(.leading)
                            .frame(width: 170)
                            .onSubmit(rename)
                        Button("Rename", action: rename).disabled(trimmed.isEmpty || trimmed == crew.name || busy)
                    }
                }
            } else {
                LabeledContent("Name", value: crew.name)
                LabeledContent("Leader", value: "@\(crew.leaderHandle)")
            }
            LabeledContent("Plan", value: planLine)
            if crew.iAmLeader {
                if team {
                    Button("Manage billing…") { open("billingPortal", [:]) }.disabled(busy)
                } else {
                    Picker("Pay", selection: $yearly) {
                        Text("Monthly · $10 a member").tag(false)
                        Text("Yearly · $100 a member").tag(true)
                    }
                    .pickerStyle(.segmented)
                    Button("Upgrade to Team…") { open("billingCheckout", ["yearly": yearly]) }.disabled(busy)
                }
            }
            CrewProblem(text: problem)
            CrewCaption(caption)
        } header: {
            Text("Crew")
        }
        .onAppear { name = crew.name }
        .onChange(of: crew.name) { name = crew.name }
    }

    private var planLine: String {
        guard team else { return "Free · up to 20 questions a day, 7-day ledger" }
        guard let until = crew.planUntil else { return "Team · $10 a member a month" }
        return "Team · $10 a member a month · paid until \(CrewFormat.date(until))"
    }

    private var caption: String {
        if team {
            return crew.iAmLeader
                ? "The daily digest and Slack, a 90-day ledger, 60 crew notes, unlimited hand-offs and the scout. Billing opens in your browser."
                : "The daily digest and Slack, a 90-day ledger, 60 crew notes, unlimited hand-offs and the scout. @\(crew.leaderHandle) looks after billing."
        }
        return crew.iAmLeader
            ? "Team adds the daily digest and Slack, a 90-day ledger, 60 crew notes, unlimited hand-offs and the scout. Checkout opens in your browser; you pay for each member."
            : "Team adds the daily digest and Slack, a 90-day ledger, 60 crew notes, unlimited hand-offs and the scout. Only @\(crew.leaderHandle) can upgrade."
    }

    private func rename() {
        let next = trimmed
        guard !next.isEmpty, next != crew.name, !busy else { return }
        busy = true
        Task {
            problem = await CrewActions.run(client, "renameCrew", ["name": next], done: "The crew is called \(next) now.")
            busy = false
        }
    }

    private func open(_ action: String, _ args: [String: Any]) {
        busy = true
        problem = nil
        Task {
            problem = await CrewActions.openPage(client, action, args)
            busy = false
        }
    }
}

// Everyone in the crew. The leader adds and removes people and can hand the lead on; anyone can leave.
struct CrewMembersSection: View {
    @EnvironmentObject var client: AgentClient
    let crew: CrewInfo
    let me: String
    @State private var handle = ""
    @State private var busy = false
    @State private var problem: String?
    @State private var asking: Change?

    enum Change: Identifiable {
        case leave, remove(String), lead(String)
        var id: String {
            switch self {
            case .leave: return "leave"
            case .remove(let h): return "remove \(h)"
            case .lead(let h): return "lead \(h)"
            }
        }
    }

    static let most = 8
    private var full: Bool { crew.members.count >= Self.most }
    // The leader stays until someone else leads, unless they are the only one left.
    private var mustHandOn: Bool { crew.iAmLeader && crew.members.count > 1 }

    var body: some View {
        Section {
            ForEach(crew.members) { member in
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(member.handle == me ? "@\(member.handle) (you)" : "@\(member.handle)")
                        if let name = member.name { Text(name).font(.caption).foregroundStyle(.secondary) }
                    }
                    Spacer()
                    Text(member.role == "leader" ? "leader" : "member").foregroundStyle(.secondary)
                    if crew.iAmLeader && member.handle != me {
                        Menu {
                            Button("Make @\(member.handle) the leader…") { asking = .lead(member.handle) }
                            Button("Remove @\(member.handle) from the crew…", role: .destructive) { asking = .remove(member.handle) }
                        } label: {
                            Image(systemName: "ellipsis.circle")
                        }
                        .menuStyle(.borderlessButton)
                        .menuIndicator(.hidden)
                        .fixedSize()
                        .help("Make @\(member.handle) the leader, or remove them")
                        .disabled(busy)
                    }
                }
            }
            if crew.iAmLeader {
                LabeledContent("Add a crewmate") {
                    HStack(spacing: 6) {
                        TextField("Handle", text: $handle, prompt: Text("e.g. adalovelace"))
                            .labelsHidden()
                            .textFieldStyle(.roundedBorder)
                            .multilineTextAlignment(.leading)
                            .frame(width: 150)
                            .onSubmit(add)
                        Button("Add", action: add).disabled(CrewFormat.handle(handle).isEmpty || busy || full)
                    }
                }
            }
            CrewProblem(text: problem)
            if crew.iAmLeader {
                CrewCaption(full
                    ? "The crew is full: 8 people at most."
                    : "They must be your friend on soopdoop already, and in no other crew. Someone new: invite them from the menu bar.")
            }
            HStack {
                if mustHandOn {
                    CrewCaption("You lead the crew: make someone else the leader before you leave.")
                }
                Spacer()
                Button("Leave the crew…", role: .destructive) { asking = .leave }.disabled(mustHandOn || busy)
            }
            .confirmationDialog(title, isPresented: Binding(get: { asking != nil }, set: { if !$0 { asking = nil } }), presenting: asking) { change in
                switch change {
                case .leave: Button("Leave", role: .destructive) { perform(change) }
                case .remove: Button("Remove", role: .destructive) { perform(change) }
                case .lead: Button("Make them the leader") { perform(change) }
                }
                Button("Cancel", role: .cancel) { asking = nil }
            } message: { change in
                Text(message(change))
            }
        } header: {
            Text("Members · \(crew.members.count) of \(Self.most)")
        }
        .onChange(of: handle) { problem = nil }
    }

    private var title: String {
        switch asking {
        case .leave: return crew.members.count == 1 ? "Leave and end \(crew.name)?" : "Leave \(crew.name)?"
        case .remove(let h): return "Remove @\(h) from \(crew.name)?"
        case .lead(let h): return "Make @\(h) the leader?"
        case nil: return ""
        }
    }

    private func message(_ change: Change) -> String {
        switch change {
        case .leave:
            if crew.members.count > 1 { return "You stop sharing the ledger, notes and hand-offs with the crew. The leader can add you again." }
            return crew.plan == "team"
                ? "You are the last one in it. A crew with a paid plan stays until its billing ends: cancel it in Manage billing first."
                : "You are the last one in it, so the crew ends and its notes and digests are deleted."
        case .remove(let h):
            return "@\(h) stops sharing the crew's ledger, notes and hand-offs. You stay friends, and you can add them again."
        case .lead(let h):
            return "@\(h) looks after the crew's members, settings and billing from now on. You stay in the crew."
        }
    }

    private func add() {
        let h = CrewFormat.handle(handle)
        guard !h.isEmpty, !busy, !full else { return }
        busy = true
        Task {
            problem = await CrewActions.run(client, "addToCrew", ["handle": h], done: "@\(h) is in the crew now.")
            if problem == nil { handle = "" }
            busy = false
        }
    }

    private func perform(_ change: Change) {
        asking = nil
        busy = true
        problem = nil
        Task {
            switch change {
            case .leave:
                problem = await CrewActions.run(client, "leaveCrew", done: "You left \(crew.name).")
            case .remove(let h):
                problem = await CrewActions.run(client, "removeFromCrew", ["handle": h], done: "@\(h) is out of the crew.")
            case .lead(let h):
                problem = await CrewActions.run(client, "handLeadership", ["handle": h], done: "@\(h) leads the crew now.")
            }
            busy = false
        }
    }
}

// When the daily digest goes out, in the crew's time zone.
struct CrewDigestSection: View {
    @EnvironmentObject var client: AgentClient
    let crew: CrewInfo
    @State private var zone = ""
    @State private var problem: String?

    private var here: String { TimeZone.current.identifier }
    private var typed: String { zone.trimmingCharacters(in: .whitespaces) }

    var body: some View {
        Section {
            if crew.iAmLeader {
                Picker("Posts at", selection: Binding(get: { crew.digestHour }, set: { hour in save(hour: hour, zone: crew.timezone) })) {
                    ForEach(0..<24, id: \.self) { Text(CrewFormat.hour($0)).tag($0) }
                }
                LabeledContent("Time zone") {
                    HStack(spacing: 6) {
                        TextField("Time zone", text: $zone, prompt: Text("e.g. America/Toronto"))
                            .labelsHidden()
                            .textFieldStyle(.roundedBorder)
                            .multilineTextAlignment(.leading)
                            .frame(width: 170)
                            .onSubmit { save(hour: crew.digestHour, zone: typed) }
                        Button("Save") { save(hour: crew.digestHour, zone: typed) }.disabled(typed.isEmpty || typed == crew.timezone)
                    }
                }
                if here != crew.timezone {
                    Button("Use this Mac's time zone, \(here)") { save(hour: crew.digestHour, zone: here) }
                        .buttonStyle(.link)
                }
                CrewProblem(text: problem)
            } else {
                LabeledContent("Posts at", value: "\(CrewFormat.hour(crew.digestHour)) · \(crew.timezone)")
            }
            CrewCaption(crew.plan == "team"
                ? "Each day at this hour the Operator writes \"Yesterday in \(crew.name)\" from the wire and the ledger. It shows in the HUD and goes to Slack."
                : "The daily digest comes with the Team plan: each day at this hour the Operator writes \"Yesterday in \(crew.name)\" for the HUD and Slack.")
        } header: {
            Text("Daily digest")
        }
        .onAppear { zone = crew.timezone }
        .onChange(of: crew.timezone) { zone = crew.timezone }
        .onChange(of: zone) { problem = nil }
    }

    private func save(hour: Int, zone: String) {
        Task {
            problem = await CrewActions.run(client, "setDigest", ["digestHour": hour, "timezone": zone],
                                            done: "The digest goes out at \(CrewFormat.hour(hour)), \(zone).")
        }
    }
}

// The crew's Slack channel: an incoming webhook (pasted, never shown again), the live mirror, a test post.
struct CrewSlackSection: View {
    @EnvironmentObject var client: AgentClient
    let crew: CrewInfo
    @State private var webhook = ""
    @State private var busy = false
    @State private var problem: String?
    @State private var removing = false

    private var typed: String { webhook.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        Section {
            LabeledContent("Status", value: status)
            if let error = crew.slackError {
                Text("The last post failed: \(error)").font(.caption).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            }
            if crew.iAmLeader {
                LabeledContent(crew.slackConnected ? "New webhook" : "Webhook") {
                    HStack(spacing: 6) {
                        TextField("Webhook", text: $webhook, prompt: Text("https://hooks.slack.com/services/…"))
                            .labelsHidden()
                            .textFieldStyle(.roundedBorder)
                            .multilineTextAlignment(.leading)
                            .frame(width: 210)
                            .onSubmit(save)
                        Button("Save", action: save).disabled(typed.isEmpty || busy)
                    }
                }
                Toggle("Live mirror: ships, props and saves as they happen", isOn: Binding(get: { crew.slackMirror }, set: { on in
                    Task {
                        problem = await CrewActions.run(client, "setSlackWebhook", ["mirror": on],
                                                        done: on ? "Ships, props and saves go to Slack as they happen." : "The live mirror is off.")
                    }
                }))
                .disabled(!crew.slackConnected)
                HStack {
                    Button("Send a test post") {
                        Task { problem = await CrewActions.run(client, "testSlack", done: "A test post is on its way to the crew's channel.") }
                    }
                    .disabled(!crew.slackConnected || busy)
                    Spacer()
                    Button("Remove…", role: .destructive) { removing = true }.disabled(!crew.slackConnected || busy)
                }
                .confirmationDialog("Disconnect Slack?", isPresented: $removing) {
                    Button("Disconnect", role: .destructive) { remove() }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("The digest stops going to the channel. To connect again you paste a webhook again.")
                }
                CrewProblem(text: problem)
                CrewCaption("In Slack, add the Incoming Webhooks app to the crew's channel and paste its webhook here. soopdoop never shows it again."
                    + (crew.plan == "team" ? "" : " Posts to Slack come with the Team plan."))
            } else {
                CrewCaption("@\(crew.leaderHandle) connects the crew's Slack channel.")
            }
        } header: {
            Text("Slack")
        }
        .onChange(of: webhook) { problem = nil }
    }

    private var status: String {
        guard crew.slackConnected else { return "Not connected" }
        guard let at = crew.slackPostedAt else { return "Connected" }
        return "Connected · last post \(CrewFormat.ago(at))"
    }

    private func save() {
        let url = typed
        guard !url.isEmpty, !busy else { return }
        busy = true
        Task {
            problem = await CrewActions.run(client, "setSlackWebhook", ["webhook": url, "mirror": crew.slackMirror],
                                            done: "Slack is connected. Send a test post to check the channel.")
            if problem == nil { webhook = "" }
            busy = false
        }
    }

    private func remove() {
        busy = true
        Task {
            problem = await CrewActions.run(client, "setSlackWebhook", ["webhook": NSNull()], done: "Slack is disconnected.")
            busy = false
        }
    }
}

// Intercom, for props from customers (the leader's): the access token, the client secret that signs Intercom's calls, and
// the address to paste into Intercom.
struct CrewIntercomSection: View {
    @EnvironmentObject var client: AgentClient
    let crew: CrewInfo
    @State private var token = ""
    @State private var secret = ""
    @State private var busy = false
    @State private var problem: String?
    @State private var removing = false

    var body: some View {
        Section {
            LabeledContent("Status", value: crew.intercomConnected ? "Connected" : "Not connected")
            LabeledContent("Access token") {
                SecureField("Access token", text: $token, prompt: Text(crew.intercomConnected ? "unchanged" : "paste it here"))
                    .labelsHidden()
                    .textFieldStyle(.roundedBorder)
                    .multilineTextAlignment(.leading)
                    .frame(width: 210)
            }
            LabeledContent("Client secret") {
                SecureField("Client secret", text: $secret, prompt: Text(crew.intercomConnected ? "unchanged" : "paste it here"))
                    .labelsHidden()
                    .textFieldStyle(.roundedBorder)
                    .multilineTextAlignment(.leading)
                    .frame(width: 210)
                    .onSubmit(save)
            }
            HStack {
                Button("Save", action: save).disabled((token.isEmpty && secret.isEmpty) || busy)
                Spacer()
                Button("Remove…", role: .destructive) { removing = true }.disabled(!crew.intercomConnected || busy)
            }
            .confirmationDialog("Disconnect Intercom?", isPresented: $removing) {
                Button("Disconnect", role: .destructive) { remove() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Ratings from Intercom stop reaching the wire. To connect again you paste the token and secret again.")
            }
            if let url = crew.intercomWebhookUrl {
                LabeledContent("Webhook address") {
                    HStack(spacing: 6) {
                        Text(url).lineLimit(1).truncationMode(.middle).textSelection(.enabled).frame(maxWidth: 200, alignment: .trailing)
                        Button {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(url, forType: .string)
                            client.toast = "Copied the address for Intercom's webhook settings."
                        } label: {
                            Image(systemName: "doc.on.doc")
                        }
                        .buttonStyle(.borderless)
                        .help("Copy the address")
                        .accessibilityLabel("Copy the webhook address")
                    }
                }
            }
            CrewProblem(text: problem)
            CrewCaption("When a customer rates a conversation 4 or 5, the props go on the wire for whoever's ledger line names it. In Intercom's Developer Hub, add this address as a webhook for conversation.rating.added. soopdoop never shows the token or secret again."
                + (crew.plan == "team" ? "" : " Props from customers come with the Team plan."))
        } header: {
            Text("Intercom")
        }
        .onChange(of: token) { problem = nil }
        .onChange(of: secret) { problem = nil }
    }

    private func save() {
        guard !(token.isEmpty && secret.isEmpty), !busy else { return }
        var args: [String: Any] = [:]
        if !token.isEmpty { args["token"] = token }
        if !secret.isEmpty { args["secret"] = secret }
        busy = true
        Task {
            problem = await CrewActions.run(client, "setIntercom", args, done: "Saved Intercom's settings.")
            if problem == nil {
                token = ""
                secret = ""
            }
            busy = false
        }
    }

    private func remove() {
        busy = true
        Task {
            problem = await CrewActions.run(client, "setIntercom", ["token": NSNull(), "secret": NSNull()], done: "Intercom is disconnected.")
            busy = false
        }
    }
}

// What each crewmate may do with hand-offs to my agents.
struct CrewConsentSection: View {
    @EnvironmentObject var client: AgentClient
    let consents: [Consent]

    var body: some View {
        Section {
            if consents.isEmpty {
                Text("Nobody else is in the crew yet.").foregroundStyle(.secondary)
            }
            ForEach(consents) { consent in
                Picker(selection: Binding(get: { consent.mode }, set: { mode in set(consent.handle, mode) })) {
                    Text("Ask me each time").tag("ask")
                    Text("Run when my agent is idle").tag("auto")
                    Text("Never").tag("never")
                } label: {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("@\(consent.handle)")
                        if let name = consent.name { Text(name).font(.caption).foregroundStyle(.secondary) }
                    }
                }
            }
            CrewCaption("A hand-off is a task a crewmate sends to one of your agents, in their exact words. It runs on your account, within this Mac's daily allowance (Settings → This Mac).")
        } header: {
            Text("Hand-offs to my agents")
        }
    }

    private func set(_ handle: String, _ mode: String) {
        let done: String
        switch mode {
        case "auto": done = "Hand-offs from @\(handle) run when your agent is idle."
        case "never": done = "Hand-offs from @\(handle) are off."
        default: done = "Hand-offs from @\(handle) wait for your yes."
        }
        client.run("setConsent", ["handle": handle, "mode": mode], done: done)
    }
}

// Whose agents may post crew notes without asking (the leader's).
struct CrewNotesSection: View {
    @EnvironmentObject var client: AgentClient
    let crew: CrewInfo

    var body: some View {
        Section {
            ForEach(crew.members) { member in
                Toggle(isOn: Binding(get: { crew.trustedNotePosters.contains(member.handle) }, set: { on in set(member.handle, on) })) {
                    Text("@\(member.handle)")
                }
            }
            CrewCaption("Notes from these people's agents go live at once. Other agents propose a note, and its owner or you approve it."
                + (crew.plan == "team" ? "" : " Agents post notes on the Team plan."))
        } header: {
            Text("Crew notes from agents")
        }
    }

    private func set(_ handle: String, _ on: Bool) {
        var handles = crew.trustedNotePosters.filter { $0 != handle }
        if on { handles.append(handle) }
        client.run("setTrustedNotePosters", ["handles": handles],
                   done: on ? "Notes from @\(handle)'s agents go live at once." : "Notes from @\(handle)'s agents wait for approval.")
    }
}

// What the crew's Operator cost this month, at API prices.
struct CrewCostSection: View {
    let costs: Costs?
    let team: Bool

    var body: some View {
        Section {
            if let costs {
                Text("The Operator cost the crew \(CrewFormat.usd(costs.operatorUsd)) \(CrewFormat.month(costs.month)); the digest \(CrewFormat.usd(costs.digestUsd)).")
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("Not counted yet.").foregroundStyle(.secondary)
            }
            CrewCaption(team
                ? "At API prices, for routing and answering the crew's questions and writing the digest. The Team plan includes it."
                : "At API prices, for routing and answering the crew's questions. Each person's own agents run on their own plans.")
        } header: {
            Text("Cost")
        }
    }
}
