import AppKit
import SwiftUI

struct NativeQuickShortcutView: View {
    @ObservedObject var store: NativeQuickShortcutStore
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text(nativeUI("唤出快捷键", "Open shortcut")).font(.system(size: 12))
                Spacer()
                NativeQuickShortcutRecorder(store: store).frame(width: 144, height: 28)
                if store.recording {
                    Button(nativeUI("取消", "Cancel")) { store.setRecording(false) }
                } else if store.shortcut != .standard {
                    Button(nativeUI("恢复默认", "Reset")) { store.apply(.standard) }
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
                Text(nativeUI("常驻入口已关闭，启用后快捷键生效。", "The persistent entry is off. Its shortcut becomes active when enabled.")).font(.system(size: 11)).foregroundStyle(.secondary)
            }
        }
        .onDisappear { store.setRecording(false) }
    }
}

private struct NativeQuickShortcutRecorder: NSViewRepresentable {
    @ObservedObject var store: NativeQuickShortcutStore
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
        view.setAccessibilityLabel(nativeUI("录制唤出快捷键", "Record open shortcut"))
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
