import Foundation
import Combine

/// A voice instruction has its own request identity, separate from the chat
/// editor. A failed delivery retries that identity, never starts a second chat.
@MainActor final class NativeVoiceCommandCoordinator: ObservableObject {
    enum Phase: Equatable { case idle, starting, recording, recorded, transcribing, preview, submitting, failed }
    struct Execution: Equatable {
        let requestID: String
        let conversationID: String
        var runID: String?
        var userMessageID: String?
        var status: String
        var summary: String
        var statusLabel: String {
            switch status {
            case "submitted": return nativeUI("指令已提交", "Instruction submitted")
            case "processing": return nativeUI("AI Bro 正在处理", "AI Bro is working")
            case "awaiting-approval": return nativeUI("等待你确认", "Awaiting your approval")
            case "awaiting-input": return nativeUI("等待补充信息", "More information needed")
            case "awaiting-save": return nativeUI("等待确认保存", "Awaiting save confirmation")
            case "completed": return nativeUI("已完成", "Completed")
            case "failed": return nativeUI("执行未完成", "Execution failed")
            case "cancelled": return nativeUI("已停止", "Stopped")
            case "interrupted": return nativeUI("执行已中断", "Execution interrupted")
            case "rejected": return nativeUI("已拒绝执行", "Execution rejected")
            default: return nativeUI("暂时无法读取执行状态", "Execution status unavailable")
            }
        }
    }
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var issue: String?
    @Published private(set) var text = ""
    @Published private(set) var execution: Execution?
    let dictation: NativeSpeechDictation
    var onPresent: (() -> Void)?
    var onDismiss: (() -> Void)?
    var onAccepted: ((String) -> Void)?
    var onOpenConversation: ((String) -> Void)?
    var autoSubmitProvider: () -> Bool = { false }
    private let verify: @MainActor () async -> Bool
    private let submit: @MainActor (String,String) async -> [String:Any]
    private var lease: NativeSpeechDictation.Lease?
    private var generation = 0
    private var operation: Task<Void,Never>?
    private var subscription: AnyCancellable?
    private var wantsReveal = true
    private var heldGeneration: Int?
    private var autoSubmitThisCommand = false
    init(dictation:NativeSpeechDictation,verify:@escaping @MainActor () async -> Bool,
         submit:@escaping @MainActor (String,String) async -> [String:Any]) {
        self.dictation=dictation;self.verify=verify;self.submit=submit
        subscription=dictation.$phase.sink { [weak self] state in
            guard let self,self.lease != nil else{return}
            if state == .recorded && self.phase == .recording {self.phase = .recorded}
            // Successful conversion also emits idle before returning text. Do
            // not revoke that completion; only reconcile a live audio session.
            if [.starting,.recording,.recorded].contains(self.phase) && (state == .idle || state == .error) {
                self.phase = .failed
                self.issue=nativeUI("录音已停止，未提交指令。可以重新开始。", "Recording stopped without submitting an instruction. You can start again.")
            }
        }
    }
    var retryAvailable:Bool {execution == nil && phase == .failed && (!text.isEmpty || dictation.retryAvailable)}
    func invoke() {
        switch phase {
        case .idle: start()
        case .recording,.recorded: finish()
        case .failed,.preview: onPresent?()
        default: break
        }
    }
    /// A release belongs only to the recording begun by that physical press.
    /// Releasing while permissions/device preparation are pending cancels the
    /// start, rather than opening a microphone after the user has let go.
    func beginHold() {
        guard heldGeneration == nil else{return}
        if phase == .idle || phase == .failed && text.isEmpty && !dictation.retryAvailable {
            start()
            if phase == .starting || phase == .recording {heldGeneration=generation}
        }else if phase == .failed || phase == .preview {onPresent?()}
    }
    func endHold() {
        guard let held=heldGeneration else{return}
        heldGeneration=nil
        guard held==generation else{return}
        if phase == .starting {invalidate()}
        else if phase == .recording || phase == .recorded {finish()}
    }
    func cancelHeldCapture() {
        guard let held=heldGeneration else{return}
        heldGeneration=nil
        if held==generation && [.starting,.recording,.recorded].contains(phase) {invalidate()}
    }
    func start() {
        guard phase == .idle || phase == .failed && text.isEmpty && !dictation.retryAvailable else{return}
        guard dictation.lease == nil else {
            issue=nativeUI("请先结束当前语音输入或录音。", "Finish the current dictation or recording first.")
            phase = .failed;onPresent?();return
        }
        generation+=1;let token=generation
        let request=NativeSpeechDictation.Lease(nonce:UUID().uuidString,conversationId:nil,revision:token,mode:.quickConversation)
        autoSubmitThisCommand=autoSubmitProvider()
        execution=nil;lease=request;text="";issue=nil;wantsReveal=true;phase = .starting;onPresent?()
        operation=Task { [weak self] in
            guard let self,self.generation==token,self.lease==request,!Task.isCancelled else{return}
            let result=await self.dictation.start(request,verify:self.verify)
            guard self.generation==token,self.lease==request,!Task.isCancelled else{return}
            self.operation=nil
            if result["status"] as? String == "recording" {self.phase = .recording}
            else {self.phase = .failed;self.issue=result["message"] as? String ?? nativeUI("暂时无法开始语音，请稍后重试。", "Voice input is unavailable. Try again shortly.")}
        }
    }
    func finish() {
        guard phase == .recording || phase == .recorded,let request=lease else{return}
        heldGeneration=nil
        convert(request,retry:false)
    }
    func retry() {
        guard retryAvailable,let request=lease else{return}
        if !text.isEmpty {
            let token=generation;phase = .submitting;issue=nil
            operation=Task { [weak self] in await self?.deliver(request,token:token) }
        }else{convert(request,retry:true)}
    }
    func sendPreview() {
        guard phase == .preview,execution == nil,let request=lease,!text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else{return}
        let token=generation;phase = .submitting;issue=nil
        operation=Task { [weak self] in
            guard let self,self.generation==token,self.lease==request,!Task.isCancelled else{return}
            await self.deliver(request,token:token)
        }
    }
    private func convert(_ request:NativeSpeechDictation.Lease,retry:Bool) {
        let token=generation;phase = .transcribing;issue=nil
        operation=Task { [weak self] in
            guard let self else{return}
            let result=await (retry ? self.dictation.retry(request):self.dictation.finish(request))
            guard self.generation==token,self.lease==request,!Task.isCancelled else{return}
            guard result["status"] as? String == "completed",result["nonce"] as? String == request.nonce,
                  let text=result["text"] as? String,!text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else {
                self.operation=nil;self.phase = .failed
                self.issue=result["message"] as? String ?? nativeUI("语音已取消，未提交指令。", "Voice input was cancelled; no instruction was submitted.");return
            }
            self.text=text
            guard self.generation==token,self.lease==request,!Task.isCancelled else{return}
            if self.autoSubmitThisCommand {
                self.phase = .submitting
                await self.deliver(request,token:token)
            }else{
                self.operation=nil;self.phase = .preview
            }
        }
    }
    private func deliver(_ request:NativeSpeechDictation.Lease,token:Int) async {
        guard await verify(),generation==token,lease==request,!Task.isCancelled else {
            if generation==token {phase = .failed;issue=nativeUI("工作区暂不可用。文字已保留，可稍后重试。", "The workspace is unavailable. Your text is retained for retry.");operation=nil};return
        }
        let result=await submit(request.nonce,text)
        guard generation==token,lease==request,!Task.isCancelled else{return}
        operation=nil
        if result["status"] as? String == "accepted",result["requestId"] as? String == request.nonce,
           let id=result["conversationId"] as? String,!id.isEmpty {
            let reveal=wantsReveal
            let runID=(result["runId"] as? String).flatMap{ $0.isEmpty ? nil:$0 }
            let userMessageID=(result["userMessageId"] as? String).flatMap{ $0.isEmpty ? nil:$0 }
            execution=Execution(requestID:request.nonce,conversationID:id,runID:runID,userMessageID:userMessageID,status:"submitted",summary:"")
            lease=nil;issue=nil;phase = .idle
            if reveal{onAccepted?(id)}
        }else{
            phase = .failed
            let reason=result["reason"] as? String ?? "unconfirmed"
            switch reason {
            case "busy","execution_busy","voice_command_busy":issue=nativeUI("AI Bro 正在执行另一项任务。文字已保留，结束后可重试。", "AI Bro is running another task. Your text is retained; retry when it finishes.")
            case "editing","draft","editor_active","composition_active":issue=nativeUI("请先完成当前编辑。语音文字已保留，可稍后继续提交。", "Finish the current edit. Your voice text is retained for later submission.")
            case "navigation_blocked","navigation_changed","context_changed":issue=nativeUI("对话切换未完成，指令尚未执行。文字已保留，请重试。", "The chat switch did not complete. Nothing was run; your text is retained for retry.")
            case "draft_changed","conversation_changed","request_changed","request_retired_or_ambiguous":issue=nativeUI("这条指令对应的对话已被修改，未再次执行。可复制下方文字到新对话。", "The associated chat has changed, so this instruction was not rerun. Copy the text below into a new chat.")
            case "draft_save_failed","conversation_save_failed","dispatch_save_failed":issue=nativeUI("本地保存未完成，指令尚未执行。文字已保留，请重试。", "Local saving did not complete. Nothing was run; your text is retained for retry.")
            case "send_not_started":issue=nativeUI("消息未能发送，指令尚未执行。请检查模型配置后重试。", "The message was not sent. Check your model settings, then retry.")
            case "unavailable","workspace_unavailable","workspace_not_ready":issue=nativeUI("工作区尚未就绪，指令未执行。文字已保留，请稍后重试。", "The workspace is not ready. Nothing was run; your text is retained for retry.")
            default:issue=nativeUI("暂未确认提交。文字已保留；重试会继续同一条指令。", "Submission is not confirmed. Your text is retained; retry continues the same instruction.")
            }
        }
    }
    /// Once dispatch begins, closing a panel cannot retract an accepted Agent
    /// run. Retain this transaction until its acknowledgement instead.
    func cancel() {
        if phase == .submitting {wantsReveal=false;onDismiss?();return}
        if execution != nil {onDismiss?();return}
        invalidate()
    }
    /// Updates a projection of one accepted request. It never polls, resubmits,
    /// stops a run, or treats disappearance of a record as completion.
    func acceptExecution(runID:String?,voiceRequestID:String,conversationID:String,userMessageID:String?,status:String,notificationReady:Bool,summary:String) {
        guard var current=execution,current.requestID==voiceRequestID,current.conversationID==conversationID else{return}
        if let expected=current.runID {guard runID==expected else{return}}
        if let expected=current.userMessageID {guard userMessageID==expected else{return}}
        let normalized:String
        switch status {
        case "submitted": normalized = "submitted"
        case "running", "processing": normalized = "processing"
        case "awaiting-approval": normalized = "awaiting-approval"
        case "awaiting-input": normalized = "awaiting-input"
        case "awaiting-save": normalized = "awaiting-save"
        case "completed", "completed-local", "completed-local-fallback": normalized = notificationReady ? "completed":"processing"
        case "failed": normalized = "failed"
        case "cancelled": normalized = "cancelled"
        case "interrupted": normalized = "interrupted"
        case "rejected": normalized = "rejected"
        default: normalized = "unavailable"
        }
        // Message-only receipts may bind a run only through the exact user
        // message already acknowledged. Request/conversation proximity alone
        // cannot claim a different run after follow-up messages are sent.
        if current.runID == nil,let runID,!runID.isEmpty {
            guard let expected=current.userMessageID,!expected.isEmpty,userMessageID==expected else{return}
            current.runID=runID
        }
        let effective=current.runID == nil && normalized != "submitted" ? "unavailable":normalized
        current.status=effective
        current.summary=effective == "unavailable" ? "":summary
        if current != execution {execution=current}
    }
    func openConversation() {
        guard let execution else{return}
        onOpenConversation?(execution.conversationID)
    }
    func invalidate() {
        heldGeneration=nil
        generation+=1;operation?.cancel();operation=nil
        if let lease{dictation.cancel(lease)}
        lease=nil;execution=nil;text="";issue=nil;phase = .idle;onDismiss?()
    }
}
