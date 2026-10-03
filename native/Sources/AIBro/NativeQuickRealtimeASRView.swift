import SwiftUI

struct NativeQuickRealtimeASRSettingsView: View {
    @ObservedObject var store: NativeQuickRecordingStore
    @ObservedObject var settings: NativeQuickASRSettings
    let onClose: () -> Void
    @State private var deleting = false
    private var draft: NativeQuickASRSettingsDraft { store.realtimeSettingsDraft ?? .init(configuration:settings.configuration,key:"") }
    private func field<T>(_ key: WritableKeyPath<NativeQuickASRConfiguration,T>) -> Binding<T> {
        Binding(get:{draft.configuration[keyPath:key]},set:{value in var next=draft;next.configuration[keyPath:key]=value;store.updateRealtimeSettings(next)})
    }
    var body: some View {
        VStack(alignment:.leading,spacing:16) {
            Text(nativeUI("实时转写", "Realtime transcription")).font(.system(size:17,weight:.semibold))
            Text(nativeUI("开启后，录音时的音频会发送到你配置的通义百炼服务；完整录音仍保存在这台 Mac。", "When enabled, audio recorded here is sent to your configured Alibaba Cloud Model Studio service. The full recording stays on this Mac."))
                .font(.system(size:12)).foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true)
            Toggle(nativeUI("录音时实时转写", "Transcribe while recording"),isOn:field(\.enabled)).toggleStyle(.switch)
            Grid(alignment:.leading,horizontalSpacing:16,verticalSpacing:12) {
                GridRow {
                    Text(nativeUI("地区", "Region"))
                    Picker("",selection:field(\.region)) {
                        Text(nativeUI("中国 · 北京", "China · Beijing")).tag(NativeQuickASRConfiguration.Region.beijing)
                        Text(nativeUI("新加坡", "Singapore")).tag(NativeQuickASRConfiguration.Region.singapore)
                    }.labelsHidden()
                }
                GridRow {
                    Text(nativeUI("工作空间", "Workspace"))
                    TextField(nativeUI("可选 Workspace ID", "Optional Workspace ID"),text:field(\.workspaceID)).textFieldStyle(.roundedBorder)
                }
                GridRow {
                    Text(nativeUI("语言", "Language"))
                    Picker("",selection:field(\.language)) {
                        Text(nativeUI("自动识别", "Auto detect")).tag("")
                        Text(nativeUI("中文", "Chinese")).tag("zh")
                        Text(nativeUI("英文", "English")).tag("en")
                        Text(nativeUI("粤语", "Cantonese")).tag("yue")
                        Text(nativeUI("日语", "Japanese")).tag("ja")
                        Text(nativeUI("韩语", "Korean")).tag("ko")
                        Text(nativeUI("德语", "German")).tag("de")
                        Text(nativeUI("法语", "French")).tag("fr")
                        Text(nativeUI("西班牙语", "Spanish")).tag("es")
                    }.labelsHidden()
                }
                GridRow {
                    Text("API Key")
                    SecureField(settings.configured ? nativeUI("已保存，留空保留", "Saved; leave blank to keep") : nativeUI("百炼独立 Key", "Model Studio Key"),text:Binding(get:{draft.key},set:{value in var next=draft;next.key=value;store.updateRealtimeSettings(next)})).textFieldStyle(.roundedBorder)
                }
            }.font(.system(size:12))
            Text(nativeUI("qwen3-asr-flash-realtime · Key 仅本机加密保存，连接时验证。聊天 Key 不会用于转写。", "qwen3-asr-flash-realtime · Key is encrypted locally and checked when connecting. Chat credentials are not used."))
                .font(.system(size:11)).foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true)
            if let error=settings.error {Text(error).font(.system(size:11)).foregroundStyle(.orange).fixedSize(horizontal:false,vertical:true)}
            HStack {
                if settings.configured {Button(nativeUI("删除配置", "Remove settings"),role:.destructive){deleting=true}.buttonStyle(.plain)}
                Spacer()
                Button(nativeUI("取消", "Cancel")){store.cancelRealtimeSettings();onClose()}.keyboardShortcut(.cancelAction)
                Button(nativeUI("保存", "Save")){if store.saveRealtimeSettings(){onClose()}}.keyboardShortcut(.defaultAction)
                    .disabled(!draft.configuration.valid || (!settings.configured && draft.key.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty))
            }
        }.padding(22).frame(width:420).disabled(!store.available)
            .interactiveDismissDisabled()
            .confirmationDialog(nativeUI("删除实时转写配置？", "Remove realtime transcription settings?"),isPresented:$deleting) {
                Button(nativeUI("删除", "Remove"),role:.destructive){if store.removeRealtimeSettings(){onClose()}}
                Button(nativeUI("取消", "Cancel"),role:.cancel){}
            } message:{Text(nativeUI("不会删除录音或转写文字。", "Recordings and transcripts are retained."))}
    }
}
