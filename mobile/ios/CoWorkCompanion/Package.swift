// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "CoWorkCompanion",
    platforms: [.iOS(.v16)],
    targets: [
        .executableTarget(
            name: "CoWorkCompanion",
            path: "Sources"
        ),
    ]
)
