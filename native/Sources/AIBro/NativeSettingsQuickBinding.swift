import Foundation

/// General and quick-entry items of the unified Settings page (#5, #6, #8-#14). Each write goes through the
/// same store entry point the native settings view uses; the reply reports what is actually in effect.
/// Panel sections, home widgets and the default page share one UserDefaults key, so values are split per id here.
@MainActor enum NativeSettingsQuickBinding {
    static func code(_ shortcut: NativeQuickShortcut) -> String { "\(shortcut.modifiers):\(shortcut.keyCode)" }

    static func values(login: NativeQuickLoginItemStore, quickEntry: NativeQuickEntryCoordinator, clipboard: NativeQuickClipboardStore,
                       defaults: UserDefaults) -> [String: Any] {
        let prefs = quickEntry.panelPreferences
        let available = quickEntry.availableSections
        let ids = quickEntry.homeModules.map(\.id)
        let visibleHome = Set(prefs.visibleHomeIDs(available: ids))
        var out: [String: Any] = [
            "login.enabled": login.status.isRegistered,
            "login.background": defaults.bool(forKey: NativeLoginLaunch.backgroundKey),
            "quickEntry.enabled": quickEntry.isEnabled,
            "quickEntry.mode": quickEntry.mode.rawValue,
            "quickEntry.shortcut": code(quickEntry.shortcutStore.shortcut),
            "quickPanel.default": prefs.defaultSection(available: available).rawValue,
            "clipboard.retention.preview": retentionCode(clipboard.retentionPolicy),
        ]
        let visible = Set(prefs.visibleSections(available: available))
        for section in NativeQuickPanelSection.allCases where section.canHide && available.contains(section) {
            out["quickPanel.section.\(section.rawValue)"] = visible.contains(section)
        }
        for id in ids {
            out["quickPanel.home.\(id)"] = visibleHome.contains(id)
            out["quickPanel.size.\(id)"] = prefs.preferredSize(id).rawValue
        }
        return out
    }

    static func retentionCode(_ policy: NativeQuickClipboardRetention) -> String { "\(policy.days ?? 0):\(policy.itemLimit)" }

    static func meta(login: NativeQuickLoginItemStore, quickEntry: NativeQuickEntryCoordinator, clipboard: NativeQuickClipboardStore) -> [String: Any] {
        let prefs = quickEntry.panelPreferences
        let ids = quickEntry.homeModules.map(\.id)
        let visibleHome = prefs.visibleHomeIDs(available: ids)
        let sections = NativeQuickPanelSection.allCases.filter { quickEntry.availableSections.contains($0) }
            .map { ["id": $0.rawValue, "title": $0.title, "canHide": $0.canHide] as [String: Any] }
        let modules = prefs.orderedHomeIDs(available: ids).compactMap { id in
            quickEntry.homeModules.first { $0.id == id }.map {
                ["id": $0.id, "title": $0.title, "visible": visibleHome.contains($0.id),
                 "lastVisible": visibleHome == [$0.id]] as [String: Any]
            }
        }
        var preview: Any = NSNull()
        if let p = clipboard.retentionPreview {
            preview = ["count": p.ids.count, "bytes": p.bytes, "totalBytes": p.totalBytes, "favorites": p.favoriteCount,
                       "stamp": p.stamp, "policy": retentionCode(p.policy)]
        }
        return [
            "login": ["changing": login.changing, "issue": login.issue as Any, "status": String(describing: login.status)],
            "quickEntry": ["label": quickEntry.shortcutStore.shortcut.label, "issue": quickEntry.shortcutStore.issue as Any,
                           "preferredMode": quickEntry.preferredEnabledMode.rawValue],
            "quickPanel": ["sections": sections, "modules": modules, "automatic": prefs.usesAutomaticLayout(available: ids),
                           "issue": prefs.issue as Any],
            "clipboard": ["available": clipboard.available, "open": clipboard.retentionSettingsOpen, "loading": clipboard.retentionLoading,
                          "busy": clipboard.busy, "error": clipboard.retentionError as Any, "preview": preview],
        ]
    }

    /// Returns false when the id is not one of this binding's. Async stores are started and polled through `state`.
    static func set(_ id: String, _ value: NativeSettingsRegistry.Value, login: NativeQuickLoginItemStore, quickEntry: NativeQuickEntryCoordinator,
                    clipboard: NativeQuickClipboardStore, defaults: UserDefaults) -> Bool {
        let prefs = quickEntry.panelPreferences
        let available = quickEntry.availableSections
        let ids = quickEntry.homeModules.map(\.id)
        switch (id, value) {
        case ("login.enabled", .bool(let on)):
            guard !login.changing else { return true }
            Task { @MainActor in await login.setEnabled(on) }
        case ("login.background", .bool(let on)):
            // The option only matters while the login item is on; the page disables the switch otherwise.
            defaults.set(on, forKey: NativeLoginLaunch.backgroundKey)
        case ("quickEntry.enabled", .bool(let on)): quickEntry.setEnabled(on)
        case ("quickEntry.mode", .string(let raw)):
            guard let mode = NativeQuickEntryCoordinator.Mode(rawValue: raw) else { return true }
            if mode == .off { quickEntry.setEnabled(false) } else { quickEntry.mode = mode }
        case ("quickEntry.shortcut", .string(let raw)):
            guard let parts = NativeSettingsRegistry.shortcut(raw) else { return true }
            _ = quickEntry.shortcutStore.apply(NativeQuickShortcut(keyCode: parts.keyCode, modifiers: parts.modifiers))
        case ("quickPanel.default", .string(let raw)):
            guard let section = NativeQuickPanelSection(rawValue: raw) else { return true }
            prefs.setDefault(section, available: available)
        case ("quickPanel.reset", .string): prefs.resetLayout()
        case ("clipboard.retention.preview", .string(let raw)):
            guard let parts = NativeSettingsRegistry.retention(raw) else { return true }
            let policy = NativeQuickClipboardRetention(days: parts.days, itemLimit: parts.itemLimit)
            guard policy.valid, !clipboard.busy else { return true }
            Task { @MainActor in
                if !clipboard.retentionSettingsOpen { clipboard.openRetentionSettings() }
                await clipboard.prepareRetention(policy)
            }
        case ("clipboard.retention.apply", .string):
            // applyRetention verifies the preview's stamp itself; nothing is deleted without a fresh preview.
            guard clipboard.retentionPreview != nil else { return true }
            Task { @MainActor in await clipboard.applyRetention() }
        case ("clipboard.retention.cancel", .string): clipboard.closeRetentionSettings()
        default:
            if id.hasPrefix("quickPanel.section."), case .bool(let on) = value {
                let raw = String(id.dropFirst("quickPanel.section.".count))
                if let section = NativeQuickPanelSection(rawValue: raw), available.contains(section) { prefs.setSection(section, visible: on) }
                return true
            }
            if id.hasPrefix("quickPanel.home."), case .bool(let on) = value {
                let moduleID = String(id.dropFirst("quickPanel.home.".count))
                if ids.contains(moduleID) { quickEntry.setHomeModule(moduleID, visible: on) }
                return true
            }
            if id.hasPrefix("quickPanel.size."), case .string(let raw) = value {
                let moduleID = String(id.dropFirst("quickPanel.size.".count))
                if ids.contains(moduleID), let size = NativeQuickPanelPreferences.Size(rawValue: raw) { prefs.setSize(size, for: moduleID) }
                return true
            }
            if id.hasPrefix("quickPanel.move."), case .string(let raw) = value {
                let moduleID = String(id.dropFirst("quickPanel.move.".count))
                if ids.contains(moduleID), raw == "up" || raw == "down" { prefs.moveHome(moduleID, offset: raw == "up" ? -1 : 1, available: ids) }
                return true
            }
            return false
        }
        return true
    }
}
