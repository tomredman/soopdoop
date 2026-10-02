// ABOUTME: The HUD's look: the prototype's colours (three LED colours carry meaning: green working, blue idle, purple a
// ABOUTME: relay in flight) and the style a hacker picks in Settings: material, background opacity, density, sections.
import AppKit
import SwiftUI

enum Theme {
    static let ground = Color(red: 0.039, green: 0.047, blue: 0.063)
    static let panel = Color(red: 0.063, green: 0.078, blue: 0.102)
    static let panel2 = Color(red: 0.082, green: 0.102, blue: 0.133)
    static let line = Color(red: 0.122, green: 0.149, blue: 0.188)
    static let line2 = Color(red: 0.165, green: 0.196, blue: 0.251)
    static let text = Color(red: 0.835, green: 0.859, blue: 0.890)
    static let muted = Color(red: 0.482, green: 0.522, blue: 0.584)
    // Lighter than the prototype's #4b5462: small text has to read on glass, not only on a solid panel.
    static let dim = Color(red: 0.384, green: 0.420, blue: 0.478)
    static let green = Color(red: 0.290, green: 0.871, blue: 0.502)
    static let blue = Color(red: 0.376, green: 0.647, blue: 0.980)
    static let purple = Color(red: 0.655, green: 0.545, blue: 0.980)
    static let amber = Color(red: 0.984, green: 0.749, blue: 0.141)

    static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}

// When the HUD is on screen.
enum HUDMode: String, CaseIterable, Identifiable {
    case withSuperset, always, hidden
    var id: String { rawValue }
    var label: String {
        switch self {
        case .withSuperset: return "With Superset"
        case .always: return "Always"
        case .hidden: return "Hidden"
        }
    }
}

enum HUDMaterial: String, CaseIterable, Identifiable {
    case glass, frosted, dark, solid
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
    // nil means no blur: a flat panel.
    var effect: NSVisualEffectView.Material? {
        switch self {
        case .glass: return .hudWindow
        case .frosted: return .popover
        case .dark: return .underWindowBackground
        case .solid: return nil
        }
    }
}

enum NotifyMode: String, CaseIterable, Identifiable {
    case off, whenHidden, always
    var id: String { rawValue }
    var label: String {
        switch self {
        case .off: return "Off"
        case .whenHidden: return "When the HUD is hidden"
        case .always: return "Always"
        }
    }
}

// What the hacker chose in Settings. Kept in this app's defaults; the HUD redraws when it changes.
final class HUDStyle: ObservableObject {
    @AppStorage("hud.mode") var modeRaw = HUDMode.withSuperset.rawValue
    @AppStorage("hud.material") var materialRaw = HUDMaterial.glass.rawValue
    @AppStorage("hud.opacity") var opacity = 0.85
    @AppStorage("hud.compact") var compact = false
    @AppStorage("hud.showCrew") var showCrew = true
    @AppStorage("hud.showOperator") var showOperator = true
    @AppStorage("hud.showBoard") var showBoard = true
    @AppStorage("hud.showMachine") var showMachine = true
    @AppStorage("hud.notify") var notifyRaw = NotifyMode.whenHidden.rawValue

    var mode: HUDMode {
        get { HUDMode(rawValue: modeRaw) ?? .withSuperset }
        set { modeRaw = newValue.rawValue }
    }
    var material: HUDMaterial {
        get { HUDMaterial(rawValue: materialRaw) ?? .glass }
        set { materialRaw = newValue.rawValue }
    }
    var notify: NotifyMode {
        get { NotifyMode(rawValue: notifyRaw) ?? .whenHidden }
        set { notifyRaw = newValue.rawValue }
    }

    var bodySize: CGFloat { compact ? 11 : 12 }
    var smallSize: CGFloat { compact ? 10 : 11 }
    var pad: CGFloat { compact ? 6 : 9 }
}

// An AppKit blur behind the HUD's content.
struct VisualEffect: NSViewRepresentable {
    let material: NSVisualEffectView.Material

    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.blendingMode = .behindWindow
        view.state = .active
        view.appearance = NSAppearance(named: .darkAqua)
        view.material = material
        return view
    }

    func updateNSView(_ view: NSVisualEffectView, context: Context) {
        view.material = material
    }
}
