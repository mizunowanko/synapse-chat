// SynapseDesktopHelper: a menu-bar agent (LSUIElement) that owns the macOS
// permissions for the desktop MCP server and serves it over a Unix socket
// (default ~/Library/Application Support/synapse-desktop/helper.sock, 0600;
// `--socket <path>` overrides it).
//
// The menu-bar icon is a red dot while a session holds the desktop; its menu
// has Stop (same as Esc), the permission prompts and Quit.
import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    let sessions = SessionManager()
    var server: SocketServer!
    var handler: Handler!
    var statusItem: NSStatusItem!
    let stateItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let permItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    let stopItem = NSMenuItem(title: "停止（Esc）", action: #selector(stop), keyEquivalent: "")

    static func socketPath() -> String {
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--socket"), i + 1 < args.count { return args[i + 1] }
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("synapse-desktop/helper.sock").path
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        server = SocketServer(path: Self.socketPath())
        handler = Handler(sessions: sessions, server: server)
        server.onRequest = { [unowned self] conn, req in handler.handle(conn, req) }
        server.onDisconnect = { [unowned self] conn in sessions.released(by: ObjectIdentifier(conn)) }
        sessions.onChange = { [weak self] _ in DispatchQueue.main.async { self?.refresh() } }
        EscWatcher.shared.onEscape = { [weak self] in self?.abort(by: "esc") }
        do {
            try server.start()
        } catch {
            FileHandle.standardError.write("desktop-helper: \(error)\n".data(using: .utf8)!)
            exit(1)
        }
        _ = EscWatcher.shared.install()

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let menu = NSMenu()
        stateItem.isEnabled = false
        permItem.isEnabled = false
        stopItem.target = self
        menu.addItem(stateItem)
        menu.addItem(stopItem)
        menu.addItem(.separator())
        menu.addItem(permItem)
        let prompt = NSMenuItem(title: "権限を求める…", action: #selector(promptPermissions), keyEquivalent: "")
        prompt.target = self
        menu.addItem(prompt)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "終了", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        menu.delegate = self
        statusItem.menu = menu
        refresh()
    }

    func applicationWillTerminate(_ notification: Notification) {
        server?.stop()
    }

    func abort(by: String) {
        guard let id = sessions.abort() else { return }
        server.broadcast(["event": "aborted", "session": id, "by": by])
    }

    func refresh() {
        let s = sessions.session
        if let button = statusItem?.button {
            let color: NSColor = s == nil ? .secondaryLabelColor : .systemRed
            button.attributedTitle = NSAttributedString(string: s == nil ? "○" : "●", attributes: [.foregroundColor: color])
            button.toolTip = s == nil ? "synapse desktop: 待機中" : "synapse desktop: セッション中（Esc で停止）"
        }
        if let s {
            stateItem.title = "セッション中: " + s.apps.sorted().joined(separator: ", ")
        } else {
            stateItem.title = "セッションなし"
        }
        stopItem.isEnabled = s != nil
        let ax = AXIsProcessTrusted() ? "可" : "不可"
        let sr = CGPreflightScreenCaptureAccess() ? "可" : "不可"
        permItem.title = "アクセシビリティ: \(ax) / 画面収録: \(sr) / Esc: \(EscWatcher.shared.installed ? "有効" : "無効")"
    }

    @objc func stop() { abort(by: "menu") }

    @objc func promptPermissions() {
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(opts)
        if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
        refresh()
    }

    @objc func quit() { NSApp.terminate(nil) }
}

extension AppDelegate: NSMenuDelegate {
    func menuWillOpen(_ menu: NSMenu) {
        if !EscWatcher.shared.installed { _ = EscWatcher.shared.install() }
        refresh()
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
signal(SIGPIPE, SIG_IGN)
// `kill` / `pkill` should not leave a dead socket file behind.
signal(SIGTERM, SIG_IGN)
let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigterm.setEventHandler { NSApp.terminate(nil) }
sigterm.resume()
app.run()
