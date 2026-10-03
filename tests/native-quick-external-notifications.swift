import Foundation

@main struct ExternalNotificationTests {
    @MainActor static func main() async throws {
        var count = 0
        func check(_ value: Bool, _ label: String) {
            precondition(value, label); count += 1
        }
        let record: [String: Any] = ["id": "external_" + String(repeating: "a", count: 32),
            "source": "codex", "title": "Fictional report ready", "detail": "Two notes updated",
            "project": "Demo", "occurredAt": 1790950000000.0, "outcome": "completed", "delivery": "pending"]
        func encode(_ body: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: body) }
        let parsed = try JSONDecoder().decode(NativeQuickExternalNotificationRecord.self, from: encode(record))
        check(parsed.event(ownerID: "fixture")?.destination == .external(record["id"] as! String), "external destination only")
        var bad = record; bad["source"] = "task"
        check(try JSONDecoder().decode(NativeQuickExternalNotificationRecord.self, from: encode(bad)).event(ownerID: "fixture") == nil, "reject internal source")
        bad = record; bad["id"] = "task_123"
        check(try JSONDecoder().decode(NativeQuickExternalNotificationRecord.self, from: encode(bad)).event(ownerID: "fixture") == nil, "reject foreign identity")
        let queue = NativeQuickNotificationQueue(ownerID: "fixture", schedulesTimers: false)
        var serverEnabled = false, serverAvailable = false, serverRevision = -1
        var generation = "g0", pending = [record], historyRows = [record]
        var calls: [String] = [], acknowledgements = 0, clears = 0
        var pollGate: CheckedContinuation<Void, Never>?
        var blockPoll = false, pollEntered = false
        var blockEnable = false, enableEntered = false
        var enableGate: CheckedContinuation<Void, Never>?
        let store = NativeQuickExternalNotificationStore(ownerID: "fixture", queue: queue,
            endpointFile: URL(fileURLWithPath: "/tmp/fictional endpoint/endpoint.json"),
            hookFile: URL(fileURLWithPath: "/tmp/fictional ' app/hook.cjs"), schedulesTimers: false) { path, body in
                calls.append(path)
                @MainActor func status() throws -> Data { try encode(["enabled": serverEnabled, "available": serverAvailable,
                    "generation": generation, "revision": serverRevision]) }
                switch path {
                case "status": return try status()
                case "config":
                    let nextRevision = body!["revision"] as! Int
                    precondition(nextRevision > serverRevision)
                    serverRevision = nextRevision
                    serverEnabled = body!["enabled"] as! Bool
                    serverAvailable = serverEnabled && (body!["available"] as! Bool)
                    generation = "g" + String(serverRevision)
                    let result = try status()
                    if blockEnable && serverAvailable {
                        enableEntered = true; await withCheckedContinuation { enableGate = $0 }
                    }
                    return result
                case "poll":
                    let capturedGeneration = generation, capturedRows = pending
                    if blockPoll { pollEntered = true; await withCheckedContinuation { pollGate = $0 } }
                    return try encode(["generation": capturedGeneration, "events": capturedRows])
                case "ack":
                    precondition(body!["generation"] as! String == generation)
                    acknowledgements += 1; pending = []
                    return try encode(["ok": true])
                case "history": return try encode(["generation": generation, "events": historyRows])
                case "clear": clears += 1; pending = []; historyRows = []; return try encode(["ok": true])
                default: fatalError("unknown request")
                }
            }
        store.updateContext(ready: true, available: true); await store.settle()
        check(store.loaded && !store.enabled && !store.receiving, "default off restored")
        check(!calls.contains("poll"), "no polling disabled")
        check(store.hookCommand(source: "codex") == nil, "no disabled hook")
        store.setEnabled(true); await store.settle()
        check(store.enabled && store.receiving && !store.changing, "explicit enable")
        check(queue.current?.events.first?.title == "Fictional report ready", "real queue enqueued")
        check(acknowledgements == 1, "ack accepted delivery once")
        check(store.history.count == 1, "persistent recent list projected")
        check(store.hookCommand(source: "codex")!.contains("'\\''"), "safe apostrophe quoting")
        check(store.hookCommand(source: "codex")!.contains("--endpoint '/tmp/fictional endpoint/endpoint.json'"), "spaces quoted")
        check(store.hookCommand(source: "task") == nil, "source allowlist")
        pending = [record]; store.refresh(); await store.settle()
        check(acknowledgements == 2 && queue.history.count == 1, "duplicate receipt no duplicate toast")
        // A response already in flight must not repopulate a private workspace.
        pending = [record]; blockPoll = true; store.refresh()
        while !pollEntered { await Task.yield() }
        store.updateContext(ready: true, available: false)
        check(!store.receiving && store.history.isEmpty && queue.current == nil, "privacy revokes synchronously")
        blockPoll = false; pollGate?.resume(); pollGate = nil; await store.settle()
        check(acknowledgements == 2 && queue.history.isEmpty, "late poll is not enqueued or acknowledged")
        check(!serverAvailable && store.enabled, "pause preserves preference")
        // The backend contract discards paused pending records, rather than replaying them.
        pending = []; store.updateContext(ready: true, available: true); await store.settle()
        check(store.receiving && queue.current == nil, "resume no stale toast")
        store.updateContext(ready: false, available: false); await store.settle()
        check(!serverAvailable && !store.receiving, "ready withdrawal revokes backend")
        store.updateContext(ready: true, available: true); await store.settle()
        check(store.receiving, "ready restoration reconnects")
        store.clearHistory(); await store.settle()
        check(clears == 1 && store.history.isEmpty, "clear persisted history")
        store.setEnabled(false); await store.settle()
        check(!serverEnabled && !store.receiving && store.hookCommand(source: "codex") == nil, "disable revokes hook")
        blockEnable = true; store.setEnabled(true)
        while !enableEntered { await Task.yield() }
        store.updateContext(ready: false, available: false)
        blockEnable = false; enableGate?.resume(); enableGate = nil; await store.settle()
        check(!serverAvailable && !store.receiving && queue.current == nil, "late enable must be revoked after ready withdrawal")
        store.shutdown(); store.updateContext(ready: true, available: true); await store.settle()
        check(!store.receiving, "shutdown cannot resurrect")
        let unavailableStore = NativeQuickExternalNotificationStore(ownerID: "fixture", queue: queue,
            endpointFile: URL(fileURLWithPath: "/tmp/endpoint.json"), hookFile: URL(fileURLWithPath: "/tmp/hook.cjs"),
            schedulesTimers: false) { _, _ in throw NativeQuickExternalNotificationError.restartRequired }
        unavailableStore.updateContext(ready: true, available: true); await unavailableStore.settle()
        check(unavailableStore.needsRestart && unavailableStore.issue && !unavailableStore.receiving, "uncertain storage fails closed with restart guidance")
        unavailableStore.shutdown()
        print("Native external notifications: \(count) assertions passed")
    }
}
