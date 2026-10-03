import AppKit
import SwiftUI
func nativeUI(_ zh: String, _ en: String) -> String { en }

@MainActor final class ReminderClock {
    var date = ISO8601DateFormatter().date(from: "2030-10-03T09:00:00+08:00")!
    var zone = "Asia/Shanghai"
    var onRead: (() -> Void)?
    func read() -> Date { onRead?(); return date }
    var calendar: Calendar { var value = Calendar(identifier: .gregorian); value.timeZone = TimeZone(identifier: zone)!; return value }
}
@main struct ReminderChecks {
    @MainActor static func main() async throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1]), fm = FileManager.default
        var checks = 0
        func check(_ pass: Bool, _ label: String) { precondition(pass, label); checks += 1; print("ok \(checks): \(label)") }
        func date(_ value: String) -> Date { ISO8601DateFormatter().date(from: value)! }
        func wait(_ label: String, _ predicate: () -> Bool) async {
            for _ in 0..<400 { if predicate() { return }; try? await Task.sleep(nanoseconds: 5_000_000) }
            precondition(predicate(), "Timed out: " + label)
        }
        func settle() async { try? await Task.sleep(nanoseconds: 45_000_000) }
        func task(_ id: String, _ due: NativeQuickTaskDate?, title: String = "Synthetic reminder title", completed: Bool = false, version: String = "v1", saving: Bool = false) -> NativeQuickTaskItem {
            .init(id: id, title: title, projectTitle: "", dueLabel: "", isCompleted: completed, version: version, isSaving: saving, dueAt: due)
        }
        func fixture(_ directory: URL, clock: ReminderClock, owner: String = "synthetic-workspace") async -> (NativeQuickTaskReminderStore, NativeQuickNotificationSources, NativeQuickNotificationQueue) {
            let q = NativeQuickNotificationQueue(ownerID: owner, schedulesTimers: false)
            q.setReducedMotion(true)
            let s = NativeQuickNotificationSources(queue: q, now: { clock.read() }); s.accept([])
            let r = NativeQuickTaskReminderStore(directory: directory, ownerID: owner, sources: s,
                now: { clock.read() }, calendar: { clock.calendar }, schedulesTimers: false)
            r.accept(tasks: [])
            await wait("archive load") { r.loaded || r.error != nil }
            return (r, s, q)
        }
        let clock = ReminderClock(), folder = root.appendingPathComponent("normal")
        let (r, sources, q) = await fixture(folder, clock: clock)
        let a = task("a", .text("2030-10-03T11:00:00+08:00"))
        r.accept(tasks: [a]); r.tick(); await settle()
        check(!r.enabled && q.history.isEmpty, "Fresh install defaults off without requesting system permission")
        await r.setEnabled(true); await settle()
        check(r.enabled && q.history.isEmpty, "Explicit enable preserves the exact one-hour trigger")
        clock.date = date("2030-10-03T10:00:00+08:00"); r.tick()
        await wait("first deadline") { q.history.count == 1 }
        let firstID = q.history[0].id, token = r.navigationToken(taskID: "a")!
        check(q.history[0].destination == .task("a") && q.history[0].source == .task && q.history[0].outcome == .information, "Real task identity enters information queue, never fake completion")
        check(r.canOpen(token), "Current task and durable attempt admit a navigation token")
        r.accept(tasks: [a]); r.tick(); r.tick(); await settle()
        check(q.history.count == 1, "Repeated task snapshots and ticks do not duplicate")
        await r.setEnabled(false)
        check(!r.enabled && q.current == nil && q.history.isEmpty && !r.canOpen(token), "Off immediately withdraws current and history and revokes navigation")
        await r.setEnabled(true); await settle()
        check(q.history.isEmpty, "Off/on does not replay the already-attempted deadline")
        r.shutdown()

        let (restart, _, qr) = await fixture(folder, clock: clock)
        restart.accept(tasks: [a]); await settle()
        check(restart.enabled && qr.history.isEmpty, "Restart within the same hour preserves preference and dedupe")
        let rescheduled = task("a", .text("2030-10-03T11:15:00+08:00"), version: "v2")
        restart.accept(tasks: [rescheduled]); clock.date = date("2030-10-03T10:15:00+08:00"); restart.tick()
        await wait("rescheduled reminder") { qr.history.count == 1 }
        let shifted = restart.navigationToken(taskID: "a")!
        check(qr.history[0].id != firstID && shifted.cutoff == date("2030-10-03T11:15:00+08:00"), "Changing effective deadline produces a fresh reminder")
        restart.accept(tasks: [task("a", rescheduled.dueAt, completed: true, version: "v3")])
        check(qr.history.isEmpty && qr.current == nil && !restart.canOpen(shifted), "Completed task disappears immediately from queue and navigation")
        restart.accept(tasks: [rescheduled]); await settle()
        check(qr.history.isEmpty, "Unchecking completion does not replay the same attempted deadline")
        let persisted = try String(contentsOf: folder.appendingPathComponent("reminders.json"), encoding: .utf8)
        check(!persisted.contains("Synthetic") && !persisted.contains("synthetic-workspace") && !persisted.contains("\"taskID\""), "Archive contains only hash receipts and settings, no copied task title or workspace path")
        restart.shutdown()

        let invalidClock = ReminderClock(); invalidClock.date = clock.date
        let (invalid, _, qi) = await fixture(root.appendingPathComponent("invalid"), clock: invalidClock)
        await invalid.setEnabled(true)
        let due = NativeQuickTaskDate.time(clock.date.addingTimeInterval(1200))
        invalid.accept(tasks: [task("dup", due), task("dup", due), task("", due), task("past", .milliseconds(clock.date.timeIntervalSince1970 * 1000)),
            task("bad", .text("2030-02-30")), task("finished", due, completed: true), task("saving", due, saving: true), task("disabled", due)], disabledTaskIDs: ["disabled"])
        await settle()
        check(qi.history.isEmpty, "Duplicate/empty IDs, invalid/expired dates, completed/saving/disabled tasks fail closed")
        invalid.accept(tasks: [task("present", due)]); await wait("eligible") { qi.history.count == 1 }
        let deletedToken = invalid.navigationToken(taskID: "present")!
        invalid.accept(tasks: [])
        check(qi.current == nil && qi.history.isEmpty && !invalid.canOpen(deletedToken), "Deletion removes both toast and retained history")
        invalid.accept(tasks: [task("permission", due)]); await wait("disabled fixture") { qi.history.count == 1 }
        invalid.accept(tasks: [task("permission", due)], disabledTaskIDs: ["permission"])
        check(qi.history.isEmpty, "Per-task reminder opt-out revokes an existing reminder")
        invalid.accept(tasks: [task("edited", due)]); await wait("edit fixture") { qi.history.count == 1 }
        let versionToken = invalid.navigationToken(taskID: "edited")!
        invalid.accept(tasks: [task("edited", due, version: "v2")])
        check(!invalid.canOpen(versionToken) && qi.history.isEmpty, "A changed record version cannot reuse an old navigation capability")
        invalid.accept(tasks: [task("changed-due", due)]); await wait("date fixture") { qi.history.count == 1 }
        let dueToken = invalid.navigationToken(taskID: "changed-due")!
        invalid.accept(tasks: [task("changed-due", .time(clock.date.addingTimeInterval(7200)), version: "v2")])
        check(qi.history.isEmpty && !invalid.canOpen(dueToken), "Moving the deadline out of the hour immediately withdraws the old reminder")
        invalid.shutdown()

        let (privacy, privateSources, qp) = await fixture(root.appendingPathComponent("privacy"), clock: clock)
        await privacy.setEnabled(true)
        privacy.accept(tasks: [task("private-a", due, title: "Synthetic private title")]); await wait("privacy event") { qp.history.count == 1 }
        let privateToken = privacy.navigationToken(taskID: "private-a")!
        privateSources.accept(nil); privacy.accept(tasks: nil)
        check(qp.current == nil && qp.history.isEmpty && qp.pendingEventCount == 0 && !privacy.canOpen(privateToken), "Private entry drops titles in current, waiting, history and navigation")
        privateSources.accept([]); privacy.accept(tasks: [task("private-a", due)])
        await settle()
        check(qp.history.isEmpty, "Private exit does not replay the previous attempt")
        privacy.accept(tasks: [task("race", due)])
        privacy.accept(tasks: nil); privateSources.accept(nil); await settle()
        check(qp.history.isEmpty && qp.current == nil, "Revocation before an asynchronous claim completes cannot enqueue late")
        privacy.shutdown()

        let (wake, _, qw) = await fixture(root.appendingPathComponent("wake"), clock: clock)
        await wake.setEnabled(true)
        wake.accept(tasks: [task("wake-before", .time(clock.date.addingTimeInterval(7200)))])
        clock.date = clock.date.addingTimeInterval(5400); wake.tick(); await wait("wake catch-up") { qw.history.count == 1 }
        check(qw.history[0].destination == .task("wake-before"), "Wake inside the final hour catches up once")
        clock.date = clock.date.addingTimeInterval(1800); wake.tick()
        check(qw.current == nil && qw.history.isEmpty, "Exact deadline expires and removes pending notification")
        wake.accept(tasks: [task("wake-past", .time(clock.date.addingTimeInterval(-1)))])
        await settle()
        check(qw.history.isEmpty, "Wake past deadline never replays old history")
        wake.shutdown()

        let zoneClock = ReminderClock(); zoneClock.zone = "America/Los_Angeles"; zoneClock.date = date("2030-03-10T22:59:59-07:00")
        let (zone, _, qz) = await fixture(root.appendingPathComponent("zone"), clock: zoneClock)
        await zone.setEnabled(true); zone.accept(tasks: [task("spring", .text("2030-03-10"))]); await settle()
        check(qz.history.isEmpty, "DST all-day task does not trigger before local 23:00")
        zoneClock.date = date("2030-03-10T23:00:00-07:00"); zone.tick(); await wait("DST spring") { qz.history.count == 1 }
        let spring = zone.navigationToken(taskID: "spring")!
        check(spring.cutoff == date("2030-03-11T00:00:00-07:00"), "23-hour day still reminds one hour before the next local midnight")
        zoneClock.zone = "Pacific/Honolulu"; zone.tick()
        check(qz.history.isEmpty && !zone.canOpen(spring), "Timezone change invalidates the old live cutoff and token")
        zoneClock.date = date("2030-03-10T23:00:00-10:00"); zone.tick(); await settle()
        check(qz.history.isEmpty, "Travel does not replay the same logical all-day deadline")
        zoneClock.zone = "America/Los_Angeles"; zoneClock.date = date("2030-11-03T23:00:00-08:00")
        zone.accept(tasks: [task("fall", .text("2030-11-03"))]); await wait("DST fall") { qz.history.count == 1 }
        check(zone.navigationToken(taskID: "fall")?.cutoff == date("2030-11-04T00:00:00-08:00"), "25-hour day retains the same local final-hour semantics")
        zone.shutdown()

        let failureClock = ReminderClock(), failDir = root.appendingPathComponent("failure")
        let (failure, _, qf) = await fixture(failDir, clock: failureClock)
        await failure.setEnabled(true)
        let path = failDir.appendingPathComponent("reminders.json"), saved = try Data(contentsOf: path)
        try fm.removeItem(at: path); try fm.createDirectory(at: path, withIntermediateDirectories: false)
        failure.accept(tasks: [task("write-fail", .time(failureClock.date.addingTimeInterval(1200)))])
        await wait("failed save") { failure.error != nil }
        check(qf.history.isEmpty, "Receipt write failure produces no false notification")
        try fm.removeItem(at: path); try saved.write(to: path); failure.retry()
        await wait("retry receipt") { qf.history.count == 1 }
        check(failure.error == nil, "Explicit retry after storage repair enqueues exactly once")
        let acknowledged = try Data(contentsOf: path)
        try fm.removeItem(at: path); try fm.createDirectory(at: path, withIntermediateDirectories: false)
        await failure.setEnabled(false)
        check(!failure.enabled && failure.error != nil && qf.history.isEmpty, "Failed OFF write still stops this session and reports durable failure")
        failure.accept(tasks: nil); failure.accept(tasks: [])
        await settle()
        check(!failure.enabled && failure.error != nil, "A private/unavailable round trip cannot revive failed OFF preference")
        try fm.removeItem(at: path); try acknowledged.write(to: path); failure.retry()
        await wait("retry preference") { failure.error == nil && !failure.savingPreference }
        check(try await NativeQuickTaskReminderArchive(directory: failDir).load().enabled == false, "Retry saves failed OFF rather than merely hiding its error")
        failure.shutdown()

        let fullClock = ReminderClock(), fullDir = root.appendingPathComponent("full")
        let (full, _, qq) = await fixture(fullDir, clock: fullClock)
        await full.setEnabled(true)
        for index in 0..<NativeQuickNotificationQueue.retainedEventLimit {
            _ = qq.enqueue(.init(id: "other:\(index)", ownerID: qq.ownerID, source: .agent, title: "Synthetic existing event \(index)", destination: .run("run-\(index)"))!)
        }
        full.accept(tasks: [task("full", .time(fullClock.date.addingTimeInterval(1200)))])
        await wait("queue full") { full.queueBlocked }
        check(try await NativeQuickTaskReminderArchive(directory: fullDir).load().receipts.isEmpty, "Full queue does not consume a reminder receipt")
        full.accept(tasks: [])
        check(!full.queueBlocked, "Deleting the last preflight-blocked task clears the obsolete full-queue notice")
        full.accept(tasks: [task("full", .time(fullClock.date.addingTimeInterval(1200)))])
        await wait("queue full again") { full.queueBlocked }
        qq.reset(ownerID: qq.ownerID); fullClock.date = fullClock.date.addingTimeInterval(15); full.tick()
        await wait("queue capacity returned") { qq.history.count == 1 }
        check(qq.history[0].destination == .task("full") && !full.queueBlocked, "Capacity recovery retries before deadline without fake completion")
        full.shutdown()

        // Deterministic actor-boundary faults: the injected clock is first
        // consulted after the real atomic claim appears on disk. No fake
        // persistence implementation, live workspace or main-loop GUI involved.
        for deleteBeforeRetry in [false, true] {
        let raceClock = ReminderClock(), raceDir = root.appendingPathComponent("full-after-claim-\(deleteBeforeRetry)")
        let (race, _, rq) = await fixture(raceDir, clock: raceClock)
        await race.setEnabled(true)
        let racePath = raceDir.appendingPathComponent("reminders.json")
        var blockedAfterClaim = false, claimedBytes: Data?
        raceClock.onRead = {
            guard !blockedAfterClaim, let bytes = try? Data(contentsOf: racePath),
                  let state = try? JSONDecoder().decode(NativeQuickTaskReminderArchiveState.self, from: bytes), !state.receipts.isEmpty else { return }
            blockedAfterClaim = true; claimedBytes = bytes
            for index in 0..<NativeQuickNotificationQueue.retainedEventLimit {
                _ = rq.enqueue(.init(id: "late-fill:\(index)", ownerID: rq.ownerID, source: .agent, title: "Synthetic competing event", destination: .run("late-\(index)"))!)
            }
            try! fm.removeItem(at: racePath); try! fm.createDirectory(at: racePath, withIntermediateDirectories: false)
        }
        race.accept(tasks: [task("late-full", .time(raceClock.date.addingTimeInterval(1200)))])
        await wait("failed full rollback") { race.error != nil }
        check(blockedAfterClaim && !rq.history.contains { $0.source == .task }, "Queue filling during durable claim rejects task delivery and exposes rollback failure")
        raceClock.onRead = nil
        if deleteBeforeRetry { race.accept(tasks: []) }
        try fm.removeItem(at: racePath); try claimedBytes!.write(to: racePath)
        rq.reset(ownerID: rq.ownerID); race.retry()
        if deleteBeforeRetry {
            await wait("rollback with no remaining task") { race.error == nil }
            check(rq.history.isEmpty && !race.queueBlocked, "Successful rollback after task deletion clears obsolete delivery errors without showing a reminder")
            check(try await NativeQuickTaskReminderArchive(directory: raceDir).load().receipts.isEmpty, "Deleted unaccepted task leaves no consumed attempt")
        } else {
        await wait("rollback retry") { rq.history.contains { $0.destination == .task("late-full") } }
        check(rq.history.count == 1 && race.error == nil, "Retry repairs the rejected receipt before enqueuing exactly once")
        check(try await NativeQuickTaskReminderArchive(directory: raceDir).load().receipts.count == 1, "Compensated retry retains only its acknowledged final attempt")
        }
        race.shutdown()
        }

        let editClock = ReminderClock(), editDir = root.appendingPathComponent("snapshot-during-claim")
        let (edit, _, eq) = await fixture(editDir, clock: editClock)
        await edit.setEnabled(true)
        let editDue = NativeQuickTaskDate.time(editClock.date.addingTimeInterval(1200)), editPath = editDir.appendingPathComponent("reminders.json")
        var editedAfterClaim = false
        editClock.onRead = {
            guard !editedAfterClaim, let bytes = try? Data(contentsOf: editPath),
                  let state = try? JSONDecoder().decode(NativeQuickTaskReminderArchiveState.self, from: bytes), !state.receipts.isEmpty else { return }
            editedAfterClaim = true
            edit.accept(tasks: [task("editing", editDue, title: "Synthetic updated title", version: "v2"),
                                task("unrelated", nil)])
        }
        edit.accept(tasks: [task("editing", editDue)])
        await wait("snapshot changed after claim") { eq.history.count == 1 }
        check(editedAfterClaim && eq.history[0].title == "Synthetic updated title", "Snapshot change after claim releases the stale candidate and presents only the current title")
        check(edit.navigationToken(taskID: "editing")?.version == "v2", "Navigation token is created from the current record version after a concurrent edit")
        editClock.onRead = nil; edit.shutdown()

        let gateDir = root.appendingPathComponent("gate"), archive = NativeQuickTaskReminderArchive(directory: gateDir)
        _ = try await archive.setEnabled(true, gate: .init())
        let receipt = NativeQuickTaskReminderReceipt(fingerprint: String(repeating: "a", count: 64), cutoff: clock.date.addingTimeInterval(1200), claimedAt: clock.date)
        let gate = NativeQuickTaskReminderGate(); gate.revoke()
        let before = try Data(contentsOf: gateDir.appendingPathComponent("reminders.json"))
        do { _ = try await archive.claim(receipt, gate: gate); preconditionFailure("Revoked commit must reject") }
        catch is CancellationError { checks += 1 }
        check(try Data(contentsOf: gateDir.appendingPathComponent("reminders.json")) == before, "Revoked commit leaves durable state byte-for-byte unchanged")
        let claimed = try await archive.claim(receipt, gate: .init())
        let duplicate = try await archive.claim(receipt, gate: .init())
        check(claimed.inserted && !duplicate.inserted && duplicate.state.receipts.count == 1, "Durable claim dedupe is independent of UI/timer state")
        let otherAttempt = NativeQuickTaskReminderReceipt(fingerprint: receipt.fingerprint, cutoff: receipt.cutoff, claimedAt: receipt.claimedAt.addingTimeInterval(1))
        check(try await archive.release(otherAttempt, gate: .init()).receipts.count == 1, "Failed enqueue rollback can release only its exact own attempt")
        let stat = try fm.attributesOfItem(atPath: gateDir.appendingPathComponent("reminders.json").path)
        check((stat[.posixPermissions] as! NSNumber).intValue == 0o600, "Local receipt manifest has owner-only permissions")
        let badDir = root.appendingPathComponent("corrupt"); try fm.createDirectory(at: badDir, withIntermediateDirectories: false)
        let corrupt = Data("invalid synthetic archive".utf8); try corrupt.write(to: badDir.appendingPathComponent("reminders.json"))
        let (bad, _, qb) = await fixture(badDir, clock: clock)
        bad.accept(tasks: [task("corrupt", .time(clock.date.addingTimeInterval(1200)))])
        await bad.setEnabled(true)
        check(!bad.loaded && !bad.enabled && qb.history.isEmpty && bad.error != nil, "Corrupt archive fails closed and does not silently replace dedupe history")
        check(try Data(contentsOf: badDir.appendingPathComponent("reminders.json")) == corrupt, "Corrupt receipt file is preserved for recovery")
        bad.shutdown()
        check(sources.acceptTaskReminder(.init(id: "invalid-kind", ownerID: q.ownerID, source: .task, title: "Synthetic", outcome: .completed, destination: .task("a"))!) == nil, "Source adapter refuses fake task completion events")
        check(sources.acceptTaskReminder(.init(id: "invalid-owner", ownerID: "other-owner", source: .task, title: "Synthetic", destination: .task("a"))!) == nil, "Source adapter rejects cross-workspace events")
        sources.accept(nil)
        check(sources.acceptTaskReminder(.init(id: "unavailable", ownerID: q.ownerID, source: .task, title: "Synthetic", destination: .task("a"))!) == nil, "Source adapter rejects unavailable workspace delivery")
        print("PASS: \(checks) task reminder checks")
    }
}
