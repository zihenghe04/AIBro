import AppKit
import AVFoundation
import Darwin

/// This driver never requests permission. Its owner chooses it only for an
/// explicit, already-authorized realtime recording; local-only keeps its recorder.
@MainActor final class NativeQuickRealtimeASRAudio {
    typealias PCMHandler = @Sendable (Data) -> Void
    typealias FailureHandler = @Sendable () -> Void
    struct Receipt: Sendable {
        let duration: TimeInterval
        let bytes: Int
        let interrupted: Bool
        let streamInterrupted: Bool
    }
    private var engine: AVAudioEngine?
    private var pipeline: NativeQuickRealtimeASRAudioPipeline?
    private var observer: NSObjectProtocol?
    private var tapped = false
    private var paused = false
    private var stopping: Task<Receipt, Never>?
    private var lastDuration: TimeInterval = 0
    private var token = UUID()
    var elapsed: TimeInterval { pipeline?.snapshot.duration ?? lastDuration }
    var level: Double { paused ? 0 : pipeline?.snapshot.level ?? 0 }

    func start(url: URL, onPCM: @escaping PCMHandler, onFailure: @escaping FailureHandler,
               onStreamFailure: @escaping FailureHandler = {}) throws {
        guard engine == nil, pipeline == nil, stopping == nil,
              AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else { throw AudioError.unavailable }
        let session = UUID(); token = session
        let next = AVAudioEngine(), input = next.inputNode
        let format = input.outputFormat(forBus: 0)
        let writer = try NativeQuickRealtimeASRAudioPipeline(url: url, inputFormat: format,
            onPCM: onPCM, onFailure: { [weak self] in
                Task { @MainActor in
                    guard let self, self.token == session else { return }
                    self.haltCapture(); onFailure()
                }
            }, onStreamFailure: onStreamFailure)
        engine = next; pipeline = writer; paused = false
        let frames = AVAudioFrameCount(ceil(format.sampleRate * 0.1))
        input.installTap(onBus: 0, bufferSize: frames, format: format) { buffer, _ in writer.enqueue(buffer) }
        tapped = true
        do {
            next.prepare(); try next.start()
            observer = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: next, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, self.token == session, self.stopping == nil else { return }
                    // Changing devices invalidates the tap format. Retain this
                    // file rather than silently mixing formats or restarting.
                    writer.interrupt()
                }
            }
        } catch {
            haltCapture(); writer.interrupt(); throw error
        }
    }
    func pause() {
        guard stopping == nil, let engine, let pipeline, !paused else { return }
        engine.pause(); pipeline.setPaused(true); paused = true
    }
    func resume() throws {
        guard stopping == nil, let engine, let pipeline, paused, !pipeline.snapshot.interrupted else { throw AudioError.unavailable }
        guard engine.inputNode.outputFormat(forBus: 0).isEqual(pipeline.inputFormat) else { pipeline.interrupt(); throw AudioError.formatChanged }
        pipeline.setPaused(false)
        do { try engine.start(); paused = false }
        catch { pipeline.setPaused(true); pipeline.interrupt(); throw error }
    }
    func stop() async -> Receipt {
        if let stopping { return await stopping.value }
        guard let pipeline else { return .init(duration: lastDuration, bytes: 0, interrupted: true, streamInterrupted: false) }
        haltCapture()
        let work = Task { await pipeline.finish() }; stopping = work
        let receipt = await work.value
        lastDuration = receipt.duration; self.pipeline = nil
        return receipt
    }
    private func haltCapture() {
        if let observer { NotificationCenter.default.removeObserver(observer); self.observer = nil }
        pipeline?.setPaused(true)
        if tapped { engine?.inputNode.removeTap(onBus: 0); tapped = false }
        engine?.stop(); engine = nil; paused = true
    }
    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        if tapped { engine?.inputNode.removeTap(onBus: 0) }
        engine?.stop(); pipeline?.sealWithoutWaiting()
    }
    enum AudioError: Error { case unavailable, formatChanged }
}

/// Worker-facing stage is also used by synthetic PCM checks, without creating an
/// engine or touching a microphone. Only bounded copies occur in the tap.
final class NativeQuickRealtimeASRAudioPipeline: @unchecked Sendable {
    struct Snapshot { let duration: TimeInterval; let level: Double; let interrupted: Bool }
    typealias Receipt = NativeQuickRealtimeASRAudio.Receipt
    let inputFormat: AVAudioFormat
    private let url: URL
    private let queue = DispatchQueue(label: "app.aibro.recording.file", qos: .userInitiated)
    private let lock = NSLock()
    private var free: [AVAudioPCMBuffer] = []
    private var pending: [AVAudioPCMBuffer] = []
    private var draining = false, receiving = true, sealed = false, interrupted = false
    private var framesWritten: Int64 = 0, measuredLevel: Double = 0
    private var finalized: Receipt?
    private var file: AVAudioFile?
    private var fileFailed = false // accessed only on the file queue
    private let archiveConverter: NativeQuickAudioConverter
    private var pcmConverter: NativeQuickAudioConverter?
    private let delivery: NativeQuickPCMDelivery
    private let onFailure: @Sendable () -> Void
    private let write: (AVAudioFile, AVAudioPCMBuffer) throws -> Void
    private let maximumFrames: AVAudioFrameCount

    init(url: URL, inputFormat: AVAudioFormat, bufferCount: Int = 16,
         onPCM: @escaping @Sendable (Data) -> Void,
         onFailure: @escaping @Sendable () -> Void,
         onStreamFailure: @escaping @Sendable () -> Void = {},
         write: @escaping (AVAudioFile, AVAudioPCMBuffer) throws -> Void = { try $0.write(from: $1) }) throws {
        guard url.isFileURL, inputFormat.sampleRate.isFinite, (8000...192000).contains(inputFormat.sampleRate),
              (1...8).contains(inputFormat.channelCount), inputFormat.commonFormat != .otherFormat else { throw PipelineError.invalidFormat }
        self.url = url; self.inputFormat = inputFormat; self.onFailure = onFailure; self.write = write
        maximumFrames = AVAudioFrameCount(ceil(inputFormat.sampleRate * 0.4))
        guard let archiveFormat = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 1),
              let streamFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true) else { throw PipelineError.invalidFormat }
        archiveConverter = try .init(from: inputFormat, to: archiveFormat)
        pcmConverter = try? .init(from: archiveFormat, to: streamFormat)
        delivery = .init(onPCM: onPCM, onFailure: onStreamFailure)
        let planes = inputFormat.isInterleaved ? 1 : Int(inputFormat.channelCount)
        let bytesPerBuffer = Int(maximumFrames) * Int(inputFormat.streamDescription.pointee.mBytesPerFrame) * planes
        guard bytesPerBuffer > 0, bytesPerBuffer <= 16 * 1024 * 1024 else { throw PipelineError.invalidFormat }
        let count = min(max(2, bufferCount), 16, (32 * 1024 * 1024) / bytesPerBuffer)
        free.reserveCapacity(count); pending.reserveCapacity(count)
        for _ in 0..<count {
            guard let buffer = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: maximumFrames) else { throw PipelineError.invalidFormat }
            free.append(buffer)
        }
        // AVAudioFile's writing initializer overwrites. Reserve a new path first
        // so an existing recording is never replaced by a start/retry.
        let fd = Darwin.open(url.path, O_CREAT | O_EXCL | O_WRONLY, S_IRUSR | S_IWUSR)
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        Darwin.close(fd)
        file = try AVAudioFile(forWriting: url, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 44100, AVNumberOfChannelsKey: 1, AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        if pcmConverter == nil { delivery.fail() }
    }
    var snapshot: Snapshot {
        lock.lock(); defer { lock.unlock() }
        return .init(duration: Double(framesWritten) / 44100, level: measuredLevel, interrupted: interrupted)
    }
    func setPaused(_ value: Bool) {
        lock.lock(); defer { lock.unlock() }
        receiving = !value && !sealed && !interrupted
        if value { measuredLevel = 0 }
    }
    func interrupt() {
        lock.lock(); let notify = !interrupted; interrupted = true; receiving = false; measuredLevel = 0; lock.unlock()
        if notify { DispatchQueue.global(qos: .userInitiated).async(execute: onFailure) }
    }
    func enqueue(_ input: AVAudioPCMBuffer) {
        lock.lock()
        guard receiving, !sealed else { lock.unlock(); return }
        guard input.frameLength > 0 else { lock.unlock(); return }
        guard input.frameLength <= maximumFrames, input.format.isEqual(inputFormat), let owned = free.popLast() else {
            lock.unlock(); interrupt(); return
        }
        owned.frameLength = input.frameLength
        let source = UnsafeMutableAudioBufferListPointer(input.mutableAudioBufferList)
        let destination = UnsafeMutableAudioBufferListPointer(owned.mutableAudioBufferList)
        let bytes = Int(input.frameLength) * Int(inputFormat.streamDescription.pointee.mBytesPerFrame)
        guard source.count == destination.count, zip(source, destination).allSatisfy({ $0.mData != nil && $1.mData != nil && Int($0.mDataByteSize) >= bytes && Int($1.mDataByteSize) >= bytes }) else {
            free.append(owned); lock.unlock(); interrupt(); return
        }
        for index in source.indices { memcpy(destination[index].mData!, source[index].mData!, bytes) }
        pending.append(owned)
        if !draining {
            draining = true
            // Schedule while holding the tiny queue lock so stop cannot overtake
            // a buffer that has already been accepted from the tap.
            queue.async { [self] in drain() }
        }
        lock.unlock()
    }
    private func drain() {
        while true {
            lock.lock()
            guard !pending.isEmpty else { draining = false; lock.unlock(); return }
            let input = pending.removeFirst(); lock.unlock()
            if !fileFailed {
                do { for output in try archiveConverter.convert(input) { try appendArchive(output) } }
                catch { fileFailed = true; interrupt() }
            }
            lock.lock(); free.append(input); lock.unlock()
        }
    }
    private func appendArchive(_ buffer: AVAudioPCMBuffer) throws {
        guard let file else { throw PipelineError.closed }
        try write(file, buffer)
        var sum: Double = 0
        if let samples = buffer.floatChannelData?[0] { for i in 0..<Int(buffer.frameLength) { let v = Double(samples[i]); sum += v * v } }
        lock.lock(); framesWritten += Int64(buffer.frameLength)
        measuredLevel = receiving ? min(1, sqrt(sum / Double(max(1, buffer.frameLength)))) : 0; lock.unlock()
        if let pcmConverter {
            do { for output in try pcmConverter.convert(buffer) { emit(output) } }
            catch { self.pcmConverter = nil; delivery.fail() }
        }
    }
    private func emit(_ buffer: AVAudioPCMBuffer) {
        guard buffer.frameLength > 0, let samples = buffer.int16ChannelData?[0] else { return }
        // macOS supported architectures are little-endian; the converter emits
        // signed PCM16 mono at exactly 16 kHz, not float or WAV framing.
        delivery.enqueue(Data(bytes: samples, count: Int(buffer.frameLength) * MemoryLayout<Int16>.size))
    }
    private func finalizeOnQueue() -> Receipt {
        if let finalized { return finalized }
        if !fileFailed {
            do { for output in try archiveConverter.finish() { try appendArchive(output) } }
            catch { fileFailed = true; interrupt() }
        }
        if let pcmConverter {
            do { for output in try pcmConverter.finish() { emit(output) } }
            catch { delivery.fail() }
        }
        pcmConverter = nil
        // Releasing AVAudioFile finalizes AAC/container headers also on macOS 14.
        file = nil
        var bytes = 0
        do {
            let handle = try FileHandle(forWritingTo: url); defer { try? handle.close() }
            try handle.synchronize()
            bytes = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            if bytes == 0 || snapshot.duration == 0 { interrupt() }
        } catch { interrupt() }
        let state = snapshot
        let result = Receipt(duration: state.duration, bytes: bytes, interrupted: state.interrupted, streamInterrupted: delivery.failed)
        finalized = result; return result
    }
    func sealWithoutWaiting() {
        lock.lock(); guard !sealed else { lock.unlock(); return }; sealed = true; receiving = false
        queue.async { [self] in _ = finalizeOnQueue() }; lock.unlock()
    }
    func finish() async -> Receipt {
        let local: Receipt = await withCheckedContinuation { continuation in
            lock.lock(); sealed = true; receiving = false
            queue.async { [self] in continuation.resume(returning: finalizeOnQueue()) }; lock.unlock()
        }
        let streamed = await delivery.finish(timeout: 0.5)
        return .init(duration: local.duration, bytes: local.bytes, interrupted: local.interrupted, streamInterrupted: local.streamInterrupted || !streamed)
    }
    enum PipelineError: Error { case invalidFormat, closed, conversion }
}

private final class NativeQuickAudioConverter {
    private let converter: AVAudioConverter
    private let output: AVAudioFormat
    private let ratio: Double
    private var ended = false
    init(from input: AVAudioFormat, to output: AVAudioFormat) throws {
        guard let converter = AVAudioConverter(from: input, to: output) else { throw NativeQuickRealtimeASRAudioPipeline.PipelineError.invalidFormat }
        self.converter = converter; self.output = output; ratio = output.sampleRate / input.sampleRate
        converter.downmix = true; converter.sampleRateConverterQuality = AVAudioQuality.medium.rawValue
        converter.primeMethod = .none
    }
    func convert(_ input: AVAudioPCMBuffer) throws -> [AVAudioPCMBuffer] { try process(input, final: false) }
    func finish() throws -> [AVAudioPCMBuffer] { try process(nil, final: true) }
    private func process(_ input: AVAudioPCMBuffer?, final: Bool) throws -> [AVAudioPCMBuffer] {
        guard !ended else { return [] }
        let capacity = AVAudioFrameCount(max(1024, ceil(Double(input?.frameLength ?? 1024) * ratio) + 128))
        var supplied = false, result: [AVAudioPCMBuffer] = []
        for _ in 0..<32 {
            guard let buffer = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { throw NativeQuickRealtimeASRAudioPipeline.PipelineError.conversion }
            var error: NSError?
            let status = converter.convert(to: buffer, error: &error) { _, state in
                if !supplied, let input { supplied = true; state.pointee = .haveData; return input }
                state.pointee = final ? .endOfStream : .noDataNow; return nil
            }
            if let error { throw error }
            guard status != .error else { throw NativeQuickRealtimeASRAudioPipeline.PipelineError.conversion }
            if buffer.frameLength > 0 { result.append(buffer) }
            if status == .endOfStream { ended = true; return result }
            if status == .inputRanDry { return result }
            if buffer.frameLength == 0 { throw NativeQuickRealtimeASRAudioPipeline.PipelineError.conversion }
        }
        throw NativeQuickRealtimeASRAudioPipeline.PipelineError.conversion
    }
}

/// Consumer/network stalls may lose realtime transcript, never local audio.
/// Retention is bounded to 30 seconds of PCM; a gap is reported once explicitly.
private final class NativeQuickPCMDelivery: @unchecked Sendable {
    private let queue = DispatchQueue(label: "app.aibro.recording.pcm", qos: .userInitiated)
    private let lock = NSLock()
    private var queued = 0, stopped = false, gap = false
    private let onPCM: @Sendable (Data) -> Void
    private let onFailure: @Sendable () -> Void
    init(onPCM: @escaping @Sendable (Data) -> Void, onFailure: @escaping @Sendable () -> Void) { self.onPCM = onPCM; self.onFailure = onFailure }
    var failed: Bool { lock.lock(); defer { lock.unlock() }; return gap }
    func fail() {
        lock.lock(); let notify = !gap; gap = true; lock.unlock()
        if notify { DispatchQueue.global(qos: .userInitiated).async(execute: onFailure) }
    }
    func enqueue(_ data: Data) {
        lock.lock()
        guard !stopped, !gap else { lock.unlock(); return }
        guard queued + data.count <= 16000 * 2 * 30 else { lock.unlock(); fail(); return }
        queued += data.count
        queue.async { [self] in
            lock.lock(); let send = !gap; lock.unlock()
            if send { onPCM(data) }
            lock.lock(); queued -= data.count; lock.unlock()
        }
        lock.unlock()
    }
    func finish(timeout: TimeInterval) async -> Bool {
        await withCheckedContinuation { continuation in
            let waiter = Waiter(continuation)
            lock.lock(); stopped = true
            queue.async { [self] in _ = waiter.resolve(!failed) }
            lock.unlock()
            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + timeout) { [self] in
                if waiter.resolve(false) { fail() }
            }
        }
    }
    private final class Waiter: @unchecked Sendable {
        private let lock = NSLock()
        private var continuation: CheckedContinuation<Bool, Never>?
        init(_ continuation: CheckedContinuation<Bool, Never>) { self.continuation = continuation }
        func resolve(_ result: Bool) -> Bool {
            lock.lock(); let reply = continuation; continuation = nil; lock.unlock()
            reply?.resume(returning: result); return reply != nil
        }
    }
}
