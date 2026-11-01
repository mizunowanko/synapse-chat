// swift-tools-version:5.9
// The native half of the desktop MCP server (docs/design/desktop-mcp.md):
// a menu-bar agent that owns the macOS permissions (Accessibility, Screen
// Recording) and serves screenshots / input over a Unix domain socket.
// Built into an .app bundle by build.sh; not part of the npm package.
import PackageDescription

let package = Package(
    name: "SynapseDesktopHelper",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "SynapseDesktopHelper",
            path: "Sources/SynapseDesktopHelper",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("ApplicationServices"),
            ]
        ),
    ]
)
