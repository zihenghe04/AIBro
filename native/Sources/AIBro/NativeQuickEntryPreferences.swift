import Foundation

enum NativeQuickEntryMode: String, CaseIterable, Identifiable {
    case off, menuBar, edge, island
    var id: String { rawValue }
    var title: String {
        switch self {
        case .off: return nativeUI("关闭常驻入口", "Off")
        case .menuBar: return nativeUI("菜单栏", "Menu bar")
        case .edge: return nativeUI("屏幕侧边", "Screen edge")
        case .island: return nativeUI("顶部灵动岛", "Top island")
        }
    }
}

/// Only presentation preferences. Enabling this does not register a login item
/// or grant clipboard, microphone, camera, or external notification access.
struct NativeQuickEntryPreferences {
    static let modeKey = "ai-bro-native-quick-entry-mode"
    static let lastEnabledModeKey = "ai-bro-native-quick-entry-last-enabled-mode"
    let defaults: UserDefaults

    var mode: NativeQuickEntryMode {
        guard defaults.object(forKey: Self.modeKey) != nil else { return .island }
        guard let saved = defaults.string(forKey: Self.modeKey) else { return .off }
        // Preserve an explicit opt-out; malformed saved values fail closed.
        return NativeQuickEntryMode(rawValue: saved) ?? .off
    }
    var preferredEnabledMode: NativeQuickEntryMode {
        if mode != .off { return mode }
        if let saved = defaults.string(forKey: Self.lastEnabledModeKey),
           let mode = NativeQuickEntryMode(rawValue: saved), mode != .off { return mode }
        return .island
    }
    func save(_ next: NativeQuickEntryMode) {
        if next != .off { defaults.set(next.rawValue, forKey: Self.lastEnabledModeKey) }
        else if mode != .off { defaults.set(mode.rawValue, forKey: Self.lastEnabledModeKey) }
        defaults.set(next.rawValue, forKey: Self.modeKey)
    }
}
