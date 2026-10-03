import Foundation
import Combine

/// The receiver is local to this installation, outside synchronized knowledge.
/// Its native control credential never enters a WebKit script or a hook command.
enum NativeQuickExternalNotificationLocation {
    static var directory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support", isDirectory: true)
            .appendingPathComponent(Bundle.main.bundleIdentifier ?? "app.ai-workstation.studio", isDirectory: true)
            .appendingPathComponent("QuickTools/ExternalNotifications", isDirectory: true)
    }
}

struct NativeQuickExternalNotificationRecord: Decodable, Identifiable, Equatable {
    let id: String
    let source: String
    let title: String
    let detail: String
    let project: String
    let occurredAt: Double
    let outcome: String
    let delivery: String?

    func event(ownerID: String) -> NativeQuickNotificationEvent? {
        let nativeSource: NativeQuickNotificationEvent.Source
        switch source {
        case "codex": nativeSource = .externalCodex
        case "claude": nativeSource = .externalClaude
        case "gpt": nativeSource = .externalGPT
        default: return nil
        }
        guard id.range(of: "^external_[0-9a-f]{32}$", options: .regularExpression) != nil,
              occurredAt.isFinite, occurredAt > 0,
              ["completed", "failed"].contains(outcome) else { return nil }
        return NativeQuickNotificationEvent(id: id, ownerID: ownerID, source: nativeSource,
            title: title, detail: [project, detail].filter { !$0.isEmpty }.joined(separator: " · "),
            occurredAt: Date(timeIntervalSince1970: occurredAt / 1000),
            outcome: outcome == "failed" ? .failed : .completed, destination: .external(id))
    }
}

private struct NativeQuickExternalNotificationStatus: Decodable {
    let enabled: Bool
    let available: Bool
    let generation: String
    let revision: Int
    let error: String?
}
private struct NativeQuickExternalNotificationBatch: Decodable {
    let generation: String
    let events: [NativeQuickExternalNotificationRecord]
}

enum NativeQuickExternalNotificationError: Error { case unavailable, invalidResponse, restartRequired }

private final class NativeQuickNotificationNoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

final class NativeQuickExternalNotificationTransport {
    private let session: URLSession
    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 3
        configuration.timeoutIntervalForResource = 4
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        session = URLSession(configuration: configuration, delegate: NativeQuickNotificationNoRedirect(), delegateQueue: nil)
    }
    deinit { session.invalidateAndCancel() }
    func request(origin: URL?, token: String, path: String, body: [String: Any]?) async throws -> Data {
        guard let origin, origin.scheme == "http", origin.host == "127.0.0.1",
              let port = origin.port, (1...65535).contains(port), token.count >= 32,
              ["status", "config", "poll", "history", "ack", "clear"].contains(path),
              let url = URL(string: "/__external-notifications/" + path, relativeTo: origin)?.absoluteURL else {
            throw NativeQuickExternalNotificationError.unavailable
        }
        var request = URLRequest(url: url)
        request.setValue(token, forHTTPHeaderField: "X-AIBro-Native-Token")
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse, data.count <= 512 * 1024 else {
            throw NativeQuickExternalNotificationError.invalidResponse
        }
        if let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           payload["error"] as? String == "notification_commit_uncertain" {
            throw NativeQuickExternalNotificationError.restartRequired
        }
        guard response.statusCode == 200 else { throw NativeQuickExternalNotificationError.invalidResponse }
        return data
    }
}

/// One serialized control/poll lane. A local epoch invalidates every awaited
/// response when availability changes, before the server's revoke round-trip.
@MainActor final class NativeQuickExternalNotificationStore: ObservableObject {
    typealias Request = @MainActor (String, [String: Any]?) async throws -> Data
    @Published private(set) var enabled = false
    @Published private(set) var loaded = false
    @Published private(set) var receiving = false
    @Published private(set) var changing = false
    @Published private(set) var history: [NativeQuickNotificationEvent] = []
    @Published private(set) var issue = false
    @Published private(set) var needsRestart = false
    private(set) var ready = false
    private(set) var available = false
    let endpointFile: URL
    let hookFile: URL
    let ownerID: String
    var onEventsInvalidated: (() -> Void)?
    private let queue: NativeQuickNotificationQueue
    private let request: Request
    private let schedulesTimers: Bool
    private var timer: Timer?
    private var work: Task<Void, Never>?
    private var stopped = false
    private var epoch: UInt64 = 0
    private var revision = -1
    private var backendGeneration = ""
    private var configurationDirty = true
    private var requestedEnabled: Bool?
    private var clearRequested = false
    private var repeatRequested = false

    init(ownerID: String, queue: NativeQuickNotificationQueue, endpointFile: URL, hookFile: URL,
         schedulesTimers: Bool = true, request: @escaping Request) {
        self.ownerID = ownerID; self.queue = queue; self.endpointFile = endpointFile
        self.hookFile = hookFile; self.schedulesTimers = schedulesTimers; self.request = request
    }
    func updateContext(ready: Bool, available: Bool) {
        guard !stopped else { return }
        let nextAvailable = ready && available
        guard self.ready != ready || self.available != nextAvailable else { return }
        self.ready = ready; self.available = nextAvailable
        epoch &+= 1; configurationDirty = true
        if !nextAvailable { revokeLocal() }
        if ready || loaded { refresh() }
        configureTimer()
    }
    func setEnabled(_ value: Bool) {
        guard !stopped, !needsRestart, ready, loaded, !changing, value != enabled else { return }
        requestedEnabled = value; changing = true; configurationDirty = true; epoch &+= 1
        if !value { revokeLocal() }
        refresh()
    }
    func clearHistory() {
        guard !stopped, receiving, !changing else { return }
        clearRequested = true; changing = true
        refresh()
    }
    func refresh() {
        // A ready withdrawal still has to revoke an already configured backend.
        guard !stopped, !needsRestart, ready || loaded else { return }
        if work != nil { repeatRequested = true; return }
        work = Task { @MainActor [weak self] in
            guard let self else { return }
            repeat {
                self.repeatRequested = false
                await self.synchronizeOnce()
            } while self.repeatRequested && !self.stopped && (self.ready || self.loaded)
            self.work = nil
            self.configureTimer()
        }
    }
    /// Tests await the exact production lane instead of sleeping or racing timers.
    func settle() async { await work?.value }
    private func valid(_ captured: UInt64) -> Bool { !stopped && captured == epoch && queue.ownerID == ownerID }
    private func revokeLocal() {
        receiving = false; history = []; clearRequested = false
        if requestedEnabled == nil { changing = false }
        queue.removeEvents { $0.source.isExternal }
        onEventsInvalidated?()
    }
    private func synchronizeOnce() async {
        let captured = epoch
        do {
            if !loaded {
                guard ready else { return }
                let status = try JSONDecoder().decode(NativeQuickExternalNotificationStatus.self, from: await request("status", nil))
                guard valid(captured) else { return }
                if status.error == "notification_commit_uncertain" { throw NativeQuickExternalNotificationError.restartRequired }
                guard status.error == nil else { throw NativeQuickExternalNotificationError.unavailable }
                enabled = status.enabled; revision = max(revision, status.revision); loaded = true
            }
            if configurationDirty {
                revision += 1
                let target = requestedEnabled ?? enabled
                let status = try JSONDecoder().decode(NativeQuickExternalNotificationStatus.self,
                    from: await request("config", ["enabled": target, "available": available, "revision": revision]))
                guard valid(captured) else { return }
                guard status.error == nil, status.enabled == target, status.available == (target && available),
                      status.revision == revision else { throw NativeQuickExternalNotificationError.invalidResponse }
                enabled = status.enabled; receiving = status.available; backendGeneration = status.generation
                configurationDirty = false; requestedEnabled = nil; changing = false
                if !receiving { revokeLocal() }
            }
            guard valid(captured), ready, available, receiving else { issue = false; return }
            if clearRequested {
                _ = try await request("clear", ["generation": backendGeneration])
                guard valid(captured) else { return }
                clearRequested = false; changing = false
                queue.removeEvents { $0.source.isExternal }; history = []; onEventsInvalidated?()
            }
            let batch = try JSONDecoder().decode(NativeQuickExternalNotificationBatch.self, from: await request("poll", nil))
            guard valid(captured), receiving, batch.generation == backendGeneration else { return }
            var accepted: [String] = []
            for record in batch.events.prefix(100) {
                guard let event = record.event(ownerID: ownerID) else { continue }
                switch queue.enqueue(event) {
                case .accepted, .duplicate: accepted.append(record.id)
                case .full, .wrongOwner: break
                }
            }
            if !accepted.isEmpty {
                _ = try await request("ack", ["generation": backendGeneration, "ids": accepted])
                guard valid(captured) else { return }
            }
            let recent = try JSONDecoder().decode(NativeQuickExternalNotificationBatch.self, from: await request("history", nil))
            guard valid(captured), receiving, recent.generation == backendGeneration else { return }
            history = recent.events.prefix(20).compactMap { $0.event(ownerID: ownerID) }
            issue = false
        } catch {
            guard valid(captured) else { return }
            issue = true; changing = false
            if case NativeQuickExternalNotificationError.restartRequired = error {
                needsRestart = true; revokeLocal()
            }
            // Failed control writes retain their requested state for an explicit
            // retry. A failed polling read cannot manufacture a delivery receipt.
        }
    }
    private func configureTimer() {
        let shouldPoll = schedulesTimers && !stopped && !needsRestart && ready && available && enabled && !configurationDirty
        if !shouldPoll { timer?.invalidate(); timer = nil; return }
        guard timer == nil else { return }
        let timer = Timer(timeInterval: 2, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in self?.refresh() }
        }
        self.timer = timer; RunLoop.main.add(timer, forMode: .common)
    }
    func hookCommand(source: String) -> String? {
        guard receiving, ["codex", "claude", "gpt"].contains(source) else { return nil }
        func quote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        return "node " + quote(hookFile.path) + " --endpoint " + quote(endpointFile.path) + " --source " + source
    }
    func shutdown() {
        stopped = true; epoch &+= 1; timer?.invalidate(); timer = nil
        work?.cancel(); work = nil; revokeLocal()
    }
}
