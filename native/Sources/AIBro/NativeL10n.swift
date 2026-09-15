import Foundation
import Combine

/// Localizes declared interface text only. Content titles, source text and stored IDs
/// are never passed through a translation dictionary or changed by language selection.
final class NativeL10n: ObservableObject {
    static let shared = NativeL10n()
    @Published private(set) var language = "zh-CN"
    func setLanguage(_ value: String) {
        let normalized = Self.normalize(value)
        if language != normalized { language = normalized }
    }
    static func normalize(_ value: String) -> String { value == "en" ? "en" : "zh-CN" }
    static var locale: Locale { Locale(identifier: shared.language == "en" ? "en_US" : "zh_CN") }
    static var dateTime: Date.FormatStyle { .dateTime.locale(locale) }
    static func space(_ key: String) -> String {
        switch key {
        case "日常": return nativeUI("日常", "Daily")
        case "课程": return nativeUI("课程", "Courses")
        case "科研": return nativeUI("科研", "Research")
        default: return key
        }
    }
    static func agendaMode(_ key: String) -> String {
        switch key {
        case "今日": return nativeUI("今日", "Day")
        case "周": return nativeUI("周", "Week")
        case "月": return nativeUI("月", "Month")
        default: return key
        }
    }
    static func weekday(_ key: String) -> String {
        let names = ["一":"Mon", "二":"Tue", "三":"Wed", "四":"Thu", "五":"Fri", "六":"Sat", "日":"Sun"]
        return shared.language == "en" ? (names[key] ?? key) : key
    }
    /// These are status messages produced by AgendaStore, never user content.
    static func notificationStatus(_ status: String) -> String {
        guard shared.language == "en" else { return status }
        let messages = [
            "提醒未启用":"Reminders are off",
            "独立验证模式：不申请通知权限":"Demo mode: notification permission is not requested",
            "通知未获授权，请在系统设置中允许 AI Bro 通知。":"Allow AI Bro notifications in System Settings.",
            "系统通知未授权；请在系统设置中开启。":"Notifications are not authorized. Enable them in System Settings."
        ]
        if let value = messages[status] { return value }
        let pattern = #"^已交给系统 (\d+) 条 · 未来 30 天(?: · (\d+) 条待后续补排)?$"#
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: status, range: NSRange(status.startIndex..., in: status)),
              let count = Range(match.range(at: 1), in: status) else { return status }
        let base = "Scheduled with macOS: \(status[count]) · Next 30 days"
        if let remaining = Range(match.range(at: 2), in: status) { return base + " · \(status[remaining]) pending" }
        return base
    }
}

func nativeUI(_ chinese: String, _ english: String) -> String {
    NativeL10n.shared.language == "en" ? english : chinese
}

extension Date {
    func nativeFormatted(_ style: Date.FormatStyle) -> String { formatted(style.locale(NativeL10n.locale)) }
    func nativeFormatted(date: Date.FormatStyle.DateStyle = .numeric, time: Date.FormatStyle.TimeStyle = .shortened) -> String {
        formatted(Date.FormatStyle(date: date, time: time, locale: NativeL10n.locale))
    }
}
