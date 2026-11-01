// Accessibility: read an allowed app's window as a tree of elements, and act
// on an element by its ref, without activating the app or touching the
// cursor (syn-7).
//
// Refs (`e12`) name AXUIElements the helper has handed out in this session.
// The same element gets the same ref every time it is read again (AXUIElement
// is CFEqual across reads), so a ref from one ax_tree survives the next one;
// an element the app has destroyed answers `stale-ref`. The table is dropped
// when the session changes.
//
// The window element for a CGWindowID: `_AXUIElementGetWindow` (private, as
// used by yabai / Hammerspoon / AltTab) on the app's AXWindows. On another
// Space AXWindows may leave the window out; then the app's elements are
// enumerated through `_AXUIElementCreateWithRemoteToken` (the same trick as
// AltTab), bounded in time.
import AppKit
import ApplicationServices

@_silgen_name("_AXUIElementGetWindow")
private func _AXUIElementGetWindow(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

@_silgen_name("_AXUIElementCreateWithRemoteToken")
private func _AXUIElementCreateWithRemoteToken(_ token: CFData) -> Unmanaged<AXUIElement>?

enum AX {
    // MARK: - refs

    private struct Key: Hashable {
        let e: AXUIElement
        static func == (a: Key, b: Key) -> Bool { CFEqual(a.e, b.e) }
        func hash(into h: inout Hasher) { h.combine(CFHash(e)) }
    }

    private static var refs: [String: AXUIElement] = [:]
    private static var byKey: [Key: String] = [:]
    private static var next = 1
    private static var owner: String?
    private static var windowCache: [CGWindowID: AXUIElement] = [:]
    private static let maxRefs = 20_000

    private static func use(session: String) {
        if owner != session || refs.count > maxRefs {
            refs = [:]
            byKey = [:]
            next = 1
            owner = session
            windowCache = [:]
        }
    }

    static func ref(for e: AXUIElement, session: String) -> String {
        use(session: session)
        if let r = byKey[Key(e: e)] { return r }
        let r = "e\(next)"
        next += 1
        refs[r] = e
        byKey[Key(e: e)] = r
        return r
    }

    static func element(_ ref: String, session: String) throws -> AXUIElement {
        use(session: session)
        guard let e = refs[ref] else {
            throw HelperError("stale-ref", "Unknown element ref \(ref). Call ax_tree again and use a ref from it.")
        }
        return e
    }

    static func pid(of e: AXUIElement) -> pid_t? {
        var pid: pid_t = 0
        return AXUIElementGetPid(e, &pid) == .success ? pid : nil
    }

    static func setTimeouts() {
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 1.5)
    }

    // MARK: - attributes

    static func attr(_ e: AXUIElement, _ name: String) -> AnyObject? {
        var v: CFTypeRef?
        return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
    }

    static func windowID(_ e: AXUIElement) -> CGWindowID? {
        var id: CGWindowID = 0
        return _AXUIElementGetWindow(e, &id) == .success && id != 0 ? id : nil
    }

    private static func point(_ v: AnyObject?) -> CGPoint? {
        guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var p = CGPoint.zero
        return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
    }

    private static func size(_ v: AnyObject?) -> CGSize? {
        guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var s = CGSize.zero
        return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
    }

    static func frame(_ e: AXUIElement) -> CGRect? {
        guard let p = point(attr(e, kAXPositionAttribute)), let s = size(attr(e, kAXSizeAttribute)) else { return nil }
        return CGRect(origin: p, size: s)
    }

    /// A value the model can read: strings (cut at 500), numbers, booleans. Nothing else.
    static func plain(_ v: AnyObject?) -> Any? {
        guard let v else { return nil }
        let t = CFGetTypeID(v)
        if t == CFStringGetTypeID() {
            let s = v as! String
            return s.count > 500 ? String(s.prefix(500)) + "…" : s
        }
        if t == CFBooleanGetTypeID() { return (v as! NSNumber).boolValue }
        if t == CFNumberGetTypeID() { return (v as! NSNumber).doubleValue }
        if let a = v as? NSAttributedString { return plain(a.string as AnyObject) }
        if let u = v as? URL { return u.absoluteString }
        return nil
    }

    // MARK: - windows

    /// The app's windows AX can see: id → minimized / title.
    static func windowStates(pid: pid_t) -> [CGWindowID: (minimized: Bool, title: String?)] {
        guard AXIsProcessTrusted() else { return [:] }
        let app = AXUIElementCreateApplication(pid)
        var out: [CGWindowID: (Bool, String?)] = [:]
        for w in (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? [] {
            guard let id = windowID(w) else { continue }
            out[id] = ((attr(w, kAXMinimizedAttribute) as? Bool) ?? false, attr(w, kAXTitleAttribute) as? String)
            windowCache[id] = w
        }
        return out
    }

    /// The AXWindow of `pid` whose CGWindowID is `id`.
    static func window(pid: pid_t, id: CGWindowID) -> AXUIElement? {
        if let w = windowCache[id], windowID(w) == id { return w }
        let app = AXUIElementCreateApplication(pid)
        var candidates = (attr(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
        for a in [kAXMainWindowAttribute, kAXFocusedWindowAttribute] {
            if let w = attr(app, a), CFGetTypeID(w) == AXUIElementGetTypeID() { candidates.append(w as! AXUIElement) }
        }
        for w in candidates where windowID(w) == id {
            windowCache[id] = w
            return w
        }
        // Not in AXWindows (another Space): walk the app's element ids.
        var token = Data(count: 20)
        token.withUnsafeMutableBytes { b in
            b.storeBytes(of: pid, toByteOffset: 0, as: pid_t.self)
            b.storeBytes(of: Int32(0), toByteOffset: 4, as: Int32.self)
            b.storeBytes(of: Int32(0x636f_636f), toByteOffset: 8, as: Int32.self)
        }
        let deadline = Date().addingTimeInterval(2)
        for n in UInt64(0)..<5000 {
            if n % 64 == 0 && Date() > deadline { break }
            token.withUnsafeMutableBytes { $0.storeBytes(of: n, toByteOffset: 12, as: UInt64.self) }
            guard let e = _AXUIElementCreateWithRemoteToken(token as CFData)?.takeRetainedValue() else { continue }
            guard (attr(e, kAXRoleAttribute) as? String) == kAXWindowRole else { continue }
            if let wid = windowID(e) {
                windowCache[wid] = e
                if wid == id { return e }
            }
        }
        return nil
    }

    // MARK: - the tree

    struct TreeOptions {
        var maxDepth = 25
        var maxNodes = 400
        var all = false
    }

    /// Roles worth showing even with no text: the model may want to act on them.
    private static let interactive: Set<String> = [
        "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXComboBox", "AXTextField",
        "AXTextArea", "AXSearchField", "AXSlider", "AXIncrementor", "AXStepper", "AXMenuItem", "AXMenuBarItem", "AXLink",
        "AXTab", "AXDisclosureTriangle", "AXCell", "AXRow", "AXColorWell", "AXDateField", "AXSegmentedControl", "AXSwitch",
        "AXToolbar", "AXTabGroup", "AXTable", "AXOutline", "AXList", "AXWebArea", "AXSheet", "AXDialog",
    ]

    private static let names: [String] = [
        kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute,
        kAXEnabledAttribute, kAXFocusedAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXIdentifierAttribute,
        kAXHelpAttribute, kAXChildrenAttribute, kAXSelectedAttribute,
    ]

    /// Depth-first; `depth` counts shown nodes only (containers with nothing to say are skipped unless `all`).
    static func tree(_ root: AXUIElement, session: String, options o: TreeOptions) -> (nodes: [JSON], truncated: Bool) {
        var nodes: [JSON] = []
        var visited = 0
        var truncated = false
        let visitCap = max(o.maxNodes * 8, 2000)
        func walk(_ e: AXUIElement, _ depth: Int, _ shownDepth: Int) {
            if nodes.count >= o.maxNodes || visited >= visitCap { truncated = true; return }
            visited += 1
            var values: CFArray?
            guard AXUIElementCopyMultipleAttributeValues(e, names as CFArray, [], &values) == .success,
                  let arr = values as? [AnyObject], arr.count == names.count else { return }
            func v(_ i: Int) -> AnyObject? {
                let x = arr[i]
                if CFGetTypeID(x) == AXValueGetTypeID() && AXValueGetType(x as! AXValue) == .axError { return nil }
                return x
            }
            let role = (v(0) as? String) ?? "AXUnknown"
            let subrole = v(1) as? String
            let secure = subrole == "AXSecureTextField"
            var node: JSON = ["role": role, "depth": shownDepth]
            if let s = subrole { node["subrole"] = s }
            var said = false
            for (i, key) in [(2, "title"), (3, "description"), (9, "identifier"), (10, "help")] {
                if let s = plain(v(i)) as? String, !s.isEmpty { node[key] = s; if key != "identifier" { said = true } }
            }
            if !secure, let val = plain(v(4)) {
                if let s = val as? String { if !s.isEmpty { node["value"] = s; said = true } } else { node["value"] = val; said = true }
            }
            if let en = v(5) as? Bool, !en { node["enabled"] = false }
            if let f = v(6) as? Bool, f { node["focused"] = true }
            if let sel = v(12) as? Bool, sel { node["selected"] = true }
            if let p = point(v(7)), let s = size(v(8)) {
                node["x"] = Double(p.x); node["y"] = Double(p.y); node["width"] = Double(s.width); node["height"] = Double(s.height)
            }
            var actions: CFArray?
            if AXUIElementCopyActionNames(e, &actions) == .success, let a = actions as? [String], !a.isEmpty {
                // Custom actions ("Name:…\nTarget:…") are left out: they cannot be named back reliably.
                let useful = a.filter { $0.hasPrefix("AX") && $0 != "AXScrollToVisible" && $0 != "AXShowDefaultUI" && $0 != "AXShowAlternateUI" }
                if !useful.isEmpty { node["actions"] = useful }
                if useful.contains(where: { $0 != kAXShowMenuAction }) { said = true }
            }
            let show = o.all || depth == 0 || said || interactive.contains(role)
            if show {
                node["ref"] = ref(for: e, session: session)
                nodes.append(node)
            }
            guard depth < o.maxDepth, let kids = v(11) as? [AXUIElement] else {
                if depth >= o.maxDepth, let kids = v(11) as? [AXUIElement], !kids.isEmpty { truncated = true }
                return
            }
            for k in kids { walk(k, depth + 1, show ? shownDepth + 1 : shownDepth) }
        }
        walk(root, 0, 0)
        return (nodes, truncated)
    }

    // MARK: - actions

    static func fail(_ err: AXError, _ what: String) -> HelperError {
        switch err {
        case .invalidUIElement:
            return HelperError("stale-ref", "The element is gone (\(what)). Call ax_tree again.")
        case .actionUnsupported, .attributeUnsupported, .illegalArgument:
            return HelperError("bad-request", "The element does not support \(what).")
        case .apiDisabled:
            return HelperError("permission", "Accessibility is not granted to the desktop helper.", extra: ["permission": "accessibility"])
        case .cannotComplete:
            return HelperError("ax-failed", "The app did not answer \(what) in time (it may be busy).", extra: ["code": Int(err.rawValue)])
        default:
            return HelperError("ax-failed", "\(what) failed (AXError \(err.rawValue)).", extra: ["code": Int(err.rawValue)])
        }
    }

    static func perform(_ e: AXUIElement, _ action: String) throws {
        let err = AXUIElementPerformAction(e, action as CFString)
        if err != .success { throw fail(err, action) }
    }

    static func setValue(_ e: AXUIElement, _ value: Any) throws {
        var settable: DarwinBoolean = false
        let s = AXUIElementIsAttributeSettable(e, kAXValueAttribute as CFString, &settable)
        if s != .success { throw fail(s, "setting AXValue") }
        guard settable.boolValue else { throw HelperError("bad-request", "The element's value cannot be set.") }
        let current = attr(e, kAXValueAttribute)
        var new: CFTypeRef
        if let current, CFGetTypeID(current) == CFNumberGetTypeID() || CFGetTypeID(current) == CFBooleanGetTypeID() {
            if let n = value as? NSNumber { new = n }
            else if let str = value as? String, let d = Double(str) { new = NSNumber(value: d) }
            else { throw HelperError("bad-request", "This element takes a number.") }
        } else if let str = value as? String {
            new = str as CFString
        } else if let n = value as? NSNumber {
            new = n.stringValue as CFString
        } else {
            throw HelperError("bad-request", "value must be a string or a number.")
        }
        let err = AXUIElementSetAttributeValue(e, kAXValueAttribute as CFString, new)
        if err != .success { throw fail(err, "setting AXValue") }
    }

    // MARK: - a click in the background

    private static func actions(_ e: AXUIElement) -> [String] {
        var a: CFArray?
        return AXUIElementCopyActionNames(e, &a) == .success ? (a as? [String]) ?? [] : []
    }

    private static func parent(_ e: AXUIElement) -> AXUIElement? {
        guard let p = attr(e, kAXParentAttribute), CFGetTypeID(p) == AXUIElementGetTypeID() else { return nil }
        return (p as! AXUIElement)
    }

    /// The deepest element of `root` whose frame holds `p` (later siblings first: they are drawn on top).
    private static func deepest(_ root: AXUIElement, _ p: CGPoint) -> AXUIElement? {
        var visits = 0
        func walk(_ e: AXUIElement) -> AXUIElement? {
            visits += 1
            if visits > 3000 { return nil }
            for k in ((attr(e, kAXChildrenAttribute) as? [AXUIElement]) ?? []).reversed() {
                guard let f = frame(k), f.contains(p) else { continue }
                return walk(k) ?? k
            }
            return nil
        }
        return walk(root)
    }

    private static let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"]

    /// A plain left click at `p` in the window `id` of `pid`, done through AX: the element under the
    /// point (or its nearest ancestor below the window) is pressed, or focused when it is a text field.
    /// Nil when nothing there takes AXPress / focus: then the caller posts the click to the process.
    /// AppKit drops a mouse click posted to an inactive app's window (measured on macOS 26 with
    /// Calculator on another Space), while AX works whatever the window's Space.
    static func clickThroughAX(pid: pid_t, window id: CGWindowID, at p: CGPoint) -> (via: String, element: JSON)? {
        guard AXIsProcessTrusted() else { return nil }
        setTimeouts()
        var hit: AXUIElement?
        var el: AXUIElement?
        if AXUIElementCopyElementAtPosition(AXUIElementCreateApplication(pid), Float(p.x), Float(p.y), &el) == .success, let el,
           self.pid(of: el) == pid, frame(el)?.contains(p) == true,
           let w = attr(el, kAXWindowAttribute), CFGetTypeID(w) == AXUIElementGetTypeID(), windowID(w as! AXUIElement) == id {
            hit = el
        }
        if hit == nil, let w = window(pid: pid, id: id) { hit = deepest(w, p) }
        var cur = hit
        var level = 0
        while let e = cur, level < 5 {
            let role = attr(e, kAXRoleAttribute) as? String
            if role == kAXWindowRole { break }
            if actions(e).contains(kAXPressAction) {
                if AXUIElementPerformAction(e, kAXPressAction as CFString) == .success { return ("ax-press", describe(e)) }
                return nil
            }
            if let role, textRoles.contains(role) {
                var settable: DarwinBoolean = false
                if AXUIElementIsAttributeSettable(e, kAXFocusedAttribute as CFString, &settable) == .success, settable.boolValue,
                   AXUIElementSetAttributeValue(e, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success {
                    return ("ax-focus", describe(e))
                }
            }
            cur = parent(e)
            level += 1
        }
        return nil
    }

    static func describe(_ e: AXUIElement) -> JSON {
        var o: JSON = ["role": (attr(e, kAXRoleAttribute) as? String) ?? NSNull()]
        if let t = plain(attr(e, kAXTitleAttribute)) as? String, !t.isEmpty { o["title"] = t }
        if let d = plain(attr(e, kAXDescriptionAttribute)) as? String, !d.isEmpty { o["description"] = d }
        if (attr(e, kAXSubroleAttribute) as? String) != "AXSecureTextField", let v = plain(attr(e, kAXValueAttribute)) { o["value"] = v }
        return o
    }
}
