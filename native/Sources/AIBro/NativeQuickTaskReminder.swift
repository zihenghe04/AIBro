import AppKit
import Combine
import CryptoKit

struct NativeQuickTaskReminderNavigationToken: Equatable {
    let taskID: String
    let fingerprint: String
    let cutoff: Date
    let version: String
}

/// TO-DO Panel T07: main.js:623–678 / main-services.js:210–231 at
/// 1deb3cac1e32599f13b1d6b30a7e52af76f67efd (MIT). Native equivalent uses
/// the workspace's access-filtered projection, not a second persisted task list.
@MainActor final class NativeQuickTaskReminderStore: ObservableObject {
    nonisolated static let lead: TimeInterval = 3600
    @Published private(set) var loaded = false
    @Published private(set) var enabled = false
    @Published private(set) var savingPreference = false
    @Published private(set) var available = false
    @Published private(set) var queueBlocked = false
    @Published private(set) var error: String?
    var onEventsInvalidated: (@MainActor () -> Void)?
    private struct Candidate {
        let token: NativeQuickTaskReminderNavigationToken
        let event: NativeQuickNotificationEvent
        var trigger: Date { token.cutoff.addingTimeInterval(-NativeQuickTaskReminderStore.lead) }
    }
    private let archive: NativeQuickTaskReminderArchive
    private let sources: NativeQuickNotificationSources
    private let ownerID: String
    private let now: () -> Date
    private let calendar: () -> Calendar
    private let schedulesTimers: Bool
    private var tasks: [NativeQuickTaskItem] = []
    private var disabledTaskIDs = Set<String>()
    private var seen = Set<String>()
    private var presented: [String: NativeQuickTaskReminderNavigationToken] = [:]
    private var taskGeneration: UInt64 = 0
    private var accessGeneration: UInt64 = 0
    private var processingID: UUID?
    private var processing: Task<Void, Never>?
    private var loading: Task<Void, Never>?
    private var timer: Task<Void, Never>?
    private var processingGate: NativeQuickTaskReminderGate?
    private var preferenceGate: NativeQuickTaskReminderGate?
    private var retryAfter: Date?
    private var preferenceToRetry: Bool?
    // Known unaccepted attempts must retry their precise rollback before a
    // future enqueue. A failed rollback cannot be hidden by `seen` dedupe.
    private var rejectedReceipts: [NativeQuickTaskReminderReceipt] = []
    private var stopped = false
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []

    init(directory: URL, ownerID: String, sources: NativeQuickNotificationSources,
         now: @escaping () -> Date = Date.init, calendar: @escaping () -> Calendar = { .current }, schedulesTimers: Bool = true) {
        self.archive = NativeQuickTaskReminderArchive(directory: directory)
        self.ownerID = ownerID; self.sources = sources; self.now = now; self.calendar = calendar; self.schedulesTimers = schedulesTimers
        loadState()
        if schedulesTimers {
            observe(NSWorkspace.shared.notificationCenter, NSWorkspace.didWakeNotification)
            observe(.default, .NSSystemClockDidChange)
            observe(.default, .NSSystemTimeZoneDidChange)
        }
    }
    deinit {
        timer?.cancel(); processing?.cancel(); loading?.cancel()
        processingGate?.revoke(); preferenceGate?.revoke()
        for (center, observer) in observers { center.removeObserver(observer) }
    }
    private func observe(_ center: NotificationCenter, _ name: Notification.Name) {
        observers.append((center, center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in self?.tick() }
        }))
    }
    private func loadState() {
        loading?.cancel()
        loading = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let state = try await archive.load()
                guard !stopped, !Task.isCancelled else { return }
                enabled = preferenceToRetry == false ? false : state.enabled
                seen = Set(state.receipts.map(\.fingerprint)); loaded = true
                if preferenceToRetry == nil { error = nil }
                loading = nil; tick()
            } catch {
                guard !stopped, !Task.isCancelled else { return }
                enabled = false; loaded = false; loading = nil
                self.error = nativeUI("无法读取本机提醒设置，未启动提醒；原文件保留。", "Local reminder settings could not be read. Reminders remain off; the original file is retained.")
            }
        }
    }
    func accept(tasks next: [NativeQuickTaskItem]?, disabledTaskIDs disabled: Set<String> = []) {
        guard !stopped else { return }
        guard let next else {
            available = false; accessGeneration &+= 1; preferenceGate?.revoke(); preferenceGate = nil
            cancelProcessing(); tasks = []; disabledTaskIDs = []; queueBlocked = false; retryAfter = nil
            withdrawAll(); return
        }
        let resuming = !available
        available = true
        // Keep one in-flight receipt transaction across ordinary snapshot
        // updates. Its exact candidate is revalidated after the write; an
        // unrelated task edit must not consume another task's reminder.
        tasks = next; disabledTaskIDs = disabled
        // A user preference may have committed immediately before access was
        // revoked. Re-read its ACK state rather than reviving optimistic UI.
        if resuming, loading == nil { loadState() }
        tick()
    }
    func setEnabled(_ value: Bool) async {
        guard !stopped, loaded, available, !savingPreference else { return }
        savingPreference = true; defer { savingPreference = false; tick() }
        loading?.cancel(); loading = nil
        cancelProcessing()
        if !value { enabled = false; withdrawAll() }
        let generation = accessGeneration, gate = NativeQuickTaskReminderGate(); preferenceGate = gate
        defer { if preferenceGate === gate { preferenceGate = nil } }
        do {
            let state = try await archive.setEnabled(value, gate: gate)
            guard !stopped, available, generation == accessGeneration else { return }
            enabled = state.enabled; seen = Set(state.receipts.map(\.fingerprint)); error = nil; retryAfter = nil; preferenceToRetry = nil
        } catch {
            guard !stopped, available, generation == accessGeneration else { return }
            preferenceToRetry = value
            // A failed OFF never silently turns delivery back on this session.
            self.error = value
                ? nativeUI("启用未保存，提醒仍关闭。请重试。", "Enabling was not saved. Reminders remain off. Try again.")
                : nativeUI("关闭未保存；本次运行已停止提醒，重启后可能恢复。请重试关闭。", "Turning reminders off was not saved. Delivery is stopped this session but may resume after restart. Try turning it off again.")
        }
    }
    func retry() {
        guard !stopped, available, !savingPreference else { return }
        if let preferenceToRetry {
            Task { @MainActor [weak self] in await self?.setEnabled(preferenceToRetry) }; return
        }
        retryAfter = nil
        if !loaded { loadState() } else { tick() }
    }
    func shutdown() {
        stopped = true; acceptUnavailable()
        loading?.cancel(); loading = nil
        for (center, observer) in observers { center.removeObserver(observer) }; observers = []
    }
    private func acceptUnavailable() {
        available = false; accessGeneration &+= 1; preferenceGate?.revoke(); preferenceGate = nil
        cancelProcessing(); tasks = []; disabledTaskIDs = []; withdrawAll()
    }
    private func cancelProcessing() {
        taskGeneration &+= 1; processingGate?.revoke(); processingGate = nil
        processing?.cancel(); processing = nil; processingID = nil; timer?.cancel(); timer = nil
    }
    private func withdrawAll() {
        let prefix = "task-reminder:"
        sources.queue.removeEvents { $0.ownerID == ownerID && $0.id.hasPrefix(prefix) && $0.source == .task }
        presented = [:]; onEventsInvalidated?()
    }
    private func candidates(at instant: Date) -> [Candidate] {
        guard loaded, enabled, available, !stopped, sources.available, sources.queue.ownerID == ownerID else { return [] }
        let grouped = Dictionary(grouping: tasks, by: \.id)
        return tasks.compactMap { task in
            guard !task.id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  grouped[task.id]?.count == 1, !task.isCompleted, task.isSaving != true, !disabledTaskIDs.contains(task.id),
                  let deadline = NativeQuickTaskDeadline.presentation(for: task, now: instant, calendar: calendar()), deadline.cutoff > instant else { return nil }
            let identity: String
            if case .text(let day) = task.dueAt, deadline.isAllDay { identity = "day:" + day }
            else { identity = "instant:\(Int64((deadline.cutoff.timeIntervalSince1970 * 1000).rounded()))" }
            // Logical date-only identity is independent of travel/time-zone
            // changes, while the live cutoff is recalculated in the new zone.
            let bytes = try! JSONEncoder().encode([ownerID, task.id, identity])
            let fingerprint = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            let token = NativeQuickTaskReminderNavigationToken(taskID: task.id, fingerprint: fingerprint, cutoff: deadline.cutoff, version: task.version)
            guard let event = NativeQuickNotificationEvent(id: "task-reminder:" + fingerprint, ownerID: ownerID, source: .task,
                title: task.title, detail: deadline.isAllDay ? nativeUI("今天结束前截止 · 查看待办", "Due by the end of today · View task") : nativeUI("将在 1 小时内截止 · 查看待办", "Due within 1 hour · View task"),
                occurredAt: instant, outcome: .information, destination: .task(task.id)) else { return nil }
            return Candidate(token: token, event: event)
        }.sorted { $0.token.cutoff == $1.token.cutoff ? $0.token.taskID < $1.token.taskID : $0.token.cutoff < $1.token.cutoff }
    }
    /// Re-evaluate absolute deadlines after wake/clock changes. One timer for
    /// the nearest boundary replaces per-task polling and is capped at 60s so
    /// expiry remains prompt even if a platform clock notification is missed.
    func tick() {
        timer?.cancel(); timer = nil
        let instant = now(), current = candidates(at: instant)
        let byID = Dictionary(uniqueKeysWithValues: current.map { ($0.event.id, $0) })
        var invalidated = false
        sources.queue.removeEvents { event in
            guard event.ownerID == ownerID, event.source == .task, event.id.hasPrefix("task-reminder:") else { return false }
            let valid = byID[event.id].map { $0.trigger <= instant && $0.event.title == event.title && presented[event.id] == $0.token } ?? false
            if !valid { invalidated = true }; return !valid
        }
        presented = presented.filter { byID[$0.key]?.token == $0.value }
        if invalidated { onEventsInvalidated?() }
        let hasDue = current.contains { $0.trigger <= instant && !seen.contains($0.token.fingerprint) }
        if loaded, available, rejectedReceipts.isEmpty, !hasDue {
            queueBlocked = false
            if preferenceToRetry == nil { error = nil; retryAfter = nil }
        }
        guard loaded, enabled, available, !stopped, !savingPreference, sources.available else { return }
        if processing == nil, retryAfter.map({ $0 <= instant }) ?? true,
           (!rejectedReceipts.isEmpty || hasDue) {
            let id = UUID(), generation = taskGeneration, gate = NativeQuickTaskReminderGate()
            processingID = id; processingGate = gate
            processing = Task { @MainActor [weak self] in
                guard let self else { return }
                await deliver(generation: generation, gate: gate)
                guard processingID == id else { return }
                processing = nil; processingID = nil; processingGate = nil; tick()
            }
        }
        scheduleNext()
    }
    private func deliver(generation: UInt64, gate: NativeQuickTaskReminderGate) async {
        do {
            for receipt in rejectedReceipts { try await releaseUnaccepted(receipt, generation: generation, gate: gate) }
        } catch {
            guard generation == taskGeneration, !Task.isCancelled, available else { return }
            deliveryFailed(); return
        }
        for candidate in candidates(at: now()) where candidate.trigger <= now() && !seen.contains(candidate.token.fingerprint) {
            guard generation == taskGeneration, !Task.isCancelled, enabled, available else { return }
            if sources.queue.pendingEventCount + (sources.queue.current?.events.count ?? 0) >= NativeQuickNotificationQueue.retainedEventLimit {
                queueBlocked = true; retryAfter = now().addingTimeInterval(15); return
            }
            let receipt = NativeQuickTaskReminderReceipt(fingerprint: candidate.token.fingerprint, cutoff: candidate.token.cutoff, claimedAt: now())
            do {
                let claimed = try await archive.claim(receipt, gate: gate)
                guard generation == taskGeneration, !Task.isCancelled, enabled, available else { return }
                seen = Set(claimed.state.receipts.map(\.fingerprint))
                guard claimed.inserted else { continue }
                guard let current = candidates(at: now()).first(where: { $0.token == candidate.token }), current.trigger <= now() else {
                    try await releaseUnaccepted(receipt, generation: generation, gate: gate); continue
                }
                // Queue publications can synchronously run validation. Install
                // the token first so the accepted event is never briefly stale.
                presented[current.event.id] = current.token
                switch sources.acceptTaskReminder(current.event) {
                case .accepted?, .duplicate?:
                    queueBlocked = false; error = nil; retryAfter = nil
                case .full?:
                    presented.removeValue(forKey: current.event.id)
                    queueBlocked = true
                    try await releaseUnaccepted(receipt, generation: generation, gate: gate)
                    retryAfter = now().addingTimeInterval(15); return
                case .wrongOwner?, nil: presented.removeValue(forKey: current.event.id); return
                }
            } catch {
                guard generation == taskGeneration, !Task.isCancelled, available else { return }
                deliveryFailed(); return
            }
        }
        if generation == taskGeneration, !Task.isCancelled, available {
            queueBlocked = false; retryAfter = nil
            if preferenceToRetry == nil { error = nil }
        }
    }
    private func releaseUnaccepted(_ receipt: NativeQuickTaskReminderReceipt, generation: UInt64, gate: NativeQuickTaskReminderGate) async throws {
        if !rejectedReceipts.contains(receipt) { rejectedReceipts.append(receipt) }
        let released = try await archive.release(receipt, gate: gate)
        guard generation == taskGeneration, !Task.isCancelled, available else { throw CancellationError() }
        rejectedReceipts.removeAll { $0 == receipt }; seen = Set(released.receipts.map(\.fingerprint))
    }
    private func deliveryFailed() {
        error = nativeUI("本机提醒记录未能保存，尚未发出本次提醒。请重试。", "The local reminder receipt could not be saved. This reminder was not sent. Retry when ready.")
        retryAfter = now().addingTimeInterval(30)
    }
    private func scheduleNext() {
        timer?.cancel(); timer = nil
        guard schedulesTimers, loaded, enabled, available, !stopped, !savingPreference, sources.available else { return }
        let instant = now(), current = candidates(at: instant)
        guard !current.isEmpty || !rejectedReceipts.isEmpty else { return }
        let future = current.map { $0.trigger > instant ? $0.trigger : $0.token.cutoff }.min()
        var delay = min(60, max(0.05, future?.timeIntervalSince(instant) ?? 60))
        if let retryAfter, retryAfter > instant { delay = min(delay, retryAfter.timeIntervalSince(instant)) }
        timer = Task { @MainActor [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) } catch { return }
            self?.tick()
        }
    }
    func navigationToken(taskID: String) -> NativeQuickTaskReminderNavigationToken? {
        let instant = now()
        guard let candidate = candidates(at: instant).first(where: { $0.token.taskID == taskID && $0.trigger <= instant }),
              presented[candidate.event.id] == candidate.token,
              !sources.queue.events(for: [candidate.event.id]).isEmpty else { return nil }
        return candidate.token
    }
    func canOpen(_ token: NativeQuickTaskReminderNavigationToken) -> Bool { navigationToken(taskID: token.taskID) == token }
}
