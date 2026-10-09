import Foundation

final class VoiceShortcutInbox {
    static let shared = VoiceShortcutInbox()
    static let changed = Notification.Name("AIBroVoiceShortcutPending")
    static let url = "aibro://voice/new"
    private let defaults: UserDefaults
    private let key = "aibro.pendingVoiceShortcut.v1"
    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    @discardableResult func receive(_ url: URL, now: Date = Date()) -> Bool {
        guard url.scheme?.lowercased() == "aibro", url.host?.lowercased() == "voice", url.path == "/new",
              url.user == nil, url.password == nil, url.port == nil, url.query == nil, url.fragment == nil else { return false }
        let item: [String: Any] = ["requestId": UUID().uuidString, "createdAt": now.timeIntervalSince1970 * 1000, "url": Self.url]
        defaults.set(item, forKey: key)
        NotificationCenter.default.post(name: Self.changed, object: self, userInfo: item)
        return true
    }
    func pending() -> [String: Any] { defaults.dictionary(forKey: key) ?? ["requestId": NSNull()] }
    func acknowledge(_ id: String) {
        guard defaults.dictionary(forKey: key)?["requestId"] as? String == id else { return }
        defaults.removeObject(forKey: key)
    }
}
