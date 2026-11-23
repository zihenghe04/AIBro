import AppKit
import ApplicationServices
import AVFoundation
import CoreGraphics
import UserNotifications

/// Status-only view of the system permissions for Settings → Privacy & security.
/// Every read here is a preflight/status call: nothing in this file may ever request
/// or prompt for a permission. Granting happens in System Settings, opened by the user.
@MainActor final class NativePermissionProbe {
    private(set) var notifications = "unknown"
    /// `getNotificationSettings` only reads; it never shows the authorization prompt.
    func refreshNotifications() {
        guard Bundle.main.bundleIdentifier != nil, Bundle.main.bundleURL.pathExtension == "app" else { return }
        UNUserNotificationCenter.current().getNotificationSettings { [weak self] settings in
            let value: String
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral: value = "granted"
            case .denied: value = "denied"
            case .notDetermined: value = "notDetermined"
            @unknown default: value = "unknown"
            }
            Task { @MainActor in self?.notifications = value }
        }
    }
}

@MainActor enum NativeSettingsPermissionBinding {
    /// pane id (the `perm.open.<pane>` suffix) -> System Settings URL.
    static let panes: [String: String] = [
        "accessibility": "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        "inputMonitoring": "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
        "microphone": "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
        "camera": "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
        "notifications": "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
    ]

    static func capture(_ type: AVMediaType) -> String {
        switch AVCaptureDevice.authorizationStatus(for: type) {
        case .authorized: return "granted"
        case .denied, .restricted: return "denied"
        case .notDetermined: return "notDetermined"
        @unknown default: return "unknown"
        }
    }

    static func values(login: NativeQuickLoginItemStore, probe: NativePermissionProbe) -> [String: Any] {
        probe.refreshNotifications()
        let loginValue: String
        switch login.status {
        case .enabled: loginValue = "enabled"
        case .notRegistered: loginValue = "notRegistered"
        case .requiresApproval: loginValue = "requiresApproval"
        case .notFound: loginValue = "notFound"
        case .unknown: loginValue = "unknown"
        }
        return [
            "perm.accessibility": AXIsProcessTrusted() ? "granted" : "denied",
            "perm.inputMonitoring": CGPreflightListenEventAccess() ? "granted" : "denied",
            "perm.microphone": capture(.audio),
            "perm.camera": capture(.video),
            "perm.notifications": probe.notifications,
            "perm.loginItem": loginValue,
        ]
    }

    static func meta() -> [String: Any] {
        ["permissions": ["bundlePath": Bundle.main.bundlePath, "bundleID": Bundle.main.bundleIdentifier as Any]]
    }

    /// Returns false when the id is not a permission action. `perm.open.loginItems` reuses the login-item store.
    static func set(_ id: String, _ value: NativeSettingsRegistry.Value, login: NativeQuickLoginItemStore) -> Bool {
        let prefix = "perm.open."
        guard id.hasPrefix(prefix) else { return false }
        let pane = String(id.dropFirst(prefix.count))
        if pane == "loginItems" { login.openSettings(); return true }
        guard let raw = panes[pane], let url = URL(string: raw) else { return false }
        NSWorkspace.shared.open(url)
        return true
    }
}
