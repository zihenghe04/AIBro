import SwiftUI

/// Shared HTTP speech configuration for recorded files and explicit dictation.
/// Recording-time WebSocket settings and their credentials remain separate.
struct NativeSpeechSettingsView: View {
    @ObservedObject var store: NativeQuickRecordingStore
    @ObservedObject var settings: NativeSpeechSettings
    let onClose: () -> Void
    @State private var removing = false
    private var draft: NativeSpeechSettingsDraft {store.speechSettingsDraft ?? .init(configuration:settings.configuration,key:"")}
    private func field<T>(_ path:WritableKeyPath<NativeSpeechConfiguration,T>) -> Binding<T> {
        Binding(get:{draft.configuration[keyPath:path]},set:{value in var next=draft;next.configuration[keyPath:path]=value;store.updateSpeechSettings(next)})
    }
    var body: some View {
        VStack(alignment:.leading,spacing:14) {
            Text(nativeUI("云转写设置", "Cloud transcription settings")).font(.system(size:17,weight:.semibold))
            Text(nativeUI("用于录音转写、输入框语音和快捷语音。点击云端转写，或停止语音并转写时才上传音频；保存设置不会上传。", "Used for recordings, composer dictation and quick voice. Audio uploads only when you request cloud transcription or stop and transcribe dictation; saving settings uploads nothing."))
                .font(.system(size:12)).foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true)
            Grid(alignment:.leading,horizontalSpacing:14,verticalSpacing:11) {
                GridRow {
                    Text(nativeUI("协议", "Protocol"))
                    Picker("",selection:field(\.provider)) {
                        Text(nativeUI("阿里云语音", "Alibaba Cloud speech")).tag(NativeSpeechConfiguration.Provider.aliyun)
                        Text(nativeUI("OpenAI 兼容转写", "OpenAI-compatible transcription")).tag(NativeSpeechConfiguration.Provider.openAI)
                    }.labelsHidden()
                }
                GridRow {Text(nativeUI("服务地址", "Base URL"));TextField("https://…",text:field(\.baseURL)).textFieldStyle(.roundedBorder)}
                GridRow {Text(nativeUI("模型", "Model"));TextField("qwen-audio-3.0-asr-flash",text:field(\.model)).textFieldStyle(.roundedBorder)}
                GridRow {Text(nativeUI("语言", "Language"));TextField(nativeUI("留空自动识别，如 zh / en", "Auto if blank, e.g. zh / en"),text:field(\.language)).textFieldStyle(.roundedBorder)}
                GridRow {
                    Text("API Key")
                    SecureField(settings.configured ? nativeUI("已保存，留空保留", "Saved; leave blank to keep"):nativeUI("此服务的独立 Key", "Independent service Key"),text:Binding(get:{draft.key},set:{value in var next=draft;next.key=value;store.updateSpeechSettings(next)})).textFieldStyle(.roundedBorder)
                }
            }.font(.system(size:12)).disabled(settings.busy)
            Text(nativeUI("Key 仅在本机加密保存，不使用聊天或实时转写的 Key。阿里云协议单次最多 5 分钟、编码后 10 MB；超限会提示，不截取音频。", "The Key is encrypted on this Mac, separate from chat and realtime transcription. Alibaba Cloud accepts up to 5 minutes and 10 MB encoded audio; oversized audio is rejected, never truncated."))
                .font(.system(size:11)).foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true)
            if let error=settings.error {Text(error).font(.system(size:11)).foregroundStyle(.orange).fixedSize(horizontal:false,vertical:true)}
            HStack(spacing:12) {
                if settings.configured {Button(nativeUI("删除配置", "Remove settings"),role:.destructive){removing=true}.buttonStyle(.plain).disabled(settings.busy)}
                if settings.busy {ProgressView().controlSize(.small)}
                Spacer(minLength:0)
                Button(nativeUI("取消", "Cancel")){store.cancelSpeechSettings();onClose()}.keyboardShortcut(.cancelAction).disabled(settings.busy)
                Button(nativeUI("保存", "Save")){Task{if await store.saveSpeechSettings(){onClose()}}}.keyboardShortcut(.defaultAction)
                    .disabled(settings.busy || !draft.configuration.valid || (!settings.configured && draft.key.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty))
            }
        }.padding(22).frame(width:440).disabled(!store.available)
            .interactiveDismissDisabled()
            .confirmationDialog(nativeUI("删除云转写配置？", "Remove cloud transcription settings?"),isPresented:$removing) {
                Button(nativeUI("删除", "Remove"),role:.destructive){Task{if await store.removeSpeechSettings(){onClose()}}}
                Button(nativeUI("取消", "Cancel"),role:.cancel){}
            } message:{Text(nativeUI("录音、已保存文字和实时转写设置不变。", "Recordings, saved text and realtime settings are retained."))}
    }
}
