import Foundation

/// Voice and dictation items of the unified Settings page (#15-#22, #25). Every write goes through the
/// stores' own entry points (`setKind` -> `refresh(force:true)`, `apply`, `setMode`...), so a change takes
/// effect immediately and the reply reports the effective value, never the requested one.
@MainActor enum NativeSettingsVoiceBinding {
    static let silenceKey = "aibro.dictation.silenceSeconds"
    static let defaultSilence = 1.5

    static func silence(_ preferences: UserDefaults) -> Double {
        guard let value = preferences.object(forKey: silenceKey) as? Double, value.isFinite else { return defaultSilence }
        return min(max(value, 0), 10)
    }

    static func code(_ shortcut: NativeQuickShortcut) -> String { "\(shortcut.modifiers):\(shortcut.keyCode)" }

    static func values(dictate: NativeDictateTriggerStore, speech: NativeSpeechShortcutStore, preferences: UserDefaults) -> [String: Any] {
        [
            "dictate.enabled": dictate.enabled,
            "dictate.trigger": dictate.kind.rawValue,
            "dictate.combo": code(dictate.combo),
            "dictate.access": dictate.enabled && dictate.active ? !dictate.needsAccess : true,
            "speech.shortcut": code(speech.shortcut),
            "speech.mode": speech.mode.rawValue,
            "speech.autoSubmit": speech.autoSubmit,
            "speech.silence": silence(preferences),
        ]
    }

    /// Labels and issues the page cannot derive from the values alone.
    static func meta(dictate: NativeDictateTriggerStore, speech: NativeSpeechShortcutStore) -> [String: Any] {
        [
            "dictate": ["label": dictate.label, "comboLabel": dictate.combo.label, "issue": dictate.issue as Any, "active": dictate.active,
                        "registered": dictate.registered, "needsAccess": dictate.needsAccess],
            "speech": ["label": speech.shortcut.label, "issue": speech.issue as Any, "active": speech.active, "registered": speech.registered],
        ]
    }

    /// Returns false when the id is not a voice item. The caller replies with `values` afterwards.
    static func set(_ id: String, _ value: NativeSettingsRegistry.Value, dictate: NativeDictateTriggerStore, speech: NativeSpeechShortcutStore,
                    preferences: UserDefaults) -> Bool {
        switch (id, value) {
        case ("dictate.enabled", .bool(let on)): dictate.setEnabled(on)
        case ("dictate.trigger", .string(let raw)):
            guard let kind = NativeDictateTriggerKind(rawValue: raw) else { return true }
            dictate.setKind(kind)
        case ("dictate.combo", .string(let raw)):
            guard let parts = NativeSettingsRegistry.shortcut(raw) else { return true }
            dictate.apply(NativeQuickShortcut(keyCode: parts.keyCode, modifiers: parts.modifiers))
        case ("speech.shortcut", .string(let raw)):
            guard let parts = NativeSettingsRegistry.shortcut(raw) else { return true }
            speech.apply(NativeQuickShortcut(keyCode: parts.keyCode, modifiers: parts.modifiers))
        case ("speech.mode", .string(let raw)):
            guard let mode = NativeSpeechShortcutStore.Mode(rawValue: raw) else { return true }
            speech.setMode(mode)
        case ("speech.autoSubmit", .bool(let on)): speech.setAutoSubmit(on)
        case ("speech.silence", .number(let seconds)):
            preferences.set((min(max(seconds, 0), 10) * 10).rounded() / 10, forKey: silenceKey)
        default: return false
        }
        return true
    }
}
