// ABOUTME: The Operator chat: a small window with what you asked and what the Operator said, newest at the bottom. The
// ABOUTME: Operator answers small talk and crew questions itself, and asks a crewmate's agent when the answer needs one.
import AppKit
import SwiftUI

// The window, opened from the HUD's Operator line or the menu bar. One for the app's life; closing only hides it.
@MainActor
final class ChatWindow {
    static var shared: ChatWindow?

    private let window: NSWindow

    var visible: Bool { window.isVisible }

    init(client: AgentClient, style: HUDStyle) {
        let host = NSHostingView(rootView: OperatorChat().environmentObject(client).environmentObject(style))
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 380, height: 520),
            styleMask: [.titled, .closable, .resizable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "The Operator"
        window.contentView = host
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .darkAqua)
        if !window.setFrameUsingName("SoopdoopOperatorChat") { window.center() }
        window.setFrameAutosaveName("SoopdoopOperatorChat")
    }

    func show() {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }
}

struct OperatorChat: View {
    @EnvironmentObject var client: AgentClient
    @State private var text = ""
    @FocusState private var typing: Bool

    private var turns: [Relay] { client.state?.chat ?? [] }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        if turns.isEmpty {
                            Text("Ask the Operator anything about your crew or your project. It answers what it can, and asks a crewmate's agent the rest.")
                                .font(Theme.mono(11))
                                .foregroundStyle(Theme.dim)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        ForEach(turns) { turn in ChatTurnView(turn: turn).id(turn.id) }
                    }
                    .padding(14)
                }
                .onAppear { scroll(proxy) }
                .onChange(of: turns.map { "\($0.id) \($0.status)" }) { scroll(proxy) }
            }
            Rectangle().fill(Theme.line).frame(height: 1)
            HStack(spacing: 8) {
                TextField("Ask the Operator…", text: $text)
                    .textFieldStyle(.roundedBorder)
                    .font(Theme.mono(12))
                    .focused($typing)
                    .onSubmit(send)
                Button("Send", action: send)
                    .buttonStyle(HUDButtonStyle(primary: true))
                    .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(10)
        }
        .frame(minWidth: 340, minHeight: 380)
        .background(Theme.panel)
        .environment(\.colorScheme, .dark)
        .onAppear { typing = true }
    }

    private func scroll(_ proxy: ScrollViewProxy) {
        guard let last = turns.last else { return }
        withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(last.id, anchor: .bottom) }
    }

    private func send() {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        text = ""
        client.run("chat", ["text": t])
    }
}

// One exchange: my message on the right, the Operator's reply on the left (or what it is doing about it).
struct ChatTurnView: View {
    let turn: Relay

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Spacer(minLength: 48)
                Text(turn.question).bubble(mine: true)
            }
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(header).font(Theme.mono(9.5)).tracking(0.5).foregroundStyle(Theme.dim)
                    if turn.inFlight {
                        HStack(spacing: 6) {
                            LED(color: Theme.purple, size: 6, pulse: true)
                            Text(working).font(Theme.mono(11)).foregroundStyle(Theme.muted)
                        }
                        .padding(.vertical, 4)
                    } else {
                        Text(reply).bubble(mine: false, muted: turn.status != "answered")
                    }
                }
                Spacer(minLength: 48)
            }
        }
    }

    private var asked: String? { turn.byOperator ? nil : turn.targetHandle }

    private var header: String {
        guard let who = asked else { return "OPERATOR" }
        return "OPERATOR · asked @\(who)'s \(turn.targetAgentName ?? "agent")"
    }

    private var working: String {
        if turn.status == "reading" { return "Asking @\(turn.targetHandle ?? "a crewmate")'s agent…" }
        return "Thinking…"
    }

    private var reply: String {
        turn.status == "answered" ? (turn.answer ?? "") : (turn.note ?? "No answer.")
    }
}

extension View {
    // A chat bubble: mine purple, the Operator's dark.
    func bubble(mine: Bool, muted: Bool = false) -> some View {
        font(.system(size: 12.5))
            .foregroundStyle(muted ? Theme.muted : Theme.text)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(mine ? Theme.purple.opacity(0.26) : Theme.panel2))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(mine ? Theme.purple.opacity(0.5) : Theme.line2, lineWidth: 1))
    }
}
