import Foundation
import Network
import Combine

@MainActor protocol NativeQuickASRSocket: AnyObject {
    func send(_ text: String) async throws
    func sendBinary(_ data: Data) async throws
    func receive() async throws -> Data
    func ping() async throws
    func close()
    var authenticationRejected: Bool { get }
}

extension NativeQuickASRSocket { func sendBinary(_ data: Data) async throws { throw NativeQuickASRError.invalidMessage } }

/// ws:// connection over Network.framework for the self-hosted service. App Transport Security refuses plain ws to an IP address
/// that URLSession is asked to open, and cannot be told about one; this path is only used for ws:// (wss:// stays on URLSession).
@MainActor final class NativeQuickASRPlainWebSocket: NativeQuickASRSocket {
    private let connection: NWConnection
    init(request: URLRequest) {
        let options = NWProtocolWebSocket.Options()
        options.autoReplyPing = true; options.maximumMessageSize = 512 * 1024
        options.setAdditionalHeaders((request.allHTTPHeaderFields ?? [:]).map { ($0.key, $0.value) })
        let parameters = NWParameters.tcp
        parameters.defaultProtocolStack.applicationProtocols.insert(options, at: 0); parameters.preferNoProxies = true
        connection = NWConnection(to: .url(request.url!), using: parameters)
        connection.start(queue: .main)
    }
    private func transmit(_ data: Data, opcode: NWProtocolWebSocket.Opcode) async throws {
        let context = NWConnection.ContentContext(identifier: "frame", metadata: [NWProtocolWebSocket.Metadata(opcode: opcode)])
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            })
        }
    }
    func send(_ text: String) async throws { try await transmit(Data(text.utf8), opcode: .text) }
    func sendBinary(_ data: Data) async throws { try await transmit(data, opcode: .binary) }
    func receive() async throws -> Data {
        while true {
            let message: (Data?, NWProtocolWebSocket.Opcode?) = try await withCheckedThrowingContinuation { continuation in
                connection.receiveMessage { data, context, _, error in
                    if let error { continuation.resume(throwing: error); return }
                    let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
                    continuation.resume(returning: (data, metadata?.opcode))
                }
            }
            switch message.1 {
            case .text, .binary: if let data = message.0 { return data }
            case .close: throw NativeQuickASRError.unavailable
            default: continue
            }
        }
    }
    func ping() async throws { try await transmit(Data(), opcode: .ping) }
    var authenticationRejected: Bool { false }
    func close() { connection.cancel() }
}

/// Ephemeral, fixed-provider connection. No cookies/cache, ambient credentials,
/// redirects or request/body logging. Constructed ONLY by an explicit recording.
@MainActor final class NativeQuickASRWebSocket: NSObject, NativeQuickASRSocket, URLSessionTaskDelegate {
    /// The default socket for a request: plain ws:// (self-hosted) over Network.framework, everything else over URLSession.
    static func make(_ request: URLRequest) -> any NativeQuickASRSocket {
        request.url?.scheme?.lowercased() == "ws" ? NativeQuickASRPlainWebSocket(request: request) : NativeQuickASRWebSocket(request: request)
    }
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
    func sendBinary(_ data: Data) async throws { try await socket.send(.data(data)) }
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
    private var committedCount = 0, commitMark = 0
    private var segmentNumber = 0 // ElevenLabs: partials replace the open segment; a commit closes it.
    private var phase: NativeQuickASRPhase = .idle
    private var reason: String?
    var transcriptContentBuilds: Int { transcript.contentBuilds }
    init(factory: @escaping Factory = { NativeQuickASRWebSocket.make($0) }, sleep: @escaping Sleep = { try await Task.sleep(for: .seconds($0)) }) { self.factory = factory; self.sleep = sleep }
    func start(configuration: NativeQuickASRConfiguration, key: String) throws {
        guard configuration.enabled, configuration.valid else { throw NativeQuickASRError.configuration }
        _ = try configuration.request(key: key)
        cancel(); generation += 1
        self.config = configuration; self.key = key; buffer = .init(); transcript = .init(); gap = false; retries = 0; segmentNumber = 0; committedCount = 0; commitMark = 0
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
            // ElevenLabs has no end-of-session event: the commit already went out, so a quiet server means nothing is left to wait for.
            if self.config.completesOnFinal, self.finishSent, self.transcript.interimText.isEmpty { self.terminate(.completed, reason: nil); return }
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
    private func send(_ frame: NativeQuickASRFrame, on socket: any NativeQuickASRSocket) async throws {
        switch frame { case .json(let body): try await socket.send(json(body)); case .binary(let data): try await socket.sendBinary(data) }
    }
    private func json(_ body: [String:Any]) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: body), as: UTF8.self) }
    private func beginConnection() {
        guard active else { return }
        connection += 1; let id = connection, token = generation
        ready = false; finishSent = false; segmentNumber += 1
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
                if let update = self.config.updateFrame { try await self.send(update, on: socket) }
            } catch {
                guard let self, self.current(id,token) else { return }
                self.reconnect(reason: socket.authenticationRejected ? "authentication" : "configuration_send_failed", terminal: socket.authenticationRejected)
            }
        }
    }
    private func receive(_ raw: [String:Any], connection id: Int) {
        switch config.interpret(raw) {
        case .ready:
            guard !ready else { return }; ready = true; timeoutTask?.cancel(); timeoutTask = nil
            phase = finishing ? .finishing : .connected; reason = nil; publish(); startHeartbeat(); drain()
        case .transcript(let item, let eventID, let text, let final):
            guard ready else { return }
            do {
                if let item { try transcript.receive(item: item, eventID: eventID, text: text, final: final, connection: id) }
                else if !(final && text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) { try transcript.receiveSegment(segmentNumber, connection: id, text: text, final: final) }
                publish()
                if item == nil && final {
                    segmentNumber += 1; committedCount += 1
                    if config.completesOnFinal && finishing && finishSent && committedCount > commitMark && transcript.interimText.isEmpty { terminate(.completed, reason: nil) }
                }
            } catch { gap = true; terminate(.failed, reason: "transcript_limit") }
        case .invalidTranscript:
            guard ready else { return }
            gap = true; terminate(.failed, reason: "transcript_limit")
        case .sessionFinished:
            if finishing && finishSent { terminate(.completed, reason: nil) }
            else { reconnect(reason: "session_finished") }
        case .nothingToCommit:
            // Silence or a throttled commit: after the final commit there is nothing left to wait for.
            if config.completesOnFinal && finishing && finishSent && transcript.interimText.isEmpty { terminate(.completed, reason: nil) }
        case .failure(let why, let terminal):
            reconnect(reason: why, terminal: terminal)
        case .ignore: break
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
                    // ElevenLabs: the last chunk of a finishing recording carries the commit.
                    let last = self.config.finishesWithCommit && self.finishing && self.buffer.bytes == 0
                    if last { self.finishSent = true; self.commitMark = self.committedCount }
                    do { try await self.send(self.config.audioFrame(bytes, commit: last), on: socket) }
                    catch {
                        guard self.current(id,token) else { return }
                        self.gap = true // Delivery of this one chunk is uncertain. Do not replay it.
                        self.reconnect(reason: "audio_send_failed"); return
                    }
                } else {
                    if self.finishing, !self.finishSent {
                        self.finishSent = true; self.commitMark = self.committedCount
                        do { try await self.send(self.config.finishFrame, on: socket) }
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
