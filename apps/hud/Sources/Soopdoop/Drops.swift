// ABOUTME: The HUD's Drops section: the crew's shelf of walkthroughs, pages and links, newest first, four until "more". A
// ABOUTME: click opens one; whoever shared it (or the crew's leader) can forget it; a one-line box shares a new link.
import SwiftUI

// The crew's shelf (drops.list): walkthroughs and pages soopdoop keeps for a crew on Team, and links to pages hosted
// elsewhere, on any plan. Newest first; four show until "more" opens the rest. A click opens one in the browser.
struct DropsSection: View {
    @EnvironmentObject var style: HUDStyle
    let state: AppState
    @State private var all: Bool
    // The drop whose "forget" waits for a yes. One at a time.
    @State private var forgetting: String?

    static let shown = 4

    init(state: AppState, all: Bool = false, forgetting: String? = nil) {
        self.state = state
        _all = State(initialValue: all)
        _forgetting = State(initialValue: forgetting)
    }

    var body: some View {
        let drops = state.drops.sorted { $0.createdAt > $1.createdAt }
        let list = all ? drops : Array(drops.prefix(Self.shown))
        FoldingHeader(title: "Drops", detail: drops.isEmpty ? nil : "\(drops.count)", open: $style.dropsOpen)
        if style.dropsOpen {
            DropLinkBox()
            if drops.isEmpty {
                Text(Self.empty(state)).font(Theme.mono(10)).foregroundStyle(Theme.dim).fixedSize(horizontal: false, vertical: true)
            } else {
                // Ticks for the "2h" ages.
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    let now = context.date.timeIntervalSince1970 * 1000
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(list) { drop in
                            DropRow(drop: drop, mine: drop.byHandle == state.me?.handle, now: now, forgetting: $forgetting)
                        }
                    }
                }
                MoreToggle(hidden: drops.count - list.count, open: $all)
            }
        }
    }

    // On Team, walkthroughs written from the HUD are stored as drops; on the free plan one opens on its writer's Mac only.
    static func empty(_ state: AppState) -> String {
        state.crewInfo?.plan == "team"
            ? "Nothing here yet. Walkthroughs your agents write land here, and so does any link you share."
            : "Nothing here yet. Share a link to a page (a Superset Page, an Artifact) and your crew finds it here."
    }
}

// One drop: its title (a click opens it), then a small line with what kind it is, who shared it and when, and "forget"
// for whoever shared it or the crew's leader. Forgetting asks first, here in the HUD.
struct DropRow: View {
    @EnvironmentObject var client: AgentClient
    let drop: Drop
    // I shared it.
    let mine: Bool
    let now: Double
    @Binding var forgetting: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Button { client.run("openDrop", ["dropId": drop.id]) } label: {
                Text(drop.title)
                    .font(Theme.mono(10.5))
                    .foregroundStyle(Theme.text)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Open it in your browser")
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                DropKindChip(label: Self.kind(drop))
                Text(Self.meta(drop, mine: mine, now: now)).font(Theme.mono(9.5)).foregroundStyle(Theme.dim).lineLimit(1)
                Spacer(minLength: 4)
                if drop.canForget && forgetting != drop.id {
                    Button("forget") { forgetting = drop.id }
                        .buttonStyle(.plain)
                        .font(Theme.mono(9.5))
                        .foregroundStyle(Theme.dim)
                        .help(mine ? "Take it off the shelf" : "Take it off the shelf: you lead the crew")
                }
            }
            if forgetting == drop.id {
                VStack(alignment: .leading, spacing: 5) {
                    Text(Self.forgetQuestion(drop, mine: mine))
                        .font(Theme.mono(10)).foregroundStyle(Theme.amber).fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 8) {
                        Button("Forget") {
                            forgetting = nil
                            client.run("forgetDrop", ["dropId": drop.id], done: "Forgotten. Its link no longer works.")
                        }
                        .buttonStyle(HUDButtonStyle(primary: true))
                        Button("Keep") { forgetting = nil }.buttonStyle(HUDButtonStyle())
                        Spacer(minLength: 0)
                    }
                }
                .padding(.top, 2)
            }
        }
        .padding(.vertical, 1)
    }

    // "walkthrough", "page" or "file", and "link" for a page hosted elsewhere: soopdoop keeps no copy, so its size is 0.
    static func kind(_ drop: Drop) -> String {
        if drop.kind == "walkthrough" { return "walkthrough" }
        return drop.size == 0 ? "link" : drop.kind
    }

    // "by @adalovelace · 2h", or "by you · 3d".
    static func meta(_ drop: Drop, mine: Bool, now: Double) -> String {
        "by " + (mine ? "you" : "@\(drop.byHandle)") + " · " + age(drop.createdAt, now: now)
    }

    // "now", "4m", "2h", "3d", and the day ("16 Oct") after a week.
    static func age(_ at: Double, now: Double) -> String {
        let seconds = max(0, now - at) / 1000
        if seconds < 86_400 { return WireLines.ago(at, now: now) }
        if seconds < 7 * 86_400 { return "\(Int(seconds / 86_400))d" }
        return Ago.day(at)
    }

    static func forgetQuestion(_ drop: Drop, mine: Bool) -> String {
        let whose = mine ? "this drop" : "@\(drop.byHandle)'s drop"
        return drop.size == 0
            ? "Forget \(whose)? Its link stops working for everyone. The page it points to stays."
            : "Forget \(whose)? soopdoop deletes it, and its link stops working for everyone."
    }
}

// What kind of drop it is, small, beside who shared it.
struct DropKindChip: View {
    let label: String

    var body: some View {
        Text(label)
            .font(Theme.mono(8.5))
            .foregroundStyle(label == "walkthrough" ? Theme.blue : Theme.muted)
            .padding(.horizontal, 5)
            .padding(.vertical, 0.5)
            .overlay(Capsule().stroke(Theme.line2, lineWidth: 1))
            .fixedSize()
    }
}

// One line to put a page on the crew's shelf (dropLink): paste an https link, give it a title, and Enter shares it. Any
// plan: soopdoop keeps only the link, and its drop link sends whoever opens it on to the page.
struct DropLinkBox: View {
    @EnvironmentObject var client: AgentClient
    @State private var link: String
    @State private var title: String
    // Enter was pressed with a link drops.link would refuse; it says so under the box until the link changes.
    @State private var tried: Bool
    @State private var sending = false
    @FocusState private var focus: Field?

    enum Field { case link, title }

    // What the backend takes (drops.ts MAX_TITLE and MAX_LINK).
    static let maxTitle = 200
    static let maxLink = 2_000

    init(link: String = "", title: String = "", tried: Bool = false) {
        _link = State(initialValue: link)
        _title = State(initialValue: title)
        _tried = State(initialValue: tried)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                TextField("Share a link…", text: $link)
                    .focused($focus, equals: .link)
                    .onSubmit { if Self.blank(title) { focus = .title } else { send() } }
                TextField("Title", text: $title)
                    .focused($focus, equals: .title)
                    .onSubmit { if Self.blank(link) { focus = .link } else { send() } }
            }
            .textFieldStyle(.roundedBorder)
            .font(Theme.mono(10.5))
            .disabled(sending)
            if tried && !Self.valid(link) {
                Text("A drop links to an https:// page.").font(Theme.mono(9.5)).foregroundStyle(Theme.amber)
            }
        }
        .help("Paste an https link and give it a title. Enter shares it with your crew.")
        .onChange(of: link) {
            tried = false
            if link.count > Self.maxLink { link = String(link.prefix(Self.maxLink)) }
        }
        .onChange(of: title) { if title.count > Self.maxTitle { title = String(title.prefix(Self.maxTitle)) } }
    }

    static func blank(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // An https link with a host, and no spaces, user name or password: what drops.link takes.
    static func valid(_ raw: String) -> Bool {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.rangeOfCharacter(from: .whitespacesAndNewlines) == nil, let url = URL(string: text),
              url.scheme?.lowercased() == "https", let host = url.host, !host.isEmpty else { return false }
        return url.user == nil && url.password == nil
    }

    private func send() {
        let url = link.trimmingCharacters(in: .whitespacesAndNewlines)
        let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard Self.valid(url) else {
            tried = true
            focus = .link
            return
        }
        guard !name.isEmpty else {
            focus = .title
            return
        }
        sending = true
        Task {
            do {
                try await client.act("dropLink", ["title": name, "url": url])
                link = ""
                title = ""
                client.toast = "Shared. Your crew finds it under Drops."
            } catch {
                // The words stay, so nothing typed is lost.
                client.toast = (error as? AgentError)?.message ?? error.localizedDescription
            }
            sending = false
        }
    }
}
