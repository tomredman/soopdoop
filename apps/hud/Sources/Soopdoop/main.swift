// ABOUTME: Entry point. `Soopdoop --snapshot <dir>` draws the HUD with sample data into PNG files and exits (for checking
// ABOUTME: the layout without a screen); anything else starts the app.
import AppKit

if let at = CommandLine.arguments.firstIndex(of: "--snapshot") {
    let dir = CommandLine.arguments.count > at + 1 ? CommandLine.arguments[at + 1] : "."
    MainActor.assumeIsolated { Snapshot.run(into: dir) }
    exit(0)
}

SoopdoopApp.main()
