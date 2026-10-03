import SwiftUI

// Voice content is hosted by the existing island, with the same shell, screen
// geometry, palette and transition. This file creates no AppKit window.
extension NativeVoiceCommandCoordinator {
    var presentationTitle:String {
        if let execution {
            switch execution.status {
            case "completed":return nativeUI("已完成", "Completed")
            case "awaiting-approval":return nativeUI("等待你的确认", "Waiting for approval")
            case "awaiting-input":return nativeUI("需要补充信息", "More information needed")
            case "awaiting-save":return nativeUI("等待保存", "Waiting to save")
            case "failed":return nativeUI("处理未完成", "Could not finish")
            case "cancelled","interrupted","rejected":return nativeUI("已停止", "Stopped")
            case "unavailable":return nativeUI("暂时无法读取进度", "Progress unavailable")
            default:return nativeUI("正在处理", "Working on it")
            }
        }
        switch phase {
        case .starting:return nativeUI("准备麦克风…", "Preparing microphone…")
        case .recording:return nativeUI("正在听你说", "Listening")
        case .recorded:return nativeUI("录音已停止", "Recording stopped")
        case .transcribing:return nativeUI("正在转成文字…", "Transcribing…")
        case .preview:return nativeUI("确认这条指令", "Review your instruction")
        case .submitting:return nativeUI("交给 AI Bro…", "Sending to AI Bro…")
        case .failed:return nativeUI("暂未完成", "Not completed yet")
        case .idle:return nativeUI("说一句，开始一件事", "Say it. Start something.")
        }
    }
    var presentationBusy:Bool {
        if let execution {return ["submitted","processing","running"].contains(execution.status)}
        return [.starting,.transcribing,.submitting].contains(phase)
    }
    var presentationSymbol:String {
        if let execution {
            switch execution.status {
            case "completed":return "checkmark.circle.fill"
            case "awaiting-approval","awaiting-input","awaiting-save":return "clock"
            case "failed","unavailable":return "exclamationmark.circle"
            case "cancelled","interrupted","rejected":return "stop.circle"
            default:return "sparkle"
            }
        }
        return phase == .preview ? "text.bubble" : "mic.fill"
    }
}

struct NativeVoiceCommandView:View {
    @ObservedObject var coordinator:NativeVoiceCommandCoordinator
    @ObservedObject var dictation:NativeSpeechDictation
    @ObservedObject var speechSettings:NativeSpeechSettings
    @ObservedObject var shortcut:NativeSpeechShortcutStore
    let settings:()->Void
    let stop:(String) async -> Bool
    @State private var stopping=false
    @State private var stopIssue:String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var recording:Bool {coordinator.phase == .recording || coordinator.phase == .recorded}
    private var accepted:Bool {coordinator.execution != nil}
    private var footer:String {
        if accepted {return nativeUI("关闭灵动岛不会停止任务", "Closing the island does not stop the task")}
        if coordinator.phase == .preview {return nativeUI("确认后才发送 · Esc 取消", "Send when ready · Esc to cancel")}
        if coordinator.phase == .submitting {return nativeUI("正在提交，关闭不会撤回指令", "Submitting; closing does not retract it")}
        return shortcut.shortcut.label + (shortcut.mode == .hold
            ? nativeUI(" 按住说话 · 松开结束 · Esc 取消", " Hold to speak · Release to finish · Esc cancel")
            : nativeUI(" 按一下开始/结束 · Esc 取消", " Press to start/finish · Esc cancel"))
    }
    var body:some View {
        VStack(alignment:.leading,spacing:12) {
            HStack(spacing:12) {
                ZStack {
                    Circle().fill(Color.accentColor.opacity(0.12)).frame(width:38,height:38)
                    if coordinator.presentationBusy {ProgressView().controlSize(.small)}
                    else {
                        Image(systemName:coordinator.presentationSymbol).font(.system(size:19,weight:.medium))
                            .foregroundStyle(Color.accentColor)
                            .symbolEffect(.bounce,options:.nonRepeating,value:!reduceMotion && coordinator.execution?.status == "completed")
                    }
                }.accessibilityHidden(true)
                VStack(alignment:.leading,spacing:4) {
                    Text(coordinator.presentationTitle).font(.system(size:16,weight:.semibold))
                    if recording {
                        HStack(spacing:10) {
                            Text(String(format:"%02d:%02d",Int(dictation.elapsed)/60,Int(dictation.elapsed)%60)).monospacedDigit()
                            if coordinator.phase == .recording {
                                ProgressView(value:dictation.level).progressViewStyle(.linear).frame(width:110)
                                    .accessibilityLabel(nativeUI("麦克风音量", "Microphone level"))
                            }
                        }.font(.system(size:11)).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength:0)
                if !accepted && [.idle,.failed,.preview].contains(coordinator.phase) {
                    Button(action:settings){Image(systemName:"slider.horizontal.3")}.buttonStyle(.plain)
                        .accessibilityLabel(nativeUI("语音服务设置", "Speech service settings"))
                }
            }
            ScrollView(.vertical) {
                VStack(alignment:.leading,spacing:10) {
                    if let issue=coordinator.issue ?? stopIssue {
                        Label(issue,systemImage:"exclamationmark.circle").font(.system(size:11))
                            .foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true).textSelection(.enabled)
                    }
                    if !coordinator.text.isEmpty {
                        Text(coordinator.text).font(.system(size:13)).foregroundStyle(.primary)
                            .fixedSize(horizontal:false,vertical:true).textSelection(.enabled)
                            .accessibilityLabel(nativeUI("识别的指令", "Recognized instruction"))
                            .accessibilityValue(coordinator.text)
                    }else if coordinator.issue == nil {
                        Text(nativeUI("例如：明天下午三点打篮球，帮我记一下。", "For example: Remind me to play basketball tomorrow at 3 pm."))
                            .font(.system(size:12)).foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true)
                    }
                    if let result=coordinator.execution?.summary,!result.isEmpty {
                        Divider().opacity(0.4)
                        Text(nativeUI("处理结果", "Result")).font(.system(size:10,weight:.medium)).foregroundStyle(.secondary)
                        Text(result).font(.system(size:12)).fixedSize(horizontal:false,vertical:true).textSelection(.enabled)
                    }
                }.frame(maxWidth:.infinity,alignment:.topLeading)
            }.frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.topLeading)
            HStack(spacing:8) {
                if accepted {
                    if coordinator.presentationBusy {
                        Button(stopping ? nativeUI("正在停止…", "Stopping…"):nativeUI("停止任务", "Stop task")) {
                            guard !stopping,let id=coordinator.execution?.runID else{return};stopping=true;stopIssue=nil
                            Task {
                                let success=await stop(id)
                                guard coordinator.execution?.runID==id else{return}
                                guard coordinator.presentationBusy else{stopping=false;stopIssue=nil;return}
                                if !success {
                                    stopping=false
                                    stopIssue=nativeUI("暂未停止，请打开对话查看。", "Could not stop. Open the chat to check.")
                                }
                            }
                        }.disabled(stopping || coordinator.execution?.runID == nil)
                    }
                    Spacer(minLength:0)
                    Button(nativeUI("打开对话", "Open chat")){coordinator.openConversation()}.buttonStyle(.borderedProminent)
                }else {
                    Button(coordinator.phase == .submitting ? nativeUI("收起", "Hide"):nativeUI("取消", "Cancel")){coordinator.cancel()}.buttonStyle(.bordered)
                    Spacer(minLength:0)
                    if coordinator.phase == .preview {
                        Button(nativeUI("发送", "Send")){coordinator.sendPreview()}.buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
                    }else if recording {
                        Button(nativeUI("结束录音", "Finish recording")){coordinator.finish()}.buttonStyle(.borderedProminent)
                    }else if coordinator.retryAvailable {
                        Button(nativeUI("重试", "Retry")){coordinator.retry()}.buttonStyle(.borderedProminent)
                    }else if !coordinator.presentationBusy {
                        Button(nativeUI("开始说话", "Start speaking")){coordinator.start()}.buttonStyle(.borderedProminent)
                            .disabled(!speechSettings.configured || speechSettings.busy)
                    }
                }
            }.controlSize(.regular)
            Text(footer).font(.system(size:10)).foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true)
        }.frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.topLeading)
            .animation(reduceMotion ? nil:.easeOut(duration:0.16),value:coordinator.phase)
            .animation(reduceMotion ? nil:.easeOut(duration:0.16),value:coordinator.execution?.status)
            .onChange(of:coordinator.execution?.requestID){_,_ in stopping=false;stopIssue=nil}
            .onChange(of:coordinator.execution?.status){_,_ in
                if !coordinator.presentationBusy {stopping=false;stopIssue=nil}
            }
    }
}
