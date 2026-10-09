import SwiftUI

/// Native counterpart of the settings/preset pattern: the retained recording
/// owner owns this draft. HTTP speech is shared by recording/composer/quick voice;
/// recording-time WebSocket transcription remains a separate service.
struct NativeSpeechSettingsView: View {
    @ObservedObject var store: NativeQuickRecordingStore
    @ObservedObject var settings: NativeSpeechSettings
    let onClose: () -> Void
    private enum DraftAction:Equatable {case choose(String),new,close}
    @State private var removing=false
    @State private var baseline:NativeSpeechSettingsDraft?
    @State private var pending:DraftAction?
    private var draft:NativeSpeechSettingsDraft {store.speechSettingsDraft ?? .init(configuration:settings.configuration,key:"")}
    private var savedScheme:NativeSpeechScheme? {settings.schemes.first{$0.id==draft.schemeID}}
    private var dirty:Bool {baseline.map{$0 != draft} ?? false}
    private var canKeepKey:Bool {settings.canRetainKey(schemeID:draft.schemeID,configuration:draft.configuration)}
    private var canSubmit:Bool {draft.configuration.valid && NativeSpeechScheme.validName(draft.name) &&
        (canKeepKey || NativeSpeechService.validKey(draft.key.trimmingCharacters(in:.whitespacesAndNewlines)))}
    private func change(_ update:(inout NativeSpeechSettingsDraft)->Void) {
        var next=draft;update(&next);settings.clearTestResult();store.updateSpeechSettings(next)
    }
    private func field<T>(_ path:WritableKeyPath<NativeSpeechConfiguration,T>)->Binding<T> {
        Binding(get:{draft.configuration[keyPath:path]},set:{value in change{$0.configuration[keyPath:path]=value}})
    }
    private func request(_ action:DraftAction) {
        settings.clearTestResult()
        if dirty {pending=action} else {Task{await perform(action)}}
    }
    private func perform(_ action:DraftAction)async {
        switch action {
        case .choose(let id):if await store.selectSpeechScheme(id){baseline=store.speechSettingsDraft}
        case .new:store.newSpeechSchemeDraft();baseline=store.speechSettingsDraft
        case .close:store.cancelSpeechSettings();onClose()
        }
    }
    private func saveThen(_ action:DraftAction)async {
        guard await store.saveSpeechSettings() else{return}
        if action == .close {onClose();return}
        store.beginSpeechSettings();baseline=store.speechSettingsDraft;await perform(action)
    }
    var body:some View {
        VStack(alignment:.leading,spacing:14) {
            Text(nativeUI("语音 API 方案","Speech API schemes")).font(.system(size:17,weight:.semibold))
            Text(nativeUI("录音转写、输入框语音和快捷语音共用当前方案。Key 在本机独立加密保存。","Recordings, composer dictation and quick voice share the active scheme. Keys are encrypted independently on this Mac."))
                .font(.system(size:12)).foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true)
            HStack {
                Picker(nativeUI("方案","Scheme"),selection:Binding(get:{draft.schemeID},set:{request(.choose($0))})) {
                    ForEach(settings.schemes) {scheme in
                        Text(scheme.name+(scheme.id==settings.selectedID ? nativeUI(" · 当前"," · Active"):"" )).tag(scheme.id)
                    }
                    if savedScheme == nil {Text(nativeUI("新方案（未保存）","New scheme (unsaved)")).tag(draft.schemeID)}
                }.accessibilityIdentifier("speech-scheme-picker")
                Button(nativeUI("新建","New")){request(.new)}.accessibilityIdentifier("speech-scheme-new")
            }.disabled(settings.busy)
            Grid(alignment:.leading,horizontalSpacing:14,verticalSpacing:11) {
                GridRow {Text(nativeUI("名称","Name"));TextField(nativeUI("便于区分的方案名称","Scheme name"),text:Binding(get:{draft.name},set:{value in change{$0.name=value}})).textFieldStyle(.roundedBorder).accessibilityIdentifier("speech-scheme-name")}
                GridRow {
                    Text(nativeUI("协议","Protocol"))
                    Picker("",selection:field(\.provider)) {
                        Text(nativeUI("阿里云语音","Alibaba Cloud speech")).tag(NativeSpeechConfiguration.Provider.aliyun)
                        Text(nativeUI("OpenAI 兼容转写","OpenAI-compatible transcription")).tag(NativeSpeechConfiguration.Provider.openAI)
                    }.labelsHidden()
                }
                GridRow {Text(nativeUI("服务地址","Base URL"));TextField("https://…",text:field(\.baseURL)).textFieldStyle(.roundedBorder)}
                GridRow {Text(nativeUI("模型","Model"));TextField("qwen-audio-3.0-asr-flash",text:field(\.model)).textFieldStyle(.roundedBorder)}
                GridRow {Text(nativeUI("语言","Language"));TextField(nativeUI("留空自动识别，如 zh / en","Auto if blank, e.g. zh / en"),text:field(\.language)).textFieldStyle(.roundedBorder)}
                GridRow {
                    Text("API Key")
                    SecureField(canKeepKey ? nativeUI("本方案已保存，留空保留","Saved for this scheme; blank keeps it"):nativeUI("请填写此方案、此地址的 Key","Key for this scheme and endpoint"),text:Binding(get:{draft.key},set:{value in change{$0.key=value}})).textFieldStyle(.roundedBorder)
                }
            }.font(.system(size:12)).disabled(settings.busy)
            Text(nativeUI("测试会向当前表单中的服务发送 1 秒合成静音，可能计费；不开麦、不上传录音。仅验证响应，不保存设置。","Testing sends one second of generated silence to the service in this form and may incur a charge. No microphone or recording is used. It checks the response without saving settings."))
                .font(.system(size:11)).foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true)
            HStack {
                Button(nativeUI("测试连接","Test connection")){let current=draft;Task{_ = await settings.testConnection(schemeID:current.schemeID,configuration:current.configuration,key:current.key,expectedRevision:current.catalogRevision)}}
                    .disabled(settings.busy || !canSubmit).accessibilityIdentifier("speech-test-connection")
                if settings.testing {ProgressView().controlSize(.small);Button(nativeUI("停止测试","Stop test")){settings.clearTestResult()}}
            }
            if let message=settings.testResult {Text(message).font(.system(size:11)).foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true)}
            if let error=settings.error {Text(error).font(.system(size:11)).foregroundStyle(.orange).fixedSize(horizontal:false,vertical:true)}
            HStack(spacing:12) {
                if savedScheme != nil {Button(nativeUI("删除方案","Delete scheme"),role:.destructive){removing=true}.buttonStyle(.plain).disabled(settings.busy)}
                if settings.busy && !settings.testing {ProgressView().controlSize(.small)}
                Spacer(minLength:0)
                Button(nativeUI("取消","Cancel")){request(.close)}.keyboardShortcut(.cancelAction).disabled(settings.busy && !settings.testing)
                Button(nativeUI("保存并使用","Save and use")){Task{if await store.saveSpeechSettings(){onClose()}}}.keyboardShortcut(.defaultAction)
                    .disabled(settings.busy || !canSubmit).accessibilityIdentifier("speech-scheme-save")
            }
        }.padding(22).frame(width:500).disabled(!store.available).interactiveDismissDisabled()
            .onAppear{if baseline==nil{baseline=store.speechSettingsDraft}}
            .onDisappear{settings.clearTestResult()}
            .confirmationDialog(nativeUI("保留尚未保存的更改？","Keep your unsaved changes?"),isPresented:Binding(get:{pending != nil},set:{if !$0{pending=nil}})) {
                if let action=pending {
                    Button(nativeUI("保存后继续","Save and continue")){pending=nil;Task{await saveThen(action)}}.disabled(!canSubmit)
                    Button(nativeUI("放弃更改并继续","Discard changes and continue"),role:.destructive){pending=nil;Task{await perform(action)}}
                }
                Button(nativeUI("继续编辑","Keep editing"),role:.cancel){pending=nil}
            } message:{Text(nativeUI("切换方案不会自动覆盖这份草稿。","Switching schemes will not silently overwrite this draft."))}
            .confirmationDialog(nativeUI("删除此语音方案？","Delete this speech scheme?"),isPresented:$removing) {
                Button(nativeUI("删除","Delete"),role:.destructive){Task{if await store.removeSpeechSettings(){onClose()}}}
                Button(nativeUI("取消","Cancel"),role:.cancel){}
            } message:{Text(nativeUI("若删除当前方案，语音转写将停用，直到明确选择另一方案。录音与文字保留。","Deleting the active scheme disables speech until you explicitly select another. Recordings and transcripts are retained."))}
    }
}
