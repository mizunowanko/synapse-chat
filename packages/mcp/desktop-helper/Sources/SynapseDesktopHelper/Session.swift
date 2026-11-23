// The sessions, their allowed sets, and the screen lock (agt-533).
//
// Several client sessions (session ids the MCP servers make) may be open at
// once, as long as their apps do not overlap: an app belongs to one session
// at a time. `beginSession` sets what a session may see (`apps`) and touch
// (`inputApps`, a subset), and is refused (`locked`, with the holder) when
// another live session already has one of its apps.
//
// The screen itself (the pointer, the frontmost app, a capture of the whole
// display) is one: operations on screen coordinates take the screen lock
// first (`takeScreen`), and keep it for `screenLease` after their last such
// operation. Another session's screen operation meanwhile is refused with
// `screen-busy` (and `retryAfterMs`); the MCP server waits its turn. AX and
// window operations never need it.
//
// A `hold` session is the app's (familia's) way to keep apps out of reach
// after it stopped a grant: it operates on nothing, and Esc leaves it alone.
//
// Esc or the menu's Stop aborts every session but the holds: they are
// cleared, and their ids are remembered so their next request is told
// `aborted` rather than `no-session`.
import Foundation

struct Session {
    let id: String
    /// The connection that began it; the session ends when it disconnects.
    let owner: ObjectIdentifier
    /// Bundle ids whose windows appear in screenshots.
    let apps: Set<String>
    /// Bundle ids that may receive clicks and keys. Always within `apps`.
    let inputApps: Set<String>
    let expiresAt: Date?
    /// Keeps `apps` from other sessions; never aborted by Esc.
    var hold: Bool = false
    let begunAt: Date = Date()
}

/// How long the screen lock stays with a session after its last screen operation.
let screenLease: TimeInterval = 30

final class SessionManager {
    private let lock = NSLock()
    private var sessions: [String: Session] = [:]
    private var aborted: Set<String> = []
    private var screen: (id: String, until: Date)?

    /// Called (on any thread) whenever a session starts, ends or is aborted.
    var onChange: (() -> Void)?
    /// Called (on any thread) with the id of every session that ends, so its per-session state can go.
    var onEnd: ((String) -> Void)?

    /// Every session, the latest first.
    var all: [Session] {
        lock.lock()
        defer { lock.unlock() }
        return sessions.values.sorted { $0.begunAt > $1.begunAt }
    }

    /// The screen lock's holder and end, if a session holds it.
    var screenHolder: (id: String, until: Date)? {
        lock.lock()
        defer { lock.unlock() }
        if let s = screen, s.until > Date(), sessions[s.id] != nil { return s }
        return nil
    }

    func begin(_ s: Session, isConnected: (ObjectIdentifier) -> Bool) throws {
        lock.lock()
        var gone: [String] = []
        for (id, cur) in sessions where id != s.id && (!isConnected(cur.owner) || isExpired(cur)) {
            sessions[id] = nil
            gone.append(id)
        }
        if let cur = sessions.values.first(where: { $0.id != s.id && !$0.apps.isDisjoint(with: s.apps) }) {
            lock.unlock()
            for id in gone { onEnd?(id) }
            let overlap = cur.apps.intersection(s.apps).sorted()
            throw HelperError("locked", "Another session holds \(overlap.joined(separator: ", ")).", extra: ["holder": cur.id, "apps": overlap])
        }
        sessions[s.id] = s
        aborted.remove(s.id)
        lock.unlock()
        for id in gone { onEnd?(id) }
        onChange?()
    }

    func end(_ id: String) {
        lock.lock()
        let changed = sessions.removeValue(forKey: id) != nil
        if screen?.id == id { screen = nil }
        lock.unlock()
        if changed {
            onEnd?(id)
            onChange?()
        }
    }

    /// Clears every session but the holds; returns the ids that were aborted.
    @discardableResult
    func abort() -> [String] {
        lock.lock()
        let ids = sessions.values.filter { !$0.hold }.map(\.id)
        for id in ids {
            sessions[id] = nil
            aborted.insert(id)
        }
        screen = nil
        lock.unlock()
        for id in ids { onEnd?(id) }
        onChange?()
        return ids
    }

    func released(by owner: ObjectIdentifier) {
        lock.lock()
        let ids = sessions.values.filter { $0.owner == owner }.map(\.id)
        for id in ids { sessions[id] = nil }
        if let s = screen, ids.contains(s.id) { screen = nil }
        lock.unlock()
        for id in ids { onEnd?(id) }
        if !ids.isEmpty { onChange?() }
    }

    /// The caller's session, or the refusal that says why it has none.
    func require(_ id: String?) throws -> Session {
        guard let id, !id.isEmpty else { throw HelperError("bad-request", "session is required") }
        lock.lock()
        defer { lock.unlock() }
        if aborted.contains(id) {
            throw HelperError("aborted", "The user aborted the session (Esc or Stop). Ask for access again.")
        }
        guard let cur = sessions[id] else { throw HelperError("no-session", "No session. Ask for access first.") }
        if isExpired(cur) { throw HelperError("expired", "The grant has expired. Ask for access again.") }
        if cur.hold { throw HelperError("bad-request", "A hold session does not operate.") }
        return cur
    }

    /// Takes (or extends) the screen lock for `id`, or refuses while another live session has it.
    func takeScreen(_ id: String) throws {
        lock.lock()
        defer { lock.unlock() }
        let now = Date()
        if let s = screen, s.id != id, s.until > now, sessions[s.id] != nil {
            let ms = Int(ceil(s.until.timeIntervalSince(now) * 1000))
            throw HelperError("screen-busy", "Another session is using the screen (the pointer and the frontmost app). Wait for your turn.",
                              extra: ["holder": s.id, "retryAfterMs": ms])
        }
        screen = (id, now.addingTimeInterval(screenLease))
    }

    /// For long operations (typing) to stop between steps once Esc is pressed.
    func stillHeld(_ id: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return sessions[id] != nil
    }

    private func isExpired(_ s: Session) -> Bool {
        if let e = s.expiresAt { return Date() >= e }
        return false
    }
}
