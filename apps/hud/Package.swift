// swift-tools-version:5.9
// ABOUTME: The soopdoop Mac app (a menu bar item and a HUD that shows over Superset) and its watcher, which opens the app
// ABOUTME: when Superset opens. Built on each Mac by `soopdoop setup`. The app talks only to this Mac's rail server (127.0.0.1:47312/app).
import PackageDescription

let package = Package(
    name: "Soopdoop",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "Soopdoop", path: "Sources/Soopdoop"),
        .executableTarget(name: "SoopdoopWatcher", path: "Sources/SoopdoopWatcher"),
    ]
)
