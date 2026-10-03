import AppKit
import AVFoundation

struct NativeQuickMirrorDevice: Identifiable, Equatable, Sendable {
    enum Kind: Int, Sendable { case builtIn, external, continuity, virtual }
    let id: String
    let name: String
    let kind: Kind
    static func rank(_ devices: [Self], preferred: String?) -> [Self] {
        var seen = Set<String>()
        return devices.enumerated().filter { !$0.element.id.isEmpty && seen.insert($0.element.id).inserted }
            .sorted {
                let a = $0.element.id == preferred ? -1 : $0.element.kind.rawValue
                let b = $1.element.id == preferred ? -1 : $1.element.kind.rawValue
                return a == b ? $0.offset < $1.offset : a < b
            }.map(\.element)
    }
}

enum NativeQuickMirrorFrameResult: Equatable, Sendable { case frame, unavailable, timedOut, cancelled }
protocol NativeQuickMirrorCameraDriving: AnyObject {
    var session: AVCaptureSession? { get }
    func devices() async -> [NativeQuickMirrorDevice]
    func start(deviceID: String, completion: @escaping @Sendable (NativeQuickMirrorFrameResult) -> Void,
               interrupted: @escaping @Sendable () -> Void)
    func stop()
}

/// Each output delegate owns an immutable attempt ID: buffered frames from an
/// old input can never acknowledge a newer camera. No frame bytes leave AVFoundation.
final class NativeQuickMirrorFrameGate: @unchecked Sendable {
    private let lock = NSLock()
    private var id: UUID?
    private var callback: (@Sendable (NativeQuickMirrorFrameResult) -> Void)?
    func begin(_ id: UUID, callback: @escaping @Sendable (NativeQuickMirrorFrameResult) -> Void) {
        lock.lock(); let old = self.callback; self.id = id; self.callback = callback; lock.unlock()
        old?(.cancelled)
    }
    @discardableResult func finish(_ id: UUID, _ result: NativeQuickMirrorFrameResult) -> Bool {
        lock.lock()
        guard self.id == id, let reply = callback else { lock.unlock(); return false }
        callback = nil; lock.unlock(); reply(result); return true
    }
    func current(_ id: UUID) -> Bool { lock.lock(); defer { lock.unlock() }; return self.id == id }
    func cancel() { lock.lock(); id = nil; let reply = callback; callback = nil; lock.unlock(); reply?(.cancelled) }
}

final class NativeQuickMirrorCamera: NSObject, NativeQuickMirrorCameraDriving, @unchecked Sendable {
    private let capture = AVCaptureSession()
    var session: AVCaptureSession? { capture }
    private let queue = DispatchQueue(label:"app.aibro.mirror.capture",qos:.userInitiated)
    private let frameQueue = DispatchQueue(label:"app.aibro.mirror.first-frame",qos:.userInitiated)
    private let gate = NativeQuickMirrorFrameGate()
    private var outputDelegate: FirstFrame?
    private var runtimeObserver: NSObjectProtocol?
    final class FirstFrame: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
        let callback: @Sendable () -> Void
        init(_ callback: @escaping @Sendable () -> Void) { self.callback = callback }
        func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
            guard CMSampleBufferDataIsReady(sampleBuffer), CMSampleBufferGetImageBuffer(sampleBuffer) != nil else { return }
            callback()
        }
    }
    static func list() -> [AVCaptureDevice] {
        AVCaptureDevice.DiscoverySession(deviceTypes:[.builtInWideAngleCamera,.external,.continuityCamera],mediaType:.video,position:.unspecified).devices
    }
    func devices() async -> [NativeQuickMirrorDevice] {
        await withCheckedContinuation { reply in queue.async {
            reply.resume(returning:Self.list().map { device in
                let name = device.localizedName
                let virtual = name.range(of:"virtual|虚拟|filteronme|尚镜|snap camera|mmhmm|manycam|xsplit|camo\\b|camtwist|ecamm|nvidia broadcast",options:[.regularExpression,.caseInsensitive]) != nil
                let kind: NativeQuickMirrorDevice.Kind = virtual ? .virtual : device.deviceType == .builtInWideAngleCamera ? .builtIn : device.deviceType == .continuityCamera ? .continuity : .external
                return .init(id:device.uniqueID,name:name,kind:kind)
            })
        }}
    }
    func start(deviceID: String, completion: @escaping @Sendable (NativeQuickMirrorFrameResult) -> Void,
               interrupted: @escaping @Sendable () -> Void) {
        let attempt = UUID(); gate.begin(attempt,callback:completion)
        // This deadline does not sit behind a potentially blocking startRunning.
        // A late OS return checks the revoked attempt before it can publish live.
        DispatchQueue.global(qos:.userInitiated).asyncAfter(deadline:.now()+3) { [weak self] in
            guard let self, self.gate.finish(attempt,.timedOut) else { return }
            self.queue.async { [weak self] in guard let self,self.gate.current(attempt) else{return};self.release() }
        }
        queue.async { [weak self] in
            guard let self,self.gate.current(attempt) else { return }
            self.release()
            guard AVCaptureDevice.authorizationStatus(for:.video) == .authorized,
                  let device = Self.list().first(where:{$0.uniqueID == deviceID}),
                  let input = try? AVCaptureDeviceInput(device:device) else {
                self.gate.finish(attempt,.unavailable); return
            }
            self.capture.beginConfiguration(); self.capture.sessionPreset = .medium
            let output = AVCaptureVideoDataOutput(); output.alwaysDiscardsLateVideoFrames = true
            guard self.capture.canAddInput(input),self.capture.canAddOutput(output) else {
                self.capture.commitConfiguration();self.gate.finish(attempt,.unavailable);return
            }
            let delegate = FirstFrame { [weak self] in self?.gate.finish(attempt,.frame) }
            self.outputDelegate = delegate; output.setSampleBufferDelegate(delegate,queue:self.frameQueue)
            self.capture.addInput(input);self.capture.addOutput(output);self.capture.commitConfiguration()
            self.runtimeObserver = NotificationCenter.default.addObserver(forName:AVCaptureSession.runtimeErrorNotification,object:self.capture,queue:nil) { [weak self] _ in
                guard let self,self.gate.current(attempt) else{return}
                if !self.gate.finish(attempt,.unavailable) { interrupted() }
            }
            guard self.gate.current(attempt) else { self.release();return }
            self.capture.startRunning()
            if !self.gate.current(attempt) { self.release() }
        }
    }
    private func release() {
        if let observer = runtimeObserver { NotificationCenter.default.removeObserver(observer); runtimeObserver = nil }
        capture.stopRunning(); capture.beginConfiguration()
        capture.inputs.forEach { capture.removeInput($0) }
        capture.outputs.forEach { if let output = $0 as? AVCaptureVideoDataOutput { output.setSampleBufferDelegate(nil,queue:nil) }; capture.removeOutput($0) }
        capture.commitConfiguration(); outputDelegate = nil
    }
    func stop() { gate.cancel(); queue.async { [weak self] in self?.release() } }
    deinit { if let observer = runtimeObserver { NotificationCenter.default.removeObserver(observer) };gate.cancel() }
}
