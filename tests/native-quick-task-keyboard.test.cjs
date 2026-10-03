const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Compile only the production value types, without an App, GUI or task store.
// This covers the modifier classification that a SwiftUI typecheck cannot.
test('task keyboard commands reject redo/system modifiers and each row control has a distinct focus identity', { skip: process.platform !== 'darwin', timeout: 60000 }, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-task-keyboard-'));
  try {
    const source = path.join(temporary, 'KeyboardTests.swift'), binary = path.join(temporary, 'keyboard-tests');
    fs.writeFileSync(source, String.raw`
import Foundation
@main struct KeyboardTests {
    static func main() {
        for mask: UInt8 in 0..<16 {
            let modifiers = NativeQuickTaskKeyModifiers(rawValue: mask)
            for character in ["a", "A", "z", "Z"] {
                let expected: NativeQuickTaskCommand? = mask == NativeQuickTaskKeyModifiers.command.rawValue
                    ? (character.lowercased() == "a" ? .selectAll : .undo) : nil
                precondition(NativeQuickTaskCommand.match(character, modifiers: modifiers) == expected, "Unexpected command for modifier mask \(mask), key \(character)")
            }
            precondition(NativeQuickTaskCommand.match("x", modifiers: modifiers) == nil)
        }
        precondition(NativeQuickTaskCommand.match("z", modifiers: [.command, .shift]) == nil, "Redo must not undo deletion")
        precondition(NativeQuickTaskCommand.match("z", modifiers: [.command, .option]) == nil)
        precondition(NativeQuickTaskCommand.match("z", modifiers: [.command, .control]) == nil)
        let selection = NativeQuickTaskRowFocus(taskID: "stable-task", control: .selection)
        let title = NativeQuickTaskRowFocus(taskID: "stable-task", control: .title)
        let other = NativeQuickTaskRowFocus(taskID: "other-task", control: .title)
        precondition(selection != title && Set([selection, title, other]).count == 3, "Focusable controls must not share one binding value")
        precondition(selection.taskID == title.taskID, "Both controls resolve the same task for the shared row handler")
        print("PASS: 16 modifier masks, 64 command cases, distinct control identities sharing a stable row ID")
    }
}
`);
    const production = path.resolve(__dirname, '../native/Sources/AIBro/NativeQuickTaskLifecycle.swift');
    const compiled = spawnSync('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', production, source, '-o', binary], { encoding: 'utf8', timeout: 45000 });
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr + (compiled.error?.message ?? ''));
    const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message ?? ''));
    assert.match(result.stdout, /PASS: 16 modifier masks/);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
