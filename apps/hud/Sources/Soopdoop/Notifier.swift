// ABOUTME: macOS notifications for what the HUD cannot show right now: a knock, a flick, an answer to my question, a friend
// ABOUTME: request. Off, only while the HUD is hidden (default), or always. A knock's notification has Show me / Not now buttons.
import AppKit
import Combine
import UserNotifications

@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    private let client: AgentClient
    private let style: HUDStyle
    weak var hud: HUDController?
    private var watcher: AnyCancellable?
    private var seeded = false
    private var lastKnock: String?
    private var finishedRelays = Set<String>()
    private var requests = Set<String>()
    private var flicks = Set<String>()
    private var asked = false

    init(client: AgentClient, style: HUDStyle) {
        self.client = client
        self.style = style
        super.init()
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let show = UNNotificationAction(identifier: "SHOW", title: "Show me", options: [.foreground])
        let later = UNNotificationAction(identifier: "LATER", title: "Not now", options: [])
        center.setNotificationCategories([UNNotificationCategory(identifier: "knock", actions: [show, later], intentIdentifiers: [])])
        watcher = client.$state.sink { [weak self] state in
            DispatchQueue.main.async { self?.observe(state) }
        }
    }

    private var wanted: Bool {
        switch style.notify {
        case .off: return false
        case .always: return true
        case .whenHidden: return !(hud?.visible ?? false)
        }
    }

    // The first state only sets what has been seen, so old knocks and answers do not ring at launch.
    private func observe(_ state: AppState?) {
        guard let state, state.phase == "ready" else { return }
        let knock = state.incoming.current
        let finished = Set(state.wire.filter { $0.role == "asked" && !$0.inFlight }.map(\.id))
        let requestHandles = Set(state.requests.map(\.handle))
        let flickIds = Set(state.flicks.incoming.map(\.id))
        if seeded && wanted {
            for flick in state.flicks.incoming where !flicks.contains(flick.id) {
                let rally = flick.rally > 1 ? " Rally: \(flick.rally)." : ""
                post(id: "flick-\(flick.id)", title: "@\(flick.fromHandle) flicked you", body: "Flick back from the soopdoop HUD.\(rally)", category: nil)
            }
            if let knock, knock.id != lastKnock {
                post(id: "knock-\(knock.id)", title: "@\(knock.fromHandle) wants you to see this", body: knock.item.title, category: "knock")
            }
            for relay in state.wire where finished.contains(relay.id) && !finishedRelays.contains(relay.id) {
                let body = relay.status == "answered" ? (relay.answer ?? "") : (relay.note ?? "No answer.")
                post(id: "relay-\(relay.id)", title: "The Operator: \(relay.question)", body: body, category: nil)
            }
            for handle in requestHandles.subtracting(requests) {
                post(id: "friend-\(handle)", title: "@\(handle) wants to be friends", body: "Accept in the soopdoop HUD.", category: nil)
            }
        }
        seeded = true
        lastKnock = knock?.id
        finishedRelays = finished
        requests = requestHandles
        flicks = flickIds
    }

    private func post(id: String, title: String, body: String, category: String?) {
        let center = UNUserNotificationCenter.current()
        let send = {
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            if let category { content.categoryIdentifier = category }
            center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
        }
        if asked {
            send()
            return
        }
        asked = true
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            if granted { send() }
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void
    ) {
        let action = response.actionIdentifier
        Task { @MainActor in
            switch action {
            case "SHOW": self.client.run("decideKnock", ["outcome": "opened"])
            case "LATER": self.client.run("decideKnock", ["outcome": "not-now"])
            default: self.hud?.peek()
            }
            done()
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
        withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        done([.banner, .sound])
    }
}
