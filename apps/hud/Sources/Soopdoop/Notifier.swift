// ABOUTME: macOS notifications for what the HUD cannot show right now: a knock, a hand-off offered to me, a heads-up, a hand-off of
// ABOUTME: mine done, a flick, an answer, a friend request. Off, only while the HUD is hidden (default), or always. Requests carry buttons.
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
    private var caught = Set<String>()
    // Hand-offs offered to me, heads-up cards, and my hand-offs a crewmate's agent finished.
    private var offers = Set<String>()
    private var headsups = Set<String>()
    private var handoffsDone = Set<String>()
    private var asked = false

    init(client: AgentClient, style: HUDStyle) {
        self.client = client
        self.style = style
        super.init()
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let show = UNNotificationAction(identifier: "SHOW", title: "Show me", options: [.foreground])
        let later = UNNotificationAction(identifier: "LATER", title: "Not now", options: [])
        // A flick's notification can catch it right there, while the 10 seconds last.
        let catchIt = UNNotificationAction(identifier: "CATCH", title: "Catch!", options: [])
        // A hand-off that names one of my agents can be run or declined right there; one that names none opens the HUD to
        // pick an agent. Run now accepts it: my Mac gives it to the agent as soon as that agent is idle.
        let run = UNNotificationAction(identifier: "RUN", title: "Run now", options: [])
        let decline = UNNotificationAction(identifier: "DECLINE", title: "Decline", options: [])
        // A heads-up: ask that agent in the Operator chat, or let it go.
        let ask = UNNotificationAction(identifier: "ASK", title: "Ask", options: [.foreground])
        let notNow = UNNotificationAction(identifier: "NOT_NOW", title: "Not now", options: [])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: "knock", actions: [show, later], intentIdentifiers: []),
            UNNotificationCategory(identifier: "flick", actions: [catchIt], intentIdentifiers: []),
            UNNotificationCategory(identifier: "handoff", actions: [run, decline], intentIdentifiers: []),
            UNNotificationCategory(identifier: "handoff-pick", actions: [decline], intentIdentifiers: []),
            UNNotificationCategory(identifier: "headsup", actions: [ask, notNow], intentIdentifiers: []),
        ])
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
        let caughtIds = Set(state.flicks.caught.map(\.id))
        let offered = state.handoffs.incoming.filter { $0.status == "offered" }
        let offerIds = Set(offered.map(\.id))
        let headsupIds = Set(state.headsups.map(\.id))
        let done = state.handoffs.outgoing.filter { $0.status == "done" }
        let doneIds = Set(done.map(\.id))
        if seeded {
            // Flicks, with a line to go with them: a notification while the HUD is hidden, the green toast while it shows.
            for c in state.flicks.caught where !caught.contains(c.id) {
                let shame = Quips.pick(Quips.caught)
                if wanted {
                    post(id: "caught-\(c.id)", title: "@\(c.byHandle) caught your flick", body: c.xp > 0 ? "They took \(c.xp) XP. \(shame)" : "You had no XP to lose. Lucky.", category: nil)
                } else {
                    client.toast = c.xp > 0 ? "@\(c.byHandle) caught your flick and took \(c.xp) XP. \(shame)" : "@\(c.byHandle) caught your flick. You had no XP to lose. Lucky."
                }
            }
            let now = Date().timeIntervalSince1970 * 1000
            for flick in state.flicks.incoming where !flicks.contains(flick.id) {
                if flick.superflick {
                    let line = Quips.pick(Quips.superflicked)
                    let took = flick.xp > 0 ? "They took \(flick.xp) XP." : "You had no XP to take."
                    if wanted { post(id: "flick-\(flick.id)", title: "@\(flick.fromHandle) superflicked you", body: "\(took) \(line)", category: nil) }
                    else { client.toast = "⚡ @\(flick.fromHandle) superflicked you. \(took) \(line)" }
                } else {
                    let line = Quips.pick(Quips.flicked)
                    let catchable = flick.catchUntil > now
                    if wanted {
                        post(id: "flick-\(flick.id)", title: "@\(flick.fromHandle) flicked you", body: catchable ? "\(line) Catch it in 10 seconds and their XP is yours." : line, category: catchable ? "flick" : nil)
                    } else {
                        client.toast = "@\(flick.fromHandle) flicked you. \(line)\(catchable ? " Catch it!" : "")"
                    }
                }
            }
        }
        if seeded && wanted {
            if let knock, knock.id != lastKnock {
                post(id: "knock-\(knock.id)", title: "@\(knock.fromHandle) wants you to see this", body: knock.item.title, category: "knock")
            }
            // A chat reply in front of you needs no notification.
            let chatting = ChatWindow.shared?.visible ?? false
            for relay in state.wire where finished.contains(relay.id) && !finishedRelays.contains(relay.id) && !(chatting && relay.via == "chat") {
                let body = relay.status == "answered" ? (relay.answer ?? "") : (relay.note ?? "No answer.")
                post(id: "relay-\(relay.id)", title: "The Operator: \(relay.question)", body: body, category: nil)
            }
            for handle in requestHandles.subtracting(requests) {
                post(id: "friend-\(handle)", title: "@\(handle) wants to be friends", body: "Accept in the soopdoop HUD.", category: nil)
            }
            // A task a crewmate hands me: their exact words, and which of my agents would get it.
            for offer in offered where !offers.contains(offer.id) {
                let body = offer.targetAgentId == nil
                    ? "“\(offer.text)” Pick one of your agents in the HUD to run it."
                    : "“\(offer.text)” → your \(offer.targetAgentName ?? "chosen") agent"
                post(id: "handoff-\(offer.id)", title: "@\(offer.fromHandle) hands you a task", body: body,
                     category: offer.targetAgentId == nil ? "handoff-pick" : "handoff")
            }
            for card in state.headsups where !headsups.contains(card.id) {
                post(id: "headsup-\(card.id)", title: "@\(card.otherHandle)'s agent is on this \(card.kind == "files" ? "code" : "area")",
                     body: card.line, category: "headsup", info: ["handle": card.otherHandle])
            }
            for h in done where !handoffsDone.contains(h.id) {
                let link = h.links.first.map { " \($0)" } ?? ""
                post(id: "handoff-done-\(h.id)", title: "@\(h.toHandle)'s agent did your hand-off", body: (h.summary ?? h.text) + link, category: nil)
            }
        }
        // An offer answered or ended, or a heads-up gone: its notification goes too, so no stale button is left behind.
        let gone = offers.subtracting(offerIds).map { "handoff-\($0)" } + headsups.subtracting(headsupIds).map { "headsup-\($0)" }
        if !gone.isEmpty { UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: gone) }
        seeded = true
        lastKnock = knock?.id
        finishedRelays = finished
        requests = requestHandles
        flicks = flickIds
        caught = caughtIds
        offers = offerIds
        headsups = headsupIds
        handoffsDone = doneIds
    }

    private func post(id: String, title: String, body: String, category: String?, info: [String: String] = [:]) {
        let center = UNUserNotificationCenter.current()
        let send = {
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            if let category { content.categoryIdentifier = category }
            if !info.isEmpty { content.userInfo = info }
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
        let id = response.notification.request.identifier
        let handle = response.notification.request.content.userInfo["handle"] as? String
        Task { @MainActor in
            switch action {
            case "SHOW": self.client.run("decideKnock", ["outcome": "opened"])
            case "LATER": self.client.run("decideKnock", ["outcome": "not-now"])
            case "CATCH": self.client.catchFlick(String(id.dropFirst("flick-".count)))
            case "RUN":
                self.client.run("decideHandoff", ["handoffId": String(id.dropFirst("handoff-".count)), "outcome": "accept"],
                                done: "Accepted. Your agent gets it as soon as it is idle.")
            case "DECLINE":
                self.client.run("decideHandoff", ["handoffId": String(id.dropFirst("handoff-".count)), "outcome": "decline"], done: "Declined.")
            case "ASK":
                if let handle { ChatWindow.shared?.show(prefill: "@\(handle): ") }
            case "NOT_NOW": self.client.run("dismissHeadsup", ["headsupId": String(id.dropFirst("headsup-".count))])
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
