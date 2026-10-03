import Foundation
import AVFoundation

@MainActor protocol NativeSpeechDictationRecording: AnyObject {
    var elapsed: TimeInterval { get }
    var level: Double { get }
    var onFailure: (() -> Void)? { get set }
    func start(at url: URL) throws
    func stop()
}

/// A temporary recording, deliberately separate from the recording library.
/// Constructing this adapter never opens a device or asks for permission.
@MainActor final class NativeSpeechDictationRecorder: NSObject, NativeSpeechDictationRecording, AVAudioRecorderDelegate {
    private var recorder: AVAudioRecorder?
    private var stoppedElapsed: TimeInterval = 0
    var onFailure: (() -> Void)?
    var elapsed: TimeInterval { recorder?.currentTime ?? stoppedElapsed }
    var level:Double {
        guard let recorder,recorder.isRecording else{return 0}
        recorder.updateMeters()
        return min(1,max(0,pow(10,Double(recorder.averagePower(forChannel:0))/20)))
    }
    static func requestPermission() async -> Bool {
        guard Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription") != nil else { return false }
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
        default: return false
        }
    }
    func start(at url: URL) throws {
        guard recorder == nil else { throw NativeSpeechError.unavailable }
        let next = try AVAudioRecorder(url: url, settings: [AVFormatIDKey:kAudioFormatMPEG4AAC,
            AVSampleRateKey:16000,AVNumberOfChannelsKey:1,AVEncoderAudioQualityKey:AVAudioQuality.high.rawValue])
        next.delegate = self
        next.isMeteringEnabled = true
        guard next.prepareToRecord(),next.record() else { next.delegate=nil;next.stop();throw NativeSpeechError.invalidAudio }
        do { try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:url.path) }
        catch { next.delegate=nil;next.stop();throw NativeSpeechError.invalidAudio }
        recorder=next;stoppedElapsed=0
    }
    func stop() {
        guard let current=recorder else{return}
        stoppedElapsed=current.currentTime;recorder=nil;current.delegate=nil;current.stop()
    }
    nonisolated func audioRecorderDidFinishRecording(_ recorder:AVAudioRecorder,successfully flag:Bool) {
        Task { @MainActor [weak self] in
            guard let self,self.recorder === recorder else{return}
            self.stop();self.onFailure?()
        }
    }
    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder:AVAudioRecorder,error:Error?) {
        Task { @MainActor [weak self] in
            guard let self,self.recorder === recorder else{return}
            self.stop();self.onFailure?()
        }
    }
}
