// ABOUTME: Small forms in the HUD: hand a task to a crewmate's agent, shout one line to the crew, and write or change a crew
// ABOUTME: note. Each sends one action to the agent; what happened (or went wrong) shows in the toast.
import SwiftUI

// Hands a task to a crewmate's agent (offerHandoff). From a heads-up card it comes filled in with the crewmate and the agent
// the card is about; from the Hand-offs section the hacker picks the crewmate and the backend picks their agent that fits.
// The crewmate sees the exact words and says yes before anything runs, on their own account.
struct HandoffComposer: View {
    @EnvironmentObject var client: AgentClient
    // Nil: the hacker picks a crewmate here, from `crewmates`.
    let toHandle: String?
    var targetAgentId: String? = nil
    var targetAgentName: String? = nil
    // Where it was offered from: "hud" or "headsup".
    var via = "hud"
    var crewmates: [String] = []
    let close: () -> Void
    @State private var text = ""
    @State private var why = ""
    @State private var picked = ""
    @State private var sending = false

    // What the backend takes (handoffs.ts MAX_TASK and MAX_WHY).
    static let maxTask = 2_000
    static let maxWhy = 500

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let toHandle {
                Text(Self.target(toHandle, agentId: targetAgentId, agentName: targetAgentName))
                    .font(Theme.mono(10)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            } else {
                Picker("To", selection: $picked) {
                    Text("Pick a crewmate").tag("")
                    ForEach(crewmates, id: \.self) { Text("@\($0)").tag($0) }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .font(Theme.mono(11))
                .fixedSize()
            }
            TextField("What should their agent do?", text: $text, axis: .vertical)
                .lineLimit(2...5)
                .textFieldStyle(.roundedBorder)
                .font(Theme.mono(11))
            TextField("Why them? (optional)", text: $why)
                .textFieldStyle(.roundedBorder)
                .font(Theme.mono(11))
            Text("They see these exact words and say yes first. It runs on their account.")
                .font(Theme.mono(9.5)).foregroundStyle(Theme.dim).fixedSize(horizontal: false, vertical: true)
            HStack {
                Spacer()
                Button("Cancel", action: close).buttonStyle(HUDButtonStyle())
                Button(sending ? "Sending…" : "Hand off", action: send)
                    .buttonStyle(HUDButtonStyle(primary: true))
                    .disabled(!ready)
            }
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.panel2))
        .onChange(of: text) { if text.count > Self.maxTask { text = String(text.prefix(Self.maxTask)) } }
        .onChange(of: why) { if why.count > Self.maxWhy { why = String(why.prefix(Self.maxWhy)) } }
    }

    // "To @jimmy's email-metrics agent", or, with no agent named, who picks one.
    static func target(_ handle: String, agentId: String?, agentName: String?) -> String {
        if let agentName { return "To @\(handle)'s \(agentName) agent" }
        if agentId != nil { return "To the @\(handle) agent this heads-up is about" }
        return "To @\(handle). soopdoop picks their agent that fits the task."
    }

    private var recipient: String { toHandle ?? picked }

    private var ready: Bool {
        !sending && !recipient.isEmpty && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func send() {
        let to = recipient
        let task = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard ready else { return }
        var args: [String: Any] = ["toHandle": to, "text": task, "via": via]
        let reason = why.trimmingCharacters(in: .whitespacesAndNewlines)
        if !reason.isEmpty { args["why"] = reason }
        if let targetAgentId { args["targetAgentId"] = targetAgentId }
        sending = true
        Task {
            do {
                try await client.act("offerHandoff", args)
                client.toast = "Offered to @\(to). They say yes in soopdoop first; you hear back on the wire."
                close()
            } catch {
                client.toast = (error as? AgentError)?.message ?? error.localizedDescription
            }
            sending = false
        }
    }
}

// One line to the crew on the wire ("CI is red, looking", "lunch?"), gone after a day. Enter sends it.
struct ShoutBox: View {
    @EnvironmentObject var client: AgentClient
    @State private var text = ""

    // What the backend takes (feed.ts MAX_SHOUT).
    static let limit = 140

    var body: some View {
        HStack(spacing: 6) {
            TextField("Shout…", text: $text)
                .textFieldStyle(.roundedBorder)
                .font(Theme.mono(10.5))
                .onSubmit(send)
            // How many characters are left, once it gets close.
            if text.count > Self.limit - 30 {
                Text("\(Self.limit - text.count)")
                    .font(Theme.mono(9.5))
                    .foregroundStyle(text.count >= Self.limit ? Theme.amber : Theme.dim)
                    .monospacedDigit()
            }
        }
        .onChange(of: text) { if text.count > Self.limit { text = String(text.prefix(Self.limit)) } }
        .help("One line to your crew, on the wire for a day. Enter sends it.")
    }

    private func send() {
        let line = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty else { return }
        text = ""
        Task {
            do {
                try await client.act("shout", ["text": line])
            } catch {
                // Keep the words, so nothing typed is lost.
                if text.isEmpty { text = line }
                client.toast = (error as? AgentError)?.message ?? error.localizedDescription
            }
        }
    }
}

// Writes a crew note (addNote) or changes one (editNote): up to 400 characters, a few tags, and where it applies (a
// folder, a repository or a word), so it reaches only the sessions it is about.
struct NoteEditor: View {
    @EnvironmentObject var client: AgentClient
    // Nil: a new note.
    let note: Note?
    let close: () -> Void
    @State private var text: String
    @State private var tags: String
    @State private var appliesWhen: String
    @State private var sending = false

    // What the backend takes (notes.ts MAX_NOTE and MAX_APPLIES_WHEN).
    static let limit = 400
    static let appliesLimit = 120

    init(note: Note? = nil, close: @escaping () -> Void) {
        self.note = note
        self.close = close
        _text = State(initialValue: note?.text ?? "")
        _tags = State(initialValue: note?.tags.joined(separator: ", ") ?? "")
        _appliesWhen = State(initialValue: note?.appliesWhen ?? "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField(note == nil ? "A note every crewmate's agent reads…" : "The note", text: $text, axis: .vertical)
                .lineLimit(2...6)
                .textFieldStyle(.roundedBorder)
                .font(Theme.mono(11))
            TextField("tags (optional): design, pricing", text: $tags)
                .textFieldStyle(.roundedBorder)
                .font(Theme.mono(10.5))
            TextField("applies when (optional)", text: $appliesWhen)
                .textFieldStyle(.roundedBorder)
                .font(Theme.mono(10.5))
                .help("A folder, a repository or a word. The note then goes only to agents working there.")
            HStack {
                Text("\(Self.limit - text.count) left")
                    .font(Theme.mono(9.5))
                    .foregroundStyle(text.count >= Self.limit ? Theme.amber : Theme.dim)
                    .monospacedDigit()
                Spacer()
                Button("Cancel", action: close).buttonStyle(HUDButtonStyle())
                Button(note == nil ? "Add" : "Save", action: save)
                    .buttonStyle(HUDButtonStyle(primary: true))
                    .disabled(sending || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.panel2))
        .onChange(of: text) { if text.count > Self.limit { text = String(text.prefix(Self.limit)) } }
        .onChange(of: appliesWhen) { if appliesWhen.count > Self.appliesLimit { appliesWhen = String(appliesWhen.prefix(Self.appliesLimit)) } }
    }

    // "design, pricing" or "design pricing" → ["design", "pricing"]. The backend cleans them further.
    static func tagList(_ raw: String) -> [String] {
        raw.split(whereSeparator: { $0 == "," || $0 == " " }).map(String.init).filter { !$0.isEmpty }
    }

    private func save() {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !words.isEmpty else { return }
        let applies = appliesWhen.trimmingCharacters(in: .whitespacesAndNewlines)
        var args: [String: Any] = ["text": words, "tags": Self.tagList(tags)]
        if let note {
            args["noteId"] = note.id
            // An emptied box takes "applies when" off the note.
            args["appliesWhen"] = applies
        } else if !applies.isEmpty {
            args["appliesWhen"] = applies
        }
        sending = true
        Task {
            do {
                try await client.act(note == nil ? "addNote" : "editNote", args)
                client.toast = note == nil
                    ? "Added to the crew notes. Agents get it at their next prompt or session."
                    : "Saved. Agents get the new words at their next prompt or session."
                close()
            } catch {
                client.toast = (error as? AgentError)?.message ?? error.localizedDescription
            }
            sending = false
        }
    }
}
