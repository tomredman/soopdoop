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
    // Muted and dim are lighter than the prototype's: small text has to read on glass with a light window behind it
    // (about 4:1 there; check with the -light snapshots), not only on a solid dark panel.
    static let muted = Color(red: 0.600, green: 0.639, blue: 0.698)
    static let dim = Color(red: 0.522, green: 0.561, blue: 0.620)
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

// The HUD's sections under the alerts (knocks, friend requests, flicks), which the hacker can hide and put in order.
enum HUDSection: String, CaseIterable, Identifiable {
    case crew, operatorLine = "operator", board, machine

    var id: String { rawValue }
    var label: String {
        switch self {
        case .crew: return "Crew"
        case .operatorLine: return "Operator"
        case .board: return "Board"
        case .machine: return "This Mac"
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
    // Off until the hacker wants it: it is about this Mac, not the crew.
    @AppStorage("hud.showMachine") var showMachine = false
    // The section order, "crew,operator,board,machine"; empty until the hacker moves one.
    @AppStorage("hud.order") var orderRaw = ""
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

    // The chosen order. Sections it does not name (all of them at first, or one added later) follow in the default order.
    var order: [HUDSection] {
        let chosen = orderRaw.split(separator: ",").compactMap { HUDSection(rawValue: String($0)) }
        return chosen + HUDSection.allCases.filter { !chosen.contains($0) }
    }

    func move(_ section: HUDSection, by offset: Int) {
        var list = order
        guard let i = list.firstIndex(of: section), list.indices.contains(i + offset) else { return }
        list.swapAt(i, i + offset)
        orderRaw = list.map(\.rawValue).joined(separator: ",")
    }

    func shows(_ section: HUDSection) -> Bool {
        switch section {
        case .crew: return showCrew
        case .operatorLine: return showOperator
        case .board: return showBoard
        case .machine: return showMachine
        }
    }

    func setShows(_ section: HUDSection, _ on: Bool) {
        switch section {
        case .crew: showCrew = on
        case .operatorLine: showOperator = on
        case .board: showBoard = on
        case .machine: showMachine = on
        }
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
