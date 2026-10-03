const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const production = path.resolve(__dirname, '../native/Sources/AIBro/NativeQuickUtilities.swift');

// Compile the production store. A controlled wall clock covers sleep/restart
// without waiting, and injected copy/notification callbacks cannot touch the
// real clipboard, play a sound, or execute any command text.
const harness = String.raw`
import Foundation
import Combine
import AppKit
import SwiftUI

func nativeUI(_ zh: String, _ en: String) -> String { en }
enum CheckFailure: Error, CustomStringConvertible {
    case failed(String)
    var description: String { switch self { case .failed(let text): return text } }
}
func check(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try condition() == false { throw CheckFailure.failed(message) }
}
func stateFile(_ directory: URL) -> URL { directory.appendingPathComponent("native-quick-utilities.json") }
func draftFile(_ directory: URL) -> URL { directory.appendingPathComponent("native-quick-command-draft.json") }
func objectAt(_ file: URL) throws -> [String: Any] {
    guard let value = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any] else { throw CheckFailure.failed("Expected durable JSON object") }
    return value
}

@main struct UtilitiesTests {
    @MainActor static func main() {
        do {
            let name = CommandLine.arguments[1], directory = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try run(name, directory)
            print("PASS: " + name)
        } catch {
            FileHandle.standardError.write(Data(("FAIL: \(error)\n").utf8)); exit(1)
        }
    }

    @MainActor static func run(_ name: String, _ directory: URL) throws {
        var now = Date(timeIntervalSince1970: 2_000_000_000)
        let file = stateFile(directory), draft = draftFile(directory)
        switch name {
        case "deadline-and-no-per-second-writes":
            var writes = 0, notifications = 0
            let store = NativeQuickUtilitiesStore(now: { now }, write: { data, url in writes += 1; try data.write(to: url, options: .atomic) }, copy: { _ in false }, notify: { _ in notifications += 1 }, schedulesTimers: false)
            store.configure(directory: directory); store.setVisible(true)
            try check(store.ready && store.configurePomodoro(focusSeconds: 60, restSeconds: 30), "Valid configuration must become ready")
            try check(store.startPomodoro(phase: .focus), "Explicit focus start must succeed")
            let deadline = now.addingTimeInterval(60), beforeTicks = writes
            try check(store.deadline == deadline && store.status.rawValue == "running", "Deadline uses wall clock, not a decrementing counter")
            for second in 1...12 { now = deadline.addingTimeInterval(Double(second - 60)); store.tick() }
            try check(store.remainingSeconds == 48 && writes == beforeTicks && notifications == 0, "Visible ticks update display without per-second writes or notification")

        case "sleep-and-completion-once":
            var writes = 0, phases: [NativeQuickPomodoroPhase] = []
            let store = NativeQuickUtilitiesStore(now: { now }, write: { data, url in writes += 1; try data.write(to: url, options: .atomic) }, copy: { _ in false }, notify: { phase in
                let text = (try? String(contentsOf: file, encoding: .utf8)) ?? ""
                if !text.contains("\"completed\"") { fatalError("Notification preceded durable completion") }
                phases.append(phase)
            }, schedulesTimers: false)
            store.configure(directory: directory); store.setVisible(true)
            try check(store.configurePomodoro(focusSeconds: 10, restSeconds: 5) && store.startPomodoro(phase: .focus), "Start short focus")
            now = now.addingTimeInterval(600); store.tick()
            try check(store.status.rawValue == "completed" && store.remainingSeconds == 0 && store.deadline == nil, "Long sleep must settle against real deadline")
            try check(store.completion != nil && phases == [.focus], "Exactly one completed focus notification is emitted")
            let completedWrites = writes
            for _ in 0..<10 { now = now.addingTimeInterval(100); store.tick() }
            try check(writes == completedWrites && phases == [.focus], "Repeated ticks cannot re-persist or re-notify completion")

        case "hidden-countdown":
            var notifications = 0
            let store = NativeQuickUtilitiesStore(now: { now }, copy: { _ in false }, notify: { _ in notifications += 1 }, schedulesTimers: false)
            store.configure(directory: directory); store.setVisible(true)
            try check(store.configurePomodoro(focusSeconds: 20, restSeconds: 5) && store.startPomodoro(), "Start visible timer")
            store.setVisible(false)
            let hiddenRemaining = store.remainingSeconds
            var published: [Int] = []
            let subscription = store.$remainingSeconds.dropFirst().sink { published.append($0) }
            now = now.addingTimeInterval(7); store.tick()
            try check(store.remainingSeconds == hiddenRemaining && published.isEmpty, "Hidden ticking must not publish a per-second countdown")
            store.setVisible(true)
            try check(store.remainingSeconds == 13, "Reopening immediately catches up to the original deadline")
            store.setVisible(false); now = now.addingTimeInterval(30); store.tick()
            try check(store.status.rawValue == "completed" && notifications == 1, "Hidden UI still settles and notifies real completion")
            withExtendedLifetime(subscription) {}

        case "pause-resume-excludes-paused-time":
            let store = NativeQuickUtilitiesStore(now: { now }, copy: { _ in false }, notify: { _ in }, schedulesTimers: false)
            store.configure(directory: directory); store.setVisible(true)
            try check(store.configurePomodoro(focusSeconds: 60, restSeconds: 30) && store.startPomodoro(phase: .focus), "Start focus")
            now = now.addingTimeInterval(13)
            try check(store.pausePomodoro(), "Pause must use current clock even before next tick")
            try check(store.status.rawValue == "paused" && store.remainingSeconds == 47 && store.deadline == nil, "Pause retains remaining duration")
            now = now.addingTimeInterval(3600); store.tick()
            try check(store.remainingSeconds == 47 && store.status.rawValue == "paused", "Paused time cannot count toward focus")
            try check(store.resumePomodoro() && store.deadline == now.addingTimeInterval(47), "Resume creates a new deadline from remaining duration")
            now = now.addingTimeInterval(10); store.tick()
            try check(store.remainingSeconds == 37, "Resumed countdown retains actual remaining time")

        case "restart-running-and-overdue":
            var notifications = 0
            let first = NativeQuickUtilitiesStore(now: { now }, copy: { _ in false }, notify: { _ in notifications += 1 }, schedulesTimers: false)
            first.configure(directory: directory)
            try check(first.configurePomodoro(focusSeconds: 20, restSeconds: 5) && first.startPomodoro(phase: .focus), "Persist running timer")
            let originalDeadline = first.deadline
            now = now.addingTimeInterval(6)
            let restored = NativeQuickUtilitiesStore(now: { now }, copy: { _ in false }, notify: { _ in notifications += 1 }, schedulesTimers: false)
            restored.configure(directory: directory); restored.setVisible(true)
            try check(restored.status.rawValue == "running" && restored.deadline == originalDeadline && restored.remainingSeconds == 14, "Restart preserves deadline rather than starting a fresh duration")
            now = now.addingTimeInterval(100)
            let overdue = NativeQuickUtilitiesStore(now: { now }, copy: { _ in false }, notify: { _ in notifications += 1 }, schedulesTimers: false)
            overdue.configure(directory: directory)
            try check(overdue.status.rawValue == "completed" && notifications == 1, "Overdue restart settles exactly once")
            let repeated = NativeQuickUtilitiesStore(now: { now }, copy: { _ in false }, notify: { _ in notifications += 1 }, schedulesTimers: false)
            repeated.configure(directory: directory); repeated.tick()
            try check(repeated.status.rawValue == "completed" && notifications == 1, "Already saved completion cannot notify again after restart")

        case "phase-acknowledgement-and-config":
            var phases: [NativeQuickPomodoroPhase] = []
            let store = NativeQuickUtilitiesStore(now: { now }, copy: { _ in false }, notify: { phases.append($0) }, schedulesTimers: false)
            store.configure(directory: directory); store.setVisible(true)
            try check(store.configurePomodoro(focusSeconds: 10, restSeconds: 4) && store.startPomodoro(phase: .focus), "Start focus")
            let firstDeadline = store.deadline
            try check(store.configurePomodoro(focusSeconds: 30, restSeconds: 8), "Update defaults during running timer")
            try check(store.deadline == firstDeadline && store.phase == .focus, "Configuration cannot rewrite an active duration")
            now = now.addingTimeInterval(11); store.tick()
            try check(store.acknowledgeCompletion() && store.completion == nil && store.status.rawValue == "completed" && store.remainingSeconds == 0, "Acknowledgement only dismisses completion; it cannot start another phase")
            now = now.addingTimeInterval(100); store.tick()
            try check(store.status.rawValue == "completed" && phases == [.focus], "No automatic phase loop")
            try check(store.startPomodoro() && store.phase == .rest && store.deadline == now.addingTimeInterval(8), "Explicit next start selects rest using new defaults")
            try check(store.resetPomodoro() && store.status.rawValue == "idle" && store.deadline == nil, "Reset is an explicit durable transition")
            for (focus, rest) in [(0, 1), (1, 0), (-1, 10), (86_401, 10), (10, 86_401)] {
                try check(!store.configurePomodoro(focusSeconds: focus, restSeconds: rest), "Out-of-range settings must be rejected without truncating")
            }
            try check(store.configurePomodoro(focusSeconds: 1, restSeconds: 86_400), "Both inclusive configuration boundaries are supported")

        case "timer-write-failure":
            var failWrites = false, notifications = 0
            let store = NativeQuickUtilitiesStore(now: { now }, write: { data, url in if failWrites { throw CocoaError(.fileWriteOutOfSpace) }; try data.write(to: url, options: .atomic) }, copy: { _ in false }, notify: { _ in notifications += 1 }, schedulesTimers: false)
            store.configure(directory: directory); store.setVisible(true)
            try check(store.configurePomodoro(focusSeconds: 5, restSeconds: 2), "Persist defaults")
            failWrites = true
            try check(!store.startPomodoro() && store.status.rawValue == "idle" && store.deadline == nil, "Failed start cannot show an unpersisted active timer")
            failWrites = false; try check(store.startPomodoro(), "Start after storage recovers")
            now = now.addingTimeInterval(10); failWrites = true; store.tick()
            try check(store.status.rawValue != "completed" && notifications == 0 && store.error != nil, "Completion cannot notify before storage accepts transition")
            failWrites = false; now = now.addingTimeInterval(5); store.tick()
            try check(store.status.rawValue == "completed" && notifications == 1, "Recovering persistence settles the same completion once")

        case "draft-hide-restart":
            let first = NativeQuickUtilitiesStore(now: { now }, copy: { _ in false }, notify: { _ in }, schedulesTimers: false)
            first.configure(directory: directory)
            try check(first.startEditingCommand(), "Start new command draft")
            let text = "  printf '%s\\n' 'synthetic 🌱'\n# Preserve exact draft whitespace  "
            first.commandDraft = text; first.setVisible(false)
            try check(!first.hasUnpersistedChanges && first.flushPendingDraft(), "Draft setter persists independently of panel visibility")
            let before = try Data(contentsOf: draft)
            let restored = NativeQuickUtilitiesStore(now: { now }, copy: { _ in false }, notify: { _ in }, schedulesTimers: false)
            restored.configure(directory: directory)
            try check(restored.isEditingCommand && restored.commandDraft == text && restored.commands.isEmpty, "Restart restores exact unsaved input without saving a command")
            restored.setVisible(false)
            try check(try Data(contentsOf: draft) == before, "Hiding does not rewrite or discard draft")

        case "command-crud-and-edit-guard":
            let store = NativeQuickUtilitiesStore(now: { now }, copy: { _ in false }, notify: { _ in }, schedulesTimers: false)
            store.configure(directory: directory)
            try check(store.startEditingCommand(), "Start first command")
            store.commandDraft = "echo synthetic-one"
            try check(store.saveCommand() && store.commands.count == 1 && !store.isEditingCommand, "Save creates one durable command and closes editor")
            let firstID = store.commands[0].id, firstCreated = store.commands[0].createdAt
            now = now.addingTimeInterval(10)
            try check(store.startEditingCommand(id: firstID), "Edit existing item")
            store.commandDraft = "echo synthetic-one-edited"
            _ = store.startEditingCommand(id: firstID)
            try check(store.commandDraft == "echo synthetic-one-edited", "Clicking the same command again must not replace its unsaved draft")
            try check(!store.startEditingCommand(), "Starting another editor must not discard changed draft")
            try check(store.saveCommand() && store.commands.count == 1, "Editing changes the same saved item")
            try check(store.commands[0].id == firstID && store.commands[0].createdAt == firstCreated && store.commands[0].text == "echo synthetic-one-edited", "Stable identity and creation time survive edits")
            try check(store.startEditingCommand(), "Start second command")
            store.commandDraft = "echo synthetic-two"
            try check(store.saveCommand() && store.commands.count == 2, "Second distinct item is saved")
            let ids = Set(store.commands.map(\.id))
            try check(store.deleteCommands(ids: ids) && store.commands.isEmpty, "Explicit batch deletion removes only selected commands")
            let reopened = NativeQuickUtilitiesStore(now: { now }, copy: { _ in false }, notify: { _ in }, schedulesTimers: false)
            reopened.configure(directory: directory)
            try check(reopened.commands.isEmpty, "Deletion survives restart")

        case "command-save-failure-same-id":
            var failMain = false
            let store = NativeQuickUtilitiesStore(now: { now }, write: { data, url in if failMain && url.lastPathComponent == file.lastPathComponent { throw CocoaError(.fileWriteOutOfSpace) }; try data.write(to: url, options: .atomic) }, copy: { _ in false }, notify: { _ in }, schedulesTimers: false)
            store.configure(directory: directory)
            try check(store.startEditingCommand(), "Begin stable new draft")
            store.commandDraft = "echo retry-only-once"
            let priorDraft = try objectAt(draft)
            failMain = true
            try check(!store.saveCommand() && store.isEditingCommand && store.commandDraft == "echo retry-only-once" && store.commands.isEmpty, "Failed save preserves editable draft without false new row")
            let retriedDraft = try objectAt(draft)
            try check(NSDictionary(dictionary: priorDraft).isEqual(to: retriedDraft), "Retry retains its durable draft identity and text regardless of JSON key ordering")
            failMain = false
            try check(store.saveCommand() && store.commands.count == 1, "Retry creates exactly one command")
            let id = store.commands[0].id
            try check(!store.saveCommand() && store.commands.count == 1 && store.commands[0].id == id, "Repeated save after close cannot duplicate a command")

        case "command-write-then-throw":
            var uncertainMain = false
            let store = NativeQuickUtilitiesStore(now: { now }, write: { data, url in try data.write(to: url, options: .atomic); if uncertainMain && url.lastPathComponent == file.lastPathComponent { throw CocoaError(.fileWriteUnknown) } }, copy: { _ in false }, notify: { _ in }, schedulesTimers: false)
            store.configure(directory: directory); try check(store.startEditingCommand(), "Begin new draft")
            store.commandDraft = "echo committed-but-unconfirmed"; uncertainMain = true
            try check(!store.saveCommand() && store.isEditingCommand && store.commands.count == 1, "Read-back recognizes a written candidate but retains retry draft after writer error")
            let firstID = store.commands[0].id
            uncertainMain = false
            try check(store.saveCommand() && store.commands.count == 1 && store.commands[0].id == firstID, "Same-ID retry cannot duplicate an already written command")

        case "draft-write-failure-and-flush":
            var failDraft = false
            let store = NativeQuickUtilitiesStore(now: { now }, write: { data, url in if failDraft && url.lastPathComponent == draft.lastPathComponent { throw CocoaError(.fileWriteOutOfSpace) }; try data.write(to: url, options: .atomic) }, copy: { _ in false }, notify: { _ in }, schedulesTimers: false)
            store.configure(directory: directory); try check(store.startEditingCommand(), "Begin recoverable editor")
            store.commandDraft = "old durable draft"; failDraft = true; store.commandDraft = "new unsaved draft"
            try check(store.commandDraft == "new unsaved draft" && store.hasUnpersistedChanges && !store.flushPendingDraft(), "Failed draft write keeps newest input in memory and exposes unsaved state")
            failDraft = false
            try check(store.flushPendingDraft() && !store.hasUnpersistedChanges, "Explicit retry resolves draft durability")
            let restored = NativeQuickUtilitiesStore(now: { now }, copy: { _ in false }, notify: { _ in }, schedulesTimers: false)
            restored.configure(directory: directory)
            try check(restored.commandDraft == "new unsaved draft", "Restart restores the repaired newest input")

        case "copy-only-and-copy-failure":
            var copied: [String] = [], allowCopy = true
            let store = NativeQuickUtilitiesStore(now: { now }, copy: { value in copied.append(value); return allowCopy }, notify: { _ in }, schedulesTimers: false)
            store.configure(directory: directory); try check(store.startEditingCommand(), "Start command")
            let text = "printf '%s' '$(this-is-text-only)'"
            store.commandDraft = text; try check(store.saveCommand(), "Save inert command text")
            let id = store.commands[0].id
            try check(store.copyCommand(id: id) && copied == [text] && store.copiedCommandID == id, "Copy sends exact text solely to injected clipboard callback")
            allowCopy = false
            try check(!store.copyCommand(id: id) && store.copiedCommandID == nil && store.error != nil, "Failed copy cannot retain a success indicator")
            try check(!store.copyCommand(id: "missing") && copied.count == 2, "Missing commands cannot copy arbitrary input")

        case "cancel-edit-and-delete-failure":
            var failMain = false
            let store = NativeQuickUtilitiesStore(now: { now }, write: { data, url in if failMain && url.lastPathComponent == file.lastPathComponent { throw CocoaError(.fileWriteOutOfSpace) }; try data.write(to: url, options: .atomic) }, copy: { _ in false }, notify: { _ in }, schedulesTimers: false)
            store.configure(directory: directory); try check(store.startEditingCommand(), "Begin first item")
            store.commandDraft = "saved text"; try check(store.saveCommand(), "Save first item")
            let id = store.commands[0].id
            try check(store.startEditingCommand(id: id), "Open existing command")
            store.commandDraft = "discard me"
            try check(store.cancelCommandEdit() && !store.isEditingCommand && store.commands[0].text == "saved text", "Explicit cancel discards only draft, not saved command")
            failMain = true
            try check(!store.deleteCommands(ids: [id]) && store.commands.count == 1 && store.commands[0].id == id, "Failed deletion retains saved row")

        case "corrupt-state-preserved":
            let bytes = Data([0x7b, 0xff, 0x00, 0x0a])
            try bytes.write(to: file)
            var writes = 0
            let store = NativeQuickUtilitiesStore(now: { now }, write: { data, url in writes += 1; try data.write(to: url, options: .atomic) }, copy: { _ in false }, notify: { _ in }, schedulesTimers: false)
            store.configure(directory: directory)
            try check(!store.ready && store.error != nil, "Corrupt main file must not silently load defaults")
            try check(!store.startPomodoro() && !store.startEditingCommand(), "Unready corrupt state refuses mutations")
            store.tick(); store.setVisible(false)
            let retained = try Data(contentsOf: file)
            try check(writes == 0 && retained == bytes, "Corrupt bytes remain untouched")

        case "corrupt-draft-preserved":
            let bytes = Data("{invalid-command-draft".utf8)
            try bytes.write(to: draft)
            var writes = 0
            let store = NativeQuickUtilitiesStore(now: { now }, write: { data, url in writes += 1; try data.write(to: url, options: .atomic) }, copy: { _ in false }, notify: { _ in }, schedulesTimers: false)
            store.configure(directory: directory)
            try check(!store.ready && store.error != nil, "Corrupt draft must not become a blank editable command")
            try check(!store.startEditingCommand(), "New editor cannot overwrite unreadable draft")
            store.commandDraft = "must not replace corrupt bytes"; store.setVisible(false)
            let retained = try Data(contentsOf: draft)
            try check(writes == 0 && retained == bytes, "Malformed draft is preserved byte-for-byte")

        case "owner-only-files":
            let store = NativeQuickUtilitiesStore(now: { now }, copy: { _ in false }, notify: { _ in }, schedulesTimers: false)
            store.configure(directory: directory)
            try check(store.configurePomodoro(focusSeconds: 20, restSeconds: 10) && store.startEditingCommand(), "Create both persistent files")
            store.commandDraft = "echo synthetic"
            for url in [file, draft] {
                let mode = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber
                try check(mode?.intValue == 0o600, "Persistent utilities and draft files must be owner-only")
                _ = try objectAt(url)
            }

        default: throw CheckFailure.failed("Unknown case: " + name)
        }
    }
}
`;

test('production native quick utilities preserve deadlines, durable drafts and inert command text', {
  skip: process.platform !== 'darwin', timeout: 180000,
}, async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-quick-utilities-'));
  try {
    const source = path.join(temporary, 'UtilitiesTests.swift'), binary = path.join(temporary, 'utilities-tests');
    fs.writeFileSync(source, harness);
    const compiled = spawnSync('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', production, path.resolve(__dirname, '../native/Sources/AIBro/NativeQuickWidgetContext.swift'), source, '-o', binary], { encoding: 'utf8', timeout: 90000 });
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr + (compiled.error?.message ?? ''));
    for (const name of ['deadline-and-no-per-second-writes', 'sleep-and-completion-once', 'hidden-countdown', 'pause-resume-excludes-paused-time', 'restart-running-and-overdue', 'phase-acknowledgement-and-config', 'timer-write-failure', 'draft-hide-restart', 'command-crud-and-edit-guard', 'command-save-failure-same-id', 'command-write-then-throw', 'draft-write-failure-and-flush', 'copy-only-and-copy-failure', 'cancel-edit-and-delete-failure', 'corrupt-state-preserved', 'corrupt-draft-preserved', 'owner-only-files']) {
      await t.test(name, () => {
        const result = spawnSync(binary, [name, path.join(temporary, name)], { encoding: 'utf8', timeout: 15000 });
        assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message ?? ''));
        assert.ok(result.stdout.includes('PASS: ' + name), result.stdout);
      });
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
