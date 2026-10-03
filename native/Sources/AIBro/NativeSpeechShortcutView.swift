// Adapted from the existing native shortcut recorder; no global event tap.
import AppKit
import SwiftUI

struct NativeSpeechShortcutView: View {
    @ObservedObject var store: NativeSpeechShortcutStore
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Picker(nativeUI("操作方式", "Interaction"), selection: Binding(get: { store.mode }, set: { store.setMode($0) })) {
                Text(nativeUI("按住说话", "Hold to speak")).tag(NativeSpeechShortcutStore.Mode.hold)
                Text(nativeUI("按一下切换", "Toggle")).tag(NativeSpeechShortcutStore.Mode.toggle)
            }.pickerStyle(.segmented).labelsHidden()
                .accessibilityLabel(nativeUI("语音快捷键操作方式", "Voice shortcut interaction"))
            Picker(nativeUI("发送方式", "Send instruction"), selection: Binding(get: { store.autoSubmit }, set: { store.setAutoSubmit($0) })) {
                Text(nativeUI("确认后发送", "Review before sending")).tag(false)
                Text(nativeUI("识别后立即发送", "Send after recognition")).tag(true)
            }.pickerStyle(.menu).controlSize(.small).font(.system(size: 12))
                .accessibilityLabel(nativeUI("语音指令发送方式", "Voice command sending preference"))
            HStack {
                Text(nativeUI("语音指令快捷键", "Voice command shortcut")).font(.system(size: 12))
                Spacer()
                NativeSpeechShortcutRecorder(store: store).frame(width: 144, height: 28)
                if store.recording {
                    Button(nativeUI("取消", "Cancel")) { store.setRecording(false) }
                } else if store.shortcut != NativeSpeechShortcutStore.standard {
                    Button(nativeUI("恢复默认", "Reset")) { store.apply(NativeSpeechShortcutStore.standard) }
                }
            }
            if let issue = store.issue {
                HStack(alignment: .top) {
                    Text(issue).font(.system(size: 11)).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                    if store.active { Button(nativeUI("重试", "Retry")) { store.apply(store.shortcut) } }
                }
            } else if store.recording {
                Text(nativeUI("按下组合键，Esc 取消。", "Press a shortcut; Esc cancels.")).font(.system(size: 11)).foregroundStyle(.secondary)
            } else if !store.active {
                Text(nativeUI("语音入口暂不可用；就绪后快捷键生效。", "Voice entry is unavailable. The shortcut becomes active when it is ready.")).font(.system(size: 11)).foregroundStyle(.secondary)
            } else {
                Text(store.mode == .hold
                     ? nativeUI("按住快捷键说话，松开结束；Esc 取消。", "Hold the shortcut to speak, release to finish; Esc cancels.")
                     : nativeUI("按一下开始，再按一下结束；Esc 取消。", "Press once to start and again to finish; Esc cancels."))
                    .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
        .onDisappear { store.setRecording(false) }
    }
}

private struct NativeSpeechShortcutRecorder: NSViewRepresentable {
    @ObservedObject var store: NativeSpeechShortcutStore
    func makeNSView(context: Context) -> Recorder {
        let view = Recorder()
        view.bezelStyle = .rounded; view.controlSize = .small
        view.font = .monospacedSystemFont(ofSize: 12, weight: .medium)
        return view
    }
    func updateNSView(_ view: Recorder, context: Context) {
        view.begin = { store.setRecording(true) }
        view.finish = { store.setRecording(false) }
        view.choose = { value in if store.apply(value) { store.setRecording(false) } }
        view.title = store.recording ? nativeUI("按下组合键…", "Press shortcut…") : store.shortcut.label
        view.setAccessibilityLabel(nativeUI("录制语音指令快捷键", "Record voice command shortcut"))
        view.setAccessibilityValue(store.recording ? nativeUI("正在录制", "Recording") : store.shortcut.label)
        view.toolTip = nativeUI("点击后按下新的组合键", "Click and press a new shortcut")
        view.recording = store.recording
    }
    static func dismantleNSView(_ view: Recorder, coordinator: ()) { view.stopObservingWindow(); view.finish?(); view.begin = nil; view.choose = nil; view.finish = nil }
    final class Recorder: NSButton {
        var begin: (() -> Void)?
        var finish: (() -> Void)?
        var choose: ((NativeQuickShortcut) -> Void)?
        private var windowObserver: NSObjectProtocol?
        var recording = false {
            didSet {
                guard recording != oldValue else { return }
                if recording { window?.makeFirstResponder(self) }
                needsDisplay = true
            }
        }
        override init(frame frameRect: NSRect) {
            super.init(frame: frameRect); target = self; action = #selector(startRecording)
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            stopObservingWindow()
            guard let window else { return }
            // Switching applications can resign the key window without changing
            // its first responder. Do not leave a hidden recorder consuming the
            // next global invocation when the user returns.
            windowObserver = NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: window, queue: .main) { [weak self, weak window] _ in
                MainActor.assumeIsolated {
                    guard let self, self.window === window, self.recording else { return }
                    self.finish?()
                }
            }
        }
        func stopObservingWindow() {
            if let windowObserver { NotificationCenter.default.removeObserver(windowObserver) }
            windowObserver = nil
            if recording { finish?() }
        }
        deinit { if let windowObserver { NotificationCenter.default.removeObserver(windowObserver) } }
        override var acceptsFirstResponder: Bool { true }
        @objc private func startRecording() { begin?() }
        override func resignFirstResponder() -> Bool { if recording { finish?() }; return super.resignFirstResponder() }
        override func keyDown(with event: NSEvent) {
            guard recording else { super.keyDown(with: event); return }
            guard !event.isARepeat else { return }
            let flags = event.modifierFlags.intersection([.command, .control, .option, .shift])
            if event.keyCode == 53, flags.isEmpty { finish?(); return }
            if event.keyCode == 48, flags.isEmpty || flags == .shift {
                finish?()
                if flags == .shift { window?.selectPreviousKeyView(self) } else { window?.selectNextKeyView(self) }
                return
            }
            choose?(NativeQuickShortcut(event: event))
        }
        override func performKeyEquivalent(with event: NSEvent) -> Bool {
            guard recording else { return super.performKeyEquivalent(with: event) }
            keyDown(with: event); return true
        }
    }
}
