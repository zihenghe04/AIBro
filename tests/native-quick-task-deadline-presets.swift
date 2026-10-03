import Foundation
import SwiftUI
import Combine
func nativeUI(_ zh: String, _ en: String) -> String { en }
@MainActor final class DeadlineReplyGate {
    var wait: CheckedContinuation<[String: Any], Never>?
    func result() async -> [String: Any] { await withCheckedContinuation { wait = $0 } }
    func finish(_ result: [String: Any]) { wait?.resume(returning: result); wait = nil }
}
@main struct DeadlinePresetTests {
    @MainActor static func main() async throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        func check(_ value: Bool, _ label: String) { precondition(value, label); print("PASS: " + label) }
        func date(_ text: String) -> Date { ISO8601DateFormatter().date(from: text)! }
        func calendar(_ zone: String) -> Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: zone)!; return c }
        let sh = calendar("Asia/Shanghai"), la = calendar("America/Los_Angeles")
        let cutoff = date("2030-12-31T23:30:00+08:00"), justBefore = cutoff.addingTimeInterval(-1)
        check(NativeQuickTaskDeadlineDefault.none.deadline(now: justBefore, calendar: sh) == nil, "Fresh install keeps no deadline")
        check(NativeQuickTaskDeadlinePreset.today.deadline(now: justBefore, calendar: sh)?.date == cutoff, "Explicit Today targets local 23:30")
        check(NativeQuickTaskDeadlinePreset.today.deadline(now: cutoff, calendar: sh) == nil, "Today at or after cutoff is unavailable, not silently tomorrow")
        check(NativeQuickTaskDeadlineDefault.nextEvening.deadline(now: cutoff, calendar: sh)?.date == date("2031-01-01T23:30:00+08:00"), "Automatic next evening rolls across year after cutoff")
        check(NativeQuickTaskDeadlinePreset.tomorrow.deadline(now: date("2030-03-09T23:30:00-08:00"), calendar: la)?.date == date("2030-03-10T23:30:00-07:00"), "Spring DST keeps next local evening rather than adding 24 hours")
        check(NativeQuickTaskDeadlinePreset.tomorrow.deadline(now: date("2030-11-02T23:30:00-07:00"), calendar: la)?.date == date("2030-11-03T23:30:00-08:00"), "Autumn DST keeps next local evening")
        check(NativeQuickTaskDeadlinePreset.week.deadline(now: date("2032-02-25T10:00:00+08:00"), calendar: sh)?.date == date("2032-03-03T23:30:00+08:00"), "Seven-day shortcut respects leap day")
        check(NativeQuickTaskDeadlinePreset.none.deadline(now: cutoff, calendar: sh) == nil, "Explicit no deadline stays nil")
        let prefDirectory = root.appendingPathComponent("preferences"), prefs = NativeQuickTaskDeadlinePreferences(directory: prefDirectory)
        check(try await prefs.load() == .none && !FileManager.default.fileExists(atPath: prefDirectory.path), "Reading absent settings does not create files or opt in")
        try await prefs.save(.nextEvening)
        check(try await NativeQuickTaskDeadlinePreferences(directory: prefDirectory).load() == .nextEvening, "Selected local default survives a new preference instance")
        let mode = try FileManager.default.attributesOfItem(atPath: prefDirectory.appendingPathComponent("deadline.json").path)[.posixPermissions] as? NSNumber
        check(mode?.intValue == 0o600, "Preference archive has private file mode")
        var now = date("2030-12-31T10:00:00+08:00"), payloads: [[String: Any]] = []
        let store = NativeQuickWorkbenchStore(deadlinePreferences: prefs, now: { now }, calendar: { sh })
        func snapshot(_ ready: Bool = true) -> NativeQuickWorkbenchSnapshot {
            let row = NativeQuickTaskItem(id: "synthetic-existing", title: "Fictional task", projectTitle: "", dueLabel: "", isCompleted: false, version: "v1", dueAt: .text("2030-10-01"))
            return NativeQuickWorkbenchSnapshot(version: 1, status: ready ? "ready" : "deferred", reason: nil, tasks: ready ? [row] : [], runs: [], taskCount: ready ? 1 : 0, runCount: 0)
        }
        store.configure(directory: root.appendingPathComponent("workspace"), command: { p in payloads.append(p); return ["status": "saved", "id": p["id"]!] }, openTask: { _ in false }, openRun: { _ in false })
        store.accept(snapshot()); await store.loadCreationDeadlinePreference()
        defer { store.taskInbox.setAvailable(false) }
        check(store.creationFields.dueAt?.date == cutoff && !store.hasUnsavedTaskCreationFields, "Automatic date alone does not trigger a quit draft warning")
        store.creationFields.workspace = "课程"; store.creationFields.workflowCategory = "P0"
        check(store.hasUnsavedTaskCreationFields, "Actual scope/category edits retain draft protection")
        store.refreshCreationDeadline()
        check(store.creationFields.workspace == "课程" && store.creationFields.workflowCategory == "P0", "Default refresh preserves scope and workflow metadata")
        store.markCreationDeadlineManual() // choosing even the same visible timestamp is an explicit choice
        let fixed = store.creationFields
        now = date("2031-01-01T09:00:00+08:00"); store.refreshCreationDeadline(); store.accept(snapshot(false)); store.accept(snapshot()); store.refreshCreationDeadline()
        check(store.creationFields == fixed, "Same-value manual choice survives wake, midnight and availability changes")
        check(!store.resetCreationFields(after: fixed), "No successful creation ACK means no automatic reset")
        check(await store.createTask(title: "Synthetic deadline task", fields: fixed), "Existing durable create path accepts fixed submitted fields")
        check(payloads.last?["dueAt"] as? String == fixed.dueAt?.jsonValue as? String, "Canonical task payload uses exactly the displayed manual date")
        check(store.resetCreationFields(after: fixed), "Exact persisted ACK may reset the creation form")
        check(store.creationFields.dueAt?.date == date("2031-01-01T23:30:00+08:00") && !store.hasUnsavedTaskCreationFields, "Successful reset uses the new day's preferred default")
        check(!store.resetCreationFields(after: fixed), "An old ACK cannot be consumed twice")
        now = date("2031-01-02T01:00:00+08:00"); store.refreshCreationDeadline()
        check(store.creationFields.dueAt?.date == date("2031-01-02T23:30:00+08:00"), "Untouched default advances after midnight")
        check(store.beginEditingTask(id: "synthetic-existing"), "Saved task opens its canonical editor")
        now = date("2031-01-04T01:00:00+08:00"); store.refreshCreationDeadline()
        check(store.editingTask?.fields.dueAt == .text("2030-10-01"), "Automatic creation defaults never alter an existing task editor")
        store.markCreationDeadlineManual(); store.creationFields.dueAt = nil
        await store.setCreationDeadlineDefault(.tomorrowEvening)
        check(store.creationDeadlineDefault == .tomorrowEvening && store.creationFields.dueAt == nil, "Choosing a future default does not undo explicit no deadline")
        let broken = NativeQuickTaskDeadlinePreferences(directory: root.appendingPathComponent("failed-preference"), beforeWrite: { throw CocoaError(.fileWriteOutOfSpace) })
        let failed = NativeQuickWorkbenchStore(deadlinePreferences: broken, now: { now }, calendar: { sh })
        failed.configure(directory: root.appendingPathComponent("failed-workspace"), command: { _ in [:] }, openTask: { _ in false }, openRun: { _ in false }); failed.accept(snapshot())
        defer { failed.taskInbox.setAvailable(false) }
        await failed.setCreationDeadlineDefault(.nextEvening)
        check(failed.creationDeadlineDefault == .none && failed.creationFields.dueAt == nil && failed.deadlinePreferenceError != nil && !failed.deadlinePreferenceBusy, "Real preference writer failure preserves current default/input and reports failure")
        let pendingDir = root.appendingPathComponent("unconfirmed-workspace"), first = NativeQuickWorkbenchStore(deadlinePreferences: prefs, now: { now }, calendar: { sh })
        var firstID: String?, retryID: String?
        first.configure(directory: pendingDir, command: { p in firstID = p["id"] as? String; return ["status":"error", "reason":"storage_failed"] }, openTask: { _ in false }, openRun: { _ in false })
        first.accept(snapshot()); await first.loadCreationDeadlinePreference(); let exact = first.creationFields
        check(!(await first.createTask(title: "Unconfirmed synthetic task", fields: exact)), "Unconfirmed create retains a retry request")
        now = now.addingTimeInterval(3 * 86400); first.refreshCreationDeadline()
        check(first.pendingTaskFields == exact && !first.resetCreationFields(after: exact), "Midnight refresh cannot change an unconfirmed request or reset on failure")
        first.taskInbox.setAvailable(false)
        let restart = NativeQuickWorkbenchStore(deadlinePreferences: prefs, now: { now }, calendar: { sh })
        restart.configure(directory: pendingDir, command: { p in retryID = p["id"] as? String; return ["status":"saved", "id":p["id"]!] }, openTask: { _ in false }, openRun: { _ in false })
        restart.accept(snapshot()); await restart.loadCreationDeadlinePreference(); restart.refreshCreationDeadline()
        defer { restart.taskInbox.setAvailable(false) }
        check(restart.pendingTaskFields == exact && restart.creationFields == exact, "Restarted pending input ignores newer default and clock")
        check(await restart.createTask(title: "Unconfirmed synthetic task", fields: exact), "Retry confirms the original request")
        check(firstID == retryID && restart.resetCreationFields(after: exact), "Same identity retry resets only after its ACK")
        let gate = DeadlineReplyGate(), delayed = NativeQuickWorkbenchStore(deadlinePreferences: prefs, now: { now }, calendar: { sh })
        delayed.configure(directory: root.appendingPathComponent("late-ack"), command: { p in var reply = await gate.result(); reply["id"] = p["id"]; return reply }, openTask: { _ in false }, openRun: { _ in false })
        delayed.accept(snapshot()); await delayed.loadCreationDeadlinePreference(); let submitted = delayed.creationFields
        defer { delayed.taskInbox.setAvailable(false) }
        let request = Task { await delayed.createTask(title: "Delayed synthetic task", fields: submitted) }
        while gate.wait == nil { await Task.yield() }
        delayed.creationFields.workspace = "科研"; delayed.creationFields = submitted
        gate.finish(["status":"saved"])
        check(await request.value && !delayed.resetCreationFields(after: submitted), "Edit-and-revert while awaiting ACK prevents a late reset")
        delayed.accept(snapshot(false))
        check(delayed.startNewTaskFields() && delayed.creationFields == NativeQuickTaskFields(), "Explicit new input can clear preserved fields while unavailable without assigning an automatic date")
        delayed.accept(snapshot()); delayed.refreshCreationDeadline()
        check(delayed.creationFields.dueAt != nil && !delayed.hasUnsavedTaskCreationFields, "Returning ready applies only the untouched automatic default")
        print("PASS: actual Workbench + task fields SwiftUI compiled; no GUI, microphone, network or user workspace used")
    }
}
