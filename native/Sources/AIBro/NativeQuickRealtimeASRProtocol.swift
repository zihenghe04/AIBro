import Foundation

// Protocol/lifecycle adapted from TO-DO Panel 1deb3cac, main.js:2641–3025.
// Copyright (c) 2026 TO-DO Panel contributors, MIT; docs/licenses/to-do-panel-MIT.txt.
// Provider contract: https://help.aliyun.com/en/model-studio/qwen-asr-realtime-client-events
// ElevenLabs contract (checked 2026-10-26): https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
//   wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&audio_format=pcm_16000&commit_strategy=vad[&language_code=]
//   auth: xi-api-key header; client sends {message_type:"input_audio_chunk",audio_base_64,sample_rate,commit};
// Self-hosted (OpenAI-compatible ASR service) contract, from the service's own integration guide:
//   ws(s)://<host>:<port>/stream?token=<TOKEN>&language=Chinese|English|auto; server sends {type:"ready"}, client sends binary 16 kHz int16 mono PCM,
//   ends with the text frame {type:"stop"}; server replies {type:"partial"|"final",text} (partial replaces) and {type:"error",message}.
//   server sends session_started / partial_transcript{text} / committed_transcript{text} and typed error messages.
struct NativeQuickASRConfiguration: Codable, Equatable, Sendable {
    enum Region: String, Codable, CaseIterable { case beijing, singapore }
    enum Provider: String, Codable, CaseIterable, Sendable { case bailian, elevenLabs, selfHosted }
    var provider: Provider = .bailian
    var enabled = false
    var region: Region = .beijing
    var workspaceID = ""
    var language = "zh"
    /// Self-hosted only: ws:// or wss:// address of the service (path /stream is implied).
    var serverURL = ""
    static let model = "qwen3-asr-flash-realtime"
    static let elevenLabsModel = "scribe_v2_realtime"
    var modelName: String { provider == .elevenLabs ? Self.elevenLabsModel : provider == .selfHosted ? "stream" : Self.model }
    init() {}
    /// Configurations saved before ElevenLabs existed have no `provider`; they stay Model Studio.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        provider = try c.decodeIfPresent(Provider.self, forKey: .provider) ?? .bailian
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        region = try c.decodeIfPresent(Region.self, forKey: .region) ?? .beijing
        workspaceID = try c.decodeIfPresent(String.self, forKey: .workspaceID) ?? ""
        language = try c.decodeIfPresent(String.self, forKey: .language) ?? "zh"
        serverURL = try c.decodeIfPresent(String.self, forKey: .serverURL) ?? ""
    }
    var valid: Bool {
        workspaceID.utf8.count <= 128 && workspaceID.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }
            && (provider == .selfHosted ? ["", "zh", "en", "auto"] : ["", "zh", "en", "yue", "ja", "ko", "de", "fr", "es"]).contains(language)
            && (provider != .selfHosted || selfHostedURL != nil)
    }
    /// ws:// (plain, via Network.framework) or wss://.
    var selfHostedURL: URLComponents? {
        guard let raw = Self.streamAddress(serverURL) else { return nil }
        guard raw.utf8.count <= 2048, var parts = URLComponents(string: raw), let scheme = parts.scheme?.lowercased(), ["ws", "wss"].contains(scheme),
              let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              !raw.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains), parts.percentEncodedPath == parts.path,
              !parts.path.split(separator: "/").contains(where: { $0 == "." || $0 == ".." }) else { return nil }
        parts.scheme = scheme; parts.host = host.lowercased()
        if parts.port == (scheme == "wss" ? 443 : 80) { parts.port = nil }
        if !parts.path.hasSuffix("/stream") { parts.path = (parts.path.hasSuffix("/") ? String(parts.path.dropLast()) : parts.path) + "/stream" }
        return parts
    }
    /// Turns what a person would type into the stream address: `http(s)://host:port`, a base ending in `/v1`, a bare `host:port`, or a
    /// ws(s):// address all become `ws(s)://host[:port]/stream` (http -> ws, https -> wss). Nil when no host can be read.
    static func streamAddress(_ input: String) -> String? {
        var raw = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty, raw.utf8.count <= 2048 else { return nil }
        if !raw.contains("://") { raw = "http://" + raw }
        guard var parts = URLComponents(string: raw), let scheme = parts.scheme?.lowercased(), ["http", "https", "ws", "wss"].contains(scheme),
              let host = parts.host, !host.isEmpty else { return nil }
        parts.scheme = ["http": "ws", "https": "wss"][scheme] ?? scheme
        var path = parts.path
        for tail in ["/audio/transcriptions", "/stream", "/v1"] where path.hasSuffix(tail) { path.removeLast(tail.count) }
        while path.hasSuffix("/") { path.removeLast() }
        parts.path = path + "/stream"
        return parts.string
    }
    /// Why the address cannot be used, in words for the person typing it; nil when it is fine.
    var serverURLProblem: String? {
        guard provider == .selfHosted else { return nil }
        if serverURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return nativeUI("请填写服务地址，例如 http://主机:8000", "Enter the server address, e.g. http://host:8000") }
        return selfHostedURL == nil ? nativeUI("服务地址无法识别，请填 http(s)://主机:端口 或 ws(s)://主机:端口", "The address is not recognized; use http(s)://host:port or ws(s)://host:port") : nil
    }
    /// Language names the self-hosted server expects.
    var selfHostedLanguage: String { ["zh": "Chinese", "en": "English"][language] ?? "auto" }
    var host: String {
        if provider == .elevenLabs { return "api.elevenlabs.io" }
        if provider == .selfHosted { return selfHostedURL?.host ?? "" }
        if !workspaceID.isEmpty { return workspaceID + (region == .beijing ? ".cn-beijing.maas.aliyuncs.com" : ".ap-southeast-1.maas.aliyuncs.com") }
        return region == .beijing ? "dashscope.aliyuncs.com" : "dashscope-intl.aliyuncs.com"
    }
    /// Credential scope. Self-hosted uses the http(s) form of the ws(s) address, matching the credential store's origin format.
    var origin: String {
        guard provider == .selfHosted, let parts = selfHostedURL else { return "https://" + host }
        return (parts.scheme == "wss" ? "https" : "http") + "://" + host + (parts.port.map { ":\($0)" } ?? "")
    }
    var endpoint: URL? {
        guard valid else { return nil }
        if provider == .selfHosted {
            var parts = selfHostedURL; parts?.queryItems = [.init(name: "language", value: selfHostedLanguage)]
            return parts?.url
        }
        if provider == .elevenLabs {
            var parts = URLComponents(); parts.scheme = "wss"; parts.host = host; parts.path = "/v1/speech-to-text/realtime"
            parts.queryItems = [.init(name: "model_id", value: Self.elevenLabsModel), .init(name: "audio_format", value: "pcm_16000"), .init(name: "commit_strategy", value: "vad")]
                + (language.isEmpty ? [] : [.init(name: "language_code", value: language)])
            return parts.url
        }
        return URL(string: "wss://" + host + "/api-ws/v1/realtime?model=" + Self.model + "&heartbeat=true")
    }
    func request(key: String) throws -> URLRequest {
        if provider == .selfHosted {
            // The service takes the token as a query parameter; encode it strictly so no character can add another parameter.
            guard var parts = selfHostedURL, valid, !key.isEmpty, key.utf8.count <= 16384, !key.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains),
                  let token = key.trimmingCharacters(in: .whitespacesAndNewlines).addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")) else { throw NativeQuickASRError.configuration }
            parts.percentEncodedQuery = "token=" + token + "&language=" + selfHostedLanguage
            guard let url = parts.url else { throw NativeQuickASRError.configuration }
            var request = URLRequest(url: url); request.setValue("AI-Bro-Realtime-ASR/1", forHTTPHeaderField: "User-Agent"); return request
        }
        guard let endpoint, !key.isEmpty, key.utf8.count <= 16384, !key.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { throw NativeQuickASRError.configuration }
        var request = URLRequest(url: endpoint)
        request.setValue("AI-Bro-Realtime-ASR/1", forHTTPHeaderField: "User-Agent")
        if provider == .elevenLabs { request.setValue(key.trimmingCharacters(in: .whitespacesAndNewlines), forHTTPHeaderField: "xi-api-key"); return request }
        request.setValue("Bearer " + key, forHTTPHeaderField: "Authorization")
        request.setValue("realtime=v1", forHTTPHeaderField: "OpenAI-Beta")
        if !workspaceID.isEmpty { request.setValue(workspaceID, forHTTPHeaderField: "X-DashScope-WorkSpace") }
        return request
    }
    /// First message after connecting. ElevenLabs takes its settings from the URL, so it sends none and is ready on session_started.
    var update: [String: Any]? {
        if provider != .bailian { return nil }
        return ["event_id": UUID().uuidString, "type": "session.update", "session": ["input_audio_format": "pcm", "sample_rate": 16000,
          "input_audio_transcription": language.isEmpty ? [:] : ["language": language],
          "turn_detection": ["type": "server_vad", "threshold": 0.0, "silence_duration_ms": 400]]]
    }
    /// One audio chunk; `commit` closes the current segment (used for the last chunk of a recording).
    func audioMessage(_ pcm: Data, commit: Bool = false) -> [String: Any] {
        if provider == .selfHosted { return [:] } // never used: self-hosted audio goes out as binary frames, see audioFrame
        if provider == .elevenLabs { return ["message_type": "input_audio_chunk", "audio_base_64": pcm.base64EncodedString(), "sample_rate": 16000, "commit": commit] }
        return ["event_id": UUID().uuidString, "type": "input_audio_buffer.append", "audio": pcm.base64EncodedString()]
    }
}

/// One outgoing websocket frame: a JSON text message, or raw PCM bytes (self-hosted).
enum NativeQuickASRFrame { case json([String: Any]), binary(Data) }

/// What a provider message means to the session. Each provider's wire format is translated here, once, so the
/// session itself (queueing, reconnects, finish, transcript assembly) is shared.
enum NativeQuickASREvent {
    case ready
    /// `item == nil`: the provider has no item ids, the session numbers segments (a partial replaces the open one, a commit closes it).
    case transcript(item: String?, eventID: String?, text: String, final: Bool)
    case invalidTranscript
    case sessionFinished
    case nothingToCommit
    case failure(reason: String, terminal: Bool)
    case ignore
}

extension NativeQuickASRConfiguration {
    /// ElevenLabs closes a recording with a commit; Model Studio with an explicit session.finish event.
    var finishesWithCommit: Bool { provider == .elevenLabs }
    /// Providers that have no end-of-session event end a recording once the last committed/final transcript has arrived.
    var completesOnFinal: Bool { provider != .bailian }
    func audioFrame(_ pcm: Data, commit: Bool = false) -> NativeQuickASRFrame { provider == .selfHosted ? .binary(pcm) : .json(audioMessage(pcm, commit: commit)) }
    var finishFrame: NativeQuickASRFrame { provider == .selfHosted ? .json(["type": "stop"]) : .json(finishMessage) }
    var updateFrame: NativeQuickASRFrame? { update.map { .json($0) } }
    /// Closing message of a recording: ElevenLabs commits with an empty chunk (as its SDKs do), Model Studio sends session.finish.
    var finishMessage: [String: Any] {
        provider == .elevenLabs ? audioMessage(Data(), commit: true) : ["event_id": UUID().uuidString, "type": "session.finish"]
    }
    func interpret(_ event: [String: Any]) -> NativeQuickASREvent {
        switch provider {
        case .bailian:
            let type = event["type"] as? String
            switch type {
            case "session.updated": return .ready
            case "conversation.item.input_audio_transcription.text", "conversation.item.input_audio_transcription.completed":
                let final = type == "conversation.item.input_audio_transcription.completed"
                guard let item = event["item_id"] as? String,
                      let value = final ? event["transcript"] as? String : (event["text"] as? String).map({ $0 + (event["stash"] as? String ?? "") }) else { return .invalidTranscript }
                return .transcript(item: item, eventID: event["event_id"] as? String, text: value, final: final)
            case "session.finished": return .sessionFinished
            case "error", "conversation.item.input_audio_transcription.failed":
                let code = (event["error"] as? [String: Any])?["code"] as? String ?? ""
                let terminal = ["invalid_api_key", "invalid_request_error", "invalid_value", "authentication_error", "invalid_parameter", "unauthorized"].contains(code)
                return .failure(reason: terminal ? "configuration_rejected" : "service_error", terminal: terminal)
            default: return .ignore
            }
        case .selfHosted:
            switch event["type"] as? String {
            case "ready": return .ready
            case "partial", "final":
                guard let text = event["text"] as? String else { return .invalidTranscript }
                return .transcript(item: nil, eventID: nil, text: text, final: event["type"] as? String == "final")
            case "error": return .failure(reason: "service_error", terminal: false)
            default: return .ignore
            }
        case .elevenLabs:
            switch event["message_type"] as? String {
            case "session_started": return .ready
            case "partial_transcript", "committed_transcript":
                guard let text = event["text"] as? String ?? event["transcript"] as? String else { return .invalidTranscript }
                return .transcript(item: nil, eventID: nil, text: text, final: event["message_type"] as? String == "committed_transcript")
            case "warning", "insufficient_audio_activity", "commit_throttled": return .nothingToCommit
            case "auth_error", "quota_exceeded", "unaccepted_terms", "invalid_request", "input_error": return .failure(reason: "configuration_rejected", terminal: true)
            case "error", "rate_limited", "queue_overflow", "resource_exhausted", "session_time_limit_exceeded", "chunk_size_exceeded", "transcriber_error": return .failure(reason: "service_error", terminal: false)
            default: return .ignore
            }
        }
    }
    /// True when this message acknowledges the connection in a settings test.
    func isStartAck(_ event: [String: Any]) -> Bool { if case .ready = interpret(event) { return true }; return false }
    func isRejection(_ event: [String: Any]) -> Bool { if case .failure = interpret(event) { return true }; return false }
}

enum NativeQuickASRError: Error { case configuration, invalidMessage, unavailable }
enum NativeQuickASRPhase: String, Equatable, Sendable { case idle, connecting, connected, reconnecting, finishing, completed, failed, cancelled }
struct NativeQuickASRSnapshot: Equatable, Sendable {
    var phase: NativeQuickASRPhase = .idle
    var finalized = ""
    var interim = ""
    var interruptedSegments: [String] = []
    var hasGap = false
    var reason: String?
    var retry = 0
    var queuedBytes = 0
    var text = "" // Cached chronological output; timer/PCM updates never join the full transcript.
}

/// Server utterances use stable item IDs. Partial text is a replacement, not a
/// delta. Real repeated phrases from DIFFERENT items must never be fuzzy-deduped.
struct NativeQuickASRTranscript {
    struct Segment { let id: String; var text: String; var final: Bool }
    private(set) var segments: [Segment] = []
    private var seenEvents = Set<String>()
    private(set) var interrupted = [String]()
    private(set) var hasGap = false
    static let maxUTF16 = 200_000
    private(set) var finalText = ""
    private(set) var interimText = ""
    private(set) var text = ""
    private(set) var contentBuilds = 0
    private var textLength = 0
    private mutating func rebuild() {
        finalText = segments.filter(\.final).map(\.text).filter { !$0.isEmpty }.joined(separator:"\n")
        interimText = segments.filter { !$0.final }.map(\.text).filter { !$0.isEmpty }.joined(separator:"\n")
        text = segments.map(\.text).filter { !$0.isEmpty }.joined(separator:"\n")
        textLength = text.utf16.count; contentBuilds += 1
    }
    /// Provider-neutral entry. `eventID` (when the provider sends one) is de-duplicated per connection.
    mutating func receive(item: String, eventID: String?, text value: String, final: Bool, connection: Int) throws {
        guard !item.isEmpty, item.utf8.count <= 256 else { throw NativeQuickASRError.invalidMessage }
        if let event = eventID {
            guard event.utf8.count <= 256 else { throw NativeQuickASRError.invalidMessage }
            guard seenEvents.insert("\(connection):" + event).inserted else { return }
            // Keep the bounded event history independent of transcript length.
            if seenEvents.count > 4096 { seenEvents = [] }
        }
        try upsert(id: "\(connection):" + item, value: value, final: final)
    }
    /// ElevenLabs has no item ids: the caller numbers segments; a partial replaces the open segment, a committed text closes it.
    mutating func receiveSegment(_ number: Int, connection: Int, text: String, final: Bool) throws {
        try upsert(id: "\(connection):seg\(number)", value: text, final: final)
    }
    private mutating func upsert(id: String, value: String, final: Bool) throws {
        guard value.utf16.count <= Self.maxUTF16 else { throw NativeQuickASRError.invalidMessage }
        if let index = segments.firstIndex(where: { $0.id == id }) {
            guard !segments[index].final else { return }
            guard textLength - segments[index].text.utf16.count + value.utf16.count <= Self.maxUTF16 else { throw NativeQuickASRError.invalidMessage }
            guard segments[index].text != value || segments[index].final != final else { return }
            segments[index].text = value; segments[index].final = final
        } else {
            guard segments.count < 10000, textLength + value.utf16.count + (segments.isEmpty ? 0 : 1) <= Self.maxUTF16 else { throw NativeQuickASRError.invalidMessage }
            segments.append(.init(id: id, text: value, final: final))
        }
        rebuild()
    }
    mutating func disconnect() {
        var changed = false
        for index in segments.indices where !segments[index].final {
            let value = segments[index].text
            if !value.isEmpty { interrupted.append(value); hasGap = true }
            // Preserve the heard fragment in chronological output, explicitly
            // marked incomplete by the snapshot/record receipt, not as a new
            // provider-confirmed utterance.
            segments[index].final = true; changed = true
        }
        if changed { rebuild() }
    }
}

/// Only unsent PCM is queued. A failed in-flight send has unknown delivery,
/// so it is NOT replayed; flag a gap instead of duplicating words across sessions.
struct NativeQuickASRBuffer {
    static let limit = 16_000 * 2 * 30
    private(set) var chunks: [Data] = []
    private(set) var bytes = 0
    private(set) var lostBytes = 0
    mutating func append(_ pcm: Data) {
        guard !pcm.isEmpty, pcm.count % 2 == 0 else { return }
        if pcm.count > Self.limit { lostBytes += pcm.count; return }
        chunks.append(pcm); bytes += pcm.count
        while bytes > Self.limit, !chunks.isEmpty { let dropped = chunks.removeFirst(); bytes -= dropped.count; lostBytes += dropped.count }
    }
    mutating func take() -> Data? {
        guard !chunks.isEmpty else { return nil }
        let value = chunks.removeFirst(); bytes -= value.count; return value
    }
    mutating func clear() { chunks.removeAll(); bytes = 0 }
}
