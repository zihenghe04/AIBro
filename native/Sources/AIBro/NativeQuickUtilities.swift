import Foundation
import Combine
import SwiftUI
import AppKit
import Darwin

// Native adaptation of TO-DO Panel's pomodoro and text-command modules.
// Source mapping and MIT notice: docs/THIRD_PARTY.md. No shell is executed.
enum NativeQuickPomodoroPhase: String, Codable { case focus, rest
    var other: Self { self == .focus ? .rest:.focus }
    var title: String { self == .focus ? nativeUI("专注", "Focus"):nativeUI("休息", "Rest") }
}
enum NativeQuickPomodoroStatus: String, Codable { case idle, running, paused, completed }
struct NativeQuickPomodoroCompletion {
    let runID: String
    let phase: NativeQuickPomodoroPhase
    let duration: TimeInterval
    let completedAt: Date
    let directory: URL
}
struct NativeQuickCommandItem: Identifiable, Codable, Equatable {
    let id: String
    var text: String
    let createdAt: Date
    var updatedAt: Date
}

@MainActor final class NativeQuickUtilitiesStore: ObservableObject {
    private struct ClockState: Codable, Equatable {
        var phase: NativeQuickPomodoroPhase = .focus
        var status: NativeQuickPomodoroStatus = .idle
        var duration: Double = 1500
        var remaining: Double = 1500
        var deadline: Date?
        var runID: String?
        var completionDismissed = false
    }
    private struct Envelope: Codable, Equatable {
        var version = 1
        var focusSeconds = 1500
        var restSeconds = 300
        var clock = ClockState()
        var commands: [NativeQuickCommandItem] = []
    }
    private struct CommandDraft: Codable, Equatable {
        let id: String
        let existing: Bool
        let original: String
        var text: String
    }
    private struct DraftEnvelope: Codable { var version = 1; var editor: CommandDraft? }

    @Published private(set) var ready = false
    @Published private(set) var error: String?
    @Published private(set) var remainingSeconds = 1500
    @Published private(set) var phase: NativeQuickPomodoroPhase = .focus
    @Published private(set) var status: NativeQuickPomodoroStatus = .idle
    @Published private(set) var deadline: Date?
    @Published private(set) var focusSeconds = 1500
    @Published private(set) var restSeconds = 300
    @Published private(set) var completion: String?
    @Published private(set) var commands: [NativeQuickCommandItem] = []
    @Published private(set) var copiedCommandID: String?
    @Published private(set) var isEditingCommand = false
    @Published private(set) var editingCommandID: String?
    @Published private(set) var hasUnpersistedChanges = false
    @Published var commandDraft = "" {
        didSet {
            guard !applyingDraft, ready, commandDraft != oldValue else { return }
            if editor == nil { editor = CommandDraft(id: UUID().uuidString.lowercased(), existing: false, original: "", text: "") }
            editor?.text = commandDraft
            isEditingCommand = true
            _ = flushPendingDraft()
        }
    }

    /// Called only after durable completion. Return false to retain the existing
    /// system attention fallback; a notification is not a persistence receipt.
    var onCommittedCompletion: (@MainActor (NativeQuickPomodoroCompletion) -> Bool)?
    var currentPomodoroRunID: String? { value.clock.runID }
    private var value = Envelope()
    private var editor: CommandDraft?
    private var applyingDraft = false
    private var file: URL?
    private var draftFile: URL?
    private var visible = false
    private var displayTimer: Timer?
    private var completionTimer: Timer?
    private var wakeObserver: NSObjectProtocol?
    private var retryCompletionAfter: Date?
    private var notificationPending: NativeQuickPomodoroPhase?
    private var copyGeneration = UUID()
    private let now: () -> Date
    private let write: (Data, URL) throws -> Void
    private let copy: @MainActor (String) -> Bool
    private let notify: @MainActor (NativeQuickPomodoroPhase) -> Void
    private let schedulesTimers: Bool

    init(now: @escaping () -> Date = Date.init,
         write: @escaping (Data, URL) throws -> Void = NativeQuickUtilitiesStore.atomicWrite,
         copy: @escaping @MainActor (String) -> Bool = { text in
             NSPasteboard.general.clearContents()
             return NSPasteboard.general.setString(text, forType: .string)
         },
         notify: @escaping @MainActor (NativeQuickPomodoroPhase) -> Void = { _ in
             NSSound.beep()
             NSApp?.requestUserAttention(.informationalRequest)
         }, schedulesTimers: Bool = true) {
        self.now = now; self.write = write; self.copy = copy; self.notify = notify; self.schedulesTimers = schedulesTimers
        if schedulesTimers {
            wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.tick(); self?.schedule() }
            }
        }
    }
    deinit {
        displayTimer?.invalidate(); completionTimer?.invalidate()
        if let wakeObserver { NSWorkspace.shared.notificationCenter.removeObserver(wakeObserver) }
    }

    nonisolated static func atomicWrite(_ data: Data, _ url: URL) throws {
        let directory = url.deletingLastPathComponent()
        let staging = directory.appendingPathComponent(".quick-utilities-" + UUID().uuidString.lowercased())
        let descriptor = Darwin.open(staging.path, O_WRONLY | O_CREAT | O_EXCL, 0o600)
        guard descriptor >= 0 else { throw CocoaError(.fileWriteUnknown) }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close(); try? FileManager.default.removeItem(at: staging) }
        try handle.write(contentsOf: data); try handle.synchronize(); try handle.close()
        guard Darwin.rename(staging.path, url.path) == 0 else { throw CocoaError(.fileWriteUnknown) }
        let parent = Darwin.open(directory.path, O_RDONLY)
        guard parent >= 0 else { throw CocoaError(.fileWriteUnknown) }
        defer { Darwin.close(parent) }
        guard Darwin.fsync(parent) == 0 else { throw CocoaError(.fileWriteUnknown) }
    }

    func configure(directory: URL) {
        let destination = directory.appendingPathComponent("native-quick-utilities.json")
        guard file == nil || file == destination else {
            error = nativeUI("请返回工具所属的工作区。", "Return to this utility's workspace."); return
        }
        guard file == nil else { return }
        file = destination; draftFile = directory.appendingPathComponent("native-quick-command-draft.json")
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            if FileManager.default.fileExists(atPath: destination.path) {
                value = try JSONDecoder().decode(Envelope.self, from: Data(contentsOf: destination))
                guard valid(value) else { throw CocoaError(.fileReadCorruptFile) }
            }
            if let draftFile, FileManager.default.fileExists(atPath: draftFile.path) {
                let saved = try JSONDecoder().decode(DraftEnvelope.self, from: Data(contentsOf: draftFile))
                guard saved.version == 1, saved.editor.map({ UUID(uuidString: $0.id) != nil }) ?? true else { throw CocoaError(.fileReadCorruptFile) }
                editor = saved.editor
            }
            ready = true; publish(); publishEditor(); tick(); schedule()
        } catch {
            ready = false
            self.error = nativeUI("工具资料暂时无法读取，原文件已保留。请在文件夹中检查后重新打开应用。", "Utility data could not be read. Original files are retained; check the folder before reopening the app.")
        }
    }
    func revealStorage() { if let file { NSWorkspace.shared.activateFileViewerSelecting([file]) } }

    private func valid(_ candidate: Envelope) -> Bool {
        let clock = candidate.clock
        guard candidate.version == 1, (1...86400).contains(candidate.focusSeconds), (1...86400).contains(candidate.restSeconds),
              clock.duration.isFinite, (1...86400).contains(clock.duration), clock.remaining.isFinite,
              clock.remaining >= 0, clock.remaining <= clock.duration,
              Set(candidate.commands.map(\.id)).count == candidate.commands.count,
              candidate.commands.allSatisfy({ UUID(uuidString: $0.id) != nil && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.createdAt.timeIntervalSince1970.isFinite && $0.updatedAt.timeIntervalSince1970.isFinite }) else { return false }
        if clock.status != .idle, clock.runID.flatMap(UUID.init(uuidString:)) == nil { return false }
        if clock.status == .running { return clock.deadline?.timeIntervalSince1970.isFinite == true }
        if clock.deadline != nil { return false }
        return clock.status != .completed || clock.remaining == 0
    }
    private func publish() {
        phase = value.clock.phase; status = value.clock.status; deadline = value.clock.deadline
        focusSeconds = value.focusSeconds; restSeconds = value.restSeconds; commands = value.commands
        remainingSeconds = remaining(at: now())
        completion = status == .completed && !value.clock.completionDismissed ? nativeUI("\(phase.title)已完成", "\(phase.title) complete"):nil
    }
    private func publishEditor() {
        applyingDraft = true; commandDraft = editor?.text ?? ""; applyingDraft = false
        isEditingCommand = editor != nil; editingCommandID = editor?.existing == true ? editor?.id:nil
    }
    private func remaining(at date: Date) -> Int {
        let seconds = value.clock.status == .running ? (value.clock.deadline?.timeIntervalSince(date) ?? value.clock.remaining):value.clock.remaining
        return Int(ceil(max(0, min(value.clock.duration, seconds))))
    }
    var progress: Double { 1 - Double(remainingSeconds) / max(1, value.clock.duration) }
    var timeLabel: String { String(format: "%02d:%02d", remainingSeconds / 60, remainingSeconds % 60) }

    @discardableResult private func commit(_ candidate: Envelope) -> Bool {
        guard ready, let file else { return false }
        do {
            try write(JSONEncoder().encode(candidate), file)
            value = candidate; error = nil; publish(); schedule(); return true
        } catch {
            // A writer can fail after rename. Reflect only the exact bytes now
            // present; retain the operation's retry input instead of duplicating it.
            if let saved = try? JSONDecoder().decode(Envelope.self, from: Data(contentsOf: file)), saved == candidate {
                value = saved; publish(); schedule()
            }
            self.error = nativeUI("更改尚未确认保存，输入已保留。请重试。", "The change is not confirmed saved. Your input is retained; retry.")
            return false
        }
    }
    func setVisible(_ visible: Bool) {
        guard self.visible != visible else { return }
        self.visible = visible; tick(); schedule()
    }
    private func schedule() {
        guard schedulesTimers else { return }
        displayTimer?.invalidate(); displayTimer = nil
        completionTimer?.invalidate(); completionTimer = nil
        guard ready else { return }
        if value.clock.status == .completed, notificationPending != nil {
            let timer = Timer(timeInterval: max(0.1, (retryCompletionAfter ?? now().addingTimeInterval(5)).timeIntervalSince(now())), repeats: false) { [weak self] _ in
                Task { @MainActor in self?.tick(); self?.schedule() }
            }
            completionTimer = timer; RunLoop.main.add(timer, forMode: .common)
        }
        if value.clock.status == .running, let deadline = value.clock.deadline {
            let interval = max(0.05, max(deadline, retryCompletionAfter ?? deadline).timeIntervalSince(now()))
            let timer = Timer(timeInterval: interval, repeats: false) { [weak self] _ in Task { @MainActor in self?.tick(); self?.schedule() } }
            completionTimer = timer; RunLoop.main.add(timer, forMode: .common)
            if visible {
                let display = Timer(timeInterval: 1, repeats: true) { [weak self] _ in Task { @MainActor in self?.tick() } }
                displayTimer = display; RunLoop.main.add(display, forMode: .common)
            }
        }
    }
    func tick() {
        guard ready else { return }
        let date = now()
        if value.clock.status == .running, let deadline = value.clock.deadline, deadline <= date {
            if let retryCompletionAfter, date < retryCompletionAfter { return }
            var next = value; next.clock.status = .completed; next.clock.remaining = 0; next.clock.deadline = nil; next.clock.completionDismissed = false
            notificationPending = next.clock.phase
            if commit(next) {
                retryCompletionAfter = nil; notificationPending = nil; schedule(); notifyCommittedCompletion(next.clock.phase)
            } else { retryCompletionAfter = date.addingTimeInterval(5); schedule() }
        } else if value.clock.status == .completed, let pending = notificationPending {
            if let retryCompletionAfter, date < retryCompletionAfter { return }
            if commit(value) { notificationPending = nil; retryCompletionAfter = nil; schedule(); notifyCommittedCompletion(pending) }
            else { retryCompletionAfter = date.addingTimeInterval(5); schedule() }
        } else if visible {
            let seconds = remaining(at: date)
            if remainingSeconds != seconds { remainingSeconds = seconds }
        }
    }
    private func notifyCommittedCompletion(_ phase: NativeQuickPomodoroPhase) {
        if let runID = value.clock.runID, let file,
           onCommittedCompletion?(.init(runID: runID, phase: phase, duration: value.clock.duration,
               completedAt: now(), directory: file.deletingLastPathComponent())) == true { return }
        notify(phase)
    }
    @discardableResult func configurePomodoro(focusSeconds: Int, restSeconds: Int) -> Bool {
        guard (1...86400).contains(focusSeconds), (1...86400).contains(restSeconds) else {
            error = nativeUI("每段时长须为 1 秒至 24 小时。", "Each duration must be between 1 second and 24 hours."); return false
        }
        var next = value; next.focusSeconds = focusSeconds; next.restSeconds = restSeconds
        if next.clock.status == .idle { next.clock.duration = Double(next.clock.phase == .focus ? focusSeconds:restSeconds); next.clock.remaining = next.clock.duration }
        return commit(next)
    }
    @discardableResult func selectPomodoroPhase(_ phase: NativeQuickPomodoroPhase) -> Bool {
        guard value.clock.status == .idle || value.clock.status == .completed else { return false }
        var next = value; next.clock = ClockState(phase: phase, duration: Double(phase == .focus ? value.focusSeconds:value.restSeconds), remaining: Double(phase == .focus ? value.focusSeconds:value.restSeconds))
        notificationPending = nil; return commit(next)
    }
    @discardableResult func startPomodoro(phase requested: NativeQuickPomodoroPhase? = nil) -> Bool {
        guard ready else { return false }
        if value.clock.status == .paused, requested == nil || requested == value.clock.phase { return resumePomodoro() }
        guard value.clock.status == .idle || value.clock.status == .completed else { return false }
        let phase = requested ?? (value.clock.status == .completed ? value.clock.phase.other:value.clock.phase)
        let duration = Double(phase == .focus ? value.focusSeconds:value.restSeconds)
        var next = value; next.clock = ClockState(phase: phase, status: .running, duration: duration, remaining: duration, deadline: now().addingTimeInterval(duration), runID: UUID().uuidString.lowercased())
        notificationPending = nil; retryCompletionAfter = nil; return commit(next)
    }
    @discardableResult func pausePomodoro() -> Bool {
        guard value.clock.status == .running, let deadline = value.clock.deadline else { return false }
        if deadline <= now() { tick(); return false }
        var next = value; next.clock.remaining = min(next.clock.duration, max(0, deadline.timeIntervalSince(now()))); next.clock.status = .paused; next.clock.deadline = nil
        return commit(next)
    }
    @discardableResult func resumePomodoro() -> Bool {
        guard value.clock.status == .paused, value.clock.remaining > 0 else { return false }
        var next = value; next.clock.status = .running; next.clock.deadline = now().addingTimeInterval(next.clock.remaining)
        return commit(next)
    }
    @discardableResult func resetPomodoro() -> Bool {
        var next = value; let duration = Double(value.clock.phase == .focus ? value.focusSeconds:value.restSeconds)
        next.clock = ClockState(phase: value.clock.phase, duration: duration, remaining: duration)
        notificationPending = nil; retryCompletionAfter = nil; return commit(next)
    }
    @discardableResult func acknowledgeCompletion() -> Bool {
        guard value.clock.status == .completed else { return false }
        var next = value; next.clock.completionDismissed = true; return commit(next)
    }

    @discardableResult func flushPendingDraft() -> Bool {
        guard ready, let draftFile else { return false }
        do { try write(JSONEncoder().encode(DraftEnvelope(editor: editor)), draftFile); hasUnpersistedChanges = false; error = nil; return true }
        catch { hasUnpersistedChanges = true; self.error = nativeUI("提示词草稿尚未保存，请重试后再退出。", "The prompt draft is not saved. Retry before quitting."); return false }
    }
    @discardableResult func startEditingCommand(id: String? = nil) -> Bool {
        guard ready else { return false }
        if let id, editor?.id == id { return true }
        if let editor, editor.text != editor.original, editor.id != id {
            error = nativeUI("请先保存或取消当前提示词编辑。", "Save or cancel the current prompt before editing another."); return false
        }
        if let id {
            guard let item = commands.first(where: { $0.id == id }) else { return false }
            editor = CommandDraft(id: item.id, existing: true, original: item.text, text: item.text)
        } else { editor = CommandDraft(id: UUID().uuidString.lowercased(), existing: false, original: "", text: "") }
        publishEditor(); return flushPendingDraft()
    }
    @discardableResult func saveCommand() -> Bool {
        guard ready else { return false }
        let text = commandDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { error = nativeUI("请先输入提示词。", "Enter a prompt first."); return false }
        if editor == nil { editor = CommandDraft(id: UUID().uuidString.lowercased(), existing: false, original: "", text: commandDraft) }
        guard flushPendingDraft(), let editor else { return false }
        var next = value
        if let index = next.commands.firstIndex(where: { $0.id == editor.id }) {
            next.commands[index].text = text; next.commands[index].updatedAt = now()
        } else {
            guard !editor.existing else { error = nativeUI("该提示词已删除，草稿仍保留。", "This prompt was deleted. Your draft is retained."); return false }
            next.commands.insert(NativeQuickCommandItem(id: editor.id, text: text, createdAt: now(), updatedAt: now()), at: 0)
        }
        guard commit(next) else { return false }
        return cancelCommandEdit()
    }
    @discardableResult func cancelCommandEdit() -> Bool {
        let retained = editor; editor = nil
        guard flushPendingDraft() else { editor = retained; return false }
        publishEditor(); return true
    }
    @discardableResult func deleteCommands(ids: Set<String>) -> Bool {
        guard !ids.isEmpty, ids.isSubset(of: Set(commands.map(\.id))) else { return false }
        if let editor, ids.contains(editor.id), editor.text != editor.original {
            error = nativeUI("请先保存或取消这条提示词的编辑。", "Save or cancel this prompt's edit before deleting it."); return false
        }
        var next = value; next.commands.removeAll { ids.contains($0.id) }
        guard commit(next) else { return false }
        if let editor, ids.contains(editor.id) { return cancelCommandEdit() }
        return true
    }
    @discardableResult func copyCommand(id: String) -> Bool {
        guard ready, let command = commands.first(where: { $0.id == id }) else { return false }
        copiedCommandID = nil
        guard copy(command.text) else { error = nativeUI("复制失败，请重试。", "Copy failed. Retry."); return false }
        error = nil; copiedCommandID = id; let generation = UUID(); copyGeneration = generation
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in if self?.copyGeneration == generation { self?.copiedCommandID = nil } }
        return true
    }
}

/// Keep the exact edit, including empty/invalid text, separate from persisted
/// durations. A click on Save must not depend on AppKit ending field editing.
struct NativeQuickDurationDraft: Equatable {
    struct Field: Equatable {
        var text: String
        var isComposing = false
        func integer(maximum: Int) -> Int? {
            guard !isComposing, !text.isEmpty,
                  text.unicodeScalars.allSatisfy({ (48...57).contains($0.value) }),
                  let value = Int(text), (0...maximum).contains(value) else { return nil }
            return value
        }
    }
    struct Values: Equatable { let focus: Int; let rest: Int }
    enum Issue: Error, Equatable {
        case composition, minutes, seconds, range
        var message: String {
            switch self {
            case .composition: return nativeUI("请先完成输入，再保存时长。", "Finish composing the input before saving durations.")
            case .minutes: return nativeUI("分钟请输入 0–1440 的整数，不能留空。", "Enter whole minutes from 0 to 1440; do not leave them empty.")
            case .seconds: return nativeUI("秒请输入 0–59 的整数，不能留空。", "Enter whole seconds from 0 to 59; do not leave them empty.")
            case .range: return nativeUI("每段时长须为 1 秒至 24 小时。", "Each duration must be from 1 second to 24 hours.")
            }
        }
    }
    var focusMinutes = Field(text: "25")
    var focusSeconds = Field(text: "0")
    var restMinutes = Field(text: "5")
    var restSeconds = Field(text: "0")
    init(focus: Int = 1500, rest: Int = 300) {
        focusMinutes.text = String(focus / 60); focusSeconds.text = String(focus % 60)
        restMinutes.text = String(rest / 60); restSeconds.text = String(rest % 60)
    }
    func validated() -> Result<Values, Issue> {
        guard ![focusMinutes, focusSeconds, restMinutes, restSeconds].contains(where: \.isComposing) else { return .failure(.composition) }
        guard let fm = focusMinutes.integer(maximum: 1440), let rm = restMinutes.integer(maximum: 1440) else { return .failure(.minutes) }
        guard let fs = focusSeconds.integer(maximum: 59), let rs = restSeconds.integer(maximum: 59) else { return .failure(.seconds) }
        let values = Values(focus: fm * 60 + fs, rest: rm * 60 + rs)
        guard (1...86400).contains(values.focus), (1...86400).contains(values.rest) else { return .failure(.range) }
        return .success(values)
    }
}

struct NativeQuickPomodoroView: View {
    @ObservedObject var store: NativeQuickUtilitiesStore
    @Environment(\.nativeQuickWidgetContext) private var widget
    @State private var durationDraft = NativeQuickDurationDraft()
    @State private var durationIssue: NativeQuickDurationDraft.Issue?
    var body: some View {
        Group {
            if widget.isDetail { ScrollView { expandedContent } }
            else { compactContent }
        }
    }
    private var compactContent: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label(nativeUI("番茄钟", "Focus timer"), systemImage: "timer")
                Spacer(minLength: 4)
                Text(store.phase.title).foregroundStyle(.secondary)
            }.font(.system(size: 11, weight: .medium))
            HStack(spacing: 8) {
                Text(store.timeLabel).font(.system(size: widget.size == "mini" ? 26 : 34, weight: .medium, design: .rounded)).monospacedDigit()
                    .accessibilityLabel(nativeUI("剩余 \(store.remainingSeconds) 秒", "\(store.remainingSeconds) seconds remaining"))
                Spacer(minLength: 0)
                Button {
                    if store.status == .running { _ = store.pausePomodoro() }
                    else if store.status == .paused { _ = store.resumePomodoro() }
                    else { _ = store.startPomodoro() }
                } label: {
                    Image(systemName: store.status == .running ? "pause.fill" : "play.fill")
                        .font(.system(size: 11, weight: .semibold)).frame(width: 28, height: 28)
                        .background(Color.accentColor.opacity(0.16), in: Circle())
                }.buttonStyle(.plain).foregroundStyle(.tint).disabled(!store.ready)
                    .accessibilityLabel(store.status == .running ? nativeUI("暂停计时", "Pause timer") : store.status == .paused ? nativeUI("继续计时", "Resume timer") : nativeUI("开始计时", "Start timer"))
            }
            if widget.size != "mini" {
                ProgressView(value: store.progress).tint(.accentColor)
                HStack {
                    Text(store.completion ?? (store.status == .paused ? nativeUI("已暂停", "Paused") : store.status == .running ? nativeUI("专注进行中", "Focus in progress") : nativeUI("专注一件事", "One thing at a time")))
                        .foregroundStyle(.secondary).lineLimit(1)
                    Spacer(minLength: 3)
                    Button(nativeUI("设置", "Settings")) { widget.expand?() }.buttonStyle(.plain)
                }.font(.system(size: 10))
            }
            if store.error != nil {
                Button(nativeUI("查看保存问题", "Review save issue")) { widget.expand?() }.buttonStyle(.plain).font(.system(size: 10)).foregroundStyle(.orange)
            }
        }.padding(.horizontal, 12).padding(.bottom, 8)
    }
    private var expandedContent: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Label(nativeUI("番茄钟", "Pomodoro"), systemImage: "timer").font(.headline)
                Spacer()
                Picker(nativeUI("计时阶段", "Timer phase"), selection: Binding(get: { store.phase }, set: { _ = store.selectPomodoroPhase($0) })) {
                    Text(nativeUI("专注", "Focus")).tag(NativeQuickPomodoroPhase.focus)
                    Text(nativeUI("休息", "Rest")).tag(NativeQuickPomodoroPhase.rest)
                }.pickerStyle(.segmented).labelsHidden().frame(maxWidth: 150).disabled(store.status == .running || store.status == .paused)
            }
            HStack(alignment: .lastTextBaseline) {
                Text(store.timeLabel).font(.system(size: 42, weight: .medium, design: .rounded)).monospacedDigit().accessibilityLabel(nativeUI("剩余 \(store.remainingSeconds) 秒", "\(store.remainingSeconds) seconds remaining"))
                Spacer()
                if let deadline = store.deadline { Text(deadline, style: .time).font(.caption).foregroundStyle(.secondary).accessibilityLabel(nativeUI("预计结束", "Ends at")) }
                else if store.status == .paused { Text(nativeUI("已暂停", "Paused")).foregroundStyle(.secondary) }
            }
            ProgressView(value: store.progress).tint(store.phase == .focus ? .accentColor:.blue).accessibilityLabel(nativeUI("计时进度", "Timer progress"))
            HStack(spacing: 10) {
                Button {
                    if store.status == .running { _ = store.pausePomodoro() }
                    else if store.status == .paused { _ = store.resumePomodoro() }
                    else { _ = store.startPomodoro() }
                } label: {
                    Label(store.status == .running ? nativeUI("暂停", "Pause"):store.status == .paused ? nativeUI("继续", "Resume"):store.status == .completed ? nativeUI("开始\(store.phase.other.title)", "Start \(store.phase.other.title.lowercased())"):nativeUI("开始", "Start"), systemImage: store.status == .running ? "pause.fill":"play.fill")
                }.buttonStyle(.borderedProminent).disabled(!store.ready)
                Button(nativeUI("重置", "Reset")) { _ = store.resetPomodoro() }.disabled(!store.ready || store.status == .idle)
                Spacer()
            }
            if let completion = store.completion {
                HStack { Label(completion, systemImage: "checkmark.circle"); Spacer(); Button { _ = store.acknowledgeCompletion() } label: { Image(systemName: "xmark") }.buttonStyle(.plain).accessibilityLabel(nativeUI("关闭完成提示", "Dismiss completion")) }.font(.callout)
            }
            DisclosureGroup(nativeUI("时长设置", "Durations")) {
                VStack(spacing: 10) {
                    durationRow(nativeUI("专注", "Focus"), minutes: $durationDraft.focusMinutes, seconds: $durationDraft.focusSeconds)
                    durationRow(nativeUI("休息", "Rest"), minutes: $durationDraft.restMinutes, seconds: $durationDraft.restSeconds)
                    HStack {
                        Text(nativeUI("进行中的计时保持不变", "An active timer keeps its duration")).font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Button(nativeUI("保存时长", "Save durations")) {
                            switch durationDraft.validated() {
                            case .success(let values):
                                durationIssue = nil
                                _ = store.configurePomodoro(focusSeconds: values.focus, restSeconds: values.rest)
                            case .failure(let issue): durationIssue = issue
                            }
                        }.disabled(!store.ready)
                    }
                    if let durationIssue {
                        Text(durationIssue.message).font(.caption).foregroundStyle(.orange)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }.padding(.top, 8)
            }.font(.callout)
            NativeQuickUtilitiesFeedback(store: store)
        }.padding(16).onAppear {
            durationDraft = NativeQuickDurationDraft(focus: store.focusSeconds, rest: store.restSeconds)
            durationIssue = nil
        }
    }
    private func durationRow(_ title: String, minutes: Binding<NativeQuickDurationDraft.Field>, seconds: Binding<NativeQuickDurationDraft.Field>) -> some View {
        HStack {
            Text(title).frame(width: 44, alignment: .leading)
            NativeQuickDurationField(draft: minutes, maximum: 1440, label: title + nativeUI("分钟", " minutes")).frame(width: 54, height: 24)
            Text(nativeUI("分", "min")).foregroundStyle(.secondary)
            NativeQuickDurationField(draft: seconds, maximum: 59, label: title + nativeUI("秒", " seconds")).frame(width: 44, height: 24)
            Text(nativeUI("秒", "sec")).foregroundStyle(.secondary)
            Spacer()
        }
    }
}

struct NativeQuickDurationField: NSViewRepresentable {
    @Binding var draft: NativeQuickDurationDraft.Field
    let maximum: Int
    let label: String
    class Field: NSTextField {
        var adjust: ((Int) -> Void)?
        override func scrollWheel(with event: NSEvent) {
            // Ordinary scrolling belongs to the page. Only an explicit Option
            // scroll in the field being edited adjusts the value.
            guard currentEditor() != nil, event.modifierFlags.contains(.option),
                  event.scrollingDeltaY != 0 else { super.scrollWheel(with: event); return }
            adjust?(event.scrollingDeltaY > 0 ? 1:-1)
        }
    }
    class Coordinator: NSObject, NSTextFieldDelegate {
        var owner: NativeQuickDurationField
        init(_ owner: NativeQuickDurationField) { self.owner = owner }
        func controlTextDidChange(_ notification: Notification) { synchronize(notification) }
        func controlTextDidEndEditing(_ notification: Notification) { synchronize(notification) }
        private func synchronize(_ notification: Notification) {
            guard let field = notification.object as? NSTextField else { return }
            let editor = field.currentEditor() as? NSTextView
            // Never replace selected/marked text or normalize an invalid edit.
            // Save validates the live draft and cannot fall back to old values.
            owner.draft = .init(text: editor?.string ?? field.stringValue,
                                isComposing: editor?.hasMarkedText() == true)
        }
    }
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeNSView(context: Context) -> Field {
        let field = Field(); field.delegate = context.coordinator; field.alignment = .center; field.font = .monospacedDigitSystemFont(ofSize: 13, weight: .regular); field.setAccessibilityLabel(label)
        return field
    }
    func updateNSView(_ field: Field, context: Context) {
        context.coordinator.owner = self
        if field.currentEditor() == nil { field.stringValue = draft.text }
        field.adjust = { [weak field] delta in
            guard let field, (field.currentEditor() as? NSTextView)?.hasMarkedText() != true,
                  let current = draft.integer(maximum: maximum) else { return }
            let next = String(min(maximum, max(0, current + delta)))
            draft = .init(text: next)
            field.stringValue = next; field.currentEditor()?.string = next
        }
    }
}

struct NativeQuickCommandsView: View {
    @ObservedObject var store: NativeQuickUtilitiesStore
    @Environment(\.nativeQuickWidgetContext) private var widget
    @State private var selection = Set<String>()
    @State private var anchor: String?
    @State private var multiline = false
    var body: some View {
        Group {
            if widget.isDetail { expandedContent }
            else { compactContent }
        }
    }
    private var compactContent: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Label(nativeUI("常用提示词", "Saved prompts"), systemImage: "text.quote").font(.system(size: 11, weight: .medium))
                Spacer(minLength: 3)
                Button { widget.expand?() } label: { Image(systemName: "plus").font(.system(size: 11)) }
                    .buttonStyle(.plain).accessibilityLabel(nativeUI("添加提示词", "Add prompt"))
            }
            if store.commands.isEmpty {
                Button(nativeUI("保存常用文字，随时复用", "Save text to use again")) { widget.expand?() }
                    .buttonStyle(.plain).font(.system(size: 11)).foregroundStyle(.secondary)
            } else {
                ForEach(Array(store.commands.prefix(widget.size == "mini" ? 1 : widget.size == "small" ? 2 : widget.size == "medium" ? 3 : 4))) { item in
                    Button { _ = store.copyCommand(id: item.id) } label: {
                        HStack(spacing: 7) {
                            Text(item.text).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                            Image(systemName: store.copiedCommandID == item.id ? "checkmark" : "doc.on.doc").foregroundStyle(.secondary)
                        }.font(.system(size: 11)).contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityLabel(nativeUI("复制提示词：", "Copy prompt: ") + item.text)
                }
                if widget.size != "mini" {
                    Spacer(minLength: 0)
                    Button(nativeUI("全部 \(store.commands.count) 条", "All \(store.commands.count) prompts")) { widget.expand?() }
                        .font(.system(size: 10)).buttonStyle(.plain).foregroundStyle(.tint)
                }
            }
            if store.hasUnpersistedChanges || store.error != nil {
                Button(nativeUI("查看保存问题", "Review save issue")) { widget.expand?() }.buttonStyle(.plain).font(.system(size: 10)).foregroundStyle(.orange)
            }
        }.padding(.horizontal, 12).padding(.bottom, 8)
    }
    private var expandedContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label(nativeUI("常用提示词", "Saved prompts"), systemImage: "text.quote").font(.headline)
                Spacer()
                if !selection.isEmpty {
                    Button(nativeUI("删除 \(selection.count) 项", "Delete \(selection.count)"), role: .destructive) { if store.deleteCommands(ids: selection) { selection = [] } }
                }
            }
            if multiline || store.editingCommandID != nil {
                TextEditor(text: $store.commandDraft).font(.body).frame(minHeight: 74, maxHeight: 120).padding(5).background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8)).accessibilityLabel(nativeUI("提示词内容", "Prompt text")).disabled(!store.ready)
                HStack {
                    Button(nativeUI("保存", "Save")) { _ = store.saveCommand() }.buttonStyle(.borderedProminent).keyboardShortcut(.return, modifiers: .command).disabled(!store.ready || store.commandDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button(nativeUI("取消编辑", "Cancel edit")) { if store.cancelCommandEdit() { multiline = false } }
                    Spacer()
                    Text("⌘↵").font(.caption).foregroundStyle(.secondary)
                }
            } else {
                HStack {
                    TextField(nativeUI("添加常用指令、提示词或回复模板", "Add a command, prompt, or reply template"), text: $store.commandDraft).textFieldStyle(.roundedBorder).onSubmit { _ = store.saveCommand() }.disabled(!store.ready)
                    Button { multiline = true } label: { Image(systemName: "square.and.pencil") }.help(nativeUI("多行编辑", "Multiline editor")).disabled(!store.ready)
                    Button { _ = store.saveCommand() } label: { Image(systemName: "plus") }.disabled(!store.ready || store.commandDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty).help(nativeUI("保存提示词", "Save prompt"))
                }
            }
            if store.commands.isEmpty {
                Text(nativeUI("把常用文字放在这里，使用时一键复制。", "Keep reusable text here and copy it when needed.")).font(.callout).foregroundStyle(.secondary).frame(maxWidth: .infinity, minHeight: 58, alignment: .leading)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(store.commands) { item in
                            HStack(alignment: .top, spacing: 8) {
                                Button { select(item.id, extend: NSEvent.modifierFlags.contains(.shift)) } label: { Image(systemName: selection.contains(item.id) ? "checkmark.circle.fill":"circle").foregroundStyle(selection.contains(item.id) ? Color.accentColor:Color.secondary) }.buttonStyle(.plain).accessibilityLabel(nativeUI("选择提示词", "Select prompt"))
                                Button {
                                    if NSEvent.modifierFlags.contains(.shift) { select(item.id, extend: true) }
                                    else { _ = store.startEditingCommand(id: item.id) }
                                } label: { Text(item.text).lineLimit(3).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle()) }.buttonStyle(.plain).help(nativeUI("点击编辑", "Click to edit"))
                                Button { _ = store.copyCommand(id: item.id) } label: { Image(systemName: store.copiedCommandID == item.id ? "checkmark":"doc.on.doc") }.buttonStyle(.borderless).help(store.copiedCommandID == item.id ? nativeUI("已复制", "Copied"):nativeUI("复制", "Copy"))
                                Button(role: .destructive) { if store.deleteCommands(ids: [item.id]) { selection.remove(item.id) } } label: { Image(systemName: "trash") }.buttonStyle(.borderless).help(nativeUI("删除提示词", "Delete prompt"))
                            }.padding(.vertical, 10)
                            if item.id != store.commands.last?.id { Divider() }
                        }
                    }
                }
            }
            NativeQuickUtilitiesFeedback(store: store)
        }.padding(16)
    }
    private func select(_ id: String, extend: Bool) {
        let ids = store.commands.map(\.id)
        if extend, let anchor, let first = ids.firstIndex(of: anchor), let last = ids.firstIndex(of: id) { selection.formUnion(ids[min(first, last)...max(first, last)]) }
        else { if selection.contains(id) { selection.remove(id) } else { selection.insert(id) }; anchor = id }
    }
}

private struct NativeQuickUtilitiesFeedback: View {
    @ObservedObject var store: NativeQuickUtilitiesStore
    var body: some View {
        if let error = store.error {
            VStack(alignment: .leading, spacing: 6) {
                Text(error).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if store.hasUnpersistedChanges { Button(nativeUI("重试保存草稿", "Retry saving draft")) { _ = store.flushPendingDraft() }.font(.caption) }
                if !store.ready { Button(nativeUI("查看保留的文件", "Show retained files")) { store.revealStorage() }.font(.caption) }
            }
        }
    }
}
