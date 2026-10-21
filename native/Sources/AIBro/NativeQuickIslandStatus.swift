import Foundation
import CoreGraphics

/// The collapsed island shows one state at a time. Priority follows what the
/// user must act on first: a live voice command, then a run waiting for the
/// user, live work, unseen outcomes (failure before success), then ambient
/// activity. Outcomes clear on read; history from before this session is
/// never presented as new.
struct NativeQuickIslandStatus: Equatable {
    enum Kind: String, Equatable { case voice, awaiting, running, failed, completed, recording, music, unread, idle, preparing }
    enum Tint: Equatable { case neutral, accent, amber, red }
    var kind: Kind
    var symbol: String
    /// Short state word, the primary label on a display without a notch.
    var title: String
    /// Secondary context such as the run or track title.
    var detail: String? = nil
    /// Right-hand value on a wide island: a count or timer only, never a
    /// word that repeats the title.
    var trailing: String? = nil
    /// Value for the narrow shoulder right of a hardware notch (about 28pt):
    /// a count, a compact timer, or nil for a tinted dot.
    var shoulder: String? = nil
    /// One action word shown on the right shoulder only while peeking.
    var actionWord: String? = nil
    var tint: Tint = .neutral
    /// Live work. The view shimmers or pulses only while this is true.
    var busy = false
    var runID: String? = nil

    var attention: Bool { kind == .awaiting || kind == .failed }
    var accessibilityValue: String {
        [title, detail].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: nativeUI("，", ", "))
    }
}

struct NativeQuickIslandInputs: Equatable {
    struct Voice: Equatable { var title: String; var symbol: String; var isProcessing: Bool }
    struct Run: Equatable {
        var id: String
        var title: String
        var status: String
        var finishedAt: Double? = nil // JavaScript epoch milliseconds.
        /// The projection confirmed the outcome's final message; mirrors toasts.
        var notificationReady = false
    }
    enum Recording: Equatable { case recording(TimeInterval), paused(TimeInterval), saving }
    struct Music: Equatable { var title: String; var artist: String? = nil }
    var voice: Voice? = nil
    var runs: [Run] = []
    /// Outcome keys the user has already read (see `outcomeKey`).
    var seen: Set<String> = []
    /// Outcomes that finished before this instant (epoch ms) are history.
    var since: Double = 0
    var busy = false
    var recording: Recording? = nil
    var music: Music? = nil
    var unread = 0
    var ready = true
}

extension NativeQuickIslandStatus {
    static let awaitingStatuses: Set<String> = ["awaiting-approval", "awaiting-input", "awaiting-save"]
    static let completedStatuses: Set<String> = ["completed", "completed-local", "completed-local-fallback"]
    /// A user-requested stop is not news, so `cancelled` never alerts.
    static let failedStatuses: Set<String> = ["failed", "interrupted", "rejected"]

    /// A new outcome for the same run (retry, a later failure) alerts again.
    static func outcomeKey(_ run: NativeQuickIslandInputs.Run) -> String {
        "\(run.id):\(run.status):\(Int64((run.finishedAt ?? 0).rounded()))"
    }

    static func unseenOutcomes(_ input: NativeQuickIslandInputs) -> [NativeQuickIslandInputs.Run] {
        input.runs.filter { run in
            guard completedStatuses.contains(run.status) || failedStatuses.contains(run.status),
                  run.notificationReady, let end = run.finishedAt, end.isFinite, end >= input.since else { return false }
            return !input.seen.contains(outcomeKey(run))
        }
    }

    static func derive(_ input: NativeQuickIslandInputs) -> Self {
        if let voice = input.voice {
            return .init(kind: .voice, symbol: voice.symbol, title: clipped(voice.title, 18),
                         tint: .accent, busy: voice.isProcessing)
        }
        let awaiting = input.runs.filter { awaitingStatuses.contains($0.status) }
        if let run = awaiting.first {
            let (title, word, symbol): (String, String, String)
            switch run.status {
            case "awaiting-input": (title, word, symbol) = (nativeUI("等待回复", "Reply needed"), nativeUI("回复", "Reply"), "questionmark.bubble.fill")
            case "awaiting-save": (title, word, symbol) = (nativeUI("等待保存", "Save needed"), nativeUI("保存", "Save"), "square.and.arrow.down.fill")
            default: (title, word, symbol) = (nativeUI("等待审批", "Needs review"), nativeUI("审批", "Review"), "hand.raised.fill")
            }
            return .init(kind: .awaiting, symbol: symbol, title: title, detail: runDetail(run, more: awaiting.count - 1),
                         trailing: awaiting.count > 1 ? "\(min(awaiting.count, 99))" : nil,
                         shoulder: awaiting.count > 1 ? "\(min(awaiting.count, 99))" : nil, actionWord: word, tint: .amber, runID: run.id)
        }
        let running = input.runs.filter { $0.status == "running" }
        if let run = running.first {
            return .init(kind: .running, symbol: "sparkles", title: nativeUI("执行中", "Working"),
                         detail: runDetail(run, more: running.count - 1),
                         trailing: running.count > 1 ? "\(min(running.count, 99))" : nil,
                         shoulder: running.count > 1 ? "\(min(running.count, 99))" : nil, tint: .accent, busy: true, runID: run.id)
        }
        if input.busy {
            return .init(kind: .running, symbol: "sparkles", title: nativeUI("执行中", "Working"), tint: .accent, busy: true)
        }
        let outcomes = unseenOutcomes(input).sorted { ($0.finishedAt ?? 0) > ($1.finishedAt ?? 0) }
        let failed = outcomes.filter { failedStatuses.contains($0.status) }
        if let run = failed.first {
            let title = run.status == "interrupted" ? nativeUI("已中断", "Interrupted")
                : run.status == "rejected" ? nativeUI("已拒绝", "Rejected") : nativeUI("未完成", "Run failed")
            return .init(kind: .failed, symbol: "exclamationmark.triangle.fill", title: title,
                         detail: runDetail(run, more: failed.count - 1),
                         trailing: failed.count > 1 ? "\(min(failed.count, 99))" : nil,
                         shoulder: failed.count > 1 ? "\(min(failed.count, 99))" : nil, actionWord: nativeUI("查看", "View"), tint: .red, runID: run.id)
        }
        if let run = outcomes.first {
            return .init(kind: .completed, symbol: "checkmark.circle.fill", title: nativeUI("已完成", "Done"),
                         detail: runDetail(run, more: outcomes.count - 1),
                         trailing: outcomes.count > 1 ? "\(min(outcomes.count, 99))" : nil,
                         shoulder: outcomes.count > 1 ? "\(min(outcomes.count, 99))" : nil, tint: .accent, runID: run.id)
        }
        switch input.recording {
        case .recording(let elapsed):
            return .init(kind: .recording, symbol: "record.circle", title: nativeUI("录音中", "Recording"),
                         trailing: clock(elapsed), shoulder: compactClock(elapsed), tint: .red, busy: true)
        case .paused(let elapsed):
            return .init(kind: .recording, symbol: "pause.circle", title: nativeUI("录音已暂停", "Paused"),
                         trailing: clock(elapsed), shoulder: compactClock(elapsed), tint: .amber)
        case .saving:
            return .init(kind: .recording, symbol: "waveform", title: nativeUI("正在保存录音", "Saving"), tint: .neutral, busy: true)
        case nil: break
        }
        if let music = input.music, !music.title.isEmpty {
            return .init(kind: .music, symbol: "music.note", title: clipped(music.title, 16),
                         detail: music.artist.flatMap { $0.isEmpty ? nil : clipped($0, 14) }, tint: .neutral)
        }
        if input.unread > 0 {
            let count = min(input.unread, 99)
            return .init(kind: .unread, symbol: "bell.badge", title: nativeUI("\(input.unread) 项新变化", "\(input.unread) new"),
                         trailing: "\(count)\(input.unread > 99 ? "+" : "")", shoulder: "\(count)\(input.unread > 99 ? "+" : "")", tint: .accent)
        }
        guard input.ready else {
            return .init(kind: .preparing, symbol: "hourglass", title: nativeUI("正在准备", "Preparing"))
        }
        return .init(kind: .idle, symbol: "square.stack.3d.up", title: "AI Bro")
    }

    private static func runDetail(_ run: NativeQuickIslandInputs.Run, more: Int) -> String? {
        let title = run.title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return nil }
        return more > 0 ? clipped(title, 12) + " +\(more)" : clipped(title, 14)
    }

    static func clipped(_ value: String, _ limit: Int) -> String {
        let single = value.split(whereSeparator: \.isNewline).joined(separator: " ").trimmingCharacters(in: .whitespaces)
        guard single.count > limit else { return single }
        return String(single.prefix(max(1, limit - 1))).trimmingCharacters(in: .whitespaces) + "…"
    }

    static func clock(_ seconds: TimeInterval) -> String {
        let total = seconds.isFinite ? max(0, Int(seconds)) : 0
        let hours = total / 3600, minutes = total / 60 % 60, rest = total % 60
        return hours > 0 ? String(format: "%d:%02d:%02d", hours, minutes, rest) : String(format: "%d:%02d", minutes, rest)
    }

    /// Minutes keep counting past an hour ("62:05") so the shoulder stays
    /// five characters at most until 999 minutes.
    static func compactClock(_ seconds: TimeInterval) -> String {
        let total = seconds.isFinite ? max(0, Int(seconds)) : 0
        return String(format: "%d:%02d", min(999, total / 60), total % 60)
    }

    /// States that need the user may briefly widen the island so their label
    /// and context fit; every other state renders inside the base footprint.
    var peeks: Bool { attention }

    /// Temporary width while a state peeks. Never below `base` (the existing
    /// collapsed footprint) and only modestly above it. With a notch both
    /// shoulders grow symmetrically so the island stays centred on the camera.
    func peekWidth(notchGap: CGFloat, base: CGFloat, measure: (String) -> CGFloat) -> CGFloat {
        guard peeks else { return base }
        let trailingWidth = (trailing ?? actionWord).map { measure($0) } ?? 6
        let target: CGFloat
        if notchGap > 0 {
            let value = (actionWord ?? shoulder).map { measure($0) } ?? 6
            target = notchGap + 2 * min(60, 10 + value + 10)
            return min(base + 56, max(base, target.rounded(.up)))
        }
        var width: CGFloat = 12 + 14 + 7 + measure(title) + 7 + trailingWidth + 12
        if let detail { width += 6 + measure(detail) }
        return min(base + 88, max(base, width.rounded(.up)))
    }

}
