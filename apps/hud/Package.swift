// swift-tools-version:5.9
// ABOUTME: The soopdoop Mac app: a menu bar item and a HUD that shows over Superset. Built on each Mac by `soopdoop setup`.
// ABOUTME: It talks only to this machine's rail server (127.0.0.1:47312/app), which holds the sign-in and the Convex connection.
import PackageDescription

let package = Package(
    name: "Soopdoop",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "Soopdoop", path: "Sources/Soopdoop")
    ]
)
