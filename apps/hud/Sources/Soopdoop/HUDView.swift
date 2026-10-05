// ABOUTME: The HUD's content: sign-in and handle screens, then you (rank, XP), the knock on screen, friend requests, flicks,
// ABOUTME: the crew, the Operator (how many answers today), the board, and this Mac. Every action goes through the agent.
import AppKit
import SwiftUI

struct HUDRoot: View {
    @EnvironmentObject var client: AgentClient
    @EnvironmentObject var style: HUDStyle

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            TitleBar()
            Rectangle().fill(Theme.line).frame(height: 1)
            ScrollView {
                VStack(alignment: .leading, spacing: style.pad) {
                    content
                }
                .padding(style.pad + 2)
            }
            .scrollIndicators(.never)
            if let toast = client.toast {
                ToastView(text: toast).transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .background(Background())
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Theme.line2.opacity(0.9), lineWidth: 1))
        .environment(\.colorScheme, .dark)
        .animation(.spring(duration: 0.3), value: client.toast)
    }

    @ViewBuilder private var content: some View {
        if !client.connected || client.state == nil {
            Offline()
        } else if let state = client.state {
            switch state.phase {
            case "signed-out": SignIn(state: state)
            case "signing-in": Waiting(text: "Finish signing in with Superset in your browser.")
            case "connecting": Waiting(text: "Connecting…")
            case "needs-handle": PickHandle(state: state)
            default: Main(state: state)
            }
        }
    }
}

struct Background: View {
    @EnvironmentObject var style: HUDStyle

    var body: some View {
        ZStack {
            if let effect = style.material.effect {
                VisualEffect(material: effect).opacity(style.opacity)
                // A dark tint, so text reads whatever window is behind the glass.
                Theme.ground.opacity(style.opacity * 0.6)
            } else {
                Theme.panel.opacity(style.opacity)
            }
        }
    }
}

struct TitleBar: View {
    @EnvironmentObject var client: AgentClient

    var body: some View {
        HStack(spacing: 8) {
            HStack(spacing: 0) {
                Text("soop").foregroundStyle(Theme.text)
                Text("doop").foregroundStyle(Theme.purple)
            }
            .font(Theme.mono(13, .bold))
            Spacer()
            if let me = client.state?.me {
                if let until = me.focusUntil, until > Date().timeIntervalSince1970 * 1000 {
                    Chip(text: "focus", color: Theme.amber)
                }
                Text("@\(me.handle)").font(Theme.mono(11, .semibold)).foregroundStyle(Theme.text)
            }
            if #available(macOS 14.0, *) {
                SettingsLink {
                    Image(systemName: "gearshape").foregroundStyle(Theme.muted)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

// The HUD's message line, in soopdoop green: what just happened (a flick, a catch, an invite copied), for 6 seconds.
struct ToastView: View {
    @EnvironmentObject var client: AgentClient
    let text: String

    var body: some View {
        HStack(alignment: .top) {
            Text(text).font(Theme.mono(11, .semibold)).foregroundStyle(Theme.ground).fixedSize(horizontal: false, vertical: true)
            Spacer()
            Button { client.toast = nil } label: { Image(systemName: "xmark").font(.system(size: 9, weight: .bold)) }
                .buttonStyle(.plain)
                .foregroundStyle(Theme.ground.opacity(0.6))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .background(Theme.green)
        .task(id: text) {
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            if client.toast == text { client.toast = nil }
        }
    }
}

struct Offline: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("soopdoop is not running on this Mac.").font(Theme.mono(12)).foregroundStyle(Theme.text)
            Text("Run `soopdoop setup` in Terminal. The HUD connects by itself once it is up.")
                .font(Theme.mono(11)).foregroundStyle(Theme.muted)
            ProgressView().controlSize(.small)
        }
    }
}

struct Waiting: View {
    let text: String

    var body: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(text).font(Theme.mono(11)).foregroundStyle(Theme.muted)
        }
    }
}

struct SignIn: View {
    @EnvironmentObject var client: AgentClient
    let state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Your Superset, with your crew in it.").font(.system(size: 13)).foregroundStyle(Theme.text)
            if state.inviteWaiting {
                Text("You have an invite waiting. Sign in to accept it.").font(Theme.mono(11)).foregroundStyle(Theme.green)
            }
            Button("Sign in with Superset") { client.run("signIn") }
                .buttonStyle(HUDButtonStyle(primary: true))
            if let message = state.message { Text(message).font(Theme.mono(11)).foregroundStyle(Theme.amber) }
            Text("Your browser opens Superset's sign-in. soopdoop never sees your password.")
                .font(Theme.mono(10)).foregroundStyle(Theme.dim)
        }
    }
}

struct PickHandle: View {
    @EnvironmentObject var client: AgentClient
    let state: AppState
    @State private var handle = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Pick a handle").font(Theme.mono(12, .semibold)).foregroundStyle(Theme.text)
            TextField("e.g. ada-lovelace", text: $handle)
                .textFieldStyle(.roundedBorder)
                .font(Theme.mono(12))
                .onSubmit(claim)
            Button("Claim it", action: claim).buttonStyle(HUDButtonStyle(primary: true)).disabled(handle.isEmpty)
            Text("2 to 39 lowercase letters, digits and single hyphens. Use your Superset handle and your public profile is linked too.")
                .font(Theme.mono(10)).foregroundStyle(Theme.dim).fixedSize(horizontal: false, vertical: true)
        }
    }

    private func claim() {
        client.run("claimHandle", ["handle": handle.trimmingCharacters(in: .whitespaces)])
    }
}

struct Main: View {
    @EnvironmentObject var client: AgentClient
    @EnvironmentObject var style: HUDStyle
    let state: AppState

    var body: some View {
        MeCard(state: state)
        Notices(state: state)
        if let knock = state.incoming.current { KnockCard(knock: knock, pending: state.incoming.pending) }
        ForEach(state.requests) { request in
            HStack {
                Text("@\(request.handle)").font(Theme.mono(11, .semibold)).foregroundStyle(Theme.text)
                Text("wants to be friends").font(Theme.mono(11)).foregroundStyle(Theme.muted)
                Spacer()
                Button("Accept") { client.run("acceptFriend", ["handle": request.handle], done: "You and @\(request.handle) are friends now.") }
                    .buttonStyle(HUDButtonStyle(primary: true))
            }
            .padding(6)
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.line2, style: StrokeStyle(lineWidth: 1, dash: [3])))
        }
        ForEach(state.flicks.incoming) { flick in FlickRow(flick: flick) }
        // In the order chosen in Settings.
        ForEach(style.order) { section in
            if style.shows(section) {
                switch section {
                case .crew: CrewSection(state: state)
                case .operatorLine: OperatorSection(state: state)
                case .board: BoardSection(state: state)
                case .machine: MachineSection(state: state)
                }
            }
        }
    }
}

struct MeCard: View {
    let state: AppState

    var body: some View {
        if let row = state.myRow {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Chip(text: row.rank, color: Theme.green)
                    if let tier = state.me?.superset?.tier { Chip(text: tier) }
                    Spacer()
                    Text("\(row.xp) XP").font(Theme.mono(11, .semibold)).foregroundStyle(Theme.text)
                }
                XPBar(row: row)
                HStack {
                    Text("\(row.assists) assist\(row.assists == 1 ? "" : "s") · \(row.asks) asked").font(Theme.mono(10)).foregroundStyle(Theme.dim)
                    Spacer()
                    if let next = row.nextRankAt {
                        Text("\(next - row.xp) to next rank").font(Theme.mono(10)).foregroundStyle(Theme.dim)
                    }
                }
            }
        }
    }
}

struct Notices: View {
    @EnvironmentObject var client: AgentClient
    let state: AppState

    var body: some View {
        if let local = state.local, local.newer, let latest = local.latest {
            HStack(spacing: 8) {
                Text(local.updating ? "Updating to \(latest)…" : "soopdoop \(latest) is out.")
                    .font(Theme.mono(11)).foregroundStyle(Theme.text)
                Spacer()
                if local.canUpdate && !local.updating {
                    Button("Update now") { client.run("updateNow") }.buttonStyle(HUDButtonStyle(primary: true))
                }
            }
            .padding(6)
            .background(RoundedRectangle(cornerRadius: 8).fill(Theme.panel2))
        }
        if let message = state.message {
            Text(message).font(Theme.mono(11)).foregroundStyle(Theme.green).fixedSize(horizontal: false, vertical: true)
        }
        if let local = state.local, !local.paired {
            Text("Connecting this Mac…").font(Theme.mono(10)).foregroundStyle(Theme.dim)
        }
    }
}

struct KnockCard: View {
    @EnvironmentObject var client: AgentClient
    let knock: Knock
    let pending: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center) {
                (Text("@\(knock.fromHandle)").font(Theme.mono(12, .bold)) + Text(" wants you to see this").font(.system(size: 12)))
                    .foregroundStyle(Theme.text)
                Spacer()
                CountdownRing(expiresAt: knock.expiresAt, lifetimeMs: knock.lifetimeMs)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(knock.item.kind.uppercased()).font(Theme.mono(9)).tracking(1).foregroundStyle(Theme.purple)
                Text(knock.item.title).font(Theme.mono(12)).foregroundStyle(Theme.text).lineLimit(2)
                if let note = knock.note { Text("“\(note)”").font(Theme.mono(11)).foregroundStyle(Theme.muted) }
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 6).fill(Theme.ground))
            HStack {
                Button(knock.item.url == nil ? "Got it" : "Show me") { client.run("decideKnock", ["outcome": "opened"]) }
                    .buttonStyle(HUDButtonStyle(primary: true))
                Button("Not now") { client.run("decideKnock", ["outcome": "not-now"]) }
                    .buttonStyle(HUDButtonStyle())
                Spacer()
                if pending > 0 { Chip(text: "+\(pending) waiting") }
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10).fill(Theme.panel2))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line2, lineWidth: 1))
    }
}

struct CrewSection: View {
    @EnvironmentObject var client: AgentClient
    @EnvironmentObject var style: HUDStyle
    let state: AppState
    @State private var composing: String?
    @State private var adding = false
    @State private var handle = ""

    var body: some View {
        SectionHeader(title: "Crew", trailing: state.crew.isEmpty ? nil : "\(state.crew.count)\(superflickLine)")
        if state.crew.isEmpty {
            Text("No crew yet. Invite someone from the menu bar: soopdoop → Invite someone new.")
                .font(Theme.mono(10)).foregroundStyle(Theme.dim).fixedSize(horizontal: false, vertical: true)
        }
        ForEach(state.crew) { friend in
            FriendRow(friend: friend, flicked: state.flicks.waitingOn.contains(friend.handle), canSuperflick: state.flicks.superflicks.ready > 0, composing: $composing)
            if composing == friend.handle { KnockComposer(handle: friend.handle, composing: $composing) }
        }
        SentKnocks(sent: state.sent)
        // For someone who is already on soopdoop. Someone new needs an invite instead.
        if adding {
            HStack(spacing: 6) {
                TextField("their soopdoop or Superset handle", text: $handle)
                    .textFieldStyle(.roundedBorder)
                    .font(Theme.mono(11))
                    .onSubmit(add)
                Button("Add", action: add).buttonStyle(HUDButtonStyle(primary: true)).disabled(handle.isEmpty)
                Button("Cancel") {
                    adding = false
                    handle = ""
                }
                .buttonStyle(HUDButtonStyle())
            }
        } else {
            Button("+ add a friend by handle") { adding = true }
                .buttonStyle(.plain)
                .font(Theme.mono(10))
                .foregroundStyle(Theme.dim)
        }
    }

    // Someone on soopdoop gets a friend request. Anyone else gets an invite, and its message goes on the clipboard.
    // "⚡ 3/5" toward the next superflick, or "⚡ 1 ready".
    private var superflickLine: String {
        let s = state.flicks.superflicks
        if s.ready > 0 { return " · ⚡ \(s.ready) ready" }
        return s.clean > 0 ? " · ⚡ \(s.clean)/\(s.every)" : ""
    }

    private func add() {
        let h = handle.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "^@", with: "", options: .regularExpression)
        guard !h.isEmpty else { return }
        handle = ""
        adding = false
        Task {
            do {
                let result = try await client.act("addOrInvite", ["handle": h]) as? [String: Any] ?? [:]
                client.toast = AddFriend.outcome(result, typed: h, showNames: style.showNames)
            } catch {
                client.toast = (error as? AgentError)?.message ?? error.localizedDescription
            }
        }
    }
}

// What adding a friend by handle did, as one toast. An invite's message goes on the clipboard, ready for Slack.
enum AddFriend {
    @MainActor static func outcome(_ result: [String: Any], typed: String, showNames: Bool) -> String {
        let handle = result["handle"] as? String ?? typed
        if result["kind"] as? String == "asked" {
            let via = result["viaSuperset"] as? Bool == true ? " (@\(typed) on Superset)" : ""
            return "Asked @\(handle)\(via) to be friends. They join your crew when they accept."
        }
        if let message = result["message"] as? String {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(message, forType: .string)
        }
        if result["onSuperset"] as? Bool == true {
            let who = showNames ? result["name"] as? String ?? "@\(handle)" : "@\(handle)"
            return "\(who) is on Superset but not soopdoop yet. Invite link copied: send it to them. They join your crew when they sign in."
        }
        return "Nobody is @\(handle) on soopdoop or Superset. Invite link copied: send it to them."
    }
}

extension AgentClient {
    // A flick: the toast says how long the rally is, and what is at stake.
    func flick(_ handle: String) {
        Task {
            do {
                let result = try await act("flick", ["handle": handle]) as? [String: Any]
                let rally = result?["rally"] as? Int ?? 1
                toast = rally > 1 ? "Flicked @\(handle) back. Rally: \(rally). Hope they're slow." : "Flicked @\(handle). Hope they're slow."
            } catch {
                toast = (error as? AgentError)?.message ?? error.localizedDescription
            }
        }
    }

    // Caught in time: the flicker's XP is yours.
    func catchFlick(_ id: String) {
        Task {
            do {
                let result = try await act("catchFlick", ["flickId": id]) as? [String: Any]
                let from = result?["fromHandle"] as? String ?? "them"
                let xp = result?["xp"] as? Int ?? 0
                toast = xp > 0 ? "Caught! You took \(xp) XP from @\(from)." : "Caught @\(from)'s flick, but they had no XP to take."
            } catch {
                toast = (error as? AgentError)?.message ?? error.localizedDescription
            }
        }
    }

    func superflick(_ handle: String) {
        Task {
            do {
                let result = try await act("superflick", ["handle": handle]) as? [String: Any]
                let xp = result?["xp"] as? Int ?? 0
                toast = xp > 0 ? "SUPERFLICK! You took \(xp) XP from @\(handle)." : "Superflicked @\(handle), but they had no XP to take."
            } catch {
                toast = (error as? AgentError)?.message ?? error.localizedDescription
            }
        }
    }
}

// A friend flicked you. Catch it in its first 10 seconds and you take their XP; after that, flick back and the rally goes
// on. A superflick already took your XP and cannot be caught. Either goes away by itself after 10 minutes.
struct FlickRow: View {
    @EnvironmentObject var client: AgentClient
    let flick: IncomingFlick
    @State private var wiggle = false

    var body: some View {
        Group {
            if flick.superflick {
                // Rare and loud: the name on its own line, the loss and the button under it.
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        hand
                        who
                        Spacer(minLength: 0)
                    }
                    HStack(spacing: 6) {
                        Text(flick.xp > 0 ? "took \(flick.xp) XP" : "you had no XP to take").font(Theme.mono(10)).foregroundStyle(Theme.amber).lineLimit(1)
                        Spacer(minLength: 4)
                        Button("flick back") { client.flick(flick.fromHandle) }.buttonStyle(HUDButtonStyle())
                    }
                    .padding(.leading, 17)
                }
            } else {
                TimelineView(.periodic(from: .now, by: 0.5)) { context in
                    let left = flick.catchUntil - context.date.timeIntervalSince1970 * 1000
                    HStack(spacing: 6) {
                        hand
                        // The rally shows only when it fits; "@mira flicked you" always does.
                        ViewThatFits(in: .horizontal) {
                            HStack(spacing: 6) {
                                who
                                if flick.rally > 1 { Text("rally \(flick.rally)").font(Theme.mono(10)).foregroundStyle(Theme.dim).lineLimit(1) }
                            }
                            who
                        }
                        Spacer(minLength: 4)
                        if left > 0 {
                            Button("catch! \(Int((left / 1000).rounded(.up)))") { client.catchFlick(flick.id) }
                                .buttonStyle(HUDButtonStyle(primary: true))
                        } else {
                            Button("flick back") { client.flick(flick.fromHandle) }.buttonStyle(HUDButtonStyle(primary: true))
                        }
                    }
                }
            }
        }
        .padding(6)
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(flick.superflick ? Theme.purple.opacity(0.7) : Theme.line2, style: StrokeStyle(lineWidth: 1, dash: [3])))
        .onAppear {
            withAnimation(.easeInOut(duration: 0.08).repeatCount(6, autoreverses: true)) { wiggle = true }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { wiggle = false }
        }
    }

    private var hand: some View {
        Image(systemName: flick.superflick ? "bolt.fill" : "hand.point.right.fill")
            .font(.system(size: 11))
            .foregroundStyle(flick.superflick ? Theme.purple : Theme.amber)
            .rotationEffect(.degrees(wiggle ? -18 : 0), anchor: .leading)
    }

    private var who: some View {
        (Text("@\(flick.fromHandle)").font(Theme.mono(11, .semibold)) + Text(flick.superflick ? " superflicked you" : " flicked you").font(Theme.mono(11)))
            .foregroundStyle(Theme.text)
            .lineLimit(1)
    }
}

// The knocks I sent: waiting with a countdown, "they're looking", or "not now". Expired knocks make no noise.
struct SentKnocks: View {
    let sent: [SentKnock]

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let now = context.date.timeIntervalSince1970 * 1000
            let rows = sent.filter { r in
                r.outcome == "open" ? r.expiresAt > now - 1_000 : r.outcome != "expired" && now - r.expiresAt < 10 * 60_000
            }
            if !rows.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("YOU KNOCKED").font(Theme.mono(9)).tracking(1).foregroundStyle(Theme.dim)
                    ForEach(rows) { r in
                        HStack {
                            Text("@\(r.toHandle)").font(Theme.mono(10.5, .semibold)).foregroundStyle(Theme.text)
                            Spacer()
                            Text(label(r, now)).font(Theme.mono(10)).foregroundStyle(r.outcome == "opened" ? Theme.green : Theme.muted)
                        }
                    }
                }
            }
        }
    }

    private func label(_ r: SentKnock, _ now: Double) -> String {
        switch r.outcome {
        case "open": return "waiting · \(CountdownRing.label(max(0, r.expiresAt - now)))"
        case "opened": return "they're looking"
        default: return "not now"
        }
    }
}

struct FriendRow: View {
    @EnvironmentObject var client: AgentClient
    @EnvironmentObject var style: HUDStyle
    let friend: Friend
    // I flicked them and wait for a flick back.
    let flicked: Bool
    // I have a superflick to use.
    let canSuperflick: Bool
    @Binding var composing: String?
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Avatar(handle: friend.handle, led: friend.relaying ? Theme.purple : LED.color(for: friend.led), pulse: friend.relaying)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 4) {
                        Text("@\(friend.handle)").font(Theme.mono(style.bodySize, .semibold)).foregroundStyle(Theme.text)
                        if style.showNames, let name = friend.superset?.name {
                            Text(name).font(.system(size: style.smallSize)).foregroundStyle(Theme.muted).lineLimit(1)
                        }
                    }
                    Text(stateLine).font(Theme.mono(style.smallSize)).foregroundStyle(friend.relaying ? Theme.purple : Theme.muted).lineLimit(1)
                }
                Spacer(minLength: 4)
                // A small hand, so names keep their room. Offline is fine for a flick: it waits 10 minutes. Focus bounces it.
                Button { client.flick(friend.handle) } label: {
                    Image(systemName: flicked ? "hand.point.right.fill" : "hand.point.right")
                }
                .buttonStyle(HUDButtonStyle())
                .disabled(flicked || friend.inFocus)
                .opacity(flicked || friend.inFocus ? 0.4 : 1)
                .help(flicked ? "Flicked. Waiting for @\(friend.handle) to flick back." : "flick: if they catch it in 10 seconds, they take your XP")
                .accessibilityLabel(flicked ? "flicked" : "flick")
                if canSuperflick {
                    Button { client.superflick(friend.handle) } label: { Image(systemName: "bolt.fill").foregroundStyle(Theme.purple) }
                        .buttonStyle(HUDButtonStyle())
                        .help("SUPERFLICK: take up to 10 XP from @\(friend.handle). Nobody catches a superflick.")
                        .accessibilityLabel("superflick")
                }
                let reachable = friend.led != "x" && !friend.inFocus
                Button("knock") { composing = composing == friend.handle ? nil : friend.handle }
                    .buttonStyle(HUDButtonStyle())
                    .disabled(!reachable)
                    .opacity(reachable ? 1 : 0.4)
            }
            .contentShape(Rectangle())
            .onTapGesture { open.toggle() }
            if open { details.padding(.leading, 34) }
        }
    }

    private var stateLine: String {
        if friend.relaying { return "answering the Operator…" }
        if friend.inFocus { return "in focus" }
        if friend.led == "x" { return "offline" }
        let agents = friend.agentCount == 0 ? "∅ empty subset" : "\(friend.agentCount) agent\(friend.agentCount == 1 ? "" : "s")"
        if let tier = friend.superset?.tier { return "\(agents) · \(tier)" }
        return agents
    }

    @ViewBuilder private var details: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(friend.agents ?? [], id: \.self) { agent in
                HStack(spacing: 6) {
                    LED(color: LED.color(for: agent.status), size: 6)
                    Text(agent.name).font(Theme.mono(10.5)).foregroundStyle(Theme.text)
                    if let ws = agent.workspace, ws != agent.name { Text(ws).font(Theme.mono(10)).foregroundStyle(Theme.dim) }
                }
            }
            if let card = friend.superset {
                if !card.models.isEmpty {
                    Text("models · " + card.models.joined(separator: ", ")).font(Theme.mono(10)).foregroundStyle(Theme.muted).lineLimit(2)
                }
                if !card.achievements.isEmpty {
                    Text(card.achievements.map { a in a.level.map { "\(a.slug) \($0)/\(a.of ?? $0)" } ?? a.slug }.joined(separator: " · "))
                        .font(Theme.mono(10)).foregroundStyle(Theme.muted).lineLimit(2)
                }
                if let profile = URL(string: "https://superset.sh/\(card.handle)") {
                    Link("superset.sh/\(card.handle)", destination: profile)
                        .font(Theme.mono(10)).foregroundStyle(Theme.text)
                }
            }
        }
    }
}

struct KnockComposer: View {
    @EnvironmentObject var client: AgentClient
    let handle: String
    @Binding var composing: String?
    @State private var title = ""
    @State private var url = ""
    @State private var seconds = 30

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField("What is it? e.g. the coupon fix", text: $title).textFieldStyle(.roundedBorder).font(Theme.mono(11))
            TextField("https://… (optional)", text: $url).textFieldStyle(.roundedBorder).font(Theme.mono(11))
            // The lifetime gets its own row: beside it, the buttons had no room and wrapped ("Cance/l", "Knoc/k").
            Picker("", selection: $seconds) {
                Text("10 s").tag(10)
                Text("30 s").tag(30)
                Text("2 min").tag(120)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            HStack {
                Spacer()
                Button("Cancel") { composing = nil }.buttonStyle(HUDButtonStyle())
                Button("Knock", action: send).buttonStyle(HUDButtonStyle(primary: true)).disabled(title.isEmpty)
            }
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.panel2))
    }

    private func send() {
        var args: [String: Any] = ["toHandle": handle, "title": title, "lifetimeMs": seconds * 1000]
        if !url.isEmpty { args["url"] = url }
        client.run("knock", args, done: "Knocked on @\(handle).")
        composing = nil
    }
}

// The Operator, folded to one line: how many questions it answered today, and a chat button (OperatorChat.swift). Opened,
// its last few moves, newest first: a very small view of what it is doing.
struct OperatorSection: View {
    @EnvironmentObject var style: HUDStyle
    let state: AppState

    var body: some View {
        FoldingHeader(title: "Operator", detail: OperatorSection.count(state.wire, now: Date()), open: $style.operatorOpen) {
            Button("chat") { ChatWindow.shared?.show() }.buttonStyle(HUDButtonStyle())
        }
        if style.operatorOpen {
            let lines = OperatorLines.recent(state.wire)
            if lines.isEmpty {
                Text("Quiet so far. Agents ask it on their own; chat with it any time.")
                    .font(Theme.mono(10)).foregroundStyle(Theme.dim).fixedSize(horizontal: false, vertical: true)
            }
            ForEach(lines) { line in
                HStack(alignment: .top, spacing: 7) {
                    LED(color: line.color, size: 6, pulse: line.pulse).padding(.top, 4)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(line.text).font(Theme.mono(10.5)).foregroundStyle(Theme.muted).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                        if let detail = line.detail {
                            Text(detail).font(Theme.mono(9.5)).foregroundStyle(Theme.dim).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
            }
        }
    }

    // The agent sends the newest 20 questions (operator.log). When all 20 are from today, there may be more: "20+".
    static let wireLimit = 20

    static func count(_ wire: [Relay], now: Date) -> String {
        let midnight = Calendar.current.startOfDay(for: now).timeIntervalSince1970 * 1000
        let today = wire.filter { $0.createdAt >= midnight }
        let answered = today.filter { $0.status == "answered" }.count
        let more = wire.count >= wireLimit && today.count == wire.count ? "+" : ""
        return "\(answered)\(more) answered today"
    }
}

// The Operator's last few moves, newest first: what happened, and a small line under it (what it cost, what it earned,
// why it stopped). Purple while it works, green when someone got an answer, grey when nobody did.
enum OperatorLines {
    struct Line: Identifiable {
        let id: String
        let color: Color?
        var pulse = false
        let text: String
        var detail: String?
    }

    static func recent(_ wire: [Relay], limit: Int = 3) -> [Line] {
        wire.prefix(limit).map(line)
    }

    static func line(_ r: Relay) -> Line {
        let q = "“\(r.question.count > 40 ? String(r.question.prefix(39)) + "…" : r.question)”"
        let agent = "@\(r.targetHandle ?? "a crewmate")'s agent"
        if r.inFlight {
            let text = r.status == "reading" ? "Asking \(agent) \(q)" : "Finding who knows \(q)"
            return Line(id: r.id, color: Theme.purple, pulse: true, text: text)
        }
        if r.role == "answered" {
            return r.status == "answered"
                ? Line(id: r.id, color: Theme.green, text: "Your agent helped @\(r.askerHandle) with \(q)", detail: "+10 XP")
                : Line(id: r.id, color: nil, text: "Your agent couldn't help @\(r.askerHandle) with \(q)")
        }
        switch r.status {
        // The Operator answered itself: a chat message, or a question it could answer from what the crew is doing.
        case "answered" where r.byOperator:
            return r.via == "chat"
                ? Line(id: r.id, color: Theme.green, text: "Chatted with you: \(q)")
                : Line(id: r.id, color: Theme.green, text: "Answered \(q) itself", detail: "no agent needed")
        case "answered":
            return Line(id: r.id, color: Theme.green, text: "\(agent) answered \(q)", detail: read(r))
        case "not-found":
            return Line(id: r.id, color: nil, text: "\(agent) didn't know \(q)", detail: read(r))
        case "nobody":
            return Line(id: r.id, color: nil, text: "Nobody to ask about \(q)", detail: r.note)
        case "timeout":
            return Line(id: r.id, color: nil, text: "Gave up on \(q)", detail: r.note)
        default:
            return Line(id: r.id, color: nil, text: "Couldn't ask \(q)", detail: "Something went wrong.")
        }
    }

    // What answering cost the crewmate's agent. Ephemeral: the copy of its session that read them is never saved.
    private static func read(_ r: Relay) -> String? {
        guard let t = r.tokensRead, t > 0 else { return nil }
        let n = t >= 1000 ? "\(Int((t / 1000).rounded()))k" : "\(Int(t))"
        return "\(n) tokens read ephemerally"
    }
}

struct BoardSection: View {
    let state: AppState

    var body: some View {
        SectionHeader(title: "Board", trailing: "all time")
        ForEach(Array(state.board.prefix(8).enumerated()), id: \.element.id) { index, row in
            HStack(spacing: 8) {
                Text("\(index + 1)").font(Theme.mono(10)).foregroundStyle(Theme.dim).frame(width: 14, alignment: .trailing)
                Text("@\(row.handle)").font(Theme.mono(11, row.me ? .bold : .regular)).foregroundStyle(row.me ? Theme.text : Theme.muted)
                Text(row.rank).font(Theme.mono(10)).foregroundStyle(Theme.dim)
                Spacer()
                Text("\(row.assists)⚡︎").font(Theme.mono(10)).foregroundStyle(Theme.muted).help("assists")
                Text("\(row.xp) XP").font(Theme.mono(10.5, .semibold)).foregroundStyle(row.me ? Theme.green : Theme.text)
            }
        }
    }
}

struct MachineSection: View {
    @EnvironmentObject var style: HUDStyle
    let state: AppState

    var body: some View {
        let agents = state.subset.flatMap { $0.agents }
        let machine = state.local?.machine
        let open = Binding(get: { !style.machineFolded }, set: { style.machineFolded = !$0 })
        // Folded, the header still says how many agents run.
        let count = "\(agents.count) agent\(agents.count == 1 ? "" : "s")"
        let detail = style.machineFolded ? [machine, count].compactMap { $0 }.joined(separator: " · ") : machine
        FoldingHeader(title: "This Mac", detail: detail, open: open)
        if !style.machineFolded {
            MachineAgents(state: state, agents: agents)
        }
    }
}

struct MachineAgents: View {
    @EnvironmentObject var client: AgentClient
    let state: AppState
    let agents: [AgentState]

    var body: some View {
        if agents.isEmpty {
            Text("∅ no agents running. Claude Code sessions show up on their next prompt.")
                .font(Theme.mono(10)).foregroundStyle(Theme.dim).fixedSize(horizontal: false, vertical: true)
        }
        ForEach(agents) { agent in
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    if agent.open {
                        LED(color: LED.color(for: agent.status), size: 7)
                    } else {
                        Text("◇").font(.system(size: 9)).foregroundStyle(Theme.dim).frame(width: 7)
                    }
                    Text(agent.name).font(Theme.mono(11)).foregroundStyle(Theme.text).lineLimit(1)
                    Spacer()
                    Text(agent.open ? agent.status : "private").font(Theme.mono(10)).foregroundStyle(Theme.dim)
                    // Private covers the agent's whole repository, so every Superset workspace of the project.
                    Toggle("private", isOn: Binding(get: { !agent.open }, set: { on in
                        client.run("setPrivate", ["agentId": agent.agentId, "private": on], done: on
                            ? "Private: friends never see this project's agents, and the Operator never asks them."
                            : "This project is open to your crew again.")
                    }))
                    .toggleStyle(.switch)
                    .controlSize(.mini)
                    .labelsHidden()
                    .help(agent.open ? "Make this project private" : "Private. Turn off to share this project with your crew again.")
                }
                // What the Operator knows about this agent, so its owner can see what questions get routed by.
                if agent.open, let line = state.routing.first(where: { $0.agentId == agent.agentId })?.summary {
                    Text("Operator sees: \(line)").font(Theme.mono(9.5)).foregroundStyle(Theme.dim).lineLimit(2)
                        .padding(.leading, 13)
                }
            }
        }
    }
}
