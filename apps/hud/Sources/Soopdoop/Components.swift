// ABOUTME: Small pieces the HUD is built from: status lights (LEDs), the knock countdown ring, the XP bar, avatars, chips
// ABOUTME: and section headers. They follow the prototype's look.
import SwiftUI

// Green working, blue idle, purple a relay in flight, grey off.
struct LED: View {
    let color: Color?
    var size: CGFloat = 8
    var pulse = false
    @State private var dim = false

    var body: some View {
        Circle()
            .fill(color ?? Theme.dim)
            .frame(width: size, height: size)
            .shadow(color: (color ?? .clear).opacity(0.8), radius: color == nil ? 0 : 3)
            .opacity(pulse && dim ? 0.45 : 1)
            .onAppear {
                guard pulse else { return }
                withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) { dim = true }
            }
    }

    static func color(for led: String) -> Color? {
        switch led {
        case "g", "working": return Theme.green
        case "b", "idle", "waiting": return Theme.blue
        case "p": return Theme.purple
        default: return nil
        }
    }
}

// A network switch's activity light. Steady while the link is up (connected and signed in); flickering while traffic
// passes: the Operator working on a question, or an agent answering one. Anything that moves on the wire (a question
// starting, an answer landing) flickers it for a moment too.
struct ActivityLight: View {
    let link: Bool
    let busy: Bool
    // Changes whenever something moves on the wire.
    let traffic: String
    @State private var lit = true
    @State private var burst = false

    var body: some View {
        let flickering = link && (busy || burst)
        RoundedRectangle(cornerRadius: 1.5)
            .fill(link ? Theme.green : Theme.dim)
            .frame(width: 8, height: 5)
            .opacity(!link ? 0.4 : flickering ? (lit ? 1 : 0.2) : 0.5)
            .shadow(color: Theme.green.opacity(flickering && lit ? 0.9 : 0), radius: 3)
            // On and off at quick, uneven intervals, like a switch port.
            .task(id: flickering) {
                lit = true
                guard flickering else { return }
                while !Task.isCancelled {
                    lit = Double.random(in: 0...1) < 0.6
                    try? await Task.sleep(for: .milliseconds(Int.random(in: 35...110)))
                }
            }
            // The newest change wins: an earlier burst cannot end a later one.
            .task(id: traffic) {
                burst = true
                try? await Task.sleep(for: .seconds(1.5))
                if !Task.isCancelled { burst = false }
            }
            .help(link ? "Flickers while the Operator works on a question or an agent answers one." : "Not connected")
            .accessibilityLabel(flickering ? "Operator traffic" : link ? "Connected" : "Not connected")
    }
}

// The knock's countdown: a ring that empties as the time the server gave runs out.
struct CountdownRing: View {
    let expiresAt: Double
    let lifetimeMs: Double

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let now = context.date.timeIntervalSince1970 * 1000
            let left = max(0, expiresAt - now)
            let fraction = lifetimeMs > 0 ? min(1, left / lifetimeMs) : 0
            ZStack {
                Circle().stroke(Theme.line2, lineWidth: 3)
                Circle()
                    .trim(from: 0, to: fraction)
                    .stroke(left <= 10_000 ? Theme.amber : Theme.blue, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                Text(Self.label(left)).font(Theme.mono(9)).foregroundStyle(Theme.muted)
            }
            .frame(width: 28, height: 28)
        }
    }

    static func label(_ ms: Double) -> String {
        let s = Int((ms / 1000).rounded(.up))
        return s >= 60 ? "\(s / 60):\(String(format: "%02d", s % 60))" : "\(s)"
    }
}

// Progress from this rank to the next.
struct XPBar: View {
    let row: BoardRow

    var body: some View {
        let next = row.nextRankAt ?? row.xp
        let span = max(1, next - row.rankAt)
        let fraction = row.nextRankAt == nil ? 1 : min(1, Double(row.xp - row.rankAt) / Double(span))
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.line)
                Capsule()
                    .fill(LinearGradient(colors: [Theme.green, Theme.blue], startPoint: .leading, endPoint: .trailing))
                    .frame(width: max(4, geo.size.width * fraction))
            }
        }
        .frame(height: 4)
    }
}

struct Avatar: View {
    let handle: String
    let led: Color?
    var pulse = false

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Text(Self.initials(handle))
                .font(Theme.mono(10, .semibold))
                .foregroundStyle(Theme.text)
                .frame(width: 26, height: 26)
                .background(RoundedRectangle(cornerRadius: 6).fill(Theme.line2))
            LED(color: led, size: 9, pulse: pulse)
                .overlay(Circle().stroke(Theme.panel, lineWidth: 2))
                .offset(x: 2, y: 2)
        }
    }

    // "tom" → "TO", "tom-redman" → "TR".
    static func initials(_ handle: String) -> String {
        let parts = handle.split(separator: "-")
        let a = parts.first?.first.map(String.init) ?? "?"
        let b = parts.count > 1 ? parts[1].first.map(String.init) ?? "" : String(parts.first?.dropFirst().first.map(String.init) ?? "")
        return (a + b).uppercased()
    }
}

struct Chip: View {
    let text: String
    var color: Color = Theme.muted

    var body: some View {
        Text(text)
            .font(Theme.mono(10))
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .overlay(Capsule().stroke(Theme.line2, lineWidth: 1))
    }
}

// A section header that folds its section away: click the title. `trailing` goes on the right (a button).
struct FoldingHeader<Trailing: View>: View {
    let title: String
    var detail: String?
    @Binding var open: Bool
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Button { withAnimation(.easeInOut(duration: 0.15)) { open.toggle() } } label: {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 7.5, weight: .bold))
                        .rotationEffect(.degrees(open ? 90 : 0))
                    Text(title.uppercased()).font(Theme.mono(9.5, .medium)).tracking(1)
                    if let detail { Text(detail).font(Theme.mono(9.5)).lineLimit(1) }
                }
                .foregroundStyle(Theme.dim)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(open ? "Fold \(title)" : "Open \(title)")
            Spacer()
            trailing()
        }
        .padding(.top, 6)
    }
}

extension FoldingHeader where Trailing == EmptyView {
    init(title: String, detail: String? = nil, open: Binding<Bool>) {
        self.init(title: title, detail: detail, open: open) { EmptyView() }
    }
}

struct SectionHeader: View {
    let title: String
    var trailing: String? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title.uppercased()).font(Theme.mono(9.5, .medium)).tracking(1).foregroundStyle(Theme.dim)
            if let trailing { Text(trailing).font(Theme.mono(9.5)).foregroundStyle(Theme.dim) }
            Spacer()
        }
        .padding(.top, 6)
    }
}

// The HUD's buttons: quiet by default, one primary look.
struct HUDButtonStyle: ButtonStyle {
    var primary = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.mono(11))
            // One line at its own width: in a tight row the text beside it gives way, never the button ("Knoc/k").
            .lineLimit(1)
            .fixedSize()
            .foregroundStyle(primary ? Theme.text : Theme.muted)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(RoundedRectangle(cornerRadius: 6).fill(primary ? Theme.line2 : Theme.panel2.opacity(0.6)))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(primary ? Theme.blue.opacity(0.7) : Theme.line2, lineWidth: 1))
            .opacity(configuration.isPressed ? 0.6 : 1)
    }
}
