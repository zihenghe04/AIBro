const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const production = path.resolve(__dirname, '../native/Sources/AIBro/NativeQuickWorkbench.swift');

// Exercise the real production store in isolated processes and temporary
// workspaces. Only native translation and the backend acknowledgement are
// replaced; ordinary pending-envelope writes use the actual default writer.
const harness = String.raw`
import Foundation
import Combine

func nativeUI(_ zh: String, _ en: String) -> String { en }
enum TestFailure: Error, CustomStringConvertible {
    case failed(String)
    var description: String { switch self { case .failed(let message): return message } }
}
func check(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try condition() == false { throw TestFailure.failed(message) }
}
func pendingFile(_ directory: URL) -> URL { directory.appendingPathComponent("native-quick-task-pending.json") }
func pendingAt(_ file: URL) throws -> [String: Any]? {
    let value = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
    return value?["pending"] as? [String: Any]
}
func snapshot(completed: Bool = false, cancelling: Bool = true, status: String = "ready", reason: String? = nil, saving: Bool = false) -> NativeQuickWorkbenchSnapshot {
    NativeQuickWorkbenchSnapshot(version: 1, status: status, reason: reason,
        tasks: [NativeQuickTaskItem(id: "task-one", title: "合成任务", projectTitle: "合成项目", dueLabel: "2030-10-03", isCompleted: completed, version: completed ? "v2" : "v1", isSaving: saving)],
        runs: [NativeQuickRunItem(id: "run-one", title: "合成对话", statusLabel: cancelling ? "Running" : "Stopped", detail: "", isActive: cancelling, canCancel: cancelling)],
        taskCount: completed ? 0 : 1, runCount: cancelling ? 1 : 0)
}
@MainActor func configure(_ store: NativeQuickWorkbenchStore, _ directory: URL, command: @escaping ([String: Any]) async throws -> [String: Any]) {
    store.configure(directory: directory, command: command, openTask: { _ in false }, openRun: { _ in false })
    store.accept(snapshot())
}

@main struct QuickWorkbenchTests {
    @MainActor static func main() async {
        do {
            let name = CommandLine.arguments[1]
            let directory = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try await run(name, directory)
            print("PASS: " + name)
        } catch {
            FileHandle.standardError.write(Data(("FAIL: \(error)\n").utf8)); exit(1)
        }
    }

    @MainActor static func run(_ name: String, _ directory: URL) async throws {
        let file = pendingFile(directory)
        switch name {
        case "pending-before-backend":
            let store = NativeQuickWorkbenchStore()
            var calls = 0
            configure(store, directory) { payload in
                calls += 1
                try check(store.creating && !store.canRecoverPendingTask, "In-flight state must forbid recovery/reset")
                let pending = try pendingAt(file)
                try check(pending?["id"] as? String == payload["id"] as? String, "Exact identity must be durable before backend call")
                try check(pending?["title"] as? String == "Read synthetic notes", "Normalized title must be durable before backend call")
                try check(payload["action"] as? String == "create-task", "Only task creation is requested")
                return ["status": "saved", "id": payload["id"]!]
            }
            let result = await store.createTask(title: "  Read synthetic notes  ")
            try check(result && calls == 1, "Matching durable receipt must succeed once")
            try check(!store.creating && store.pendingTaskTitle == nil, "Acknowledged pending input must clear")
            try check(try pendingAt(file) == nil, "Acknowledged envelope must be cleared on disk")
            let mode = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber
            try check(mode?.intValue == 0o600, "Default pending file is owner-only")

        case "lost-ack-restart":
            var workspace: Set<String> = [], originalID: String?, calls = 0
            let first = NativeQuickWorkbenchStore()
            configure(first, directory) { payload in
                calls += 1; originalID = payload["id"] as? String; workspace.insert(originalID!)
                throw TestFailure.failed("Simulated lost acknowledgement after commit")
            }
            let firstResult = await first.createTask(title: "Already committed task")
            try check(!firstResult && first.pendingTaskTitle == "Already committed task" && first.canRecoverPendingTask, "Uncertain result retains retry input")
            let restarted = NativeQuickWorkbenchStore()
            configure(restarted, directory) { payload in
                calls += 1; let id = payload["id"] as! String
                try check(id == originalID && workspace.contains(id), "Restart must check the same already committed task")
                workspace.insert(id); return ["status": "saved", "id": id]
            }
            try check(restarted.pendingTaskTitle == "Already committed task", "Exact retry input is restored")
            let changed = await restarted.createTask(title: "Replacement is forbidden")
            try check(!changed && calls == 1, "Different input cannot overwrite an uncertain request")
            let retried = await restarted.createTask(title: "Already committed task")
            try check(retried && calls == 2 && workspace.count == 1, "Lost ACK retry creates no second identity")

        case "wrong-receipt":
            let store = NativeQuickWorkbenchStore()
            var sent: [String: Any] = [:], index = 0
            configure(store, directory) { payload in
                sent = payload; index += 1
                if index == 1 { return ["status": "saved", "id": "wrong-identity"] }
                if index == 2 { return ["status": "cancel_requested", "id": payload["id"]!] }
                return ["status": "saved"]
            }
            for _ in 0..<3 {
                let result = await store.createTask(title: "Keep exact pending title")
                try check(!result && store.pendingTaskTitle == "Keep exact pending title" && store.error != nil, "Mismatched receipt must not clear input")
                try check(try pendingAt(file)?["id"] as? String == sent["id"] as? String, "Same identity remains durable")
            }

        case "disk-error-before-backend":
            var fail = true, calls = 0
            let store = NativeQuickWorkbenchStore(write: { data, url in
                if fail { throw CocoaError(.fileWriteOutOfSpace) }
                try data.write(to: url, options: .atomic)
            })
            configure(store, directory) { payload in calls += 1; return ["status": "saved", "id": payload["id"]!] }
            let rejected = await store.createTask(title: "Cannot send before disk accepts input")
            try check(!rejected && calls == 0 && !store.creating && store.error != nil, "Failed preflight cannot call backend")
            fail = false
            let accepted = await store.createTask(title: "Cannot send before disk accepts input")
            try check(accepted && calls == 1, "Storage recovery allows the retained caller input to save")

        case "disk-error-after-ack":
            var writes = 0, savedID: String?
            let store = NativeQuickWorkbenchStore(write: { data, url in
                writes += 1; if writes > 1 { throw CocoaError(.fileWriteOutOfSpace) }
                try data.write(to: url, options: .atomic)
            })
            configure(store, directory) { payload in savedID = payload["id"] as? String; return ["status": "saved", "id": payload["id"]!] }
            let result = await store.createTask(title: "Retain uncertain local receipt")
            try check(!result && store.pendingTaskTitle != nil, "Local receipt clear failure keeps recoverable pending input")
            try check(try pendingAt(file)?["id"] as? String == savedID, "Disk keeps exact ID after acknowledged workspace commit")
            let restarted = NativeQuickWorkbenchStore()
            configure(restarted, directory) { payload in
                try check(payload["id"] as? String == savedID, "Retry must verify the prior committed ID")
                return ["status": "saved", "id": payload["id"]!]
            }
            let retried = await restarted.createTask(title: "Retain uncertain local receipt")
            try check(retried, "Matching retry should resolve local uncertainty")

        case "simultaneous-create":
            let store = NativeQuickWorkbenchStore()
            var calls = 0, sentID: String?, release: CheckedContinuation<[String: Any], Error>?
            configure(store, directory) { payload in
                calls += 1; sentID = payload["id"] as? String
                return try await withCheckedThrowingContinuation { release = $0 }
            }
            let pending = Task { @MainActor in await store.createTask(title: "One real task") }
            while release == nil { await Task.yield() }
            let duplicate = await store.createTask(title: "One real task")
            try check(!duplicate && calls == 1 && store.creating, "Overlapping submits cannot duplicate a backend call")
            try check(!store.preservePendingTaskAndStartNew(), "Recovery cannot abandon an in-flight request")
            release!.resume(returning: ["status": "saved", "id": sentID!])
            let accepted = await pending.value
            try check(accepted && !store.creating, "One matching receipt settles the request")

        case "completion-projection":
            let store = NativeQuickWorkbenchStore()
            var release: CheckedContinuation<[String: Any], Error>?, calls = 0
            configure(store, directory) { payload in
                calls += 1
                try check(payload["action"] as? String == "set-task-completed", "Status command uses dedicated bridge action")
                try check(payload["id"] as? String == "task-one" && payload["expectedVersion"] as? String == "v1", "Exact projected identity/version must be sent")
                try check(payload["completed"] as? Bool == true, "Desired status must be explicit")
                return try await withCheckedThrowingContinuation { release = $0 }
            }
            let pending = Task { @MainActor in await store.setTaskCompleted(id: "task-one", completed: true) }
            while release == nil { await Task.yield() }
            try check(store.busyTaskIDs.contains("task-one") && !store.tasks[0].isCompleted, "No optimistic row mutation before acknowledgement")
            let duplicate = await store.setTaskCompleted(id: "task-one", completed: false)
            try check(!duplicate && calls == 1, "Same task must not submit overlapping status commands")
            release!.resume(returning: ["status": "saved", "id": "task-one"])
            let accepted = await pending.value
            try check(accepted && store.busyTaskIDs.isEmpty && !store.tasks[0].isCompleted, "Receipt alone cannot fabricate the projected status")
            store.accept(snapshot(completed: true))
            try check(store.tasks[0].isCompleted && store.tasks[0].version == "v2", "Only actual workspace projection updates the row")

        case "completion-rejection":
            let store = NativeQuickWorkbenchStore()
            var calls = 0
            configure(store, directory) { _ in calls += 1; return ["status": "saved", "id": "another-task"] }
            let rejected = await store.setTaskCompleted(id: "task-one", completed: true)
            try check(!rejected && !store.tasks[0].isCompleted && store.busyTaskIDs.isEmpty && store.error != nil, "Wrong identity cannot mark a task complete or leave it disabled")
            store.accept(snapshot(saving: true))
            let busy = await store.setTaskCompleted(id: "task-one", completed: true)
            let missing = await store.setTaskCompleted(id: "missing", completed: true)
            try check(!busy && !missing && calls == 1, "Saving or absent projected rows cannot be mutated")

        case "cancel-receipt-projection":
            let store = NativeQuickWorkbenchStore()
            var calls = 0
            configure(store, directory) { payload in calls += 1; return ["status": "cancel_requested", "id": payload["id"]!] }
            let missing = await store.cancelRun(id: "another-run")
            try check(!missing && calls == 0, "Only the projected cancellable run can send a request")
            let accepted = await store.cancelRun(id: "run-one")
            try check(accepted && calls == 1 && store.cancellingRunIDs.contains("run-one"), "Cancellation acknowledgement is pending until an actual projection")
            try check(store.runs[0].isActive && store.runs[0].statusLabel == "Running", "Requested cancellation must not display fabricated completion")
            let duplicate = await store.cancelRun(id: "run-one")
            try check(!duplicate && calls == 1, "Acknowledged cancellation must not be repeatedly submitted")
            store.accept(snapshot(cancelling: false))
            try check(store.cancellingRunIDs.isEmpty && !store.runs[0].isActive, "Actual settled projection completes cancellation display")
            let settled = await store.cancelRun(id: "run-one")
            try check(!settled && calls == 1, "Ended runs cannot be cancelled")

        case "cancel-wrong-receipt":
            let store = NativeQuickWorkbenchStore()
            configure(store, directory) { _ in ["status": "saved", "id": "run-one"] }
            let rejected = await store.cancelRun(id: "run-one")
            try check(!rejected && store.cancellingRunIDs.isEmpty && store.runs[0].isActive, "A generic saved response is not a cancellation receipt")

        case "projection-privacy-and-navigation":
            let store = NativeQuickWorkbenchStore()
            var commands = 0, opened: [String] = []
            store.configure(directory: directory, command: { _ in commands += 1; return [:] }, openTask: { id in opened.append(id); return true }, openRun: { id in opened.append(id); return false })
            store.accept(snapshot())
            let good = await store.openTask(id: "task-one"), unknown = await store.openTask(id: "unknown"), declined = await store.openRun(id: "run-one")
            try check(good && !unknown && !declined && opened == ["task-one", "run-one"], "Navigation uses exact visible rows and propagates host refusal")
            store.accept(snapshot(status: "deferred", reason: "private"))
            try check(!store.ready && store.tasks.isEmpty && store.runs.isEmpty, "Private projection must clear visible content immediately")
            let hidden = await store.openTask(id: "task-one"), mutate = await store.createTask(title: "Hidden mutation")
            try check(!hidden && !mutate && commands == 0 && opened.count == 2, "Suppressed projection cannot navigate or mutate")
            store.accept(nil)
            try check(store.loading && !store.ready && store.tasks.isEmpty, "A missing snapshot cannot retain stale sensitive rows")

        case "corrupt-recovery":
            let original = Data([0x7b, 0xff, 0x00, 0x0a, 0x7b])
            try original.write(to: file)
            let store = NativeQuickWorkbenchStore()
            var calls = 0
            configure(store, directory) { payload in calls += 1; return ["status": "saved", "id": payload["id"]!] }
            let rejected = await store.createTask(title: "Must not erase corrupt bytes")
            try check(!rejected && calls == 0 && store.canRecoverPendingTask && store.error != nil, "Corrupt state enters explicit recovery")
            try check(try Data(contentsOf: file) == original, "Corrupt file must remain untouched until recovery")
            try check(store.preservePendingTaskAndStartNew(), "Durable recovery copy should permit a new task")
            guard let recovery = store.recoveryURL else { throw TestFailure.failed("Recovery file must be discoverable") }
            try check(try Data(contentsOf: recovery) == original, "Invalid UTF-8 and JSON must be retained byte-for-byte")
            let mode = try FileManager.default.attributesOfItem(atPath: recovery.path)[.posixPermissions] as? NSNumber
            try check(mode?.intValue == 0o600, "Recovery file is owner-only")
            try check(try pendingAt(file) == nil, "Recovery leaves a readable empty envelope")
            let accepted = await store.createTask(title: "A fresh task after recovery")
            try check(accepted && calls == 1, "Only the explicit new task goes to backend")

        case "recovery-copy-failure":
            let original = Data("{broken pending envelope".utf8)
            try original.write(to: file)
            var fail = true
            let store = NativeQuickWorkbenchStore(write: { data, url in
                if fail { throw CocoaError(.fileWriteOutOfSpace) }
                try data.write(to: url, options: .atomic)
            })
            configure(store, directory) { _ in throw TestFailure.failed("Recovery must never publish") }
            try check(!store.preservePendingTaskAndStartNew() && store.canRecoverPendingTask && store.recoveryURL == nil, "Copy failure retains recovery state")
            try check(try Data(contentsOf: file) == original, "Failed recovery must retain original bytes")
            fail = false
            try check(store.preservePendingTaskAndStartNew(), "Explicit recovery can retry once storage works")

        case "title-limit-and-workspace-ownership":
            let store = NativeQuickWorkbenchStore()
            var calls = 0
            configure(store, directory) { payload in calls += 1; return ["status": "saved", "id": payload["id"]!] }
            for title in [" \n\t", String(repeating: "🌱", count: 251)] {
                let rejected = await store.createTask(title: title)
                try check(!rejected, "Invalid or over-limit UTF-16 title must fail")
            }
            try check(calls == 0, "Rejected title must not reach backend")
            let accepted = await store.createTask(title: String(repeating: "🌱", count: 250))
            try check(accepted && calls == 1, "Exactly 500 UTF-16 units must be accepted")
            configure(store, directory.appendingPathComponent("another-workspace")) { _ in calls += 1; return [:] }
            let moved = await store.createTask(title: "Wrong workspace")
            try check(!moved && calls == 1, "A configured store cannot silently move requests into another workspace")

        case "legacy-pending-metadata-compatibility":
            let id = "quick_task_01234567-89ab-4cde-8fab-0123456789ab"
            let legacy: [String: Any] = ["version": 1, "pending": ["id": id, "title": "Legacy pending task"]]
            try JSONSerialization.data(withJSONObject: legacy).write(to: file)
            let store = NativeQuickWorkbenchStore(); var calls = 0
            configure(store, directory) { payload in
                calls += 1
                try check(payload["id"] as? String == id && payload["workspace"] == nil && payload["projectId"] == nil && payload["dueAt"] == nil, "Legacy retry must preserve its title-only fingerprint protocol")
                return ["status": "saved", "id": id]
            }
            let changed = await store.createTask(title: "Legacy pending task", fields: NativeQuickTaskFields(workspace: "课程"))
            try check(!changed && calls == 0, "Metadata cannot mutate an unacknowledged legacy request")
            let retry = await store.createTask(title: "Legacy pending task")
            try check(retry && calls == 1 && store.pendingTaskTitle == nil, "Legacy pending retry remains compatible")

        case "v2-full-request-restart":
            let fields = NativeQuickTaskFields(workspace: "课程", projectId: "course-one", dueAt: .text("2030-10-04"))
            let first = NativeQuickWorkbenchStore(); var originalID: String?
            configure(first, directory) { payload in
                originalID = payload["id"] as? String
                let pending = try pendingAt(file)
                let saved = pending?["fields"] as? [String: Any]
                try check(saved?["workspace"] as? String == "课程" && saved?["projectId"] as? String == "course-one" && saved?["dueAt"] as? String == "2030-10-04", "All fields must be durable before invoking backend")
                throw TestFailure.failed("Lost response")
            }
            let lost = await first.createTask(title: "Course deadline", fields: fields)
            try check(!lost, "Uncertain full request stays pending")
            let next = NativeQuickWorkbenchStore(); var calls = 0
            configure(next, directory) { payload in
                calls += 1
                try check(payload["id"] as? String == originalID && payload["workspace"] as? String == "课程" && payload["projectId"] as? String == "course-one" && payload["dueAt"] as? String == "2030-10-04", "Restart retries exact identity and metadata")
                return ["status": "saved", "id": payload["id"]!]
            }
            try check(next.pendingTaskFields == fields && next.creationFields == fields, "Metadata is restored for the frozen retry form")
            let changed = await next.createTask(title: "Course deadline", fields: NativeQuickTaskFields(workspace: "课程", projectId: "course-one", dueAt: nil))
            try check(!changed && calls == 0, "Clearing date cannot alter uncertain request")
            let retry = await next.createTask(title: "Course deadline", fields: fields)
            try check(retry && calls == 1 && next.pendingTaskFields == nil, "Exact full request acknowledges once")

        case "edit-conflict-and-explicit-reload":
            let store = NativeQuickWorkbenchStore(); var calls = 0
            configure(store, directory) { payload in
                calls += 1
                try check(payload["action"] as? String == "update-task" && payload["expectedVersion"] as? String == "v1", "Editor uses captured baseline version")
                let patch = payload["patch"] as? [String: Any]
                try check(patch?["title"] as? String == "Draft title" && patch?["projectId"] is NSNull && patch?["dueAt"] is NSNull, "No project/deadline are explicit null edits")
                return ["status": "error", "reason": "changed"]
            }
            try check(store.beginEditingTask(id: "task-one"), "Actual projected task can be edited")
            store.editingTask?.title = "Draft title"; store.editingTask?.fields = NativeQuickTaskFields()
            try check(store.hasUnsavedTaskEditorDraft, "Changed draft participates in quit protection")
            store.accept(snapshot(completed: true))
            try check(store.editingTask?.title == "Draft title" && store.editingTask?.original.version == "v1", "New snapshot never replaces input or baseline")
            let saved = await store.saveEditingTask()
            try check(!saved && store.taskEditorConflict && store.editingTask?.title == "Draft title" && calls == 1, "Conflict retains input and enables deliberate reload")
            try check(store.reloadEditingTask() && store.editingTask?.original.version == "v2" && store.editingTask?.title == "合成任务" && !store.hasUnsavedTaskEditorDraft, "Explicit reload adopts the latest record and resets only that editor")

        case "edit-ack-newer-input-and-invalid-fields":
            let store = NativeQuickWorkbenchStore(); var calls = 0
            configure(store, directory) { payload in
                calls += 1
                try check(store.busyTaskIDs.contains("task-one"), "Saving is visible and prevents competing commands")
                store.editingTask?.title = "Newer user input"
                return ["status": "saved", "id": payload["id"]!]
            }
            try check(store.beginEditingTask(id: "task-one"), "Task editing opens")
            store.editingTask?.title = "Submitted title"
            let saved = await store.saveEditingTask()
            try check(saved && store.editingTask?.title == "Newer user input" && store.hasUnsavedTaskEditorDraft && store.busyTaskIDs.isEmpty, "ACK never clears a newer draft")
            let invalid = await store.updateTask(id: "task-one", expectedVersion: "v1", title: "Valid", fields: NativeQuickTaskFields(dueAt: .text("2030-02-30")))
            try check(!invalid && calls == 1, "Invalid calendar day fails before backend")
            let numeric = NativeQuickTaskDate.milliseconds(1917302400000)
            let decoded = try JSONDecoder().decode(NativeQuickTaskDate.self, from: JSONEncoder().encode(numeric))
            try check(decoded == numeric && numeric.date != nil, "Legacy numeric raw deadline roundtrips without local label parsing")
            store.creationFields = NativeQuickTaskFields(workspace: "科研", dueAt: .text("2030-10-05"))
            try check(store.hasUnsavedTaskCreationFields, "Unsubmitted project/date selection is protected")

        default: throw TestFailure.failed("Unknown case: " + name)
        }
    }
}
`;

test('production native quick workbench preserves durable identities and real workspace projections', {
  skip: process.platform !== 'darwin', timeout: 180000,
}, async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-quick-workbench-store-'));
  try {
    const source = path.join(temporary, 'QuickWorkbenchTests.swift'), binary = path.join(temporary, 'quick-workbench-tests');
    fs.writeFileSync(source, harness);
    const compiled = spawnSync('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', ...['NativeQuickRecordFocus.swift', 'NativeTaskInboxParser.swift', 'NativeTaskInbox.swift', 'NativeQuickTaskDeadlinePresets.swift'].map(name => path.resolve(__dirname, '../native/Sources/AIBro', name)), production, path.resolve(__dirname, '../native/Sources/AIBro/NativeQuickTaskLifecycle.swift'), source, '-o', binary], { encoding: 'utf8', timeout: 90000 });
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr + (compiled.error?.message ?? ''));
    for (const name of ['pending-before-backend', 'lost-ack-restart', 'wrong-receipt', 'disk-error-before-backend', 'disk-error-after-ack', 'simultaneous-create', 'completion-projection', 'completion-rejection', 'cancel-receipt-projection', 'cancel-wrong-receipt', 'projection-privacy-and-navigation', 'corrupt-recovery', 'recovery-copy-failure', 'title-limit-and-workspace-ownership', 'legacy-pending-metadata-compatibility', 'v2-full-request-restart', 'edit-conflict-and-explicit-reload', 'edit-ack-newer-input-and-invalid-fields']) {
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
