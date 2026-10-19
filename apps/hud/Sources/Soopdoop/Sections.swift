// ABOUTME: The HUD's crew sections: the four numbers under my card, "Yesterday" (the crew's digest), hand-offs in and out,
// ABOUTME: crew notes, and This Mac's ledger with its walkthrough question. Long lists show their first lines; "more" opens them.
import AppKit
import SwiftUI

// Work the HUD started that takes a while and shows in more than one place: walkthroughs being written, by ledger line.
final class HUDWork: ObservableObject {
    static let shared = HUDWork()
    @Published var writing: Set<String> = []

    // This Mac's agent writes a walkthrough page for a shipped ledger line from its session, and opens it; a web link to
    // it goes on the line and the wire.
    @MainActor func makeWalkthrough(_ line: LedgerLine, client: AgentClient) {
        guard !writing.contains(line.id) else { return }
        writing.insert(line.id)
        Task {
            do {
                let link = try await client.act("makeWalkthrough", ["ledgerId": line.id]) as? String
                client.toast = link?.hasPrefix("http") == true
                    ? "Walkthrough ready. It opened in your browser, and its link is on the wire."
                    : "Walkthrough ready. It opened in your browser."
            } catch {
                client.toast = (error as? AgentError)?.message ?? error.localizedDescription
            }
            writing.remove(line.id)
        }
    }
}

// The crew's four numbers for the last 7 days, in one quiet line under my card: questions crewmates' agents answered and
// the tokens that saved (an estimate), hand-offs done, heads-ups acted on, ships and how many have a walkthrough. Only
// what is above zero, and nothing at all while everything is zero. A number never breaks across two lines.
struct NumbersLine: View {
    let numbers: Numbers

    var body: some View {
        let parts = Self.parts(numbers)
        if !parts.isEmpty {
            // A line breaks only after a "·", never inside a number's words.
            Text(NoBreak.text("\(numbers.days) days: ") + parts.map(NoBreak.text).joined(separator: "\u{00A0}· "))
                .font(Theme.mono(9.5))
                .foregroundStyle(Theme.dim)
                .fixedSize(horizontal: false, vertical: true)
                .help("Your crew, the last \(numbers.days) days. Each number counts something soopdoop did; tokens saved is an estimate.")
        }
    }

    static func parts(_ n: Numbers) -> [String] {
        var parts: [String] = []
        if n.answered > 0 { parts.append("\(n.answered) answered") }
        if n.tokensSaved > 0 { parts.append("~\(Tokens.short(n.tokensSaved)) tokens saved") }
        if n.handoffs > 0 { parts.append(n.handoffs == 1 ? "1 hand-off" : "\(n.handoffs) hand-offs") }
        if n.headsups > 0 { parts.append(n.headsups == 1 ? "1 heads-up" : "\(n.headsups) heads-ups") }
        if n.ships > 0 {
            let walks = n.walkthroughs == 0 ? "" : n.walkthroughs == 1 ? ", 1 walkthrough" : ", \(n.walkthroughs) walkthroughs"
            parts.append((n.ships == 1 ? "1 ship" : "\(n.ships) ships") + walks)
        }
        return parts
    }
}

// "Yesterday": the crew's daily digest, which the Operator writes each morning and posts to the crew's Slack, folded to its
// first lines; opened, the week's numbers under it when there are some. Nothing shows until there is a digest.
struct YesterdaySection: View {
    let digest: DigestInfo
    @State private var open: Bool

    static let folded = 3

    init(digest: DigestInfo, open: Bool = false) {
        self.digest = digest
        _open = State(initialValue: open)
    }

    var body: some View {
        if digest.daily != nil || digest.weekly != nil {
            SectionHeader(title: "Yesterday", trailing: digest.daily.map { Ago.digestDay($0.day) })
            if let daily = digest.daily {
                let lines = DigestText.lines(daily.text)
                let shown = open ? lines : Array(lines.prefix(Self.folded))
                // Folded, the week's lines wait under "more" too.
                let week = open ? 0 : digest.weekly.map { DigestText.lines($0.text).count } ?? 0
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(Array(shown.enumerated()), id: \.offset) { index, line in
                        Text(DigestText.attributed(line))
                            .font(Theme.mono(index == 0 ? 11 : 10.5))
                            .foregroundStyle(index == 0 ? Theme.text : Theme.muted)
                            .tint(Theme.text)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        MoreToggle(hidden: lines.count - shown.count + week, open: $open)
                        Spacer(minLength: 4)
                        if let error = daily.postError {
                            Text("not posted to Slack: \(error)").font(Theme.mono(9.5)).foregroundStyle(Theme.amber).lineLimit(2)
                        } else if daily.postedAt != nil {
                            Text("posted to Slack").font(Theme.mono(9.5)).foregroundStyle(Theme.dim)
                        }
                    }
                }
            }
            // The week's numbers are close to the four under my card, so they wait until the digest is opened.
            if let weekly = digest.weekly, open || digest.daily == nil {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(DigestText.lines(weekly.text).enumerated()), id: \.offset) { index, line in
                        Text(DigestText.attributed(line))
                            .font(Theme.mono(index == 0 ? 10 : 9.5))
                            .foregroundStyle(index == 0 ? Theme.muted : Theme.dim)
                            .tint(Theme.text)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.top, 2)
            }
        }
    }
}

// A digest is plain text, one item per line. Its web links become short ones that open: a pull request as "PR #412",
// anything else without its "https://" and cut to 32 characters.
enum DigestText {
    static func lines(_ text: String) -> [String] {
        text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    private static let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

    static func attributed(_ line: String) -> AttributedString {
        guard let detector else { return AttributedString(line) }
        let ns = line as NSString
        var out = AttributedString()
        var cursor = 0
        for match in detector.matches(in: line, range: NSRange(location: 0, length: ns.length)) {
            guard let url = match.url, PRs.url(url.absoluteString) != nil, match.range.location >= cursor else { continue }
            if match.range.location > cursor {
                out += AttributedString(ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor)))
            }
            var link = AttributedString(short(url))
            link.link = url
            link.underlineStyle = .single
            out += link
            cursor = match.range.location + match.range.length
        }
        if cursor < ns.length { out += AttributedString(ns.substring(from: cursor)) }
        return out
    }

    // Kept on one line.
    static func short(_ url: URL) -> String {
        if PRs.number(url.absoluteString) != nil { return NoBreak.text(PRs.label(url.absoluteString)) }
        let bare = (url.host ?? "") + url.path
        return NoBreak.text(bare.count > 32 ? String(bare.prefix(31)) + "…" : bare)
    }
}

// Hand-offs: tasks crewmates handed to my agents (waiting for me, accepted, running) and the ones I handed out, each with
// where it is now. The offer waiting for my answer is also the card at the top. My last few offers show; "more" opens the rest.
struct HandoffsSection: View {
    @EnvironmentObject var style: HUDStyle
    let state: AppState
    @State private var composing: Bool
    @State private var allOut = false

    static let shownOut = 3

    init(state: AppState, composing: Bool = false) {
        self.state = state
        _composing = State(initialValue: composing)
    }

    var body: some View {
        let incoming = state.handoffs.incoming
        let outgoing = state.handoffs.outgoing
        FoldingHeader(title: "Hand-offs", detail: Self.detail(incoming: incoming, outgoing: outgoing), open: $style.handoffsOpen) {
            if !state.crew.isEmpty {
                Button("hand off…") {
                    composing.toggle()
                    if composing { style.handoffsOpen = true }
                }
                .buttonStyle(HUDButtonStyle())
                .help("Hand a task to a crewmate's agent")
            }
        }
        if style.handoffsOpen {
            if composing {
                HandoffComposer(toHandle: nil, via: "hud", crewmates: state.crew.map(\.handle)) { composing = false }
            }
            if incoming.isEmpty && outgoing.isEmpty && !composing {
                Text("Hand a task to the crewmate's agent that knows the area. They say yes first, and it runs on their account.")
                    .font(Theme.mono(10)).foregroundStyle(Theme.dim).fixedSize(horizontal: false, vertical: true)
            }
            let now = Date().timeIntervalSince1970 * 1000
            ForEach(incoming) { h in HandoffRow.incoming(h, now: now) }
            let shown = allOut ? outgoing : Array(outgoing.prefix(Self.shownOut))
            ForEach(shown) { h in HandoffRow.outgoing(h) }
            MoreToggle(hidden: outgoing.count - shown.count, open: $allOut)
        }
    }

    // "1 for you · 2 out": offers waiting for my answer, and mine still on their way.
    static func detail(incoming: [IncomingHandoff], outgoing: [OutgoingHandoff]) -> String? {
        let waiting = incoming.filter { $0.status == "offered" }.count
        let out = outgoing.filter { ["offered", "accepted", "running"].contains($0.status) }.count
        let parts = [waiting > 0 ? "\(waiting) for you" : nil, out > 0 ? "\(out) out" : nil].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

// One hand-off: the task on one line, where it is under it, and what came back (a summary, a note, links).
struct HandoffRow: View {
    let title: String
    let status: String
    // A light while it is on its way (blue waiting, green running); a mark once it is over.
    var light: Color?
    var pulse = false
    var done = false
    var detail: String?
    var links: [String] = []

    var body: some View {
        HStack(alignment: .top, spacing: 7) {
            Group {
                if let light {
                    LED(color: light, size: 6, pulse: pulse).padding(.top, 4)
                } else {
                    Image(systemName: done ? "checkmark.circle.fill" : "minus.circle")
                        .font(.system(size: 9))
                        .foregroundStyle(done ? Theme.green : Theme.dim)
                        .padding(.top, 2)
                }
            }
            .frame(width: 12)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(Theme.mono(10.5)).foregroundStyle(Theme.text).lineLimit(1)
                Text(status).font(Theme.mono(9.5)).foregroundStyle(Theme.dim).lineLimit(2)
                if let detail {
                    Text(detail).font(Theme.mono(9.5)).foregroundStyle(Theme.muted).lineLimit(3).fixedSize(horizontal: false, vertical: true)
                }
                if !links.isEmpty {
                    HStack(spacing: 8) {
                        ForEach(links, id: \.self) { link in
                            if let url = PRs.url(link) { SmallLink(label: PRs.number(link) == nil ? "link" : PRs.label(link), url: url) }
                        }
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 1)
    }

    // A task a crewmate handed to me.
    static func incoming(_ h: IncomingHandoff, now: Double) -> HandoffRow {
        let title = "from @\(h.fromHandle): “\(h.text)”"
        let agent = h.targetAgentName.map { "your \(NoBreak.text($0)) agent" } ?? "your agent"
        switch h.status {
        case "offered":
            return HandoffRow(title: title, status: "waiting for you · \(CountdownRing.label(max(0, h.expiresAt - now))) left", light: Theme.blue)
        case "accepted":
            return HandoffRow(title: title, status: "you said yes · \(agent) gets it when it is idle", light: Theme.blue)
        case "running":
            return HandoffRow(title: title, status: "running in \(agent)", light: Theme.green, pulse: true)
        case "done":
            return HandoffRow(title: title, status: "done", done: true)
        default:
            return HandoffRow(title: title, status: words(h.status))
        }
    }

    // A task I handed to a crewmate's agent: waiting for them, running there, done with what it said, or over.
    static func outgoing(_ h: OutgoingHandoff) -> HandoffRow {
        let title = "to @\(h.toHandle): “\(h.text)”"
        let agent = h.targetAgentName.map { "@\(h.toHandle)'s \(NoBreak.text($0)) agent" } ?? "@\(h.toHandle)'s agent"
        switch h.status {
        case "offered":
            return HandoffRow(title: title, status: "waiting for @\(h.toHandle)", light: Theme.blue)
        case "accepted":
            return HandoffRow(title: title, status: "@\(h.toHandle) said yes · \(agent) gets it when it is idle", light: Theme.blue)
        case "running":
            return HandoffRow(title: title, status: "running in \(agent)", light: Theme.green, pulse: true)
        case "done":
            return HandoffRow(title: title, status: "done", done: true, detail: h.summary, links: h.links)
        case "declined":
            return HandoffRow(title: title, status: "@\(h.toHandle) said no", detail: h.note.map { "“\($0)”" })
        case "expired":
            return HandoffRow(title: title, status: "nobody said yes within a day")
        case "failed":
            return HandoffRow(title: title, status: "did not finish", detail: h.note)
        default:
            return HandoffRow(title: title, status: words(h.status))
        }
    }

    private static func words(_ status: String) -> String {
        switch status {
        case "declined": return "you said no"
        case "expired": return "over: nobody answered within a day"
        case "failed": return "did not finish"
        default: return status
        }
    }
}

// Crew notes: live shared instructions every crewmate's agent reads (a design rule, a price, who owns what this week). The
// newest few show, with the author, the age and the tags; a note of mine that is 30 days old asks "still true?" at the
// top; a note nobody confirmed for 45 days is dimmed (agents no longer get it). Proposals from my agents wait for my yes.
struct NotesSection: View {
    @EnvironmentObject var style: HUDStyle
    let state: AppState
    @State private var adding: Bool
    @State private var editing: String?
    @State private var all = false

    static let shown = 3

    init(state: AppState, adding: Bool = false, editing: String? = nil) {
        self.state = state
        _adding = State(initialValue: adding)
        _editing = State(initialValue: editing)
    }

    var body: some View {
        let notes = state.notes
        let me = state.me?.handle ?? ""
        let leader = state.crewInfo?.iAmLeader ?? false
        FoldingHeader(title: "Crew notes", detail: Self.detail(notes), open: $style.notesOpen) {
            if state.crewInfo != nil {
                Button("add") {
                    adding.toggle()
                    if adding { style.notesOpen = true }
                }
                .buttonStyle(HUDButtonStyle())
                .help("Add a note every crewmate's agent reads")
            }
        }
        if style.notesOpen {
            if state.crewInfo == nil {
                Text("Crew notes belong to a crew. Start one in Settings → Crew.")
                    .font(Theme.mono(10)).foregroundStyle(Theme.dim).fixedSize(horizontal: false, vertical: true)
            } else {
                if adding { NoteEditor { adding = false } }
                ForEach(notes.proposed) { note in ProposalRow(note: note, mine: note.authorHandle == me) }
                let pinned = notes.live.filter { $0.nudge && Self.mayChange($0, me: me, leader: leader) }
                let pinnedIds = Set(pinned.map(\.id))
                let rest = notes.live.filter { !pinnedIds.contains($0.id) }
                let shown = pinned + (all ? rest : Array(rest.prefix(Self.shown)))
                if notes.live.isEmpty && notes.proposed.isEmpty && !adding {
                    Text("Nothing yet. A note here (a design rule, a price, who owns what) reaches every crewmate's agent.")
                        .font(Theme.mono(10)).foregroundStyle(Theme.dim).fixedSize(horizontal: false, vertical: true)
                }
                ForEach(shown) { note in
                    if editing == note.id {
                        NoteEditor(note: note) { editing = nil }
                    } else {
                        NoteRow(note: note, canChange: Self.mayChange(note, me: me, leader: leader)) { editing = note.id }
                    }
                }
                MoreToggle(hidden: notes.live.count - shown.count, open: $all)
            }
        }
    }

    // The backend lets a note's author or the crew leader change, confirm or retire it.
    static func mayChange(_ note: Note, me: String, leader: Bool) -> Bool {
        leader || (!me.isEmpty && note.authorHandle == me)
    }

    static func detail(_ notes: NotesList) -> String? {
        let parts = [notes.live.isEmpty ? nil : "\(notes.live.count) live", notes.proposed.isEmpty ? nil : "\(notes.proposed.count) to approve"]
            .compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

struct NoteRow: View {
    @EnvironmentObject var client: AgentClient
    let note: Note
    let canChange: Bool
    let edit: () -> Void

    var body: some View {
        let now = Date().timeIntervalSince1970 * 1000
        VStack(alignment: .leading, spacing: 3) {
            VStack(alignment: .leading, spacing: 2) {
                Text(note.text).font(Theme.mono(10.5)).foregroundStyle(Theme.text).fixedSize(horizontal: false, vertical: true)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(Self.meta(note, now: now)).font(Theme.mono(9.5)).foregroundStyle(Theme.dim).lineLimit(2)
                    Spacer(minLength: 4)
                    if canChange {
                        Button("edit", action: edit).buttonStyle(.plain).font(Theme.mono(9.5)).foregroundStyle(Theme.dim)
                    }
                }
                if note.stale {
                    Text("Agents no longer get it: nobody said it is still true for 45 days.")
                        .font(Theme.mono(9.5)).foregroundStyle(Theme.dim).fixedSize(horizontal: false, vertical: true)
                }
            }
            .opacity(note.stale ? 0.6 : 1)
            if note.nudge && canChange {
                HStack(spacing: 8) {
                    Text("Still true?").font(Theme.mono(10)).foregroundStyle(Theme.amber)
                    Button("Confirm") { client.run("confirmNote", ["noteId": note.id], done: "Thanks. The note counts as fresh again.") }
                        .buttonStyle(HUDButtonStyle(primary: true))
                    Button("Retire") { client.run("retireNote", ["noteId": note.id], done: "Retired. Agents stop getting that note.") }
                        .buttonStyle(HUDButtonStyle())
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(.vertical, 2)
    }

    // "@adalovelace · 3 days · design · in apps/web/quote"
    static func meta(_ note: Note, now: Double) -> String {
        var parts = ["@\(note.authorHandle)", Ago.age(note.createdAt, now: now)]
        if !note.tags.isEmpty { parts.append(note.tags.joined(separator: ", ")) }
        if let applies = note.appliesWhen, !applies.isEmpty { parts.append("in \(applies)") }
        return parts.joined(separator: " · ")
    }
}

// A note an agent wants to add. Nobody else sees it until its owner (or the crew leader) says yes.
struct ProposalRow: View {
    @EnvironmentObject var client: AgentClient
    let note: Note
    let mine: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(mine ? "Your agent wants to add a crew note:" : "@\(note.authorHandle)'s agent wants to add a crew note:")
                .font(Theme.mono(9.5)).foregroundStyle(Theme.muted)
            Text(note.text).font(Theme.mono(10.5)).foregroundStyle(Theme.text).fixedSize(horizontal: false, vertical: true)
            let meta = [note.tags.isEmpty ? nil : note.tags.joined(separator: ", "), note.appliesWhen.map { "in \($0)" }].compactMap { $0 }
            if !meta.isEmpty {
                Text(meta.joined(separator: " · ")).font(Theme.mono(9.5)).foregroundStyle(Theme.dim)
            }
            HStack(spacing: 8) {
                Button("Approve") { client.run("approveNote", ["noteId": note.id], done: "Approved. Agents get it at their next prompt or session.") }
                    .buttonStyle(HUDButtonStyle(primary: true))
                Button("Reject") { client.run("rejectNote", ["noteId": note.id], done: "Rejected. Nobody else saw it.") }
                    .buttonStyle(HUDButtonStyle())
                Spacer(minLength: 0)
            }
        }
        .padding(7)
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.line2, style: StrokeStyle(lineWidth: 1, dash: [3])))
    }
}

// This Mac's ledger: one line per finished task, as the crew sees it, written on this Mac (at most 240 characters). Mine
// to fix or delete. Folded by default; it shows the newest 20.
struct LedgerSection: View {
    @EnvironmentObject var style: HUDStyle
    let lines: [LedgerLine]

    static let shown = 20

    var body: some View {
        let count = lines.count
        FoldingHeader(title: "Ledger", detail: count == 0 ? nil : "\(count) line\(count == 1 ? "" : "s") your crew sees", open: $style.ledgerOpen)
        if style.ledgerOpen {
            if lines.isEmpty {
                Text("One line for each task your agents finish shows up here, as your crew sees it. You can fix or delete any of them.")
                    .font(Theme.mono(10)).foregroundStyle(Theme.dim).fixedSize(horizontal: false, vertical: true)
            }
            ForEach(lines.prefix(Self.shown)) { line in LedgerRow(line: line) }
        }
    }
}

struct LedgerRow: View {
    @EnvironmentObject var client: AgentClient
    let line: LedgerLine
    @State private var editing: Bool
    @State private var did: String
    @State private var forgetting: Bool

    // What the backend keeps of a line (ledger.ts MAX_DID).
    static let limit = 240

    init(line: LedgerLine, editing: Bool = false, forgetting: Bool = false) {
        self.line = line
        _editing = State(initialValue: editing)
        _did = State(initialValue: line.did)
        _forgetting = State(initialValue: forgetting)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            if editing {
                TextField("What was done", text: $did, axis: .vertical)
                    .lineLimit(1...4)
                    .textFieldStyle(.roundedBorder)
                    .font(Theme.mono(10.5))
                    .onChange(of: did) { if did.count > Self.limit { did = String(did.prefix(Self.limit)) } }
                HStack(spacing: 8) {
                    Text("\(Self.limit - did.count) left").font(Theme.mono(9.5)).foregroundStyle(Theme.dim).monospacedDigit()
                    Spacer()
                    Button("Cancel") { editing = false }.buttonStyle(HUDButtonStyle())
                    Button("Save", action: save)
                        .buttonStyle(HUDButtonStyle(primary: true))
                        .disabled(did.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            } else {
                Text(line.did).font(Theme.mono(10.5)).foregroundStyle(Theme.text).fixedSize(horizontal: false, vertical: true)
            }
            Text(Self.meta(line)).font(Theme.mono(9.5)).foregroundStyle(Theme.dim).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                if let pr = PRs.url(line.pr) { SmallLink(label: PRs.label(pr.absoluteString), url: pr) }
                if let page = PRs.url(line.walkthrough) { SmallLink(label: "walkthrough", url: page) }
                if line.editedByOwner { Text("edited by you").font(Theme.mono(9.5)).foregroundStyle(Theme.dim) }
                Spacer(minLength: 4)
                if !editing && !forgetting {
                    Button("edit") {
                        did = line.did
                        editing = true
                    }
                    .buttonStyle(.plain).font(Theme.mono(9.5)).foregroundStyle(Theme.dim)
                    Button("delete") { forgetting = true }
                        .buttonStyle(.plain).font(Theme.mono(9.5)).foregroundStyle(Theme.dim)
                }
            }
            if forgetting {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Delete this line? Your crew no longer sees it, and its ship leaves the wire.")
                        .font(Theme.mono(10)).foregroundStyle(Theme.amber).fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 8) {
                        Button("Delete") {
                            forgetting = false
                            client.run("forgetLedger", ["ledgerId": line.id], done: "Deleted. Your crew no longer sees that line.")
                        }
                        .buttonStyle(HUDButtonStyle(primary: true))
                        Button("Keep") { forgetting = false }.buttonStyle(HUDButtonStyle())
                        Spacer(minLength: 0)
                    }
                }
            }
            if Self.asks(line) {
                Text(Self.question(line)).font(Theme.mono(10)).foregroundStyle(Theme.text).fixedSize(horizontal: false, vertical: true)
                WalkthroughAsk(line: line)
            }
        }
        .padding(.vertical, 3)
    }

    // A shipped line with no walkthrough that nobody has answered "Make a walkthrough?" for yet.
    static func asks(_ line: LedgerLine) -> Bool {
        line.shipped && line.walkthrough == nil && !line.walkthroughAsked
    }

    // "#412", or nil when the line has no numbered pull request.
    static func ship(_ line: LedgerLine) -> String? {
        PRs.number(line.pr ?? "").map { "#\($0)" }
    }

    static func question(_ line: LedgerLine) -> String {
        "Make a walkthrough for \(ship(line) ?? "it")? Your agent writes a short page."
    }

    // "16 Oct · codex · vibes@quote-redesign · areas: apps/web/quote, docs/changelog · 14 files"
    static func meta(_ line: LedgerLine) -> String {
        var parts = [Ago.day(line.at), line.harness == "claude-code" ? "claude" : line.harness]
        let place = [line.workspace, line.branch].compactMap { $0 }.joined(separator: "@")
        if !place.isEmpty { parts.append(place) }
        // A folder never splits across two lines.
        if !line.areas.isEmpty { parts.append("areas:\u{00A0}" + line.areas.map(NoBreak.text).joined(separator: ", ")) }
        parts.append(line.files == 1 ? "1 file" : "\(line.files) files")
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private func save() {
        let words = did.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { return }
        editing = false
        client.run("editLedger", ["ledgerId": line.id, "did": words], done: "Saved. Your crew sees the new words.")
    }
}

// Yes / Not now for "Make a walkthrough?", or "writing…" while this Mac's agent writes it.
struct WalkthroughAsk: View {
    @EnvironmentObject var client: AgentClient
    @ObservedObject private var work = HUDWork.shared
    let line: LedgerLine

    var body: some View {
        if work.writing.contains(line.id) {
            HStack(spacing: 6) {
                ProgressView().controlSize(.mini)
                Text("writing…").font(Theme.mono(10)).foregroundStyle(Theme.muted)
            }
        } else {
            HStack(spacing: 8) {
                Button("Yes") { work.makeWalkthrough(line, client: client) }
                    .buttonStyle(HUDButtonStyle(primary: true))
                    .help("A copy of the session that did the work writes the page on this Mac. It opens when it is ready.")
                Button("Not now") { client.run("skipWalkthrough", ["ledgerId": line.id]) }
                    .buttonStyle(HUDButtonStyle())
                Spacer(minLength: 0)
            }
        }
    }
}

// After a ship, the HUD asks once, near the top: the newest shipped line of the last day that nobody has answered for. It
// waits while a request is on screen, and does not repeat what the open ledger already asks.
struct WalkthroughNotice: View {
    let line: LedgerLine

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 7) {
                Image(systemName: "shippingbox.fill").font(.system(size: 9)).foregroundStyle(Theme.green).frame(width: 12).padding(.top, 2)
                VStack(alignment: .leading, spacing: 2) {
                    Text("You shipped" + (LedgerRow.ship(line).map { " \($0)" } ?? "") + ": " + line.did)
                        .font(Theme.mono(9.5)).foregroundStyle(Theme.dim).lineLimit(1)
                    Text(LedgerRow.question(line))
                        .font(Theme.mono(10.5)).foregroundStyle(Theme.text).fixedSize(horizontal: false, vertical: true)
                }
            }
            WalkthroughAsk(line: line).padding(.leading, 19)
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.panel2))
    }

    static func pick(_ state: AppState, now: Double) -> LedgerLine? {
        state.ledger.first { LedgerRow.asks($0) && now - $0.at < 24 * 3_600_000 }
    }
}
