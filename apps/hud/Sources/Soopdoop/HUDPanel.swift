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
    // Where the panel's frame is remembered. ".2": frames saved before the panel stopped growing with its content can
    // be taller than the screen, so they are left behind and the HUD starts over at its normal size.
    static let frameName = "SoopdoopHUD.2"

    let panel = HUDPanel()
    private let client: AgentClient
    private let style: HUDStyle
    private var watchers: [AnyCancellable] = []
    // A peek from the menu bar: shown until the hacker switches apps.
    private var peeking = false
    private(set) var visible = false

    // remember: false for checks, which must not move the real HUD's saved frame.
    init(client: AgentClient, style: HUDStyle, remember: Bool = true) {
        self.client = client
        self.style = style
        let host = NSHostingView(rootView: HUDRoot().environmentObject(client).environmentObject(style))
        // The window keeps the size it has and the content scrolls inside it. By default the hosting view resizes its
        // window to fit the content, so a toast (or a longer crew) made the HUD grow past the bottom of the screen.
        host.sizingOptions = []
        host.wantsLayer = true
        host.layer?.backgroundColor = NSColor.clear.cgColor
        panel.contentView = host
        if !remember || !panel.setFrameUsingName(Self.frameName) { placeTopRight() }
        if remember { panel.setFrameAutosaveName(Self.frameName) }
        fitOnScreen()

        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.fitOnScreen() }
        }

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
        let height = min(panel.frame.height, screen.height - 32)
        panel.setFrame(NSRect(x: screen.maxX - panel.frame.width - 16, y: screen.maxY - height - 16, width: panel.frame.width, height: height), display: false)
    }

    // Keeps the whole HUD on its screen: never taller than the space between the menu bar and the Dock, and moved back
    // inside when it hangs over an edge (a frame saved on a bigger display, or a display that went away).
    func fitOnScreen() {
        guard let area = (panel.screen ?? NSScreen.main)?.visibleFrame.insetBy(dx: 8, dy: 8) else { return }
        var frame = panel.frame
        frame.size.width = min(frame.width, area.width)
        frame.size.height = min(frame.height, area.height)
        frame.origin.x = min(max(frame.minX, area.minX), area.maxX - frame.width)
        frame.origin.y = min(max(frame.minY, area.minY), area.maxY - frame.height)
        if frame != panel.frame { panel.setFrame(frame, display: visible) }
    }

    var supersetInFront: Bool {
        NSWorkspace.shared.frontmostApplication?.bundleIdentifier == Self.supersetBundleId
    }

    // soopdoop itself is in front while its Settings window is open: the HUD stays up to show the look being picked.
    private var selfInFront: Bool {
        NSWorkspace.shared.frontmostApplication?.processIdentifier == ProcessInfo.processInfo.processIdentifier
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
        case .hidden: show = peeking || selfInFront
        case .withSuperset: show = peeking || supersetInFront || selfInFront || needsAttention
        }
        if show && !visible {
            fitOnScreen()
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
