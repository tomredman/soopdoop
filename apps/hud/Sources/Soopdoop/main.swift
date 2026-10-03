// ABOUTME: Entry point. `Soopdoop --snapshot <dir>` draws the HUD with sample data into PNG files and `--check-window`
// ABOUTME: checks the HUD window keeps its size and stays on screen; both exit when done. Anything else starts the app.
import AppKit

if CommandLine.arguments.contains("--check-window") {
    exit(MainActor.assumeIsolated { WindowCheck.run() })
}

if let at = CommandLine.arguments.firstIndex(of: "--snapshot") {
    let dir = CommandLine.arguments.count > at + 1 ? CommandLine.arguments[at + 1] : "."
    MainActor.assumeIsolated { Snapshot.run(into: dir) }
    exit(0)
}

SoopdoopApp.main()
