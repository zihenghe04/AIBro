import AppKit
import Foundation

func nativeUI(_ zh: String, _ en: String) -> String { en }
enum InjectedFailure: Error { case failed }
actor PendingScans {
    private var count = 0
    private var pending: [Int: CheckedContinuation<NativeQuickWindowSnapshot, Error>] = [:]
    func scan() async throws -> NativeQuickWindowSnapshot {
        count += 1; let id = count
        return try await withCheckedThrowingContinuation { pending[id] = $0 }
    }
    func calls() -> Int { count }
    func finish(_ id: Int, _ snapshot: NativeQuickWindowSnapshot) { pending.removeValue(forKey: id)?.resume(returning: snapshot) }
    func fail(_ id: Int) { pending.removeValue(forKey: id)?.resume(throwing: InjectedFailure.failed) }
}
final class WorkerProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var observations: [(String, Bool)] = []
    private var allowed = true
    func record(_ name: String) { lock.lock(); defer { lock.unlock() }; observations.append((name, Thread.isMainThread)) }
    func permission() -> Bool { lock.lock(); defer { lock.unlock() }; return allowed }
    func revoke() { lock.lock(); allowed = false; lock.unlock() }
    func readings() -> [(String, Bool)] { lock.lock(); defer { lock.unlock() }; return observations }
}
@MainActor final class ObserverProbe {
    var callback: (@MainActor () -> Void)?
    var installed = 0, removed = 0
    func observe(_ callback: @escaping @MainActor () -> Void) -> () -> Void {
        installed += 1; self.callback = callback
        return { [weak self] in self?.removed += 1; self?.callback = nil }
    }
}
@main struct WindowActivityChecks {
    @MainActor static var assertions = 0
    @MainActor static func check(_ pass: @autoclosure () -> Bool, _ message: String) {
        precondition(pass(), message); assertions += 1; print("PASS \(assertions): \(message)")
    }
    static func snapshot(_ name: String, titles: Bool = true, multi: Bool = false) -> NativeQuickWindowSnapshot {
        .init(rows: (multi ? [1, 2] : [1]).map {
            .init(id: "44:\($0)", pid: 44, title: titles ? name + "-\($0)" : "", appName: "Synthetic App", applicationIdentity: "synthetic-session", icon: nil)
        }, canReadTitles: titles)
    }
    static func calls(_ expected: Int, _ gate: PendingScans) async {
        for _ in 0..<1000 {
            if await gate.calls() == expected { return }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        preconditionFailure("Timed out waiting for \(expected) scans")
    }
    @MainActor static func until(_ condition: () -> Bool) async {
        for _ in 0..<1000 {
            if condition() { return }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        preconditionFailure("Timed out waiting for state")
    }
    @MainActor static func main() async throws {
        let probe = WorkerProbe()
        let scanner = NativeQuickWindowScanner(readWindows: {
            probe.record("CG read")
            return [.init(number: 1, pid: 44, title: "Synthetic A"), .init(number: 2, pid: 44, title: "Synthetic B")]
        }, readApplication: { _ in
            probe.record("metadata and icon")
            return .init(identity: "synthetic-session", name: "Synthetic App", icon: nil)
        }, permission: { probe.permission() })
        let scanned = try await scanner.scan()
        check(scanned.rows.count == 2 && scanned.rows.map(\.title) == ["Synthetic A", "Synthetic B"], "worker preserves distinct titled windows")
        check(probe.readings().allSatisfy { !$0.1 }, "actual scanner executor calls window and icon providers off the main thread")
        check(probe.readings().filter { $0.0 == "metadata and icon" }.count == 1, "one application/icon lookup for multiple windows in a scan")
        let revoked = NativeQuickWindowScanner(readWindows: { [.init(number: 1, pid: 44, title: "Synthetic private"), .init(number: 2, pid: 44, title: "Synthetic second")] }, readApplication: { _ in
            probe.revoke(); return .init(identity: "fixture", name: "Synthetic App", icon: nil)
        }, permission: { probe.permission() })
        let scrubbed = try await revoked.scan()
        check(!scrubbed.canReadTitles && scrubbed.rows.count == 1 && scrubbed.rows[0].title.isEmpty, "permission lost during worker read scrubs and deduplicates before return")

        let slowProbe = WorkerProbe(), release = DispatchSemaphore(value: 0)
        let slow = NativeQuickWindowScanner(readWindows: {
            slowProbe.record("slow read entered")
            guard release.wait(timeout: .now() + 2) == .success else { throw InjectedFailure.failed }
            return []
        }, readApplication: { _ in nil }, permission: { false })
        let slowRequest = Task { try await slow.scan() }
        await until { !slowProbe.readings().isEmpty }
        var heartbeat = false
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            DispatchQueue.main.async {
                heartbeat = true
                release.signal()
                continuation.resume()
            }
        }
        _ = try await slowRequest.value
        check(heartbeat && slowProbe.readings().allSatisfy { !$0.1 }, "main queue executes and releases a deliberately blocked background scan")

        let gate = PendingScans(), observer = ObserverProbe()
        var permission = true
        let store = NativeQuickWindowsStore(scan: { try await gate.scan() }, permission: { permission }, observe: observer.observe)
        var presentation = NativeQuickPresentation()
        let opening = presentation.request(expanded: true, reducedMotion: false)!
        store.setAvailable(true); store.setVisible(presentation.contentVisible); store.setActivity(presentation.phase == .expanded)
        check(store.state == .waiting && observer.installed == 0, "opening starts without scan or observer")
        _ = presentation.revealContent(opening); store.setVisible(presentation.contentVisible)
        check(store.state == .waiting && observer.installed == 0, "110ms content visibility does not start expensive work")
        let earlyCount = await gate.calls(); check(earlyCount == 0, "no automatic read before settled phase")
        _ = presentation.settle(opening); store.setActivity(presentation.phase == .expanded)
        await calls(1, gate)
        check(store.isRefreshing && observer.installed == 1, "settled phase starts exactly one background scan and observer")
        observer.callback?(); observer.callback?(); observer.callback?()
        let coalesced = await gate.calls(); check(coalesced == 1, "activation events coalesce while scan is suspended")
        await gate.finish(1, snapshot("First", multi: true)); await calls(2, gate)
        await gate.finish(2, snapshot("Latest", multi: true)); await until { store.state == .ready }
        check(store.items.count == 2 && store.items[0].title == "Latest-1", "one follow-up scan publishes latest snapshot")
        store.hide(id: "44:1")
        check(store.hiddenIDs == ["44:1"], "titled hide targets one window")
        store.setVisible(false); store.setActivity(false)
        check(observer.removed == 1 && observer.callback == nil, "collapse removes observation immediately")
        check(store.items.count == 1 && store.items[0].id == "44:2" && store.items[0].title.isEmpty, "collapse retains one safe app snapshot, preferring nonhidden representative")
        check(store.hiddenIDs.isEmpty && store.hiddenCount == 1, "hidden titled window does not hide the whole app fallback")
        store.setVisible(true); store.setActivity(true); await calls(3, gate)
        check(store.items.count == 1 && store.isRefreshing, "reopen preserves visual app snapshot during refresh")
        store.setVisible(false); store.setActivity(false)
        store.setVisible(true); store.setActivity(true); await calls(4, gate)
        await gate.finish(4, snapshot("Reversed", multi: true)); await until { store.state == .ready }
        await gate.finish(3, snapshot("Late old")); try? await Task.sleep(nanoseconds: 10_000_000)
        check(store.items[0].title == "Reversed-1" && store.hiddenIDs == ["44:1"], "rapid reverse rejects old result and retains precise hidden window")
        check(observer.installed == 3 && observer.removed == 2, "rapid reverse leaves one current observer")
        store.refresh(); await calls(5, gate); permission = false
        await gate.finish(5, snapshot("Revoked", multi: true)); await until { store.state == .ready }
        check(store.items.count == 1 && store.items[0].title.isEmpty && store.needsWindowTitles, "permission lost before UI commit removes all titles and duplicate apps")
        check(store.hiddenIDs.isEmpty, "fallback representative ID cannot inherit an unrelated window hide")
        store.hide(id: store.items[0].id)
        check(store.hiddenIDs.count == 1, "explicit fallback hide targets the app")
        permission = true; store.refresh(); await calls(6, gate)
        await gate.finish(6, snapshot("Granted", multi: true)); await until { store.state == .ready }
        check(store.hiddenIDs.count == 2, "explicit fallback app hide applies after titled windows return")
        store.showAll(); check(store.hiddenCount == 0 && store.hiddenIDs.isEmpty, "restore clears both scopes")
        store.refresh(); await calls(7, gate); await gate.fail(7); await until { store.state == .failed }
        check(store.items.count == 2 && store.error != nil && !store.isRefreshing, "failed refresh retains real snapshot and exposes retry state")
        store.refresh(); await calls(8, gate); store.setAvailable(false)
        check(store.items.isEmpty && store.error == nil && store.state == .unavailable && observer.callback == nil, "private/unavailable clears cached titles, items, error and observer")
        await gate.fail(8); try? await Task.sleep(nanoseconds: 10_000_000)
        check(store.items.isEmpty && store.error == nil && store.state == .unavailable, "late failure cannot repopulate private state")
        store.setAvailable(true); await calls(9, gate)
        store.shutdown(); await gate.finish(9, snapshot("After quit")); try? await Task.sleep(nanoseconds: 10_000_000)
        check(store.items.isEmpty && !store.available && observer.installed == observer.removed, "shutdown removes final observer and rejects late snapshot")

        let manualGate = PendingScans(), manualObserver = ObserverProbe()
        let manual = NativeQuickWindowsStore(scan: { try await manualGate.scan() }, permission: { true }, observe: manualObserver.observe)
        manual.setAvailable(true); manual.setVisible(true); manual.refresh(); await calls(1, manualGate)
        check(manual.isRefreshing && manualObserver.installed == 0, "explicit early refresh really executes without enabling automatic observation")
        await manualGate.finish(1, .init(rows: [], canReadTitles: true)); await until { manual.state == .ready }
        check(manual.items.isEmpty && manual.error == nil, "completed empty result differs from first-load waiting")
        manual.setActivity(true); await calls(2, manualGate)
        manual.setVisible(false); manual.setActivity(false); await manualGate.finish(2, snapshot("Wrong page"))
        try? await Task.sleep(nanoseconds: 10_000_000)
        check(manual.items.isEmpty && manualObserver.callback == nil, "leaving module before result preserves empty prior state")
        manual.shutdown()
        var reduced = NativeQuickPresentation(); _ = reduced.request(expanded: true, reducedMotion: true)
        check(reduced.contentVisible && reduced.phase == .expanded, "reduce motion has no artificial activity delay")
        print("\(assertions) window activity assertions passed; synthetic providers only, no system enumeration or GUI")
    }
}
