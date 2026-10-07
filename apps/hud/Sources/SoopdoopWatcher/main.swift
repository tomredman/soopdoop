// ABOUTME: The watcher: a small helper that opens soopdoop when Superset opens, unless the hacker turned that off
// ABOUTME: (`autoOpen` in ~/.soopdoop/settings.json). Its LaunchAgent, com.soopdoop.watcher, keeps it running.
import AppKit

// One line at a time into watcher.log, where launchd sends stdout.
setvbuf(stdout, nil, _IOLBF, 0)

// SOOPDOOP_SUPERSET_ID exists so a check can launch another app in Superset's place.
let supersetId = ProcessInfo.processInfo.environment["SOOPDOOP_SUPERSET_ID"] ?? "com.superset.desktop"
let appId = "com.soopdoop.app"
let appLabel = "com.soopdoop.hud"

func log(_ line: String) {
    print("\(ISO8601DateFormatter().string(from: Date())) \(line)")
}

var home: URL {
    if let custom = ProcessInfo.processInfo.environment["SOOPDOOP_HOME"] { return URL(fileURLWithPath: custom) }
    return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".soopdoop")
}

// On unless settings.json says "autoOpen": false. Read each time Superset opens, so a change needs no restart.
func autoOpen() -> Bool {
    guard let data = try? Data(contentsOf: home.appendingPathComponent("settings.json")),
          let settings = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return true }
    return settings["autoOpen"] as? Bool != false
}

// Through the app's LaunchAgent, as at login, so launchd restarts the app if it crashes. When that job is not loaded
// (stopped, or turned off in Login Items), the app is opened like any other app.
func openSoopdoop() {
    let kick = Process()
    kick.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    kick.arguments = ["kickstart", "gui/\(getuid())/\(appLabel)"]
    kick.standardOutput = FileHandle.nullDevice
    kick.standardError = FileHandle.nullDevice
    if (try? kick.run()) != nil {
        kick.waitUntilExit()
        if kick.terminationStatus == 0 {
            log("Superset opened, so soopdoop started.")
            return
        }
    }
    let app = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/soopdoop.app")
    let configuration = NSWorkspace.OpenConfiguration()
    // Superset keeps the focus.
    configuration.activates = false
    configuration.addsToRecentItems = false
    NSWorkspace.shared.openApplication(at: app, configuration: configuration) { _, error in
        if let error {
            log("Superset opened, but soopdoop did not open: \(error.localizedDescription)")
        } else {
            log("Superset opened, so soopdoop opened (its LaunchAgent is not loaded).")
        }
    }
}

NSWorkspace.shared.notificationCenter.addObserver(
    forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main
) { note in
    guard let launched = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
          launched.bundleIdentifier == supersetId else { return }
    if !autoOpen() {
        log("Superset opened. Auto-open is off, so soopdoop stays closed.")
    } else if !NSRunningApplication.runningApplications(withBundleIdentifier: appId).isEmpty {
        log("Superset opened. soopdoop is already running.")
    } else {
        openSoopdoop()
    }
}

log("Watching for Superset (\(supersetId)) to open.")
RunLoop.main.run()
