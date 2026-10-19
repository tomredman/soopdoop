// ABOUTME: The one request on screen at a time: a knock first, then a hand-off offered to me, then a heads-up; the rest wait
// ABOUTME: in the "+N waiting" chip. Each card has a countdown the backend enforces. Every button sends one action to the agent.
import SwiftUI

struct RequestCard: View {
    let state: AppState

    var body: some View {
        let offers = Self.offers(state)
        let headsups = state.headsups
        let knocks = state.incoming.pending
        if let knock = state.incoming.current {
            KnockCard(knock: knock, pending: knocks + offers.count + headsups.count)
        } else if let offer = offers.first {
            HandoffCard(offer: offer, state: state, pending: knocks + offers.count - 1 + headsups.count).id(offer.id)
        } else if let headsup = headsups.first {
            HeadsupCard(headsup: headsup, pending: knocks + headsups.count - 1).id(headsup.id)
        }
    }

    // Offers waiting for my answer, the one that runs out first at the front. Accepted ones are no longer requests.
    static func offers(_ state: AppState) -> [IncomingHandoff] {
        state.handoffs.incoming.filter { $0.status == "offered" }.sorted { $0.expiresAt < $1.expiresAt }
    }

    // Whether a request card is on screen now.
    static func showing(_ state: AppState) -> Bool {
        state.incoming.current != nil || !offers(state).isEmpty || !state.headsups.isEmpty
    }
}

// One of my open agents, on one of my Macs: where a hand-off can run. Private agents never take one.
struct AgentChoice: Identifiable, Hashable {
    let machine: String
    let agentId: String
    let name: String
    let status: String
    var id: String { "\(machine)\t\(agentId)" }

    static func all(_ state: AppState) -> [AgentChoice] {
        state.subset.flatMap { m in
            m.agents.filter(\.open).map { AgentChoice(machine: m.machineName, agentId: $0.agentId, name: $0.name, status: $0.status) }
        }
    }
}

// A crewmate hands me a task: their exact words, which of my agents would get it, and how long the offer lasts (a day; the
// backend ends it). Run now and Run when idle both accept it: this Mac gives it to the agent as soon as that agent is idle.
// Reply… declines it with a line back. When the offer names none of my open agents, I pick one first.
struct HandoffCard: View {
    @EnvironmentObject var client: AgentClient
    let offer: IncomingHandoff
    let state: AppState
    let pending: Int
    @State private var picked: String
    @State private var replying: Bool
    @State private var reply = ""
    @State private var showAll = false

    // The backend keeps a reply note to 500 characters (handoffs.ts MAX_NOTE).
    static let replyLimit = 500

    init(offer: IncomingHandoff, state: AppState, pending: Int, picked: String = "", replying: Bool = false) {
        self.offer = offer
        self.state = state
        self.pending = pending
        _picked = State(initialValue: picked)
        _replying = State(initialValue: replying)
    }

    var body: some View {
        let choices = AgentChoice.all(state)
        let named = choices.first { $0.agentId == offer.targetAgentId && (offer.targetMachine == nil || $0.machine == offer.targetMachine) }
        let target = named ?? choices.first { $0.id == picked }
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center) {
                (Text("@\(offer.fromHandle)").font(Theme.mono(12, .bold)) + Text(" hands you a task").font(.system(size: 12)))
                    .foregroundStyle(Theme.text)
                Spacer(minLength: 4)
                CountdownRing(expiresAt: offer.expiresAt, lifetimeMs: max(1, offer.expiresAt - offer.createdAt))
            }
            words
            agentLine(choices: choices, named: named)
            if replying {
                replyBox
            } else {
                buttons(target: target)
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.panel2))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line2, lineWidth: 1))
    }

    // The task exactly as it was written, and why them when it says.
    private var words: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("“\(offer.text)”")
                .font(Theme.mono(11.5))
                .foregroundStyle(Theme.text)
                .lineLimit(showAll ? nil : 6)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            if offer.text.count > 280 {
                Button(showAll ? "less" : "show all of it") { showAll.toggle() }
                    .buttonStyle(.plain).font(Theme.mono(9.5)).foregroundStyle(Theme.dim)
            }
            if let why = offer.why, !why.isEmpty {
                Text("why you: \(why)").font(Theme.mono(10.5)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 6).fill(Theme.ground))
    }

    // "→ your email-metrics agent · idle", or a picker of my open agents when the offer names none of them.
    @ViewBuilder private func agentLine(choices: [AgentChoice], named: AgentChoice?) -> some View {
        let machines = Set(choices.map(\.machine)).count
        if let named {
            let on = machines > 1 ? " on \(named.machine)" : ""
            Text("→ your \(NoBreak.text(offer.targetAgentName ?? named.name)) agent\(on) · \(named.status)")
                .font(Theme.mono(10.5)).foregroundStyle(Theme.muted).lineLimit(2)
        } else if choices.isEmpty {
            Text("None of your agents is open right now. Start one to run it, or decline.")
                .font(Theme.mono(10.5)).foregroundStyle(Theme.amber).fixedSize(horizontal: false, vertical: true)
        } else {
            VStack(alignment: .leading, spacing: 4) {
                Text(offer.targetAgentId == nil
                     ? "→ which of your agents should run it?"
                     : "→ your \(offer.targetAgentName ?? "chosen") agent is not open now. Pick another:")
                    .font(Theme.mono(10.5)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                Picker("Agent", selection: $picked) {
                    Text("Pick an agent").tag("")
                    ForEach(choices) { c in
                        Text(machines > 1 ? "\(c.name) on \(c.machine) · \(c.status)" : "\(c.name) · \(c.status)").tag(c.id)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .font(Theme.mono(11))
                .fixedSize()
            }
        }
    }

    @ViewBuilder private func buttons(target: AgentChoice?) -> some View {
        let run = Button("Run now") { accept(target, now: true) }
            .buttonStyle(HUDButtonStyle(primary: true))
            .disabled(target == nil)
            .help("Your agent gets it now if it is idle, or the moment it is.")
        let idle = Button("Run when idle") { accept(target, now: false) }
            .buttonStyle(HUDButtonStyle())
            .disabled(target == nil)
            .help("Your agent gets it the next time it is idle.")
        let decline = Button("Decline") {
            client.run("decideHandoff", ["handoffId": offer.id, "outcome": "decline"], done: "Declined. @\(offer.fromHandle) sees that in their HUD.")
        }
        .buttonStyle(HUDButtonStyle())
        let answer = Button("Reply…") { replying = true }
            .buttonStyle(HUDButtonStyle())
            .help("Decline with a line back to @\(offer.fromHandle)")
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { run; idle; decline; answer; Spacer(minLength: 0); waiting }
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) { run; idle; Spacer(minLength: 0) }
                HStack(spacing: 8) { decline; answer; Spacer(minLength: 0); waiting }
            }
        }
    }

    // The other requests behind this one.
    @ViewBuilder private var waiting: some View {
        if pending > 0 { Chip(text: "+\(pending) waiting") }
    }

    private var replyBox: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField("A line back to @\(offer.fromHandle)…", text: $reply)
                .textFieldStyle(.roundedBorder)
                .font(Theme.mono(11))
                .onSubmit(sendReply)
            HStack {
                Spacer()
                Button("Cancel") { replying = false }.buttonStyle(HUDButtonStyle())
                Button("Send and decline", action: sendReply)
                    .buttonStyle(HUDButtonStyle(primary: true))
                    .disabled(reply.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .onChange(of: reply) { if reply.count > Self.replyLimit { reply = String(reply.prefix(Self.replyLimit)) } }
    }

    private func accept(_ target: AgentChoice?, now: Bool) {
        guard let target else { return }
        var args: [String: Any] = ["handoffId": offer.id, "outcome": "accept"]
        // An agent picked here goes with the answer; the one the offer named is already on it.
        if target.agentId != offer.targetAgentId || (offer.targetMachine != nil && target.machine != offer.targetMachine) {
            args["targetAgentId"] = target.agentId
            args["targetMachine"] = target.machine
        }
        let name = target.agentId == offer.targetAgentId ? offer.targetAgentName ?? target.name : target.name
        let when = now && target.status == "idle" ? "now" : "when it is idle"
        client.run("decideHandoff", args, done: "Accepted. Your \(name) agent gets it \(when).")
    }

    private func sendReply() {
        let note = reply.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !note.isEmpty else { return }
        client.run("decideHandoff", ["handoffId": offer.id, "outcome": "decline", "note": note],
                   done: "Declined with your note. @\(offer.fromHandle) sees it in their HUD.")
        replying = false
    }
}

// A crewmate's agent is already on what one of mine just started. Ask it first (the Operator chat opens with "@jimmy: "
// typed in), hand the task to it, or let it go. The backend ends the card after 10 minutes.
struct HeadsupCard: View {
    @EnvironmentObject var client: AgentClient
    let headsup: Headsup
    let pending: Int
    @State private var handingOff: Bool

    init(headsup: Headsup, pending: Int, handingOff: Bool = false) {
        self.headsup = headsup
        self.pending = pending
        _handingOff = State(initialValue: handingOff)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center) {
                Text("Heads-up").font(.system(size: 12, weight: .bold)).foregroundStyle(Theme.text)
                Spacer(minLength: 4)
                if pending > 0 { Chip(text: "+\(pending) waiting") }
                CountdownRing(expiresAt: headsup.expiresAt, lifetimeMs: max(1, headsup.expiresAt - headsup.at))
            }
            Text(headsup.line)
                .font(Theme.mono(11.5))
                .foregroundStyle(Theme.text)
                .fixedSize(horizontal: false, vertical: true)
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 6).fill(Theme.ground))
            if handingOff {
                HandoffComposer(toHandle: headsup.otherHandle, targetAgentId: headsup.otherAgentId,
                                targetAgentName: headsup.otherAgentName, via: "headsup") { handingOff = false }
            } else {
                HStack(spacing: 8) {
                    Button("Ask") { ChatWindow.shared?.show(prefill: "@\(headsup.otherHandle): ") }
                        .buttonStyle(HUDButtonStyle(primary: true))
                        .help("Ask @\(headsup.otherHandle)'s agent in the Operator chat before you go on")
                    Button("Hand off") { handingOff = true }
                        .buttonStyle(HUDButtonStyle())
                        .help("Hand this task to @\(headsup.otherHandle)'s agent. They say yes first.")
                    Button("Not now") { client.run("dismissHeadsup", ["headsupId": headsup.id]) }
                        .buttonStyle(HUDButtonStyle())
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.panel2))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line2, lineWidth: 1))
    }
}
