import AppKit
import ApplicationServices
import SwiftUI

/// Island settings for dictate-to-cursor: switch, trigger key and the
/// Accessibility status it depends on. Asks macOS for access only when the
/// user presses the button.
struct NativeDictateSettingsView: View {
    @ObservedObject var store: NativeDictateTriggerStore
    private static let accessibilityURL = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Toggle(nativeUI("听写到光标处", "Dictate at cursor"), isOn: Binding(get: { store.enabled }, set: { store.setEnabled($0) }))
                .toggleStyle(.switch).controlSize(.small).font(.system(size: 12))
            if store.enabled {
                Picker(nativeUI("触发键", "Trigger"), selection: Binding(get: { store.kind }, set: { store.setKind($0) })) {
                    ForEach(NativeDictateTriggerKind.allCases, id: \.self) { Text($0.label).tag($0) }
                }.pickerStyle(.segmented).labelsHidden()
                    .accessibilityLabel(nativeUI("听写触发键", "Dictation trigger key"))
                if store.kind == .combo {
                    HStack {
                        Text(nativeUI("听写快捷键", "Dictation shortcut")).font(.system(size: 12))
                        Spacer()
                        NativeDictateComboRecorder(store: store).frame(width: 144, height: 28)
                        if store.recording {
                            Button(nativeUI("取消", "Cancel")) { store.setRecording(false) }
                        } else if store.combo != NativeDictateTriggerStore.standardCombo {
                            Button(nativeUI("恢复默认", "Reset")) { store.apply(NativeDictateTriggerStore.standardCombo) }
                        }
                    }
                }
                if let issue = store.issue {
                    Text(issue).font(.system(size: 11)).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                } else if store.recording {
                    Text(nativeUI("按下组合键，Esc 取消。", "Press a shortcut; Esc cancels.")).font(.system(size: 11)).foregroundStyle(.secondary)
                } else {
                    Text(hint).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                if store.needsAccess {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(nativeUI("需要在“系统设置 › 隐私与安全性 › 辅助功能”中允许 AI Bro，才能听到触发键并输入文字。",
                                      "Allow AI Bro in System Settings › Privacy & Security › Accessibility so it can hear the trigger and type.")
                              + nativeUI("若列表里已有且已打开却仍提示，请点“−”删除后再用“+”重新添加当前的 AI Bro。",
                                         " If it is already listed and on, remove it with “−” and add this AI Bro again with “+”."))
                            .font(.system(size: 11)).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                        HStack {
                            Button(nativeUI("打开辅助功能设置", "Open Accessibility settings")) { requestAccess() }
                            Button(nativeUI("重新检查", "Check again")) { recheck() }
                        }.controlSize(.small)
                    }
                }
                Text(accessStatus).font(.system(size: 10)).foregroundStyle(.tertiary).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .onAppear { store.recheckAccess() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in recheck() }
        .onDisappear { store.setRecording(false) }
    }

    private var hint: String {
        switch store.kind {
        case .rightOption, .rightCommand:
            return nativeUI("在其他 App 的输入框里按住\(store.kind.label)说话，松开后输入；轻按一下开始，再按一下结束。",
                            "In another app, hold \(store.kind.label) to talk and release to insert; tap once to start and again to stop.")
        case .combo:
            return nativeUI("在其他 App 的输入框里按住快捷键说话，松开后输入；轻按一下开始，再按一下结束。",
                            "In another app, hold the shortcut to talk and release to insert; tap once to start and again to stop.")
        }
    }

    private func recheck() {
        store.recheckAccess()
    }

    /// Which copy of the app the permissions belong to, so the right row can
    /// be found in System Settings.
    private var accessStatus: String {
        let name = (Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String) ?? "AI Bro"
        let yes = nativeUI("已允许", "on"), no = nativeUI("未允许", "off")
        return nativeUI("“\(name)” 辅助功能：\(AXIsProcessTrusted() ? yes : no) · 输入监控：\(CGPreflightListenEventAccess() ? yes : no)\n\(Bundle.main.bundlePath)",
                        "“\(name)” Accessibility: \(AXIsProcessTrusted() ? yes : no) · Input Monitoring: \(CGPreflightListenEventAccess() ? yes : no)\n\(Bundle.main.bundlePath)")
    }

    /// Lets macOS add this copy to the Accessibility (and Input Monitoring)
    /// list and show its own prompt, then opens the pane. The user decides there.
    private func requestAccess() {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        let trusted = AXIsProcessTrustedWithOptions(options)
        let listen = CGPreflightListenEventAccess() || CGRequestListenEventAccess()
        dictateLog("access requested from settings trusted=\(trusted) listenEvent=\(listen) path=\(Bundle.main.bundlePath)")
        NSWorkspace.shared.open(Self.accessibilityURL)
    }
}

private struct NativeDictateComboRecorder: NSViewRepresentable {
    @ObservedObject var store: NativeDictateTriggerStore
    func makeNSView(context: Context) -> NativeSpeechShortcutRecorder.Recorder {
        let view = NativeSpeechShortcutRecorder.Recorder()
        view.bezelStyle = .rounded; view.controlSize = .small
        view.font = .monospacedSystemFont(ofSize: 12, weight: .medium)
        return view
    }
    func updateNSView(_ view: NativeSpeechShortcutRecorder.Recorder, context: Context) {
        view.begin = { store.setRecording(true) }
        view.finish = { store.setRecording(false) }
        view.choose = { value in if store.apply(value) { store.setRecording(false) } }
        view.title = store.recording ? nativeUI("按下组合键…", "Press shortcut…") : store.combo.label
        view.setAccessibilityLabel(nativeUI("录制听写快捷键", "Record dictation shortcut"))
        view.setAccessibilityValue(store.recording ? nativeUI("正在录制", "Recording") : store.combo.label)
        view.toolTip = nativeUI("点击后按下新的组合键", "Click and press a new shortcut")
        view.recording = store.recording
    }
    static func dismantleNSView(_ view: NativeSpeechShortcutRecorder.Recorder, coordinator: ()) {
        view.stopObservingWindow(); view.finish?(); view.begin = nil; view.choose = nil; view.finish = nil
    }
}
