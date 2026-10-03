import Foundation
import AppKit
import Carbon

func nativeUI(_ zh: String, _ en: String) -> String { en }

final class StatusTransport: NativeQuickSpotifyTransport {
    var running = true
    var permissionStatus: OSStatus = noErr
    var playerState = "kPSS"
    var permissionGate: DispatchSemaphore?
    private let lock = NSLock()
    private var entered = false
    private var sendProperties: [String?] = []
    private var prompts: [Bool] = []
    var permissionEntered: Bool { lock.lock(); defer { lock.unlock() }; return entered }
    var properties: [String?] { lock.lock(); defer { lock.unlock() }; return sendProperties }
    var asks: [Bool] { lock.lock(); defer { lock.unlock() }; return prompts }
    func runningTarget() -> NativeQuickSpotifyTarget? {
        running ? .init(pid: 4242, launchedAt: Date(timeIntervalSince1970: 123)) : nil
    }
    func isSameTarget(_ target: NativeQuickSpotifyTarget) -> Bool { running }
    func permission(_ target: NativeQuickSpotifyTarget, operation: NativeQuickSpotifyOperation, ask: Bool) -> OSStatus {
        lock.lock(); prompts.append(ask); entered = true; lock.unlock()
        if let permissionGate { _ = permissionGate.wait(timeout: .now() + 1) }
        return permissionStatus
    }
    func send(_ target: NativeQuickSpotifyTarget, operation: NativeQuickSpotifyOperation,
              property: String?, timeout: TimeInterval) throws -> NSAppleEventDescriptor {
        lock.lock(); sendProperties.append(property); lock.unlock()
        precondition(operation == .read && property == "pPlS", "Status fixture must not inspect any real or mock track metadata")
        return .init(enumCode: NativeQuickSpotifyAppleEvents.code(playerState))
    }
}

@main struct SpotifyStatusChecks {
    @MainActor static func main() async throws {
        var total = 0, failures = 0
        func check(_ value: Bool, _ text: String) {
            total += 1
            print("\(value ? "PASS" : "FAIL"): \(text)")
            if !value { failures += 1 }
        }
        func waitUntil(_ predicate: () -> Bool) async {
            for _ in 0..<1000 {
                if predicate() { return }
                try? await Task.sleep(nanoseconds: 1_000_000)
            }
            precondition(predicate(), "Bounded fixture wait expired")
        }
        func store(_ transport: StatusTransport, timeout: TimeInterval = 0.5) -> NativeQuickNowPlayingStore {
            .init(client: .init(transport: transport, operationTimeout: timeout,
                usageDescription: { true }), schedulesPolling: false,
                launcher: .init(findApplication: { URL(fileURLWithPath: "/fixture/Spotify.app") },
                    validApplication: { _ in true }, runningTarget: { transport.runningTarget() },
                    isSameTarget: { transport.isSameTarget($0) },
                    open: { _, _ in preconditionFailure("Passive status fixture must never open an application") }))
        }

        let first = StatusTransport()
        first.permissionStatus = OSStatus(errAEEventWouldRequireUserConsent)
        first.permissionGate = .init(value: 0)
        let firstStore = store(first)
        check(firstStore.snapshot.state != .notRunning && !firstStore.snapshot.canControl,
              "Constructed card does not claim Spotify is absent before checking")
        check(first.asks.isEmpty && first.properties.isEmpty, "Construction makes no permission request or metadata read")
        firstStore.setVisible(true)
        await waitUntil { first.permissionEntered }
        check(firstStore.busy && firstStore.snapshot.state != .notRunning,
              "Pending passive discovery shows an unverified state, not not-running")
        first.permissionGate?.signal()
        await waitUntil { !firstStore.busy }
        check(firstStore.snapshot.state == .authorizationRequired && first.asks == [false] && first.properties.isEmpty,
              "A running unauthorized target is Connect, never not-running and never prompts")
        firstStore.setVisible(false)

        let reentry = StatusTransport(); reentry.running = false
        let reentryStore = store(reentry)
        reentryStore.setVisible(true); await waitUntil { !reentryStore.busy }
        check(reentryStore.snapshot.state == .notRunning && reentry.asks.isEmpty && reentry.properties.isEmpty,
              "Only a completed absent-target check reports not-running, without events")
        reentryStore.setVisible(false)
        reentry.running = true; reentry.permissionStatus = OSStatus(errAEEventNotPermitted)
        reentry.permissionGate = .init(value: 0)
        reentryStore.setVisible(true); await waitUntil { reentry.permissionEntered }
        check(reentryStore.busy && reentryStore.snapshot.state != .notRunning,
              "Reopened card discards a prior not-running conclusion while checking again")
        reentry.permissionGate?.signal(); await waitUntil { !reentryStore.busy }
        check(reentryStore.snapshot.state == .denied && reentry.properties.isEmpty,
              "Automation denial stays distinct from target absence")
        reentryStore.setVisible(false)

        let stopped = StatusTransport(), stoppedStore = store(stopped)
        stoppedStore.setVisible(true); await waitUntil { !stoppedStore.busy }
        check(stoppedStore.snapshot.state == .stopped && stopped.properties == ["pPlS"],
              "No playback is stopped, without requesting an absent current track")
        stoppedStore.setVisible(false)

        let slow = StatusTransport(); slow.permissionGate = .init(value: 0)
        let slowStore = store(slow, timeout: 0.03)
        slowStore.setVisible(true); await waitUntil { slow.permissionEntered && !slowStore.busy }
        check(slowStore.snapshot.state == .timedOut, "A passive deadline remains timeout, not not-running")
        slow.permissionGate?.signal(); try await Task.sleep(nanoseconds: 30_000_000)
        check(slow.properties.isEmpty, "A late permission callback after timeout cannot read metadata")
        slowStore.setVisible(false)

        let hidden = StatusTransport(); hidden.permissionGate = .init(value: 0)
        hidden.permissionStatus = OSStatus(errAEEventNotPermitted)
        let hiddenStore = store(hidden)
        hiddenStore.setVisible(true); await waitUntil { hidden.permissionEntered }
        let pending = hiddenStore.snapshot
        hiddenStore.setVisible(false); hidden.permissionGate?.signal()
        try await Task.sleep(nanoseconds: 30_000_000)
        check(hiddenStore.snapshot == pending && !hiddenStore.busy && hidden.properties.isEmpty,
              "Hide cancels discovery and a late denial cannot publish into the hidden card")
        check(NativeQuickSpotifyClient.state(for: OSStatus(errAENoSuchObject)) == .unavailable,
              "An unreadable object is unavailable, not a claim that the process is absent")
        check(NSApp == nil, "Checks use fake transport only, no app, system permission or real AppleEvent")
        print("RESULT: \(total - failures)/\(total) status checks passed")
        if failures > 0 { exit(1) }
    }
}
