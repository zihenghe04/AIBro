import Foundation

// Protocol/lifecycle adapted from TO-DO Panel 1deb3cac, main.js:2641–3025.
// Copyright (c) 2026 TO-DO Panel contributors, MIT; docs/licenses/to-do-panel-MIT.txt.
// Provider contract: https://help.aliyun.com/en/model-studio/qwen-asr-realtime-client-events
struct NativeQuickASRConfiguration: Codable, Equatable, Sendable {
    enum Region: String, Codable, CaseIterable { case beijing, singapore }
    var enabled = false
    var region: Region = .beijing
    var workspaceID = ""
    var language = "zh"
    static let model = "qwen3-asr-flash-realtime"
    var valid: Bool {
        workspaceID.utf8.count <= 128 && workspaceID.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }
            && ["", "zh", "en", "yue", "ja", "ko", "de", "fr", "es"].contains(language)
    }
    var host: String {
        if !workspaceID.isEmpty { return workspaceID + (region == .beijing ? ".cn-beijing.maas.aliyuncs.com" : ".ap-southeast-1.maas.aliyuncs.com") }
        return region == .beijing ? "dashscope.aliyuncs.com" : "dashscope-intl.aliyuncs.com"
    }
    var origin: String { "https://" + host }
    var endpoint: URL? { valid ? URL(string: "wss://" + host + "/api-ws/v1/realtime?model=" + Self.model + "&heartbeat=true") : nil }
    func request(key: String) throws -> URLRequest {
        guard let endpoint, !key.isEmpty, key.utf8.count <= 16384, !key.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { throw NativeQuickASRError.configuration }
        var request = URLRequest(url: endpoint)
        request.setValue("Bearer " + key, forHTTPHeaderField: "Authorization")
        request.setValue("realtime=v1", forHTTPHeaderField: "OpenAI-Beta")
        request.setValue("AI-Bro-Realtime-ASR/1", forHTTPHeaderField: "User-Agent")
        if !workspaceID.isEmpty { request.setValue(workspaceID, forHTTPHeaderField: "X-DashScope-WorkSpace") }
        return request
    }
    var update: [String: Any] {
        ["event_id": UUID().uuidString, "type": "session.update", "session": ["input_audio_format": "pcm", "sample_rate": 16000,
          "input_audio_transcription": language.isEmpty ? [:] : ["language": language],
          "turn_detection": ["type": "server_vad", "threshold": 0.0, "silence_duration_ms": 400]]]
    }
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
    mutating func receive(_ message: [String: Any], connection: Int) throws {
        let type = message["type"] as? String ?? ""
        guard type == "conversation.item.input_audio_transcription.text" || type == "conversation.item.input_audio_transcription.completed" else { return }
        guard let item = message["item_id"] as? String, !item.isEmpty, item.utf8.count <= 256 else { throw NativeQuickASRError.invalidMessage }
        if let event = message["event_id"] as? String {
            guard event.utf8.count <= 256 else { throw NativeQuickASRError.invalidMessage }
            guard seenEvents.insert("\(connection):" + event).inserted else { return }
            // Keep the bounded event history independent of transcript length.
            if seenEvents.count > 4096 { seenEvents = [] }
        }
        let id = "\(connection):" + item, final = type.hasSuffix(".completed")
        let value = final ? message["transcript"] as? String : (message["text"] as? String).map { $0 + (message["stash"] as? String ?? "") }
        guard let value, value.utf16.count <= Self.maxUTF16 else { throw NativeQuickASRError.invalidMessage }
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
