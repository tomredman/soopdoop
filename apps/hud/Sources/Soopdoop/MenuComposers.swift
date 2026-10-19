// ABOUTME: The menu bar's two small composers, in a panel just under the menu bar that never takes focus from Superset:
// ABOUTME: "Hand off…" sends a task, in exactly the words typed, to a crewmate's agent; "Shout…" puts one line on the wire.
import AppKit
import SwiftUI

// Takes typing without making soopdoop the active app, like the HUD. Escape closes it from any field.
final class MenuComposerPanel: NSPanel {
    init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: MenuComposer.width, height: 200),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: true
        )
        isFloatingPanel = true
        // Above the HUD, which floats too.
        level = NSWindow.Level(rawValue: NSWindow.Level.floating.rawValue + 1)
        hidesOnDeactivate = false
        becomesKeyOnlyIfNeeded = false
        isMovableByWindowBackground = true
        backgroundColor = .clear
        isOpaque = false
        hasShadow = true
        isReleasedWhenClosed = false
        appearance = NSAppearance(named: .darkAqua)
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    override func cancelOperation(_ sender: Any?) {
        orderOut(nil)
    }
}

// Opens and places the composer panel. One for the app's life; each opening starts empty.
@MainActor
final class MenuComposer {
    static var shared: MenuComposer?
    static let width: CGFloat = 380
    // The longest hand-off and shout the backend takes (handoffs.offer, feed.shout), and the longest "why".
    static let taskLimit = 2_000
    static let whyLimit = 500
    static let shoutLimit = 140

    enum Kind { case handoff, shout }

    let panel = MenuComposerPanel()
    private let client: AgentClient
    private let style: HUDStyle
    // Where the panel's top edge goes: just under the menu bar.
    private var top: CGFloat?

    var visible: Bool { panel.isVisible }

    init(client: AgentClient, style: HUDStyle) {
        self.client = client
        self.style = style
        // The forms keep their size, but if the content ever changes it, the top edge stays under the menu bar.
        NotificationCenter.default.addObserver(forName: NSWindow.didResizeNotification, object: panel, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.keepTop() }
        }
    }

    func show(_ kind: Kind) {
        let close: () -> Void = { [weak self] in self?.close() }
        let form: AnyView
        switch kind {
        case .handoff: form = AnyView(MenuHandoffForm(close: close))
        case .shout: form = AnyView(MenuShoutForm(close: close))
        }
        let host = NSHostingView(rootView: form.environmentObject(client).environmentObject(style))
        panel.contentView = host
        let size = host.fittingSize
        panel.setFrame(place(size), display: true)
        panel.orderFrontRegardless()
        panel.makeKey()
    }

    func close() {
        panel.orderOut(nil)
    }

    // Under soopdoop's icon when it can be found, else under the pointer (which is on the menu that opened it), kept on
    // the screen.
    private func place(_ size: NSSize) -> NSRect {
        let mouse = NSEvent.mouseLocation
        let icon = NSApp.windows.first { $0.className.contains("NSStatusBarWindow") && $0.isVisible && $0.frame.width < 200 }?.frame
        let anchor = icon.map { NSPoint(x: $0.midX, y: $0.minY) } ?? mouse
        let screen = NSScreen.screens.first { NSMouseInRect(anchor, $0.frame, false) } ?? NSScreen.main
        let area = screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let x = min(max(anchor.x - size.width / 2, area.minX + 8), area.maxX - size.width - 8)
        let top = area.maxY - 6
        self.top = top
        return NSRect(x: x, y: top - size.height, width: size.width, height: size.height)
    }

    private func keepTop() {
        guard let top, panel.isVisible, abs(panel.frame.maxY - top) > 0.5 else { return }
        panel.setFrameOrigin(NSPoint(x: panel.frame.minX, y: top - panel.frame.height))
    }
}

// The composers' frame: a title, the HUD's dark panel, rounded.
struct MenuComposerFrame<Content: View>: View {
    let title: String
    let detail: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(title.uppercased()).font(Theme.mono(9.5, .medium)).tracking(1).foregroundStyle(Theme.dim)
                Text(detail).font(Theme.mono(9.5)).foregroundStyle(Theme.dim)
                Spacer()
            }
            content()
        }
        .padding(12)
        .frame(width: MenuComposer.width, alignment: .leading)
        .background(Theme.panel)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.line2, lineWidth: 1))
        .environment(\.colorScheme, .dark)
    }
}

// The line under the fields: what went wrong, what was sent, or what will happen. Two lines always, so the panel keeps
// its size whichever shows.
struct MenuComposerNote: View {
    let problem: String?
    let sent: String?
    let hint: String

    var body: some View {
        Text(problem ?? sent ?? hint)
            .font(Theme.mono(10))
            .foregroundStyle(problem != nil ? Theme.amber : sent != nil ? Theme.green : Theme.dim)
            .lineLimit(2, reservesSpace: true)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// "Hand off…": a crewmate, the task in exactly the words their agent will read, and why it goes to them.
struct MenuHandoffForm: View {
    @EnvironmentObject var client: AgentClient
    let close: () -> Void
    @State private var to = ""
    @State private var task = ""
    @State private var why = ""
    @State private var sending = false
    @State private var problem: String?
    @State private var sent: String?
    @FocusState private var field: Field?

    private enum Field { case task, why }

    private var targets: [MenuLines.Target] { MenuLines.handoffTargets(client.state) }
    private var text: String { task.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var ready: Bool {
        !sending && sent == nil && !to.isEmpty && !text.isEmpty && text.count <= MenuComposer.taskLimit
            && why.count <= MenuComposer.whyLimit
    }

    var body: some View {
        MenuComposerFrame(title: "Hand off", detail: "a task for a crewmate's agent") {
            if targets.isEmpty {
                Text("Nobody to hand work to yet. Crewmates show up here once they are in your crew.")
                    .font(Theme.mono(11)).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                HStack {
                    Spacer()
                    Button("Close", action: close).buttonStyle(HUDButtonStyle()).keyboardShortcut(.cancelAction)
                }
            } else {
                HStack(spacing: 8) {
                    Text("To").font(Theme.mono(11)).foregroundStyle(Theme.muted)
                    Picker("To", selection: $to) {
                        ForEach(targets) { target in Text(label(target)).tag(target.handle) }
                    }
                    .labelsHidden()
                    .fixedSize()
                    Spacer()
                }
                // Return sends from either field (the field's own Return, or the Send button's when the panel has the
                // keyboard); Option-Return starts a new line in the task.
                TextField("What should their agent do? It gets exactly these words.", text: $task, axis: .vertical)
                    .lineLimit(4, reservesSpace: true)
                    .textFieldStyle(.roundedBorder)
                    .font(Theme.mono(12))
                    .focused($field, equals: .task)
                    .onSubmit(send)
                TextField("Why them? (optional)", text: $why)
                    .textFieldStyle(.roundedBorder)
                    .font(Theme.mono(11))
                    .focused($field, equals: .why)
                    .onSubmit(send)
                MenuComposerNote(problem: problem, sent: sent, hint: hint)
                HStack(spacing: 8) {
                    Text(counter).font(Theme.mono(10)).foregroundStyle(text.count > MenuComposer.taskLimit ? Theme.amber : Theme.dim)
                    Spacer()
                    Button("Cancel", action: close).buttonStyle(HUDButtonStyle()).keyboardShortcut(.cancelAction)
                    Button(sending ? "Sending…" : "Send", action: send)
                        .buttonStyle(HUDButtonStyle(primary: true))
                        .keyboardShortcut(.defaultAction)
                        .disabled(!ready)
                        .opacity(ready ? 1 : 0.45)
                }
            }
        }
        .onAppear {
            if to.isEmpty { to = targets.first?.handle ?? "" }
            DispatchQueue.main.async { field = .task }
        }
        .onChange(of: task) { problem = nil }
        .onChange(of: to) { problem = nil }
    }

    private var hint: String {
        let whose = to.isEmpty ? "their" : "@\(to)'s"
        return "It runs on \(whose) account, only with their yes. An offer lasts 24 hours. Option-Return: new line."
    }

    // Shown once the task is long: "1,850 / 2,000".
    private var counter: String {
        let count = text.count
        guard count > 1_500 else { return "" }
        return "\(count.formatted()) / \(MenuComposer.taskLimit.formatted())"
    }

    private func label(_ target: MenuLines.Target) -> String {
        guard let light = target.light else { return "@\(target.handle)" }
        return "@\(target.handle) · \(MenuIcon.word(light))"
    }

    private func send() {
        guard ready else { return }
        sending = true
        problem = nil
        let handle = to
        var args: [String: Any] = ["toHandle": handle, "text": text, "via": "menu"]
        let reason = why.trimmingCharacters(in: .whitespacesAndNewlines)
        if !reason.isEmpty { args["why"] = reason }
        Task {
            do {
                try await client.act("offerHandoff", args)
                let done = "Offered to @\(handle). They approve it in their soopdoop."
                sent = done
                client.toast = done
                try? await Task.sleep(for: .seconds(1.6))
                close()
            } catch {
                problem = (error as? AgentError)?.message ?? error.localizedDescription
            }
            sending = false
        }
    }
}

// "Shout…": one line on the crew's wire for a day ("ship it", "lunch?", "CI is red, looking").
struct MenuShoutForm: View {
    @EnvironmentObject var client: AgentClient
    let close: () -> Void
    @State private var text = ""
    @State private var sending = false
    @State private var problem: String?
    @State private var sent: String?
    @FocusState private var typing: Bool

    private var line: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var ready: Bool { !sending && sent == nil && !line.isEmpty && line.count <= MenuComposer.shoutLimit }

    var body: some View {
        MenuComposerFrame(title: "Shout", detail: "one line to your crew") {
            TextField("ship it · lunch? · CI is red, looking", text: $text)
                .textFieldStyle(.roundedBorder)
                .font(Theme.mono(12))
                .focused($typing)
                .onSubmit(send)
            MenuComposerNote(problem: problem, sent: sent, hint: "It shows on your crew's wire for 24 hours, then it is gone.")
            HStack(spacing: 8) {
                Text("\(line.count)/\(MenuComposer.shoutLimit)")
                    .font(Theme.mono(10))
                    .foregroundStyle(line.count > MenuComposer.shoutLimit ? Theme.amber : Theme.dim)
                Spacer()
                Button("Cancel", action: close).buttonStyle(HUDButtonStyle()).keyboardShortcut(.cancelAction)
                Button(sending ? "Shouting…" : "Shout", action: send)
                    .buttonStyle(HUDButtonStyle(primary: true))
                    .keyboardShortcut(.defaultAction)
                    .disabled(!ready)
                    .opacity(ready ? 1 : 0.45)
            }
        }
        .onAppear { DispatchQueue.main.async { typing = true } }
        .onChange(of: text) { problem = nil }
    }

    private func send() {
        guard ready else { return }
        sending = true
        problem = nil
        let shout = line
        Task {
            do {
                try await client.act("shout", ["text": shout])
                let done = "Shouted to the crew. It leaves the wire in 24 hours."
                sent = done
                client.toast = done
                try? await Task.sleep(for: .seconds(1.2))
                close()
            } catch {
                problem = (error as? AgentError)?.message ?? error.localizedDescription
            }
            sending = false
        }
    }
}
