import AppIntents
import Foundation

struct OpenVoiceCaptureIntent: AppIntent {
    static var title: LocalizedStringResource = "打开语音记录"
    static var description = IntentDescription("打开 AI Bro，在前台录音并审阅转写结果。")
    static var openAppWhenRun = true
    static var authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication

    @MainActor func perform() async throws -> some IntentResult {
        // The shortcut only opens the app and queues this route. Microphone use
        // begins exclusively when the foreground UI consumes and accepts it.
        VoiceShortcutInbox.shared.receive(URL(string: VoiceShortcutInbox.url)!)
        return .result()
    }
}

struct AIBroVoiceShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: OpenVoiceCaptureIntent(), phrases: [
            "Record a voice note in \(.applicationName)",
            "Take a voice note in \(.applicationName)",
        ], shortTitle: "语音记录", systemImageName: "mic.fill")
    }
}
