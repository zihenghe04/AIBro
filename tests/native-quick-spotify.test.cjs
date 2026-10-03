const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

test('Spotify public-event protocol, explicit permission, bounded cancellation and visibility lifecycle', {
  skip: process.platform !== 'darwin', timeout: 90000,
}, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-spotify-test-'));
  try {
    const source = path.join(temp, 'SpotifyTests.swift'), binary = path.join(temp, 'spotify-tests');
    fs.writeFileSync(source, String.raw`
import Foundation
import AppKit
import Carbon
func nativeUI(_ zh: String, _ en: String) -> String { en }
final class Fake: NativeQuickSpotifyTransport {
  let lock = NSLock()
  var running = true
  var sameTarget = true
  var permissionStatus: OSStatus = noErr
  var permissionDelay: TimeInterval = 0
  var errorStatus: OSStatus?
  var playerState = "kPSP"
  var trackID = "spotify:track:synthetic-a"
  var rawDuration: Double = 235000
  var position: Double = 42
  var repeating = false
  var shuffling = false
  var changeTrackDuringRead = false
  var trackReads = 0
  var sends: [(NativeQuickSpotifyOperation, String?, TimeInterval)] = []
  var asks: [Bool] = []
  var onMain = false
  var permissionEntered = false
  var forceExitAfterPermission = false
  func runningTarget() -> NativeQuickSpotifyTarget? {
    lock.lock(); defer { lock.unlock() }; onMain = onMain || Thread.isMainThread
    return running ? .init(pid: 4242, launchedAt: Date(timeIntervalSince1970: 123)) : nil
  }
  func isSameTarget(_ target: NativeQuickSpotifyTarget) -> Bool {
    lock.lock(); defer { lock.unlock() }; return sameTarget && running
  }
  func permission(_ target: NativeQuickSpotifyTarget, operation: NativeQuickSpotifyOperation, ask: Bool) -> OSStatus {
    lock.lock(); asks.append(ask); permissionEntered = true; let delay = permissionDelay, result = permissionStatus
    if forceExitAfterPermission { sameTarget = false }; lock.unlock()
    if delay > 0 { Thread.sleep(forTimeInterval: delay) }
    return result
  }
  func send(_ target: NativeQuickSpotifyTarget, operation: NativeQuickSpotifyOperation, property: String?, timeout: TimeInterval) throws -> NSAppleEventDescriptor {
    lock.lock(); defer { lock.unlock() }
    guard sameTarget && running else { throw NativeQuickSpotifyFailure.status(OSStatus(procNotFound)) }
    sends.append((operation, property, timeout)); onMain = onMain || Thread.isMainThread
    if let errorStatus { throw NativeQuickSpotifyFailure.status(errorStatus) }
    switch operation {
    case .seek(let value): position = value.position
    case .setRepeat(let value): repeating = value
    case .setShuffle(let value): shuffling = value
    default: break
    }
    if property == "ID  " { trackReads += 1; return .init(string: changeTrackDuringRead && trackReads % 2 == 0 ? "spotify:track:synthetic-b" : trackID) }
    if property == "pDur" { return .init(double: rawDuration) }
    if property == "pPos" { return .init(double: position) }
    if property == "pRep" { return .init(boolean: repeating) }
    if property == "pShu" { return .init(boolean: shuffling) }
    if property == "pPlS" { return .init(enumCode: NativeQuickSpotifyAppleEvents.code(playerState)) }
    if property == "pnam" { return .init(string: "Synthetic Song") }
    if property == "pArt" { return .init(string: "Synthetic Artist") }
    return .null()
  }
  var sendCount: Int { lock.lock(); defer { lock.unlock() }; return sends.count }
  var entered: Bool { lock.lock(); defer { lock.unlock() }; return permissionEntered }
}
@main struct SpotifyTests {
  @MainActor static func main() async throws {
    var checks = 0
    func check(_ value: Bool, _ message: String) { checks += 1; precondition(value, message) }
    func client(_ fake: Fake, timeout: TimeInterval = 1) -> NativeQuickSpotifyClient {
      .init(transport: fake, operationTimeout: timeout, authorizationTimeout: timeout, usageDescription: { true })
    }
    func makeStore(_ fake: Fake) -> NativeQuickNowPlayingStore {
      .init(client: client(fake), schedulesPolling: false,
        launcher: .init(findApplication: { URL(fileURLWithPath: "/fixture/Spotify.app") },
          validApplication: { _ in true }, runningTarget: { fake.runningTarget() },
          isSameTarget: { fake.isSameTarget($0) },
          open: { _, _ in preconditionFailure("Protocol fixture must never open an application") }))
    }
    func result(_ client: NativeQuickSpotifyClient, _ op: NativeQuickSpotifyOperation) async -> NativeQuickSpotifyReply {
      await withCheckedContinuation { continuation in client.request(op) { continuation.resume(returning: $0) } }
    }
    func state(_ reply: NativeQuickSpotifyReply) -> NativeQuickSpotifySnapshot {
      guard case .snapshot(let value) = reply else { fatalError("Expected a snapshot") }; return value
    }
    func waitUntil(_ condition: () -> Bool) async {
      for _ in 0..<500 { if condition() { return }; try? await Task.sleep(nanoseconds: 1_000_000) }
      precondition(condition(), "Condition timed out")
    }
    let f = Fake(), c = client(f)
    let playing = state(await result(c, .read))
    check(playing.state == .playing && playing.title == "Synthetic Song" && playing.artist == "Synthetic Artist", "Current metadata is decoded from real dictionary properties")
    check(f.asks == [false] && !f.onMain, "Passive checks never prompt and never run on the main thread")
    check(f.sends.map { $0.1 ?? "command" } == ["pPlS", "ID  ", "pnam", "pArt", "pDur", "pPos", "pRep", "pShu", "ID  "], "Snapshot reads documented playback properties and bounds metadata with track identity")
    check(playing.duration == 235 && playing.rawDuration == 235000 && playing.position == 42 && playing.canSeek, "Milliseconds conversion remains explicit; position already uses seconds")
    check(playing.repeating == false && playing.shuffling == false, "Boolean modes are read without inventing a repeat-one state")
    check(playing.displayedPosition(at: playing.observedAt + 1) == 43 && playing.displayedPosition(at: playing.observedAt + 60) == 45, "Progress extrapolates briefly, never indefinitely while Spotify is unresponsive")
    func seek(_ snap: NativeQuickSpotifySnapshot, position: Double = 90, age: Double = 0) -> NativeQuickSpotifyOperation {
      .seek(.init(trackID: snap.trackID, target: snap.target!, observedAt: snap.observedAt - age, position: position, duration: snap.duration!))
    }
    let sought = state(await result(c, seek(playing)))
    check(sought.position == 90 && f.sends.filter { if case .seek = $0.0 { return true }; return false }.count == 1, "One explicit seek writes once then reads actual position")
    let repeated = state(await result(c, .setRepeat(true)))
    let shuffled = state(await result(c, .setShuffle(true)))
    check(repeated.repeating == true && shuffled.shuffling == true && f.asks.allSatisfy { !$0 }, "Repeat/shuffle use explicit Boolean state, readback and no consent prompt")
    let changed = Fake(); changed.trackID = "spotify:track:other"
    if case .rejected(.trackChanged) = await result(client(changed), seek(playing)) { check(true, "Old track seek is rejected") } else { fatalError("Stale track was accepted") }
    check(changed.sends.allSatisfy { $0.0 == .read }, "Mismatched track never receives a setter")
    let expired = Fake()
    if case .rejected(.expired) = await result(client(expired), seek(playing, age: 121)) { check(true, "Expired drag is rejected") } else { fatalError("Expired drag was accepted") }
    check(expired.sendCount == 0, "Expired drag sends no events")
    let invalid = Fake()
    if case .rejected(.invalidPosition) = await result(client(invalid), seek(playing, position: .nan)) { check(true, "Nonfinite position is rejected") } else { fatalError("Invalid seek accepted") }
    check(invalid.sendCount == 0, "Invalid seek sends no events")
    let mixed = Fake(); mixed.changeTrackDuringRead = true
    if case .rejected(.trackChanged) = await result(client(mixed), .read) { check(true, "Metadata spanning two tracks is rejected") } else { fatalError("Mixed metadata accepted") }
    let unusable = Fake(); unusable.rawDuration = 0
    check(!state(await result(client(unusable), .read)).canSeek, "Missing/zero duration does not create a seekable track")
    let inconsistent = Fake(); inconsistent.rawDuration = 235
    let inconsistentSnapshot = state(await result(client(inconsistent), .read))
    check(!inconsistentSnapshot.canSeek && inconsistentSnapshot.rawDuration == 235 && inconsistentSnapshot.position == 42, "Invalid duration/position combinations disable seeking but preserve raw diagnostics without a unit heuristic")
    let priorProcess = NativeQuickSpotifySnapshot(state: .playing, trackID: playing.trackID,
      target: .init(pid: 4242, launchedAt: Date(timeIntervalSince1970: 1)), observedAt: playing.observedAt,
      position: 42, duration: 235)
    let restarted = Fake()
    if case .rejected(.trackChanged) = await result(client(restarted), seek(priorProcess)) { check(true, "Restarted Spotify rejects an old PID launch identity even if the same track is playing") } else { fatalError("Old process identity accepted") }
    check(restarted.sendCount == 0, "Old process seek never writes to its replacement")
    check(f.sends.allSatisfy { $0.2 > 0 && $0.2 <= 1 }, "Every event gets a finite remaining timeout")
    f.playerState = "kPSp"
    check(state(await result(c, .read)).state == .paused, "Paused is distinct from stopped/unavailable")
    f.playerState = "kPSS"
    let before = f.sendCount
    check(state(await result(c, .read)).state == .stopped && f.sendCount == before + 1, "Stopped does not query an absent current track")
    for op in [NativeQuickSpotifyOperation.play, .pause, .previous, .next] {
      let count = f.sendCount
      _ = await result(c, op)
      check(f.sends[count].0 == op && f.sends[count].1 == nil, "Each explicit button sends its exact non-toggle command")
    }
    f.running = false
    let events = f.sendCount, permissions = f.asks.count
    check(state(await result(c, .read)).state == .notRunning && f.sendCount == events && f.asks.count == permissions, "Not-running detection cannot send/authorize/launch Spotify")
    let noConsent = Fake(); noConsent.permissionStatus = OSStatus(errAEEventWouldRequireUserConsent)
    check(state(await result(client(noConsent), .read)).state == .authorizationRequired && noConsent.asks == [false] && noConsent.sendCount == 0, "First read presents a connect action without asking permission")
    let denied = Fake(); denied.permissionStatus = OSStatus(errAEEventNotPermitted)
    check(state(await result(client(denied), .read)).state == .denied && denied.sendCount == 0, "Denied permission is visible, never treated as no music")
    let consent = Fake()
    _ = await result(client(consent), .authorize)
    check(consent.asks == [true] && consent.sends.allSatisfy { $0.0 == .read }, "Only explicit authorization asks; it never starts playback")
    let missingDescription = Fake()
    let missingClient = NativeQuickSpotifyClient(transport: missingDescription, usageDescription: { false })
    check(state(await result(missingClient, .authorize)).state == .unavailable && missingDescription.asks.isEmpty, "Missing package permission description fails closed before a prompt")
    let reusedPID = Fake(); reusedPID.forceExitAfterPermission = true
    check(state(await result(client(reusedPID), .play)).state == .notRunning && reusedPID.sendCount == 0, "Exit/PID identity change blocks control after permission preflight")
    let error = Fake(); error.errorStatus = OSStatus(errAETimeout)
    check(state(await result(client(error), .pause)).state == .timedOut && error.sendCount == 1, "A failed control is not optimistically marked paused or automatically resent")
    let unknown = Fake(); unknown.playerState = "????"
    check(state(await result(client(unknown), .read)).state == .unavailable, "Unknown enums do not invent a playback state")

    let slow = Fake(); slow.permissionDelay = 0.15
    let slowClient = client(slow, timeout: 0.03), start = Date()
    check(state(await result(slowClient, .authorize)).state == .timedOut && Date().timeIntervalSince(start) < 0.12, "User consent wait has a bounded UI deadline")
    if case .busy = await result(slowClient, .read) { check(true, "Outstanding OS request cannot accumulate workers") }
    else { fatalError("Expected busy while OS callback remains outstanding") }
    try await Task.sleep(nanoseconds: 180_000_000)
    check(slow.sendCount == 0, "Late permission approval after timeout cannot send read or playback events")
    let cancel = Fake(); cancel.permissionDelay = 0.1
    let cancelClient = client(cancel)
    var cancelled: NativeQuickSpotifyReply?
    let handle = cancelClient.request(.play) { reply in DispatchQueue.main.async { cancelled = reply } }
    await waitUntil { cancel.entered }; handle.cancel()
    await waitUntil { cancelled != nil }
    if case .cancelled = cancelled { check(true, "Cancellation completes the waiting UI") } else { fatalError("Wrong cancel result") }
    try await Task.sleep(nanoseconds: 130_000_000)
    check(cancel.sendCount == 0, "Cancelled command cannot run after the blocked preflight returns")

    let visibleFake = Fake(), store = makeStore(visibleFake)
    store.refresh(); store.authorize(); store.playPause()
    check(visibleFake.sendCount == 0 && visibleFake.asks.isEmpty, "Hidden/constructed component cannot read, request permission or control")
    store.setVisible(true); await waitUntil { !store.busy }
    check(store.snapshot.state == .playing && visibleFake.asks == [false], "Visible component automatically discovers authorized Spotify")
    store.setVisible(false); let hiddenCount = visibleFake.sendCount; store.refresh(); store.next()
    check(visibleFake.sendCount == hiddenCount, "Hiding component disables polling and subsequent controls")
    let late = Fake(); late.permissionDelay = 0.08
    let lateStore = makeStore(late)
    lateStore.setVisible(true); await waitUntil { late.entered }; lateStore.setVisible(false)
    try await Task.sleep(nanoseconds: 120_000_000)
    check(late.sendCount == 0 && lateStore.snapshot.state == .checking && !lateStore.busy, "Hidden view rejects stale callback and cancels subsequent sends")
    let dragFake = Fake(), dragStore = makeStore(dragFake)
    dragStore.setVisible(true); await waitUntil { !dragStore.busy }
    let beforeDrag = dragFake.sendCount
    dragStore.beginSeek()
    for value in 10...80 { dragStore.updateSeek(Double(value)); dragStore.refresh() }
    check(dragFake.sendCount == beforeDrag && dragStore.seeking && dragStore.seekPosition == 80, "Dragging is local and suppresses polling without a setter per movement")
    dragStore.endSeek(); await waitUntil { !dragStore.busy }
    check(dragFake.sends.filter { if case .seek = $0.0 { return true }; return false }.count == 1 && dragStore.snapshot.position == 80, "Mouse-up submits exactly once and adopts readback")
    dragStore.beginSeek(); dragStore.updateSeek(235); dragStore.endSeek(); await waitUntil { !dragStore.busy }
    check(dragStore.snapshot.position == 234.75, "Right edge stays within the same song instead of silently skipping")
    dragFake.permissionDelay = 0.03
    dragStore.refresh(); dragStore.beginSeek(); dragStore.updateSeek(100); dragStore.endSeek()
    await waitUntil { !dragStore.busy }
    check(dragStore.snapshot.position == 100 && dragFake.sends.filter { if case .seek = $0.0 { return true }; return false }.count == 3, "Drag during an in-flight poll waits and sends once after the serial worker is free")
    dragStore.beginSeek(); dragStore.updateSeek(110); dragStore.setVisible(false); let hideDragCount = dragFake.sendCount
    dragStore.endSeek()
    check(!dragStore.seeking && dragFake.sendCount == hideDragCount, "Hiding the card discards an unfinished seek without changing playback")
    check(NativeQuickSpotifyAppleEvents.eventCode(.setRepeat(true)).1 == NativeQuickSpotifyAppleEvents.code("setd") && NativeQuickSpotifyAppleEvents.eventCode(seek(playing)).1 == NativeQuickSpotifyAppleEvents.code("setd"), "Writable properties use standard core/setd events")
    let spec = try NativeQuickSpotifyAppleEvents.property("pnam", container: NativeQuickSpotifyAppleEvents.property("pTrk"))
    check(spec.descriptorType == typeObjectSpecifier && spec.forKeyword(AEKeyword(keyAEKeyData))?.typeCodeValue == NativeQuickSpotifyAppleEvents.code("pnam"), "Native object specifier requests the documented current-track name")
    let options = NativeQuickSpotifyAppleEvents.sendOptions.rawValue
    check(options & UInt(kAEDoNotPromptForUserConsent) != 0 && options & UInt(kAENeverInteract) != 0, "Actual send forbids prompt even if permission is revoked after preflight")
    check(NativeQuickSpotifyAppleEvents.eventCode(.play).1 == NativeQuickSpotifyAppleEvents.code("Play") && NativeQuickSpotifyAppleEvents.eventCode(.pause).1 == NativeQuickSpotifyAppleEvents.code("Paus"), "Published Spotify command codes are used instead of a guessed keyboard toggle")
    check(NSApp == nil, "No test launches an app, sends a real AppleEvent or manipulates the system UI")
    print("PASS: \(checks) Spotify protocol, authorization and lifecycle assertions")
  }
}
`);
    const names = ['NativeQuickNowPlaying.swift', 'NativeQuickWindowSnapshot.swift', 'NativeQuickWindowActivation.swift', 'NativeQuickWindowInteraction.swift', 'NativeQuickWindowInteractionView.swift', 'NativeQuickMedia.swift', 'NativeQuickMirrorCamera.swift', 'NativeQuickMirrorPreferences.swift', 'NativeQuickMirrorStore.swift', 'NativeQuickMirrorView.swift', 'NativeQuickRecordingBatch.swift', 'NativeQuickRecordingTitle.swift', 'NativeQuickRecordingStore.swift', 'NativeSpeechService.swift', 'NativeSpeechCredentials.swift', 'NativeSpeechSettingsView.swift', 'NativeCredentials.swift','AgendaCore.swift', 'NativeQuickRecordingPlayback.swift', 'NativeQuickRealtimeASRHandoff.swift','NativeQuickRealtimeASRProtocol.swift','NativeQuickRealtimeASRSession.swift','NativeQuickRealtimeASRSettings.swift','NativeQuickRealtimeASRAudio.swift','NativeQuickRealtimeASRView.swift',
      'NativeQuickRecordingProjection.swift', 'NativeQuickRecordingViews.swift', 'NativeQuickWidgetContext.swift'];
    const built = spawnSync('xcrun', ['swiftc', '-swift-version', '5', '-target', 'arm64-apple-macosx14.0', '-parse-as-library',
      ...names.map(name => path.join(root, 'native/Sources/AIBro', name)), source, '-o', binary], { encoding: 'utf8', timeout: 65000 });
    assert.equal(built.status, 0, built.stdout + built.stderr + (built.error?.message || ''));
    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
    assert.equal(run.status, 0, run.stdout + run.stderr + (run.error?.message || ''));
    assert.match(run.stdout, /PASS: \d+ Spotify/); console.log(run.stdout.trim());
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('native package declares Spotify automation without removing camera microphone or speech purposes', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-spotify-plist-'));
  try {
    fs.mkdirSync(path.join(temp, 'Contents'));
    const script = fs.readFileSync(path.join(root, 'scripts/build-native-app.sh'), 'utf8');
    const python = script.match(/<<'PY'\n([\s\S]*?)\nPY/)[1];
    const generated = spawnSync('python3', ['-', temp, path.join(root, 'package.json')], { input: python, encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    const parsed = spawnSync('python3', ['-c', 'import json,plistlib,sys; print(json.dumps(plistlib.load(open(sys.argv[1],"rb"))))', path.join(temp, 'Contents/Info.plist')], { encoding: 'utf8' });
    assert.equal(parsed.status, 0, parsed.stderr);
    const plist = JSON.parse(parsed.stdout);
    assert.match(plist.NSAppleEventsUsageDescription, /Spotify/);
    for (const name of ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription', 'NSSpeechRecognitionUsageDescription']) assert.ok(plist[name]);
    assert.equal(plist.CFBundleIdentifier, 'app.ai-workstation.studio');
    const entitlements = spawnSync('python3', ['-c', 'import json,plistlib,sys; print(json.dumps(plistlib.load(open(sys.argv[1],"rb"))))', path.join(root, 'native/Entitlements.plist')], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(entitlements.stdout), { 'com.apple.security.automation.apple-events': true });
    assert.ok(require('../scripts/release-native').requiredNativeSourceInputs(root).includes('native/Entitlements.plist'));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
