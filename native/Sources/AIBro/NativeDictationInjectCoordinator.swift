import Foundation
import Combine

/// Dictation into whatever app holds the caret. Driven by one trigger key:
/// hold to talk and release to insert, or tap once to start and tap again to
/// stop. Only the island status is shown; the key window is never taken, so
/// the caret stays where the user left it.
@MainActor final class NativeDictationInjectCoordinator: ObservableObject {
    enum Phase: Equatable { case idle, starting, recording, transcribing, injecting, done, failed }
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var latched = false
    @Published private(set) var message: String?
    @Published private(set) var outcome: NativeDictationInjectOutcome?
    let dictation: NativeSpeechDictation
    /// A key held this long counts as press-to-talk; a shorter press latches.
    var tapThreshold = 0.3
    /// Delay before the microphone opens on press, so ⌥ used as a modifier never records.
    var armDelay = 0.12
    var noticeSeconds = 1.6
    var issueSeconds = 4.0
    private let verify: @MainActor () async -> Bool
    private let frontmost: @MainActor () -> NativeDictationInjectTarget?
    private let inject: @MainActor (String, NativeDictationInjectTarget) async -> NativeDictationInjectOutcome
    private let now: () -> Date
    private let sleep: (Double) async -> Void
    private var lease: NativeSpeechDictation.Lease?
    private var target: NativeDictationInjectTarget?
    private var generation = 0
    private var operation: Task<Void, Never>?
    private var arming: Task<Void, Never>?
    private var clearing: Task<Void, Never>?
    private var subscription: AnyCancellable?
    private var liveSubscription: AnyCancellable?
    private var pressedAt: Date?
    private var pressStarted = false
    private var pressIsStop = false

    init(dictation: NativeSpeechDictation, verify: @escaping @MainActor () async -> Bool,
         frontmost: @escaping @MainActor () -> NativeDictationInjectTarget?,
         inject: @escaping @MainActor (String, NativeDictationInjectTarget) async -> NativeDictationInjectOutcome,
         now: @escaping () -> Date = Date.init,
         sleep: @escaping (Double) async -> Void = { try? await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }) {
        self.dictation = dictation; self.verify = verify; self.frontmost = frontmost; self.inject = inject
        self.now = now; self.sleep = sleep
        liveSubscription = dictation.$liveText.sink { [weak self] _ in
            guard let self, self.phase == .recording else { return }
            self.objectWillChange.send()
        }
        subscription = dictation.$phase.sink { [weak self] state in
            guard let self, self.lease != nil else { return }
            if state == .recorded && self.phase == .recording && self.dictation.autoStopped {
                Task { @MainActor [weak self] in self?.finish() }
            }
            if [.starting, .recording].contains(self.phase) && (state == .idle || state == .error) {
                self.fail(nativeUI("录音已停止，没有输入文字。", "Recording stopped; nothing was inserted."))
            }
        }
    }

    var active: Bool { phase != .idle && phase != .done && phase != .failed }

    // MARK: Trigger

    /// Physical press of the trigger key.
    func press() {
        if pressedAt != nil { return }
        dictateLog("coordinator press phase=\(phase)")
        pressedAt = now(); pressStarted = false; pressIsStop = false
        switch phase {
        case .starting, .recording:
            // Second tap of a latched recording stops it on the way down.
            if latched { pressIsStop = true; finish() }
        case .transcribing, .injecting:
            break
        case .idle, .done, .failed:
            let token = generation
            arming = Task { @MainActor [weak self] in
                guard let self else { return }
                await self.sleep(self.armDelay)
                guard !Task.isCancelled, self.generation == token, self.pressedAt != nil, !self.pressStarted else { return }
                self.arming = nil
                self.pressStarted = true
                self.start(latched: false)
            }
        }
    }

    /// Physical release of the trigger key.
    func release() {
        guard let pressed = pressedAt else { return }
        dictateLog("coordinator release phase=\(phase)")
        pressedAt = nil
        if pressIsStop { pressIsStop = false; return }
        if let arming {
            // Released before the microphone opened: a tap that latches.
            arming.cancel(); self.arming = nil
            start(latched: true); return
        }
        guard pressStarted, phase == .starting || phase == .recording else { return }
        pressStarted = false
        if now().timeIntervalSince(pressed) < tapThreshold {
            latched = true; dictation.autoStopAllowed = true
        } else if phase == .starting {
            invalidate()
        } else {
            finish()
        }
    }

    /// Another key or modifier joined the trigger: the user meant a shortcut, not dictation.
    func abortPress() {
        guard pressedAt != nil else { return }
        pressedAt = nil
        if pressIsStop { pressIsStop = false; return }
        if let arming { arming.cancel(); self.arming = nil; return }
        if pressStarted && !latched { pressStarted = false; invalidate() }
    }

    // MARK: Session

    private func start(latched startLatched: Bool) {
        guard !active else { return }
        clearing?.cancel(); clearing = nil
        guard dictation.lease == nil else {
            show(nativeUI("请先结束当前语音输入或录音。", "Finish the current dictation or recording first."), failed: true); return
        }
        guard let destination = frontmost() else {
            dictateLog("start refused: no frontmost target")
            show(nativeUI("先点到要输入文字的位置。", "Click where the text should go first."), failed: true); return
        }
        generation += 1; let token = generation
        let request = NativeSpeechDictation.Lease(nonce: UUID().uuidString, conversationId: nil, revision: token, mode: .inject)
        dictation.autoStopAllowed = startLatched
        lease = request; target = destination; latched = startLatched
        message = nil; outcome = nil; phase = .starting
        operation = Task { [weak self] in
            guard let self, self.generation == token, self.lease == request, !Task.isCancelled else { return }
            dictateLog("recording start requested latched=\(startLatched)")
            let result = await self.dictation.start(request, verify: self.verify)
            dictateLog("recording start result status=\(result["status"] as? String ?? "?") \(result["message"] as? String ?? "")")
            guard self.generation == token, self.lease == request, !Task.isCancelled else { return }
            self.operation = nil
            if result["status"] as? String == "recording" { self.phase = .recording }
            else { self.fail(result["message"] as? String ?? nativeUI("暂时无法开始听写，请稍后重试。", "Dictation is unavailable. Try again shortly.")) }
        }
    }

    func finish() {
        guard let request = lease, let destination = target else { return }
        guard phase == .recording || phase == .starting && latched else { return }
        if phase == .starting { invalidate(); return }
        let token = generation; phase = .transcribing; latched = false
        operation = Task { [weak self] in
            guard let self else { return }
            dictateLog("transcription requested")
            let result = await self.dictation.finish(request)
            dictateLog("transcription result status=\(result["status"] as? String ?? "?") chars=\((result["text"] as? String)?.count ?? 0) \(result["message"] as? String ?? "")")
            guard self.generation == token, self.lease == request, !Task.isCancelled else { return }
            guard result["status"] as? String == "completed", result["nonce"] as? String == request.nonce,
                  let text = result["text"] as? String else {
                self.fail(result["message"] as? String ?? nativeUI("听写已取消，没有输入文字。", "Dictation was cancelled; nothing was inserted.")); return
            }
            self.phase = .injecting
            let outcome = await self.inject(text, destination)
            guard self.generation == token, !Task.isCancelled else { return }
            self.operation = nil; self.lease = nil; self.target = nil
            self.outcome = outcome
            dictateLog("injection outcome=\(outcome)")
            switch outcome {
            case .typed, .pasted: self.show(nativeUI("已输入", "Inserted"), failed: false)
            case .empty: self.show(nativeUI("没有识别到文字。", "No speech was recognized."), failed: true)
            case .copied(let reason): self.show(Self.copiedMessage(reason), failed: true)
            }
        }
    }

    static func copiedMessage(_ reason: NativeDictationInjectOutcome.CopyReason) -> String {
        switch reason {
        case .secure: return nativeUI("密码框不自动输入，文字已复制。", "Password fields are skipped; text copied.")
        case .permission: return nativeUI("需要辅助功能权限才能输入，文字已复制。", "Accessibility access is needed to insert; text copied.")
        case .targetChanged: return nativeUI("输入位置已变化，文字已复制。", "The text field changed; text copied.")
        case .unverified: return nativeUI("未确认完整输入，文字已复制。", "Insertion was not confirmed; text copied.")
        case .noFocus, .failed: return nativeUI("无法输入，文字已复制。", "Could not insert; text copied.")
        }
    }

    func invalidate() {
        generation += 1
        arming?.cancel(); arming = nil; operation?.cancel(); operation = nil
        clearing?.cancel(); clearing = nil
        if let lease { dictation.cancel(lease) }
        lease = nil; target = nil; latched = false; pressStarted = false
        message = nil; outcome = nil; phase = .idle
    }

    private func fail(_ text: String) {
        dictateLog("fail: \(text)")
        generation += 1; operation?.cancel(); operation = nil
        if let lease { dictation.cancel(lease) }
        lease = nil; target = nil; latched = false; pressStarted = false
        show(text, failed: true)
    }

    private func show(_ text: String, failed: Bool) {
        message = text; phase = failed ? .failed : .done
        clearing?.cancel()
        let token = generation, seconds = failed ? issueSeconds : noticeSeconds
        clearing = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.sleep(seconds)
            guard !Task.isCancelled, self.generation == token, self.phase == .done || self.phase == .failed else { return }
            self.clearing = nil; self.message = nil; self.outcome = nil; self.phase = .idle
        }
    }

    // MARK: Island

    var presentationTitle: String {
        switch phase {
        case .starting, .recording:
            return nativeUI("正在听写", "Dictating")
        case .transcribing: return nativeUI("正在转写", "Transcribing")
        case .injecting: return nativeUI("正在输入", "Inserting")
        case .done, .failed: return message ?? ""
        case .idle: return ""
        }
    }
    var presentationSymbol: String {
        switch phase {
        case .starting, .recording: return "mic.fill"
        case .transcribing, .injecting: return "text.cursor"
        case .done: return "checkmark"
        case .failed: return outcome.map { if case .copied = $0 { return "doc.on.clipboard" } else { return "exclamationmark.circle" } } ?? "exclamationmark.circle"
        case .idle: return "mic"
        }
    }
    /// How to finish, shown next to the title while listening.
    var presentationHint: String? {
        guard phase == .recording || phase == .starting else { return nil }
        return latched ? nativeUI("再按一次结束", "tap again to stop") : nativeUI("松开输入", "release to insert")
    }
    /// Tail of the text heard so far, so interim results show while talking.
    var presentationDetail: String? {
        guard phase == .recording || phase == .starting else { return nil }
        let text = dictation.liveText.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : String(text.suffix(24))
    }
    var presentationBusy: Bool { phase == .transcribing || phase == .injecting }
}
