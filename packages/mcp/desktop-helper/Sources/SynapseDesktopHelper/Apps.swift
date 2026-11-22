// Applications: what is running, what is in front, what is under a point,
// resolving a name to a bundle id, and opening one (NSWorkspace).
import AppKit
import CoreGraphics
import ApplicationServices

enum Apps {
    static func describe(_ app: NSRunningApplication) -> JSON {
        var o: JSON = ["pid": Int(app.processIdentifier), "active": app.isActive, "hidden": app.isHidden]
        o["name"] = app.localizedName ?? NSNull()
        o["bundleId"] = app.bundleIdentifier ?? NSNull()
        return o
    }

    static func running() -> [JSON] {
        NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular }
            .map(describe)
    }

    static func frontmost() -> NSRunningApplication? {
        NSWorkspace.shared.frontmostApplication
    }

    /// The app that gets a click at `point` (global points, top-left origin, the coordinate space CGEvent uses).
    ///
    /// Asks the accessibility hit test first: it answers with what is really under the point (a Dock tile is the Dock,
    /// the rest of the screen is the window below). The window list alone is not enough: the Dock keeps a
    /// full-display window at layer 20 on screen, so every point of the main display would be "Dock".
    static func owner(at point: CGPoint) -> (bundleId: String?, name: String?, pid: pid_t)? {
        if let pid = axOwner(at: point) {
            let app = NSRunningApplication(processIdentifier: pid)
            return (app?.bundleIdentifier, app?.localizedName, pid)
        }
        return windowOwner(at: point)
    }

    private static func axOwner(at point: CGPoint) -> pid_t? {
        var el: AXUIElement?
        guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &el) == .success,
              let el else { return nil }
        var pid: pid_t = 0
        return AXUIElementGetPid(el, &pid) == .success && pid > 0 ? pid : nil
    }

    /// The owner of the frontmost on-screen window containing `point`, skipping the Dock's full-display window.
    static func windowOwner(at point: CGPoint) -> (bundleId: String?, name: String?, pid: pid_t)? {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            return nil
        }
        let displays = activeDisplayBounds()
        for w in list {
            guard let b = w[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: b),
                  rect.contains(point) else { continue }
            if let alpha = w[kCGWindowAlpha as String] as? Double, alpha <= 0 { continue }
            guard let pid = w[kCGWindowOwnerPID as String] as? Int32 else { continue }
            let app = NSRunningApplication(processIdentifier: pid)
            let layer = (w[kCGWindowLayer as String] as? Int) ?? 0
            if app?.bundleIdentifier == "com.apple.dock", layer > 0, displays.contains(where: { $0 == rect }) { continue }
            return (app?.bundleIdentifier, app?.localizedName ?? (w[kCGWindowOwnerName as String] as? String), pid)
        }
        return nil
    }

    private static func activeDisplayBounds() -> [CGRect] {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
        return ids.prefix(Int(count)).map { CGDisplayBounds($0) }
    }

    private static let searchDirs: [String] = [
        "/Applications",
        "/Applications/Utilities",
        "/System/Applications",
        "/System/Applications/Utilities",
        (NSHomeDirectory() as NSString).appendingPathComponent("Applications"),
    ]

    /// A name or a bundle id → `{query, bundleId, name, path}` (`bundleId` null when not found).
    static func resolve(_ query: String) -> JSON {
        var out: JSON = ["query": query, "bundleId": NSNull(), "name": NSNull(), "path": NSNull()]
        func fill(_ url: URL) {
            let bundle = Bundle(url: url)
            out["bundleId"] = bundle?.bundleIdentifier ?? NSNull()
            out["name"] = (bundle?.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
                ?? (bundle?.object(forInfoDictionaryKey: "CFBundleName") as? String)
                ?? url.deletingPathExtension().lastPathComponent
            out["path"] = url.path
        }
        let q = query.trimmingCharacters(in: .whitespaces)
        if q.contains("."), let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: q) {
            fill(url)
            return out
        }
        let lower = q.lowercased().replacingOccurrences(of: ".app", with: "")
        if let app = NSWorkspace.shared.runningApplications.first(where: { $0.localizedName?.lowercased() == lower }),
           let url = app.bundleURL {
            fill(url)
            return out
        }
        let fm = FileManager.default
        for dir in searchDirs {
            guard let items = try? fm.contentsOfDirectory(atPath: dir) else { continue }
            if let hit = items.first(where: { $0.lowercased() == lower + ".app" }) {
                fill(URL(fileURLWithPath: dir).appendingPathComponent(hit))
                return out
            }
        }
        return out
    }

    /// Opens (or brings to front) the app with `bundleId`; waits up to 10 s.
    static func open(bundleId: String) throws -> JSON {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId) else {
            throw HelperError("not-found", "No application with bundle id \(bundleId).")
        }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        let done = DispatchSemaphore(value: 0)
        var opened: NSRunningApplication?
        var failure: Error?
        NSWorkspace.shared.openApplication(at: url, configuration: config) { app, err in
            opened = app
            failure = err
            done.signal()
        }
        if done.wait(timeout: .now() + 10) == .timedOut {
            throw HelperError("timeout", "Opening \(bundleId) did not finish in 10 s.")
        }
        if let failure { throw HelperError("open-failed", failure.localizedDescription) }
        return opened.map(describe) ?? ["bundleId": bundleId]
    }
}
