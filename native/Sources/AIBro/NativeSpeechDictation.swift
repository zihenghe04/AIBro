import Foundation
import Combine

/// Both modes share audio/configuration, but only the host of quickConversation
/// may submit its result. This controller never creates or sends a message.
@MainActor final class NativeSpeechDictation: ObservableObject {
    enum Mode: String, Codable, Sendable { case composer, quickConversation }
    enum Phase: String { case idle, authorizing, recording, recorded, transcribing, error }
    struct Lease: Equatable, Sendable {
        let nonce: String
        let conversationId: String?
        let revision: Int
        let mode: Mode
        var valid: Bool {
            UUID(uuidString:nonce) != nil && revision>=0 && revision<=9_007_199_254_740_991 &&
            (mode == .quickConversation ? conversationId == nil : conversationId.map{!$0.isEmpty && $0.utf8.count<=512 && !$0.unicodeScalars.contains(where:CharacterSet.controlCharacters.contains)} == true)
        }
        init(nonce:String,conversationId:String?,revision:Int,mode:Mode = .composer) {
            self.nonce=nonce;self.conversationId=conversationId;self.revision=revision;self.mode=mode
        }
        /// The web-facing RPC cannot claim the global automatic-submit mode.
        init?(composer value:[String:Any]) {
            guard Set(value.keys)==Set(["nonce","conversationId","revision"]),
                  let nonce=value["nonce"] as? String,let conversation=value["conversationId"] as? String,
                  let number=value["revision"] as? NSNumber,CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.doubleValue.isFinite,number.doubleValue.rounded()==number.doubleValue,
                  number.doubleValue>=0,number.doubleValue<=9_007_199_254_740_991 else{return nil}
            self.init(nonce:nonce,conversationId:conversation,revision:number.intValue)
            if !valid{return nil}
        }
        var payload:[String:Any] {
            var result:[String:Any]=["nonce":nonce,"revision":revision]
            if let conversationId {result["conversationId"]=conversationId}
            if mode == .quickConversation {result["mode"]=mode.rawValue}
            return result
        }
    }
    typealias Verify = @MainActor () async -> Bool
    typealias Transcribe = @Sendable (URL,NativeSpeechConfiguration,String) async throws -> String
    @Published private(set) var phase:Phase = .idle
    @Published private(set) var elapsed:TimeInterval = 0
    @Published private(set) var level:Double = 0
    @Published private(set) var error:String?
    @Published private(set) var available=false
    private(set) var lease:Lease?
    let settings:NativeSpeechSettings
    private let directory:URL
    private let permission:@MainActor () async -> Bool
    private let makeRecorder:@MainActor () throws -> NativeSpeechDictationRecording
    private let transcribe:Transcribe
    private let canCapture:@MainActor (Mode)->Bool
    private var verify:Verify?
    private var recorder:NativeSpeechDictationRecording?
    private var file:URL?
    private var generation=0,settingsRevision=0
    private var work:Task<String,Error>?
    private var permissionWork:Task<Bool,Never>?
    private var timer:Timer?
    private var expiresAt:Date?
    private var settingsObservation:AnyCancellable?
    /// Memory-only spent nonces stop a late old start RPC from resurrecting a
    /// cancelled session. Bounded; the current JS verifier is also mandatory.
    private var spent:[String]=[]
    init(settings:NativeSpeechSettings,directory:URL,
         canCapture:@escaping @MainActor (Mode)->Bool,
         permission:@escaping @MainActor () async -> Bool = {await NativeSpeechDictationRecorder.requestPermission()},
         makeRecorder:@escaping @MainActor () throws -> NativeSpeechDictationRecording = {NativeSpeechDictationRecorder()},
         transcribe:@escaping Transcribe = {try await NativeSpeechService.transcribe(fileURL:$0,configuration:$1,key:$2)}) {
        self.settings=settings;self.directory=directory;self.canCapture=canCapture
        self.permission=permission;self.makeRecorder=makeRecorder;self.transcribe=transcribe
        settingsObservation=settings.$revision.dropFirst().sink { [weak self] revision in
            guard let self,self.lease != nil,revision != self.settingsRevision else{return}
            self.invalidate()
        }
    }
    var retryAvailable:Bool {phase == .error && file != nil && lease != nil}
    var status:[String:Any] {
        var result=lease?.payload ?? [:]
        result["status"]=phase.rawValue;result["phase"]=phase.rawValue
        result["configured"]=settings.configured;result["available"]=available && settings.available
        result["elapsed"]=elapsed;result["retryAvailable"]=retryAvailable
        if let error {result["message"]=error}
        return result
    }
    var composerStatus:[String:Any] {
        guard lease?.mode == .quickConversation else{return status}
        return ["status":"busy","phase":"busy","available":false,"configured":settings.configured,"retryAvailable":false]
    }
    var canOpenComposerSettings:Bool {lease == nil}
    func setAvailable(_ value:Bool) {available=value;if !value{invalidate()}}
    func shutdown(){setAvailable(false);settingsObservation=nil}
    func invalidate(){_ = cancel()}
    @discardableResult func cancel(_ expected:Lease? = nil)->[String:Any] {
        guard expected == nil || lease==expected else{return reply("cancelled",expected)}
        let previous=lease
        if let previous {spent.append(previous.nonce);if spent.count>128{spent.removeFirst(spent.count-128)}}
        generation+=1;work?.cancel();work=nil;permissionWork?.cancel();permissionWork=nil
        recorder?.onFailure=nil;recorder?.stop();recorder=nil
        if let file{try? FileManager.default.removeItem(at:file)}
        file=nil;verify=nil;lease=nil;expiresAt=nil;timer?.invalidate();timer=nil
        phase = .idle;elapsed=0;level=0;error=nil
        return reply("cancelled",previous ?? expected)
    }
    func start(_ requested:Lease,verify:@escaping Verify) async->[String:Any] {
        guard requested.valid,!spent.contains(requested.nonce) else{return failure("expired",requested)}
        guard lease == nil else{return failure("busy",requested)}
        guard available,settings.available,settings.configured,!settings.busy,canCapture(requested.mode) else{return failure(settings.configured ? "unavailable":"not_configured",requested)}
        generation+=1;let token=generation
        lease=requested;self.verify=verify;settingsRevision=settings.revision;phase = .authorizing;error=nil;elapsed=0
        guard await current(requested,token) else{return cancelled(requested,token)}
        let permissionWork=Task {await permission()};self.permissionWork=permissionWork
        let permitted=await permissionWork.value
        guard await current(requested,token) else{return cancelled(requested,token)}
        self.permissionWork=nil
        guard permitted else{return failAndClear("permission",requested,token)}
        do {
            try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
            guard try directory.resourceValues(forKeys:[.isDirectoryKey,.isSymbolicLinkKey]).isSymbolicLink != true else{throw NativeSpeechError.invalidAudio}
            let url=directory.appendingPathComponent("dictation-"+UUID().uuidString.lowercased()+".m4a")
            file=url
            let next=try makeRecorder()
            next.onFailure={ [weak self] in
                guard let self,self.generation==token,self.lease==requested else{return}
                _ = self.failAndClear("recording_failed",requested,token)
            }
            try next.start(at:url);recorder=next;phase = .recording
            installTimer();return reply("recording",requested)
        }catch{return failAndClear("recording_failed",requested,token)}
    }
    func finish(_ requested:Lease) async->[String:Any] {
        guard lease==requested,phase == .recording || phase == .recorded else{return failure("expired",requested)}
        if phase == .recording{stopAudio()}
        return await convert(requested)
    }
    func retry(_ requested:Lease) async->[String:Any] {
        guard lease==requested,retryAvailable else{return failure("expired",requested)}
        return await convert(requested)
    }
    private func stopAudio() {
        elapsed=recorder?.elapsed ?? elapsed;recorder?.onFailure=nil;recorder?.stop();recorder=nil
        phase = .recorded;level=0;expiresAt=Date().addingTimeInterval(300)
    }
    private func installTimer() {
        timer?.invalidate()
        let next=Timer(timeInterval:0.25,repeats:true){[weak self] _ in MainActor.assumeIsolated{self?.tick()}}
        timer=next;RunLoop.main.add(next,forMode:.common)
    }
    /// Reaching the limit only closes audio. It must never send an instruction.
    func tick(now:Date=Date()) {
        if phase == .recording {
            elapsed=recorder?.elapsed ?? elapsed
            level=recorder?.level ?? 0
            if elapsed>=300{stopAudio()}
        }else if let expiresAt,now>=expiresAt{invalidate()}
    }
    private func owned(_ requested:Lease,_ token:Int)->Bool {
        generation==token && lease==requested && available && settings.available && settings.configured &&
        !settings.busy && settings.revision==settingsRevision && canCapture(requested.mode) && !Task.isCancelled
    }
    private func current(_ requested:Lease,_ token:Int) async->Bool {
        guard owned(requested,token),let verify else{return false}
        let allowed=await verify()
        return allowed && owned(requested,token)
    }
    private func convert(_ requested:Lease) async->[String:Any] {
        let token=generation
        guard let file,phase == .recorded || phase == .error else{return failure("busy",requested)}
        phase = .transcribing;expiresAt=nil;error=nil
        guard await current(requested,token) else{return cancelled(requested,token)}
        let settings=settings,transcribe=transcribe,version=settingsRevision
        let task=Task { () throws -> String in
            let (configuration,key)=try await settings.connection()
            try Task.checkCancellation()
            guard settings.revision==version else{throw NativeSpeechError.changed}
            return try await transcribe(file,configuration,key)
        }
        work=task
        do {
            let text=try await withTaskCancellationHandler(operation:{try await task.value},onCancel:{task.cancel()})
            guard await current(requested,token) else{return cancelled(requested,token)}
            guard !text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,text.utf8.count<=NativeSpeechService.responseLimit else{throw NativeSpeechError.invalidResponse}
            _ = cancel(requested)
            var result=reply("completed",requested);result["text"]=text;return result
        }catch{
            guard await current(requested,token) else{return cancelled(requested,token)}
            work=nil;phase = .error;expiresAt=Date().addingTimeInterval(300)
            let safe=(error as? NativeSpeechError ?? .network).localizedDescription
            self.error=safe
            var result=failure("transcription_failed",requested);result["message"]=safe;return result
        }
    }
    private func cancelled(_ requested:Lease,_ token:Int)->[String:Any] {
        if generation==token,lease==requested{_ = cancel(requested)}
        return reply("cancelled",requested)
    }
    private func failAndClear(_ reason:String,_ requested:Lease,_ token:Int)->[String:Any] {
        if generation==token,lease==requested{_ = cancel(requested);phase = .error;error=message(reason)}
        return failure(reason,requested)
    }
    private func reply(_ status:String,_ requested:Lease?)->[String:Any] {var result=requested?.payload ?? [:];result["status"]=status;return result}
    private func failure(_ reason:String,_ requested:Lease?)->[String:Any] {var result=reply("error",requested);result["reason"]=reason;result["message"]=message(reason);result["retryAvailable"]=lease==requested && retryAvailable;return result}
    private func message(_ reason:String)->String {
        switch reason {
        case "permission":return nativeUI("麦克风未获允许。请在系统设置中允许 AI Bro，然后重新开始。", "Microphone access was not granted. Allow AI Bro in System Settings, then start again.")
        case "not_configured":return nativeUI("请先配置独立语音服务。", "Configure the independent speech service first.")
        case "busy":return nativeUI("另一段语音正在处理中，请先完成或取消。", "Another voice session is active. Finish or cancel it first.")
        case "recording_failed":return nativeUI("未能完整录音，请重新开始。没有发送音频。", "Recording failed. Start again; no audio was sent.")
        case "expired":return nativeUI("这次语音已结束或页面已变化，请重新开始。", "This voice session ended or its page changed. Start again.")
        default:return NativeSpeechError.unavailable.localizedDescription
        }
    }
}
