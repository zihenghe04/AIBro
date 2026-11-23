import Foundation

/// Test builds have their own bundle id, so UserDefaults starts empty and the
/// user's shortcuts (for example ⌥⇧V for voice) silently fall back to the
/// defaults. On the first launch of a Dev build, copy the release app's
/// non-sensitive interface preferences once. The release domain is only read;
/// nothing is written back, and no keys, tokens, servers or Keychain items move.
enum NativeDevPreferenceImport {
    static let releaseDomain = "app.ai-workstation.studio"
    static let markerKey = "ai-bro-dev-imported-release-preferences-v1"
    /// Shortcuts, entry modes and dictate settings. Nothing here holds a
    /// credential, model name or server address.
    static let keys = [
        "ai-bro-native-speech-shortcut-v1", "ai-bro-native-speech-shortcut-mode-v1", "ai-bro-native-speech-auto-submit-v1",
        "ai-bro-native-quick-shortcut-v1", "ai-bro-native-quick-entry-mode", "ai-bro-native-quick-entry-last-enabled-mode",
        "ai-bro-native-quick-panel-preferences-v1",
        "ai-bro-native-dictate-enabled-v1", "ai-bro-native-dictate-trigger-v1", "ai-bro-native-dictate-combo-v1",
    ]

    /// Copies `keys` present in `release` into `dev` once, then sets the
    /// marker. Returns the keys copied (empty when already done or nothing found).
    @discardableResult static func run(dev: UserDefaults, release: UserDefaults?) -> [String] {
        guard !dev.bool(forKey: markerKey) else { return [] }
        var copied: [String] = []
        if let release {
            for key in keys {
                guard let value = release.object(forKey: key) else { continue }
                dev.set(value, forKey: key); copied.append(key)
            }
        }
        dev.set(true, forKey: markerKey)
        return copied
    }

    /// Runs only inside a Dev build whose bundle id differs from the release one.
    @discardableResult static func runAtLaunch(bundle: Bundle = .main) -> [String] {
        guard bundle.object(forInfoDictionaryKey: "AIBroDevIdentity") as? Bool == true,
              let identifier = bundle.bundleIdentifier, identifier != releaseDomain else { return [] }
        let copied = run(dev: .standard, release: UserDefaults(suiteName: releaseDomain))
        if !copied.isEmpty { NSLog("AI Bro Dev imported release preferences: %@", copied.joined(separator: ",")) }
        return copied
    }

    /// Interface language from the release app's preferences file, used when
    /// the Dev data folder has none yet. Only this one key is read.
    static func language(releasePreferences file: URL) -> String? {
        guard let data = try? Data(contentsOf: file),
              let values = try? JSONDecoder().decode([String: String].self, from: data),
              let language = values["ai-bro-language"], ["zh-CN", "en"].contains(language) else { return nil }
        return language
    }
}
