import Foundation
import Combine

/// Microphone source for live dictation: writes the recording file (kept for a cloud fallback) and delivers 16 kHz PCM as it is captured.
@MainActor protocol NativeDictationAudio: AnyObject {
    var elapsed: TimeInterval { get }
    var level: Double { get }
    func start(url: URL, onPCM: @escaping @Sendable (Data) -> Void, onFailure: @escaping @Sendable () -> Void, onStreamFailure: @escaping @Sendable () -> Void) throws
    func stop() async -> NativeQuickRealtimeASRAudio.Receipt
}
extension NativeQuickRealtimeASRAudio: NativeDictationAudio {}

/// Live (realtime) transcription for dictation. `connection` returns the active realtime scheme and its Key, or nil when none is enabled.
struct NativeDictationRealtime {
    var connection: @MainActor () -> (NativeQuickASRConfiguration, String)?
    var makeSession: @MainActor () -> NativeQuickRealtimeASRSession = { NativeQuickRealtimeASRSession() }
    var makeAudio: @MainActor () -> any NativeDictationAudio = { NativeQuickRealtimeASRAudio() }
}

enum NativeDictationPreferences {
    /// Seconds of silence after speech before dictation stops by itself; 0 turns it off. The settings sheets bind to the same key.
    static let silenceKey = "aibro.dictation.silenceSeconds"
    static let defaultSilence: TimeInterval = 1.5
    static var silenceSeconds: TimeInterval {
        guard let value = UserDefaults.standard.object(forKey: silenceKey) as? Double, value.isFinite else { return defaultSilence }
        return min(10, max(0, value))
    }
    /// Linear RMS above which the microphone counts as hearing speech.
    static let speechLevel = 0.02
}

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
    /// Text heard so far while a live session runs (partials are replaced, finals kept).
    @Published private(set) var liveText=""
    /// One-time hint, e.g. that live transcription failed and the cloud scheme takes over after recording.
    @Published private(set) var notice:String?
    /// True when the recording ended because the speaker stopped talking; the host then goes straight to the confirmation.
    @Published private(set) var autoStopped=false
    /// The host turns this off for a hold-to-talk press: releasing the key ends that recording, silence must not.
    var autoStopAllowed=true
    private(set) var lease:Lease?
    let settings:NativeSpeechSettings
    private let directory:URL
    private let permission:@MainActor () async -> Bool
    private let makeRecorder:@MainActor () throws -> NativeSpeechDictationRecording
    private let transcribe:Transcribe
    private let canCapture:@MainActor (Mode)->Bool
    private let realtime:NativeDictationRealtime?
    private let silenceSeconds:@MainActor ()->TimeInterval
    private var liveAudio:(any NativeDictationAudio)?,liveSession:NativeQuickRealtimeASRSession?,liveHandoff:NativeQuickASRPCMHandoff?,liveStop:Task<Void,Never>?
    private var liveCapable=false,liveFailed=false,spoke=false,lastActivity=Date()
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
         realtime:NativeDictationRealtime?=nil,
         silenceSeconds:@escaping @MainActor ()->TimeInterval={NativeDictationPreferences.silenceSeconds},
         permission:@escaping @MainActor () async -> Bool = {await NativeSpeechDictationRecorder.requestPermission()},
         makeRecorder:@escaping @MainActor () throws -> NativeSpeechDictationRecording = {NativeSpeechDictationRecorder()},
         transcribe:@escaping Transcribe = {try await NativeSpeechService.transcribe(fileURL:$0,configuration:$1,key:$2)}) {
        self.settings=settings;self.directory=directory;self.canCapture=canCapture;self.realtime=realtime;self.silenceSeconds=silenceSeconds
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
        result["configured"]=settings.configured || liveCapable || realtime?.connection() != nil;result["available"]=available && settings.available
        result["liveText"]=liveText;result["autoStopped"]=autoStopped;if let notice {result["notice"]=notice}
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
        recorder?.onFailure=nil;recorder?.stop();recorder=nil;teardownLive()
        if let file{try? FileManager.default.removeItem(at:file)}
        file=nil;verify=nil;lease=nil;expiresAt=nil;timer?.invalidate();timer=nil
        phase = .idle;elapsed=0;level=0;error=nil;liveText="";notice=nil;autoStopped=false
        return reply("cancelled",previous ?? expected)
    }
    func start(_ requested:Lease,verify:@escaping Verify) async->[String:Any] {
        guard requested.valid,!spent.contains(requested.nonce) else{return failure("expired",requested)}
        guard lease == nil else{return failure("busy",requested)}
        let live=realtime?.connection()
        guard available,settings.available,settings.configured || live != nil,!settings.busy,canCapture(requested.mode) else{return failure(settings.configured || live != nil ? "unavailable":"not_configured",requested)}
        generation+=1;let token=generation;liveCapable=live != nil;autoStopped=false
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
            file=url;spoke=false;lastActivity=Date();liveFailed=false;liveText="";notice=nil;autoStopped=false
            if let live,let realtime {
                try beginLive(live,realtime,url,requested,token);phase = .recording
            }else{
                let next=try makeRecorder()
                next.onFailure={ [weak self] in
                    guard let self,self.generation==token,self.lease==requested else{return}
                    _ = self.failAndClear("recording_failed",requested,token)
                }
                try next.start(at:url);recorder=next;phase = .recording
            }
            installTimer();return reply("recording",requested)
        }catch{return failAndClear("recording_failed",requested,token)}
    }
    func finish(_ requested:Lease) async->[String:Any] {
        guard lease==requested,phase == .recording || phase == .recorded else{return failure("expired",requested)}
        if phase == .recording{if liveAudio != nil{await stopLive()}else{stopAudio()}}
        guard lease==requested else{return failure("expired",requested)}
        return await convert(requested)
    }
    func retry(_ requested:Lease) async->[String:Any] {
        guard lease==requested,retryAvailable else{return failure("expired",requested)}
        return await convert(requested)
    }
    /// Starts the microphone with a live session beside it. If the session cannot start, recording continues for the cloud fallback.
    private func beginLive(_ live:(NativeQuickASRConfiguration,String),_ realtime:NativeDictationRealtime,_ url:URL,_ requested:Lease,_ token:Int) throws {
        let audio=realtime.makeAudio(),session=realtime.makeSession()
        session.onChange={[weak self] snapshot in
            guard let self,self.generation==token,self.lease==requested else{return}
            self.liveChanged(snapshot)
        }
        let handoff=NativeQuickASRPCMHandoff(receive:{[weak self] data in
            guard let self,self.generation==token,self.lease==requested,let session=self.liveSession else{return false}
            session.append(data);return true
        },onFailure:{[weak self] in Task{@MainActor in
            guard let self,self.generation==token else{return};self.liveSession?.inputFailed()
        }})
        liveAudio=audio;liveSession=session;liveHandoff=handoff
        try audio.start(url:url,onPCM:{data in handoff.send(data)},onFailure:{[weak self] in Task{@MainActor in
            guard let self,self.generation==token,self.lease==requested else{return}
            _ = self.failAndClear("recording_failed",requested,token)
        }},onStreamFailure:{[weak self] in Task{@MainActor in
            guard let self,self.generation==token else{return};self.liveSession?.inputFailed()
        }})
        do{try session.start(configuration:live.0,key:live.1)}
        catch{
            session.cancel();liveSession=nil;liveFailed=true
            if notice==nil{notice=nativeUI("实时转写没能连上，已改为录完后转写。", "Live transcription could not connect; transcribing after recording instead.")}
        }
    }
    private func liveChanged(_ snapshot:NativeQuickASRSnapshot) {
        if snapshot.text != liveText{liveText=snapshot.text;lastActivity=Date();if !snapshot.text.isEmpty{spoke=true}}
        if snapshot.phase == .failed && !liveFailed {
            liveFailed=true
            if notice==nil{notice=nativeUI("实时转写中断了，已改为录完后转写。", "Live transcription was interrupted; transcribing after recording instead.")}
        }
    }
    /// Closes the microphone and drains the PCM already captured; the session itself stays open until `convert` asks for the final text.
    private func stopLive() async {
        if let liveStop{await liveStop.value;return}
        guard let audio=liveAudio,phase == .recording else{return}
        let handoff=liveHandoff,token=generation
        let task=Task{@MainActor [weak self] in
            let receipt=await audio.stop();handoff?.close()
            guard let self,self.generation==token else{return}
            if receipt.streamInterrupted || handoff?.failed == true{self.liveSession?.inputFailed()}
            self.elapsed=receipt.duration;self.liveAudio=nil;self.level=0
            if self.phase == .recording{self.phase = .recorded;self.expiresAt=Date().addingTimeInterval(300)}
            self.liveStop=nil
        }
        liveStop=task;await task.value
    }
    private func teardownLive() {
        liveStop?.cancel();liveStop=nil
        liveHandoff?.close();liveHandoff=nil
        liveSession?.onChange=nil;liveSession?.cancel();liveSession=nil
        if let audio=liveAudio{Task{@MainActor in _ = await audio.stop()}}
        liveAudio=nil;liveCapable=false;liveFailed=false;spoke=false
    }
    private func autoStop() {
        autoStopped=true
        if liveAudio != nil{Task{await stopLive()}}else{stopAudio()}
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
            elapsed=liveAudio?.elapsed ?? recorder?.elapsed ?? elapsed
            level=liveAudio?.level ?? recorder?.level ?? 0
            if elapsed>=300{if liveAudio != nil{Task{await stopLive()}}else{stopAudio()};return}
            if level>NativeDictationPreferences.speechLevel{spoke=true;lastActivity=now}
            let window=silenceSeconds()
            if window>0,autoStopAllowed,spoke,liveStop == nil,now.timeIntervalSince(lastActivity)>=window,elapsed>=0.5{autoStop()}
        }else if let expiresAt,now>=expiresAt{invalidate()}
    }
    private func owned(_ requested:Lease,_ token:Int)->Bool {
        generation==token && lease==requested && available && settings.available && (settings.configured || liveCapable) &&
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
        if let session=liveSession {
            let live=await session.finish()
            liveSession=nil;liveHandoff?.close();liveHandoff=nil
            guard await current(requested,token) else{return cancelled(requested,token)}
            let heard=live.text
            if live.phase == .completed,!live.hasGap,!liveFailed {
                guard !heard.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else{return fail(.noSpeech,requested,token)}
                return complete(heard,requested)
            }
            if notice==nil{notice=nativeUI("实时转写没有完整完成，已改为录完后转写。", "Live transcription did not complete; transcribing the recording instead.")}
        }
        if !settings.configured {
            work=nil;phase = .error;expiresAt=Date().addingTimeInterval(300)
            let safe=nativeUI("实时转写没有完成，且没有配置云转写方案可以接替。", "Live transcription did not finish and no cloud scheme is configured to take over.");self.error=safe
            var result=failure("transcription_failed",requested);result["message"]=safe;return result
        }
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
            return complete(text,requested)
        }catch{
            guard await current(requested,token) else{return cancelled(requested,token)}
            work=nil;phase = .error;expiresAt=Date().addingTimeInterval(300)
            let safe=(error as? NativeSpeechError ?? .network).localizedDescription
            self.error=safe
            var result=failure("transcription_failed",requested);result["message"]=safe;return result
        }
    }
    private func complete(_ text:String,_ requested:Lease)->[String:Any] {
        _ = cancel(requested)
        var result=reply("completed",requested);result["text"]=text;return result
    }
    private func fail(_ failure:NativeSpeechError,_ requested:Lease,_ token:Int)->[String:Any] {
        work=nil;phase = .error;expiresAt=Date().addingTimeInterval(300)
        self.error=failure.localizedDescription
        var result=self.failure("transcription_failed",requested);result["message"]=failure.localizedDescription;return result
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
