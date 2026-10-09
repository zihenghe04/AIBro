import Foundation

protocol VoiceCaptureBackend: AnyObject {
    var duration: TimeInterval { get }
    func start(url: URL, maximumDuration: TimeInterval) throws
    func stop()
}

enum VoiceCaptureError: String, LocalizedError {
    case invalidID = "录音标识无效"
    case busy = "已有录音，请先停止或取消"
    case foreground = "请在前台打开 App 后录音"
    case permission = "请在系统设置中允许 AI Bro 使用麦克风"
    case cancelled = "录音已取消"
    case notRecording = "没有可用的录音"
    case failed = "录音未完成，请重试"
    case tooLarge = "录音超过 16 MB，已丢弃"
    case empty = "没有录到音频，请重试"
    var errorDescription: String? { rawValue }
}

struct VoiceCaptureResult {
    let requestID: String
    let data: Data
    let durationMS: Int
}

// All operations run on the main queue. Hardware and permission are injected so
// lifecycle races can be tested without microphone access or a Simulator.
final class VoiceCaptureCore {
    static let maximumDuration: TimeInterval = 120
    static let maximumBytes = 16 * 1024 * 1024
    private enum Phase { case permission, authorized, recording, ready }
    private final class Capture {
        let requestID: String
        let url: URL
        var phase = Phase.permission
        var durationMS = 0
        var startCompletion: ((Result<Void, VoiceCaptureError>) -> Void)?
        init(_ requestID: String, url: URL, completion: @escaping (Result<Void, VoiceCaptureError>) -> Void) {
            self.requestID = requestID; self.url = url; startCompletion = completion
        }
    }
    private let directory: URL
    private let backend: VoiceCaptureBackend
    private let foreground: () -> Bool
    private let permission: (@escaping (Bool) -> Void) -> Void
    private let event: ([String: Any]) -> Void
    private var capture: Capture?
    var recording: Bool { capture?.phase == .recording }
    var awaitingPermission: Bool { capture?.phase == .permission || capture?.phase == .authorized }

    init(directory: URL, backend: VoiceCaptureBackend, foreground: @escaping () -> Bool,
         permission: @escaping (@escaping (Bool) -> Void) -> Void, event: @escaping ([String: Any]) -> Void) throws {
        self.directory = directory; self.backend = backend; self.foreground = foreground
        self.permission = permission; self.event = event
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        // Only this dedicated app-private directory is swept after a crash.
        for file in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) {
            try FileManager.default.removeItem(at: file)
        }
    }
    deinit { dispose() }
    static func validID(_ value: String) -> Bool { !value.isEmpty && value.utf8.count <= 128 }

    func start(_ requestID: String, completion: @escaping (Result<Void, VoiceCaptureError>) -> Void) {
        guard Self.validID(requestID) else { completion(.failure(.invalidID)); return }
        guard capture == nil else { completion(.failure(.busy)); return }
        guard foreground() else { completion(.failure(.foreground)); return }
        let next = Capture(requestID, url: directory.appendingPathComponent(UUID().uuidString + ".m4a"), completion: completion)
        capture = next
        permission { [weak self, weak next] granted in
            guard let self, let next, self.capture === next, next.phase == .permission else { return }
            guard granted else { self.failStart(.permission); return }
            next.phase = .authorized
            // The system permission sheet can still be dismissing. Do not record
            // while inactive; applicationDidBecomeActive finishes this start.
            if self.foreground() { self.activate() }
        }
    }
    func becameActive() { if capture?.phase == .authorized { activate() } }
    private func activate() {
        guard let current = capture, current.phase == .authorized, foreground() else { return }
        do {
            try backend.start(url: current.url, maximumDuration: Self.maximumDuration)
            current.phase = .recording
            let completion = current.startCompletion; current.startCompletion = nil
            completion?(.success(()))
        } catch { failStart(.failed) }
    }
    private func failStart(_ error: VoiceCaptureError) {
        let completion = capture?.startCompletion
        capture?.startCompletion = nil
        dispose(); completion?(.failure(error))
    }
    private func fileSize(_ url: URL) -> Int { (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0 }
    func poll() {
        guard let current = capture, current.phase == .recording else { return }
        if !foreground() { cancelCurrent(); return }
        if fileSize(current.url) > Self.maximumBytes { failRecording(.tooLarge); return }
        if backend.duration >= Self.maximumDuration { reachedLimit() }
    }
    func reachedLimit() {
        guard let current = capture, current.phase == .recording else { return }
        current.durationMS = min(120000, max(0, Int(backend.duration * 1000)))
        current.phase = .ready
        backend.stop()
        if fileSize(current.url) > Self.maximumBytes { failRecording(.tooLarge); return }
        event(["requestId": current.requestID, "type": "limit"])
    }
    func failed() { failRecording(.failed) }
    private func failRecording(_ error: VoiceCaptureError) {
        guard let current = capture else { return }
        let completion = current.startCompletion; current.startCompletion = nil
        dispose(); completion?(.failure(error))
        event(["requestId": current.requestID, "type": "error", "error": error.rawValue])
    }
    func stop(_ requestID: String) throws -> VoiceCaptureResult {
        guard Self.validID(requestID) else { throw VoiceCaptureError.invalidID }
        guard let current = capture, current.requestID == requestID else { throw VoiceCaptureError.notRecording }
        guard foreground() else { cancelCurrent(); throw VoiceCaptureError.foreground }
        guard current.phase == .recording || current.phase == .ready else { cancelCurrent(); throw VoiceCaptureError.notRecording }
        if current.phase == .recording { current.durationMS = min(120000, max(0, Int(backend.duration * 1000))) }
        capture = nil // Ignore recorder delegate callbacks during stop.
        backend.stop()
        defer { try? FileManager.default.removeItem(at: current.url) }
        guard fileSize(current.url) <= Self.maximumBytes else { throw VoiceCaptureError.tooLarge }
        guard let data = try? Data(contentsOf: current.url), !data.isEmpty, current.durationMS > 0 else { throw VoiceCaptureError.empty }
        guard data.count <= Self.maximumBytes else { throw VoiceCaptureError.tooLarge }
        return VoiceCaptureResult(requestID: requestID, data: data, durationMS: current.durationMS)
    }
    func cancel(_ requestID: String) throws {
        guard Self.validID(requestID) else { throw VoiceCaptureError.invalidID }
        if capture?.requestID == requestID { cancelCurrent() }
    }
    func cancelCurrent() {
        guard let current = capture else { return }
        let completion = current.startCompletion; current.startCompletion = nil
        dispose(); completion?(.failure(.cancelled))
        event(["requestId": current.requestID, "type": "cancelled"])
    }
    func resignedActive() {
        // Permission sheets are inactive too. Pending requests only cancel on
        // actual background/interruption; active recording always stops now.
        if !awaitingPermission { cancelCurrent() }
    }
    func dispose() {
        let current = capture; capture = nil
        backend.stop()
        if let current { try? FileManager.default.removeItem(at: current.url) }
    }
}
