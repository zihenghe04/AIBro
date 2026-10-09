const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('capture undo is available through the responder menu and Cmd-Z without sharing records', {
  skip: process.platform !== 'darwin', timeout: 90000,
}, () => {
  const root = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-capture-undo-routing-'));
  try {
    const source = path.join(temporary, 'UndoRoutingTests.swift'), binary = path.join(temporary, 'undo-routing-tests');
    fs.writeFileSync(source, String.raw`
import AppKit
import SwiftUI
func nativeUI(_ zh: String, _ en: String) -> String { en }
@MainActor final class Model: ObservableObject {
    @Published var text = "Compare"
    @Published var recordID = "first"
    @Published var locked = false
}
struct Host: View {
    @ObservedObject var model: Model
    @State private var captureFocused = true
    var body: some View {
        NativeQuickCaptureTextEditor(text: $model.text, focused: $captureFocused,
            locked: model.locked, label: "Capture undo test")
            .id(model.recordID).frame(width: 320, height: 90)
    }
}
final class TestPanel: NSPanel { override var canBecomeKey: Bool { true } }
final class TestApplication: NSApplication {
    weak var testKeyWindow: NSWindow?
    // A never-shown panel cannot become the OS key window. Supply only that
    // outer application lookup; leave AppKit's responder/action resolution,
    // menu validation and key equivalents intact.
    override var keyWindow: NSWindow? { testKeyWindow ?? super.keyWindow }
}
@main struct UndoRoutingTests {
    @MainActor static func main() {
        let app = TestApplication.shared as! TestApplication
        NSApp.setActivationPolicy(.prohibited)
        let panel = TestPanel(contentRect: NSRect(x: 0, y: 0, width: 320, height: 90),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        let model = Model()
        let host = NSHostingView(rootView: Host(model: model))
        panel.contentView = host
        panel.makeKey()
        app.testKeyWindow = panel
        let mainMenu = NSMenu(title: "Main")
        let edit = NSMenu(title: "Edit")
        let editItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        editItem.submenu = edit
        mainMenu.addItem(editItem)
        let undo = NSMenuItem(title: "Undo", action: NSSelectorFromString("undo:"), keyEquivalent: "z")
        let redo = NSMenuItem(title: "Redo", action: NSSelectorFromString("redo:"), keyEquivalent: "Z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(undo); edit.addItem(redo)
        NSApp.mainMenu = mainMenu
        func settle() {
            host.layoutSubtreeIfNeeded()
            RunLoop.current.run(until: Date().addingTimeInterval(0.15))
            host.layoutSubtreeIfNeeded(); edit.update()
        }
        func findEditor(_ view: NSView) -> NativeQuickCaptureTextView? {
            if let editor = view as? NativeQuickCaptureTextView { return editor }
            return view.subviews.lazy.compactMap { findEditor($0) }.first
        }
        var checks = 0
        var failures: [String] = []
        func check(_ condition: @autoclosure () -> Bool, _ message: String) {
            checks += 1
            if !condition() { failures.append(message) }
        }
        func command(_ character: String, shift: Bool = false) -> Bool {
            let event = NSEvent.keyEvent(with: .keyDown, location: .zero,
                modifierFlags: shift ? [.command, .shift] : [.command], timestamp: 0,
                windowNumber: panel.windowNumber, context: nil, characters: shift ? character.uppercased() : character,
                charactersIgnoringModifiers: shift ? character.uppercased() : character, isARepeat: false,
                keyCode: character == "b" ? 11 : 6)!
            // Like AppKit dispatch, offer standard shortcuts to the main menu
            // then the key window. Never invoke UndoManager or textView.undo.
            return mainMenu.performKeyEquivalent(with: event) || panel.performKeyEquivalent(with: event)
        }
        settle()
        guard let editor = findEditor(host) else { fatalError("Missing hosted production editor") }
        // The fixture is never ordered on screen, so arrange its responder explicitly.
        // Menu dispatch, validation and native undo remain production behavior.
        check(panel.makeFirstResponder(editor), "Hidden fixture accepts the production editor")
        edit.update()
        check(NSApp.keyWindow === panel, "The hidden panel must be the application action-routing fixture")
        check(panel.firstResponder === editor, "Production editor must be the actual first responder")
        check(!undo.isEnabled && !redo.isEnabled, "A fresh editor has no menu history")
        editor.setSelectedRange(NSRange(location: 0, length: 7))
        check(command("b"), "Cmd-B routes through the key window")
        settle()
        check(model.text == "**Compare**", "Formatting updates the bound record")
        check(editor.undoManager?.canUndo == true, "The editor has registered its native undo transaction")
        check(NSApp.target(forAction: undo.action!, to: nil, from: undo) as AnyObject? === editor,
            "The Undo menu must resolve to the editor's isolated history")
        check(undo.isEnabled && !redo.isEnabled, "Undo validation uses the active editor's history")
        check(command("z"), "Cmd-Z is handled through the real menu/key-window route")
        settle()
        check(model.text == "Compare", "Cmd-Z reverses Markdown formatting in the binding")
        check(!undo.isEnabled && redo.isEnabled, "Redo becomes enabled after Cmd-Z")
        check(command("z", shift: true), "Shift-Cmd-Z is handled through the menu/key-window route")
        settle()
        check(model.text == "**Compare**" && undo.isEnabled && !redo.isEnabled, "Redo restores the bound content and menu state: body=\(model.text), undo=\(undo.isEnabled), redo=\(redo.isEnabled)")
        model.locked = true
        settle()
        panel.makeFirstResponder(editor)
        edit.update()
        check(!undo.isEnabled && !redo.isEnabled, "Saving-locked editor cannot mutate through Edit menu")
        model.locked = false
        settle()
        panel.makeFirstResponder(editor)
        edit.update()
        check(undo.isEnabled, "Same record keeps its undo history across a SwiftUI update")
        let retainedText = model.text
        model.recordID = "second-same-body"
        settle()
        guard let next = findEditor(host) else { fatalError("Missing replacement editor") }
        panel.makeFirstResponder(next)
        edit.update()
        check(next !== editor && next.string == retainedText, "A different record has its own editor even for identical text")
        check(!undo.isEnabled && !redo.isEnabled, "A new record exposes no other record's undo or redo")
        _ = command("z")
        settle()
        check(model.text == retainedText, "Cmd-Z cannot modify the new record using another record's transaction")
        check(!panel.isVisible, "No test window was ever presented")
        if !failures.isEmpty {
            print("FAILED: " + failures.joined(separator: " | "))
            exit(1)
        }
        print("PASS: \(checks) hosted capture undo routing and menu assertions")
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
    assert.match(result.stdout, /PASS: \d+ hosted capture undo routing/);
    process.stdout.write(result.stdout);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
