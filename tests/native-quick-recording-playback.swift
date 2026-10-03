import Foundation
import AppKit
import Combine
func nativeUI(_ zh: String, _ en: String) -> String { en }
struct CheckFailure: Error { let message: String }
@MainActor final class FakePlayer: NativeQuickRecordingPlaying {
    var duration: TimeInterval = 30
    var currentTime: TimeInterval = 0
    var isPlaying = false
    var onFinish: ((Bool) -> Void)?
    var plays = 0, pauses = 0, stops = 0
    var canPlay = true
    func play() -> Bool { plays += 1; isPlaying = canPlay; return canPlay }
    func pause() { pauses += 1; isPlaying = false }
    func stop() { stops += 1; isPlaying = false }
}
@main struct Checks {
    @MainActor static func main() throws {
        var count = 0
        func check(_ condition: Bool, _ message: String) throws { guard condition else { throw CheckFailure(message: message) }; count += 1; print("PASS \(message)") }
        let url = URL(fileURLWithPath: "/synthetic-unused.m4a")
        var players: [FakePlayer] = [], failures = 0, changes: [String?] = []
        let playback = NativeQuickRecordingPlayback { _ in let player = FakePlayer(); players.append(player); return player }
        playback.onFailure = { failures += 1 }; playback.onPlayingChange = { changes.append($0) }
        try playback.toggle(id: "one", url: url)
        let first = players[0]
        try check(playback.state.isPlaying && playback.isPolling && first.plays == 1, "play uses injected real controller and bounded timer")
        first.currentTime = 4; playback.poll()
        try check(playback.state.position == 4 && changes.count == 1, "playhead poll has no discrete playing-ID event")
        try playback.toggle(id: "one", url: url)
        try check(!playback.state.isPlaying && !playback.isPolling && playback.state.position == 4, "pause retains actual position and removes timer")
        try playback.toggle(id: "one", url: url)
        try check(players.count == 1 && first.currentTime == 4 && first.plays == 2, "resume reuses same player from paused position")
        first.currentTime = 6
        let drag = try playback.beginSeek(id: "one", url: url)
        playback.previewSeek(drag, to: 18); first.currentTime = 7; playback.poll()
        try check(!first.isPlaying && !playback.isPolling && playback.state.displayedPosition == 18 && playback.state.position == 6, "drag pauses audio and poll cannot overwrite preview")
        playback.endSeek(drag, commit: true)
        try check(first.currentTime == 18 && first.isPlaying && playback.state.preview == nil && playback.isPolling, "release seeks once and resumes previous playing state")
        let cancelled = try playback.beginSeek(id: "one", url: url)
        playback.previewSeek(cancelled, to: 25); playback.endSeek(cancelled, commit: false)
        try check(first.currentTime == 18 && first.isPlaying, "cancel restores start position and playback intent")
        try playback.toggle(id: "one", url: url)
        let pausedDrag = try playback.beginSeek(id: "one", url: url)
        playback.previewSeek(pausedDrag, to: 11); playback.endSeek(pausedDrag, commit: true)
        try check(!first.isPlaying && playback.state.position == 11, "paused seek does not autoplay")
        try playback.seek(id: "one", url: url, to: -100)
        try check(playback.state.position == 0, "seek clamps before start")
        try playback.seek(id: "one", url: url, to: 100)
        try check(playback.state.position == 30 && !first.isPlaying, "seek clamps beyond duration and stays paused")
        try playback.toggle(id: "one", url: url)
        try check(first.currentTime == 0 && first.isPlaying, "play at end replays from zero")
        try playback.seek(id: "one", url: url, to: .nan)
        try check(first.currentTime == 0 && first.isPlaying, "nonfinite seek is ignored without disrupting playback")
        first.currentTime = 9; first.isPlaying = false; playback.poll()
        try check(playback.state.position == 9 && !playback.state.isPlaying && !playback.isPolling, "unexpected stop is not invented as full completion")
        first.onFinish?(true)
        try check(playback.state.position == 30 && !playback.state.isPlaying, "actual successful delegate receipt confirms end after final poll")
        try playback.toggle(id: "one", url: url)
        let oldFinish = first.onFinish
        let abandoned = try playback.beginSeek(id: "one", url: url)
        playback.previewSeek(abandoned, to: 20)
        try playback.toggle(id: "two", url: url)
        let second = players[1]
        playback.endSeek(abandoned, commit: true); playback.previewSeek(abandoned, to: 29); oldFinish?(true)
        try check(playback.state.id == "two" && playback.state.position == 0 && second.isPlaying && first.stops == 1, "record switch invalidates old scrub and completion callbacks")
        second.currentTime = 3; try playback.seek(id: "two", url: url, to: 12); second.onFinish?(true)
        try check(playback.state.isPlaying && playback.state.position == 12, "queued completion cannot stop a resumed seek")
        second.onFinish?(false)
        try check(!second.isPlaying && !playback.state.isPlaying && !playback.isPolling && failures == 1 && playback.state.position == 12, "decode failure pauses and retains actual position with explicit failure")
        playback.retainSelection("three")
        try check(playback.state.id == nil && second.stops == 1, "new filtered selection releases loaded paused player")
        try playback.seek(id: "idle", url: url, to: 15)
        try check(!playback.state.isPlaying && playback.state.position == 15 && players.last!.plays == 0, "pre-play seek prepares without sound or autoplay")
        playback.stop()
        try check(playback.state == .init() && !playback.isPolling, "stop releases timer and all displayed state")
        let invalid = NativeQuickRecordingPlayback(automaticPolling: false) { _ in let player = FakePlayer(); player.duration = .nan; return player }
        do { try invalid.toggle(id: "bad", url: url); throw CheckFailure(message: "invalid duration accepted") } catch is CocoaError {}
        try check(invalid.state.id == nil && !invalid.isPolling, "invalid audio duration fails before publishing a playable item")

        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("aibro-playback-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let audioDir = directory.appendingPathComponent("quick-recordings")
        var archive = try NativeQuickRecordingArchive(directory: audioDir)
        let id = UUID().uuidString.lowercased(), otherID = UUID().uuidString.lowercased()
        let rows = [id, otherID].map { NativeQuickRecordingItem(id: $0, title: "Synthetic", createdAt: Date(), duration: 30, transcript: "Complete fictional transcript", state: "ready") }
        try archive.replace(rows)
        for row in rows { try Data("synthetic-not-audio".utf8).write(to: archive.audioURL(for: row.id, mustExist: false)) }
        var storePlayers: [FakePlayer] = []
        let controller = NativeQuickRecordingPlayback(automaticPolling: false) { _ in let p = FakePlayer(); storePlayers.append(p); return p }
        let store = NativeQuickRecordingStore(playback: controller)
        store.configure(directory: directory); store.setVisible(true)
        var storeChanges = 0
        let subscription = store.objectWillChange.sink { storeChanges += 1 }
        store.play(id: id)
        let afterPlay = storeChanges
        for value in 1...10 { storePlayers[0].currentTime = Double(value); controller.poll() }
        try check(storeChanges == afterPlay && controller.state.position == 10, "ten actual helper ticks do not publish the whole recordings store")
        store.play(id: id)
        try check(store.playingID == nil && controller.state.id == id && controller.state.position == 10, "store pause clears row playing indicator while retaining loaded player")
        store.selectPlayback(otherID)
        try check(controller.state.id == nil, "library selection contract stops paused previous item")
        store.play(id: id); let hiddenDrag = store.beginPlaybackSeek(id: id)!
        controller.previewSeek(hiddenDrag, to: 22); store.setVisible(false); controller.endSeek(hiddenDrag, commit: true)
        try check(controller.state.id == nil && store.playingID == nil && !storePlayers.last!.isPlaying, "leaving panel invalidates scrub and prevents late resume")
        store.play(id: id)
        try check(controller.state.id == nil, "hidden playback request is rejected")
        store.setVisible(true); store.play(id: id); store.setAvailable(false)
        try check(controller.state.id == nil && store.items.isEmpty, "private or unavailable state clears player and visible records")
        store.setAvailable(true); store.play(id: id); store.play(id: id); store.setDeleted(id: id, deleted: true)
        try check(controller.state.id == nil && store.items.first(where: { $0.id == id })?.deletedAt != nil, "deletion of paused loaded audio releases player after durable mutation")
        try check(try Data(contentsOf: audioDir.appendingPathComponent(rows[0].fileName)) == Data("synthetic-not-audio".utf8), "deletion never removes or changes original audio bytes")
        try check(store.items.first(where: { $0.id == id })?.transcript == rows[0].transcript && store.undoBatch(), "transcript and existing deletion undo remain intact")
        store.play(id: id); let late = storePlayers.last!.onFinish
        store.configure(directory: directory.appendingPathComponent("other-owner")); late?(true)
        try check(!store.available && controller.state.id == nil, "workspace mismatch cannot retain or restore previous player")
        subscription.cancel(); store.shutdown()
        try check(NSApp == nil, "checks create no GUI App, no microphone, no playback device and no network")
        print("PASS \(count) production playback checks")
    }
}
