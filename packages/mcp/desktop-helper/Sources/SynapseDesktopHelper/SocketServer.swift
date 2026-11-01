// The Unix domain socket and its JSON-lines framing.
//
// One request per line: {"id": <any>, "op": "<name>", ...}. One response per
// request: {"id": <same>, "ok": true, "result": {...}} or
// {"id": <same>, "ok": false, "reason": "<code>", "error": "<sentence>"}.
// Unsolicited lines carry "event" instead of "id" (today only "aborted").
//
// Only processes of the same user may connect: the socket is 0600 inside a
// 0700 directory, and each connection's peer uid is checked again.
import Foundation

typealias JSON = [String: Any]

/// A refusal sent back to the client as `{ok: false, reason, error}`.
struct HelperError: Error {
    let reason: String
    let message: String
    var extra: JSON = [:]

    init(_ reason: String, _ message: String, extra: JSON = [:]) {
        self.reason = reason
        self.message = message
        self.extra = extra
    }
}

final class Connection {
    let fd: Int32
    private let writeLock = NSLock()
    private(set) var closed = false

    init(fd: Int32) { self.fd = fd }

    func send(_ object: JSON) {
        guard var data = try? JSONSerialization.data(withJSONObject: object, options: []) else { return }
        data.append(0x0A)
        writeLock.lock()
        defer { writeLock.unlock() }
        if closed { return }
        data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
            var off = 0
            while off < buf.count {
                let n = write(fd, buf.baseAddress! + off, buf.count - off)
                if n <= 0 {
                    if n < 0 && errno == EINTR { continue }
                    return
                }
                off += n
            }
        }
    }

    func close() {
        writeLock.lock()
        defer { writeLock.unlock() }
        if closed { return }
        closed = true
        Darwin.close(fd)
    }
}

final class SocketServer {
    let path: String
    private var listenFd: Int32 = -1
    private let connectionsLock = NSLock()
    private var connections: [ObjectIdentifier: Connection] = [:]

    /// Called on a background thread, one request at a time per connection.
    var onRequest: ((Connection, JSON) -> JSON)?
    var onDisconnect: ((Connection) -> Void)?

    init(path: String) { self.path = path }

    func start() throws {
        let dir = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        chmod(dir, 0o700)
        unlink(path)

        listenFd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard listenFd >= 0 else { throw HelperError("socket", "socket() failed: \(errno)") }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let maxLen = MemoryLayout.size(ofValue: addr.sun_path)
        let bytes = Array(path.utf8)
        guard bytes.count < maxLen else { throw HelperError("socket", "socket path too long (\(bytes.count) >= \(maxLen)): \(path)") }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        // Created owner-only from the start; chmod again in case umask widened it.
        let oldMask = umask(0o177)
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listenFd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        umask(oldMask)
        guard rc == 0 else { throw HelperError("socket", "bind(\(path)) failed: \(errno)") }
        chmod(path, 0o600)
        guard listen(listenFd, 8) == 0 else { throw HelperError("socket", "listen() failed: \(errno)") }

        let t = Thread { [weak self] in self?.acceptLoop() }
        t.name = "socket-accept"
        t.start()
    }

    func stop() {
        if listenFd >= 0 { Darwin.close(listenFd) }
        unlink(path)
    }

    func broadcast(_ object: JSON) {
        connectionsLock.lock()
        let all = Array(connections.values)
        connectionsLock.unlock()
        for c in all { c.send(object) }
    }

    func isConnected(_ id: ObjectIdentifier) -> Bool {
        connectionsLock.lock()
        defer { connectionsLock.unlock() }
        return connections[id] != nil
    }

    private func acceptLoop() {
        while true {
            let fd = accept(listenFd, nil, nil)
            if fd < 0 {
                if errno == EINTR { continue }
                return
            }
            var uid: uid_t = 0
            var gid: gid_t = 0
            if getpeereid(fd, &uid, &gid) != 0 || uid != getuid() {
                Darwin.close(fd)
                continue
            }
            var one: Int32 = 1
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
            let conn = Connection(fd: fd)
            connectionsLock.lock()
            connections[ObjectIdentifier(conn)] = conn
            connectionsLock.unlock()
            let t = Thread { [weak self] in self?.readLoop(conn) }
            t.name = "socket-conn"
            t.start()
        }
    }

    private func readLoop(_ conn: Connection) {
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 65536)
        outer: while true {
            let n = read(conn.fd, &chunk, chunk.count)
            if n < 0 && errno == EINTR { continue }
            if n <= 0 { break }
            buffer.append(contentsOf: chunk[0..<n])
            while let nl = buffer.firstIndex(of: 0x0A) {
                let line = buffer.subdata(in: buffer.startIndex..<nl)
                buffer.removeSubrange(buffer.startIndex...nl)
                if line.isEmpty { continue }
                guard let obj = (try? JSONSerialization.jsonObject(with: line)) as? JSON else {
                    conn.send(["id": NSNull(), "ok": false, "reason": "bad-request", "error": "not a JSON object"])
                    continue
                }
                let response = onRequest?(conn, obj) ?? ["ok": false, "reason": "internal", "error": "no handler"]
                var out = response
                out["id"] = obj["id"] ?? NSNull()
                conn.send(out)
                if conn.closed { break outer }
            }
            if buffer.count > 16 * 1024 * 1024 { break }
        }
        connectionsLock.lock()
        connections[ObjectIdentifier(conn)] = nil
        connectionsLock.unlock()
        conn.close()
        onDisconnect?(conn)
    }
}
