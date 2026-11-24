import AppKit
import Foundation

/// Notification and reminder settings for the unified Settings page.
/// Agenda reminders (`agenda.*`), island task reminders (`notify.island`) and
/// external tool notifications (`notify.external`). Reading never asks the system for
/// permission; only an explicit `agenda.notifications` write may do that, and only
/// when the system has not yet been asked.
@MainActor enum NativeSettingsNotificationBinding {
    static let reminderChoices = ["off", "0", "15", "60", "1440"]

    static func values(agenda: AgendaStore, external: NativeQuickExternalNotificationStore?, island: NativeQuickTaskReminderStore?) -> [String: Any] {
        let p = agenda.preferences
        var out: [String: Any] = [
            "agenda.notifications": p.notifications,
            "agenda.taskReminder": p.taskReminderMinutes.map(String.init) ?? "off",
            "agenda.briefing": p.briefing,
            "agenda.briefingHour": Double(p.briefingHour),
            "agenda.briefingMinute": Double(p.briefingMinute),
            "agenda.showTitles": p.showTitles,
            "notify.sounds": NotificationSounds.enabled,
        ]
        out["notify.external"] = external?.enabled ?? false
        out["notify.island"] = island?.enabled ?? false
        return out
    }

    static func meta(agenda: AgendaStore, external: NativeQuickExternalNotificationStore?, island: NativeQuickTaskReminderStore?, entryOff: Bool) -> [String: Any] {
        [
            "agenda": ["status": agenda.notificationStatus, "error": agenda.error ?? ""],
            "externalNotify": [
                "present": external != nil, "loaded": external?.loaded ?? false, "ready": external?.ready ?? false,
                "changing": external?.changing ?? false, "receiving": external?.receiving ?? false,
                "issue": external?.issue ?? "", "needsRestart": external?.needsRestart ?? false,
                "historyCount": external?.history.count ?? 0,
            ],
            "islandNotify": [
                "present": island != nil, "loaded": island?.loaded ?? false, "available": island?.available ?? false,
                "changing": island?.savingPreference ?? false, "blocked": island?.queueBlocked ?? false, "error": island?.error ?? "",
            ],
            "entryOff": entryOff,
        ]
    }

    /// Returns false when the id is not handled here.
    static func set(_ id: String, _ value: NativeSettingsRegistry.Value, agenda: AgendaStore, external: NativeQuickExternalNotificationStore?, island: NativeQuickTaskReminderStore?, probeStatus: String) -> Bool {
        var next = agenda.preferences
        func save() { do { try agenda.updatePreferences(next) } catch { agenda.error = error.localizedDescription } }
        switch (id, value) {
        case ("agenda.notifications", .bool(let on)):
            if on, probeStatus != "granted" {
                // Explicit user gesture: the only path that may show the system prompt.
                Task { @MainActor in await agenda.requestNotifications() }
            } else { next.notifications = on; save() }
        case ("agenda.taskReminder", .string(let s)):
            guard reminderChoices.contains(s) else { return true }
            next.taskReminderMinutes = s == "off" ? nil : Int(s); save()
        case ("agenda.briefing", .bool(let on)): next.briefing = on; save()
        case ("agenda.briefingHour", .number(let n)): next.briefingHour = Int(n); save()
        case ("agenda.briefingMinute", .number(let n)): next.briefingMinute = Int(n); save()
        case ("agenda.showTitles", .bool(let on)): next.showTitles = on; save()
        case ("notify.sounds", .bool(let on)): NotificationSounds.enabled = on
        case ("agenda.test", .string("run")): Task { @MainActor in await agenda.testNotification() }
        case ("notify.external", .bool(let on)): external?.setEnabled(on)
        case ("notify.island", .bool(let on)): if let island { Task { @MainActor in await island.setEnabled(on) } }
        case ("notify.history.clear", .string("run")): external?.clearHistory()
        default:
            // Copies a hook command (file paths only) to the pasteboard; it is never sent to the page.
            guard id.hasPrefix("notify.hook."), case .string("run") = value else { return false }
            let source = String(id.dropFirst("notify.hook.".count))
            guard ["codex", "claude"].contains(source) else { return true }
            if let command = external?.hookCommand(source: source) {
                NSPasteboard.general.clearContents(); NSPasteboard.general.setString(command, forType: .string)
            }
        }
        return true
    }
}
