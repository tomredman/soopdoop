// ABOUTME: The HUD window: a floating panel that never takes focus from Superset, shown while Superset is in front (or
// ABOUTME: always, or never, per Settings), and always while the hacker still has to sign in. It remembers where it was put.
import AppKit
import Combine
import SwiftUI

final class HUDPanel: NSPanel {
    init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 300, height: 560),
            styleMask: [.nonactivatingPanel, .titled, .fullSizeContentView, .resizable],
            backing: .buffered,
            defer: false
        )
        isFloatingPanel = true
        level = .floating
        hidesOnDeactivate = false
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        isMovableByWindowBackground = true
        becomesKeyOnlyIfNeeded = true
        backgroundColor = .clear
        isOpaque = false
        hasShadow = true
        minSize = NSSize(width: 260, height: 220)
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        for button in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            standardWindowButton(button)?.isHidden = true
        }
    }

    // Text fields (ask the Operator, knock) need key status; the panel takes it without activating the app.
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class HUDController {
    static let supersetBundleId = "com.superset.desktop"

    let panel = HUDPanel()
    private let client: AgentClient
    private let style: HUDStyle
    private var watchers: [AnyCancellable] = []
    // A peek from the menu bar: shown until the hacker switches apps.
    private var peeking = false
    private(set) var visible = false

    init(client: AgentClient, style: HUDStyle) {
        self.client = client
        self.style = style
        let host = NSHostingView(rootView: HUDRoot().environmentObject(client).environmentObject(style))
        host.wantsLayer = true
        host.layer?.backgroundColor = NSColor.clear.cgColor
        panel.contentView = host
        if !panel.setFrameUsingName("SoopdoopHUD") { placeTopRight() }
        panel.setFrameAutosaveName("SoopdoopHUD")

        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.peeking = false
                self?.update()
            }
        }
        watchers.append(style.objectWillChange.sink { [weak self] _ in
            DispatchQueue.main.async { self?.update() }
        })
        watchers.append(client.$state.sink { [weak self] _ in
            DispatchQueue.main.async { self?.update() }
        })
        update()
    }

    private func placeTopRight() {
        guard let screen = NSScreen.main?.visibleFrame else { return }
        panel.setFrameOrigin(NSPoint(x: screen.maxX - panel.frame.width - 16, y: screen.maxY - panel.frame.height - 16))
    }

    var supersetInFront: Bool {
        NSWorkspace.shared.frontmostApplication?.bundleIdentifier == Self.supersetBundleId
    }

    // Until the hacker is signed in with a handle, the HUD is how they get there, so it shows whatever is in front.
    private var needsAttention: Bool {
        guard let phase = client.state?.phase else { return false }
        return phase == "signed-out" || phase == "signing-in" || phase == "needs-handle"
    }

    func update() {
        let show: Bool
        switch style.mode {
        case .always: show = true
        case .hidden: show = peeking
        case .withSuperset: show = peeking || supersetInFront || needsAttention
        }
        if show && !visible {
            panel.orderFrontRegardless()
        } else if !show && visible {
            panel.orderOut(nil)
        }
        visible = show
    }

    func peek() {
        peeking = true
        update()
        panel.makeKey()
    }
}
