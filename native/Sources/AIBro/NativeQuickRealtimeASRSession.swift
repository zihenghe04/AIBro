import Foundation
import Combine

@MainActor protocol NativeQuickASRSocket: AnyObject {
    func send(_ text: String) async throws
    func receive() async throws -> Data
    func ping() async throws
    func close()
    var authenticationRejected: Bool { get }
}

/// Ephemeral, fixed-provider connection. No cookies/cache, ambient credentials,
/// redirects or request/body logging. Constructed ONLY by an explicit recording.
@MainActor final class NativeQuickASRWebSocket: NSObject, NativeQuickASRSocket, URLSessionTaskDelegate {
    private var session: URLSession!
    private var socket: URLSessionWebSocketTask!
    init(request: URLRequest) {
        super.init()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil; configuration.urlCache = nil; configuration.urlCredentialStorage = nil
        configuration.timeoutIntervalForRequest = 8
        session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        socket = session.webSocketTask(with: request); socket.maximumMessageSize = 512 * 1024; socket.resume()
    }
    nonisolated func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func send(_ text: String) async throws { try await socket.send(.string(text)) }
    func receive() async throws -> Data {
        switch try await socket.receive() { case .data(let data): return data; case .string(let value): return Data(value.utf8); @unknown default: throw NativeQuickASRError.invalidMessage }
    }
    func ping() async throws { try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in socket.sendPing { error in if let error { continuation.resume(throwing: error) } else { continuation.resume() } } } }
    var authenticationRejected: Bool { [401,403].contains((socket.response as? HTTPURLResponse)?.statusCode ?? 0) }
    func close() { socket.cancel(with: .goingAway, reason: nil); session.invalidateAndCancel() }
}

@MainActor final class NativeQuickRealtimeASRSession: ObservableObject {
    typealias Factory = @MainActor (URLRequest) -> any NativeQuickASRSocket
    typealias Sleep = @MainActor (TimeInterval) async throws -> Void
    @Published private(set) var snapshot = NativeQuickASRSnapshot()
    var onChange: ((NativeQuickASRSnapshot) -> Void)?
    private let factory: Factory
    private let sleep: Sleep
    private var socket: (any NativeQuickASRSocket)?
    private var readTask: Task<Void,Never>?, sendTask: Task<Void,Never>?, connectTask: Task<Void,Never>?
    private var timeoutTask: Task<Void,Never>?, retryTask: Task<Void,Never>?, heartbeatTask: Task<Void,Never>?, finishTask: Task<Void,Never>?
    private var finishContinuation: CheckedContinuation<NativeQuickASRSnapshot,Never>?
    private var buffer = NativeQuickASRBuffer()
    private var transcript = NativeQuickASRTranscript()
    private var config = NativeQuickASRConfiguration()
    private var key = ""
    private var active = false, ready = false, finishing = false, finishSent = false
    private var connection = 0, generation = 0, retries = 0
    private var gap = false
    private var phase: NativeQuickASRPhase = .idle
    private var reason: String?
    var transcriptContentBuilds: Int { transcript.contentBuilds }
    init(factory: @escaping Factory = { NativeQuickASRWebSocket(request: $0) }, sleep: @escaping Sleep = { try await Task.sleep(for: .seconds($0)) }) { self.factory = factory; self.sleep = sleep }
    func start(configuration: NativeQuickASRConfiguration, key: String) throws {
        guard configuration.enabled, configuration.valid else { throw NativeQuickASRError.configuration }
        _ = try configuration.request(key: key)
        cancel(); generation += 1
        self.config = configuration; self.key = key; buffer = .init(); transcript = .init(); gap = false; retries = 0
        active = true; ready = false; finishing = false; finishSent = false; phase = .idle; reason = nil; snapshot = .init()
        beginConnection()
    }
    func append(_ pcm: Data) {
        guard active, !finishing else { return }
        guard pcm.count % 2 == 0, pcm.count <= 512 * 1024 else { markGap(); return }
        buffer.append(pcm); if buffer.lostBytes > 0 { gap = true }
        publish(); drain()
    }
    func markGap() { guard active else { return }; gap = true; publish() }
    func inputFailed() {guard active else{return};gap=true;terminate(.failed,reason:"audio_delivery_interrupted")}
    func finish() async -> NativeQuickASRSnapshot {
        guard active else { return snapshot }
        guard !finishing else { return snapshot }
        finishing = true; phase = .finishing; publish()
        guard active else { return snapshot } // onChange may revoke while publishing.
        let token = generation
        finishTask = Task { [weak self, sleep] in
            do { try await sleep(7) } catch { return }
            guard let self, self.active, self.generation == token else { return }
            self.gap = true; self.terminate(.failed, reason: "finish_timeout")
        }
        return await withCheckedContinuation { continuation in finishContinuation = continuation; drain() }
    }
    func cancel() {
        guard active || finishContinuation != nil else { return }
        terminate(.cancelled, reason: "cancelled")
    }
    private func publish() {
        // Cached transcript strings change only on actual provider text events,
        // never on the 10Hz PCM queue path. Emit a single atomic state update.
        let next = NativeQuickASRSnapshot(phase:phase,finalized:transcript.finalText,interim:transcript.interimText,
            interruptedSegments:transcript.interrupted,hasGap:gap || transcript.hasGap,reason:reason,retry:retries,queuedBytes:buffer.bytes,text:transcript.text)
        guard snapshot != next else { return }
        snapshot = next; onChange?(next)
    }
    private func current(_ id: Int, _ token: Int) -> Bool { active && generation == token && connection == id && socket != nil }
    private func json(_ body: [String:Any]) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: body), as: UTF8.self) }
    private func beginConnection() {
        guard active else { return }
        connection += 1; let id = connection, token = generation
        ready = false; finishSent = false
        do { socket = factory(try config.request(key: key)) } catch { terminate(.failed, reason: "configuration"); return }
        guard let socket else { return }
        phase = finishing ? .finishing : (retries > 0 ? .reconnecting : .connecting); publish()
        timeoutTask = Task { [weak self, sleep] in
            do { try await sleep(8) } catch { return }
            guard let self, self.current(id,token), !self.ready else { return }
            self.reconnect(reason: "connect_timeout")
        }
        readTask = Task { [weak self] in
            do {
                while !Task.isCancelled {
                    let bytes = try await socket.receive()
                    guard let self, self.current(id,token) else { return }
                    guard bytes.count <= 512 * 1024, let event = try JSONSerialization.jsonObject(with: bytes) as? [String:Any] else { throw NativeQuickASRError.invalidMessage }
                    self.receive(event, connection: id)
                }
            } catch {
                guard let self, self.current(id,token) else { return }
                self.reconnect(reason: socket.authenticationRejected ? "authentication" : "connection_lost", terminal: socket.authenticationRejected)
            }
        }
        connectTask = Task { [weak self] in
            do {
                guard let self else { return }
                try await socket.send(self.json(self.config.update))
            } catch {
                guard let self, self.current(id,token) else { return }
                self.reconnect(reason: socket.authenticationRejected ? "authentication" : "configuration_send_failed", terminal: socket.authenticationRejected)
            }
        }
    }
    private func receive(_ event: [String:Any], connection id: Int) {
        switch event["type"] as? String {
        case "session.updated":
            guard !ready else { return }; ready = true; timeoutTask?.cancel(); timeoutTask = nil
            phase = finishing ? .finishing : .connected; reason = nil; publish(); startHeartbeat(); drain()
        case "conversation.item.input_audio_transcription.text", "conversation.item.input_audio_transcription.completed":
            guard ready else { return }
            do { try transcript.receive(event, connection: id); publish() }
            catch { gap = true; terminate(.failed, reason: "transcript_limit") }
        case "session.finished":
            if finishing && finishSent { terminate(.completed, reason: nil) }
            else { reconnect(reason: "session_finished") }
        case "error", "conversation.item.input_audio_transcription.failed":
            let code = (event["error"] as? [String:Any])?["code"] as? String ?? ""
            let terminal = ["invalid_api_key", "invalid_request_error", "invalid_value", "authentication_error", "invalid_parameter", "unauthorized"].contains(code)
            reconnect(reason: terminal ? "configuration_rejected" : "service_error", terminal: terminal)
        default: break
        }
    }
    private func drain() {
        guard active, ready, sendTask == nil, let socket else { return }
        let id = connection, token = generation
        sendTask = Task { [weak self] in
            guard let self else { return }
            defer { if self.current(id,token) { self.sendTask = nil; if self.buffer.bytes > 0 { self.drain() } } }
            while self.current(id,token), self.ready, !Task.isCancelled {
                if let bytes = self.buffer.take() {
                    self.publish()
                    do { try await socket.send(self.json(["event_id":UUID().uuidString,"type":"input_audio_buffer.append","audio":bytes.base64EncodedString()])) }
                    catch {
                        guard self.current(id,token) else { return }
                        self.gap = true // Delivery of this one chunk is uncertain. Do not replay it.
                        self.reconnect(reason: "audio_send_failed"); return
                    }
                } else {
                    if self.finishing, !self.finishSent {
                        self.finishSent = true
                        do { try await socket.send(self.json(["event_id":UUID().uuidString,"type":"session.finish"])) }
                        catch { if self.current(id,token) { self.gap = true; self.terminate(.failed,reason:"finish_send_failed") } }
                    }
                    return
                }
            }
        }
    }
    private func startHeartbeat() {
        heartbeatTask?.cancel(); let id = connection, token = generation
        heartbeatTask = Task { [weak self, sleep] in
            do {
                while !Task.isCancelled {
                    try await sleep(15)
                    guard let self, self.current(id,token), let socket = self.socket else { return }
                    // The connection deadline also bounds an unanswered ping.
                    self.timeoutTask = Task { [weak self, sleep] in
                        do { try await sleep(8) } catch { return }
                        guard let self, self.current(id,token) else { return }; self.reconnect(reason:"heartbeat_timeout")
                    }
                    try await socket.ping()
                    guard self.current(id,token) else { return }
                    self.timeoutTask?.cancel(); self.timeoutTask = nil
                    // Only stable connectivity resets the retry budget, not a
                    // fleeting session.updated followed by another failure.
                    self.retries = 0; self.publish()
                }
            } catch { guard let self, self.current(id,token) else { return }; self.reconnect(reason:"heartbeat_failed") }
        }
    }
    private func dropConnection() {
        connection += 1; ready = false
        readTask?.cancel(); readTask = nil; sendTask?.cancel(); sendTask = nil; connectTask?.cancel(); connectTask = nil
        timeoutTask?.cancel(); timeoutTask = nil; heartbeatTask?.cancel(); heartbeatTask = nil
        let old = socket; socket = nil; old?.close()
    }
    private func reconnect(reason: String, terminal: Bool = false) {
        guard active, retryTask == nil else { return }
        dropConnection(); transcript.disconnect(); gap = true; self.reason = reason
        guard !terminal, retries < 5 else { terminate(.failed,reason:reason); return }
        let delay = min(pow(2, Double(retries)),15); retries += 1
        phase = finishing ? .finishing : .reconnecting; publish()
        let token = generation
        retryTask = Task { [weak self, sleep] in
            do { try await sleep(delay) } catch { return }
            guard let self, self.active, self.generation == token else { return }
            self.retryTask = nil; self.beginConnection()
        }
    }
    private func terminate(_ phase: NativeQuickASRPhase, reason: String?) {
        active = false; generation += 1; dropConnection()
        retryTask?.cancel(); retryTask = nil; finishTask?.cancel(); finishTask = nil
        if !transcript.interimText.isEmpty { transcript.disconnect() }
        if buffer.bytes > 0 { gap = true }; buffer.clear(); key = ""
        self.phase = phase; self.reason = reason; publish()
        let continuation = finishContinuation; finishContinuation = nil; continuation?.resume(returning: snapshot)
    }
}
