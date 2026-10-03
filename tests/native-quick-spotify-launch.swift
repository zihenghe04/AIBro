import Foundation
import AppKit
import Carbon

func nativeUI(_ zh: String, _ en: String) -> String { en }

final class LaunchTransport: NativeQuickSpotifyTransport {
    private let lock = NSLock()
    private var current: NativeQuickSpotifyTarget?
    private var permissionValue: OSStatus = noErr
    private var stateValue = "kPSS"
    private var calls: [(NativeQuickSpotifyTarget, NativeQuickSpotifyOperation, String?)] = []
    private var permissions: [(NativeQuickSpotifyTarget, Bool)] = []
    var gate: DispatchSemaphore?
    var replaceAfterStateRead: NativeQuickSpotifyTarget?
    var target: NativeQuickSpotifyTarget? {
        get { lock.lock(); defer { lock.unlock() }; return current }
        set { lock.lock(); current = newValue; lock.unlock() }
    }
    var permissionStatus: OSStatus {
        get { lock.lock(); defer { lock.unlock() }; return permissionValue }
        set { lock.lock(); permissionValue = newValue; lock.unlock() }
    }
    var playerState: String {
        get { lock.lock(); defer { lock.unlock() }; return stateValue }
        set { lock.lock(); stateValue = newValue; lock.unlock() }
    }
    var sends: [(NativeQuickSpotifyTarget, NativeQuickSpotifyOperation, String?)] { lock.lock(); defer { lock.unlock() }; return calls }
    var asks: [(NativeQuickSpotifyTarget, Bool)] { lock.lock(); defer { lock.unlock() }; return permissions }
    func runningTarget() -> NativeQuickSpotifyTarget? { target }
    func isSameTarget(_ target: NativeQuickSpotifyTarget) -> Bool { self.target == target }
    func permission(_ target: NativeQuickSpotifyTarget, operation: NativeQuickSpotifyOperation, ask: Bool) -> OSStatus {
        lock.lock(); permissions.append((target, ask)); let result = permissionValue; lock.unlock()
        if let gate { _ = gate.wait(timeout: .now() + 1) }
        return result
    }
    func send(_ target: NativeQuickSpotifyTarget, operation: NativeQuickSpotifyOperation,
              property: String?, timeout: TimeInterval) throws -> NSAppleEventDescriptor {
        lock.lock(); defer { lock.unlock() }
        guard current == target else { throw NativeQuickSpotifyFailure.status(OSStatus(procNotFound)) }
        calls.append((target, operation, property))
        precondition(operation == .read, "Launch/Connect must never start playback or send controls")
        switch property {
        case "pPlS":
            if let replacement = replaceAfterStateRead { current = replacement }
            return .init(enumCode: NativeQuickSpotifyAppleEvents.code(stateValue))
        case "ID  ": return .init(string: "spotify:track:fixture-only")
        case "pnam": return .init(string: "Fixture track")
        case "pArt": return .init(string: "Fixture artist")
        case "pDur": return .init(double: 120000)
        case "pPos": return .init(double: 2)
        case "pRep", "pShu": return .init(boolean: false)
        default: preconditionFailure("Unexpected property")
        }
    }
}

final class LaunchProbe {
    let transport = LaunchTransport()
    var foundURL: URL? = URL(fileURLWithPath: "/fixture/Spotify.app")
    var valid = true
    var lookupHook: (() -> Void)?
    private(set) var lookups = 0
    private(set) var opened: [URL] = []
    private(set) var callbacks: [(NativeQuickSpotifyOpenResult) -> Void] = []
    private(set) var diagnosticEvents: [NativeQuickSpotifyLaunchDiagnostic] = []
    var diagnosticHook: (([NativeQuickSpotifyLaunchDiagnostic]) -> Void)?
    func launcher(timeout: TimeInterval = 0.5) -> NativeQuickSpotifyLauncher {
        .init(findApplication: { [self] in lookups += 1; lookupHook?(); return foundURL },
            validApplication: { [self] _ in valid },
            runningTarget: { [self] in transport.runningTarget() },
            isSameTarget: { [self] in transport.isSameTarget($0) }, timeout: timeout, readinessInterval: 0.01,
            diagnostics: { [self] events in diagnosticEvents = events; diagnosticHook?(events) },
            open: { [self] url, completion in opened.append(url); callbacks.append(completion) })
    }
    @MainActor func store(timeout: TimeInterval = 0.5, polling: Bool = false) -> NativeQuickNowPlayingStore {
        .init(client: .init(transport: transport, operationTimeout: 0.5, authorizationTimeout: 0.5,
                          usageDescription: { true }), schedulesPolling: polling, launcher: launcher(timeout: timeout))
    }
}

@main struct SpotifyLaunchChecks {
    @MainActor static func main() async throws {
        var checks = 0, failures = 0
        func check(_ result: Bool, _ description: String) {
            checks += 1; if !result { failures += 1 }
            print("\(result ? "PASS" : "FAIL"): \(description)")
        }
        func waitUntil(_ predicate: () -> Bool) async {
            for _ in 0..<1500 {
                if predicate() { return }
                try? await Task.sleep(nanoseconds: 1_000_000)
            }
            precondition(predicate(), "Bounded fixture wait expired")
        }
        func settle() async { try? await Task.sleep(nanoseconds: 30_000_000) }
        let first = NativeQuickSpotifyTarget(pid: 4242, launchedAt: Date(timeIntervalSince1970: 100))
        let replacement = NativeQuickSpotifyTarget(pid: 4242, launchedAt: Date(timeIntervalSince1970: 200))
        func application(_ target: NativeQuickSpotifyTarget, bundleID: String? = NativeQuickSpotifyAppleEvents.bundleID,
                         terminated: Bool = false) -> NativeQuickSpotifyOpenResult {
            .init(application: .init(bundleID: bundleID, pid: target.pid, launchedAt: target.launchedAt, terminated: terminated))
        }
        func failedOpen() -> NativeQuickSpotifyOpenResult { .init(application: nil, errorDomain: "NSOSStatusErrorDomain", errorCode: -600) }
        func show(_ store: NativeQuickNowPlayingStore) async { store.setVisible(true); await waitUntil { !store.busy } }

        // Real filesystem validation, restricted to throwaway synthetic bundles.
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("aibro-spotify-install-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        func bundle(_ name: String, id: String, executable: Bool) throws -> URL {
            let app = directory.appendingPathComponent(name + ".app"), contents = app.appendingPathComponent("Contents")
            try FileManager.default.createDirectory(at: contents.appendingPathComponent("MacOS"), withIntermediateDirectories: true)
            let data = try PropertyListSerialization.data(fromPropertyList: ["CFBundleIdentifier": id, "CFBundleExecutable": "fixture"], format: .xml, options: 0)
            try data.write(to: contents.appendingPathComponent("Info.plist"))
            if executable {
                let file = contents.appendingPathComponent("MacOS/fixture")
                try Data("fixture; never executed".utf8).write(to: file)
                try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: file.path)
            }
            return app
        }
        check(!NativeQuickSpotifyLauncher.isSpotifyApplication(directory.appendingPathComponent("missing.app")), "A stale Launch Services URL is not an installed application")
        check(!NativeQuickSpotifyLauncher.isSpotifyApplication(try bundle("Other", id: "fixture.other", executable: true)), "A different bundle ID cannot be opened as Spotify")
        check(!NativeQuickSpotifyLauncher.isSpotifyApplication(try bundle("Incomplete", id: NativeQuickSpotifyAppleEvents.bundleID, executable: false)), "A bundle without an executable is not reported installed")
        check(NativeQuickSpotifyLauncher.isSpotifyApplication(try bundle("Valid", id: NativeQuickSpotifyAppleEvents.bundleID, executable: true)), "An exact bundle with a local executable passes installation discovery without execution")
        check(!NativeQuickSpotifyLauncher.isSpotifyApplication(URL(string: "https://example.invalid/Spotify.app")!), "Installation lookup cannot become a download or web opener")

        let absent = LaunchProbe(); absent.foundURL = nil
        let absentStore = absent.store()
        absentStore.launch(); absentStore.refresh()
        check(absent.lookups == 0 && absent.opened.isEmpty && absent.transport.asks.isEmpty, "Construction and hidden actions do not discover, launch or authorize")
        await show(absentStore)
        check(absentStore.snapshot.state == .notInstalled && absentStore.primaryActionTitle == "Check installation again", "Missing installation offers a recheck, not an install or dead Start button")
        absentStore.performPrimaryAction(); await waitUntil { !absentStore.busy }
        check(absent.opened.isEmpty && absent.transport.asks.isEmpty && absent.transport.sends.isEmpty, "Rechecking an absent install never opens, prompts or sends events")
        absentStore.setVisible(false)

        let invalid = LaunchProbe(); invalid.valid = false
        let invalidStore = invalid.store(); await show(invalidStore)
        check(invalidStore.snapshot.state == .notInstalled && invalid.opened.isEmpty, "A returned but invalid installation URL remains not-installed")
        invalidStore.setVisible(false)

        let normal = LaunchProbe()
        let store = normal.store(); await show(store)
        check(store.snapshot.state == .notRunning && store.primaryActionTitle == "Start Spotify" && normal.opened.isEmpty, "Passive discovery exposes explicit Start and never opens Spotify")
        store.performPrimaryAction(); store.performPrimaryAction(); store.refresh()
        check(store.busy && store.snapshot.state == .launching && !store.snapshot.canControl && normal.opened.count == 1,
              "One explicit Start opens once; duplicate clicks and refresh cannot invent playback")
        normal.transport.target = first
        let complete = normal.callbacks[0]
        DispatchQueue.global().async { complete(application(first)) }
        await waitUntil { !store.busy }
        check(store.snapshot.state == .stopped && store.primaryActionTitle == "Play Spotify", "A background launch callback becomes the actual stopped readback, never optimistic playing")
        check(normal.transport.asks.map { $0.1 } == [false] && normal.transport.sends.count == 1 && normal.transport.sends[0].0 == first,
              "Post-launch read is passive and pinned to the callback PID plus launch date")
        complete(application(first)); await settle()
        check(normal.transport.asks.count == 1 && normal.opened.count == 1, "Duplicate callback does not read or complete twice")
        store.setVisible(false)

        let unauthorized = LaunchProbe(), unauthorizedStore = unauthorized.store()
        await show(unauthorizedStore); unauthorizedStore.launch()
        unauthorized.transport.target = first; unauthorized.transport.permissionStatus = OSStatus(errAEEventWouldRequireUserConsent)
        unauthorized.callbacks[0](application(first)); await waitUntil { !unauthorizedStore.busy }
        check(unauthorizedStore.snapshot.state == .authorizationRequired && unauthorizedStore.primaryActionTitle == "Connect Spotify"
              && unauthorized.transport.asks.map { $0.1 } == [false] && unauthorized.transport.sends.isEmpty,
              "Launching an unauthorized app leaves a separate Connect action and never prompts")
        unauthorized.transport.permissionStatus = noErr
        unauthorizedStore.performPrimaryAction(); await waitUntil { !unauthorizedStore.busy }
        check(unauthorizedStore.snapshot.state == .stopped && unauthorized.transport.asks.map { $0.1 } == [false, true]
              && unauthorized.opened.count == 1, "Only explicit Connect requests consent, without another launch or playback command")
        unauthorizedStore.setVisible(false)

        for (raw, expected) in [("kPSp", NativeQuickSpotifyState.paused), ("kPSP", .playing)] {
            let probe = LaunchProbe(), value = probe.store(); await show(value); value.launch()
            probe.transport.target = first; probe.transport.playerState = raw
            probe.callbacks[0](application(first)); await waitUntil { !value.busy }
            check(value.snapshot.state == expected && value.snapshot.title == "Fixture track"
                  && probe.transport.sends.allSatisfy { $0.1 == .read }, "Actual \(raw) state and metadata survive launch without a play command")
            value.setVisible(false)
        }
        let denied = LaunchProbe(), deniedStore = denied.store(); await show(deniedStore); deniedStore.launch()
        denied.transport.target = first; denied.transport.permissionStatus = OSStatus(errAEEventNotPermitted)
        denied.callbacks[0](application(first)); await waitUntil { !deniedStore.busy }
        check(deniedStore.snapshot.state == .denied && denied.transport.sends.isEmpty, "Actual AE denial remains denial after successful opening")
        deniedStore.setVisible(false)

        let raced = LaunchProbe(), racedStore = raced.store(); await show(racedStore)
        raced.transport.target = first; racedStore.launch(); await waitUntil { !racedStore.busy }
        check(raced.opened.isEmpty && racedStore.snapshot.state == .stopped, "An app started elsewhere between render and click is read, never relaunched")
        racedStore.setVisible(false)
        let lookupRace = LaunchProbe(), lookupStore = lookupRace.store(); await show(lookupStore)
        lookupRace.lookupHook = { lookupRace.transport.target = first }
        lookupStore.launch(); await waitUntil { !lookupStore.busy }
        check(lookupRace.opened.isEmpty && lookupStore.snapshot.state == .stopped, "A process appearing during installation lookup is reused")
        lookupStore.setVisible(false)
        let uninstalled = LaunchProbe(), uninstalledStore = uninstalled.store(); await show(uninstalledStore)
        uninstalled.valid = false; uninstalledStore.launch(); await waitUntil { !uninstalledStore.busy }
        check(uninstalledStore.snapshot.state == .notInstalled && uninstalled.opened.isEmpty, "Uninstall between discovery and Start prevents the open call")
        uninstalledStore.setVisible(false)

        for mode in ["wrong-bundle", "terminated", "missing-date", "reused-pid", "failure"] {
            let probe = LaunchProbe(), value = probe.store(); await show(value); value.launch()
            probe.transport.target = mode == "reused-pid" ? replacement : first
            let result: NativeQuickSpotifyOpenResult
            switch mode {
            case "wrong-bundle": result = application(first, bundleID: "fixture.other")
            case "terminated": result = application(first, terminated: true)
            case "missing-date": result = .init(application: .init(bundleID: NativeQuickSpotifyAppleEvents.bundleID, pid: first.pid, launchedAt: nil, terminated: false))
            case "failure": result = failedOpen()
            default: result = application(first)
            }
            probe.callbacks[0](result); await waitUntil { !value.busy }
            let expected: NativeQuickSpotifyState = ["missing-date", "failure"].contains(mode) ? .launchTimedOut : .launchFailed
            check(value.snapshot.state == expected && !value.snapshot.canControl && probe.transport.asks.isEmpty && probe.transport.sends.isEmpty,
                  "\(mode) callback cannot trigger AppleEvents or fake a successful launch")
            value.setVisible(false)
        }

        let replaced = LaunchProbe(), replacedStore = replaced.store(); await show(replacedStore); replacedStore.launch()
        replaced.diagnosticHook = { events in if events.last?.reason == "process-confirmed" { replaced.transport.target = replacement } }
        replaced.transport.target = first; replaced.callbacks[0](application(first))
        // The callback is valid now, but the queued main-actor read must revalidate.
        await waitUntil { !replacedStore.busy }
        check(replacedStore.snapshot.state == .unavailable && replacedStore.controlError?.contains("restarted") == true
              && replaced.transport.asks.isEmpty, "PID reuse between launch completion and queued read is rejected before permission")
        replacedStore.refresh(); await waitUntil { !replacedStore.busy }
        check(replacedStore.snapshot.state == .stopped && replacedStore.controlError == nil && replaced.transport.asks.count == 1,
              "Explicit recheck accepts a new process and clears the old launch error")
        replacedStore.setVisible(false)

        let exitDuringRead = LaunchProbe(), exitStore = exitDuringRead.store(); await show(exitStore); exitStore.launch()
        exitDuringRead.transport.target = first; exitDuringRead.transport.replaceAfterStateRead = replacement
        exitDuringRead.callbacks[0](application(first)); await waitUntil { !exitStore.busy }
        check(exitStore.snapshot.state == .notRunning && !exitStore.snapshot.canControl,
              "Even stopped readback cannot publish control buttons after its launch identity exited")
        exitStore.setVisible(false)

        let hidden = LaunchProbe(), hiddenStore = hidden.store(); await show(hiddenStore); hiddenStore.launch()
        hiddenStore.setVisible(false); let hiddenSnapshot = hiddenStore.snapshot
        hidden.transport.target = first; let late = hidden.callbacks[0]
        DispatchQueue.global().async { late(application(first)) }
        await settle()
        check(!hiddenStore.busy && hiddenStore.snapshot == hiddenSnapshot && hidden.transport.asks.isEmpty && hidden.transport.sends.isEmpty,
              "Leaving the island or music source cancels observation; a background callback cannot read or repaint")
        await show(hiddenStore)
        check(hiddenStore.snapshot.state == .stopped && hidden.opened.count == 1 && hidden.transport.asks.count == 1,
              "Reentry performs fresh passive discovery without reopening or reviving the old request")
        hiddenStore.setVisible(false)

        let generation = LaunchProbe(), generationStore = generation.store(); await show(generationStore); generationStore.launch()
        generationStore.setVisible(false); await show(generationStore)
        generationStore.launch(); await waitUntil { !generationStore.busy }
        check(generation.opened.count == 1 && generationStore.controlError != nil, "An outstanding cancelled OS launch cannot accumulate another open request on reentry")
        let freshSnapshot = generationStore.snapshot
        generation.transport.target = first; generation.callbacks[0](application(first)); await settle()
        check(generationStore.snapshot == freshSnapshot && generation.transport.asks.isEmpty, "A prior generation callback cannot publish into the newly visible card")
        generationStore.refresh(); await waitUntil { !generationStore.busy }
        check(generationStore.snapshot.state == .stopped && generationStore.controlError == nil, "A user recheck after the OS finishes recovers from pending-launch feedback")
        generationStore.setVisible(false)

        let timeout = LaunchProbe(), timeoutStore = timeout.store(timeout: 0.03, polling: true); await show(timeoutStore)
        timeoutStore.launch(); await waitUntil { !timeoutStore.busy }
        check(timeoutStore.snapshot.state == .launchTimedOut && timeout.opened.count == 1 && timeout.transport.asks.isEmpty,
              "An unreturned OS callback has a bounded UI deadline without fabricated playback")
        try await Task.sleep(nanoseconds: 2_050_000_000)
        check(timeout.opened.count == 1 && timeout.lookups == 2 && timeoutStore.snapshot.state == .launchTimedOut,
              "Launch failure has no automatic timer recheck or blind launch retry")
        timeoutStore.performPrimaryAction(); await waitUntil { !timeoutStore.busy }
        check(timeoutStore.snapshot.state == .notRunning, "Explicit recheck after launch timeout can confirm the process is still absent")
        timeoutStore.performPrimaryAction(); await waitUntil { !timeoutStore.busy }
        check(timeout.opened.count == 1 && timeoutStore.controlError?.contains("system is still handling") == true,
              "Start after timeout and recheck explains the outstanding system request without queuing another launch")
        timeout.transport.target = first; timeout.callbacks[0](application(first)); await settle()
        check(timeoutStore.snapshot.state == .launchTimedOut && timeout.transport.asks.isEmpty, "Late OS completion after the deadline cannot read or mark success")
        timeoutStore.performPrimaryAction(); await waitUntil { !timeoutStore.busy }
        check(timeoutStore.snapshot.state == .stopped && timeout.opened.count == 1, "Explicit recheck discovers a late-started app without launching it again")
        timeoutStore.setVisible(false)

        let failed = LaunchProbe(), failedStore = failed.store(); await show(failedStore); failedStore.launch()
        let oldCallback = failed.callbacks[0]; oldCallback(failedOpen()); await waitUntil { !failedStore.busy }
        failedStore.performPrimaryAction(); await waitUntil { !failedStore.busy }; failedStore.performPrimaryAction()
        check(failed.opened.count == 2 && failedStore.snapshot.state == .launching, "A completed failure needs an explicit check and a new Start before retry")
        oldCallback(failedOpen()); await settle()
        check(failedStore.snapshot.state == .launching && failedStore.busy, "Duplicate callback from request one cannot settle or unlock request two")
        failed.transport.target = first; failed.callbacks[1](application(first)); await waitUntil { !failedStore.busy }
        check(failedStore.snapshot.state == .stopped && failed.transport.asks.count == 1, "Only the current launch identity owns completion and its one passive read")
        failedStore.setVisible(false)

        let warming = LaunchProbe(), warmingStore = warming.store()
        await show(warmingStore); warmingStore.launch()
        var metadataReady = false, inspected = 0, observedOnMain = true
        let warmingCallback = NativeQuickSpotifyOpenResult(application: .init(bundleID: nil, pid: first.pid,
            launchedAt: nil, terminated: false, observe: {
                inspected += 1; observedOnMain = observedOnMain && Thread.isMainThread
                return metadataReady ? .ready(first) : .pending("fixture-metadata-pending")
            }))
        let callback = warming.callbacks[0]
        DispatchQueue.global().async { callback(warmingCallback) }
        await settle()
        check(warmingStore.busy && warmingStore.snapshot.state == .launching && inspected > 1 && warming.transport.asks.isEmpty,
              "Transient callback metadata remains starting while one launch is observed, without AppleEvents")
        metadataReady = true; warming.transport.target = first; warming.transport.playerState = "kPSp"
        await waitUntil { !warmingStore.busy }
        check(observedOnMain && warmingStore.snapshot.state == .paused && warming.opened.count == 1 && warming.transport.asks.count == 1,
              "Background completion normalizes readiness on main and reaches actual paused state without another open")
        warmingStore.setVisible(false)

        let normalized = LaunchProbe(), normalizedStore = normalized.store(); await show(normalizedStore); normalizedStore.launch()
        normalized.transport.target = first
        normalized.callbacks[0](.init(application: .init(bundleID: NativeQuickSpotifyAppleEvents.bundleID, pid: first.pid,
            launchedAt: first.launchedAt.addingTimeInterval(0.000001), terminated: false, observe: { .ready(first) })))
        await waitUntil { !normalizedStore.busy }
        check(normalizedStore.snapshot.state == .stopped && normalized.transport.sends.first?.0 == first,
              "Trusted process-identity observation supplies canonical launch date instead of comparing stale callback snapshots")
        normalizedStore.setVisible(false)

        let registration = LaunchProbe(), registrationStore = registration.store(); await show(registrationStore); registrationStore.launch()
        registration.callbacks[0](application(first)); await settle()
        check(registrationStore.snapshot.state == .launching && registration.transport.asks.isEmpty,
              "A callback process not yet visible to passive discovery waits without prematurely failing")
        registration.transport.target = first; await waitUntil { !registrationStore.busy }
        check(registrationStore.snapshot.state == .stopped && registration.opened.count == 1,
              "Process registration can complete within the original open operation")
        registrationStore.setVisible(false)

        let missingApp = LaunchProbe(), missingAppStore = missingApp.store(); await show(missingAppStore); missingAppStore.launch()
        missingApp.callbacks[0](failedOpen()); await settle()
        check(missingAppStore.snapshot.state == .launching && missingApp.transport.asks.isEmpty,
              "A nil-app/error callback preserves its reason and waits for passive process evidence")
        let newlyStarted = NativeQuickSpotifyTarget(pid: 4343, launchedAt: Date())
        missingApp.transport.target = newlyStarted; missingApp.transport.permissionStatus = OSStatus(errAEEventWouldRequireUserConsent)
        await waitUntil { !missingAppStore.busy }
        check(missingAppStore.snapshot.state == .authorizationRequired && missingApp.opened.count == 1
              && missingApp.transport.asks.map { $0.1 } == [false],
              "Unknown callback PID can resolve only to verified Spotify from this launch window, then stays passive")
        check(missingApp.diagnosticEvents.contains { $0.reason == "workspace-error" && $0.errorCode == -600 && $0.errorDomain == "NSOSStatusErrorDomain" }
              && missingApp.diagnosticEvents.last?.reason == "process-confirmed",
              "OS failure code and eventual process confirmation remain in diagnostics without track data")
        missingAppStore.setVisible(false)

        for date in [Date(timeIntervalSince1970: 10), Date().addingTimeInterval(3600)] {
            let unattributed = LaunchProbe(), unattributedStore = unattributed.store(timeout: 0.07)
            await show(unattributedStore); unattributedStore.launch()
            unattributed.transport.target = .init(pid: 4343, launchedAt: date)
            unattributed.callbacks[0](failedOpen()); await waitUntil { !unattributedStore.busy }
            check(unattributedStore.snapshot.state == .launchTimedOut && unattributed.transport.asks.isEmpty
                  && unattributed.diagnosticEvents.contains { $0.reason == "unattributed-process" },
                  "Absent callback identity cannot adopt an old or future-dated unrelated Spotify process")
            unattributedStore.setVisible(false)
        }

        let leaveDuringReadiness = LaunchProbe(), leaveStore = leaveDuringReadiness.store()
        await show(leaveStore); leaveStore.launch(); var observations = 0, becameReady = false
        leaveDuringReadiness.callbacks[0](.init(application: .init(bundleID: NativeQuickSpotifyAppleEvents.bundleID,
            pid: first.pid, launchedAt: nil, terminated: false, observe: {
                observations += 1; return becameReady ? .ready(first) : .pending("fixture-date-pending")
            })))
        await waitUntil { observations > 1 }; leaveStore.setVisible(false)
        let observationsBeforeLeave = observations, beforeLeave = leaveStore.snapshot
        becameReady = true; leaveDuringReadiness.transport.target = first; await settle()
        check(observations == observationsBeforeLeave && leaveStore.snapshot == beforeLeave
              && leaveDuringReadiness.transport.asks.isEmpty && leaveDuringReadiness.opened.count == 1,
              "Leaving during readiness cancels further process observation and all subsequent AppleEvents")

        let readinessDeadline = LaunchProbe(), deadlineStore = readinessDeadline.store(timeout: 0.07)
        await show(deadlineStore); deadlineStore.launch()
        try await Task.sleep(nanoseconds: 40_000_000)
        readinessDeadline.callbacks[0](.init(application: .init(bundleID: NativeQuickSpotifyAppleEvents.bundleID,
            pid: first.pid, launchedAt: nil, terminated: false, observe: { .pending("fixture-never-ready") })))
        try await Task.sleep(nanoseconds: 50_000_000)
        check(deadlineStore.snapshot.state == .launchTimedOut && !deadlineStore.busy && readinessDeadline.transport.asks.isEmpty,
              "Readiness shares the original deadline rather than starting a new timeout at callback")
        deadlineStore.refresh(); await waitUntil { !deadlineStore.busy }; deadlineStore.launch()
        check(readinessDeadline.opened.count == 2, "Readiness timeout releases a completed OS request only for a new explicit Start")
        readinessDeadline.transport.target = first; readinessDeadline.callbacks[1](application(first)); await waitUntil { !deadlineStore.busy }
        check(deadlineStore.snapshot.state == .stopped && readinessDeadline.transport.asks.count == 1,
              "Expired readiness cannot settle the newer launch generation")
        deadlineStore.setVisible(false)

        check(NSApp == nil, "Fixtures never create an application, launch Spotify, request permission, read a music library or send a real AppleEvent")
        print("RESULT: \(checks - failures)/\(checks) Spotify launch checks passed")
        if failures > 0 { exit(1) }
    }
}
