import Foundation
import Combine
import AVFoundation
import Speech
import Darwin

struct NativeQuickRecordingItem: Codable, Identifiable, Equatable {
    let id: String
    var title: String
    let createdAt: Date
    var duration: TimeInterval
    var transcript: String
    var state: String
    var deletedAt: Date?
    var category: String? = nil
    var transcriptionState: String? = nil
    var fileName: String { "recording-\(id).m4a" }
}

/// Audio is never removed by a list action. A tombstone makes deletion reversible;
/// failed manifest writes leave the previous collection and audio intact.
struct NativeQuickRecordingArchive {
    private struct Envelope: Codable { let version: Int; let items: [NativeQuickRecordingItem]; var lastBatch: NativeQuickRecordingBatchUndo? = nil; var suggestionDraft: NativeQuickRecordingSuggestionDraft? = nil }
    let directory: URL
    private(set) var items: [NativeQuickRecordingItem] = []
    private(set) var lastBatch: NativeQuickRecordingBatchUndo?
    private(set) var suggestionDraft: NativeQuickRecordingSuggestionDraft?
    private let write: (Data, URL) throws -> Void

    init(directory: URL, write: @escaping (Data, URL) throws -> Void = NativeQuickRecordingArchive.durableWrite) throws {
        self.directory = directory; self.write = write
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        guard try directory.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink != true else { throw CocoaError(.fileReadInvalidFileName) }
        let manifest = directory.appendingPathComponent("index.json")
        if FileManager.default.fileExists(atPath: manifest.path) {
            guard try manifest.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink != true else { throw CocoaError(.fileReadInvalidFileName) }
            let saved = try JSONDecoder().decode(Envelope.self, from: Data(contentsOf: manifest))
            guard saved.version == 1, Set(saved.items.map(\.id)).count == saved.items.count,
                  saved.items.allSatisfy({ Self.validID($0.id) && $0.duration.isFinite && $0.duration >= 0 && ["recording", "ready", "interrupted"].contains($0.state) })
            else { throw CocoaError(.fileReadCorruptFile) }
            if let undo=saved.lastBatch {
                guard Self.validID(undo.id),!undo.targets.isEmpty,Set(undo.targets.map(\.id)).count==undo.targets.count,
                      undo.targets.allSatisfy({Self.validID($0.id) && $0.fingerprint.count==64 && $0.fingerprint.allSatisfy{$0.isHexDigit}}) else{throw CocoaError(.fileReadCorruptFile)}
            }
            if let draft = saved.suggestionDraft { guard draft.valid, saved.items.contains(where: {$0.id == draft.id}) else { throw CocoaError(.fileReadCorruptFile) } }
            items = saved.items; lastBatch = saved.lastBatch; suggestionDraft = saved.suggestionDraft
        }
        // A process can exit after closing audio but before acknowledging its
        // manifest. Expose the retained file as interrupted, never as completed.
        var recovered = items.map { item -> NativeQuickRecordingItem in
            var value = item
            if value.state == "recording" { value.state = "interrupted" }
            return value
        }
        let known = Set(recovered.map(\.fileName))
        for url in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey, .creationDateKey]) {
            let name = url.lastPathComponent
            guard name.hasPrefix("recording-"), name.hasSuffix(".m4a"), !known.contains(name) else { continue }
            let id = String(name.dropFirst(10).dropLast(4))
            let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .creationDateKey])
            guard Self.validID(id), values.isRegularFile == true, values.isSymbolicLink != true else { continue }
            recovered.append(.init(id: id, title: nativeUI("恢复的录音", "Recovered recording"), createdAt: values.creationDate ?? Date(), duration: 0, transcript: "", state: "interrupted"))
        }
        if recovered != items { try replace(recovered) }
    }

    static func validID(_ id: String) -> Bool { UUID(uuidString: id) != nil && id == id.lowercased() }
    static func durableWrite(_ data: Data, _ url: URL) throws {
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.synchronize()
        let fd = Darwin.open(url.deletingLastPathComponent().path, O_RDONLY)
        guard fd >= 0 else { throw CocoaError(.fileWriteUnknown) }
        defer { Darwin.close(fd) }
        guard Darwin.fsync(fd) == 0 else { throw CocoaError(.fileWriteUnknown) }
    }
    mutating func replace(_ next: [NativeQuickRecordingItem], authorize: () -> Bool = { true }) throws {
        try commit(next,lastBatch:lastBatch,suggestionDraft:suggestionDraft,authorize:authorize)
    }
    private mutating func commit(_ next:[NativeQuickRecordingItem],lastBatch:NativeQuickRecordingBatchUndo?,suggestionDraft:NativeQuickRecordingSuggestionDraft?,authorize:()->Bool) throws {
        guard Set(next.map(\.id)).count==next.count,next.allSatisfy({Self.validID($0.id) && $0.duration.isFinite && $0.duration>=0}) else{throw CocoaError(.fileWriteInvalidFileName)}
        guard authorize(),try directory.resourceValues(forKeys:[.isSymbolicLinkKey]).isSymbolicLink != true else{throw NativeQuickRecordingBatchError.unavailable}
        let fd=Darwin.open(directory.path,O_RDONLY|O_DIRECTORY|O_NOFOLLOW)
        guard fd>=0 else{throw CocoaError(.fileWriteUnknown)}
        defer{Darwin.close(fd)}
        var original=stat();guard fstat(fd,&original)==0 else{throw CocoaError(.fileWriteUnknown)}
        let stageName=".recording-index-"+UUID().uuidString.lowercased(),stage=directory.appendingPathComponent(stageName)
        defer{_ = unlinkat(fd,stageName,0)}
        try write(JSONEncoder().encode(Envelope(version:1,items:next,lastBatch:lastBatch,suggestionDraft:suggestionDraft)),stage)
        var current=stat()
        guard authorize(),lstat(directory.path,&current)==0,current.st_dev==original.st_dev,current.st_ino==original.st_ino else{throw NativeQuickRecordingBatchError.unavailable}
        guard renameat(fd,stageName,fd,"index.json")==0 else{throw CocoaError(.fileWriteUnknown)}
        // The file has already been synced by durableWrite. Once the atomic
        // rename commits, publish that exact collection; do not report a
        // pre-commit rollback after a directory sync has become uncertain.
        _ = fsync(fd)
        items=next;self.lastBatch=lastBatch;self.suggestionDraft=suggestionDraft
    }
    mutating func apply(_ request:NativeQuickRecordingBatchRequest,now:Date=Date(),authorize:()->Bool={true}) throws {
        guard !request.targets.isEmpty,Set(request.targets.map(\.id)).count==request.targets.count else{throw NativeQuickRecordingBatchError.changed}
        let targets=Dictionary(uniqueKeysWithValues:request.targets.map{($0.id,$0.fingerprint)})
        guard request.targets.allSatisfy({target in items.contains{$0.id==target.id && $0.batchFingerprint==target.fingerprint && $0.state != "recording"}}) else{throw NativeQuickRecordingBatchError.changed}
        var next=items;var undo:[NativeQuickRecordingBatchUndo.Target]=[]
        for index in next.indices where targets[next[index].id] != nil {
            let old=next[index]
            switch request.action {
            case .trash:guard old.deletedAt==nil else{throw NativeQuickRecordingBatchError.changed};next[index].deletedAt=now
            case .restore:guard old.deletedAt != nil else{throw NativeQuickRecordingBatchError.changed};next[index].deletedAt=nil
            case .categorize(let name):
                guard old.deletedAt==nil else{throw NativeQuickRecordingBatchError.changed}
                let category=name?.trimmingCharacters(in:.whitespacesAndNewlines)
                guard category == nil || category!.count<=40 && !category!.unicodeScalars.contains(where:CharacterSet.controlCharacters.contains) else{throw NativeQuickRecordingBatchError.invalidCategory}
                next[index].category=category?.isEmpty == false ? category:nil
            }
            undo.append(.init(id:old.id,fingerprint:next[index].batchFingerprint,category:old.category,deletedAt:old.deletedAt))
        }
        try commit(next,lastBatch:.init(id:request.id,action:request.action,createdAt:now,targets:undo),suggestionDraft:suggestionDraft,authorize:authorize)
    }
    var canUndoBatch:Bool {guard let lastBatch,!lastBatch.targets.isEmpty else{return false};return lastBatch.targets.allSatisfy{target in items.contains{$0.id==target.id && $0.batchFingerprint==target.fingerprint}}}
    mutating func undoBatch(authorize:()->Bool={true}) throws {
        guard canUndoBatch,let lastBatch else{throw NativeQuickRecordingBatchError.changed}
        let targets=Dictionary(uniqueKeysWithValues:lastBatch.targets.map{($0.id,$0)})
        let next=items.map{item->NativeQuickRecordingItem in guard let target=targets[item.id] else{return item};var result=item;result.category=target.category;result.deletedAt=target.deletedAt;return result}
        try commit(next,lastBatch:nil,suggestionDraft:suggestionDraft,authorize:authorize)
    }
    mutating func keepSuggestion(_ draft:NativeQuickRecordingSuggestionDraft,authorize:()->Bool={true}) throws {
        guard suggestionDraft == nil,draft.valid,items.contains(where:{$0.id==draft.id && $0.batchFingerprint==draft.fingerprint && $0.deletedAt==nil && $0.state != "recording" && !$0.transcript.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty}) else{throw NativeQuickRecordingBatchError.changed}
        try commit(items,lastBatch:lastBatch,suggestionDraft:draft,authorize:authorize)
    }
    mutating func discardSuggestion(authorize:()->Bool={true}) throws {
        try commit(items,lastBatch:lastBatch,suggestionDraft:nil,authorize:authorize)
    }
    mutating func saveSuggestion(authorize:()->Bool={true}) throws {
        guard let draft=suggestionDraft,draft.valid,let index=items.firstIndex(where:{$0.id==draft.id && $0.batchFingerprint==draft.fingerprint && $0.deletedAt==nil && $0.state != "recording"}) else{throw NativeQuickRecordingBatchError.changed}
        var next=items
        if let title=draft.title {next[index].title=title}
        if let category=draft.category {next[index].category=category}
        try commit(next,lastBatch:lastBatch,suggestionDraft:nil,authorize:authorize)
    }
    func audioURL(for id: String, mustExist: Bool = true) throws -> URL {
        guard Self.validID(id), items.contains(where: { $0.id == id }) else { throw CocoaError(.fileReadInvalidFileName) }
        let url = directory.appendingPathComponent("recording-\(id).m4a")
        if FileManager.default.fileExists(atPath: url.path) {
            let resource = try url.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey])
            guard resource.isSymbolicLink != true, resource.isRegularFile == true else { throw CocoaError(.fileReadInvalidFileName) }
        } else if mustExist { throw CocoaError(.fileNoSuchFile) }
        return url
    }
    mutating func update(id: String, authorize: () -> Bool = {true}, _ transform: (inout NativeQuickRecordingItem) -> Void) throws {
        guard let index = items.firstIndex(where: { $0.id == id }) else { throw CocoaError(.fileNoSuchFile) }
        var next = items; transform(&next[index]); try replace(next,authorize:authorize)
    }
}

struct NativeSpeechSettingsDraft: Equatable {
    let id = UUID()
    var configuration: NativeSpeechConfiguration
    var key: String
    var catalogRevision: Int? = nil
    var schemeID: String = NativeSpeechScheme.legacyID
    var name: String = nativeUI("默认方案", "Default")
}

@MainActor final class NativeQuickRecordingStore: NSObject, ObservableObject, AVAudioRecorderDelegate {
    enum Phase: Equatable { case idle, authorizing, recording, paused, saving }
    @Published private(set) var available = true
    @Published private(set) var lastBatch: NativeQuickRecordingBatchUndo?
    @Published private(set) var batchNotice: String?
    @Published private(set) var transcriptDrafts: [String:String] = [:]
    @Published private(set) var categoryDraft:NativeQuickRecordingCategoryDraft?
    @Published private(set) var editorResumeID=0
    @Published private(set) var titleDraft:NativeQuickRecordingTitleDraft?
    @Published private(set) var editorSessions: [UUID:String] = [:]
    @Published private(set) var suggestion:NativeQuickRecordingSuggestion?
    @Published private(set) var suggestionDraft:NativeQuickRecordingSuggestionDraft?
    @Published private(set) var suggestingID:String?
    @Published private(set) var suggestionError:String?
    private var suggestionRequest:(([String:Any]) async throws->[String:Any])?
    private var suggestionRequestID:String?
    private var suggestionGeneration=0
    private var suggestionTimeout:Task<Void,Never>?
    private let archiveWrite: (Data,URL) throws -> Void
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var items: [NativeQuickRecordingItem] = []
    @Published private(set) var elapsed: TimeInterval = 0
    @Published private(set) var level: Double = 0
    @Published private(set) var error: String?
    @Published private(set) var receipt: String?
    @Published private(set) var playingID: String?
    let playback: NativeQuickRecordingPlayback
    @Published private(set) var transcribingID: String?
    @Published private(set) var isCloudTranscribing = false
    let speechSettings = NativeSpeechSettings()
    @Published private(set) var speechSettingsDraft: NativeSpeechSettingsDraft?
    private var speechSettingsOperation: UUID?
    private var speechObservation: AnyCancellable?
    private var cloudTask: Task<String,Error>?
    typealias CloudTranscribe = @Sendable (URL,NativeSpeechConfiguration,String) async throws -> String
    private let cloudTranscribe: CloudTranscribe
    @Published var transcriptionLanguage = "zh-CN"
    let realtimeSettings = NativeQuickASRSettings()
    @Published private(set) var realtime = NativeQuickASRSnapshot()
    @Published private(set) var realtimeSettingsDraft: NativeQuickASRSettingsDraft?
    private var realtimeAudio: NativeQuickRealtimeASRAudio?
    private var realtimeSession: NativeQuickRealtimeASRSession?
    private var realtimeID: UUID?
    private var realtimeHandoff: NativeQuickASRPCMHandoff?
    private var realtimeStopTask: Task<Void,Never>?
    private var lastRealtimeSaved = ""
    private var archive: NativeQuickRecordingArchive?
    private var requestedDirectory:URL?
    private var recorder: AVAudioRecorder?
    private var timer: Timer?
    private var recordingID: String?
    private var speechTask: SFSpeechRecognitionTask?
    private var speechTimeout: Task<Void, Never>?
    private var generation = 0
    private var transcriptionGeneration = 0
    // Host appearance is deferred until after the view mounts. Computed
    // action eligibility must invalidate observers when that state arrives.
    @Published private var visible = false
    private var hostVisible = false
    private var undoMatchesCurrent = false
    var isActive: Bool { phase != .idle }
    var ready: Bool { archive != nil && archive?.directory == requestedDirectory }

    init(write: @escaping (Data,URL) throws -> Void = NativeQuickRecordingArchive.durableWrite,
         playback: NativeQuickRecordingPlayback? = nil,
         cloudTranscribe: @escaping CloudTranscribe = {try await NativeSpeechService.transcribe(fileURL:$0,configuration:$1,key:$2)}) {
        self.cloudTranscribe=cloudTranscribe;archiveWrite=write; self.playback=playback ?? NativeQuickRecordingPlayback(); super.init()
        self.playback.onPlayingChange = { [weak self] id in self?.playingID = id }
        self.playback.onFailure = { [weak self] in self?.playbackFailed() }
        speechObservation=speechSettings.objectWillChange.sink{[weak self] in self?.objectWillChange.send()}
    }
    func configure(directory: URL) {
        let folder = directory.appendingPathComponent("quick-recordings", isDirectory: true)
        requestedDirectory=folder
        guard archive == nil || archive?.directory == folder else {
            setAvailable(false)
            error = nativeUI("录音属于另一个工作区。请先回到原工作区。", "Recordings belong to another workspace. Return to it first."); return
        }
        guard archive == nil else { return }
        do { archive = try .init(directory: folder,write:archiveWrite); refresh() }
        catch { self.error = nativeUI("录音目录无法读取。原文件已保留，没有覆盖。", "The recording library cannot be read. Existing files were retained.") }
    }
    func setAvailable(_ requested:Bool) {
        let value=requested && (archive == nil || archive?.directory == requestedDirectory)
        guard available != value else{return};available=value;generation+=1
        if !value {speechSettings.setAvailable(false);realtimeSettings.setAvailable(false);realtimeHandoff?.close();realtimeSession?.cancel();let previous=hostVisible;setVisible(false);hostVisible=previous;cancelTranscription();items=[];lastBatch=nil;suggestionDraft=nil;batchNotice=nil;editorSessions=[:]}
        else {visible=hostVisible;speechSettings.setAvailable(true);realtimeSettings.setAvailable(true);refresh()}
    }
    var hasEditor:Bool {speechSettingsDraft != nil || speechSettingsOperation != nil || realtimeSettingsDraft != nil || !editorSessions.isEmpty || categoryDraft != nil || titleDraft != nil || suggestionDraft != nil}
    var hasUnsavedTranscriptDrafts:Bool {!transcriptDrafts.isEmpty}
    func setEditor(_ session:UUID,id:String,active:Bool){if active,available{editorSessions[session]=id}else{editorSessions.removeValue(forKey:session)}}
    func setVisible(_ value: Bool) {
        hostVisible = value;visible = value && available
        if !visible {
            if isCloudTranscribing {cancelTranscription()}
            cancelSuggestion()
            generation += 1
            if phase == .authorizing { phase = .idle }
            if phase == .recording || phase == .paused { stop() }
            stopPlayback()
        }
    }
    func shutdown() { setVisible(false); cancelTranscription() }
    /// Quit may retry retained text, but a private/unready workspace must not
    /// be written merely because the process is closing. The caller keeps the
    /// app open when false, so the user can return and save the same draft.
    func flushForQuit() -> Bool {
        guard phase != .saving,speechSettingsDraft == nil,speechSettingsOperation == nil,realtimeSettingsDraft == nil,categoryDraft == nil,titleDraft == nil else{return false}
        guard !transcriptDrafts.isEmpty else{return true}
        guard available else{return false}
        for id in Array(transcriptDrafts.keys) {retryTranscript(id:id)}
        return transcriptDrafts.isEmpty
    }

    /// Only a direct Start action reaches this method. A stale authorization
    /// response after dismissal must not start microphone capture.
    func start() async {
        guard available, visible, phase == .idle, archive != nil, realtimeSettingsDraft == nil, speechSettingsDraft == nil, transcribingID == nil else { return }
        guard Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription") != nil else {
            error = nativeUI("此安装包缺少麦克风权限说明，请更新 AI Bro。", "This build is missing its microphone permission description. Update AI Bro."); return
        }
        if realtimeSettings.configuration.enabled {
            do {_ = try realtimeSettings.connection()} catch {
                phase = .idle
                self.error = nativeUI("实时转写配置不可用。请打开实时转写设置，重新保存百炼 Key，或关闭实时转写后仅在本机录音。", "Realtime transcription settings are unavailable. Open its settings to save a Model Studio Key, or turn it off to record locally.")
                return
            }
        }
        generation += 1; let token = generation
        phase = .authorizing; error = nil; receipt = nil
        let permitted: Bool
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: permitted = true
        case .notDetermined: permitted = await AVCaptureDevice.requestAccess(for: .audio)
        default: permitted = false
        }
        guard token == generation, visible else { return }
        guard permitted else {
            phase = .idle
            error = nativeUI("麦克风访问未获允许。可在系统设置 → 隐私与安全性 → 麦克风中允许 AI Bro。", "Microphone access was denied. Allow AI Bro in System Settings → Privacy & Security → Microphone."); return
        }
        do {
            stopPlayback()
            let id = UUID().uuidString.lowercased()
            let item = NativeQuickRecordingItem(id: id, title: nativeUI("录音", "Recording") + " " + Date().formatted(date: .abbreviated, time: .shortened), createdAt: Date(), duration: 0, transcript: "", state: "recording")
            let nextItems = [item] + (archive?.items ?? [])
            try archive?.replace(nextItems)
            guard let url = try archive?.audioURL(for: id, mustExist: false) else { throw CocoaError(.fileWriteUnknown) }
            recordingID = id; refresh()
            if realtimeSettings.configuration.enabled {
                try await startRealtime(id:id,url:url)
                return
            }
            let next = try AVAudioRecorder(url: url, settings: [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44100, AVNumberOfChannelsKey: 1, AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue])
            next.delegate = self; next.isMeteringEnabled = true
            recorder = next
            guard next.prepareToRecord(), next.record() else { throw CocoaError(.fileWriteUnknown) }
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
            recorder = next; phase = .recording; elapsed = 0
            timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, let recorder = self.recorder else { return }
                    self.elapsed = recorder.currentTime
                    recorder.updateMeters()
                    self.level = self.phase == .recording ? min(1, max(0, pow(10, Double(recorder.averagePower(forChannel: 0)) / 20))) : 0
                }
            }
        } catch {
            realtimeSession?.cancel(); realtimeSession=nil;realtimeID=nil
            recorder?.stop(); recorder = nil
            if let id = recordingID { try? archive?.update(id: id) { $0.state = "interrupted" } }
            recordingID = nil; phase = .idle; refresh()
            self.error = nativeUI("无法开始录音。请检查麦克风与可用磁盘空间；已有文件未删除。", "Recording could not start. Check the microphone and free disk space; existing files were retained.")
        }
    }
    func togglePause() {
        if let audio = realtimeAudio {
            if phase == .recording {audio.pause();phase = .paused;level=0}
            else if phase == .paused,visible,available {do{try audio.resume();phase = .recording}catch{stop(success:false)}}
            return
        }
        guard let recorder else { return }
        if phase == .recording { recorder.pause(); phase = .paused; level = 0 }
        else if phase == .paused, visible {
            if recorder.record() { phase = .recording }
            else { stop(success: false) }
        }
    }
    func stop(success: Bool = true) {
        if realtimeAudio != nil {stopRealtime(success:success);return}
        guard let recorder, let id = recordingID, phase == .recording || phase == .paused else { return }
        phase = .saving; elapsed = recorder.currentTime
        timer?.invalidate(); timer = nil; level = 0
        self.recorder = nil; recordingID = nil
        recorder.delegate = nil; recorder.stop()
        do {
            guard let url = try archive?.audioURL(for: id) else { throw CocoaError(.fileWriteUnknown) }
            let handle = try FileHandle(forWritingTo: url)
            try handle.synchronize(); try handle.close()
            let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            guard size > 0 else { throw CocoaError(.fileWriteUnknown) }
            let duration = elapsed
            try archive?.update(id: id) { $0.duration = duration; $0.state = success ? "ready" : "interrupted" }
            receipt = success ? nativeUI("录音已保存在本机", "Recording saved on this Mac") : nil
            if !success { error = nativeUI("录音意外中断，已保留可恢复的音频。", "Recording was interrupted; recoverable audio was retained.") }
        } catch {
            self.error = nativeUI("录音文件已保留，但保存确认失败。请打开文件核对；重启后会显示为恢复的录音。", "Audio was retained, but saving was not confirmed. Check the file; after restart it will appear as recovered.")
        }
        phase = .idle; refresh()
    }
    nonisolated func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        Task { @MainActor [weak self] in self?.stop(success: false) }
    }
    nonisolated func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        Task { @MainActor [weak self] in if self?.recorder === recorder { self?.stop(success: flag) } }
    }
    func play(id: String) {
        guard let url = playbackURL(id: id) else { return }
        do { try playback.toggle(id: id, url: url); error = nil } catch { playbackFailed() }
    }
    private func playbackURL(id: String) -> URL? {
        guard available, visible, phase == .idle, items.contains(where: { $0.id == id && $0.deletedAt == nil && $0.state != "recording" }) else { return nil }
        do { return try archive?.audioURL(for: id) } catch { playbackFailed(); return nil }
    }
    private func playbackFailed() {
        guard available, visible else { return }
        error = nativeUI("无法播放这段音频，文件仍保留。", "This audio cannot be played. Its file is retained.")
    }
    func beginPlaybackSeek(id: String) -> UUID? {
        guard let url = playbackURL(id: id) else { return nil }
        do { return try playback.beginSeek(id: id, url: url) } catch { playbackFailed(); return nil }
    }
    func seekPlayback(id: String, to value: TimeInterval) {
        guard let url = playbackURL(id: id) else { return }
        do { error = nil; try playback.seek(id: id, url: url, to: value) } catch { playbackFailed() }
    }
    func selectPlayback(_ id: String?) { playback.retainSelection(id) }
    func stopPlayback() { playback.stop() }
    @discardableResult func rename(id: String, title: String)->Bool {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, title.count <= 200 else { return false }
        return mutate(id: id) { $0.title = title }
    }
    func beginTitle(id:String) {
        guard available,titleDraft==nil,suggestionDraft?.id != id,let item=items.first(where:{$0.id==id && $0.deletedAt==nil}) else{return}
        cancelSuggestion(id:id)
        titleDraft = .init(id:id,text:item.title)
    }
    func resumeTitle(){if available,titleDraft != nil {editorResumeID+=1}}
    func editTitle(_ text:String){guard available else{return};titleDraft?.text=text}
    func cancelTitle(){titleDraft=nil}
    @discardableResult func commitTitle()->Bool {
        guard let draft=titleDraft,rename(id:draft.id,title:draft.text) else{return false}
        titleDraft=nil;return true
    }
    func beginCategory(ids:Set<String>){
        guard categoryDraft==nil,let targets=batchTargets(ids:ids) else{return}
        if let id=suggestingID,ids.contains(id){cancelSuggestion(id:id)}
        if let id=suggestion?.id,ids.contains(id){cancelSuggestion(id:id)}
        categoryDraft = .init(targets:targets,text:"")
    }
    func editCategory(_ text:String){guard available else{return};categoryDraft?.text=text}
    func cancelCategory(){categoryDraft=nil}
    @discardableResult func commitCategory()->Bool {
        guard let draft=categoryDraft,applyBatch(.init(targets:draft.targets,action:.categorize(draft.text)),allowCategoryDraft:true) else{return false}
        categoryDraft=nil;return true
    }
    func saveTranscript(id: String, text: String) {
        guard available,suggestionDraft?.id != id else{return}
        if isCloudTranscribing,transcribingID==id {cancelTranscription()}
        cancelSuggestion(id:id);transcriptDrafts[id]=text
        if mutate(id:id,{$0.transcript=text;$0.transcriptionState="edited"}) {transcriptDrafts.removeValue(forKey:id)}
    }
    func retryTranscript(id:String){guard let draft=transcriptDrafts[id] else{return};saveTranscript(id:id,text:draft)}
    func transcriptText(id:String)->String? {
        guard available else{return nil}
        if id==recordingID,realtimeID != nil{return realtime.text}
        return transcriptDrafts[id] ?? items.first{$0.id==id}?.transcript
    }
    func setDeleted(id: String, deleted: Bool) {
        guard let request=makeBatch(ids:[id],action:deleted ? .trash:.restore) else{return}
        _ = applyBatch(request)
    }
    func fileURL(id: String) -> URL? {guard available else{return nil};return try? archive?.audioURL(for:id)}
    var categories:[String] {Array(Set(items.filter{$0.deletedAt==nil}.compactMap(\.category))).sorted{$0.localizedStandardCompare($1) == .orderedAscending}}
    func canBatch(ids:Set<String>,allowCategoryDraft:Bool=false)->Bool {
        guard available,!ids.isEmpty,phase == .idle,ids.isDisjoint(with:Set(editorSessions.values)),!ids.contains(titleDraft?.id ?? ""),
              !ids.contains(suggestionDraft?.id ?? ""),
              (allowCategoryDraft || ids.isDisjoint(with:Set(categoryDraft?.targets.map(\.id) ?? []))),
              ids.allSatisfy({$0 != transcribingID && transcriptDrafts[$0]==nil}) else{return false}
        return items.filter{ids.contains($0.id) && $0.state != "recording"}.count==ids.count
    }
    func batchTargets(ids:Set<String>)->[NativeQuickRecordingBatchTarget]? {
        guard canBatch(ids:ids) else{return nil}
        return items.filter{ids.contains($0.id)}.map(\.batchTarget)
    }
    func makeBatch(ids:Set<String>,action:NativeQuickRecordingBatchAction)->NativeQuickRecordingBatchRequest? {
        guard let targets=batchTargets(ids:ids) else{error=NativeQuickRecordingBatchError.unavailable.localizedDescription;return nil}
        return .init(targets:targets,action:action)
    }
    @discardableResult func applyBatch(_ request:NativeQuickRecordingBatchRequest,allowCategoryDraft:Bool=false)->Bool {
        let ids=Set(request.targets.map(\.id));guard canBatch(ids:ids,allowCategoryDraft:allowCategoryDraft),var candidate=archive else{error=NativeQuickRecordingBatchError.unavailable.localizedDescription;return false}
        if let id=suggestingID,ids.contains(id){cancelSuggestion(id:id)}
        if let id=suggestion?.id,ids.contains(id){cancelSuggestion(id:id)}
        let owner=candidate.directory,token=generation
        do {
            try candidate.apply(request,authorize:{self.available && self.generation==token && self.archive?.directory==owner && self.canBatch(ids:ids,allowCategoryDraft:allowCategoryDraft)})
            archive=candidate
            if let loadedID=playback.state.id,ids.contains(loadedID){stopPlayback()}
            refresh();error=nil
            switch request.action {
            case .trash:batchNotice=nativeUI("已移入最近删除 \(ids.count) 段录音","Moved \(ids.count) recordings to Deleted")
            case .restore:batchNotice=nativeUI("已恢复 \(ids.count) 段录音","Restored \(ids.count) recordings")
            case .categorize:batchNotice=nativeUI("已更新 \(ids.count) 段录音的分类","Updated categories for \(ids.count) recordings")
            }
            return true
        }catch{self.error=error.localizedDescription;return false}
    }
    var canUndoBatch:Bool {guard available,let archive,let undo=archive.lastBatch else{return false};return undoMatchesCurrent && canBatch(ids:Set(undo.targets.map(\.id)))}
    @discardableResult func undoBatch()->Bool {
        guard canUndoBatch,var candidate=archive else{error=NativeQuickRecordingBatchError.changed.localizedDescription;return false}
        let owner=candidate.directory,token=generation
        do {try candidate.undoBatch(authorize:{self.available && self.generation==token && self.archive?.directory==owner && self.canUndoBatch});archive=candidate;refresh();batchNotice=nativeUI("已撤销这次批处理","Batch undone");error=nil;return true}
        catch{self.error=error.localizedDescription;return false}
    }
    func dismissBatchNotice(){batchNotice=nil}
    func configureTitleRequest(_ request:@escaping ([String:Any]) async throws->[String:Any]) {cancelSuggestion();suggestionRequest=request}
    func resumeSuggestion(){if available,suggestionDraft != nil {editorResumeID+=1}}
    func canSuggest(id:String)->Bool {
        guard available,visible,ready,phase == .idle,suggestionRequest != nil,suggestionDraft==nil,
              titleDraft==nil,categoryDraft==nil,transcriptDrafts[id]==nil,transcribingID != id,
              let item=items.first(where:{$0.id==id && $0.deletedAt==nil && $0.state != "recording"}) else{return false}
        return !item.transcript.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty && item.transcript.utf16.count<=200000
    }
    func cancelSuggestion(id:String?=nil) {
        if let id,id != suggestingID && id != suggestion?.id {return}
        let requestID=suggestionRequestID,request=suggestionRequest
        suggestionGeneration+=1;suggestionRequestID=nil;suggestingID=nil;suggestion=nil;suggestionError=nil
        suggestionTimeout?.cancel();suggestionTimeout=nil
        if let requestID,let request {Task{_ = try? await request(["action":"cancel","requestId":requestID])}}
    }
    func generateSuggestion(id:String) async {
        guard canSuggest(id:id),let item=items.first(where:{$0.id==id}),let request=suggestionRequest else{return}
        cancelSuggestion()
        let token=suggestionGeneration,requestID="quick_recording_title_"+UUID().uuidString.lowercased(),fingerprint=item.batchFingerprint
        suggestingID=id;suggestionRequestID=requestID
        // The JS broker bounds credentials and model output to 30 seconds.
        // The outer deadline also handles a destroyed/unresponsive WebView.
        suggestionTimeout=Task{[weak self] in
            try? await Task.sleep(for:.seconds(35))
            guard !Task.isCancelled,let self,self.suggestionGeneration==token else{return}
            self.cancelSuggestion();self.suggestionError=NativeQuickRecordingSuggestionValidation.reason("timeout")
        }
        defer {if suggestionGeneration==token {suggestingID=nil;suggestionRequestID=nil;suggestionTimeout?.cancel();suggestionTimeout=nil}}
        do {
            let reply=try await request(["action":"generate","requestId":requestID,"id":id,"fingerprint":fingerprint,"text":item.transcript])
            guard suggestionGeneration==token,available,visible else{return}
            guard canSuggest(id:id),items.first(where:{$0.id==id})?.batchFingerprint==fingerprint else{suggestionError=NativeQuickRecordingSuggestionValidation.reason("changed");return}
            guard reply["status"] as? String == "generated" else{suggestionError=NativeQuickRecordingSuggestionValidation.reason(reply["reason"] as? String ?? "unavailable");return}
            guard reply["requestId"] as? String == requestID,reply["id"] as? String == id,reply["fingerprint"] as? String == fingerprint,
                  let title=reply["title"] as? String,let category=reply["category"] as? String,
                  NativeQuickRecordingSuggestionValidation.text(title,limit:80),NativeQuickRecordingSuggestionValidation.text(category,limit:40),let model=reply["model"] as? String,NativeQuickRecordingSuggestionValidation.text(model,limit:200) else{suggestionError=NativeQuickRecordingSuggestionValidation.reason("invalid_response");return}
            suggestion = .init(id:id,fingerprint:fingerprint,title:title,category:category,model:model)
        }catch{guard suggestionGeneration==token,available,visible else{return};suggestionError=NativeQuickRecordingSuggestionValidation.reason("model_failed")}
    }
    @discardableResult func adoptSuggestion(title:Bool,category:Bool)->Bool {
        guard available,visible else{return false}
        guard let suggestion,canSuggest(id:suggestion.id),title || category,var candidate=archive,
              items.first(where:{$0.id==suggestion.id})?.batchFingerprint==suggestion.fingerprint else{suggestionError=NativeQuickRecordingSuggestionValidation.reason("changed");return false}
        let owner=candidate.directory,token=generation
        do {
            try candidate.keepSuggestion(.init(id:suggestion.id,fingerprint:suggestion.fingerprint,model:suggestion.model,title:title ? suggestion.title:nil,category:category ? suggestion.category:nil),authorize:{self.available && self.visible && self.generation==token && self.archive?.directory==owner})
            archive=candidate;cancelSuggestion();refresh();return true
        }catch{if available,visible,generation==token,archive?.directory==owner {suggestionError=nativeUI("候选草稿未能保存。原名称、分类和候选仍保留，可重试。","The proposal draft could not be saved. Original metadata and the proposal are retained; retry.")};return false}
    }
    @discardableResult func saveSuggestion()->Bool {
        guard available,visible,phase == .idle,suggestionDraft != nil,var candidate=archive else{return false}
        let owner=candidate.directory,token=generation
        do {
            try candidate.saveSuggestion(authorize:{self.available && self.visible && self.generation==token && self.archive?.directory==owner})
            archive=candidate;refresh();suggestionError=nil;receipt=nativeUI("名称与分类已按所选字段保存","Selected title and category changes saved");return true
        }catch{if available,visible,generation==token,archive?.directory==owner {suggestionError=(error as? NativeQuickRecordingBatchError) == nil ? nativeUI("更改未能保存，候选草稿和原录音仍保留。","The change could not be saved. Proposal draft and original recording are retained."):NativeQuickRecordingSuggestionValidation.reason("changed")};return false}
    }
    @discardableResult func discardSuggestion()->Bool {
        guard available,visible,var candidate=archive else{return false};let owner=candidate.directory,token=generation
        do {try candidate.discardSuggestion(authorize:{self.available && self.visible && self.generation==token && self.archive?.directory==owner});archive=candidate;refresh();suggestionError=nil;return true}
        catch{if available,visible,generation==token,archive?.directory==owner {suggestionError=nativeUI("未能丢弃草稿，请重试。","The draft could not be discarded. Retry.")};return false}
    }
    @discardableResult private func mutate(id:String,_ change:(inout NativeQuickRecordingItem)->Void)->Bool {
        guard available,suggestionDraft?.id != id,var candidate=archive else{return false};cancelSuggestion(id:id);let owner=candidate.directory,token=generation
        do {try candidate.update(id:id,authorize:{self.available && self.generation==token && self.archive?.directory==owner},change);archive=candidate;refresh();error=nil;return true}
        catch{self.error=nativeUI("更改未能保存，原记录与输入仍保留。","The change could not be saved. Original recording and input are retained.");return false}
    }
    private func refresh() {items=available ? (archive?.items ?? []).sorted{$0.createdAt>$1.createdAt}:[];lastBatch=available ? archive?.lastBatch:nil;suggestionDraft=available ? archive?.suggestionDraft:nil;undoMatchesCurrent=available && archive?.canUndoBatch == true}

    func configureSpeech(owner:URL,access:NativeSpeechSecretAccess) {
        guard archive?.directory == owner.appendingPathComponent("quick-recordings",isDirectory:true),ready else{return}
        speechSettings.configure(owner:owner,access:access);speechSettings.setAvailable(available)
    }
    func beginSpeechSettings() {
        guard available,visible,phase == .idle,transcribingID == nil,realtimeSettingsDraft == nil,!speechSettings.busy else{return}
        if speechSettingsDraft == nil {
            let selected=speechSettings.schemes.first{$0.id==speechSettings.selectedID}
            speechSettingsDraft = .init(configuration:speechSettings.configuration,key:"",catalogRevision:speechSettings.catalogRevision,schemeID:selected?.id ?? UUID().uuidString,name:selected?.name ?? nativeUI("默认方案","Default"))
        }
    }
    func updateSpeechSettings(_ draft:NativeSpeechSettingsDraft) {
        guard available,speechSettingsDraft?.id == draft.id,phase == .idle else{return};speechSettingsDraft=draft
    }
    func cancelSpeechSettings() {guard speechSettingsOperation == nil else{return};speechSettings.clearTestResult();speechSettingsDraft=nil}
    func newSpeechSchemeDraft() {
        guard available,visible,phase == .idle,speechSettingsOperation == nil,!speechSettings.busy else{return}
        speechSettings.clearTestResult()
        speechSettingsDraft = .init(configuration:.init(),key:"",catalogRevision:speechSettings.catalogRevision,schemeID:UUID().uuidString,name:nativeUI("新方案","New scheme"))
    }
    @discardableResult func selectSpeechScheme(_ id:String)async->Bool {
        guard available,visible,phase == .idle,speechSettingsOperation == nil,let draft=speechSettingsDraft else{return false}
        let operation=UUID(),owner=archive?.directory,epoch=generation;speechSettingsOperation=operation
        defer{if speechSettingsOperation==operation{speechSettingsOperation=nil}}
        guard await speechSettings.selectScheme(id),available,visible,generation==epoch,archive?.directory==owner,speechSettingsDraft==draft else{return false}
        let selected=speechSettings.schemes.first{$0.id==speechSettings.selectedID}
        speechSettingsDraft = .init(configuration:speechSettings.configuration,key:"",catalogRevision:speechSettings.catalogRevision,schemeID:selected?.id ?? UUID().uuidString,name:selected?.name ?? nativeUI("默认方案","Default"));return true
    }
    @discardableResult func saveSpeechSettings() async -> Bool {
        guard available,visible,phase == .idle,speechSettingsOperation == nil,let draft=speechSettingsDraft else{return false}
        let operation=UUID(),owner=archive?.directory,epoch=generation;speechSettingsOperation=operation
        defer{if speechSettingsOperation==operation{speechSettingsOperation=nil}}
        let saved=await speechSettings.saveScheme(id:draft.schemeID,name:draft.name,configuration:draft.configuration,key:draft.key,expectedRevision:draft.catalogRevision)
        guard saved,available,visible,generation==epoch,archive?.directory==owner,speechSettingsDraft==draft else{return false}
        speechSettingsDraft=nil;return true
    }
    @discardableResult func removeSpeechSettings() async -> Bool {
        guard available,visible,phase == .idle,speechSettingsOperation == nil,let draft=speechSettingsDraft else{return false}
        let operation=UUID(),owner=archive?.directory,epoch=generation;speechSettingsOperation=operation
        defer{if speechSettingsOperation==operation{speechSettingsOperation=nil}}
        let removed=await speechSettings.removeScheme(draft.schemeID,expectedRevision:draft.catalogRevision)
        guard removed,available,visible,generation==epoch,archive?.directory==owner,speechSettingsDraft==draft else{return false}
        speechSettingsDraft=nil;return true
    }

    /// Explicit recording action only: loading/configuring the service never
    /// uploads audio. The original text remains until a current reply commits.
    func transcribeCloud(id:String) async {
        guard available,visible,ready,phase == .idle,transcribingID == nil,
              speechSettingsDraft == nil,realtimeSettingsDraft == nil,transcriptDrafts[id] == nil,
              let original=items.first(where:{$0.id==id && $0.deletedAt==nil && $0.state != "recording"}),
              original.transcriptionState != "edited",original.transcript.isEmpty || original.transcriptionState == "partial",
              let owner=archive?.directory,let url=fileURL(id:id) else{return}
        cancelSuggestion(id:id)
        transcriptionGeneration+=1;let token=transcriptionGeneration,epoch=generation,revision=speechSettings.revision
        transcribingID=id;isCloudTranscribing=true;error=nil;receipt=nil
        let settings=speechSettings,service=cloudTranscribe
        let work=Task { () throws -> String in
            guard settings.revision==revision else{throw NativeSpeechError.changed}
            let (configuration,key)=try await settings.connection()
            try Task.checkCancellation()
            guard settings.revision==revision else{throw NativeSpeechError.changed}
            return try await service(url,configuration,key)
        }
        cloudTask=work
        func current()->Bool {
            available && visible && ready && archive?.directory==owner && generation==epoch &&
            transcriptionGeneration==token && transcribingID==id && isCloudTranscribing
        }
        defer{if transcriptionGeneration==token{cancelTranscription()}}
        do {
            let text=try await withTaskCancellationHandler(operation:{try await work.value},onCancel:{work.cancel()})
            guard current(),!Task.isCancelled else{return}
            guard speechSettings.revision==revision,speechSettings.available,
                  transcriptDrafts[id]==nil,archive?.items.first(where:{$0.id==id})==original else {
                error=NativeSpeechError.changed.localizedDescription;return
            }
            guard !text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else{throw NativeSpeechError.noSpeech}
            guard text.utf8.count<=NativeSpeechService.responseLimit else{throw NativeSpeechError.responseTooLarge}
            if mutate(id:id,{$0.transcript=text;$0.transcriptionState="cloud"}) {
                receipt=nativeUI("云端转写已保存，原录音保留", "Cloud transcript saved; original audio retained")
            } else {
                // Keep the generated result recoverable without replacing the
                // durable text on a failed commit; quit returns to this draft.
                transcriptDrafts[id]=text
            }
        } catch is CancellationError {} catch {
            guard current(),!Task.isCancelled else{return}
            self.error=(error as? NativeSpeechError ?? .network).localizedDescription
        }
    }

    func configureRealtime(owner:URL,access:NativeQuickASRSecretAccess) {
        guard archive?.directory == owner.appendingPathComponent("quick-recordings",isDirectory:true),ready else{return}
        realtimeSettings.configure(owner:owner,access:access);realtimeSettings.setAvailable(available)
    }
    func beginRealtimeSettings() {
        guard available,phase == .idle,transcribingID == nil,speechSettingsDraft == nil else{return}
        if realtimeSettingsDraft == nil {realtimeSettingsDraft = realtimeSettings.draft()}
    }
    func updateRealtimeSettings(_ draft:NativeQuickASRSettingsDraft) {guard available,realtimeSettingsDraft != nil,phase == .idle else{return};realtimeSettingsDraft=draft}
    func cancelRealtimeSettings(){realtimeSettings.cancelTest();realtimeSettingsDraft=nil}
    @discardableResult func saveRealtimeSettings()->Bool {
        guard available,phase == .idle,let draft=realtimeSettingsDraft,realtimeSettings.save(draft) else{return false}
        realtimeSettingsDraft=nil;return true
    }
    @discardableResult func removeRealtimeSettings()->Bool {
        guard available,phase == .idle,realtimeSettings.remove() else{return false}
        realtimeSettingsDraft=nil;return true
    }
    var realtimeStatusText:String {
        if realtime.phase == .completed,realtime.hasGap {return nativeUI("转写可能有缺字，完整音频仍在本机", "Transcript may have gaps; full audio stays on this Mac")}
        switch realtime.phase {
        case .connecting:return nativeUI("正在连接百炼实时转写…", "Connecting to realtime transcription…")
        case .reconnecting:return nativeUI("转写正在重连（\(realtime.retry)/5），本机录音继续", "Reconnecting (\(realtime.retry)/5); local recording continues")
        case .connected:return nativeUI("实时转写中 · 百炼", "Transcribing live · Model Studio")
        case .finishing:return nativeUI("音频已保存，正在收取最后文字…", "Audio saved; receiving final transcript…")
        case .failed:return nativeUI("实时转写已中断，音频仍保留，可录后转写", "Live transcription stopped; audio is retained for later transcription")
        case .completed:return nativeUI("实时转写已保存", "Live transcript saved")
        case .cancelled:return nativeUI("实时转写已停止", "Live transcription stopped")
        case .idle:return nativeUI("仅本机录音", "Local recording only")
        }
    }
    private func startRealtime(id:String,url:URL) async throws {
        // A dedicated explicit configuration is required. No fallback to chat
        // secrets and no request is made merely by loading these settings.
        let (configuration,key)=try realtimeSettings.connection()
        let token=UUID(),audio=NativeQuickRealtimeASRAudio(),session=NativeQuickRealtimeASRSession()
        guard let owner=archive?.directory else{throw NativeQuickASRError.unavailable}
        realtimeID=token;realtimeAudio=audio;realtimeSession=session;realtime = .init();lastRealtimeSaved=""
        session.onChange = {[weak self] snapshot in
            guard let self,self.available,self.realtimeID==token,self.recordingID==id,self.archive?.directory==owner else{return}
            var display=snapshot;display.queuedBytes=0
            if self.realtime != display {self.realtime=display}
            // Save provider-completed utterances, not every partial token.
            // The remaining partial is captured again when local audio closes.
            if !snapshot.finalized.isEmpty,snapshot.finalized != self.lastRealtimeSaved {
                do {
                    // authorize reads the live archive owner before each commit.
                    // Mutate a separate value so those reads never overlap an
                    // exclusive inout access to self.archive.
                    guard var candidate=self.archive else{throw NativeQuickRecordingBatchError.unavailable}
                    try candidate.update(id:id,authorize:{self.available && self.realtimeID==token && self.recordingID==id && self.archive?.directory==owner}){$0.transcript=snapshot.finalized;$0.transcriptionState="partial"}
                    self.archive=candidate;self.lastRealtimeSaved=snapshot.finalized;self.refresh()
                }
                catch{self.transcriptDrafts[id]=snapshot.finalized}
            }
        }
        let handoff=NativeQuickASRPCMHandoff(receive:{[weak self] data in
            guard let self,self.available,self.realtimeID==token,self.recordingID==id,self.archive?.directory==owner else{return false}
            self.realtimeSession?.append(data);return true
        },onFailure:{[weak self] in Task{@MainActor in
            guard let self,self.realtimeID==token else{return};self.realtimeSession?.inputFailed()
        }})
        realtimeHandoff=handoff
        do {
            try audio.start(url:url,onPCM:{data in handoff.send(data)},onFailure:{[weak self] in Task{@MainActor in guard let self,self.realtimeID==token else{return};self.stop(success:false)}},onStreamFailure:{[weak self] in Task{@MainActor in guard let self,self.realtimeID==token else{return};self.realtimeSession?.inputFailed()}})
            // Only connect after the local recording sink has actually started.
            try session.start(configuration:configuration,key:key)
            phase = .recording;elapsed=0
            timer=Timer.scheduledTimer(withTimeInterval:0.1,repeats:true){[weak self] _ in MainActor.assumeIsolated{
                guard let self,let audio=self.realtimeAudio else{return};self.elapsed=audio.elapsed;self.level=self.phase == .recording ? audio.level:0
            }}
        }catch{
            handoff.close();realtimeHandoff=nil;session.cancel();realtimeID=nil;realtimeAudio=nil;realtimeSession=nil
            // Even failed starts may have created a recoverable audio file.
            // Driver stop owns closing it; no unlink or fallback overwrite.
            phase = .saving;_ = await audio.stop();throw error
        }
    }
    private func stopRealtime(success:Bool) {
        guard let audio=realtimeAudio,let session=realtimeSession,let id=recordingID,let token=realtimeID,
              phase == .recording || phase == .paused,let owner=archive?.directory else{return}
        phase = .saving;timer?.invalidate();timer=nil;level=0
        let handoff=realtimeHandoff
        realtimeStopTask=Task{[weak self] in
            let audioReceipt=await audio.stop()
            handoff?.close() // Actual MainActor append ACKs preceded a successful delivery drain.
            guard let self,self.realtimeID==token,self.archive?.directory==owner else{session.cancel();return}
            self.elapsed=audioReceipt.duration
            if audioReceipt.streamInterrupted || handoff?.failed == true {session.inputFailed()}
            let final:NativeQuickASRSnapshot
            if self.available {final=await session.finish()}else{session.cancel();final=self.realtime}
            guard self.realtimeID==token,self.archive?.directory==owner else{return}
            // Revocation while waiting for final response cannot introduce new
            // text. Still close and acknowledge the already-authorized local file.
            // realtime is updated only while authorized: preserve the latest
            // pre-revocation final words, not a stale snapshot from Stop time.
            let result=self.available ? final:self.realtime
            do {
                guard audioReceipt.bytes>0 else{throw CocoaError(.fileWriteUnknown)}
                // Keep the live owner/token checks while committing a separate
                // archive value, as in manual edits and batch transactions.
                guard var candidate=self.archive else{throw NativeQuickRecordingBatchError.unavailable}
                try candidate.update(id:id,authorize:{self.realtimeID==token && self.recordingID==id && self.archive?.directory==owner}){item in
                    item.duration=audioReceipt.duration;item.state=success && !audioReceipt.interrupted ? "ready":"interrupted"
                    item.transcript=result.text
                    item.transcriptionState=result.phase == .completed && !result.hasGap && !audioReceipt.streamInterrupted ? "realtime":"partial"
                }
                self.archive=candidate
                self.transcriptDrafts.removeValue(forKey:id)
                if self.available {self.receipt=nativeUI("录音与已收到的文字保存在本机", "Audio and received text saved on this Mac")}
            }catch{
                if !result.text.isEmpty {self.transcriptDrafts[id]=result.text}
                if self.available {self.error=nativeUI("音频文件保留，但保存确认失败；文字草稿可重试。", "Audio is retained, but saving was not confirmed; retry the text draft.")}
            }
            self.realtimeAudio=nil;self.realtimeSession=nil;self.realtimeHandoff=nil;self.realtimeID=nil;self.recordingID=nil;self.phase = .idle;self.realtimeStopTask=nil
            if self.available {self.realtime=result}else{self.realtime = .init()}
            self.refresh()
        }
    }

    func transcribe(id: String) async {
        guard available,transcriptDrafts[id]==nil,transcribingID == nil, phase == .idle, items.contains(where: { $0.id == id && $0.deletedAt == nil && ($0.transcript.isEmpty || $0.transcriptionState == "partial") }), let url = fileURL(id: id) else { return }
        guard Bundle.main.object(forInfoDictionaryKey: "NSSpeechRecognitionUsageDescription") != nil else {
            error = nativeUI("此安装包缺少语音识别权限说明，请更新 AI Bro。", "This build is missing its speech recognition permission description. Update AI Bro."); return
        }
        transcriptionGeneration += 1; let token = transcriptionGeneration
        transcribingID = id; error = nil
        let status = await withCheckedContinuation { continuation in SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) } }
        guard token == transcriptionGeneration, transcribingID == id else { return }
        guard status == .authorized else {
            transcribingID = nil; error = nativeUI("未获语音识别权限。音频仍保存在本机。", "Speech recognition permission was denied. Audio remains on this Mac."); return
        }
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: transcriptionLanguage)), recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else {
            transcribingID = nil; error = nativeUI("此语言的本机转写当前不可用。请在 macOS 下载对应听写语言，或导出音频使用其他转写服务。", "On-device transcription is unavailable for this language. Download its macOS dictation language or export audio to another transcription service."); return
        }
        let request = SFSpeechURLRecognitionRequest(url: url)
        request.requiresOnDeviceRecognition = true; request.shouldReportPartialResults = false
        speechTask = recognizer.recognitionTask(with: request) { [weak self] result, failure in
            Task { @MainActor in
                guard let self, self.transcriptionGeneration == token, self.transcribingID == id else { return }
                if let result, result.isFinal {
                    self.saveTranscript(id: id, text: result.bestTranscription.formattedString)
                    if self.transcriptDrafts[id] == nil {_ = self.mutate(id:id){$0.transcriptionState="on-device"}}
                    self.cancelTranscription()
                } else if failure != nil {
                    self.cancelTranscription(); self.error = nativeUI("本机转写未完成。原音频与已保存文字保留，可以重试。", "On-device transcription did not finish. Original audio and saved text are retained; you can retry.")
                }
            }
        }
        speechTimeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(120))
            guard !Task.isCancelled, let self, self.transcriptionGeneration == token else { return }
            self.cancelTranscription(); self.error = nativeUI("本机转写等待超时。音频已保留，可分段后重试。", "On-device transcription timed out. Audio is retained; retry with a shorter segment.")
        }
    }
    func cancelTranscription() {
        transcriptionGeneration += 1; cloudTask?.cancel(); cloudTask=nil;isCloudTranscribing=false; speechTask?.cancel(); speechTask = nil
        speechTimeout?.cancel(); speechTimeout = nil; transcribingID = nil
    }
}
