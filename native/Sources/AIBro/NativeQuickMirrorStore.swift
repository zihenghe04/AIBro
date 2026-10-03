import AppKit
import AVFoundation
import Combine
import UniformTypeIdentifiers

@MainActor final class NativeQuickMirrorStore: ObservableObject {
    typealias Observe = @MainActor (@escaping @MainActor () -> Void) -> (() -> Void)
    typealias CoverDecoder = @Sendable (URL) async throws -> Data
    @Published private(set) var active = false
    @Published private(set) var starting = false
    @Published private(set) var error: String?
    @Published private(set) var available = false
    @Published private(set) var ready = false
    @Published private(set) var saving = false
    @Published private(set) var devices: [NativeQuickMirrorDevice] = []
    @Published private(set) var preferredCameraID: String?
    @Published private(set) var cameraID: String?
    @Published private(set) var cover: NSImage?
    @Published var zoom: Double = 1
    private let engine: NativeQuickMirrorCameraDriving
    private let permission: () -> AVAuthorizationStatus
    private let requestPermission: () async -> Bool
    private let hasUsageDescription: () -> Bool
    private let observe: Observe
    private let decodeCover: CoverDecoder
    private var stopObserving: (() -> Void)?
    private var archive: NativeQuickMirrorArchive?
    private var directory: URL?
    private var preferences = NativeQuickMirrorPreferences()
    private var writeLease = NativeQuickMirrorWriteLease()
    private var visible = false
    private var generation: UInt64 = 0
    private var accessGeneration: UInt64 = 0
    private var inventoryGeneration: UInt64 = 0
    private var requested = false
    private var picker: NSOpenPanel?
    private var pendingCover: UUID?
    private var coverDecodeTask: Task<Data,Error>?
    var session: AVCaptureSession? { engine.session }
    var controlsEnabled: Bool { ready && available && visible && !saving }
    var cameraName: String? { devices.first(where:{$0.id == cameraID})?.name }

    init(engine: NativeQuickMirrorCameraDriving = NativeQuickMirrorCamera(),
         permission: @escaping () -> AVAuthorizationStatus = { AVCaptureDevice.authorizationStatus(for:.video) },
         requestPermission: @escaping () async -> Bool = { await AVCaptureDevice.requestAccess(for:.video) },
         hasUsageDescription: @escaping () -> Bool = { Bundle.main.object(forInfoDictionaryKey:"NSCameraUsageDescription") != nil },
         observe: @escaping Observe = NativeQuickMirrorStore.observeDevices,
         decodeCover: @escaping CoverDecoder = { url in
             let work = Task.detached(priority:.userInitiated) {
                 try Task.checkCancellation();let data = try NativeQuickMirrorArchive.cover(from:url)
                 try Task.checkCancellation();return data
             }
             return try await withTaskCancellationHandler(operation: { try await work.value }, onCancel: { work.cancel() })
         }) {
        self.engine = engine;self.permission = permission;self.requestPermission = requestPermission
        self.hasUsageDescription = hasUsageDescription;self.observe = observe;self.decodeCover = decodeCover
    }
    static func observeDevices(_ changed: @escaping @MainActor () -> Void) -> (() -> Void) {
        let tokens = [AVCaptureDevice.wasConnectedNotification, AVCaptureDevice.wasDisconnectedNotification].map { name in
            NotificationCenter.default.addObserver(forName:name,object:nil,queue:.main) { _ in Task { @MainActor in changed() } }
        }
        return { tokens.forEach { NotificationCenter.default.removeObserver($0) } }
    }
    func configure(directory: URL) {
        let value = directory.standardizedFileURL
        guard self.directory != value else { return }
        stop();stopObserving?();stopObserving = nil;cancelCoverDecode();picker?.cancel(nil);picker = nil;writeLease.revoke();writeLease = .init()
        accessGeneration &+= 1; inventoryGeneration &+= 1
        self.directory = value; archive = NativeQuickMirrorArchive(directory:value)
        ready = false;saving = false;cover = nil;devices = [];preferences = .init();preferredCameraID = nil;error = nil
        if available { Task { await reload() } }
    }
    func setAvailable(_ value: Bool) {
        guard available != value else { return };available = value;accessGeneration &+= 1
        writeLease.revoke();writeLease = .init();inventoryGeneration &+= 1
        if !value {
            stop();stopObserving?();stopObserving = nil;cancelCoverDecode();picker?.cancel(nil);picker = nil
            cover = nil;devices = [];preferredCameraID = nil;ready = false;saving = false;error = nil;preferences = .init()
        } else { Task { await reload() } }
    }
    func setVisible(_ value: Bool) {
        visible = value
        if !value { stop();stopObserving?();stopObserving = nil;inventoryGeneration &+= 1;cancelCoverDecode();picker?.cancel(nil);picker = nil }
        else { reconcileObservation() }
    }
    private func reconcileObservation() {
        guard visible,available,ready else{return}
        if stopObserving == nil { stopObserving = observe { [weak self] in Task { await self?.refreshDevices() } } }
        Task { await refreshDevices() }
    }
    func reload() async {
        guard available,let archive else{return};let owner = accessGeneration
        do {
            let value = try await archive.load()
            let image = await archive.preview(value)
            guard available,owner == accessGeneration else{return}
            preferences = value;preferredCameraID = value.cameraID;cover = image.map { NSImage(cgImage:$0.image,size:.zero) };ready = true;error = nil
            reconcileObservation()
        } catch {
            guard available,owner == accessGeneration else{return}
            self.error = nativeUI("镜子设置无法读取，原文件已保留。", "Mirror settings could not be read. The original file is retained.")
        }
    }
    func refreshDevices() async {
        guard available,visible,ready else{return}
        guard permission() == .authorized else { if active || starting { stop() };devices = [];return }
        inventoryGeneration &+= 1;let token = inventoryGeneration,owner = accessGeneration
        let result = await engine.devices()
        guard token == inventoryGeneration,owner == accessGeneration,available,visible else{return}
        guard permission() == .authorized else { stop();devices = [];return }
        devices = NativeQuickMirrorDevice.rank(result,preferred:nil)
        // Refreshing an idle/stopped mirror never starts a device. Only loss of
        // the current explicit session can use the remaining ranked candidates.
        if requested,let cameraID,!devices.contains(where:{$0.id == cameraID}) {
            stop();let restartGeneration = generation
            Task { [weak self] in
                guard let self,self.generation == restartGeneration,self.accessGeneration == owner,
                      self.visible,self.available else{return}
                await self.toggle()
            }
        }
    }
    func stop() {
        generation &+= 1;requested = false;engine.stop();active = false;starting = false;cameraID = nil;zoom = 1
    }
    func toggle() async {
        if active || starting { stop();return }
        guard controlsEnabled else{return}
        guard hasUsageDescription() else { error = nativeUI("此安装包缺少摄像头权限说明，请更新 AI Bro。", "This build is missing its camera permission description. Update AI Bro.");return }
        generation &+= 1;let token = generation,owner = accessGeneration
        requested = true;starting = true;error = nil
        let allowed: Bool
        switch permission() {
        case .authorized: allowed = true
        case .notDetermined: allowed = await requestPermission()
        default: allowed = false
        }
        guard valid(token,owner) else{return}
        guard allowed else { stop();error = nativeUI("请在系统设置 → 隐私与安全性 → 摄像头中允许 AI Bro。", "Allow AI Bro in System Settings → Privacy & Security → Camera.");return }
        let found = await engine.devices()
        guard valid(token,owner) else{return}
        devices = NativeQuickMirrorDevice.rank(found,preferred:nil)
        let candidates = NativeQuickMirrorDevice.rank(devices,preferred:preferredCameraID)
        for camera in candidates {
            guard valid(token,owner) else{return}
            cameraID = camera.id
            let result = await withCheckedContinuation { continuation in
                engine.start(deviceID:camera.id,completion:{ continuation.resume(returning:$0) },interrupted:{ [weak self] in
                    Task { @MainActor in
                        guard let self,self.valid(token,owner) else{return}
                        self.stop();self.error = nativeUI("相机预览中断，已关闭。请重新开始。", "Camera preview was interrupted and closed. Start again to retry.")
                    }
                })
            }
            guard valid(token,owner) else{return}
            if result == .frame,permission() == .authorized { starting = false;active = true;zoom = 1;return }
            engine.stop()
        }
        guard valid(token,owner) else{return}
        stop();error = nativeUI("没有收到相机画面。已停止开启请求，可检查连接后重试。", "No camera frames arrived. The opening request has stopped; check the connection and retry.")
    }
    private func valid(_ token: UInt64,_ owner: UInt64) -> Bool {
        token == generation && owner == accessGeneration && requested && available && visible && ready
    }
    func chooseCamera(_ id: String?) async {
        guard controlsEnabled,id == nil || devices.contains(where:{$0.id == id}) else{return}
        var value = preferences;value.cameraID = id
        let token = generation,wasRequested = requested
        guard await save(value) else{return}
        if wasRequested,requested,token == generation,visible { stop();await toggle() }
    }
    func resetCover() async { guard controlsEnabled else{return};var value = preferences;value.coverJPEG = nil;_ = await save(value) }
    private func cancelCoverDecode() {
        if pendingCover != nil { pendingCover = nil;saving = false;coverDecodeTask?.cancel();coverDecodeTask = nil }
    }
    func importCover(_ url: URL) async {
        guard controlsEnabled else{return};let owner = accessGeneration
        let request = UUID();pendingCover = request;saving = true
        let decode = Task { try await decodeCover(url) };coverDecodeTask = decode
        do {
            let data = try await decode.value
            guard pendingCover == request,owner == accessGeneration,available,visible else { return }
            pendingCover = nil;coverDecodeTask = nil
            saving = false;var value = preferences;value.coverJPEG = data;_ = await save(value)
        } catch {
            guard pendingCover == request,owner == accessGeneration,available,visible else{return}
            pendingCover = nil;coverDecodeTask = nil;saving = false
            self.error = nativeUI("请选择有效图片（不超过25MB、6000万像素）。原封面未更改。", "Choose a valid image (up to 25MB and 60MP). The previous cover is unchanged.")
        }
    }
    private func save(_ value: NativeQuickMirrorPreferences) async -> Bool {
        guard available,visible,ready,!saving,let archive else{return false}
        saving = true;let owner = accessGeneration,lease = writeLease
        do {
            try await archive.save(value,lease:lease)
            let image = await archive.preview(value)
            guard owner == accessGeneration,available else{return false}
            preferences = value;preferredCameraID = value.cameraID;cover = image.map { NSImage(cgImage:$0.image,size:.zero) };saving = false;error = nil
            return true
        } catch {
            guard owner == accessGeneration,available else{return false};saving = false
            self.error = nativeUI("镜子设置未确认保存，请重试。", "Mirror settings could not be confirmed saved. Retry to save.");return false
        }
    }
    func chooseCover() {
        guard controlsEnabled,picker == nil,let window = NSApp.keyWindow else{return}
        let owner = accessGeneration,panel = NSOpenPanel();picker = panel
        panel.allowedContentTypes = [.png,.jpeg,.heic,.webP];panel.allowsMultipleSelection = false;panel.canChooseDirectories = false
        panel.title = nativeUI("选择镜子封面", "Choose mirror cover")
        panel.beginSheetModal(for:window) { [weak self] response in
            Task { @MainActor in
                guard let self,self.picker === panel else{return};self.picker = nil
                guard response == .OK,owner == self.accessGeneration,self.controlsEnabled,let url = panel.url else{return}
                await self.importCover(url)
            }
        }
    }
}
