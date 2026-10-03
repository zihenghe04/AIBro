const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');

test('native timer reads the live field before Tab and retains invalid/composing edits', { skip: process.platform !== 'darwin', timeout: 90000 }, () => {
  const root = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-duration-field-'));
  try {
    const source = path.join(temporary, 'DurationTests.swift'), binary = path.join(temporary, 'checks');
    fs.writeFileSync(source, String.raw`
import AppKit
import SwiftUI
func nativeUI(_ zh: String, _ en: String) -> String { en }
@MainActor final class Model: ObservableObject {
    @Published var draft = NativeQuickDurationDraft(focus: 1, rest: 300)
}
struct Host: View {
    @ObservedObject var model: Model
    var body: some View {
        NativeQuickDurationField(draft: $model.draft.focusSeconds, maximum: 59, label: "Focus seconds")
            .frame(width: 70, height: 26)
    }
}
@MainActor final class SaveTarget: NSObject {
    let model: Model, store: NativeQuickUtilitiesStore
    var issue: NativeQuickDurationDraft.Issue?
    init(model: Model, store: NativeQuickUtilitiesStore) { self.model = model; self.store = store }
    @objc func save(_ sender: Any?) {
        switch model.draft.validated() {
        case .success(let values): issue = nil; _ = store.configurePomodoro(focusSeconds: values.focus, restSeconds: values.rest)
        case .failure(let value): issue = value
        }
    }
}
@main struct DurationTests {
    @MainActor static func main() {
        _ = NSApplication.shared; NSApp.setActivationPolicy(.prohibited)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 260, height: 90), styleMask: [.titled], backing: .buffered, defer: false)
        let root = NSView(frame: window.contentLayoutRect); window.contentView = root
        let model = Model()
        let host = NSHostingView(rootView: Host(model: model)); host.frame = NSRect(x: 10, y: 20, width: 90, height: 40); root.addSubview(host)
        let store = NativeQuickUtilitiesStore(copy: { _ in false }, notify: { _ in }, schedulesTimers: false)
        store.configure(directory: URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true))
        let target = SaveTarget(model: model, store: store)
        let save = NSButton(title: "Save durations", target: target, action: #selector(SaveTarget.save(_:)))
        save.frame = NSRect(x: 110, y: 20, width: 140, height: 30); root.addSubview(save)
        func settle() { root.layoutSubtreeIfNeeded(); RunLoop.current.run(until: Date().addingTimeInterval(0.08)); root.layoutSubtreeIfNeeded() }
        func findField(_ view: NSView) -> NativeQuickDurationField.Field? {
            if let field = view as? NativeQuickDurationField.Field { return field }
            return view.subviews.lazy.compactMap { findField($0) }.first
        }
        var checks = 0
        func check(_ condition: @autoclosure () -> Bool, _ message: String) { checks += 1; precondition(condition(), message) }
        settle()
        guard let field = findField(host) else { fatalError("Production duration field not hosted") }
        window.makeFirstResponder(field)
        guard let editor = field.currentEditor() as? NSTextView else { fatalError("Missing real AppKit field editor") }
        check(!window.isVisible, "Test must not show a window")
        func enter(_ text: String) { editor.insertText(text, replacementRange: NSRange(location: 0, length: (editor.string as NSString).length)) }
        enter("12")
        check(model.draft.focusSeconds.text == "12", "DidChange publishes the latest seconds synchronously, before blur or Tab")
        save.performClick(nil)
        check(store.focusSeconds == 12 && target.issue == nil, "Clicking Save persists 0 minutes 12 seconds without committing focus first")
        check(field.currentEditor() === editor, "Saving does not steal the active field editor")
        settle()
        for text in ["", "no", "60", "-1", "999999999999999999999999999999"] {
            enter(text); save.performClick(nil)
            check(target.issue == .seconds && store.focusSeconds == 12, "Invalid or empty seconds explicitly block saving rather than using the previous value")
            check(editor.string == text && model.draft.focusSeconds.text == text, "The exact invalid edit remains available for correction")
            settle()
            check(editor.string == text, "SwiftUI refresh cannot replace invalid input")
        }
        enter("0"); save.performClick(nil)
        check(target.issue == .range && store.focusSeconds == 12, "A zero total cannot replace an existing duration")
        enter("9")
        let selection = NSRange(location: 0, length: 1); editor.setSelectedRange(selection); settle()
        check(editor.selectedRange() == selection && editor.string == "9", "Ordinary binding refresh preserves field selection")
        // Exercise an actual marked-text editor. Delegate delivery is explicit
        // because a synthetic IME operation is not an OS input-method session.
        editor.setMarkedText("十二", selectedRange: NSRange(location: 2, length: 0), replacementRange: NSRange(location: 0, length: 1))
        field.delegate?.controlTextDidChange?(Notification(name: NSControl.textDidChangeNotification, object: field))
        check(editor.hasMarkedText() && model.draft.focusSeconds.isComposing, "IME candidates are retained and marked as composing")
        save.performClick(nil)
        check(target.issue == .composition && store.focusSeconds == 12, "Save cannot commit an active IME candidate")
        settle()
        check(editor.hasMarkedText() && editor.string == "十二", "SwiftUI updates do not destroy the marked text")
        editor.insertText("13", replacementRange: NSRange(location: 0, length: (editor.string as NSString).length))
        field.delegate?.controlTextDidChange?(Notification(name: NSControl.textDidChangeNotification, object: field))
        save.performClick(nil)
        check(!model.draft.focusSeconds.isComposing && target.issue == nil && store.focusSeconds == 13, "A committed numeric correction can save immediately")
        enter(""); window.makeFirstResponder(nil); settle()
        check(model.draft.focusSeconds.text.isEmpty && field.stringValue.isEmpty, "Leaving an empty field cannot silently restore an old number")
        var limits = NativeQuickDurationDraft(focus: 86400, rest: 1)
        check((try? limits.validated().get()) == .init(focus: 86400, rest: 1), "Inclusive whole-day and one-second bounds")
        limits.focusSeconds.text = "1"
        check(limits.validated() == .failure(.range), "24 hours plus 1 second is explicitly invalid")
        limits.focusMinutes.text = "1441"
        check(limits.validated() == .failure(.minutes), "Out-of-range minutes are explicitly invalid")
        print("PASS: \(checks) live-field, direct-save, validation, selection and synthetic IME checks")
    }
}
`);
    const sources = ['NativeQuickUtilities.swift', 'NativeQuickWidgetContext.swift'].map(name => path.join(root, 'native/Sources/AIBro', name));
    const built = spawnSync('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', '-target', 'arm64-apple-macosx14.0', ...sources, source, '-o', binary], { encoding: 'utf8', timeout: 65000 });
    assert.equal(built.status, 0, built.stdout + built.stderr);
    const result = spawnSync(binary, [path.join(temporary, 'state')], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /PASS: \d+ live-field/);
    console.log(result.stdout.trim());
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
