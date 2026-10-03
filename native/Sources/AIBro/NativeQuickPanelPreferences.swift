import Foundation
import Combine

enum NativeQuickPanelSection: String, CaseIterable, Identifiable, Codable {
    case home, tasks, agenda, capture, links, recordings, voice, vault, clipboard, shelf, runs, settings
    var id: String { rawValue }
    var title: String {
        switch self {
        case .home: return nativeUI("首页", "Home")
        case .tasks: return nativeUI("待办", "Tasks")
        case .agenda: return nativeUI("日程", "Calendar")
        case .capture: return nativeUI("随记", "Notes")
        case .links: return nativeUI("链接", "Links")
        case .recordings: return nativeUI("录音", "Recordings")
        case .voice: return nativeUI("语音", "Voice")
        case .vault: return nativeUI("保险箱", "Vault")
        case .clipboard: return nativeUI("剪贴板", "Clipboard")
        case .shelf: return nativeUI("中转站", "File shelf")
        case .runs: return nativeUI("运行", "Runs")
        case .settings: return nativeUI("设置", "Settings")
        }
    }
    var symbol: String {
        switch self {
        case .home: return "square.grid.2x2"
        case .tasks: return "checklist"
        case .agenda: return "calendar"
        case .capture: return "note.text"
        case .links: return "link"
        case .recordings: return "waveform"
        case .voice: return "mic"
        case .vault: return "lock"
        case .clipboard: return "clipboard"
        case .shelf: return "tray.and.arrow.down"
        case .runs: return "waveform.path"
        case .settings: return "slider.horizontal.3"
        }
    }
    var canHide: Bool { self != .home && self != .settings }
}

/// Presentation preferences only. Saved tasks, notes and media belong to their
/// production stores; hiding a panel never changes or deletes their data.
@MainActor final class NativeQuickPanelPreferences: ObservableObject {
    enum Size: String, CaseIterable, Codable, Identifiable {
        case mini, small, medium, large
        var id: String { rawValue }
        var title: String {
            switch self {
            case .mini: return nativeUI("迷你", "Mini")
            case .small: return nativeUI("小", "Small")
            case .medium: return nativeUI("中", "Medium")
            case .large: return nativeUI("大", "Large")
            }
        }
        var fullWidth: Bool { self == .medium || self == .large }
        var minimumHeight: CGFloat {
            switch self { case .mini: return 100; case .small: return 154; case .medium: return 182; case .large: return 238 }
        }
    }
    struct Configuration: Codable, Equatable {
        var version = 1
        var defaultSection: NativeQuickPanelSection = .home
        var hiddenSections: Set<NativeQuickPanelSection> = []
        // Follow the upstream seven-widget canvas. AI Bro's task/run pages stay
        // in the tab strip and remain available as optional home widgets.
        var hiddenHomeModules: Set<String> = ["tasks", "runs"]
        var homeOrder = ["music", "pomodoro", "windows", "recorder", "mirror", "note", "commands", "tasks", "runs"]
        var homeSizes: [String: Size] = ["tasks": .medium, "note": .medium, "runs": .small,
            "music": .medium, "pomodoro": .mini, "windows": .large, "recorder": .small, "mirror": .medium, "commands": .mini]
    }
    @Published private(set) var configuration: Configuration
    @Published private(set) var issue: String?
    private let defaults: UserDefaults
    private let key = "ai-bro-native-quick-panel-preferences-v1"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: key), let saved = try? JSONDecoder().decode(Configuration.self, from: data), saved.version == 1 {
            var safe = saved
            safe.hiddenSections = safe.hiddenSections.filter(\.canHide)
            if safe.hiddenSections.contains(safe.defaultSection) { safe.defaultSection = .home }
            safe.homeOrder = Self.unique(saved.homeOrder.filter { !$0.isEmpty && $0.count <= 80 })
            let legacyOrder = ["tasks", "note", "runs", "music", "pomodoro", "windows", "recorder", "mirror", "commands"]
            let legacySizes: [String: Size] = ["tasks": .medium, "note": .small, "runs": .small,
                "music": .medium, "pomodoro": .mini, "windows": .large, "recorder": .small, "mirror": .medium, "commands": .mini]
            // Only an untouched old home defaults snapshot is eligible. Custom
            // order, size, or visibility must never be replaced by a release.
            if saved.homeOrder == legacyOrder, saved.homeSizes == legacySizes, saved.hiddenHomeModules.isEmpty {
                let current = Configuration()
                safe.homeOrder = current.homeOrder; safe.homeSizes = current.homeSizes
                safe.hiddenHomeModules = current.hiddenHomeModules
                if let encoded = try? JSONEncoder().encode(safe) { defaults.set(encoded, forKey: key) }
            }
            configuration = safe
        } else { configuration = Configuration() }
    }
    func visibleSections(available: Set<NativeQuickPanelSection>) -> [NativeQuickPanelSection] {
        NativeQuickPanelSection.allCases.filter { available.contains($0) && (!configuration.hiddenSections.contains($0) || !$0.canHide) }
    }
    func defaultSection(available: Set<NativeQuickPanelSection>) -> NativeQuickPanelSection {
        visibleSections(available: available).contains(configuration.defaultSection) ? configuration.defaultSection : .home
    }
    func setDefault(_ section: NativeQuickPanelSection, available: Set<NativeQuickPanelSection>) {
        guard visibleSections(available: available).contains(section) else { return }
        var next = configuration; next.defaultSection = section; save(next)
    }
    func setSection(_ section: NativeQuickPanelSection, visible: Bool) {
        guard section.canHide else { return }
        var next = configuration
        if visible { next.hiddenSections.remove(section) } else { next.hiddenSections.insert(section) }
        if !visible && next.defaultSection == section { next.defaultSection = .home }
        save(next)
    }
    func orderedHomeIDs(available: [String]) -> [String] {
        Self.unique(configuration.homeOrder + available).filter { available.contains($0) }
    }
    func visibleHomeIDs(available: [String]) -> [String] {
        let order = orderedHomeIDs(available: available)
        let visible = order.filter { !configuration.hiddenHomeModules.contains($0) }
        return visible.isEmpty ? Array(order.prefix(1)) : visible
    }
    func usesAutomaticLayout(available: [String]) -> Bool {
        let base = available.filter { $0 != "tasks" && $0 != "runs" }
        let visible = visibleHomeIDs(available: available)
        guard !visible.contains("tasks"), !visible.contains("runs") else { return false }
        return visible.count < base.count
    }
    @discardableResult func setHomeModule(_ id: String, visible: Bool, available: [String]) -> Bool {
        guard available.contains(id) else { return false }
        let visibleIDs = visibleHomeIDs(available: available)
        guard visible || !visibleIDs.contains(id) || visibleIDs.count > 1 else {
            issue = nativeUI("首页至少保留一个组件。", "Keep at least one home widget."); return false
        }
        var next = configuration
        if visible { next.hiddenHomeModules.remove(id) } else { next.hiddenHomeModules.insert(id) }
        return save(next)
    }
    func preferredSize(_ id: String) -> Size { configuration.homeSizes[id] ?? .medium }
    func setSize(_ size: Size, for id: String) {
        var next = configuration; next.homeSizes[id] = size; save(next)
    }
    func moveHome(_ source: String, before target: String, available: [String]) {
        guard source != target, available.contains(source), available.contains(target) else { return }
        var next = configuration
        var order = Self.unique(next.homeOrder + available)
        order.removeAll { $0 == source }
        guard let index = order.firstIndex(of: target) else { return }
        order.insert(source, at: index); next.homeOrder = order; save(next)
    }
    /// A drag is a single compare-and-swap transaction, matching the upstream
    /// two-card exchange. Never overwrite a concurrent visibility/size change.
    @discardableResult func swapHome(_ source: String, with target: String, available: [String], expected: Configuration) -> Bool {
        guard configuration == expected, source != target else { return false }
        let visible = visibleHomeIDs(available: available)
        guard visible.contains(source), visible.contains(target) else { return false }
        var next = configuration
        var order = Self.unique(next.homeOrder + available)
        guard let a = order.firstIndex(of: source), let b = order.firstIndex(of: target) else { return false }
        order.swapAt(a, b); next.homeOrder = order
        return save(next)
    }
    func moveHome(_ id: String, offset: Int, available: [String]) {
        let visible = orderedHomeIDs(available: available)
        guard let index = visible.firstIndex(of: id), visible.indices.contains(index + offset) else { return }
        var next = configuration
        var order = Self.unique(next.homeOrder + available)
        guard let a = order.firstIndex(of: id), let b = order.firstIndex(of: visible[index + offset]) else { return }
        order.swapAt(a, b); next.homeOrder = order; save(next)
    }
    func resetLayout() {
        var next = configuration; let initial = Configuration()
        next.homeOrder = initial.homeOrder; next.homeSizes = initial.homeSizes; save(next)
    }
    func reportCannotHide() { issue = nativeUI("此组件正在使用，请先结束当前操作。", "This widget is in use. Finish its current operation first.") }
    @discardableResult private func save(_ next: Configuration) -> Bool {
        guard let data = try? JSONEncoder().encode(next) else { return false }
        defaults.set(data, forKey: key)
        guard defaults.data(forKey: key) == data else {
            issue = nativeUI("显示设置未能保存，原设置仍保留。", "Display preferences could not be saved. The previous settings are retained."); return false
        }
        issue = nil; configuration = next; return true
    }
    private static func unique(_ ids: [String]) -> [String] {
        var seen = Set<String>(); return ids.filter { seen.insert($0).inserted }
    }
}
