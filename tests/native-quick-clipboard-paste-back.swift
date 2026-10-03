import AppKit
import Combine
func nativeUI(_ zh: String, _ en: String) -> String { en }

@MainActor final class PasteEnvironment: NativeQuickClipboardPasteEnvironment {
    let ownPID: pid_t = 100
    let original = NativeQuickClipboardPasteTarget(pid: 200, bundleID: "test.editor", bundlePath: "/Synthetic/Editor.app", launchedAt: Date(timeIntervalSince1970: 42), name: "Fixture Editor")
    let own = NativeQuickClipboardPasteTarget(pid: 100, bundleID: "test.bro", bundlePath: "/Synthetic/Bro.app", launchedAt: Date(timeIntervalSince1970: 41), name: "Fixture Bro")
    let third = NativeQuickClipboardPasteTarget(pid: 300, bundleID: "test.third", bundlePath: "/Synthetic/Third.app", launchedAt: Date(timeIntervalSince1970: 40), name: "Fixture Third")
    var trusted = true, running = true, hasFocus = true, sameFocus = true, activates = true, followsActivation = true, postSucceeds = true
    var current: NativeQuickClipboardPasteTarget?
    var captures = 0, activations = 0, waits = 0, observerStops = 0
    var posted: [NativeQuickClipboardPasteTarget] = []
    var changed: ((pid_t) -> Void)?
    var onWait: (() -> Void)?, onFocusMatch: (() -> Void)?
    init() { current = original }
    func frontmost() -> NativeQuickClipboardPasteTarget? { current }
    func isRunning(_ target: NativeQuickClipboardPasteTarget) -> Bool { running && target.isSameProcess(as: original) }
    func captureFocus(_ target: NativeQuickClipboardPasteTarget) async -> AnyObject? { captures += 1; return hasFocus ? NSObject() : nil }
    func focusMatches(_ focus: AnyObject, target: NativeQuickClipboardPasteTarget) -> Bool { onFocusMatch?(); return sameFocus }
    func activate(_ target: NativeQuickClipboardPasteTarget) -> Bool {
        activations += 1
        if activates && followsActivation { current = target; changed?(target.pid) }
        return activates
    }
    func sendPaste(_ target: NativeQuickClipboardPasteTarget) -> Bool { if postSucceeds { posted.append(target) }; return postSucceeds }
    func observeActivation(_ changed: @escaping (pid_t) -> Void) -> () -> Void {
        self.changed = changed
        return { [weak self] in self?.observerStops += 1; self?.changed = nil }
    }
    func waitForActivation() async throws { waits += 1; onWait?(); await Task.yield() }
    func switchToThird(andBack: Bool = false) { current = third; changed?(third.pid); if andBack { current = original; changed?(original.pid) } }
}
@MainActor final class PasteHost {
    let environment: PasteEnvironment, paste: NativeQuickClipboardPasteBack
    var shown = true, collapseSucceeds = true, copied = 0, collapses = 0, count = 10
    var afterCopy: (() -> Void)?, onCollapse: (() async -> Void)?
    var feedback: [String] = []
    init(_ configure: (PasteEnvironment) -> Void = { _ in }) async {
        let environment = PasteEnvironment(); configure(environment); self.environment = environment
        paste = NativeQuickClipboardPasteBack(environment: environment)
        paste.setAvailable(true); paste.beginSession()
        // This legacy fixture exercises an already-captured opening. New tests
        // separately hold the actual worker and cover activation before reply.
        if environment.trusted, environment.current?.pid == environment.original.pid {
            for _ in 0..<100 where environment.captures == 0 { await Task.yield() }
            await Task.yield()
        }
        environment.current = environment.own
        paste.configure(isPresented: { [weak self] in self?.shown == true }, collapse: { [weak self] in
            guard let self else { return false }; collapses += 1; shown = false; paste.endSession()
            await onCollapse?(); return collapseSucceeds
        })
        paste.onFeedback = { [weak self] in self?.feedback.append($0) }
    }
    func run() async -> String? {
        await paste.perform(copy: { canCommit in
            guard canCommit() else { return nil }; copied += 1; afterCopy?(); return 10
        }, isCopyCurrent: { $0 == count })
    }
}
@MainActor final class PasteBoard: NativeQuickClipboardPasteboard {
    var changeCount = 80, writes = 0, reads = 0
    var types: [String] { [] }
    func data(forType type: String) -> Data? { reads += 1; return nil }
    func write(_ payload: NativeQuickClipboardPayload) -> Bool { writes += 1; changeCount += 1; return true }
}
@MainActor final class PasteReader {
    var gate: CheckedContinuation<NativeQuickClipboardPayload, Error>?
    func read() async throws -> NativeQuickClipboardPayload { try await withCheckedThrowingContinuation { gate = $0 } }
    func finish() { let current = gate; gate = nil; current?.resume(returning: .init(kind: .text, data: Data("Synthetic history".utf8))) }
}
@main struct PasteBackChecks {
    @MainActor static func main() async throws {
        var checks = 0
        func check(_ ok: Bool, _ label: String) { precondition(ok, label); checks += 1; print("PASS \(checks): \(label)") }
        func wait(_ done: () -> Bool) async { for _ in 0..<500 { if done() { return }; try? await Task.sleep(nanoseconds: 2_000_000) }; precondition(done(), "Timeout") }
        do {
            let h = await PasteHost(); let result = await h.run()
            check(h.copied == 1 && h.collapses == 1 && h.environment.posted == [h.environment.original], "Explicit action copies, closes and posts only to original process")
            check(result?.contains("Paste sent") == true && h.feedback.count == 1, "Delivery is described as sent, not inserted")
            check(h.paste.targetName == nil && h.environment.changed == nil && !h.paste.busy, "Completed session releases app/focus observation")
        }
        do {
            let h = await PasteHost { $0.trusted = false }; let result = await h.run()
            check(h.copied == 1 && h.collapses == 0 && h.environment.captures == 0 && h.environment.activations == 0, "Without permission only copies; no AX read, activation, collapse or prompt")
            check(result?.contains("permission") == true, "Permission fallback is explicit")
            h.paste.shutdown()
        }
        do {
            let h = await PasteHost { $0.current = $0.own }; let result = await h.run()
            check(h.copied == 1 && h.collapses == 0 && result?.contains("No previous app") == true, "Opening from AI Bro has no guessed external destination")
        }
        do {
            let h = await PasteHost(); h.environment.running = false; let result = await h.run()
            check(h.copied == 1 && h.collapses == 0 && result?.contains("quit") == true, "Exited target remains copy-only")
        }
        do {
            let h = await PasteHost { $0.hasFocus = false }; let result = await h.run()
            check(h.copied == 1 && h.collapses == 0 && result?.contains("input target") == true, "Unreadable original focus never guesses another field")
        }
        do {
            let h = await PasteHost(); h.environment.sameFocus = false; let result = await h.run()
            check(h.environment.posted.isEmpty && result?.contains("Input focus changed") == true, "A different field in the original app cannot receive paste")
        }
        do {
            let h = await PasteHost(); h.environment.activates = false; let result = await h.run()
            check(h.environment.posted.isEmpty && result?.contains("activate") == true && h.feedback.count == 1, "Failed activation reports copy-only after collapse")
        }
        do {
            let h = await PasteHost(); h.environment.followsActivation = false; let result = await h.run()
            check(h.environment.waits == 20 && h.environment.posted.isEmpty && result?.contains("gain focus") == true, "Activation polling is bounded at twenty waits")
        }
        do {
            let h = await PasteHost(); h.collapseSucceeds = false; let result = await h.run()
            check(h.environment.activations == 0 && result?.contains("finish closing") == true, "No activation before a real collapse acknowledgement")
            check(h.feedback.isEmpty, "Unacknowledged close reports in-page rather than an external feedback toast")
        }
        do {
            let h = await PasteHost(); h.onCollapse = { h.count += 1 }; let result = await h.run()
            check(h.environment.posted.isEmpty && result?.contains("Clipboard changed") == true, "A newer clipboard while closing is preserved")
        }
        do {
            let h = await PasteHost(); h.environment.followsActivation = false
            h.environment.onWait = { h.environment.switchToThird(andBack: true) }
            _ = await h.run()
            check(h.environment.posted.isEmpty && h.environment.waits == 1, "Switching to a third app and back cannot revive an old lease")
            check(h.feedback.count == 1 && h.feedback[0].contains("target app changed"), "A focus switch after closing has explicit, content-free feedback")
        }
        do {
            let h = await PasteHost(); h.onCollapse = { h.paste.setAvailable(false) }; _ = await h.run()
            check(h.environment.posted.isEmpty && h.paste.targetName == nil && h.feedback.isEmpty, "Private/revoked state suppresses callbacks and clears app label")
        }
        do {
            let h = await PasteHost(); h.onCollapse = { h.environment.current = h.environment.third; h.paste.beginSession(); h.shown = true }; _ = await h.run()
            check(h.environment.posted.isEmpty && h.paste.targetName == h.environment.third.name, "New opening survives without an old request clearing its target")
            h.paste.shutdown()
        }
        do {
            let h = await PasteHost(); h.environment.onFocusMatch = { h.count += 1 }; _ = await h.run()
            check(h.environment.posted.isEmpty, "Clipboard ownership is rechecked after the AX focus reply")
        }
        do {
            let h = await PasteHost(); h.environment.onFocusMatch = { h.environment.switchToThird() }; _ = await h.run()
            check(h.environment.posted.isEmpty, "Focus switch during the final focus query cannot receive an event")
        }
        do {
            let h = await PasteHost(); h.environment.onFocusMatch = { h.paste.setAvailable(false) }; let result = await h.run()
            check(h.environment.posted.isEmpty && h.feedback.isEmpty && result == nil, "Revocation during final focus validation cannot leak a delayed error")
        }
        do {
            let h = await PasteHost(); h.environment.followsActivation = false
            h.environment.onWait = { h.environment.trusted = false }; _ = await h.run()
            check(h.environment.posted.isEmpty, "Permission revoked during activation is honored")
        }
        do {
            let t = PasteEnvironment().original
            let reused = NativeQuickClipboardPasteTarget(pid: t.pid, bundleID: t.bundleID, bundlePath: t.bundlePath, launchedAt: t.launchedAt.addingTimeInterval(1), name: t.name)
            check(!t.isSameProcess(as: reused), "PID reuse is rejected by launch identity")
        }
        // The actual Store/Archive integration, with synthetic history and an
        // injected pasteboard. Neither general pasteboard nor OS AX is touched.
        let dir = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("history")
        let archive = NativeQuickClipboardArchive(directory: dir)
        _ = try await archive.setMode(.recording)
        _ = try await archive.capture(.init(kind: .text, data: Data("Synthetic history".utf8)), gate: .init())
        _ = try await archive.setMode(.off)
        let board = PasteBoard(), reader = PasteReader()
        let store = NativeQuickClipboardStore(directory: dir, pasteboard: board, schedulesPolling: false, payloadRead: { _ in try await reader.read() })
        store.setAvailable(true); store.setVisible(true); await wait { store.loaded && !store.items.isEmpty }
        let item = store.items[0]
        do {
            let h = await PasteHost()
            let task = Task { await h.paste.perform(copy: { await store.copy(item, canCommit: $0) }, isCopyCurrent: { store.isCopyCurrent($0) }) }
            await wait { reader.gate != nil }; h.paste.endSession(); h.shown = false; reader.finish(); _ = await task.value
            check(board.writes == 0 && h.environment.posted.isEmpty, "Closing while archive loads prevents even the late clipboard write")
        }
        do {
            let h = await PasteHost()
            let task = Task { await h.paste.perform(copy: { await store.copy(item, canCommit: $0) }, isCopyCurrent: { store.isCopyCurrent($0) }) }
            await wait { reader.gate != nil }; board.changeCount += 1; reader.finish(); _ = await task.value
            check(board.writes == 0 && h.environment.posted.isEmpty && store.notice?.contains("changed") == true, "Store's existing clipboard-change lease applies to paste-back reads")
        }
        do {
            let h = await PasteHost()
            let task = Task { await h.paste.perform(copy: { await store.copy(item, canCommit: $0) }, isCopyCurrent: { store.isCopyCurrent($0) }) }
            await wait { reader.gate != nil }; reader.finish(); _ = await task.value
            check(board.writes == 1 && h.environment.posted.count == 1 && store.isCopyCurrent(board.changeCount), "Production copy receipt connects to destination delivery")
            store.setAvailable(false); store.setAvailable(true)
            check(!store.isCopyCurrent(board.changeCount), "Private unlock never revives a prior copy receipt")
        }
        check(board.reads == 0 && store.mode == .off, "No system clipboard read or history capture enable occurs")
        store.shutdown()
        print("PASS: \(checks) new paste-back checks; actual external editor insertion remains a native acceptance gate")
    }
}
