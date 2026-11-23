import Foundation
import Combine

func nativeUI(_ zh:String,_ en:String)->String { en }
// Controller dependency only: no audio, configuration, device or network.
@MainActor final class NativeSpeechDictation:ObservableObject {
    enum Mode {case composer,quickConversation,inject}
    enum Phase {case idle,authorizing,recording,recorded,transcribing,error}
    struct Lease:Equatable {let nonce:String;let conversationId:String?;let revision:Int;let mode:Mode}
    @Published var phase:Phase = .idle
    var lease:Lease?
    var autoStopped=false,autoStopAllowed=true
    var starts=0,finishes=0,cancels=0
    var text="Fictional dictated sentence"
    @Published var liveText=""
    var convertHook:((Lease) async->[String:Any])?
    func start(_ request:Lease,verify:@escaping @MainActor () async->Bool) async->[String:Any] {
        starts+=1;lease=request;phase = .authorizing
        guard await verify(),!Task.isCancelled else{lease=nil;phase = .idle;return ["status":"cancelled"]}
        phase = .recording;return ["status":"recording"]
    }
    func finish(_ request:Lease) async->[String:Any] {
        finishes+=1;phase = .transcribing
        if let convertHook{return await convertHook(request)}
        lease=nil;phase = .idle;return ["status":"completed","nonce":request.nonce,"text":text]
    }
    func cancel(_ expected:Lease?=nil) {guard expected == nil || expected==lease else{return};cancels+=1;lease=nil;phase = .idle}
}

@MainActor final class Harness {
    let d=NativeSpeechDictation()
    var clock=Date(timeIntervalSince1970:1000)
    var gates:[CheckedContinuation<Void,Never>]=[]
    var target:NativeDictationInjectTarget?=NativeDictationInjectTarget(pid:42,bundleID:"com.example.editor",launchedAt:nil,name:"Editor")
    var injected:[(String,NativeDictationInjectTarget)]=[]
    var outcome:NativeDictationInjectOutcome = .typed
    lazy var c:NativeDictationInjectCoordinator = NativeDictationInjectCoordinator(dictation:d,verify:{true},frontmost:{[unowned self] in self.target},
        inject:{[unowned self] text,target in self.injected.append((text,target));return self.outcome},
        now:{[unowned self] in self.clock},sleep:{[unowned self] _ in await withCheckedContinuation{self.gates.append($0)}})
    /// Fires the arm delay (the oldest pending sleep).
    func fireArm() async {await settle();if !gates.isEmpty{gates.removeFirst().resume()};await settle()}
    func advance(_ s:Double){clock=clock.addingTimeInterval(s)}
    func settle() async {for _ in 0..<12 {await Task.yield()};try? await Task.sleep(nanoseconds:1_000_000)}
}

@main struct InjectCoordinatorChecks {
    @MainActor static func main() async {
        var count=0
        func check(_ ok:Bool,_ name:String){precondition(ok,name);count+=1;print("PASS \(name)")}

        // Hold to talk.
        var h=Harness()
        h.c.press();await h.settle()
        check(h.d.starts==0,"press does not open the microphone before the arm delay")
        await h.fireArm()
        check(h.d.starts==1 && h.c.phase == .recording && !h.c.latched && h.d.lease?.mode == .inject && h.d.lease?.conversationId == nil,"held trigger records with an inject lease")
        check(h.d.autoStopAllowed==false,"held recording does not auto-stop on silence")
        check(h.c.presentationSymbol=="mic.fill" && h.c.presentationTitle=="Dictating" && h.c.presentationHint=="release to insert","island shows listening title and hold hint")
        h.advance(1.2);h.c.release();await h.settle()
        check(h.d.finishes==1 && h.injected.count==1 && h.injected[0].0=="Fictional dictated sentence" && h.injected[0].1.pid==42,"release transcribes and injects into the press-time target")
        check(h.c.phase == .done && h.c.presentationTitle=="Inserted" && h.c.outcome == .typed,"typed outcome reports inserted")

        // Target is fixed at press time even if the frontmost app changes later.
        h=Harness();h.c.press();await h.fireArm()
        h.target=NativeDictationInjectTarget(pid:7,bundleID:"com.example.other",launchedAt:nil,name:"Other")
        h.advance(1);h.c.release();await h.settle()
        check(h.injected.first?.1.pid==42,"target snapshot is taken at press, not at release")

        // Quick tap before the microphone opens latches; second tap stops.
        h=Harness();h.c.press();h.advance(0.05);h.c.release();await h.settle()
        check(h.d.starts==1 && h.c.phase == .recording && h.c.latched && h.d.autoStopAllowed,"tap latches recording with silence auto-stop")
        check(h.c.presentationTitle=="Dictating" && h.c.presentationHint=="tap again to stop","island shows tap-again hint")
        h.advance(3);h.c.press();await h.settle()
        check(h.d.finishes==1 && h.injected.count==1,"second tap finishes on key down")
        h.c.release();await h.settle()
        check(h.d.starts==1 && h.injected.count==1,"second tap release does not start another recording")

        // Short hold after the mic opened still counts as a tap.
        h=Harness();h.c.press();await h.fireArm();h.advance(0.2);h.c.release();await h.settle()
        check(h.c.phase == .recording && h.c.latched && h.d.finishes==0,"release under tap threshold latches instead of finishing")
        h.c.press();await h.settle();h.c.release();await h.settle()
        check(h.injected.count==1,"latched recording finishes on next tap")

        // Another key joins the trigger: shortcut, not dictation.
        h=Harness();h.c.press();h.c.abortPress();await h.fireArm()
        check(h.d.starts==0 && h.c.phase == .idle,"chord during arm delay never records")
        h=Harness();h.c.press();await h.fireArm();h.c.abortPress();await h.settle()
        check(h.d.cancels==1 && h.d.lease==nil && h.c.phase == .idle && h.injected.isEmpty,"chord during hold cancels the recording")
        h=Harness();h.c.press();h.c.release();await h.settle();h.c.press();h.c.abortPress();await h.settle()
        check(h.d.finishes==1,"chord on stop tap still stops the latched recording")

        // No target, busy dictation.
        h=Harness();h.target=nil;h.c.press();await h.fireArm()
        check(h.d.starts==0 && h.c.phase == .failed && h.c.presentationTitle.contains("Click"),"no focused app reports and does not record")
        h=Harness();h.d.lease = .init(nonce:"x",conversationId:"c",revision:1,mode:.composer);h.c.press();await h.fireArm()
        check(h.d.starts==0 && h.c.phase == .failed,"existing composer dictation is not interrupted")

        // Outcomes that fall back to the clipboard.
        h=Harness();h.outcome = .copied(.secure);h.c.press();await h.fireArm();h.advance(1);h.c.release();await h.settle()
        check(h.c.phase == .failed && h.c.presentationTitle.contains("Password") && h.c.presentationSymbol=="doc.on.clipboard","secure field reports copied")
        for reason in [NativeDictationInjectOutcome.CopyReason.permission,.targetChanged,.unverified,.noFocus,.failed] {
            check(NativeDictationInjectCoordinator.copiedMessage(reason).contains("copied"),"copy reason \(reason.rawValue) mentions clipboard")
        }
        h=Harness();h.d.text="";h.outcome = .empty;h.c.press();await h.fireArm();h.advance(1);h.c.release();await h.settle()
        check(h.c.phase == .failed && h.c.presentationTitle.contains("No speech"),"empty transcript reports nothing recognized")

        // Recording lifecycle edges.
        h=Harness();h.c.press();h.c.release();await h.settle();h.d.autoStopped=true;h.d.phase = .recorded;await h.settle()
        check(h.d.finishes==1 && h.injected.count==1,"silence auto-stop of latched recording injects")
        h=Harness();h.c.press();await h.fireArm();h.d.phase = .error;await h.settle()
        check(h.c.phase == .failed && h.injected.isEmpty,"recorder error fails without injecting")

        var reply:CheckedContinuation<[String:Any],Never>?
        h=Harness();h.d.convertHook={_ in await withCheckedContinuation{reply=$0}}
        h.c.press();await h.fireArm();h.advance(1);let nonce=h.d.lease!.nonce;h.c.release();await h.settle()
        check(h.c.phase == .transcribing && h.c.presentationBusy,"transcribing is shown busy")
        h.c.press();h.c.release();await h.settle()
        check(h.d.starts==1,"trigger during transcription does not start a second recording")
        h.c.invalidate();reply?.resume(returning:["status":"completed","nonce":nonce,"text":"late"]);await h.settle()
        check(h.injected.isEmpty && h.c.phase == .idle,"invalidated session never injects a late transcript")

        h=Harness();h.d.convertHook={_ in ["status":"completed","nonce":"other","text":"wrong"]}
        h.c.press();await h.fireArm();h.advance(1);h.c.release();await h.settle()
        check(h.injected.isEmpty && h.c.phase == .failed,"mismatched nonce is rejected")

        // Interim text reaches the island while listening, and is cleared after.
        h=Harness();h.c.press();await h.fireArm()
        check(h.c.presentationDetail==nil,"no detail before any words arrive")
        h.d.liveText="Fictional interim words that keep arriving";await h.settle()
        check(h.c.presentationDetail?.hasSuffix("keep arriving")==true,"interim text is shown as island detail")
        check((h.c.presentationDetail?.count ?? 99)<=24,"interim detail is clipped to 24 characters")
        h.advance(1);h.c.release();await h.settle()
        check(h.c.presentationDetail==nil,"detail disappears once recording ends")

        // The debug log lands in the configured folder with the chain events.
        let logDir=FileManager.default.temporaryDirectory.appendingPathComponent("aibro-dlog-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at:logDir,withIntermediateDirectories:true)
        NativeDictateLog.shared.configure(folder:logDir)
        h=Harness();h.c.press();await h.fireArm();h.advance(1);h.c.release();await h.settle()
        try? await Task.sleep(nanoseconds:300_000_000)
        let logText=(try? String(contentsOf:logDir.appendingPathComponent("dictate-debug.log"),encoding:.utf8)) ?? ""
        check(!logText.isEmpty && logText.lowercased().contains("press") && logText.lowercased().contains("transcri"),"dictate-debug.log records press and transcription")
        check(!logText.contains("Fictional dictated sentence"),"log never stores dictated text")
        try? FileManager.default.removeItem(at:logDir)

        print("dictation inject coordinator checks: \(count); fake audio dependency")
    }
}
