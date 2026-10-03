import Foundation
import Combine

func nativeUI(_ zh:String,_ en:String)->String { en }
// Controller dependency only: no audio, configuration, device or network.
@MainActor final class NativeSpeechDictation:ObservableObject {
    enum Mode {case composer,quickConversation}
    enum Phase {case idle,authorizing,recording,recorded,transcribing,error}
    struct Lease:Equatable {let nonce:String;let conversationId:String?;let revision:Int;let mode:Mode}
    @Published var phase:Phase = .idle
    var lease:Lease?
    var retryAvailable=false
    var starts=0,finishes=0,retries=0,cancels=0
    var startHook:(()->Void)?
    var convertHook:((Lease) async->[String:Any])?
    func start(_ request:Lease,verify:@escaping @MainActor () async->Bool) async->[String:Any] {
        starts+=1;lease=request;phase = .authorizing
        guard await verify(),!Task.isCancelled else{lease=nil;phase = .idle;return ["status":"cancelled"]}
        startHook?();phase = .recording;return ["status":"recording"]
    }
    func finish(_ request:Lease) async->[String:Any] {finishes+=1;return await convert(request)}
    func retry(_ request:Lease) async->[String:Any] {retries+=1;return await convert(request)}
    func convert(_ request:Lease) async->[String:Any] {
        phase = .transcribing
        if let convertHook{return await convertHook(request)}
        lease=nil;phase = .idle;return ["status":"completed","nonce":request.nonce,"text":"Fictional instruction"]
    }
    func cancel(_ expected:Lease?=nil) {guard expected == nil || expected==lease else{return};cancels+=1;lease=nil;phase = .idle;retryAvailable=false}
}

@main struct VoiceCoordinatorChecks {
    @MainActor static func settle() async {for _ in 0..<12 {await Task.yield()};try? await Task.sleep(nanoseconds:1_000_000)}
    @MainActor static func automaticCoordinator(dictation:NativeSpeechDictation,verify:@escaping @MainActor () async -> Bool,submit:@escaping @MainActor (String,String) async -> [String:Any]) -> NativeVoiceCommandCoordinator {
        let value=NativeVoiceCommandCoordinator(dictation:dictation,verify:verify,submit:submit)
        value.autoSubmitProvider={true};return value
    }
    @MainActor static func main() async {
        var count=0
        func check(_ ok:Bool,_ name:String){precondition(ok,name);count+=1;print("PASS \(name)")}
        var submissions:[(String,String)]=[],accepted:[String]=[]
        let d=NativeSpeechDictation()
        let c=automaticCoordinator(dictation:d,verify:{true},submit:{id,text in submissions.append((id,text));return ["status":"accepted","requestId":id,"conversationId":"fictional-conversation"]})
        c.onAccepted={accepted.append($0)}
        c.invoke();c.invoke();await settle()
        check(d.starts==1 && c.phase == .recording,"repeated invoke while starting creates one recording")
        check(d.lease?.mode == .quickConversation && d.lease?.conversationId == nil,"voice uses independent quick-conversation lease")
        c.invoke();c.finish();await settle()
        check(d.finishes==1 && submissions.count==1,"finish invoked once and only completed text submitted")
        check(c.phase == .idle && c.text == "Fictional instruction" && c.execution?.status == "submitted" && accepted==["fictional-conversation"],"successful conversion retains transcript and submitted receipt without claiming completion")

        let retryD=NativeSpeechDictation();var retryIDs:[String]=[];var reject=true
        let retryC=automaticCoordinator(dictation:retryD,verify:{true},submit:{id,_ in retryIDs.append(id);return reject ? ["status":"deferred","requestId":id,"reason":"busy"]:["status":"accepted","requestId":id,"conversationId":"retry-conversation"]})
        retryC.start();await settle();retryC.finish();await settle()
        check(retryC.retryAvailable && !retryC.text.isEmpty && retryC.phase == .failed,"busy delivery retains recognized text for explicit retry")
        reject=false;retryC.retry();retryC.retry();await settle()
        check(retryIDs.count==2 && retryIDs[0]==retryIDs[1] && retryD.finishes==1,"retry reuses same request without retranscribing or duplicate retry")

        let closedD=NativeSpeechDictation();var reply:CheckedContinuation<[String:Any],Never>?;var sentID="",reveal=0,dismiss=0
        let closedC=automaticCoordinator(dictation:closedD,verify:{true},submit:{id,_ in sentID=id;return await withCheckedContinuation{reply=$0}})
        closedC.onAccepted={_ in reveal+=1};closedC.onDismiss={dismiss+=1}
        closedC.start();await settle();closedC.finish();await settle();closedC.cancel()
        check(closedC.phase == .submitting && !closedC.text.isEmpty && dismiss==1,"closing during submit hides without claiming rollback")
        reply?.resume(returning:["status":"accepted","requestId":sentID,"conversationId":"accepted-while-hidden"]);await settle()
        check(closedC.phase == .idle && reveal==0 && closedC.execution != nil && !closedC.text.isEmpty,"accepted hidden operation retains receipt without stealing workspace focus")

        let staleD=NativeSpeechDictation();var staleReply:CheckedContinuation<[String:Any],Never>?;var staleID="",staleReveal=0
        let staleC=automaticCoordinator(dictation:staleD,verify:{true},submit:{id,_ in staleID=id;return await withCheckedContinuation{staleReply=$0}})
        staleC.onAccepted={_ in staleReveal+=1};staleC.start();await settle();staleC.finish();await settle();staleC.invalidate()
        staleReply?.resume(returning:["status":"accepted","requestId":staleID,"conversationId":"old-owner"]);await settle()
        check(staleC.phase == .idle && staleC.text.isEmpty && staleReveal==0,"owner invalidation refuses late acknowledgement")

        let authD=NativeSpeechDictation();var allowed=true,authSends=0
        let authC=automaticCoordinator(dictation:authD,verify:{allowed},submit:{id,_ in authSends+=1;return ["status":"accepted","requestId":id,"conversationId":"forbidden"]})
        authC.start();await settle();allowed=false;authC.finish();await settle()
        check(authSends==0 && authC.retryAvailable,"permission revalidation before submit retains text without executing")
        authC.cancel();check(authC.phase == .idle && authC.text.isEmpty,"cancel before dispatch clears retained text")

        let failedD=NativeSpeechDictation();var conversionFails=true,failedSends=0
        failedD.convertHook={request in
            if conversionFails{failedD.retryAvailable=true;failedD.phase = .error;return ["status":"error","message":"Synthetic failure"]}
            failedD.cancel();return ["status":"completed","nonce":request.nonce,"text":"Recovered fictional text"]
        }
        let failedC=automaticCoordinator(dictation:failedD,verify:{true},submit:{id,_ in failedSends+=1;return ["status":"accepted","requestId":id,"conversationId":"retry-audio"]})
        failedC.start();await settle();failedC.finish();await settle();check(failedC.retryAvailable && failedSends==0,"failed transcription is retryable without any submission")
        conversionFails=false;failedC.retry();await settle();check(failedD.retries==1 && failedSends==1 && failedC.phase == .idle,"audio retry converts then submits once")

        let limitedD=NativeSpeechDictation();var limitSends=0
        let limitedC=automaticCoordinator(dictation:limitedD,verify:{true},submit:{_,_ in limitSends+=1;return [:]})
        limitedC.start();await settle();limitedD.phase = .recorded
        check(limitedC.phase == .recorded && limitedD.finishes==0 && limitSends==0,"recording limit leaves recorded state and cannot automatically execute")
        limitedD.cancel();check(limitedC.phase == .failed && limitSends==0,"external recording cancellation visibly stops without sending")

        let reentrantD=NativeSpeechDictation()
        let reentrantC=automaticCoordinator(dictation:reentrantD,verify:{true},submit:{_,_ in [:]})
        reentrantC.onPresent={reentrantC.cancel()}
        reentrantC.start();await settle()
        check(reentrantD.starts==0 && reentrantC.phase == .idle,"synchronous presentation cancellation cannot start a hidden microphone task")

        let holdD=NativeSpeechDictation();var holdSends=0
        let holdC=automaticCoordinator(dictation:holdD,verify:{true},submit:{id,_ in holdSends+=1;return ["status":"accepted","requestId":id,"conversationId":"held-command"]})
        holdC.beginHold();holdC.beginHold();await settle()
        check(holdD.starts==1 && holdC.phase == .recording,"hold repeat cannot finish its own new recording")
        holdC.endHold();holdC.endHold();await settle()
        check(holdD.finishes==1 && holdSends==1 && holdC.phase == .idle,"matching release finishes and submits once")
        holdC.beginHold();holdC.endHold();await settle()
        check(holdD.starts==1 && holdSends==1 && holdC.phase == .idle,"release before start task cancels without opening microphone")
        var preparation:CheckedContinuation<Bool,Never>?
        let slowD=NativeSpeechDictation()
        let slowC=automaticCoordinator(dictation:slowD,verify:{await withCheckedContinuation{preparation=$0}},submit:{_,_ in preconditionFailure("cancelled hold must not send")})
        slowC.beginHold();await settle();slowC.endHold();preparation?.resume(returning:true);await settle()
        check(slowD.starts==1 && slowD.finishes==0 && slowD.lease==nil && slowC.phase == .idle,"release during permission preparation cannot resurrect capture")
        holdC.beginHold();await settle();holdC.cancelHeldCapture();holdC.endHold();await settle()
        check(holdC.phase == .idle && holdD.finishes==1 && holdSends==1,"switching shortcut mode cancels held capture without executing")
        holdC.start();await settle();holdC.endHold();await settle()
        check(holdC.phase == .recording && holdD.finishes==1,"unpaired release never finishes a button-started recording")
        holdC.cancel()
        let previewD=NativeSpeechDictation();var previewSends=0,previewDismiss=0,previewOpened:[String]=[]
        let previewC=NativeVoiceCommandCoordinator(dictation:previewD,verify:{true},submit:{id,_ in previewSends+=1;return ["status":"accepted","requestId":id,"conversationId":"preview-chat","runId":"preview-run","userMessageId":"preview-user"]})
        previewC.onDismiss={previewDismiss+=1};previewC.onOpenConversation={previewOpened.append($0)}
        previewC.beginHold();await settle();previewC.endHold();await settle()
        check(previewC.phase == .preview && previewSends==0 && previewC.text=="Fictional instruction","default hold release transcribes to preview without sending")
        previewC.invoke();previewC.endHold();await settle()
        check(previewC.phase == .preview && previewSends==0,"shortcut invocation and unpaired release cannot confirm preview")
        previewC.cancel();previewC.sendPreview();await settle()
        check(previewC.phase == .idle && previewC.text.isEmpty && previewSends==0,"cancelled preview cannot be sent by a stale button action")
        previewC.start();await settle();previewC.finish();await settle();previewC.sendPreview();previewC.sendPreview();await settle()
        let acceptedReceipt=previewC.execution!
        check(previewSends==1 && previewC.phase == .idle && acceptedReceipt.status=="submitted" && acceptedReceipt.runID=="preview-run" && acceptedReceipt.userMessageID=="preview-user","explicit confirmation sends once and stores exact execution identifiers")
        check(previewDismiss==1 && previewOpened.isEmpty && !previewC.text.isEmpty,"acceptance retains transcript and panel without forced navigation")
        func project(_ status:String,_ ready:Bool=false,_ summary:String="",run:String?="preview-run",request:String?=nil,chat:String="preview-chat",user:String?="preview-user") {
            previewC.acceptExecution(runID:run,voiceRequestID:request ?? acceptedReceipt.requestID,conversationID:chat,userMessageID:user,status:status,notificationReady:ready,summary:summary)
        }
        project("running");check(previewC.execution?.status=="processing","actual running state becomes processing")
        project("awaiting-approval");check(previewC.execution?.status=="awaiting-approval","approval stays actionable and never counts as done")
        project("awaiting-input");check(previewC.execution?.status=="awaiting-input","input request remains distinct from failure")
        project("awaiting-save");check(previewC.execution?.status=="awaiting-save","pending persistence remains distinct from completion")
        project("completed",false,"Not durable yet");check(previewC.execution?.status=="processing","raw completed without ready receipt cannot show completed")
        project("completed-local",true,"Saved a fictional task")
        check(previewC.execution?.status=="completed" && previewC.execution?.summary=="Saved a fictional task","ready exact-run completion displays its supplied result summary")
        for mismatch in [0,1,2,3] {
            project("failed",false,"Wrong transaction",run:mismatch==0 ? "other-run":"preview-run",request:mismatch==1 ? "other-request":nil,chat:mismatch==2 ? "other-chat":"preview-chat",user:mismatch==3 ? "other-user":"preview-user")
        }
        check(previewC.execution?.status=="completed" && previewC.execution?.summary=="Saved a fictional task","mismatched request conversation run and user cannot alter the retained result")
        project("missing",false,"Stale private result")
        check(previewC.execution?.status=="unavailable" && previewC.execution?.summary=="" && !previewC.text.isEmpty,"missing projection keeps transcript but removes old result and never fabricates completion")
        for status in ["failed","cancelled","interrupted","rejected"] {project(status);check(previewC.execution?.status==status,"terminal state \(status) remains explicit")}
        previewC.cancel();check(previewC.execution != nil && !previewC.text.isEmpty && previewDismiss==2,"closing an accepted command hides without deleting its receipt")
        previewC.openConversation();check(previewOpened==["preview-chat"],"opening conversation is an explicit action for retained identity")
        previewC.retry();await settle();check(previewSends==1,"accepted failed or stopped runs cannot be blindly resubmitted")
        previewC.start();project("completed",true,"Late old result");await settle()
        check(previewC.execution==nil && previewC.text.isEmpty && previewC.phase == .recording,"starting new speech revokes old execution projection")
        previewC.cancel()
        project("completed",true,"After owner invalidation")
        check(previewC.execution==nil && previewC.text.isEmpty,"owner invalidation clears transcript and rejects late run updates")

        let policyD=NativeSpeechDictation();var automatic=false,policySends=0
        let policyC=NativeVoiceCommandCoordinator(dictation:policyD,verify:{true},submit:{id,_ in policySends+=1;return ["status":"accepted","requestId":id,"conversationId":"policy-chat"]})
        policyC.autoSubmitProvider={automatic}
        policyC.start();await settle();automatic=true;policyC.finish();await settle()
        check(policyC.phase == .preview && policySends==0,"enabling auto-submit mid-recording cannot bypass captured confirmation policy")
        policyC.cancel();policyC.start();await settle();automatic=false;policyC.finish();await settle()
        check(policyC.execution != nil && policySends==1,"explicit auto-submit choice is captured for its one command")
        let unbound=policyC.execution!
        policyC.acceptExecution(runID:"unrelated-run",voiceRequestID:unbound.requestID,conversationID:unbound.conversationID,userMessageID:"unknown-user",status:"completed",notificationReady:true,summary:"Must not claim")
        check(policyC.execution?.runID==nil && policyC.execution?.status=="submitted","receipt lacking user identity cannot claim a later run")
        policyC.invalidate()

        let messageD=NativeSpeechDictation()
        let messageC=automaticCoordinator(dictation:messageD,verify:{true},submit:{id,_ in ["status":"accepted","requestId":id,"conversationId":"message-chat","userMessageId":"known-user"]})
        messageC.start();await settle();messageC.finish();await settle();let messageReceipt=messageC.execution!
        messageC.acceptExecution(runID:"wrong-run",voiceRequestID:messageReceipt.requestID,conversationID:"message-chat",userMessageID:"wrong-user",status:"running",notificationReady:false,summary:"")
        check(messageC.execution?.runID==nil,"message-only acknowledgement rejects a run from a different message")
        messageC.acceptExecution(runID:"known-run",voiceRequestID:messageReceipt.requestID,conversationID:"message-chat",userMessageID:"known-user",status:"running",notificationReady:false,summary:"")
        check(messageC.execution?.runID=="known-run" && messageC.execution?.status=="processing","matching acknowledged user message binds its real run once")
        messageC.invalidate()

        let failurePreviewD=NativeSpeechDictation();var failPreview=true,failurePreviewSends=0
        failurePreviewD.convertHook={request in
            if failPreview {failurePreviewD.retryAvailable=true;return ["status":"error","message":"Synthetic retry"]}
            return ["status":"completed","nonce":request.nonce,"text":"Retry transcript"]
        }
        let failurePreviewC=NativeVoiceCommandCoordinator(dictation:failurePreviewD,verify:{true},submit:{_,_ in failurePreviewSends+=1;return [:]})
        failurePreviewC.start();await settle();failurePreviewC.finish();await settle();failPreview=false;failurePreviewC.retry();await settle()
        check(failurePreviewC.phase == .preview && failurePreviewSends==0,"successful ASR retry still requires confirmation under default policy")
        failurePreviewC.cancel()

        print("PASS: \(count) voice coordinator checks; fake audio dependency, no GUI or provider")
    }
}
