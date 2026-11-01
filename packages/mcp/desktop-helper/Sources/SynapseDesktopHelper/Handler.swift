// The socket's operations. Each request names its `op`; everything that
// sees or touches the screen also names its `session` and is checked against
// the session's allowed sets here, whatever the MCP server already checked.
//
// | op                 | params                                             | result |
// |--------------------|----------------------------------------------------|--------|
// | status             | —                                                  | version, permissions (accessibility, screenRecording, inputMonitoring), escWatcher, session |
// | requestPermissions | —                                                  | same as status (after prompting) |
// | listApps           | —                                                  | {apps, frontmost} |
// | resolveApps        | apps: [name or bundle id]                          | {apps: [{query, bundleId, name, path}]} |
// | beginSession       | session, apps, inputApps, expiresAt? (ms epoch)    | {session} |
// | endSession         | session                                            | {} |
// | openApp            | session, bundleId                                  | the app, windowOnScreen (waits ≤ 2 s) |
// | listWindows        | session                                            | {windows: [{id, pid, bundleId, app, title, x, y, width, height, onScreen, minimized, hidden, capturable, display}]} |
// | screenshot         | session, window?, region?, maxWidth?, maxHeight?, format?, quality? | image + geometry (window: that window alone, wherever it is) |
// | axTree             | session, window? / bundleId?, scope? (window / menubar), maxDepth?, maxNodes?, all?, maxWidth?, maxHeight? | {nodes, truncated, window?, geometry?} |
// | axAction           | session, ref, action (AXPress, AXConfirm, AXIncrement, AXShowMenu, …) | {ref, app, element} |
// | axSetValue         | session, ref, value                                | {ref, app, element} |
// | cursor             | session                                            | {x, y} (points) |
// | click              | session, x, y, button?, count?, modifiers?, window? | {app, background, via (ax-press / ax-focus / event / hid), element?} |
// | move               | session, x, y, window?                              | {app, background} |
// | mouseDown/mouseUp  | session, x?, y?, button?, window?                   | {app, background} |
// | drag               | session, x, y, toX, toY, button?, window?           | {app, background} |
// | scroll             | session, x, y, dx, dy, window?                      | {app, background} |
// | key                | session, keys ("cmd+shift+a", "ctrl+a Delete"), window? | {app, background} |
// | type               | session, text, window?                              | {app, typed, background} |
//
// `window` (a CGWindowID from listWindows / screenshot) sends the events to
// that window's process (CGEvent.postToPid): the cursor stays and the app is
// not activated. A plain left click there first goes through AX (the element
// under the point is pressed or focused, AX.clickThroughAX): AppKit drops a
// posted click on an inactive window, keys it takes. Without it they go through the HID tap as before (the
// foreground fallback: the cursor moves, keys go to the frontmost app).
import AppKit
import ApplicationServices
import CoreGraphics

let helperVersion = "2"

final class Handler {
    let sessions: SessionManager
    let server: SocketServer
    /// Serializes everything that touches the screen, off the main thread (the Esc tap lives there).
    private let queue = DispatchQueue(label: "desktop-helper.ops")

    init(sessions: SessionManager, server: SocketServer) {
        self.sessions = sessions
        self.server = server
    }

    func handle(_ conn: Connection, _ req: JSON) -> JSON {
        queue.sync {
            do {
                return ["ok": true, "result": try dispatch(conn, req)]
            } catch let e as HelperError {
                var o: JSON = ["ok": false, "reason": e.reason, "error": e.message]
                for (k, v) in e.extra { o[k] = v }
                return o
            } catch {
                return ["ok": false, "reason": "internal", "error": "\(error)"]
            }
        }
    }

    // MARK: - dispatch

    private func dispatch(_ conn: Connection, _ r: JSON) throws -> JSON {
        guard let op = r["op"] as? String else { throw HelperError("bad-request", "op is required") }
        switch op {
        case "status":
            return status()
        case "requestPermissions":
            let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(opts)
            if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
            if !CGPreflightListenEventAccess() { _ = CGRequestListenEventAccess() }
            return status()
        case "listApps":
            return ["apps": Apps.running(), "frontmost": Apps.frontmost().map(Apps.describe) ?? NSNull()]
        case "resolveApps":
            guard let list = r["apps"] as? [String] else { throw HelperError("bad-request", "apps: [string] is required") }
            return ["apps": list.map(Apps.resolve)]
        case "beginSession":
            return try beginSession(conn, r)
        case "endSession":
            if let id = r["session"] as? String { sessions.end(id) }
            return [:]
        case "openApp":
            let s = try sessions.require(r["session"] as? String)
            guard let bid = r["bundleId"] as? String else { throw HelperError("bad-request", "bundleId is required") }
            guard s.apps.contains(bid) else { throw notAllowed(bid, nil, "open") }
            var opened = try Apps.open(bundleId: bid)
            // The Space switch takes a moment: wait for a window before the next screenshot / click.
            if let pid = opened["pid"] as? Int {
                opened["windowOnScreen"] = Windows.waitOnScreen(pid: pid_t(pid), timeout: 2)
            }
            return opened
        case "listWindows":
            let s = try sessions.require(r["session"] as? String)
            let displays = Windows.activeDisplays()
            return ["windows": try Windows.list(bundleIds: s.apps).map { $0.json(displays: displays) }]
        case "axTree":
            return try axTree(r)
        case "axAction", "axSetValue":
            return try axAct(op, r)
        case "screenshot":
            let s = try sessions.require(r["session"] as? String)
            var o = Capture.Options()
            if let reg = r["region"] as? JSON {
                o.region = CGRect(x: num(reg["x"]) ?? 0, y: num(reg["y"]) ?? 0, width: num(reg["width"]) ?? 0, height: num(reg["height"]) ?? 0)
            }
            if let w = num(r["maxWidth"]) { o.maxWidth = Int(w) }
            if let h = num(r["maxHeight"]) { o.maxHeight = Int(h) }
            if let f = r["format"] as? String { o.format = f }
            if let q = num(r["quality"]) { o.quality = q }
            if let wid = num(r["window"]) {
                guard let w = try Windows.find(CGWindowID(wid), bundleIds: s.apps) else {
                    if Windows.lookup(CGWindowID(wid), bundleIds: s.apps) != nil {
                        throw HelperError("capture-failed", "ScreenCaptureKit does not list the window \(Int(wid)) right now (it may be closing or redrawing). Try again.")
                    }
                    throw HelperError("no-window", "No window \(Int(wid)) of an allowed app. Call list_windows.", extra: ["apps": s.apps.sorted()])
                }
                return try Windows.capture(w, options: o)
            }
            return try Capture.screenshot(apps: s.apps, options: o)
        case "cursor":
            _ = try sessions.require(r["session"] as? String)
            let p = Input.cursor()
            return ["x": Double(p.x), "y": Double(p.y)]
        case "click", "move", "mouseDown", "mouseUp", "drag", "scroll":
            return try mouse(op, r)
        case "key":
            let s = try requireInput(r)
            guard let text = r["keys"] as? String else { throw HelperError("bad-request", "keys is required") }
            let combos = try KeyParser.parse(text)
            let (app, target) = try keyTarget(s, r)
            for c in combos {
                guard sessions.stillHeld(s.id) else { break }
                Input.key(c, target)
            }
            return ["app": app, "background": isBackground(target)]
        case "type":
            let s = try requireInput(r)
            guard let text = r["text"] as? String else { throw HelperError("bad-request", "text is required") }
            let (app, target) = try keyTarget(s, r)
            let typed = Input.type(text, target) { sessions.stillHeld(s.id) }
            if typed < text.count && !sessions.stillHeld(s.id) {
                throw HelperError("aborted", "The user aborted the session while typing (\(typed) of \(text.count) characters typed).")
            }
            return ["app": app, "typed": typed, "background": isBackground(target)]
        default:
            throw HelperError("bad-request", "unknown op \(op)")
        }
    }

    // MARK: - status and session

    func status() -> JSON {
        if !EscWatcher.shared.installed && CGPreflightListenEventAccess() {
            DispatchQueue.main.sync { _ = EscWatcher.shared.install() }
        }
        var o: JSON = [
            "version": helperVersion,
            "pid": Int(getpid()),
            "socket": server.path,
            "bundlePath": Bundle.main.bundlePath,
            "accessibility": AXIsProcessTrusted(),
            "screenRecording": CGPreflightScreenCaptureAccess(),
            // The Esc watcher's event tap needs it (EscWatcher.swift).
            "inputMonitoring": CGPreflightListenEventAccess(),
            "escWatcher": EscWatcher.shared.installed,
        ]
        if let s = sessions.session {
            o["session"] = [
                "id": s.id,
                "apps": Array(s.apps).sorted(),
                "inputApps": Array(s.inputApps).sorted(),
                "expiresAt": s.expiresAt.map { Int($0.timeIntervalSince1970 * 1000) } ?? NSNull(),
            ] as JSON
        } else {
            o["session"] = NSNull()
        }
        return o
    }

    private func beginSession(_ conn: Connection, _ r: JSON) throws -> JSON {
        guard let id = r["session"] as? String, !id.isEmpty else { throw HelperError("bad-request", "session is required") }
        guard let apps = r["apps"] as? [String] else { throw HelperError("bad-request", "apps: [bundle id] is required") }
        let input = (r["inputApps"] as? [String]) ?? []
        let screen = Set(apps)
        var expires: Date?
        if let ms = num(r["expiresAt"]) {
            expires = Date(timeIntervalSince1970: ms / 1000)
            if expires! <= Date() { throw HelperError("expired", "expiresAt is in the past.") }
        }
        // Input needs the Esc watcher: no way to stop it otherwise.
        if !input.isEmpty && !EscWatcher.shared.installed {
            DispatchQueue.main.sync { _ = EscWatcher.shared.install() }
        }
        let s = Session(id: id, owner: ObjectIdentifier(conn), apps: screen, inputApps: Set(input).intersection(screen), expiresAt: expires)
        try sessions.begin(s, isConnected: server.isConnected)
        return ["session": id, "escWatcher": EscWatcher.shared.installed]
    }

    // MARK: - input checks

    private func requireInput(_ r: JSON) throws -> Session {
        let s = try sessions.require(r["session"] as? String)
        guard AXIsProcessTrusted() else {
            throw HelperError("permission", "Accessibility is not granted to the desktop helper.", extra: ["permission": "accessibility"])
        }
        guard EscWatcher.shared.installed else {
            throw HelperError("permission", "The Esc watcher is not running (needs Input Monitoring), so input is refused.", extra: ["permission": "inputMonitoring"])
        }
        return s
    }

    private func notAllowed(_ bundleId: String?, _ name: String?, _ what: String) -> HelperError {
        HelperError("not-allowed", "\(name ?? bundleId ?? "an unknown app") is not allowed for \(what).",
                    extra: ["app": ["bundleId": bundleId ?? NSNull(), "name": name ?? NSNull()] as JSON])
    }

    /// Keys go to the frontmost app: it must accept input.
    private func checkFrontmost(_ s: Session) throws -> JSON {
        let front = Apps.frontmost()
        guard let bid = front?.bundleIdentifier, s.inputApps.contains(bid) else {
            throw notAllowed(front?.bundleIdentifier, front?.localizedName, "input")
        }
        return Apps.describe(front!)
    }

    /// A click goes to the window under the point: its owner must accept input.
    private func checkPoint(_ s: Session, _ p: CGPoint) throws -> JSON {
        guard let owner = Apps.owner(at: p) else {
            throw HelperError("not-allowed", "No window of an allowed app at (\(Int(p.x)), \(Int(p.y))).")
        }
        guard let bid = owner.bundleId, s.inputApps.contains(bid) else {
            throw notAllowed(owner.bundleId, owner.name, "input")
        }
        return ["bundleId": bid, "name": owner.name ?? NSNull(), "pid": Int(owner.pid)]
    }

    private func isBackground(_ t: InputTarget) -> Bool {
        if case .hid = t { return false }
        return true
    }

    /// A window that takes input: its owner (from the window server, wherever the window is) must be in `inputApps`.
    private func inputWindow(_ s: Session, _ id: CGWindowID) throws -> (pid: pid_t, frame: CGRect, app: JSON) {
        guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]],
              let w = list.first, let pid = w[kCGWindowOwnerPID as String] as? Int32,
              let b = w[kCGWindowBounds as String] as? NSDictionary, let frame = CGRect(dictionaryRepresentation: b) else {
            throw HelperError("no-window", "No window \(id). Call list_windows.")
        }
        let app = NSRunningApplication(processIdentifier: pid)
        guard let bid = app?.bundleIdentifier, s.inputApps.contains(bid) else {
            throw notAllowed(app?.bundleIdentifier, app?.localizedName, "input")
        }
        return (pid, frame, ["bundleId": bid, "name": app?.localizedName ?? NSNull(), "pid": Int(pid)])
    }

    /// Keys go to `window`'s process when given (background), else to the frontmost app.
    private func keyTarget(_ s: Session, _ r: JSON) throws -> (JSON, InputTarget) {
        if let wid = num(r["window"]) {
            let w = try inputWindow(s, CGWindowID(wid))
            return (w.app, .process(pid: w.pid, window: CGWindowID(wid)))
        }
        return (try checkFrontmost(s), .hid)
    }

    // MARK: - accessibility

    private func requireAX() throws {
        guard AXIsProcessTrusted() else {
            throw HelperError("permission", "Accessibility is not granted to the desktop helper.", extra: ["permission": "accessibility"])
        }
        AX.setTimeouts()
    }

    private func axTree(_ r: JSON) throws -> JSON {
        let s = try sessions.require(r["session"] as? String)
        try requireAX()
        var o = AX.TreeOptions()
        if let d = num(r["maxDepth"]) { o.maxDepth = max(1, min(60, Int(d))) }
        if let n = num(r["maxNodes"]) { o.maxNodes = max(1, min(2000, Int(n))) }
        o.all = (r["all"] as? Bool) ?? false
        let scope = (r["scope"] as? String) ?? "window"
        var out: JSON = [:]
        let root: AXUIElement
        let pid: pid_t
        if let wid = num(r["window"]) {
            guard let w = Windows.lookup(CGWindowID(wid), bundleIds: s.apps) else {
                throw HelperError("no-window", "No window \(Int(wid)) of an allowed app. Call list_windows.", extra: ["apps": s.apps.sorted()])
            }
            pid = w.pid
            out["window"] = w.json(displays: Windows.activeDisplays())
            out["geometry"] = Windows.geometry(frame: w.frame, maxWidth: Int(num(r["maxWidth"]) ?? 1456), maxHeight: Int(num(r["maxHeight"]) ?? 1456))
            if scope == "menubar" {
                root = AXUIElementCreateApplication(pid)
            } else {
                guard let axw = AX.window(pid: pid, id: w.id) else {
                    throw HelperError("ax-no-window", "Accessibility cannot reach the window \(w.id) of \(w.appName) right now.", extra: ["window": out["window"]!])
                }
                root = axw
            }
        } else if let bid = r["bundleId"] as? String {
            guard s.apps.contains(bid) else { throw notAllowed(bid, nil, "reading") }
            guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bid).first else {
                throw HelperError("not-running", "\(bid) is not running.")
            }
            pid = app.processIdentifier
            root = AXUIElementCreateApplication(pid)
        } else {
            throw HelperError("bad-request", "window or bundleId is required")
        }
        var top = root
        if scope == "menubar" {
            guard let bar = AX.attr(root, kAXMenuBarAttribute), CFGetTypeID(bar) == AXUIElementGetTypeID() else {
                throw HelperError("ax-failed", "The app has no menu bar to read.")
            }
            top = bar as! AXUIElement
        }
        let t = AX.tree(top, session: s.id, options: o)
        out["nodes"] = t.nodes
        out["truncated"] = t.truncated
        out["scope"] = scope
        return out
    }

    private static let foregroundActions: Set<String> = ["AXRaise"]

    private func axAct(_ op: String, _ r: JSON) throws -> JSON {
        let s = try requireInput(r)
        try requireAX()
        guard let ref = r["ref"] as? String else { throw HelperError("bad-request", "ref is required") }
        let e = try AX.element(ref, session: s.id)
        guard let pid = AX.pid(of: e) else { throw HelperError("stale-ref", "The element \(ref) is gone. Call ax_tree again.") }
        let app = NSRunningApplication(processIdentifier: pid)
        guard let bid = app?.bundleIdentifier, s.inputApps.contains(bid) else {
            throw notAllowed(app?.bundleIdentifier, app?.localizedName, "input")
        }
        if op == "axAction" {
            guard let action = r["action"] as? String, action.hasPrefix("AX") else { throw HelperError("bad-request", "action (AXPress, …) is required") }
            if Self.foregroundActions.contains(action) {
                throw HelperError("bad-request", "\(action) would bring the window to the front; it is not offered in the background.")
            }
            try AX.perform(e, action)
        } else {
            guard let v = r["value"], v is String || v is NSNumber else { throw HelperError("bad-request", "value (string or number) is required") }
            try AX.setValue(e, v)
        }
        usleep(80_000)
        return ["ref": ref, "app": ["bundleId": bid, "name": app?.localizedName ?? NSNull(), "pid": Int(pid)] as JSON, "element": AX.describe(e)]
    }

    private func mouse(_ op: String, _ r: JSON) throws -> JSON {
        let s = try requireInput(r)
        let button = MouseButton(rawValue: (r["button"] as? String) ?? "left") ?? .left
        let here = Input.cursor()
        let p = CGPoint(x: num(r["x"]) ?? Double(here.x), y: num(r["y"]) ?? Double(here.y))
        var target = InputTarget.hid
        let app: JSON
        if let wid = num(r["window"]) {
            let w = try inputWindow(s, CGWindowID(wid))
            guard w.frame.insetBy(dx: -1, dy: -1).contains(p) else {
                throw HelperError("bad-request", "(\(Int(p.x)), \(Int(p.y))) is outside the window \(Int(wid)).")
            }
            target = .process(pid: w.pid, window: CGWindowID(wid))
            app = w.app
        } else {
            app = try checkPoint(s, p)
        }
        switch op {
        case "click":
            var flags: CGEventFlags = []
            for m in (r["modifiers"] as? [String]) ?? [] {
                guard let f = KeyParser.modifiers[m.lowercased()] else { throw HelperError("bad-request", "unknown modifier \(m)") }
                flags.insert(f)
            }
            let count = Int(num(r["count"]) ?? 1)
            if case let .process(pid, window) = target, button == .left, count == 1, flags.isEmpty,
               let done = AX.clickThroughAX(pid: pid, window: window, at: p) {
                usleep(80_000)
                return ["app": app, "background": true, "via": done.via, "element": done.element]
            }
            Input.click(at: p, button: button, count: count, flags: flags, target)
        case "move":
            Input.move(to: p, target)
        case "mouseDown", "mouseUp":
            Input.button(op == "mouseDown", at: p, button: button, target)
        case "drag":
            guard let tx = num(r["toX"]), let ty = num(r["toY"]) else { throw HelperError("bad-request", "toX / toY are required") }
            let to = CGPoint(x: tx, y: ty)
            if case .hid = target { _ = try checkPoint(s, to) }
            Input.drag(from: p, to: to, button: button, target)
        case "scroll":
            Input.scroll(at: p, dx: Int32(num(r["dx"]) ?? 0), dy: Int32(num(r["dy"]) ?? 0), target)
        default:
            break
        }
        return ["app": app, "background": isBackground(target), "via": isBackground(target) ? "event" : "hid"]
    }
}

func num(_ v: Any?) -> Double? {
    if let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() { return n.doubleValue }
    return nil
}
