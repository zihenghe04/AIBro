import Foundation

/// Whitelist for the unified Settings page's native channel (`native-settings`).
/// The web side only ever names a stable setting id; this table decides which ids
/// exist, what type they take and whether they may be written. Credentials and
/// anything not listed here never cross this channel.
enum NativeSettingsRegistry {
    /// `shortcut` carries "modifiers:keyCode" (Carbon values); native validation stays final.
    /// `action` takes the single string "run". `retention` carries "days:itemLimit" (days 0 = no age limit).
    enum Kind: Equatable { case bool, choice([String]), number(ClosedRange<Double>), shortcut, action, retention }
    struct Item: Equatable { let id: String; let kind: Kind; let writable: Bool }
    enum Value: Equatable { case bool(Bool), string(String), number(Double) }
    enum Request: Equatable { case state, set(id: String, value: Value) }
    enum Rejection: String, Error, Equatable { case invalidRequest = "invalid_request", settingsNotVisible = "settings_not_visible" }

    static let sizes = ["mini", "small", "medium", "large"]
    static let permStates = ["granted", "denied", "notDetermined", "unknown"]
    static let items: [Item] = [
        Item(id: "login.enabled", kind: .bool, writable: true),
        Item(id: "login.background", kind: .bool, writable: true),
        Item(id: "quickEntry.enabled", kind: .bool, writable: true),
        Item(id: "quickEntry.mode", kind: .choice(["island", "edge", "menuBar", "off"]), writable: true),
        Item(id: "quickEntry.shortcut", kind: .shortcut, writable: true),
        Item(id: "quickPanel.default", kind: .choice(["home", "tasks", "agenda", "capture", "links", "recordings", "voice", "vault", "clipboard", "shelf", "runs", "settings"]), writable: true),
        Item(id: "quickPanel.reset", kind: .action, writable: true),
        Item(id: "clipboard.retention.preview", kind: .retention, writable: true),
        Item(id: "clipboard.retention.apply", kind: .action, writable: true),
        Item(id: "clipboard.retention.cancel", kind: .action, writable: true),
        Item(id: "dictate.enabled", kind: .bool, writable: true),
        Item(id: "dictate.trigger", kind: .choice(["rightOption", "rightCommand", "combo"]), writable: true),
        Item(id: "dictate.combo", kind: .shortcut, writable: true),
        Item(id: "dictate.access", kind: .bool, writable: false),
        Item(id: "speech.shortcut", kind: .shortcut, writable: true),
        Item(id: "speech.mode", kind: .choice(["hold", "toggle"]), writable: true),
        Item(id: "speech.autoSubmit", kind: .bool, writable: true),
        Item(id: "speech.silence", kind: .number(0...10), writable: true),
        Item(id: "agenda.notifications", kind: .bool, writable: true),
        Item(id: "agenda.taskReminder", kind: .choice(["off", "0", "15", "60", "1440"]), writable: true),
        Item(id: "agenda.briefing", kind: .bool, writable: true),
        Item(id: "agenda.briefingHour", kind: .number(0...23), writable: true),
        Item(id: "agenda.briefingMinute", kind: .number(0...59), writable: true),
        Item(id: "agenda.showTitles", kind: .bool, writable: true),
        Item(id: "agenda.test", kind: .action, writable: true),
        Item(id: "notify.sounds", kind: .bool, writable: true),
        Item(id: "notify.external", kind: .bool, writable: true),
        Item(id: "notify.island", kind: .bool, writable: true),
        Item(id: "notify.history.clear", kind: .action, writable: true),
        // System permission status (read only; never prompts). `perm.open.<pane>` opens System Settings.
        Item(id: "perm.accessibility", kind: .choice(permStates), writable: false),
        Item(id: "perm.inputMonitoring", kind: .choice(permStates), writable: false),
        Item(id: "perm.microphone", kind: .choice(permStates), writable: false),
        Item(id: "perm.camera", kind: .choice(permStates), writable: false),
        Item(id: "perm.notifications", kind: .choice(permStates), writable: false),
        Item(id: "perm.loginItem", kind: .choice(["enabled", "notRegistered", "requiresApproval", "notFound", "unknown"]), writable: false),
    ]
    /// Id families keyed by a short suffix (a panel section or home widget id).
    static let families: [(prefix: String, kind: Kind)] = [
        ("quickPanel.section.", .bool), ("quickPanel.home.", .bool),
        ("quickPanel.size.", .choice(sizes)), ("quickPanel.move.", .choice(["up", "down"])),
        ("perm.open.", .action), ("notify.hook.", .action),
    ]
    static func item(_ id: String) -> Item? {
        if let exact = items.first(where: { $0.id == id }) { return exact }
        for family in families where id.hasPrefix(family.prefix) {
            let suffix = id.dropFirst(family.prefix.count)
            guard (1...40).contains(suffix.utf8.count), suffix.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return nil }
            return Item(id: id, kind: family.kind, writable: true)
        }
        return nil
    }
    static func shortcut(_ raw: String) -> (modifiers: UInt32, keyCode: UInt32)? {
        let parts = raw.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, let m = UInt32(parts[0]), let k = UInt32(parts[1]), m <= 0xFFFF, k <= 0xFF else { return nil }
        return (m, k)
    }
    /// `days` nil means no age limit.
    static func retention(_ raw: String) -> (days: Int?, itemLimit: Int)? {
        let parts = raw.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, let d = Int(parts[0]), let n = Int(parts[1]), [0, 1, 7, 30, 90].contains(d), [10, 25, 50, 100].contains(n) else { return nil }
        return (d == 0 ? nil : d, n)
    }

    static func isBool(_ raw: Any?) -> Bool? {
        guard let n = raw as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }
        return n.boolValue
    }

    /// Strict parse: exact key sets, known id, value type matching the item kind.
    static func parse(_ body: [String: Any]) -> Result<Request, Rejection> {
        guard let action = body["action"] as? String else { return .failure(.invalidRequest) }
        switch action {
        case "state":
            return Set(body.keys) == ["command", "action"] ? .success(.state) : .failure(.invalidRequest)
        case "set":
            guard Set(body.keys) == ["command", "action", "id", "value"],
                  let id = body["id"] as? String, id.utf8.count <= 80, let item = item(id) else { return .failure(.invalidRequest) }
            guard item.writable else { return .failure(.invalidRequest) }
            switch item.kind {
            case .bool:
                guard let b = isBool(body["value"]) else { return .failure(.invalidRequest) }
                return .success(.set(id: id, value: .bool(b)))
            case .choice(let allowed):
                guard let s = body["value"] as? String, !(body["value"] is NSNumber), allowed.contains(s) else { return .failure(.invalidRequest) }
                return .success(.set(id: id, value: .string(s)))
            case .number(let range):
                guard let n = body["value"] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite, range.contains(n.doubleValue) else { return .failure(.invalidRequest) }
                return .success(.set(id: id, value: .number(n.doubleValue)))
            case .shortcut:
                guard let s = body["value"] as? String, !(body["value"] is NSNumber), shortcut(s) != nil else { return .failure(.invalidRequest) }
                return .success(.set(id: id, value: .string(s)))
            case .action:
                guard let s = body["value"] as? String, !(body["value"] is NSNumber), s == "run" else { return .failure(.invalidRequest) }
                return .success(.set(id: id, value: .string(s)))
            case .retention:
                guard let s = body["value"] as? String, !(body["value"] is NSNumber), retention(s) != nil else { return .failure(.invalidRequest) }
                return .success(.set(id: id, value: .string(s)))
            }
        default: return .failure(.invalidRequest)
        }
    }

    /// Reads are allowed from anywhere; changes only while the Settings page is the visible, ready workspace selection.
    static func visibility(for request: Request, ready: Bool, selection: String?) -> Rejection? {
        if case .state = request { return nil }
        return ready && selection == "settings" ? nil : .settingsNotVisible
    }

    static func reply(_ rejection: Rejection) -> [String: Any] { ["status": "error", "reason": rejection.rawValue] }
}
