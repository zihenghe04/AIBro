const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('capture Markdown editing retains list semantics, UTF-16 selections, IME and native undo', {
  skip: process.platform !== 'darwin', timeout: 90000,
}, () => {
  const root = path.resolve(__dirname, '..');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-capture-markup-'));
  try {
    const source = path.join(temporary, 'MarkupTests.swift'), binary = path.join(temporary, 'markup-tests');
    fs.writeFileSync(source, String.raw`
import Foundation
import AppKit
func nativeUI(_ zh: String, _ en: String) -> String { en }

@main struct MarkupTests {
    @MainActor static func main() {
        typealias M = NativeQuickCaptureMarkup
        var assertions = 0
        func check(_ value: @autoclosure () -> Bool, _ message: String) {
            assertions += 1
            precondition(value(), message)
        }
        func changed(_ text: String, _ edit: M.Edit) -> String {
            (text as NSString).replacingCharacters(in: edit.range, with: edit.replacement)
        }
        for (source, expected) in [
            ("- first", "- first\n- "),
            ("  + first", "  + first\n  - "),
            ("\t* nested", "\t* nested\n\t- "),
            ("- [x] done", "- [x] done\n- [ ] "),
            ("* [X] 中文 🌱", "* [X] 中文 🌱\n- [ ] "),
            ("9) ninth", "9) ninth\n10. "),
            ("  01. item", "  01. item\n  2. "),
            ("> quote", "> quote\n> "),
            ("  > quote", "  > quote\n  > "),
            ("- ", ""),
            ("  - [ ] ", "  "),
            ("8. ", ""),
            ("> ", ""),
            ("before\n  * \n", "before\n  \n"),
        ] {
            let cursor = source.hasSuffix("\n") ? source.utf16.count - 1 : source.utf16.count
            guard let edit = M.continueList(text: source, selection: NSRange(location: cursor, length: 0)) else { fatalError(source) }
            check(changed(source, edit) == expected, "Wrong list edit: \(source)")
            check(edit.selection.length == 0 && edit.selection.location <= expected.utf16.count, "Caret must remain valid")
        }
        let split = "- first second"
        let splitEdit = M.continueList(text: split, selection: NSRange(location: 7, length: 0))!
        check(changed(split, splitEdit) == "- first\n-  second", "Split body without dropping following text")
        check(M.continueList(text: "- first", selection: NSRange(location: 1, length: 0)) == nil, "A marker is not body text")
        check(M.continueList(text: "- first", selection: NSRange(location: 2, length: 5)) == nil, "Selected text must use normal Return")
        check(M.continueList(text: "18446744073709551615. large", selection: NSRange(location: 27, length: 0)) == nil, "An oversized counter must not trap")
        check(M.continueList(text: "plain text", selection: NSRange(location: 10, length: 0)) == nil, "Do not turn ordinary text into lists")

        let original = "开头 🌱 中文结尾"
        let selected = (original as NSString).range(of: "🌱 中文")
        let bold = M.inline(.bold, text: original, selection: selected, placeholder: "Bold")!
        let boldText = changed(original, bold)
        check(boldText == "开头 **🌱 中文**结尾", "Selected UTF-16 text must remain exact")
        check((boldText as NSString).substring(with: bold.selection) == "🌱 中文", "Select original body inside inserted markers")
        let unbold = M.inline(.bold, text: boldText, selection: bold.selection, placeholder: "Bold")!
        check(changed(boldText, unbold) == original && unbold.selection == selected, "Second shortcut toggles outer markers")
        let whole = M.inline(.italic, text: "*中文*", selection: NSRange(location: 0, length: 4), placeholder: "Italic")!
        check(changed("*中文*", whole) == "中文", "Selected whole markup unwraps")
        let empty = M.inline(.bold, text: "", selection: NSRange(location: 0, length: 0), placeholder: "加粗文字")!
        check(empty.replacement == "**加粗文字**" && empty.selection == NSRange(location: 2, length: 4), "Empty caret selects localized placeholder")
        check(M.inline(.bold, text: "🌱", selection: NSRange(location: 1, length: 0), placeholder: "x") == nil, "Never split a surrogate pair")
        check(M.inline(.bold, text: "x", selection: NSRange(location: NSNotFound, length: 0), placeholder: "x") == nil, "Reject stale native selection")
        check(M.inline(.bold, text: "x", selection: NSRange(location: 1, length: Int.max), placeholder: "x") == nil, "Reject overflowing selection length")
        check(M.inline(.bold, text: "x", selection: NSRange(location: -1, length: 0), placeholder: "x") == nil, "Reject negative selection offset")
        check(M.inline(.bold, text: "x", selection: NSRange(location: 0, length: -1), placeholder: "x") == nil, "Reject negative selection length")
        let star = M.inline(.italic, text: "*", selection: NSRange(location: 0, length: 1), placeholder: "x")!
        check(changed("*", star) == "***", "Overlapping markers cannot erase content")

        // Native QA caught Cmd-I treating the inner star of **bold** as an
        // existing italic delimiter. Test both body-only and whole selections.
        for (source, style, selection, expected) in [
            ("**Compare**", M.Inline.italic, NSRange(location: 2, length: 7), "***Compare***"),
            ("***Compare***", M.Inline.italic, NSRange(location: 3, length: 7), "**Compare**"),
            ("*Compare*", M.Inline.bold, NSRange(location: 1, length: 7), "***Compare***"),
            ("***Compare***", M.Inline.bold, NSRange(location: 3, length: 7), "*Compare*"),
            ("**Compare**", M.Inline.italic, NSRange(location: 0, length: 11), "***Compare***"),
            ("***Compare***", M.Inline.italic, NSRange(location: 0, length: 13), "**Compare**"),
            ("*Compare*", M.Inline.bold, NSRange(location: 0, length: 9), "***Compare***"),
            ("***Compare***", M.Inline.bold, NSRange(location: 0, length: 13), "*Compare*"),
            ("***Compare***", M.Inline.italic, NSRange(location: 2, length: 9), "**Compare**"),
            ("***Compare***", M.Inline.bold, NSRange(location: 1, length: 11), "*Compare*"),
        ] {
            let edit = M.inline(style, text: source, selection: selection, placeholder: "text")!
            check(changed(source, edit) == expected, "Cross-format shortcut preserves the other emphasis: \(source), \(style), \(selection)")
        }

        // Production NSTextView, no window or application launch. These are
        // editing transactions, not live keyboard/IME acceptance.
        let editor = NativeQuickCaptureTextView(frame: .zero)
        editor.isRichText = false
        editor.allowsUndo = true
        editor.string = "- [x] done"
        editor.setSelectedRange(NSRange(location: editor.string.utf16.count, length: 0))
        editor.undoManager?.beginUndoGrouping()
        editor.insertNewline(nil)
        editor.undoManager?.endUndoGrouping()
        check(editor.string == "- [x] done\n- [ ] ", "Production Return must use the transformer")
        check(editor.undoManager?.canUndo == true, "List continuation must have a native undo")
        editor.undoManager?.undo()
        check(editor.string == "- [x] done", "One undo removes the whole generated prefix")
        editor.undoManager?.redo()
        check(editor.string == "- [x] done\n- [ ] ", "Redo restores exact list edit")
        editor.string = "中文 🌱"
        editor.undoManager?.removeAllActions()
        editor.setSelectedRange(NSRange(location: 0, length: editor.string.utf16.count))
        editor.undoManager?.beginUndoGrouping()
        check(editor.format(.bold), "Editable selected text can be formatted")
        editor.undoManager?.endUndoGrouping()
        check(editor.string == "**中文 🌱**", "Actual NSTextView preserves Unicode selection")
        editor.undoManager?.undo()
        check(editor.string == "中文 🌱", "Formatting is one undo transaction")
        editor.isEditable = false
        check(!editor.format(.italic) && editor.string == "中文 🌱", "ACK lock prevents formatting writes")
        editor.isEditable = true
        editor.setSelectedRange(NSRange(location: editor.string.utf16.count, length: 0))
        editor.setMarkedText("输入", selectedRange: NSRange(location: 2, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        let composing = editor.string, marked = editor.markedRange()
        check(editor.hasMarkedText(), "Fixture has an actual marked range")
        check(!editor.format(.bold) && editor.string == composing && editor.markedRange() == marked, "Formatting must leave the composition intact")
        editor.unmarkText()
        print("PASS: \(assertions) capture Markdown and native editing assertions")
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
    assert.match(result.stdout, /PASS: \d+ capture Markdown and native editing assertions/);
    process.stdout.write(result.stdout);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
