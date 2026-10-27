import SwiftUI

struct NativeQuickRealtimeASRSettingsView: View {
    @ObservedObject var store: NativeQuickRecordingStore
    @ObservedObject var settings: NativeQuickASRSettings
    let onClose: () -> Void
    // Same key as NativeDictationPreferences.silenceKey; read by voice input to stop on its own after the speaker goes quiet.
    @AppStorage("aibro.dictation.silenceSeconds") private var silence = 1.5
    @State private var deleting = false
    @State private var closing = false
    @State private var drafts: [String: NativeQuickASRSettingsDraft] = [:]
    private var saved: NativeQuickASRProfile? { settings.profiles.first { $0.id == draft.profileID } }
    private var dirty: Bool { !draft.key.isEmpty || saved?.name != draft.name || saved?.configuration != draft.configuration }
    private func update(_ value: NativeQuickASRSettingsDraft) { settings.cancelTest(); store.updateRealtimeSettings(value) }
    private func saveCurrent() {
        let id = draft.profileID
        if settings.save(draft) { drafts.removeValue(forKey:id); update(settings.draft(for:id)) }
    }
    private func edit(_ id: String) {
        drafts[draft.profileID] = draft
        update(drafts[id] ?? settings.draft(for: id))
    }
    private func newProfile() {
        drafts[draft.profileID] = draft
        let value = NativeQuickASRSettingsDraft(profileID: UUID().uuidString, name: nativeUI("新方案", "New scheme"), catalogRevision: settings.revision, configuration: .init(), key: "")
        update(value)
    }
    private var draft: NativeQuickASRSettingsDraft { store.realtimeSettingsDraft ?? .init(configuration:settings.configuration,key:"") }
    private func field<T>(_ key: WritableKeyPath<NativeQuickASRConfiguration,T>) -> Binding<T> {
        Binding(get:{draft.configuration[keyPath:key]},set:{value in var next=draft;next.configuration[keyPath:key]=value;update(next)})
    }
    var body: some View {
        VStack(alignment:.leading,spacing:16) {
            Text(nativeUI("实时转写", "Realtime transcription")).font(.system(size:17,weight:.semibold))
            Text(nativeUI("开启后，录音时的音频会发送到你配置的实时转写服务（通义百炼、ElevenLabs 或你自部署的服务）；完整录音仍保存在这台 Mac。", "When enabled, audio recorded here is sent to your configured realtime service (Alibaba Model Studio, ElevenLabs or your own server). The full recording stays on this Mac."))
                .font(.system(size:12)).foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true)
            HStack(spacing:10) {
                Picker(nativeUI("方案", "Scheme"), selection: Binding(get:{draft.profileID},set:edit)) {
                    ForEach(settings.profiles) { item in Text(item.name + (item.id == settings.activeProfileID ? nativeUI(" · 使用中", " · Active") : "")).tag(item.id) }
                    ForEach(drafts.values.filter { row in row.profileID != draft.profileID && !settings.profiles.contains { $0.id == row.profileID } }.sorted { $0.profileID < $1.profileID },id:\.profileID) { row in Text(row.name + nativeUI(" · 未保存", " · Unsaved")).tag(row.profileID) }
                    if saved == nil { Text(draft.name + nativeUI(" · 未保存", " · Unsaved")).tag(draft.profileID) }
                }.frame(maxWidth:.infinity)
                Button(action:newProfile) { Image(systemName:"plus") }.help(nativeUI("新建独立方案", "New independent scheme"))
            }.disabled(settings.testing)
            TextField(nativeUI("方案名称", "Scheme name"),text:Binding(get:{draft.name},set:{value in var next=draft;next.name=value;update(next)}))
                .textFieldStyle(.roundedBorder)
            Toggle(nativeUI("录音与语音输入时实时转写", "Transcribe live while recording and dictating"),isOn:field(\.enabled)).toggleStyle(.switch)
            Grid(alignment:.leading,horizontalSpacing:16,verticalSpacing:12) {
                GridRow {
                    Text(nativeUI("服务", "Service"))
                    Picker("",selection:field(\.provider)) {
                        Text(nativeUI("通义百炼", "Alibaba Model Studio")).tag(NativeQuickASRConfiguration.Provider.bailian)
                        Text("ElevenLabs Scribe").tag(NativeQuickASRConfiguration.Provider.elevenLabs)
                        Text(nativeUI("自部署（OpenAI 兼容服务流）", "Self-hosted (OpenAI-compatible stream)")).tag(NativeQuickASRConfiguration.Provider.selfHosted)
                    }.labelsHidden()
                }
                if draft.configuration.provider == .selfHosted {
                GridRow {
                    Text(nativeUI("服务地址", "Server URL"))
                    TextField("ws://<server>:8000", text: field(\.serverURL)).textFieldStyle(.roundedBorder)
                }
                }
                if draft.configuration.provider == .bailian {
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
                }
                if draft.configuration.provider == .selfHosted {
                GridRow {
                    Text(nativeUI("语言", "Language"))
                    Picker("",selection:field(\.language)) {
                        Text(nativeUI("自动识别", "Auto detect")).tag("")
                        Text(nativeUI("中文", "Chinese")).tag("zh")
                        Text(nativeUI("英文", "English")).tag("en")
                    }.labelsHidden()
                }
                } else {
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
                }
                GridRow {
                    Text(nativeUI("说完自动结束", "Stop when silent"))
                    Picker("",selection:$silence) {
                        Text(nativeUI("关闭", "Off")).tag(0.0)
                        Text(nativeUI("1 秒", "1 s")).tag(1.0)
                        Text(nativeUI("1.5 秒", "1.5 s")).tag(1.5)
                        Text(nativeUI("2 秒", "2 s")).tag(2.0)
                        Text(nativeUI("3 秒", "3 s")).tag(3.0)
                    }.labelsHidden()
                }
                GridRow {
                    Text("API Key")
                    SecureField(saved?.configuration.origin == draft.configuration.origin ? nativeUI("已保存，留空保留", "Saved; leave blank to keep") : nativeUI("此服务的独立 Key", "Independent Key for this service"),text:Binding(get:{draft.key},set:{value in var next=draft;next.key=value;update(next)})).textFieldStyle(.roundedBorder)
                }
            }.font(.system(size:12))
            Text(draft.configuration.modelName + nativeUI(" · Key 仅本机加密保存，连接时验证。聊天 Key 不会用于转写。", " · Key is encrypted locally and checked when connecting. Chat credentials are not used."))
                .font(.system(size:11)).foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true)
            HStack(spacing:10) {
                Button(settings.testing ? nativeUI("取消测试", "Cancel test") : nativeUI("测试连接", "Test connection")) {
                    if settings.testing { settings.cancelTest() } else { settings.testConnection(draft) }
                }.disabled(!draft.configuration.valid)
                if settings.testing { ProgressView().controlSize(.small) }
                if let message = settings.testMessage { Text(message).font(.system(size:11)).foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true) }
            }
            if let error=settings.error {Text(error).font(.system(size:11)).foregroundStyle(.orange).fixedSize(horizontal:false,vertical:true)}
            HStack {
                if saved != nil {Button(nativeUI("删除方案", "Delete scheme"),role:.destructive){deleting=true}.buttonStyle(.plain)}
                Spacer()
                Button(nativeUI("关闭", "Close")){if dirty || drafts.values.contains(where: { row in !row.key.isEmpty || settings.profiles.first(where: { $0.id == row.profileID })?.configuration != row.configuration || settings.profiles.first(where: { $0.id == row.profileID })?.name != row.name }) { closing=true } else {store.cancelRealtimeSettings();onClose()}}.keyboardShortcut(.cancelAction)
                Button(nativeUI("保存并使用", "Save and use")){saveCurrent()}.keyboardShortcut(.defaultAction)
                    .disabled(settings.testing || !draft.configuration.valid || draft.name.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty || (saved == nil && draft.key.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty))
            }
        }.padding(24).frame(width:480).disabled(!store.available)
            .interactiveDismissDisabled()
            .confirmationDialog(nativeUI("保留当前修改？", "Keep current changes?"), isPresented:$closing) {
                Button(nativeUI("保存当前并继续编辑", "Save current and keep editing")) { saveCurrent() }
                Button(nativeUI("放弃全部未保存修改", "Discard all unsaved changes"),role:.destructive){store.cancelRealtimeSettings();onClose()}
                Button(nativeUI("继续编辑", "Keep editing"),role:.cancel){}
            }
            .confirmationDialog(nativeUI("删除此实时转写方案？", "Delete this realtime scheme?"),isPresented:$deleting) {
                Button(nativeUI("删除", "Remove"),role:.destructive){if settings.removeProfile(draft.profileID){update(settings.draft())}}
                Button(nativeUI("取消", "Cancel"),role:.cancel){}
            } message:{Text(nativeUI("不会删除录音或转写文字。", "Recordings and transcripts are retained."))}
    }
}
