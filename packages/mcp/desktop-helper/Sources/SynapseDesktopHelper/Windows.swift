// The allowed apps' windows, one by one, wherever they are (syn-7).
//
// `SCShareableContent` with `onScreenWindowsOnly: false` lists every window,
// and `SCContentFilter(desktopIndependentWindow:)` captures one window by
// itself: the window server renders it off screen, so it comes out whole
// when it is covered by other windows, on another Space (behind a full-screen
// app) or on the other display, and nobody's screen changes. Measured on
// macOS 26 (2026-11-01):
//
// | the window is …                         | capture |
// |-----------------------------------------|---------|
// | covered by other windows                | yes |
// | on another Space (behind a full-screen app) | yes |
// | on the other display (any scale)        | yes (that display's backing scale) |
// | minimized (in the Dock)                 | no: SCStreamErrorDomain -3811 → `minimized` |
// | hidden (cmd+H)                          | treated like minimized: refused up front |
//
// The geometry of a window image is the window's frame in global points:
// pixel (x, y) is the point (frame.x + x * frame.w / width, …), the same
// shape as a screen capture's, so the MCP server converts both alike.
import AppKit
import CoreGraphics
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

enum Windows {
    struct Info {
        let id: CGWindowID
        let pid: pid_t
        let bundleId: String
        let appName: String
        let title: String
        let frame: CGRect  // global points
        let onScreen: Bool
        let layer: Int
        let minimized: Bool
        let hidden: Bool
        let scWindow: SCWindow?

        func json(displays: [CGDirectDisplayID: CGRect]) -> JSON {
            var o: JSON = [
                "id": Int(id), "pid": Int(pid), "bundleId": bundleId, "app": appName, "title": title,
                "x": Double(frame.minX), "y": Double(frame.minY), "width": Double(frame.width), "height": Double(frame.height),
                "onScreen": onScreen, "minimized": minimized, "hidden": hidden,
                "capturable": !minimized && !hidden,
            ]
            if let d = Windows.display(of: frame, in: displays) { o["display"] = Int(d.id); o["mainDisplay"] = d.id == CGMainDisplayID() }
            return o
        }
    }

    static func activeDisplays() -> [CGDirectDisplayID: CGRect] {
        var n: UInt32 = 0
        var ids = [CGDirectDisplayID](repeating: 0, count: 16)
        CGGetActiveDisplayList(16, &ids, &n)
        var out: [CGDirectDisplayID: CGRect] = [:]
        for i in 0..<Int(n) { out[ids[i]] = CGDisplayBounds(ids[i]) }
        return out
    }

    /// The display with the largest share of `frame`.
    static func display(of frame: CGRect, in displays: [CGDirectDisplayID: CGRect]) -> (id: CGDirectDisplayID, bounds: CGRect)? {
        var best: (CGDirectDisplayID, CGRect, CGFloat)?
        for (id, b) in displays {
            let i = b.intersection(frame)
            let area = i.isNull ? 0 : i.width * i.height
            if best == nil || area > best!.2 { best = (id, b, area) }
        }
        return best.map { ($0.0, $0.1) }
    }

    /// Every real window of the apps in `bundleIds` (or of the running app `pid`), front to back as the window server lists them.
    /// Leaves out the per-display menu-bar strips an app owns, tool tips and the like (< 50 points, untitled).
    static func list(bundleIds: Set<String>) throws -> [Info] {
        let content = try blocking { try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false) }
        var axState: [pid_t: [CGWindowID: (minimized: Bool, title: String?)]] = [:]
        var out: [Info] = []
        for w in content.windows {
            guard let app = w.owningApplication, bundleIds.contains(app.bundleIdentifier) else { continue }
            let pid = app.processID
            if axState[pid] == nil { axState[pid] = AX.windowStates(pid: pid) }
            let ax = axState[pid]?[w.windowID]
            let title = w.title ?? ax?.title ?? ""
            if ax == nil {
                guard w.windowLayer == 0, w.frame.width >= 50, w.frame.height >= 50 || !title.isEmpty else { continue }
                if title.isEmpty && w.frame.height < 60 { continue }
            }
            let running = NSRunningApplication(processIdentifier: pid)
            let hidden = running?.isHidden ?? false
            out.append(Info(id: w.windowID, pid: pid, bundleId: app.bundleIdentifier, appName: app.applicationName,
                            title: title, frame: w.frame, onScreen: w.isOnScreen, layer: w.windowLayer,
                            minimized: ax?.minimized ?? false, hidden: hidden, scWindow: w))
        }
        return out
    }

    /// The window with its SCWindow, for a capture. ScreenCaptureKit's list sometimes misses a
    /// window for a moment right after the app redraws, so it is asked up to three times.
    static func find(_ id: CGWindowID, bundleIds: Set<String>) throws -> Info? {
        for attempt in 0..<3 {
            if let w = try list(bundleIds: bundleIds).first(where: { $0.id == id }) { return w }
            if attempt < 2 { usleep(150_000) }
        }
        return nil
    }

    /// The window from the window server alone (no ScreenCaptureKit): enough for AX and input.
    static func lookup(_ id: CGWindowID, bundleIds: Set<String>) -> Info? {
        guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]],
              let w = list.first, (w[kCGWindowNumber as String] as? Int).map({ CGWindowID($0) }) == id,
              let pid = w[kCGWindowOwnerPID as String] as? Int32,
              let b = w[kCGWindowBounds as String] as? NSDictionary, let frame = CGRect(dictionaryRepresentation: b),
              let app = NSRunningApplication(processIdentifier: pid), let bid = app.bundleIdentifier, bundleIds.contains(bid) else {
            return nil
        }
        let ax = AX.windowStates(pid: pid)[id]
        return Info(id: id, pid: pid, bundleId: bid, appName: app.localizedName ?? bid,
                    title: (w[kCGWindowName as String] as? String) ?? ax?.title ?? "", frame: frame,
                    onScreen: (w[kCGWindowIsOnscreen as String] as? Bool) ?? false, layer: (w[kCGWindowLayer as String] as? Int) ?? 0,
                    minimized: ax?.minimized ?? false, hidden: app.isHidden, scWindow: nil)
    }

    /// The size a capture of `pointSize` at `backing` comes out at, fitted inside max.
    static func fit(_ pointSize: CGSize, backing: Double, maxWidth: Int, maxHeight: Int) -> (width: Int, height: Int) {
        let nativeW = Double(pointSize.width) * backing
        let nativeH = Double(pointSize.height) * backing
        let f = min(1.0, Double(max(maxWidth, 1)) / max(nativeW, 1), Double(max(maxHeight, 1)) / max(nativeH, 1))
        return (max(1, Int((nativeW * f).rounded())), max(1, Int((nativeH * f).rounded())))
    }

    /// The backing scale of the display that holds most of `frame`.
    static func backingScale(of frame: CGRect) -> Double {
        let displays = activeDisplays()
        guard let d = display(of: frame, in: displays) else { return 2 }
        if let mode = CGDisplayCopyDisplayMode(d.id), mode.width > 0 {
            return Double(mode.pixelWidth) / Double(mode.width)
        }
        return 2
    }

    /// Where a window image lies, as `screenshot` returns it, without capturing (for the AX tree).
    static func geometry(frame: CGRect, maxWidth: Int, maxHeight: Int) -> JSON {
        let backing = backingScale(of: frame)
        let size = fit(frame.size, backing: backing, maxWidth: maxWidth, maxHeight: maxHeight)
        return [
            "width": size.width, "height": size.height,
            "originX": Double(frame.minX), "originY": Double(frame.minY),
            "pointWidth": Double(frame.width), "pointHeight": Double(frame.height),
            "backingScale": backing,
        ]
    }

    static func capture(_ w: Info, options o: Capture.Options) throws -> JSON {
        guard CGPreflightScreenCaptureAccess() else {
            throw HelperError("permission", "Screen Recording is not granted to the desktop helper.", extra: ["permission": "screenRecording"])
        }
        if w.minimized || w.hidden {
            throw HelperError(
                w.minimized ? "minimized" : "hidden",
                "The window \(w.id) of \(w.appName) is \(w.minimized ? "minimized" : "hidden"): macOS cannot capture it in the background. Ask the user to restore it, or use the AX tools (ax_tree) which do not need the image.",
                extra: ["window": w.json(displays: activeDisplays())])
        }
        guard let sc = w.scWindow else { throw HelperError("no-window", "The window \(w.id) is gone.") }
        let filter = SCContentFilter(desktopIndependentWindow: sc)
        let backing = Double(filter.pointPixelScale)
        var src = CGRect(origin: .zero, size: w.frame.size)  // window-local points
        if let r = o.region {
            src = r.offsetBy(dx: -w.frame.minX, dy: -w.frame.minY).intersection(src)
            if src.isNull || src.width < 1 || src.height < 1 { throw HelperError("bad-request", "The region is outside the window.") }
        }
        let size = fit(src.size, backing: backing, maxWidth: o.maxWidth, maxHeight: o.maxHeight)
        let config = SCStreamConfiguration()
        config.width = size.width
        config.height = size.height
        if o.region != nil { config.sourceRect = src }
        config.showsCursor = false
        config.capturesAudio = false
        config.ignoreShadowsSingleWindow = true
        let image: CGImage
        do {
            image = try blocking { try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) }
        } catch let e as NSError where e.domain == SCStreamErrorDomain {
            throw HelperError("capture-failed", "ScreenCaptureKit could not capture the window \(w.id) (\(e.domain) \(e.code)); it may have been minimized or closed. Call list_windows and try again.", extra: ["code": e.code])
        }
        var out = try Capture.encode(image, options: o)
        out["originX"] = Double(w.frame.minX + src.minX)
        out["originY"] = Double(w.frame.minY + src.minY)
        out["pointWidth"] = Double(src.width)
        out["pointHeight"] = Double(src.height)
        out["backingScale"] = backing
        out["apps"] = [w.bundleId]
        out["window"] = w.json(displays: activeDisplays())
        return out
    }

    /// After activating an app: waits (up to `timeout`) until one of its windows is on screen, as a Space switch takes a moment.
    static func waitOnScreen(pid: pid_t, timeout: TimeInterval) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        repeat {
            if let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] {
                let hit = list.contains { w in
                    guard (w[kCGWindowOwnerPID as String] as? Int32) == pid, (w[kCGWindowLayer as String] as? Int) == 0,
                          let b = w[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b) else { return false }
                    return r.width >= 50 && r.height >= 60
                }
                if hit { return true }
            }
            usleep(100_000)
        } while Date() < end
        return false
    }
}
