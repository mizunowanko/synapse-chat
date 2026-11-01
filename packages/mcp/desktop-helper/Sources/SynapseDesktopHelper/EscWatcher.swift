// The global Esc: a listen-only CGEventTap on key-down. The user's Escape
// reaches the app as usual and also aborts the session; our own Escape (an
// event carrying `inputMarker`) does not abort.
//
// A keyboard event tap needs Accessibility (or Input Monitoring). Without it
// `install()` fails, and is retried at the next `beginSession` / status.
import CoreGraphics
import Foundation

final class EscWatcher {
    static let shared = EscWatcher()

    var onEscape: (() -> Void)?
    private var tap: CFMachPort?

    var installed: Bool { tap != nil }

    /// Must run on the main thread (the tap's run loop source goes on the main run loop).
    @discardableResult
    func install() -> Bool {
        if tap != nil { return true }
        let mask = CGEventMask(1 << CGEventType.keyDown.rawValue)
        let callback: CGEventTapCallBack = { _, type, event, _ in
            let w = EscWatcher.shared
            if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                if let t = w.tap { CGEvent.tapEnable(tap: t, enable: true) }
                return Unmanaged.passUnretained(event)
            }
            if type == .keyDown,
               event.getIntegerValueField(.keyboardEventKeycode) == 53,
               event.getIntegerValueField(.eventSourceUserData) != inputMarker {
                DispatchQueue.main.async { w.onEscape?() }
            }
            return Unmanaged.passUnretained(event)
        }
        guard let t = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                                        eventsOfInterest: mask, callback: callback, userInfo: nil) else {
            return false
        }
        let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, t, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), src, .commonModes)
        CGEvent.tapEnable(tap: t, enable: true)
        tap = t
        return true
    }
}
