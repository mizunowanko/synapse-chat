// The socket's operations. Each request names its `op`; everything that
// sees or touches the screen also names its `session` and is checked against
// the session's allowed sets here, whatever the MCP server already checked.
//
// | op                 | params                                             | result |
// |--------------------|----------------------------------------------------|--------|
// | status             | —                                                  | version, permissions, session |
// | requestPermissions | —                                                  | same as status (after prompting) |
// | listApps           | —                                                  | {apps, frontmost} |
// | resolveApps        | apps: [name or bundle id]                          | {apps: [{query, bundleId, name, path}]} |
// | beginSession       | session, apps, inputApps, expiresAt? (ms epoch)    | {session} |
// | endSession         | session                                            | {} |
// | openApp            | session, bundleId                                  | the app |
// | screenshot         | session, region?, maxWidth?, maxHeight?, format?, quality? | image + geometry |
// | cursor             | session                                            | {x, y} (points) |
// | click              | session, x, y, button?, count?, modifiers?          | {app} |
// | move               | session, x, y                                       | {app} |
// | mouseDown/mouseUp  | session, x?, y?, button?                            | {app} |
// | drag               | session, x, y, toX, toY, button?                    | {app} |
// | scroll             | session, x, y, dx, dy                               | {app} |
// | key                | session, keys ("cmd+shift+a", "ctrl+a Delete")     | {app} |
// | type               | session, text                                       | {app, typed} |
import AppKit
import ApplicationServices
import CoreGraphics

let helperVersion = "1"

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
            return try Apps.open(bundleId: bid)
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
            let app = try checkFrontmost(s)
            for c in combos {
                guard sessions.stillHeld(s.id) else { break }
                Input.key(c)
            }
            return ["app": app]
        case "type":
            let s = try requireInput(r)
            guard let text = r["text"] as? String else { throw HelperError("bad-request", "text is required") }
            let app = try checkFrontmost(s)
            let typed = Input.type(text) { sessions.stillHeld(s.id) }
            if typed < text.count && !sessions.stillHeld(s.id) {
                throw HelperError("aborted", "The user aborted the session while typing (\(typed) of \(text.count) characters typed).")
            }
            return ["app": app, "typed": typed]
        default:
            throw HelperError("bad-request", "unknown op \(op)")
        }
    }

    // MARK: - status and session

    func status() -> JSON {
        if !EscWatcher.shared.installed && AXIsProcessTrusted() {
            DispatchQueue.main.sync { _ = EscWatcher.shared.install() }
        }
        var o: JSON = [
            "version": helperVersion,
            "pid": Int(getpid()),
            "socket": server.path,
            "bundlePath": Bundle.main.bundlePath,
            "accessibility": AXIsProcessTrusted(),
            "screenRecording": CGPreflightScreenCaptureAccess(),
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
            throw HelperError("permission", "The Esc watcher is not running (needs Accessibility), so input is refused.", extra: ["permission": "accessibility"])
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

    private func mouse(_ op: String, _ r: JSON) throws -> JSON {
        let s = try requireInput(r)
        let button = MouseButton(rawValue: (r["button"] as? String) ?? "left") ?? .left
        let here = Input.cursor()
        let p = CGPoint(x: num(r["x"]) ?? Double(here.x), y: num(r["y"]) ?? Double(here.y))
        let app = try checkPoint(s, p)
        switch op {
        case "click":
            var flags: CGEventFlags = []
            for m in (r["modifiers"] as? [String]) ?? [] {
                guard let f = KeyParser.modifiers[m.lowercased()] else { throw HelperError("bad-request", "unknown modifier \(m)") }
                flags.insert(f)
            }
            Input.click(at: p, button: button, count: Int(num(r["count"]) ?? 1), flags: flags)
        case "move":
            Input.move(to: p)
        case "mouseDown", "mouseUp":
            Input.button(op == "mouseDown", at: p, button: button)
        case "drag":
            guard let tx = num(r["toX"]), let ty = num(r["toY"]) else { throw HelperError("bad-request", "toX / toY are required") }
            let to = CGPoint(x: tx, y: ty)
            _ = try checkPoint(s, to)
            Input.drag(from: p, to: to, button: button)
        case "scroll":
            Input.scroll(at: p, dx: Int32(num(r["dx"]) ?? 0), dy: Int32(num(r["dy"]) ?? 0))
        default:
            break
        }
        return ["app": app]
    }
}

func num(_ v: Any?) -> Double? {
    if let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() { return n.doubleValue }
    return nil
}
