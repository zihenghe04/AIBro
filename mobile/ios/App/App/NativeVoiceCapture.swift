import Foundation
import AVFoundation
import UIKit

private final class AudioRecorderBackend: NSObject, VoiceCaptureBackend, AVAudioRecorderDelegate {
    private var recorder: AVAudioRecorder?
    private var ownsSession = false
    private var lastDuration: TimeInterval = 0
    var finished: ((Bool) -> Void)?
    var duration: TimeInterval { recorder?.currentTime ?? lastDuration }

    func start(url: URL, maximumDuration: TimeInterval) throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .default, options: [.allowBluetoothHFP])
        try session.setActive(true); ownsSession = true
        let audio = try AVAudioRecorder(url: url, settings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16000,
            AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64000,
        ])
        recorder = audio; lastDuration = 0; audio.delegate = self
        guard audio.prepareToRecord(), audio.record(forDuration: maximumDuration) else { throw VoiceCaptureError.failed }
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
    }
    func stop() {
        if let recorder { lastDuration = max(lastDuration, recorder.currentTime); recorder.delegate = nil; recorder.stop() }
        recorder = nil
        if ownsSession { try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation]); ownsSession = false }
    }
    func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { [weak self] in self?.audioRecorderDidFinishRecording(recorder, successfully: flag) }
            return
        }
        guard self.recorder === recorder else { return }
        // currentTime resets after automatic stop; the file duration is retained.
        if let player = try? AVAudioPlayer(contentsOf: recorder.url) { lastDuration = player.duration }
        self.recorder = nil
        if ownsSession { try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation]); ownsSession = false }
        finished?(flag)
    }
    func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { [weak self] in self?.audioRecorderEncodeErrorDidOccur(recorder, error: nil) }
            return
        }
        guard self.recorder === recorder else { return }
        finished?(false)
    }
    deinit { stop() }
}

final class NativeVoiceCapture {
    static let shared = NativeVoiceCapture()
    var event: (([String: Any]) -> Void)?
    private let backend = AudioRecorderBackend()
    private var core: VoiceCaptureCore?
    private var observers: [NSObjectProtocol] = []
    private var timer: Timer?
    var recording: Bool { core?.recording == true }
    var microphonePermission: String {
        switch AVAudioSession.sharedInstance().recordPermission {
        case .granted: return "granted"
        case .denied: return "denied"
        default: return "prompt"
        }
    }
    private init() {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("aibro-voice-capture", isDirectory: true)
        core = try? VoiceCaptureCore(directory: directory, backend: backend,
            foreground: { UIApplication.shared.applicationState == .active },
            permission: { completion in
                let deliver: (Bool) -> Void = { granted in DispatchQueue.main.async { completion(granted) } }
                if #available(iOS 17, *) { AVAudioApplication.requestRecordPermission(completionHandler: deliver) }
                else { AVAudioSession.sharedInstance().requestRecordPermission(deliver) }
            }, event: { [weak self] event in self?.timer?.invalidate(); self?.timer = nil; self?.event?(event) })
        backend.finished = { [weak self] success in
            if success { self?.core?.reachedLimit() } else { self?.core?.failed() }
        }
        observe(UIApplication.willResignActiveNotification) { $0.core?.resignedActive() }
        observe(UIApplication.didEnterBackgroundNotification) { $0.core?.cancelCurrent() }
        observe(UIApplication.didBecomeActiveNotification) { $0.core?.becameActive() }
        observe(UIApplication.willTerminateNotification) { $0.core?.cancelCurrent() }
        observe(AVAudioSession.interruptionNotification) { $0.core?.cancelCurrent() }
        observe(AVAudioSession.mediaServicesWereResetNotification) { $0.core?.cancelCurrent() }
        // Switching/unplugging an input invalidates the user's recording context.
        observers.append(NotificationCenter.default.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            guard let reason = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                  reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue else { return }
            self?.core?.cancelCurrent()
        })
    }
    private func observe(_ name: Notification.Name, action: @escaping (NativeVoiceCapture) -> Void) {
        observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in if let self { action(self) } })
    }
    func start(_ id: String, completion: @escaping (Result<Void, VoiceCaptureError>) -> Void) {
        guard let core else { completion(.failure(.failed)); return }
        core.start(id) { [weak self] result in
            if case .success = result {
                self?.timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.core?.poll() }
            }
            completion(result)
        }
    }
    func stop(_ id: String) throws -> VoiceCaptureResult {
        guard let core else { throw VoiceCaptureError.failed }
        defer { if !core.recording { timer?.invalidate(); timer = nil } }
        return try core.stop(id)
    }
    func cancel(_ id: String) throws { try core?.cancel(id) }
    func cancelAll() { core?.cancelCurrent(); timer?.invalidate(); timer = nil }
    deinit { timer?.invalidate(); observers.forEach(NotificationCenter.default.removeObserver); core?.dispose() }
}
