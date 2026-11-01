// Mouse and keyboard through CGEvent. Coordinates are global points
// (top-left origin of the main display), the space CGEvent uses; the MCP
// server converts screenshot pixels to points before calling.
//
// Every event we post carries `inputMarker` in eventSourceUserData, so the
// Esc watcher can tell our own Escape key from the user's.
import CoreGraphics
import Foundation

let inputMarker: Int64 = 0x5359_4E44_534B  // "SYNDSK"

enum MouseButton: String {
    case left, right, middle

    var cg: CGMouseButton {
        switch self {
        case .left: return .left
        case .right: return .right
        case .middle: return .center
        }
    }

    var downType: CGEventType {
        switch self {
        case .left: return .leftMouseDown
        case .right: return .rightMouseDown
        case .middle: return .otherMouseDown
        }
    }

    var upType: CGEventType {
        switch self {
        case .left: return .leftMouseUp
        case .right: return .rightMouseUp
        case .middle: return .otherMouseUp
        }
    }

    var dragType: CGEventType {
        switch self {
        case .left: return .leftMouseDragged
        case .right: return .rightMouseDragged
        case .middle: return .otherMouseDragged
        }
    }
}

enum Input {
    private static let source = CGEventSource(stateID: .hidSystemState)

    private static func post(_ e: CGEvent?) {
        guard let e else { return }
        e.setIntegerValueField(.eventSourceUserData, value: inputMarker)
        e.post(tap: .cghidEventTap)
    }

    private static func pause(_ ms: UInt32) { usleep(ms * 1000) }

    static func cursor() -> CGPoint {
        CGEvent(source: nil)?.location ?? .zero
    }

    static func move(to p: CGPoint) {
        post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
        pause(15)
    }

    static func click(at p: CGPoint, button: MouseButton, count: Int, flags: CGEventFlags) {
        move(to: p)
        for i in 1...max(1, count) {
            for type in [button.downType, button.upType] {
                let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: button.cg)
                e?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
                e?.flags = flags
                post(e)
                pause(10)
            }
            pause(30)
        }
    }

    static func button(_ down: Bool, at p: CGPoint, button: MouseButton) {
        let e = CGEvent(mouseEventSource: source, mouseType: down ? button.downType : button.upType, mouseCursorPosition: p, mouseButton: button.cg)
        e?.setIntegerValueField(.mouseEventClickState, value: 1)
        post(e)
        pause(15)
    }

    static func drag(from a: CGPoint, to b: CGPoint, button: MouseButton) {
        move(to: a)
        Input.button(true, at: a, button: button)
        let steps = 20
        for i in 1...steps {
            let t = CGFloat(i) / CGFloat(steps)
            let p = CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
            post(CGEvent(mouseEventSource: source, mouseType: button.dragType, mouseCursorPosition: p, mouseButton: button.cg))
            pause(10)
        }
        Input.button(false, at: b, button: button)
    }

    /// `dy` > 0 scrolls up, `dx` > 0 scrolls left (line units, like a wheel).
    static func scroll(at p: CGPoint, dx: Int32, dy: Int32) {
        move(to: p)
        post(CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0))
        pause(20)
    }

    static func key(_ combo: KeyCombo) {
        for down in [true, false] {
            let e = CGEvent(keyboardEventSource: source, virtualKey: combo.keyCode, keyDown: down)
            e?.flags = combo.flags
            post(e)
            pause(8)
        }
    }

    /// Types `text` one character at a time; stops early once `shouldContinue` is false (Esc).
    static func type(_ text: String, shouldContinue: () -> Bool) -> Int {
        var typed = 0
        for ch in text {
            if !shouldContinue() { break }
            if ch == "\n" || ch == "\r\n" {
                key(KeyCombo(keyCode: 36, flags: []))
            } else if ch == "\t" {
                key(KeyCombo(keyCode: 48, flags: []))
            } else {
                let units = Array(String(ch).utf16)
                for down in [true, false] {
                    let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
                    e?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                    post(e)
                }
                pause(8)
            }
            typed += 1
        }
        return typed
    }
}

struct KeyCombo {
    let keyCode: CGKeyCode
    let flags: CGEventFlags
}

/// `cmd+shift+a`, `Return`, `ctrl+c` (xdotool-style names too). A space
/// separates combos pressed one after another (`ctrl+a Delete`).
enum KeyParser {
    static let modifiers: [String: CGEventFlags] = [
        "cmd": .maskCommand, "command": .maskCommand, "super": .maskCommand, "meta": .maskCommand, "win": .maskCommand,
        "ctrl": .maskControl, "control": .maskControl,
        "alt": .maskAlternate, "option": .maskAlternate, "opt": .maskAlternate,
        "shift": .maskShift,
        "fn": .maskSecondaryFn,
    ]

    // ANSI (US) virtual key codes.
    static let keys: [String: CGKeyCode] = {
        var m: [String: CGKeyCode] = [
            "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
            "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
            "=": 24, "equal": 24, "9": 25, "7": 26, "-": 27, "minus": 27, "8": 28, "0": 29, "]": 30, "bracketright": 30,
            "o": 31, "u": 32, "[": 33, "bracketleft": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "apostrophe": 39,
            "k": 40, ";": 41, "semicolon": 41, "\\": 42, "backslash": 42, ",": 43, "comma": 43, "/": 44, "slash": 44,
            "n": 45, "m": 46, ".": 47, "period": 47, "`": 50, "grave": 50,
            "return": 36, "enter": 36, "kpenter": 76, "tab": 48, "space": 49, "backspace": 51, "delete": 51,
            "escape": 53, "esc": 53, "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "prior": 116,
            "pagedown": 121, "next": 121, "left": 123, "right": 124, "down": 125, "up": 126,
            "capslock": 57, "help": 114, "insert": 114,
            "volumeup": 72, "volumedown": 73, "mute": 74,
        ]
        let f: [CGKeyCode] = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111]
        for (i, code) in f.enumerated() { m["f\(i + 1)"] = code }
        return m
    }()

    static func parse(_ text: String) throws -> [KeyCombo] {
        let parts = text.split(whereSeparator: { $0 == " " }).map(String.init)
        guard !parts.isEmpty else { throw HelperError("bad-request", "key is empty") }
        return try parts.map(parseOne)
    }

    static func parseOne(_ combo: String) throws -> KeyCombo {
        // "+" alone, or "cmd++", means the plus key: not on ANSI without shift, refuse clearly.
        let tokens = combo.split(separator: "+", omittingEmptySubsequences: false).map(String.init)
        var flags: CGEventFlags = []
        var key: CGKeyCode?
        for (i, raw) in tokens.enumerated() {
            let name = raw.lowercased().replacingOccurrences(of: "_", with: "")
            if i < tokens.count - 1 {
                guard let m = modifiers[name] else { throw HelperError("bad-request", "unknown modifier \"\(raw)\" in \"\(combo)\"") }
                flags.insert(m)
            } else if let k = keys[name] {
                key = k
            } else if let m = modifiers[name] {
                // A modifier pressed on its own.
                flags.insert(m)
                key = modifierKeyCode(name)
            } else {
                throw HelperError("bad-request", "unknown key \"\(raw)\" in \"\(combo)\"")
            }
        }
        guard let key else { throw HelperError("bad-request", "no key in \"\(combo)\"") }
        return KeyCombo(keyCode: key, flags: flags)
    }

    private static func modifierKeyCode(_ name: String) -> CGKeyCode {
        switch modifiers[name] {
        case .some(.maskCommand): return 55
        case .some(.maskControl): return 59
        case .some(.maskAlternate): return 58
        case .some(.maskShift): return 56
        default: return 63
        }
    }
}
