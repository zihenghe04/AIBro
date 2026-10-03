const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const production = path.join(root, 'native/Sources/AIBro/NativeQuickCaptureStore.swift');

// Compile the production store, then drive its public API in a fresh process
// and workspace for each case. The save closure stands in for the workspace's
// acknowledgement; only disk-error cases replace the store's real file writer.
const harness = String.raw`
import Foundation
import Combine

func nativeUI(_ zh: String, _ en: String) -> String { en }
enum CheckFailure: Error, CustomStringConvertible {
    case failed(String)
    var description: String { switch self { case .failed(let message): return message } }
}
func check(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try condition() == false { throw CheckFailure.failed(message) }
}
func draftFile(_ directory: URL) -> URL {
    directory.appendingPathComponent("native-quick-capture-draft.json")
}
func objectAt(_ file: URL) throws -> [String: Any] {
    guard let value = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any] else {
        throw CheckFailure.failed("Expected a saved JSON object")
    }
    return value
}
func pendingAt(_ file: URL) throws -> NativeQuickCapturePayload? {
    guard let value = try objectAt(file)["pending"], !(value is NSNull) else { return nil }
    return try JSONDecoder().decode(NativeQuickCapturePayload.self, from: JSONSerialization.data(withJSONObject: value))
}

@main struct CaptureTests {
    @MainActor static func main() async {
        do {
            let name = CommandLine.arguments[1]
            let directory = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try await run(name, directory)
            print("PASS: " + name)
        } catch {
            FileHandle.standardError.write(Data(("FAIL: \(error)\n").utf8))
            exit(1)
        }
    }

    @MainActor static func run(_ name: String, _ directory: URL) async throws {
        let file = draftFile(directory)
        switch name {
        case "draft-restart":
            let first = NativeQuickCaptureStore()
            first.configure(directory: directory) { _ in throw CheckFailure.failed("Draft flush must not publish a note") }
            first.text = "第一行\nA thought with emoji 🌱\n  preserve indentation"
            first.tags = "研究， ideas ,研究"
            try check(first.flushDraft(), "The draft should flush")
            try check(first.flushForQuit(), "A durable unsent draft must allow ordinary quit")
            let reopened = NativeQuickCaptureStore()
            reopened.configure(directory: directory) { _ in throw CheckFailure.failed("Restoring a draft must not publish it") }
            try check(reopened.text == first.text, "Restart must restore the exact multiline text")
            try check(reopened.tags == first.tags, "Restart must restore the editable tag text")
            try check(reopened.pending == nil && reopened.savedID == nil && reopened.canSave, "Restored draft remains editable and unpublished")
            let mode = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber
            try check(mode?.intValue == 0o600, "Default writer must make the draft owner-only")

        case "pending-before-backend":
            let store = NativeQuickCaptureStore()
            var calls = 0
            var sent: NativeQuickCapturePayload?
            store.configure(directory: directory) { payload in
                calls += 1
                try check(store.saving, "Saving must reflect a real in-flight request")
                try check(try pendingAt(file) == payload, "The exact pending envelope must be durable before the backend is called")
                try check(payload.tags == ["研究", "ideas"], "Tags must be trimmed, deduplicated, and support both comma forms")
                try check(payload.text == "  exact text\n第二行\n", "Publishing must not silently trim the note")
                sent = payload
                return payload.id
            }
            store.text = "  exact text\n第二行\n"
            store.tags = "研究， ideas ,研究,,"
            await store.saveCapture()
            try check(calls == 1 && store.savedID == sent?.id, "Only matching acknowledgement may publish a receipt")
            try check(!store.canStartWithRecovery && !store.preserveRecoveryAndStartNew(), "An acknowledged receipt keeps its ordinary New note flow")
            try check(store.pending == nil && !store.saving && store.inputLocked, "Saved receipt is retained until a new note is requested")
            try check(try pendingAt(file) == nil, "The acknowledged envelope should be cleared on disk")
            try check(try objectAt(file)["savedID"] as? String == sent?.id, "Receipt must survive restart")

        case "lost-ack-restart":
            var workspace: [String: NativeQuickCapturePayload] = [:]
            var calls = 0
            var firstPayload: NativeQuickCapturePayload?
            let first = NativeQuickCaptureStore()
            first.configure(directory: directory) { payload in
                calls += 1
                workspace[payload.id] = payload
                firstPayload = payload
                throw CheckFailure.failed("Simulated acknowledgement lost after workspace committed")
            }
            first.text = "An already committed note"
            first.tags = "one, two"
            await first.saveCapture()
            try check(first.error != nil && first.savedID == nil && first.inputLocked, "An uncertain save must retain and lock its retry envelope")
            try check(first.flushForQuit(), "A failed request with durable envelope may survive quit")
            let restarted = NativeQuickCaptureStore()
            restarted.configure(directory: directory) { payload in
                calls += 1
                try check(payload == firstPayload, "Restart retry must use the identical ID, body, and tags")
                try check(workspace[payload.id] == payload, "Existing workspace result must be recognized rather than duplicated")
                return payload.id
            }
            try check(restarted.pending == firstPayload && restarted.inputLocked && restarted.canSave, "Restart should offer only retry for an uncertain request")
            await restarted.saveCapture()
            try check(calls == 2 && workspace.count == 1, "Lost acknowledgement retry must not create another identity")
            try check(restarted.savedID == firstPayload?.id && restarted.pending == nil, "Retry should recover the original receipt")

        case "wrong-receipt":
            let store = NativeQuickCaptureStore()
            var sent: NativeQuickCapturePayload?
            store.configure(directory: directory) { payload in sent = payload; return "another-record" }
            store.text = "Receipt identity matters"
            await store.saveCapture()
            try check(store.savedID == nil && store.error != nil, "A wrong receipt cannot show success")
            try check(store.pending == sent && store.canSave && store.inputLocked, "Wrong receipt must preserve a retryable immutable payload")
            try check(try pendingAt(file) == sent, "Wrong receipt must leave the original disk envelope intact")

        case "disk-error-before-backend":
            var failWrites = true
            var calls = 0
            let store = NativeQuickCaptureStore(write: { data, file in
                if failWrites { throw CocoaError(.fileWriteOutOfSpace) }
                try data.write(to: file, options: .atomic)
            })
            store.configure(directory: directory) { payload in calls += 1; return payload.id }
            store.text = "Keep this if the disk fills up"
            await store.saveCapture()
            try check(calls == 0 && !store.saving, "No workspace mutation is allowed before its request is recoverable")
            try check(store.draftError != nil && !store.flushForQuit(), "A nondurable draft must block ordinary quit")
            let pending = store.pending
            failWrites = false
            await store.saveCapture()
            try check(calls == 1 && store.savedID == pending?.id, "Repair must retry the original envelope, not invent a new identity")
            try check(store.flushForQuit(), "Successful repair should unblock quit")

        case "disk-error-after-ack":
            var writes = 0
            var committed: NativeQuickCapturePayload?
            let store = NativeQuickCaptureStore(write: { data, file in
                writes += 1
                if writes > 1 { throw CocoaError(.fileWriteOutOfSpace) }
                try data.write(to: file, options: .atomic)
            })
            store.configure(directory: directory) { payload in committed = payload; return payload.id }
            store.text = "Workspace saved, local receipt write failed"
            await store.saveCapture()
            try check(store.savedID == committed?.id && store.draftError != nil, "A real receipt may be shown alongside its local persistence error")
            try check(try pendingAt(file) == committed, "Failed post-ACK write must preserve the prior durable pending envelope")
            try check(!store.flushForQuit(), "Unresolved local receipt persistence must block ordinary quit")
            let restarted = NativeQuickCaptureStore()
            var checks = 0
            restarted.configure(directory: directory) { payload in
                checks += 1
                try check(payload == committed, "Restart after failed receipt write must check the same saved record")
                return payload.id
            }
            await restarted.saveCapture()
            try check(checks == 1 && restarted.savedID == committed?.id, "Restart must safely recover the committed result")

        case "corrupt-draft":
            let original = Data("{not readable JSON".utf8)
            try original.write(to: file)
            var writes = 0, calls = 0
            let store = NativeQuickCaptureStore(write: { data, file in writes += 1; try data.write(to: file, options: .atomic) })
            store.configure(directory: directory) { payload in calls += 1; return payload.id }
            try check(store.inputLocked && !store.canSave && store.draftError != nil, "Unreadable draft must enter recovery rather than blank editable state")
            store.text = "A programmatic change cannot destroy the original"
            try check(!store.flushDraft() && !store.flushForQuit(), "Unreadable persisted state must block replacement and quit")
            await store.saveCapture()
            try check(writes == 0 && calls == 0, "Corrupt-state recovery must not write or publish")
            try check(try Data(contentsOf: file) == original, "Original corrupt file must stay byte-for-byte intact")
            let recoveryDirectory = directory.appendingPathComponent("recovered")
            let good = NativeQuickCaptureStore()
            good.configure(directory: recoveryDirectory) { $0.id }
            good.text = "Recovered external copy"
            try check(good.flushDraft(), "Recovery fixture should be durable")
            try Data(contentsOf: draftFile(recoveryDirectory)).write(to: file, options: .atomic)
            try check(store.flushDraft(), "Retry should reload a repaired file")
            try check(store.text == good.text && !store.inputLocked && store.canSave, "A repaired draft becomes editable without overwriting its contents")
            try check(writes == 0, "Reloading recovery state must not invoke the draft writer")

        case "blank-and-utf16-limit":
            let store = NativeQuickCaptureStore()
            var calls = 0
            store.configure(directory: directory) { payload in calls += 1; return payload.id }
            store.text = " \n\t "
            try check(!store.canSave, "Whitespace alone must not be publishable")
            await store.saveCapture()
            store.text = String(repeating: "🌱", count: 100_001)
            try check(!store.canSave, "Limit must count UTF-16 units, not grapheme clusters")
            await store.saveCapture()
            try check(calls == 0 && store.pending == nil, "Rejected input must never reach the backend")
            store.text = String(repeating: "🌱", count: 100_000)
            try check(store.canSave, "Exactly 200,000 UTF-16 units should be accepted")
            await store.saveCapture()
            try check(calls == 1 && store.savedID != nil, "Boundary-sized input should complete through the real store")

        case "simultaneous-save":
            let store = NativeQuickCaptureStore()
            var calls = 0
            var release: CheckedContinuation<String, Error>?
            var sent: NativeQuickCapturePayload?
            store.configure(directory: directory) { payload in
                calls += 1; sent = payload
                return try await withCheckedThrowingContinuation { release = $0 }
            }
            store.text = "One click and Cmd-Return at the same time"
            let first = Task { @MainActor in await store.saveCapture() }
            while release == nil { await Task.yield() }
            try check(store.saving && !store.canSave && store.inputLocked, "In-flight state must prevent duplicate submissions")
            try check(!store.canStartWithRecovery && !store.preserveRecoveryAndStartNew(), "Recovery must not reset an in-flight request")
            await store.saveCapture()
            try check(calls == 1, "Overlapping save actions must call the backend once")
            try check(!store.flushForQuit(), "Ordinary quit must wait for an active workspace write")
            try check(try pendingAt(file) == sent, "The in-flight request remains recoverable")
            release!.resume(returning: sent!.id)
            await first.value
            try check(store.savedID == sent?.id && !store.saving && store.flushForQuit(), "Completion should publish exactly one receipt and unblock quit")

        case "new-note-clear-failure":
            var failWrites = false
            let store = NativeQuickCaptureStore(write: { data, file in
                if failWrites { throw CocoaError(.fileWriteOutOfSpace) }
                try data.write(to: file, options: .atomic)
            })
            store.configure(directory: directory) { $0.id }
            store.text = "Keep acknowledged content until a new blank draft is durable"
            store.tags = "retained"
            await store.saveCapture()
            let previousID = store.savedID
            let previousBytes = try Data(contentsOf: file)
            failWrites = true
            store.newCapture()
            try check(store.savedID == previousID && !store.text.isEmpty && store.tags == "retained", "Failed clear must roll back to the visible receipt and original text")
            try check(try Data(contentsOf: file) == previousBytes, "Failed clear must preserve the old receipt on disk")
            failWrites = false
            store.newCapture()
            try check(store.savedID == nil && store.pending == nil && store.text.isEmpty && store.tags.isEmpty, "New note begins only after its blank draft is durable")
            let draft = try objectAt(file)
            try check(draft["id"] as? String != previousID, "The next note must get a new identity")
            try check(store.flushForQuit(), "Durable new draft must allow quit")

        case "recover-pending":
            let store = NativeQuickCaptureStore()
            var calls = 0
            store.configure(directory: directory) { _ in calls += 1; throw NativeQuickCaptureError.rejected("removed") }
            store.text = "Preserve a removed note's uncertain envelope"
            store.tags = "original, tags"
            await store.saveCapture()
            let pending = store.pending
            let original = try Data(contentsOf: file)
            try check(store.canStartWithRecovery, "A permanently removed request must have a safe recovery path")
            try check(store.preserveRecoveryAndStartNew(), "Recovery should allow a new empty draft")
            guard let recovery = store.recoveryURL else { throw CheckFailure.failed("Recovery location must be exposed") }
            try check(try Data(contentsOf: recovery.appendingPathComponent("original.json")) == original, "Original envelope bytes must survive exactly")
            try check(try pendingAt(recovery.appendingPathComponent("input.json")) == pending, "Current immutable payload must be retained independently")
            try check(calls == 1, "Recovery must never send or retry the old note")
            try check(store.pending == nil && store.savedID == nil && store.text.isEmpty && store.tags.isEmpty && !store.inputLocked, "Only durable recovery may unlock a fresh input")
            try check(try objectAt(file)["id"] as? String != pending?.id, "A new capture receives a different ID")
            let reopened = NativeQuickCaptureStore()
            reopened.configure(directory: directory) { $0.id }
            try check(reopened.text.isEmpty && reopened.recoveryURL == recovery, "Restart must keep the recovery location discoverable")
            let folderMode = try FileManager.default.attributesOfItem(atPath: recovery.path)[.posixPermissions] as? NSNumber
            try check(folderMode?.intValue == 0o700, "Recovery folder is owner-only")
            for name in ["original.json", "input.json"] {
                let mode = try FileManager.default.attributesOfItem(atPath: recovery.appendingPathComponent(name).path)[.posixPermissions] as? NSNumber
                try check(mode?.intValue == 0o600, "Every recovery file is owner-only")
            }
            reopened.text = "A distinct next capture"
            await reopened.saveCapture()
            try check(reopened.savedID != nil && reopened.savedID != pending?.id, "The next capture works without duplicating the abandoned request")

        case "recover-corrupt":
            let raw = Data([0x7b, 0xff, 0x00, 0x0a, 0x7b])
            try raw.write(to: file)
            let store = NativeQuickCaptureStore()
            store.configure(directory: directory) { _ in throw CheckFailure.failed("Corrupt recovery must not publish") }
            try check(store.inputLocked && store.canStartWithRecovery, "Malformed raw bytes must permit preservation, not silent deletion")
            try check(store.preserveRecoveryAndStartNew(), "Preserved malformed bytes should unblock fresh input")
            guard let recovery = store.recoveryURL else { throw CheckFailure.failed("Corrupt recovery must expose its path") }
            try check(try Data(contentsOf: recovery.appendingPathComponent("original.json")) == raw, "Invalid UTF-8 and malformed JSON must be copied byte-for-byte")
            try check(store.text.isEmpty && !store.inputLocked && store.flushForQuit(), "Recovery should leave an ordinary durable blank draft")

        case "recover-failure":
            var failure = ""
            let store = NativeQuickCaptureStore(write: { data, target in
                if failure == "copy" && target.lastPathComponent == "input.json" { throw CocoaError(.fileWriteOutOfSpace) }
                if failure == "reset" && target.lastPathComponent.hasPrefix(".native-quick-capture-reset-") {
                    try data.write(to: target, options: .atomic)
                    throw CocoaError(.fileWriteOutOfSpace)
                }
                try data.write(to: target, options: .atomic)
            })
            var calls = 0
            store.configure(directory: directory) { _ in calls += 1; throw NativeQuickCaptureError.unconfirmed }
            store.text = "Recovery failure cannot replace this"
            store.tags = "keep"
            await store.saveCapture()
            let original = try Data(contentsOf: file), pending = store.pending
            for phase in ["copy", "reset"] {
                failure = phase
                try check(!store.preserveRecoveryAndStartNew(), "Injected recovery failure must be reported")
                try check(try Data(contentsOf: file) == original, "Failure must preserve original bytes")
                try check(store.pending == pending && store.text == pending?.text && store.tags == "keep" && store.inputLocked, "Failure must preserve the current immutable input")
                try check(store.draftError != nil && store.recoveryURL == nil && calls == 1, "No false recovery success or workspace write")
            }
            failure = ""
            try check(store.preserveRecoveryAndStartNew(), "Retry should recover once storage works")

        case "recover-newer-memory":
            var failDraft = false
            let store = NativeQuickCaptureStore(write: { data, target in
                if failDraft && target.lastPathComponent == "native-quick-capture-draft.json" { throw CocoaError(.fileWriteOutOfSpace) }
                try data.write(to: target, options: .atomic)
            })
            var calls = 0
            store.configure(directory: directory) { payload in calls += 1; return payload.id }
            store.text = "Previously retained input"
            try check(store.flushDraft(), "Baseline draft must exist")
            let original = try Data(contentsOf: file)
            store.text = "Newer text not yet writable to the draft file"
            store.tags = "new tag"
            failDraft = true
            await store.saveCapture()
            let pending = store.pending
            try check(calls == 0 && pending != nil, "Failed preflight must leave an unsent memory envelope")
            failDraft = false
            try check(store.preserveRecoveryAndStartNew(), "Recovery should preserve both disk and newer memory")
            let recovery = store.recoveryURL!
            try check(try Data(contentsOf: recovery.appendingPathComponent("original.json")) == original, "Original older bytes are kept")
            try check(try pendingAt(recovery.appendingPathComponent("input.json")) == pending, "Newer unsent memory is retained too")
            try check(calls == 0, "Preserving input must not publish it")

        default: throw CheckFailure.failed("Unknown test case: " + name)
        }
    }
}
`;

test('production quick capture store preserves durable drafts and exact retry identities', {
  skip: process.platform !== 'darwin', timeout: 180000,
}, async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-quick-capture-store-'));
  try {
    const source = path.join(temporary, 'CaptureTests.swift');
    const binary = path.join(temporary, 'capture-tests');
    fs.writeFileSync(source, harness);
    const compiled = spawnSync('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', production, source, '-o', binary], {
      encoding: 'utf8', timeout: 90000,
    });
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const cases = [
      'draft-restart', 'pending-before-backend', 'lost-ack-restart', 'wrong-receipt',
      'disk-error-before-backend', 'disk-error-after-ack', 'corrupt-draft',
      'blank-and-utf16-limit', 'simultaneous-save', 'new-note-clear-failure',
      'recover-pending', 'recover-corrupt', 'recover-failure', 'recover-newer-memory',
    ];
    for (const name of cases) {
      await t.test(name, () => {
        const result = spawnSync(binary, [name, path.join(temporary, name)], {encoding: 'utf8', timeout: 15000});
        assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message ?? ''));
        assert.ok(result.stdout.includes('PASS: ' + name), result.stdout);
      });
    }
  } finally {
    fs.rmSync(temporary, {recursive: true, force: true});
  }
});
