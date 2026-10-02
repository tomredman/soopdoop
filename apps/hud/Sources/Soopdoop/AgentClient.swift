// ABOUTME: The app's line to this machine's rail server (ws://127.0.0.1:47312/app): reads the owner-only token file,
// ABOUTME: receives the agent's state, sends actions and waits for their results, and reconnects when the server restarts.
import Foundation

@MainActor
final class AgentClient: ObservableObject {
    @Published private(set) var state: AppState?
    @Published private(set) var connected = false
    // A short line for the HUD after an action: what happened, or what went wrong.
    @Published var toast: String?

    private var task: URLSessionWebSocketTask?
    private var nextId = 1
    private var waiting: [Int: CheckedContinuation<Any?, Error>] = [:]
    private var backoff: Double = 0.5
    private let session = URLSession(configuration: .ephemeral)

    init() {}

    // A client that never connects, showing a fixed state: for --snapshot.
    init(preview: AppState) {
        state = preview
        connected = true
    }

    static var home: URL {
        if let custom = ProcessInfo.processInfo.environment["SOOPDOOP_HOME"] { return URL(fileURLWithPath: custom) }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".soopdoop")
    }

    func connect() {
        guard task == nil else { return }
        let tokenFile = Self.home.appendingPathComponent("app-token")
        guard let token = try? String(contentsOf: tokenFile, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
              !token.isEmpty, let endpoint = URL(string: "ws://127.0.0.1:47312/app") else {
            retryLater()
            return
        }
        var request = URLRequest(url: endpoint)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let socket = session.webSocketTask(with: request)
        task = socket
        socket.resume()
        Task { await receive(on: socket) }
    }

    private func receive(on socket: URLSessionWebSocketTask) async {
        while true {
            let message: URLSessionWebSocketTask.Message
            do {
                message = try await socket.receive()
            } catch {
                dropped(socket)
                return
            }
            if !connected {
                connected = true
                backoff = 0.5
            }
            let data: Data
            switch message {
            case .string(let text): data = Data(text.utf8)
            case .data(let bytes): data = bytes
            @unknown default: continue
            }
            handle(data)
        }
    }

    private func handle(_ data: Data) {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String else { return }
        if type == "state", let raw = object["state"],
           let json = try? JSONSerialization.data(withJSONObject: raw),
           let decoded = try? JSONDecoder().decode(AppState.self, from: json) {
            state = decoded
        } else if type == "result", let id = object["id"] as? Int, let waiter = waiting.removeValue(forKey: id) {
            if object["ok"] as? Bool == true {
                waiter.resume(returning: object["value"])
            } else {
                waiter.resume(throwing: AgentError(message: object["error"] as? String ?? "Something went wrong."))
            }
        }
    }

    private func dropped(_ socket: URLSessionWebSocketTask) {
        guard task === socket else { return }
        task = nil
        connected = false
        for (_, waiter) in waiting { waiter.resume(throwing: AgentError(message: "Lost the connection to soopdoop.")) }
        waiting.removeAll()
        retryLater()
    }

    private func retryLater() {
        let delay = backoff
        backoff = min(backoff * 2, 5)
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            self.connect()
        }
    }

    // Sends one action and waits for its result. Errors carry the server's own words.
    @discardableResult
    func act(_ action: String, _ args: [String: Any] = [:]) async throws -> Any? {
        guard let socket = task, connected else { throw AgentError(message: "soopdoop is not running on this Mac. Run `soopdoop setup` in Terminal.") }
        let id = nextId
        nextId += 1
        let body = try JSONSerialization.data(withJSONObject: ["id": id, "action": action, "args": args])
        return try await withCheckedThrowingContinuation { (waiter: CheckedContinuation<Any?, Error>) in
            waiting[id] = waiter
            socket.send(.string(String(decoding: body, as: UTF8.self))) { error in
                guard let error else { return }
                Task { @MainActor in
                    self.waiting.removeValue(forKey: id)?.resume(throwing: error)
                }
            }
        }
    }

    // For buttons: runs the action and puts the outcome in the toast.
    func run(_ action: String, _ args: [String: Any] = [:], done: String? = nil) {
        Task {
            do {
                try await act(action, args)
                if let done { toast = done }
            } catch {
                toast = (error as? AgentError)?.message ?? error.localizedDescription
            }
        }
    }
}

struct AgentError: Error {
    let message: String
}
