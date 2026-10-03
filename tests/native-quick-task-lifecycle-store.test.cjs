const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sources = ['NativeQuickRecordFocus.swift', 'NativeTaskInboxParser.swift', 'NativeTaskInbox.swift', 'NativeQuickTaskDeadlinePresets.swift', 'NativeQuickWorkbench.swift', 'NativeQuickTaskLifecycle.swift']
  .map(name => path.resolve(__dirname, '../native/Sources/AIBro', name));

// Production controller, real envelope files, and an explicit canonical-trash
// acknowledgement fixture. No app build, GUI, user data, or timer sleeps.
const harness = String.raw`
import Foundation
import Combine

func nativeUI(_ zh: String, _ en: String) -> String { en }
enum Failure: Error, CustomStringConvertible {
    case assertion(String)
    var description: String { switch self { case .assertion(let message): return message } }
}
func check(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try condition() == false { throw Failure.assertion(message) }
}
func lifecycleFile(_ directory: URL) -> URL { directory.appendingPathComponent("native-quick-task-lifecycle.json") }
func pending(_ directory: URL) throws -> NativeQuickTaskLifecycleRequest? {
    try JSONDecoder().decode(NativeQuickTaskLifecycleEnvelope.self, from: Data(contentsOf: lifecycleFile(directory))).pending
}
func snapshot(version: String = "original-v1", rows: Bool = true, ready: Bool = true) -> NativeQuickWorkbenchSnapshot {
    NativeQuickWorkbenchSnapshot(version: 1, status: ready ? "ready" : "deferred", reason: ready ? nil : "private",
        tasks: rows ? [NativeQuickTaskItem(id: "synthetic-one", title: "Synthetic task", projectTitle: "Synthetic project", dueLabel: "", isCompleted: false, version: version)] : [],
        runs: [], taskCount: rows ? 1 : 0, runCount: 0)
}
func receipt(_ payload: [String: Any]) -> [String: Any] {
    let action = payload["action"] as? String ?? ""
    var value: [String: Any] = ["status": action.hasPrefix("delete") ? "deleted" : "restored", "id": payload["id"]!, "trashId": payload["trashId"]!]
    if action.hasSuffix("tasks") { value["ids"] = payload["ids"] ?? (payload["items"] as? [[String: String]] ?? []).compactMap { $0["id"] } }
    return value
}
func batchSnapshot(_ ids: [String] = ["a", "b", "c", "d"], changed: Bool = false) -> NativeQuickWorkbenchSnapshot {
    let tasks = ids.map { NativeQuickTaskItem(id: $0, title: "Synthetic " + $0, projectTitle: "", dueLabel: "", isCompleted: false, version: $0 + (changed ? "-new" : "-v1")) }
    return NativeQuickWorkbenchSnapshot(version: 1, status: "ready", reason: nil, tasks: tasks, runs: [], taskCount: tasks.count, runCount: 0)
}
@MainActor func configure(_ store: NativeQuickWorkbenchStore, _ directory: URL, rows: Bool = true,
                          command: @escaping ([String: Any]) async throws -> [String: Any]) {
    store.configure(directory: directory, command: command, openTask: { _ in false }, openRun: { _ in false })
    store.accept(snapshot(rows: rows))
}

@main struct LifecycleTests {
    @MainActor static func main() async {
        do {
            let directory = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try await run(CommandLine.arguments[1], directory)
            print("PASS: " + CommandLine.arguments[1])
        } catch { FileHandle.standardError.write(Data("FAIL: \(error)\n".utf8)); exit(1) }
    }

    @MainActor static func run(_ name: String, _ directory: URL) async throws {
        let file = lifecycleFile(directory)
        switch name {
        case "stable-id-selection-range-and-reorder":
            var value = NativeQuickTaskSelection()
            value.select("b", ordered: ["a", "b", "c", "d"])
            value.select("d", ordered: ["a", "b", "c", "d"], extending: true)
            try check(value.ids == Set(["b", "c", "d"]) && value.anchor == "b", "Shift selects the inclusive visible range and retains its identity anchor")
            value.reconcile(["d", "x", "b", "c", "a"])
            try check(value.ids == Set(["b", "c", "d"]), "An insertion or sorting change never selects the record at a previous index")
            value.select("a", ordered: ["d", "x", "b", "c", "a"], extending: true)
            try check(value.ids == Set(["a", "b", "c", "d"]) && !value.ids.contains("x"), "A new range follows the current visible order from the original ID")
            value.select("c", ordered: ["d", "x", "b", "c", "a"], toggling: true)
            try check(!value.ids.contains("c") && value.anchor == "c", "An explicit toggle deselects one ID without discarding the rest")
            value.reconcile(["a", "b", "x"])
            try check(value.ids == Set(["a", "b"]) && value.anchor == nil, "Removed rows prune selection and invalidate a removed anchor")
            value.select("x", ordered: ["a", "b", "x"], extending: true)
            try check(value.ids == Set(["x"]) && value.anchor == "x", "A missing anchor cannot shift-select from a stale index")
            value.selectAll(["x", "a", "b"]); value.clear()
            try check(value.ids.isEmpty && value.anchor == nil, "Escape/Done can clear all selection state")

        case "batch-durable-membership-and-canonical-undo":
            let store = NativeQuickWorkbenchStore(); var calls = 0; var deletion: NativeQuickTaskLifecycleRequest?
            configure(store, directory) { payload in
                calls += 1
                let request = try pending(directory)!
                try check(request.valid && request.isBatch && request == store.pendingTaskLifecycle, "The whole batch is durable before execution")
                try check(request.taskIDs == ["c", "b"] && store.busyTaskIDs == Set(["b", "c"]), "Membership/order are immutable IDs and all targets lock together")
                if calls == 1 {
                    deletion = request
                    try check(request.items?.map(\.expectedVersion) == ["c-v1", "b-v1"], "Every selected record version travels with the batch")
                    try check(Set(payload.keys) == Set(["action", "id", "trashId", "items"]), "Delete sends references and versions, not saved task bodies")
                } else {
                    try check(request.id == deletion?.id && request.trashId == deletion?.trashId && request.action == "restore-tasks", "Undo refers to the exact canonical batch")
                    try check(Set(payload.keys) == Set(["action", "id", "trashId", "ids"]), "Undo carries no replacement task copy")
                }
                return receipt(payload)
            }
            store.accept(batchSnapshot()); store.selectTask(id: "b"); store.selectTask(id: "c", extending: true)
            store.selectingTasks = true
            store.accept(batchSnapshot(["d", "c", "a", "b"]))
            try check(store.taskSelection.ids == Set(["b", "c"]), "Projection reorder retains selection IDs")
            let deleted = await store.deleteSelectedTasks()
            try check(deleted && store.tasks.map(\.id) == ["d", "a"] && store.taskSelection.ids.isEmpty, "An exact batch receipt removes only acknowledged selected identities")
            try check(store.taskDeletionNotice?.taskIDs == ["c", "b"] && store.taskDeletionNotice?.id == "c", "Undo and focus retain the batch membership and first affected ID")
            let restored = await store.undoTaskDeletion()
            try check(restored && calls == 2 && store.tasks.map(\.id) == ["d", "a"], "Undo waits for the real canonical projection instead of inserting reconstructed task rows")
            store.accept(batchSnapshot(["d", "c", "a", "b"]))
            try check(store.tasks.count == 4 && store.pendingTaskLifecycle == nil, "Canonical restored projection closes the loop")
            try check(store.endTaskSelection() && !store.selectingTasks && store.taskSelection.ids.isEmpty && !store.endTaskSelection(), "The first Escape exits even an empty selection mode; the next may dismiss the panel")

        case "batch-unknown-ack-restart-exact-members":
            let first = NativeQuickWorkbenchStore(); var original: NativeQuickTaskLifecycleRequest?
            configure(first, directory) { _ in original = try pending(directory); return ["status": "error", "reason": "storage_failed"] }
            first.accept(batchSnapshot()); first.selectAllTasks()
            let uncertain = await first.deleteSelectedTasks()
            try check(!uncertain && first.tasks.count == 4 && first.taskSelection.ids.count == 4 && first.canRecoverTaskLifecycle, "Unknown ACK keeps membership and does not pretend the batch was saved")
            let restarted = NativeQuickWorkbenchStore(); var calls = 0
            configure(restarted, directory, rows: false) { payload in
                calls += 1; try check(try pending(directory) == original, "Restart replays the same versioned batch even when deleted rows no longer appear")
                var response = receipt(payload); if calls == 1 { response["ids"] = ["a", "b", "c"] }; return response
            }
            let partial = await restarted.retryTaskLifecycle()
            try check(!partial && restarted.taskDeletionNotice == nil && restarted.pendingTaskLifecycle == original, "A partial-member success response is not a batch success")
            let exact = await restarted.retryTaskLifecycle()
            try check(exact && calls == 2 && restarted.taskDeletionNotice?.taskIDs == ["a", "b", "c", "d"], "Only the exact ordered membership ACK resolves uncertainty")

        case "batch-edit-and-inflight-locks":
            let store = NativeQuickWorkbenchStore(); var sent: [String: Any] = [:]; var calls = 0
            var release: CheckedContinuation<[String: Any], Error>?
            configure(store, directory) { payload in calls += 1; sent = payload; return try await withCheckedThrowingContinuation { release = $0 } }
            store.accept(batchSnapshot()); store.selectTask(id: "b"); store.selectTask(id: "c", extending: true)
            try check(store.beginEditingTask(id: "c"), "A selected task can own an unsaved editor before deletion")
            store.editingTask?.title = "Unsaved"; let blocked = await store.deleteSelectedTasks()
            try check(!blocked && calls == 0 && store.editingTask?.title == "Unsaved", "Bulk deletion cannot discard an edited selected task")
            store.editingTask = nil
            let first = Task { @MainActor in await store.deleteSelectedTasks() }
            while release == nil { await Task.yield() }
            try check(store.busyTaskIDs == Set(["b", "c"]) && !store.beginEditingTask(id: "b") && !store.canDeleteSelectedTasks, "All targets, not the batch request ID, are locked")
            let update = await store.setTaskCompleted(id: "c", completed: true)
            let duplicate = await store.deleteSelectedTasks()
            try check(!update && !duplicate && calls == 1, "Completion and a second bulk command cannot race a pending batch")
            store.accept(batchSnapshot(["c", "x", "a", "b", "d"], changed: true))
            release?.resume(returning: receipt(sent)); let saved = await first.value
            try check(saved && store.tasks.map(\.id) == ["x", "a", "d"] && store.busyTaskIDs.isEmpty, "An in-flight ordering change never retargets deleted identities")

        case "durable-request-and-exact-delete-receipt":
            let store = NativeQuickWorkbenchStore(); var calls = 0; var sent: NativeQuickTaskLifecycleRequest?
            configure(store, directory) { payload in
                calls += 1
                let onDisk = try pending(directory)
                try check(onDisk?.valid == true && onDisk == store.pendingTaskLifecycle, "A validated immutable request is durable before backend execution")
                try check(onDisk?.id == "synthetic-one" && onDisk?.expectedVersion == "original-v1" && onDisk?.title == "Synthetic task", "The original task/version/title is retained for retry and feedback")
                try check(Set(payload.keys) == Set(["action", "id", "trashId", "expectedVersion"]), "Delete sends no detached task content")
                try check(payload["trashId"] as? String == onDisk?.trashId && payload["action"] as? String == "delete-task", "Backend sees the exact durable deletion identity")
                try check(store.lifecycleBusy && store.busyTaskIDs.contains("synthetic-one") && !store.canRecoverTaskLifecycle, "In-flight mutation blocks row actions and recovery reset")
                let mode = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber
                try check(mode?.intValue == 0o600, "Pending identity file is owner-only")
                sent = onDisk; return receipt(payload)
            }
            let before = Date(); let result = await store.deleteTask(id: "synthetic-one"); let after = Date()
            try check(result && calls == 1 && store.pendingTaskLifecycle == nil && !store.lifecycleBusy && store.busyTaskIDs.isEmpty, "Exact ACK completes once and releases in-flight state")
            try check(try pending(directory) == nil, "Confirmed request is cleared durably")
            try check(store.tasks.isEmpty && store.taskDeletionNotice?.trashId == sent?.trashId, "Only acknowledged deletion removes the row and offers canonical-trash undo")
            try check(store.taskDeletionNotice?.id == sent?.id && store.taskDeletionNotice?.title == sent?.title, "Undo notice points to the acknowledged task")
            let expires = store.taskDeletionNotice!.expiresAt
            try check(expires >= before.addingTimeInterval(5) && expires <= after.addingTimeInterval(5), "Undo notice lasts five seconds from acknowledgement, not send time")

        case "delete-unknown-ack-restart-identity":
            let first = NativeQuickWorkbenchStore(); var calls = 0; var original: NativeQuickTaskLifecycleRequest?
            configure(first, directory) { _ in
                calls += 1; original = try pending(directory)
                throw Failure.assertion("Lost ACK after canonical deletion")
            }
            let initial = await first.deleteTask(id: "synthetic-one")
            try check(!initial && first.taskDeletionNotice == nil && first.pendingTaskLifecycle == original && first.canRecoverTaskLifecycle, "Unknown ACK preserves request without claiming successful undo")
            let restarted = NativeQuickWorkbenchStore()
            configure(restarted, directory, rows: false) { payload in
                calls += 1
                try check(try pending(directory) == original, "Restart retries the identical durable request")
                try check(payload["action"] as? String == "delete-task" && payload["expectedVersion"] as? String == "original-v1" && payload["trashId"] as? String == original?.trashId, "A missing live row never creates a new delete or adopts a new version")
                return receipt(payload)
            }
            restarted.accept(snapshot(version: "newer-v2"))
            let replacement = await restarted.deleteTask(id: "synthetic-one")
            try check(!replacement && calls == 1 && restarted.pendingTaskLifecycle == original, "A new snapshot cannot replace an uncertain deletion")
            restarted.accept(snapshot(rows: false))
            let retried = await restarted.retryTaskLifecycle()
            try check(retried && calls == 2 && restarted.taskDeletionNotice?.trashId == original?.trashId, "Retry resolves the same canonical trash even without a live task row")

        case "undo-canonical-trash-only":
            let store = NativeQuickWorkbenchStore(); var deleted: NativeQuickTaskLifecycleRequest?; var calls = 0
            configure(store, directory) { payload in
                calls += 1
                if calls == 1 { deleted = try pending(directory) }
                else {
                    try check(payload["action"] as? String == "restore-task" && payload["id"] as? String == deleted?.id && payload["trashId"] as? String == deleted?.trashId, "Undo addresses canonical trash from the actual deletion")
                    try check(Set(payload.keys) == Set(["action", "id", "trashId"]), "Undo cannot reconstruct an old detached task or send its former version")
                    let onDisk = try pending(directory)
                    try check(onDisk?.action == "restore-task" && onDisk?.expectedVersion == nil && onDisk == store.pendingTaskLifecycle, "Restore retry identity is durable before the backend call")
                }
                return receipt(payload)
            }
            let deletedOK = await store.deleteTask(id: "synthetic-one")
            let restoredOK = await store.undoTaskDeletion()
            try check(deletedOK && restoredOK && calls == 2 && store.taskDeletionNotice == nil && store.pendingTaskLifecycle == nil, "Matching restored ACK consumes undo exactly once")
            try check(store.tasks.isEmpty, "Restore waits for canonical snapshot; it does not create a task from the notice title")
            store.accept(snapshot(version: "canonical-restored-v3"))
            try check(store.tasks.first?.version == "canonical-restored-v3", "Restored content comes from a real workspace projection")

        case "restore-unknown-ack-restart":
            let first = NativeQuickWorkbenchStore(); var calls = 0; var original: NativeQuickTaskLifecycleRequest?
            configure(first, directory) { payload in
                calls += 1
                if calls == 1 { return receipt(payload) }
                original = try pending(directory); throw Failure.assertion("Lost restore ACK")
            }
            let deletedOK = await first.deleteTask(id: "synthetic-one")
            let restored = await first.undoTaskDeletion()
            try check(deletedOK && !restored && original?.action == "restore-task", "Uncertain undo preserves restore, not another delete")
            let restarted = NativeQuickWorkbenchStore()
            configure(restarted, directory) { payload in
                calls += 1
                try check(try pending(directory) == original && payload["action"] as? String == "restore-task" && payload["trashId"] as? String == original?.trashId && payload["expectedVersion"] == nil, "Restart resolves the same restore independently of notice expiry")
                return receipt(payload)
            }
            try check(restarted.taskDeletionNotice == nil && restarted.pendingTaskLifecycle == original, "Transient notice is not treated as durable task content")
            let retried = await restarted.retryTaskLifecycle()
            try check(retried && calls == 3 && restarted.pendingTaskLifecycle == nil, "Matching restore ACK clears durable uncertainty")

        case "wrong-delete-receipts":
            let store = NativeQuickWorkbenchStore(); var calls = 0; var original: NativeQuickTaskLifecycleRequest?
            configure(store, directory) { payload in
                calls += 1
                if original == nil { original = try pending(directory) }
                try check(try pending(directory) == original, "Every retry keeps its initial immutable request")
                var value = receipt(payload)
                switch calls {
                case 1: value["id"] = "another-task"
                case 2: value["trashId"] = "another-trash"
                case 3: value["status"] = "restored"
                default: value.removeValue(forKey: "trashId")
                }
                return value
            }
            var result = await store.deleteTask(id: "synthetic-one")
            for index in 0..<4 {
                if index > 0 { result = await store.retryTaskLifecycle() }
                try check(!result && store.taskDeletionNotice == nil && store.tasks.count == 1 && store.pendingTaskLifecycle == original, "Wrong or incomplete ACK never removes a row or offers undo")
            }
            try check(calls == 4 && store.error != nil, "All mismatches surface uncertainty")

        case "wrong-restore-receipt":
            let store = NativeQuickWorkbenchStore(); var calls = 0
            configure(store, directory) { payload in
                calls += 1; var value = receipt(payload)
                if calls > 1 { value["trashId"] = "unrelated-trash" }
                return value
            }
            let deletedOK = await store.deleteTask(id: "synthetic-one")
            let notice = store.taskDeletionNotice
            let restored = await store.undoTaskDeletion()
            try check(deletedOK && !restored && store.pendingTaskLifecycle?.action == "restore-task" && store.taskDeletionNotice == notice && store.tasks.isEmpty, "Wrong restore receipt retains exact undo uncertainty and never reconstructs a task")

        case "disk-failure-before-command":
            var fail = true, calls = 0
            let store = NativeQuickWorkbenchStore(write: { data, url in
                if fail { throw CocoaError(.fileWriteOutOfSpace) }; try data.write(to: url, options: .atomic)
            })
            configure(store, directory) { payload in calls += 1; return receipt(payload) }
            let blocked = await store.deleteTask(id: "synthetic-one")
            try check(!blocked && calls == 0 && store.tasks.count == 1 && store.pendingTaskLifecycle == nil && store.taskDeletionNotice == nil && !store.lifecycleBusy, "Undurable delete never leaves the process or consumes the task")
            fail = false
            let retried = await store.deleteTask(id: "synthetic-one")
            try check(retried && calls == 1, "Resolved storage permits a fresh unsent operation")

        case "disk-failure-after-ack":
            var writes = 0, calls = 0; var original: NativeQuickTaskLifecycleRequest?
            let first = NativeQuickWorkbenchStore(write: { data, url in
                writes += 1; if writes == 2 { throw CocoaError(.fileWriteOutOfSpace) }
                try data.write(to: url, options: .atomic)
            })
            configure(first, directory) { payload in calls += 1; original = try pending(directory); return receipt(payload) }
            let uncertain = await first.deleteTask(id: "synthetic-one")
            try check(!uncertain && calls == 1 && first.pendingTaskLifecycle == original && first.taskDeletionNotice == nil, "Failed durable ACK clear retains uncertain identity")
            try check(try pending(directory) == original, "Original identity survives on disk after ACK-clear failure")
            let restarted = NativeQuickWorkbenchStore()
            configure(restarted, directory, rows: false) { payload in
                calls += 1; try check(payload["trashId"] as? String == original?.trashId && payload["expectedVersion"] as? String == original?.expectedVersion, "Restart verifies the acknowledged canonical deletion, not a new operation")
                return receipt(payload)
            }
            let retry = await restarted.retryTaskLifecycle()
            try check(retry && calls == 2, "The same receipt resolves local uncertainty")

        case "ack-clear-writes-then-throws":
            var writes = 0; var original: NativeQuickTaskLifecycleRequest?
            let store = NativeQuickWorkbenchStore(write: { data, url in
                writes += 1; try data.write(to: url, options: .atomic)
                if writes == 2 { throw CocoaError(.fileWriteUnknown) }
            })
            configure(store, directory) { payload in original = try pending(directory); return receipt(payload) }
            let result = await store.deleteTask(id: "synthetic-one")
            try check(!result && store.pendingTaskLifecycle == original && store.taskDeletionNotice == nil, "A late local persistence error does not claim success")
            try check(try pending(directory) == original, "Even a clear writer that commits bytes before throwing must leave the original retry identity restart-safe")

        case "editing-and-unavailable-protection":
            let store = NativeQuickWorkbenchStore(); var calls = 0
            configure(store, directory) { payload in calls += 1; return receipt(payload) }
            try check(store.beginEditingTask(id: "synthetic-one"), "Existing task enters the real editor")
            store.editingTask?.title = "Unsaved manual edit"
            let deleted = await store.deleteTask(id: "synthetic-one")
            try check(!deleted && calls == 0 && store.editingTask?.title == "Unsaved manual edit" && store.pendingTaskLifecycle == nil, "Deleting an edited target cannot discard unsaved input")
            store.editingTask = nil; store.accept(snapshot(ready: false))
            let unavailable = await store.deleteTask(id: "synthetic-one")
            try check(!unavailable && calls == 0 && !FileManager.default.fileExists(atPath: file.path), "Unavailable/private workspace never sends deletion or writes an envelope")

        case "concurrent-operations-lock":
            let store = NativeQuickWorkbenchStore(); var calls = 0; var sent: [String: Any] = [:]
            var release: CheckedContinuation<[String: Any], Error>?
            configure(store, directory) { payload in
                calls += 1; sent = payload
                return try await withCheckedThrowingContinuation { release = $0 }
            }
            let first = Task { @MainActor in await store.deleteTask(id: "synthetic-one") }
            while release == nil { await Task.yield() }
            let duplicate = await store.deleteTask(id: "synthetic-one")
            let retry = await store.retryTaskLifecycle()
            let undo = await store.undoTaskDeletion()
            try check(!duplicate && !retry && !undo && !store.preserveTaskLifecycleRecovery() && !store.beginEditingTask(id: "synthetic-one") && calls == 1, "One in-flight identity excludes competing deletes, undo, retry, recovery, and editing")
            release?.resume(returning: receipt(sent))
            let completed = await first.value
            try check(completed && !store.lifecycleBusy && store.busyTaskIDs.isEmpty, "In-flight locks release after exact ACK")

        case "preserved-recovery-never-mutates-workspace":
            let store = NativeQuickWorkbenchStore(); var calls = 0
            configure(store, directory) { _ in calls += 1; throw Failure.assertion("Unknown canonical outcome") }
            _ = await store.deleteTask(id: "synthetic-one")
            let original = try Data(contentsOf: file)
            try check(store.preserveTaskLifecycleRecovery(), "Pending request can be deliberately preserved without replay")
            try check(calls == 1 && store.pendingTaskLifecycle == nil && store.taskDeletionNotice == nil && store.tasks.count == 1, "Preserving a record does not call backend, report undo, or mutate a task")
            try check(try Data(contentsOf: store.recoveryURL!) == original && pending(directory) == nil, "Exact pending bytes survive in recovery while active envelope resets")
            let retry = await store.retryTaskLifecycle()
            try check(!retry && calls == 1, "Recovery does not leave an accidental replay command")

        case "corrupt-recovery-and-partial-reset":
            let corrupt = Data("unreadable lifecycle envelope".utf8)
            try corrupt.write(to: file)
            var failReset = true, calls = 0
            let store = NativeQuickWorkbenchStore(write: { data, url in
                try data.write(to: url, options: .atomic)
                if failReset && url.lastPathComponent.hasPrefix(".native-quick-task-lifecycle-reset-") { throw CocoaError(.fileWriteUnknown) }
            })
            configure(store, directory) { payload in calls += 1; return receipt(payload) }
            let deleted = await store.deleteTask(id: "synthetic-one")
            try check(!deleted && calls == 0 && store.canRecoverTaskLifecycle, "Corrupt pending bytes cannot be overwritten by a fresh delete")
            try check(!store.preserveTaskLifecycleRecovery(), "Failed reset does not pretend recovery completed")
            try check(try Data(contentsOf: file) == corrupt && store.canRecoverTaskLifecycle && calls == 0, "A writer that throws after reset bytes does not consume the original unreadable envelope")
            failReset = false
            try check(store.preserveTaskLifecycleRecovery(), "Explicit recovery can succeed after local storage recovers")
            try check(try Data(contentsOf: store.recoveryURL!) == corrupt && pending(directory) == nil && calls == 0, "Exact corrupt bytes are preserved without backend activity")

        default: throw Failure.assertion("Unknown case: " + name)
        }
    }
}
`;

test('production task delete and undo preserve durable lifecycle identities', { skip: process.platform !== 'darwin', timeout: 180000 }, async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-task-lifecycle-'));
  try {
    const source = path.join(temporary, 'LifecycleTests.swift');
    const binary = path.join(temporary, 'lifecycle-tests');
    fs.writeFileSync(source, harness);
    const compiled = spawnSync('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', ...sources, source, '-o', binary], { encoding: 'utf8', timeout: 90000 });
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr + (compiled.error?.message ?? ''));
    for (const name of ['stable-id-selection-range-and-reorder', 'batch-durable-membership-and-canonical-undo', 'batch-unknown-ack-restart-exact-members', 'batch-edit-and-inflight-locks', 'durable-request-and-exact-delete-receipt', 'delete-unknown-ack-restart-identity', 'undo-canonical-trash-only', 'restore-unknown-ack-restart', 'wrong-delete-receipts', 'wrong-restore-receipt', 'disk-failure-before-command', 'disk-failure-after-ack', 'ack-clear-writes-then-throws', 'editing-and-unavailable-protection', 'concurrent-operations-lock', 'preserved-recovery-never-mutates-workspace', 'corrupt-recovery-and-partial-reset']) {
      await t.test(name, () => {
        const result = spawnSync(binary, [name, path.join(temporary, name)], { encoding: 'utf8', timeout: 15000 });
        assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message ?? ''));
        assert.ok(result.stdout.includes('PASS: ' + name));
      });
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
