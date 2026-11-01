// The single-session lock and the allowed sets.
//
// One client session (a session id the MCP server makes) holds the screen and
// the input at a time. `beginSession` takes the lock and sets what it may see
// (`apps`) and touch (`inputApps`, a subset). Esc or the menu's Stop aborts:
// the lock and the sets are cleared, and the aborted id is remembered so its
// next request is told `aborted` rather than `no-session`.
import Foundation

struct Session {
    let id: String
    /// The connection that began it; the lock is released when it disconnects.
    let owner: ObjectIdentifier
    /// Bundle ids whose windows appear in screenshots.
    let apps: Set<String>
    /// Bundle ids that may receive clicks and keys. Always within `apps`.
    let inputApps: Set<String>
    let expiresAt: Date?
}

final class SessionManager {
    private let lock = NSLock()
    private var current: Session?
    private var aborted: Set<String> = []

    /// Called (on any thread) whenever the session starts, ends or is aborted.
    var onChange: ((Session?) -> Void)?

    var session: Session? {
        lock.lock()
        defer { lock.unlock() }
        return current
    }

    func begin(_ s: Session, isConnected: (ObjectIdentifier) -> Bool) throws {
        lock.lock()
        if let cur = current, cur.id != s.id, isConnected(cur.owner), !isExpired(cur) {
            lock.unlock()
            throw HelperError("locked", "Another session holds the desktop.", extra: ["holder": cur.id])
        }
        current = s
        aborted.remove(s.id)
        lock.unlock()
        onChange?(s)
    }

    func end(_ id: String) {
        lock.lock()
        let changed = current?.id == id
        if changed { current = nil }
        lock.unlock()
        if changed { onChange?(nil) }
    }

    /// Clears the session; returns the id that was aborted, if any.
    @discardableResult
    func abort() -> String? {
        lock.lock()
        let id = current?.id
        if let id { aborted.insert(id) }
        current = nil
        lock.unlock()
        onChange?(nil)
        return id
    }

    func released(by owner: ObjectIdentifier) {
        lock.lock()
        let changed = current?.owner == owner
        if changed { current = nil }
        lock.unlock()
        if changed { onChange?(nil) }
    }

    /// The caller's session, or the refusal that says why it has none.
    func require(_ id: String?) throws -> Session {
        guard let id, !id.isEmpty else { throw HelperError("bad-request", "session is required") }
        lock.lock()
        defer { lock.unlock() }
        if aborted.contains(id) {
            throw HelperError("aborted", "The user aborted the session (Esc or Stop). Ask for access again.")
        }
        guard let cur = current else { throw HelperError("no-session", "No session. Ask for access first.") }
        guard cur.id == id else { throw HelperError("locked", "Another session holds the desktop.", extra: ["holder": cur.id]) }
        if isExpired(cur) { throw HelperError("expired", "The grant has expired. Ask for access again.") }
        return cur
    }

    /// For long operations (typing) to stop between steps once Esc is pressed.
    func stillHeld(_ id: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return current?.id == id
    }

    private func isExpired(_ s: Session) -> Bool {
        if let e = s.expiresAt { return Date() >= e }
        return false
    }
}
