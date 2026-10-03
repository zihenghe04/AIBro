import Foundation

/// Consumes the existing access-filtered, normalized workbench projection.
/// Never inspects transcript bodies or interprets display labels as receipts.
@MainActor final class NativeQuickNotificationSources {
    struct Run: Equatable {
        let id: String
        let title: String
        let status: String?
        let finishedAt: Double? // JavaScript epoch milliseconds.
        let notificationReady: Bool
        var fingerprint: String { "\(status ?? "unknown"):\(finishedAt ?? 0):\(notificationReady)" }
    }
    let queue: NativeQuickNotificationQueue
    private let now: () -> Date
    private var baseline: Date?
    private var observed: [String: Run] = [:]
    private(set) var available = false
    private(set) var rejectedEventCount = 0
    var onQueueFull: (@MainActor () -> Void)?

    init(queue: NativeQuickNotificationQueue, now: @escaping () -> Date = Date.init) {
        self.queue = queue; self.now = now
    }

    /// nil means unavailable/private, not an empty workspace. Drop copied
    /// titles and establish a new baseline when access resumes.
    func accept(_ runs: [Run]?) {
        guard let runs else {
            if available || baseline != nil || !queue.history.isEmpty {
                queue.reset(ownerID: queue.ownerID)
            }
            available = false; baseline = nil; observed = [:]; return
        }
        available = true
        var current: [String: Run] = [:]
        let counts = Dictionary(grouping: runs, by: \.id)
        for (id, values) in counts where !id.isEmpty && values.count == 1 { current[id] = values[0] }
        queue.removeEvents { event in
            if case .run(let id) = event.destination { return current[id] == nil }
            return false
        }
        guard let baseline else { self.baseline = now(); observed = current; return }
        for run in runs where current[run.id] != nil {
            guard run.notificationReady, let end = run.finishedAt, end.isFinite, end > 0,
                  let status = run.status, let outcome = Self.outcome(status) else { continue }
            if let prior = observed[run.id] {
                guard prior.fingerprint != run.fingerprint else { continue }
                if end < baseline.timeIntervalSince1970 * 1000, Self.outcome(prior.status ?? "") != nil { continue }
            } else {
                // Imported/older history arriving after hydration is not a new
                // completion. A run first observed after this session can be.
                guard end >= baseline.timeIntervalSince1970 * 1000 else { continue }
            }
            guard let event = NativeQuickNotificationEvent(
                id: "run:\(run.id):\(end):\(status)", ownerID: queue.ownerID, source: .agent,
                title: run.title, detail: Self.detail(outcome), occurredAt: Date(timeIntervalSince1970: end / 1000),
                outcome: outcome, destination: .run(run.id)) else { continue }
            if queue.enqueue(event) == .full { rejectedEventCount += 1; onQueueFull?() }
        }
        observed = current
    }

    @discardableResult func acceptPomodoro(runID: String, phase: String, duration: TimeInterval,
                                          completedAt: Date, ownerID: String) -> Bool {
        guard available, ownerID == queue.ownerID, ["focus", "rest"].contains(phase),
              duration.isFinite, duration > 0,
              let event = NativeQuickNotificationEvent(id: "pomodoro:\(runID)", ownerID: ownerID, source: .pomodoro,
                title: phase == "focus" ? nativeUI("专注完成，休息一下", "Focus complete. Take a break.") : nativeUI("休息结束，准备继续", "Break complete. Ready to continue."),
                detail: nativeUI("查看计时器", "Open the timer"), occurredAt: completedAt, outcome: .completed,
                destination: .pomodoro(runID)) else { return false }
        switch queue.enqueue(event) {
        case .accepted, .duplicate: return true
        case .wrongOwner: return false
        case .full: rejectedEventCount += 1; return false // Caller retains its attention fallback.
        }
    }

    /// The reminder scheduler owns deadline validation and its durable one-shot
    /// receipt. This adapter keeps the shared access/owner boundary authoritative.
    func acceptTaskReminder(_ event: NativeQuickNotificationEvent) -> NativeQuickNotificationQueue.EnqueueResult? {
        guard available, event.ownerID == queue.ownerID, event.source == .task,
              event.outcome == .information, case .task = event.destination else { return nil }
        let result = queue.enqueue(event)
        if result == .full { rejectedEventCount += 1 }
        return result
    }

    /// Only the local paste-back controller supplies this status. The UUID
    /// identifies a feedback receipt, never clipboard contents or a saved item.
    /// It lives in the existing in-memory queue and is revoked by accept(nil).
    @discardableResult func acceptClipboardFeedback(id: UUID, message: String, ownerID: String) -> Bool {
        guard available, ownerID == queue.ownerID,
              !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let event = NativeQuickNotificationEvent(id: "clipboard:\(id.uuidString)", ownerID: ownerID,
                source: .clipboard, title: nativeUI("粘回原应用", "Paste back"), detail: message,
                occurredAt: now(), outcome: .information, destination: .clipboard(id)) else { return false }
        switch queue.enqueue(event) {
        case .accepted, .duplicate: return true
        case .wrongOwner: return false
        case .full: rejectedEventCount += 1; return false
        }
    }

    /// A retained receipt authorizes opening only the clipboard page. No item
    /// is selected, read, copied or pasted by following this notification.
    func hasClipboardFeedback(id: UUID, ownerID: String) -> Bool {
        guard available, ownerID == queue.ownerID else { return false }
        return queue.events(for: ["clipboard:\(id.uuidString)"]).contains {
            $0.ownerID == ownerID && $0.source == .clipboard && $0.outcome == .information && $0.destination == .clipboard(id)
        }
    }

    private static func outcome(_ status: String) -> NativeQuickNotificationEvent.Outcome? {
        switch status {
        case "completed", "completed-local", "completed-local-fallback": return .completed
        case "failed": return .failed
        case "cancelled": return .stopped
        case "interrupted": return .interrupted
        case "rejected": return .rejected
        default: return nil
        }
    }
    private static func detail(_ outcome: NativeQuickNotificationEvent.Outcome) -> String {
        switch outcome {
        case .completed: return nativeUI("执行已完成 · 查看结果", "Run completed · View results")
        case .failed: return nativeUI("执行未完成 · 查看原因", "Run failed · View details")
        case .stopped: return nativeUI("执行已停止", "Run stopped")
        case .interrupted: return nativeUI("执行已中断 · 查看详情", "Run interrupted · View details")
        case .rejected: return nativeUI("执行已拒绝", "Run rejected")
        case .information: return nativeUI("查看更新", "View update")
        }
    }
}
