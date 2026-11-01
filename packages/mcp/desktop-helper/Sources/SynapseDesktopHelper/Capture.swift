// Screenshots through ScreenCaptureKit, filtered to the allowed apps.
//
// The filter is `SCContentFilter(display:including:)` with only the allowed
// applications: every other window (and the wallpaper, the Dock, the menu
// bar) is left out of the image by the window server, not blacked out
// afterwards. The main display only (phase 1).
//
// When none of the allowed apps has a window on screen there (another Space,
// minimized, hidden, another display), the window server fails the capture
// with SCStreamErrorDomain -3811 instead of returning an empty image, so that
// case is refused up front as `no-window` (syn-6).
import AppKit
import CoreGraphics
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

private final class ResultBox<T>: @unchecked Sendable {
    var result: Result<T, Error>?
}

/// Runs an async call from a plain thread and waits for it.
func blocking<T>(_ op: @escaping () async throws -> T) throws -> T {
    let box = ResultBox<T>()
    let sem = DispatchSemaphore(value: 0)
    Task.detached {
        do { box.result = .success(try await op()) } catch { box.result = .failure(error) }
        sem.signal()
    }
    sem.wait()
    return try box.result!.get()
}

enum Capture {
    struct Options {
        var region: CGRect?  // global points; nil = the whole main display
        var maxWidth: Int = 1456
        var maxHeight: Int = 1456
        var format: String = "png"  // png | jpeg
        var quality: Double = 0.8
    }

    static func screenshot(apps: Set<String>, options o: Options) throws -> JSON {
        guard CGPreflightScreenCaptureAccess() else {
            throw HelperError("permission", "Screen Recording is not granted to the desktop helper.", extra: ["permission": "screenRecording"])
        }
        let content = try blocking { try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) }
        let mainID = CGMainDisplayID()
        guard let display = content.displays.first(where: { $0.displayID == mainID }) ?? content.displays.first else {
            throw HelperError("no-display", "No display to capture.")
        }
        let included = content.applications.filter { apps.contains($0.bundleIdentifier) }

        let bounds = CGDisplayBounds(display.displayID)  // global points
        var src = CGRect(origin: .zero, size: bounds.size)  // display-local points
        if let r = o.region {
            src = r.offsetBy(dx: -bounds.minX, dy: -bounds.minY).intersection(src)
            if src.isNull || src.width < 1 || src.height < 1 {
                throw HelperError("bad-request", "The region is outside the display.")
            }
        }
        // SCWindow.frame is in global points, like CGDisplayBounds.
        let visible = content.windows.filter { w in
            guard let bid = w.owningApplication?.bundleIdentifier, apps.contains(bid), w.isOnScreen else { return false }
            return w.frame.intersects(bounds)
        }
        if visible.isEmpty {
            throw HelperError(
                "no-window",
                "None of the allowed apps (\(apps.sorted().joined(separator: ", "))) has a window on the main display right now: it may be on another Space, minimized, hidden or on another display. Bring it to the front (e.g. open_application) and take the screenshot again.",
                extra: ["apps": apps.sorted()])
        }
        let filter = SCContentFilter(display: display, including: included, exceptingWindows: [])
        let backing = Double(filter.pointPixelScale)
        let nativeW = Double(src.width) * backing
        let nativeH = Double(src.height) * backing
        let fit = min(1.0, Double(max(o.maxWidth, 1)) / nativeW, Double(max(o.maxHeight, 1)) / nativeH)
        let width = max(1, Int((nativeW * fit).rounded()))
        let height = max(1, Int((nativeH * fit).rounded()))

        let config = SCStreamConfiguration()
        config.width = width
        config.height = height
        config.sourceRect = src
        config.showsCursor = false
        config.capturesAudio = false
        let image: CGImage
        do {
            image = try blocking { try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) }
        } catch let e as NSError where e.domain == SCStreamErrorDomain {
            // Not `internal`: the window can vanish between the check above and
            // the capture (Space switch, minimize), which is worth a retry.
            throw HelperError("capture-failed", "ScreenCaptureKit could not take the screenshot (\(e.domain) \(e.code)). Make sure an allowed app's window is on screen on the main display and try again.", extra: ["code": e.code])
        }

        let jpeg = o.format == "jpeg"
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, (jpeg ? UTType.jpeg : UTType.png).identifier as CFString, 1, nil) else {
            throw HelperError("encode", "Cannot create the image encoder.")
        }
        let props: [CFString: Any] = jpeg ? [kCGImageDestinationLossyCompressionQuality: o.quality] : [:]
        CGImageDestinationAddImage(dest, image, props as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { throw HelperError("encode", "Cannot encode the image.") }

        return [
            "data": (data as Data).base64EncodedString(),
            "mimeType": jpeg ? "image/jpeg" : "image/png",
            "width": image.width,
            "height": image.height,
            // The captured rectangle in global points: pixel (x, y) is the
            // point (originX + x * pointWidth / width, originY + y * pointHeight / height).
            "originX": Double(bounds.minX + src.minX),
            "originY": Double(bounds.minY + src.minY),
            "pointWidth": Double(src.width),
            "pointHeight": Double(src.height),
            "backingScale": backing,
            "apps": included.map { $0.bundleIdentifier },
        ]
    }
}
