const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('hosted capture editor has a real hit target and acquires input before selection in a nonactivating panel', {
  skip: process.platform !== 'darwin', timeout: 90000,
}, () => {
  const root = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-capture-layout-'));
  try {
    const source = path.join(temporary, 'LayoutTests.swift'), binary = path.join(temporary, 'layout-tests');
    fs.writeFileSync(source, String.raw`
import AppKit
import SwiftUI
func nativeUI(_ zh: String, _ en: String) -> String { en }
@MainActor final class Model: ObservableObject {
    @Published var text = ""
    @Published var recordID = "first"
    @Published var width: CGFloat = 320
    @Published var height: CGFloat = 90
    @Published var focusTarget = ""
    @Published var otherText = ""
    var observedCaptureFocus = false
    var observedOtherFocus = false
    var prepareInput: () -> Void = {}
}
struct Host: View {
    @ObservedObject var model: Model
    @State private var captureFocused = false
    @FocusState private var otherFocused: Bool
    var body: some View {
        VStack {
            NativeQuickCaptureTextEditor(text: $model.text, focused: $captureFocused, label: "Capture test", onFocus: { model.prepareInput() })
                .id(model.recordID).frame(width: model.width, height: model.height)
            TextField("Other SwiftUI field", text: $model.otherText).focused($otherFocused)
        }
        .onChange(of: captureFocused) { _, value in model.observedCaptureFocus = value }
        .onChange(of: otherFocused) { _, value in model.observedOtherFocus = value }
        .onChange(of: model.focusTarget) { _, value in
            otherFocused = value == "other"
            captureFocused = value == "capture"
        }
    }
}
final class TestPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}
@main struct LayoutTests {
    @MainActor static func main() {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        let panel = TestPanel(contentRect: NSRect(x: 0, y: 0, width: 620, height: 260), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        let root = NSView(frame: panel.contentLayoutRect)
        panel.contentView = root
        let model = Model()
        let hosted = NSHostingView(rootView: Host(model: model))
        hosted.frame = NSRect(x: 0, y: 0, width: 320, height: 160)
        root.addSubview(hosted)
        panel.makeKey()
        func settle() { root.layoutSubtreeIfNeeded(); RunLoop.current.run(until: Date().addingTimeInterval(0.35)); root.layoutSubtreeIfNeeded() }
        func findEditor(_ view: NSView) -> NativeQuickCaptureTextView? {
            if let value = view as? NativeQuickCaptureTextView { return value }
            return view.subviews.lazy.compactMap { findEditor($0) }.first
        }
        var checks = 0
        func check(_ condition: @autoclosure () -> Bool, _ message: String) {
            checks += 1; precondition(condition(), message)
        }
        settle()
        guard let editor = findEditor(hosted), let scroll = editor.enclosingScrollView else { fatalError("Production hosted editor not found") }
        check(!panel.isVisible, "Test must never present a window")
        check(editor.frame.width >= 300 && editor.frame.height >= 90, "Empty document must fill its clip viewport")
        check(editor.minSize.height >= 90, "Native scroll document has a clickable empty height")
        let click = editor.convert(NSPoint(x: 80, y: 45), to: root)
        check(root.hitTest(click) === editor, "Clicking the body must hit NSTextView, not a zero-size scroll container")
        check(editor.acceptsFirstMouse(for: nil), "One click must be accepted while the island is inactive")
        var focusEvents: [String] = []
        model.prepareInput = { focusEvents.append("prepare") }
        let originalFocusChanged = editor.focusChanged
        editor.focusChanged = { focused in
            if focused { focusEvents.append("accepted") }
            originalFocusChanged?(focused)
        }
        check(panel.makeFirstResponder(editor), "Native text editor accepts responder ownership")
        check(focusEvents.first == "prepare" && focusEvents.last == "accepted", "Activation callback must precede accepted text focus")
        // Real app regression: focus was accepted and then cleared by the next
        // SwiftUI refresh, before the user's first character arrived. Wait for
        // that refresh and route keys through NSWindow, never straight to view.
        model.width = 319
        settle()
        check(panel.firstResponder === editor && model.observedCaptureFocus, "SwiftUI refresh must retain real native focus before the first key")
        let typed = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: panel.windowNumber, context: nil, characters: "x", charactersIgnoringModifiers: "x", isARepeat: false, keyCode: 7)!
        panel.sendEvent(typed)
        settle()
        check(editor.string == "x" && model.text == "x", "Actual key interpretation updates the production SwiftUI binding")

        // A pending SwiftUI refresh cannot reclaim focus from another field.
        model.width = 300
        model.focusTarget = "other"
        settle()
        check(model.observedOtherFocus && !model.observedCaptureFocus, "Actual SwiftUI FocusState can take focus from the AppKit editor")
        let nextResponder = panel.firstResponder
        model.height = 89
        settle()
        check(panel.firstResponder === nextResponder && panel.firstResponder !== editor, "Delayed editor update must not steal focus from another control")
        panel.sendEvent(typed)
        settle()
        check(model.otherText == "x" && model.text == "x", "Window keyboard routing goes to the SwiftUI field after focus changes")
        check(editor.frame.width >= 280 && editor.frame.width <= 300, "Resized editor tracks the viewport width")
        model.height = 45
        hosted.setFrameSize(NSSize(width: 300, height: 110))
        settle()
        check(editor.frame.height >= 45 && scroll.contentSize.height >= 45, "Compact home layout retains an input hit area")

        model.focusTarget = "capture"
        settle()
        check(panel.firstResponder === editor && model.observedCaptureFocus && !model.observedOtherFocus, "Programmatic capture focus works alongside a real SwiftUI FocusState field")
        editor.setSelectedRange(NSRange(location: 0, length: editor.string.utf16.count))
        editor.undoManager?.beginUndoGrouping()
        check(editor.format(.bold), "Formatting remains available after native layout/focus transitions")
        editor.undoManager?.endUndoGrouping()
        check(editor.undoManager?.canUndo == true, "First record has its own undo history")
        let retainedText = model.text
        model.recordID = "second-with-same-body"
        settle()
        guard let replacement = findEditor(hosted) else { fatalError("Replacement editor not found") }
        check(replacement !== editor && replacement.string == retainedText, "Record identity creates a new editor even when body text is identical")
        check(replacement.undoManager?.canUndo == false, "Second record cannot undo edits to the first")
        model.focusTarget = ""
        settle()
        check(panel.firstResponder !== replacement && !model.observedCaptureFocus, "Explicit blur still releases native input")
        check(!panel.isVisible, "No GUI window was shown during verification")
        print("PASS: \(checks) hosted capture layout, input, focus and identity assertions")
    }
}
`);
    const compiled = spawnSync('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5',
      path.join(root, 'native/Sources/AIBro/NativeQuickCaptureMarkup.swift'),
      path.join(root, 'native/Sources/AIBro/NativeQuickCaptureScrollView.swift'),
      path.join(root, 'native/Sources/AIBro/NativeQuickCaptureTextEditor.swift'), source, '-o', binary,
    ], { encoding: 'utf8', timeout: 60000 });
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr + (compiled.error?.message ?? ''));
    const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message ?? ''));
    assert.match(result.stdout, /PASS: \d+ hosted capture layout/);
    process.stdout.write(result.stdout);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
