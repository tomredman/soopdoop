// ABOUTME: Entry point. `Soopdoop --snapshot <dir>` draws the HUD, the menu bar icon, the composers and Settings into PNG
// ABOUTME: files with sample data; `--check-window` checks the HUD window's size and place. Both exit; anything else starts the app.
import AppKit

if CommandLine.arguments.contains("--check-window") {
    exit(MainActor.assumeIsolated { WindowCheck.run() })
}

// Everything in one run. `--snapshot-menu <dir>` still draws only the menu bar's pictures (SoopdoopApp.init).
if let at = CommandLine.arguments.firstIndex(of: "--snapshot") {
    let dir = CommandLine.arguments.count > at + 1 ? CommandLine.arguments[at + 1] : "."
    MainActor.assumeIsolated {
        Snapshot.run(into: dir)
        MenuSnapshot.run(into: dir)
    }
    exit(0)
}

SoopdoopApp.main()
