import Foundation
import Combine
import AVFoundation

/// TO-DO Panel renderer/workspace.js:1776–1789 uses a real audio.controls
/// player. Keep its pause/seek affordances, with one native player and no
/// relationship to microphone capture or transcription transports.
@MainActor protocol NativeQuickRecordingPlaying: AnyObject {
    var duration: TimeInterval { get }
    var currentTime: TimeInterval { get set }
    var isPlaying: Bool { get }
    var onFinish: ((Bool) -> Void)? { get set }
    func play() -> Bool
    func pause()
    func stop()
}

@MainActor private final class NativeQuickRecordingAudioPlayer: NSObject, NativeQuickRecordingPlaying, AVAudioPlayerDelegate {
    private let player: AVAudioPlayer
    var onFinish: ((Bool) -> Void)?
    init(url: URL) throws { player = try AVAudioPlayer(contentsOf: url); super.init(); player.delegate = self }
    var duration: TimeInterval { player.duration }
    var currentTime: TimeInterval { get { player.currentTime } set { player.currentTime = newValue } }
    var isPlaying: Bool { player.isPlaying }
    func play() -> Bool { player.play() }
    func pause() { player.pause() }
    func stop() { player.stop() }
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor [weak self] in guard let self, self.player === player else { return }; self.onFinish?(flag) }
    }
    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor [weak self] in guard let self, self.player === player else { return }; self.onFinish?(false) }
    }
}

@MainActor final class NativeQuickRecordingPlayback: ObservableObject {
    struct State: Equatable {
        var id: String?
        var position: TimeInterval = 0
        var duration: TimeInterval = 0
        var isPlaying = false
        var preview: TimeInterval?
        var displayedPosition: TimeInterval { preview ?? position }
    }
    private struct Scrub { let id: UUID; let original: TimeInterval; let resume: Bool }
    @Published private(set) var state = State()
    private var player: NativeQuickRecordingPlaying?
    private var timer: Timer?
    private var scrub: Scrub?
    private var generation = 0
    private var awaitingCompletion = false
    private let factory: @MainActor (URL) throws -> NativeQuickRecordingPlaying
    private let automaticPolling: Bool
    var onPlayingChange: ((String?) -> Void)?
    var onFailure: (() -> Void)?
    var isPolling: Bool { timer != nil }

    init(automaticPolling: Bool = true, factory: @escaping @MainActor (URL) throws -> NativeQuickRecordingPlaying = { try NativeQuickRecordingAudioPlayer(url: $0) }) {
        self.automaticPolling = automaticPolling; self.factory = factory
    }
    deinit { timer?.invalidate() }

    private func bounded(_ value: TimeInterval) -> TimeInterval { min(state.duration, max(0, value.isFinite ? value : 0)) }
    private func publish(_ next: State) {
        guard next != state else { return }
        let oldPlaying = state.isPlaying ? state.id : nil
        state = next
        let newPlaying = next.isPlaying ? next.id : nil
        if oldPlaying != newPlaying { onPlayingChange?(newPlaying) }
    }
    private func prepare(id: String, url: URL) throws {
        if state.id == id, player != nil { return }
        stop()
        let next = try factory(url)
        guard next.duration.isFinite, next.duration > 0 else { next.stop(); throw CocoaError(.fileReadCorruptFile) }
        player = next
        let token = generation
        next.onFinish = { [weak self] success in
            guard let self, self.generation == token, self.state.id == id else { return }
            self.finish(success: success)
        }
        publish(State(id: id, position: 0, duration: next.duration))
    }
    private func startTimer() {
        timer?.invalidate(); timer = nil
        guard automaticPolling, state.isPlaying, scrub == nil else { return }
        let token = generation
        let next = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            Task { @MainActor in guard let self, self.generation == token else { return }; self.poll() }
        }
        timer = next; RunLoop.main.add(next, forMode: .common)
    }
    private func stopTimer() { timer?.invalidate(); timer = nil }
    func toggle(id: String, url: URL) throws {
        try prepare(id: id, url: url)
        guard scrub == nil, let player else { return }
        awaitingCompletion = false
        if state.isPlaying {
            player.pause(); stopTimer()
            var next = state; next.position = bounded(player.currentTime); next.isPlaying = false; publish(next)
        } else {
            if state.position >= state.duration { player.currentTime = 0 }
            guard player.play() else { stop(); throw CocoaError(.fileReadCorruptFile) }
            var next = state; next.position = bounded(player.currentTime); next.isPlaying = true; publish(next); startTimer()
        }
    }
    /// A drag owns a token. Polling never overwrites its preview; changing the
    /// record, leaving the page or losing access invalidates the token.
    func beginSeek(id: String, url: URL) throws -> UUID {
        try prepare(id: id, url: url)
        if let scrub { return scrub.id }
        awaitingCompletion = false
        let token = UUID(), position = bounded(player?.currentTime ?? state.position)
        scrub = Scrub(id: token, original: position, resume: state.isPlaying)
        player?.pause(); stopTimer()
        var next = state; next.position = position; next.preview = position; publish(next)
        return token
    }
    func previewSeek(_ token: UUID, to value: TimeInterval) {
        guard scrub?.id == token, value.isFinite else { return }
        var next = state; next.preview = bounded(value); publish(next)
    }
    func endSeek(_ token: UUID, commit: Bool) {
        guard let scrub, scrub.id == token, let player else { return }
        let target = commit ? state.preview ?? scrub.original : scrub.original
        self.scrub = nil; player.currentTime = bounded(target)
        var next = state; next.position = bounded(target); next.preview = nil
        next.isPlaying = scrub.resume && target < state.duration && player.play()
        publish(next); startTimer()
        if scrub.resume && target < state.duration && !next.isPlaying { onFailure?() }
    }
    func seek(id: String, url: URL, to value: TimeInterval) throws {
        guard value.isFinite else { return }
        let token = try beginSeek(id: id, url: url); previewSeek(token, to: value); endSeek(token, commit: true)
    }
    func poll() {
        guard scrub == nil, state.isPlaying, let player else { return }
        if !player.isPlaying {
            // An interruption is not proof of reaching the end. Keep the real
            // position; only the delegate's successful completion sets duration.
            awaitingCompletion = true; stopTimer()
            var next = state; next.position = bounded(player.currentTime); next.isPlaying = false; publish(next)
            return
        }
        var next = state; next.position = bounded(player.currentTime); publish(next)
    }
    private func finish(success: Bool) {
        // A previously queued player callback may arrive after the drag paused
        // it. The drag still owns the position, so do not overwrite its preview.
        guard scrub == nil, (state.isPlaying || awaitingCompletion), let player else { return }
        // A queued completion from immediately before a seek must not finish
        // the resumed player. AVAudioPlayer's actual state is authoritative.
        if success && player.isPlaying { return }
        awaitingCompletion = false; stopTimer(); player.pause(); var next = state
        next.position = success ? next.duration : bounded(player.currentTime)
        next.isPlaying = false; next.preview = nil; publish(next)
        if !success { onFailure?() }
    }
    func stop() {
        generation += 1; awaitingCompletion = false; scrub = nil; stopTimer()
        player?.onFinish = nil; player?.stop(); player = nil; publish(State())
    }
    func retainSelection(_ id: String?) { if let loaded = state.id, loaded != id { stop() } }
}
