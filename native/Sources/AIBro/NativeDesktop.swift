import Foundation
import AppKit
import WebKit
import Combine

@MainActor final class NativeDesktop:NSObject,WKScriptMessageHandlerWithReply {
    weak var workspace:Workspace? { didSet { observeConnectionPage() } }
    private let connectionGate=NativeConnectionAccess.Gate()
    private var connectionPageObservers:[NSKeyValueObservation]=[]
    private var connectionReadyObserver:AnyCancellable?
    private let connectionSession:NativeConnectionSession
    var openQuickPanel:((NativeQuickPanelOpenRequest,@escaping () async -> Bool) async -> NativeQuickPanelOpenResult)?
    var speechDictation:NativeSpeechDictation?
    var openSpeechSettings:(() async -> Bool)?
    enum QuickEntrySettingsRequest { case state, enabled(Bool), mode(String), open }
    var quickEntrySettings:((QuickEntrySettingsRequest)->[String:Any])?
    /// Settings → Models → Speech: public state of the native transcription schemes plus a few actions. Keys never cross this bridge.
    /// A cloud scheme typed in Settings. `key` is write-only: it goes straight into the encrypted native store and is never read back to the web.
    struct SpeechCloudInput { var id:String?; var name:String; var configuration:NativeSpeechConfiguration; var key:String }
    struct SpeechRealtimeInput { var id:String?; var name:String; var configuration:NativeQuickASRConfiguration; var key:String; var reuseCloudID:String? }
    enum SpeechSettingsRequest {
        case state, select(String), realtime(Bool), test(String), open(String,String?)
        case saveCloud(SpeechCloudInput), deleteCloud(String), testCloud(SpeechCloudInput)
        case saveRealtime(SpeechRealtimeInput), deleteRealtime(String), selectRealtime(String), testRealtime(SpeechRealtimeInput)
        case silence(Double)
    }
    static func speechCloudInput(_ raw:Any?)->SpeechCloudInput? {
        guard let d=raw as? [String:Any],Set(d.keys).isSubset(of:["id","name","provider","baseURL","model","language","timeoutSeconds","key"]),
              let name=d["name"] as? String,name.utf8.count<=160,let provider=(d["provider"] as? String).flatMap(NativeSpeechConfiguration.Provider.init(rawValue:)),
              let base=d["baseURL"] as? String,base.utf8.count<=2048,let model=d["model"] as? String,model.utf8.count<=160,
              let language=d["language"] as? String,language.utf8.count<=16 else{return nil}
        var config=NativeSpeechConfiguration();config.provider=provider;config.baseURL=base;config.model=model;config.language=language
        if let timeout=d["timeoutSeconds"] {guard let n=timeout as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID(),n.doubleValue.isFinite else{return nil};config.timeoutSeconds=Int(min(max(n.doubleValue,0),1800));if config.timeoutSeconds==0{config.timeoutSeconds=nil}}
        let key=d["key"] as? String ?? "";guard key.utf8.count<=16384,(d["key"] == nil || d["key"] is String) else{return nil}
        var id:String?;if let value=d["id"] {guard let s=value as? String,!s.isEmpty,s.utf8.count<=200 else{return nil};id=s}
        return .init(id:id,name:name,configuration:config,key:key)
    }
    static func speechRealtimeInput(_ raw:Any?)->SpeechRealtimeInput? {
        guard let d=raw as? [String:Any],Set(d.keys).isSubset(of:["id","name","provider","region","workspaceID","serverURL","language","enabled","key","reuseCloudID"]),
              let name=d["name"] as? String,name.utf8.count<=160,let provider=(d["provider"] as? String).flatMap(NativeQuickASRConfiguration.Provider.init(rawValue:)),
              let language=d["language"] as? String,language.utf8.count<=16,let enabled=d["enabled"] as? NSNumber,CFGetTypeID(enabled)==CFBooleanGetTypeID() else{return nil}
        var config=NativeQuickASRConfiguration();config.provider=provider;config.language=language;config.enabled=enabled.boolValue
        if let region=d["region"] {guard let s=region as? String,let r=NativeQuickASRConfiguration.Region(rawValue:s) else{return nil};config.region=r}
        if let ws=d["workspaceID"] {guard let s=ws as? String,s.utf8.count<=128 else{return nil};config.workspaceID=s}
        if let url=d["serverURL"] {guard let s=url as? String,s.utf8.count<=2048 else{return nil};config.serverURL=s}
        guard d["key"] == nil || d["key"] is String,(d["key"] as? String ?? "").utf8.count<=16384 else{return nil}
        var id:String?;if let value=d["id"] {guard let s=value as? String,!s.isEmpty,s.utf8.count<=200 else{return nil};id=s}
        var reuse:String?;if let value=d["reuseCloudID"] {guard let s=value as? String,!s.isEmpty,s.utf8.count<=200 else{return nil};reuse=s}
        return .init(id:id,name:name,configuration:config,key:d["key"] as? String ?? "",reuseCloudID:reuse)
    }
    var speechSettings:((SpeechSettingsRequest)->[String:Any])?
    private let credentialQueue=DispatchQueue(label:"app.aibro.credentials")
    private let vectorQueue=DispatchQueue(label:"app.aibro.vector-index",qos:.utility)
    let vectors:NativeVectorStore
    let credentials:NativeCredentials
    var speechCredentials:NativeCredentials?
    let prefsFile:URL
    var preferences:[String:String]
    static let preferenceKeys=Set(["workstation-api-base","workstation-api-model","workstation-api-protocol","workstation-api-protocol-learned","workstation-openai-model","workstation-provider","aibro-embedding-settings-v1","ai-bro-language","workstation-ui"])
    init(data:URL,production:Bool) {
        connectionSession=NativeConnectionSession(dataDirectory:data)
        vectors=NativeVectorStore(folder:data)
        prefsFile=data.appendingPathComponent("native-preferences.json")
        preferences=(try? Data(contentsOf:prefsFile)).flatMap{try? JSONDecoder().decode([String:String].self,from:$0)} ?? [:]
        let old=production ? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/ai-workstation-studio"):nil
        credentials=NativeCredentials(folder:data.appendingPathComponent("native-credentials"),legacy:old,service:production ? "app.ai-workstation.studio.native-credentials":"app.aibro.preview-credentials")
        super.init()
        NativeL10n.shared.setLanguage(preferences["ai-bro-language"] ?? "zh-CN")
    }
    private func observeConnectionPage() {
        connectionGate.invalidate();connectionPageObservers=[];connectionReadyObserver=nil
        guard let workspace else{return}
        let gate=connectionGate
        connectionPageObservers=[workspace.web.observe(\.url,options:[.new]){_,_ in gate.invalidate()},
            workspace.web.observe(\.isLoading,options:[.new]){web,_ in if web.isLoading{gate.invalidate()}}]
        connectionReadyObserver=workspace.$ready.sink{ready in if !ready{gate.invalidate()}}
    }
    func install(_ config:WKWebViewConfiguration,root:URL) {
        config.userContentController.addScriptMessageHandler(self,contentWorld:.page,name:"desktop")
        let json=String(decoding:(try? JSONSerialization.data(withJSONObject:preferences)) ?? Data("{}".utf8),as:UTF8.self)
        let script="window.__nativePreferences="+json+";"+((try? String(contentsOf:root.appendingPathComponent("native/Resources/desktop.js"),encoding:.utf8)) ?? "")
        config.userContentController.addUserScript(WKUserScript(source:script,injectionTime:.atDocumentStart,forMainFrameOnly:true))
    }
    func userContentController(_ userContentController:WKUserContentController,didReceive message:WKScriptMessage,replyHandler:@escaping(Any?,String?)->Void) {
        guard let origin=workspace?.origin, message.frameInfo.isMainFrame,let url=message.frameInfo.request.url,url.scheme=="http",url.host==origin.host,url.port==origin.port,let body=message.body as? [String:Any],let command=body["command"] as? String else{replyHandler(nil,"拒绝非工作区请求");return}
        do {
            if command == "connection-following" {
                guard Set(body.keys) == Set(["command","value"]),let workspace,workspace.ready,
                      message.webView === workspace.web,!workspace.web.isLoading,workspace.origin == origin else {throw NativeConnectionSession.changed()}
                var next=preferences
                if body["value"] is NSNull {next.removeValue(forKey:"aibro-connection-export-v1")}
                else {
                    guard let value=body["value"] as? [String:Any] else {throw NativeConnectionSession.invalid()}
                    try NativeConnectionSession.fields(value,["serverOrigin","accountId"],optional:["apiFormat","speech"])
                    guard let server=value["serverOrigin"] as? String,try NativeConnectionSession.url(server,originOnly:true)==server,
                          NativeConnectionSession.isID(value["accountId"]) else {throw NativeConnectionSession.invalid()}
                    if let format=value["apiFormat"] {guard let format=format as? String,["chat-completions","responses"].contains(format) else {throw NativeConnectionSession.invalid()}}
                    if let speech=value["speech"] {guard let speech=speech as? NSNumber,CFGetTypeID(speech)==CFBooleanGetTypeID(),speech.boolValue else {throw NativeConnectionSession.invalid()}}
                    guard value["apiFormat"] != nil || value["speech"] != nil else {throw NativeConnectionSession.invalid()}
                    next["aibro-connection-export-v1"]=String(decoding:try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]),as:UTF8.self)
                }
                try JSONEncoder().encode(next).write(to:prefsFile,options:.atomic)
                try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:prefsFile.path)
                preferences=next;replyHandler(["saved":true],nil);return
            }
            if command == "connections" {
                guard Set(body.keys) == Set(["command","action","options"]),let action=body["action"] as? String,
                      ["sessionSnapshot","read","compareAndSwap","exportSavedAPI","verifySavedAPI","exportSavedSpeech","verifySavedSpeech"].contains(action),
                      let options=body["options"] as? [String:Any],let workspace,workspace.ready,
                      message.webView === workspace.web,!workspace.web.isLoading,workspace.origin == origin,
                      let currentURL=workspace.web.url,currentURL.scheme==origin.scheme,currentURL.host==origin.host,currentURL.port==origin.port,
                      workspace.dataDirectory.standardizedFileURL == credentials.folder.deletingLastPathComponent().standardizedFileURL else {
                    replyHandler(nil,"[CONNECTION_SESSION_CHANGED] 当前工作区尚未就绪。");return
                }
                // The trusted workspace already reads this same saved API for
                // model calls. Keep background export available after the user
                // opts into following saved settings; identity/page leases and
                // connection-session fences still guard the whole operation.
                let store=credentials,speechStore=speechCredentials,session=connectionSession,access=connectionGate.capture(),web=workspace.web
                credentialQueue.async {
                    let result=Result<[String:Any],Error>{
                        if action == "exportSavedAPI" || action == "verifySavedAPI" {return try store.exportSavedAPI(options,verify:action == "verifySavedAPI",access:access)}
                        if action == "exportSavedSpeech" || action == "verifySavedSpeech" {
                            guard let speechStore else {throw AgendaError.message("[CONNECTION_SOURCE_UNAVAILABLE] 请先保存独立语音配置。")}
                            return try speechStore.exportSavedSpeech(options,verify:action == "verifySavedSpeech",access:access)
                        }
                        return try store.connectionCall(action,options,session:session,access:access)
                    }
                    DispatchQueue.main.async { [weak self,weak workspace,weak web] in
                        guard let self,let workspace,let web,self.workspace === workspace,workspace.web === web,workspace.ready,
                              !web.isLoading,workspace.origin == origin,let current=web.url,
                              current.scheme==origin.scheme,current.host==origin.host,current.port==origin.port else {
                            replyHandler(nil,"[CONNECTION_SESSION_CHANGED] 工作区已变化，未返回连接配置。");return
                        }
                        do {
                            let value=try result.get()
                            try NativeConnectionAccess.perform(access){replyHandler(value,nil)}
                        }catch{replyHandler(nil,error.localizedDescription)}
                    }
                };return
            }
            if command == "speech-settings" {
                guard let workspace, message.webView === workspace.web,
                      let action = body["action"] as? String else { replyHandler(["status":"error","reason":"invalid_request"],nil);return }
                let request:SpeechSettingsRequest
                switch action {
                case "state" where Set(body.keys) == Set(["command","action"]): request = .state
                case "select" where Set(body.keys) == Set(["command","action","id"]):
                    guard let id = body["id"] as? String, !id.isEmpty, id.utf8.count <= 200 else {replyHandler(["status":"error","reason":"invalid_request"],nil);return}
                    request = .select(id)
                case "realtime" where Set(body.keys) == Set(["command","action","enabled"]):
                    guard let value = body["enabled"] as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else {replyHandler(["status":"error","reason":"invalid_request"],nil);return}
                    request = .realtime(value.boolValue)
                case "test" where Set(body.keys) == Set(["command","action","target"]):
                    guard let target = body["target"] as? String, ["cloud","realtime"].contains(target) else {replyHandler(["status":"error","reason":"invalid_request"],nil);return}
                    request = .test(target)
                case "open" where Set(body.keys).isSubset(of: ["command","action","target","id"]) && body["target"] != nil:
                    guard let target = body["target"] as? String, ["cloud","cloud-new","realtime"].contains(target) else {replyHandler(["status":"error","reason":"invalid_request"],nil);return}
                    var id:String?
                    if let raw = body["id"] {
                        guard target == "cloud", let value = raw as? String, !value.isEmpty, value.utf8.count <= 200 else {replyHandler(["status":"error","reason":"invalid_request"],nil);return}
                        id = value
                    }
                    request = .open(target,id)
                case "save-cloud" where Set(body.keys) == Set(["command","action","draft"]):
                    guard let input=Self.speechCloudInput(body["draft"]) else{replyHandler(["status":"error","reason":"invalid_request"],nil);return};request = .saveCloud(input)
                case "test-cloud" where Set(body.keys) == Set(["command","action","draft"]):
                    guard let input=Self.speechCloudInput(body["draft"]) else{replyHandler(["status":"error","reason":"invalid_request"],nil);return};request = .testCloud(input)
                case "delete-cloud" where Set(body.keys) == Set(["command","action","id"]):
                    guard let id = body["id"] as? String, !id.isEmpty, id.utf8.count <= 200 else {replyHandler(["status":"error","reason":"invalid_request"],nil);return}
                    request = .deleteCloud(id)
                case "save-realtime" where Set(body.keys) == Set(["command","action","draft"]):
                    guard let input=Self.speechRealtimeInput(body["draft"]) else{replyHandler(["status":"error","reason":"invalid_request"],nil);return};request = .saveRealtime(input)
                case "test-realtime" where Set(body.keys) == Set(["command","action","draft"]):
                    guard let input=Self.speechRealtimeInput(body["draft"]) else{replyHandler(["status":"error","reason":"invalid_request"],nil);return};request = .testRealtime(input)
                case "delete-realtime" where Set(body.keys) == Set(["command","action","id"]):
                    guard let id = body["id"] as? String, !id.isEmpty, id.utf8.count <= 200 else {replyHandler(["status":"error","reason":"invalid_request"],nil);return}
                    request = .deleteRealtime(id)
                case "select-realtime" where Set(body.keys) == Set(["command","action","id"]):
                    guard let id = body["id"] as? String, !id.isEmpty, id.utf8.count <= 200 else {replyHandler(["status":"error","reason":"invalid_request"],nil);return}
                    request = .selectRealtime(id)
                case "silence" where Set(body.keys) == Set(["command","action","seconds"]):
                    guard let n = body["seconds"] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite, (0...10).contains(n.doubleValue) else {replyHandler(["status":"error","reason":"invalid_request"],nil);return}
                    request = .silence(n.doubleValue)
                default: replyHandler(["status":"error","reason":"invalid_request"],nil);return
                }
                guard action == "state" || (workspace.ready && workspace.selection == "settings") else {replyHandler(["status":"error","reason":"settings_not_visible"],nil);return}
                replyHandler(speechSettings?(request) ?? ["status":"error","reason":"unavailable"],nil);return
            }
            if command == "quick-entry-settings" {
                guard let workspace, message.webView === workspace.web,
                      let action = body["action"] as? String else { replyHandler(["status":"error","reason":"invalid_request"],nil);return }
                let request:QuickEntrySettingsRequest
                switch action {
                case "state" where Set(body.keys) == Set(["command","action"]): request = .state
                case "enabled" where Set(body.keys) == Set(["command","action","enabled"]):
                    guard let value = body["enabled"] as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else {replyHandler(["status":"error","reason":"invalid_request"],nil);return}
                    request = .enabled(value.boolValue)
                case "mode" where Set(body.keys) == Set(["command","action","mode"]):
                    guard let mode = body["mode"] as? String, ["island","edge","menuBar"].contains(mode) else {replyHandler(["status":"error","reason":"invalid_request"],nil);return}
                    request = .mode(mode)
                case "open" where Set(body.keys) == Set(["command","action"]): request = .open
                default: replyHandler(["status":"error","reason":"invalid_request"],nil);return
                }
                guard action == "state" || (workspace.ready && workspace.selection == "settings") else {replyHandler(["status":"error","reason":"settings_not_visible"],nil);return}
                replyHandler(quickEntrySettings?(request) ?? ["status":"error","reason":"unavailable"],nil);return
            }
            if ["agenda-query", "agenda-read", "agenda-mutation", "agenda-mutation-status"].contains(command) {
                guard let workspace, message.webView === workspace.web,
                      Set(body.keys).isSubset(of: ["command", "request", "proposal", "requestId", "context"]),
                      let rawContext = body["context"] as? [String: Any] else { replyHandler(AgendaAgentFailure("invalid_context").payload, nil); return }
                let context = try AgendaAgentContext(rawContext)
                let proposal = body["proposal"] as? [String: Any]
                let web = workspace.web, expectedOrigin = workspace.origin, controller = workspace.agendaAgent
                let verify: AgendaAgentController.Verify = { [weak self, weak workspace, weak controller] in
                    guard let self, let workspace, let controller, self.workspace === workspace, workspace.agendaAgent === controller,
                          workspace.ready, workspace.snapshot?.privateMode == false, workspace.web === web,
                          workspace.origin == expectedOrigin, let url = web.url,
                          url.scheme == "http", url.host == expectedOrigin?.host, url.port == expectedOrigin?.port else { return false }
                    let raw = try? await web.callAsyncJavaScript("return window.AgendaAccess?.authorize(context, proposal);",
                        arguments: ["context": rawContext, "proposal": proposal as Any? ?? NSNull()], in: nil, contentWorld: .page)
                    guard let result = raw as? [String: Any], result["status"] as? String == "authorized",
                          let authorized = result["context"] as? [String: Any], (try? AgendaAgentContext(authorized)) == context else { return false }
                    return self.workspace === workspace && workspace.agendaAgent === controller && workspace.ready &&
                        workspace.snapshot?.privateMode == false && workspace.web === web && workspace.origin == expectedOrigin
                }
                Task { @MainActor in
                    let result: [String: Any]
                    if command == "agenda-query", let request = body["request"] as? [String: Any] {
                        result = await controller.query(request, context: context, verify: verify)
                    } else if command == "agenda-read", let request = body["request"] as? [String: Any] {
                        result = await controller.read(request, context: context, verify: verify)
                    } else if command == "agenda-mutation", let proposal {
                        result = await controller.mutation(proposal, context: context, verify: verify)
                    } else if command == "agenda-mutation-status", let requestID = body["requestId"] as? String, let proposal {
                        result = await controller.status(requestID, proposal: proposal, context: context, verify: verify)
                    } else { result = AgendaAgentFailure("invalid_request").payload }
                    replyHandler(result, nil)
                }; return
            }
            if command=="speech-dictation" {
                guard let workspace,message.webView === workspace.web,let action=body["action"] as? String,
                      Set(body.keys).isSubset(of:Set(["command","action","lease"])),
                      let dictation=speechDictation else {replyHandler(["status":"error","reason":"unavailable"],nil);return}
                if action=="status" {
                    replyHandler(dictation.composerStatus,nil)
                    return
                }
                if action=="settings" {
                    guard workspace.ready,workspace.snapshot?.privateMode == false else{replyHandler(["status":"error","reason":"unavailable"],nil);return}
                    // Settings from the composer cannot steal either an active
                    // global session or a composer lease it has not cancelled.
                    guard dictation.canOpenComposerSettings else{replyHandler(["status":"error","reason":"busy"],nil);return}
                    Task { @MainActor [weak self] in replyHandler(["status":await self?.openSpeechSettings?() == true ? "opened":"error"],nil) };return
                }
                guard let value=body["lease"] as? [String:Any],let lease=NativeSpeechDictation.Lease(composer:value),
                      ["start","finish","retry","cancel"].contains(action) else{replyHandler(["status":"error","reason":"invalid_request"],nil);return}
                if action=="cancel" {replyHandler(dictation.cancel(lease),nil);return}
                let web=workspace.web,expectedOrigin=workspace.origin
                let verify:NativeSpeechDictation.Verify = { [weak self,weak workspace] in
                    guard let self,let workspace,self.workspace === workspace,self.speechDictation === dictation,
                          workspace.ready,workspace.snapshot?.privateMode == false,workspace.web === web,workspace.origin==expectedOrigin,
                          let url=web.url,url.scheme=="http",url.host==expectedOrigin?.host,url.port==expectedOrigin?.port else{return false}
                    let raw=try? await web.callAsyncJavaScript("return window.workstationDesktop?.dictation?.revalidate(lease);",arguments:["lease":value],in:nil,contentWorld:.page)
                    guard let result=raw as? [String:Any],result["status"] as? String=="authorized",
                          let current=NativeSpeechDictation.Lease(composer:result.filter{$0.key != "status"}),current==lease else{return false}
                    return self.workspace === workspace && self.speechDictation === dictation && workspace.ready &&
                        workspace.snapshot?.privateMode == false && workspace.web === web && workspace.origin==expectedOrigin
                }
                Task { @MainActor in
                    let result:[String:Any]
                    if action=="start" {result=await dictation.start(lease,verify:verify)}
                    else if action=="finish" {result=await dictation.finish(lease)}
                    else {result=await dictation.retry(lease)}
                    replyHandler(result,nil)
                };return
            }
            if command=="quick-panel-open" {
                guard let envelope=body["envelope"] as? [String:Any],let request=NativeQuickPanelOpenRequest(envelope),
                      let workspace,message.webView === workspace.web else {replyHandler(NativeQuickPanelOpenResult.denied(reason:"invalid_request").payload,nil);return}
                let web=workspace.web,expectedOrigin=workspace.origin
                Task { @MainActor [weak self,weak workspace] in
                    guard let self,let workspace else {replyHandler(NativeQuickPanelOpenResult.deferred(reason:"workspace_unavailable").payload,nil);return}
                    do {
                        let value=try await web.callAsyncJavaScript("return window.workstationDesktop?.quickPanel?.authorize(envelope);",arguments:["envelope":envelope],in:nil,contentWorld:.page)
                        guard self.workspace === workspace,workspace.web === web,workspace.origin==expectedOrigin,
                              let url=web.url,url.scheme=="http",url.host==expectedOrigin?.host,url.port==expectedOrigin?.port else {replyHandler(NativeQuickPanelOpenResult.denied(reason:"workspace_changed").payload,nil);return}
                        guard let receipt=value as? [String:Any],receipt["status"] as? String=="authorized",receipt["token"] as? String==request.token else {
                            let failure=value as? [String:Any],reason=failure?["reason"] as? String ?? "owner_changed"
                            let result:NativeQuickPanelOpenResult
                            switch failure?["status"] as? String {
                            case "deferred":result = .deferred(reason:reason)
                            case "unsupported":result = .unsupported(reason:reason)
                            default:result = .denied(reason:reason)
                            }
                            replyHandler(result.payload,nil);return
                        }
                        var authorizedRequest=request
                        authorizedRequest.authorizedUserText=receipt["userText"] as? String
                        let verify:() async -> Bool = { [weak self,weak workspace] in
                            guard let self,let workspace,self.workspace === workspace,workspace.web === web,workspace.origin==expectedOrigin,
                                  let url=web.url,url.scheme=="http",url.host==expectedOrigin?.host,url.port==expectedOrigin?.port else{return false}
                            let value=try? await web.callAsyncJavaScript("return window.workstationDesktop?.quickPanel?.revalidate(envelope);",arguments:["envelope":envelope],in:nil,contentWorld:.page)
                            guard let current=value as? [String:Any],current["status"] as? String=="authorized",current["token"] as? String==request.token else{return false}
                            return self.workspace === workspace && workspace.web === web && workspace.origin==expectedOrigin
                        }
                        guard let open=self.openQuickPanel else{replyHandler(NativeQuickPanelOpenResult.unsupported(reason:"panel_unavailable").payload,nil);return}
                        let result=await open(authorizedRequest,verify)
                        // The callback confirms JS lease, then native target/editor
                        // visibility synchronously. Do not insert another await
                        // between that final check and the receipt.
                        replyHandler(result.payload,nil)
                    }catch{replyHandler(NativeQuickPanelOpenResult.deferred(reason:"workspace_unavailable").payload,nil)}
                };return
            }
            if command=="navigate-workspace",let destination=body["destination"] as? [String:Any],let view=destination["view"] as? String,let workspace {
                guard ["overview","conversations","agenda","daily","courses","research","wiki","captures","dashboard","trash","agent"].contains(view),(destination["section"] == nil || destination["section"] is String),(destination["requestId"] == nil || destination["requestId"] is String) else {replyHandler(nil,"不支持此工作区位置");return}
                Task { @MainActor in replyHandler(await workspace.navigateWorkspace(view,section:destination["section"] as? String,requestId:destination["requestId"] as? String),nil) };return
            }
            if command=="browser",let request=body["request"] as? [String:Any],let workspace {
                Task { @MainActor in
                    do {replyHandler(try await workspace.browser.request(request,root:workspace.root,workspaceOrigin:workspace.origin),nil)}
                    catch {let failure=error as? BrowserFailure;var result=failure?.details ?? [:];result["error"]=error.localizedDescription;result["code"]=failure?.code ?? "BROWSER_ERROR";if result["status"] == nil {result["status"]=failure?.code == "CANCELLED" ? "cancelled":"failed"};replyHandler(result,nil)}
                };return
            }
            if command=="vector-index",let action=body["action"] as? String,let profile=body["profile"] as? String {
                let store=vectors
                vectorQueue.async {
                    do {
                        let result:Any
                        if action=="summary" {result=try store.summary(profile)}
                        else if action=="search",let query=body["query"] as? [Double],let entries=body["entries"] as? [String:String] {
                            result=try store.search(profile,query:query,entries:entries)
                        }
                        else if action=="load" {result=try store.load(profile)}
                        else if action=="write",let puts=body["puts"] as? [[String:Any]],let removes=body["removes"] as? [String] {
                            try store.write(profile,puts:puts,removes:removes);result=["ok":true]
                        } else {throw NativeVectorStore.Failure.invalidRecord}
                        DispatchQueue.main.async{replyHandler(result,nil)}
                    } catch {DispatchQueue.main.async{replyHandler(nil,"本机向量索引操作失败，请重试")}}
                };return
            }
            if command=="agenda-notifications" {
                Task { @MainActor in
                    guard let store=self.workspace?.agenda else {replyHandler(nil,"日程尚未就绪");return}
                    if body["enable"] as? Bool == true {await store.requestNotifications()}
                    replyHandler(["enabled":store.preferences.notifications,"status":store.notificationStatus],nil)
                };return
            }
            if command=="agenda-create-batch" {
                guard let workspace,message.webView === workspace.web,let proposals=body["proposals"] as? [[String:Any]],
                      !proposals.isEmpty,proposals.count<=12,let runID=body["runId"] as? String,runID.count<=512,
                      let automatic=body["automatic"] as? Bool,Set(body.keys)==Set(["command","proposals","runId","automatic"]),
                      workspace.ready,workspace.snapshot?.privateMode == false,let owner=workspace.agenda.storageIdentity else {throw AgendaError.message("日程提案不可用。")}
                let origin=workspace.origin,web=workspace.web
                let verify:@MainActor () async -> Bool = {[weak self,weak workspace] in
                    guard let self,let workspace,self.workspace === workspace,workspace.ready,workspace.snapshot?.privateMode == false,
                          workspace.origin==origin,workspace.agenda.storageIdentity==owner,web.url?.host==origin?.host,web.url?.port==origin?.port else{return false}
                    let result=try? await web.callAsyncJavaScript("return window.AgendaProposals?.authorizeCreation(runID,proposals,automatic)",arguments:["runID":runID,"proposals":proposals,"automatic":automatic],in:nil,contentWorld:.page)
                    return (result as? [String:Any])?["status"] as? String == "authorized" && self.workspace === workspace && workspace.ready && workspace.snapshot?.privateMode == false && workspace.origin==origin && workspace.agenda.storageIdentity==owner
                }
                Task { @MainActor in
                    do {
                        guard await verify() else{throw AgendaError.message("日程提案、来源或权限已变化，未保存。")}
                        let events=try proposals.map{try workspace.proposedAgendaEvent($0,automatic:automatic)}
                        guard Set(events.map(\.id)).count==events.count else{throw AgendaError.message("日程提案存在重复标识。")}
                        if automatic {
                            // verify() re-runs authorizeCreation(automatic): it allows an estimated
                            // end only for full / risk-only conversations and reviews it otherwise.
                            let scope=AgendaEditingScope(projects:(workspace.snapshot?.projects ?? []).map{AgendaEditingProject(id:$0.id,title:$0.title)},documents:(workspace.snapshot?.documents ?? []).map{AgendaEditingDocument(id:$0.id,title:$0.title,projectID:$0.projectId,kind:$0.kind)})
                            for event in events {try scope.validate(event,expected:nil)}
                            let created=try workspace.agenda.createProposals(events)
                            replyHandler(["status":"committed","persisted":true,"created":created,"eventIds":events.map(\.id)],nil)
                        } else {
                            guard workspace.agendaCreationReview == nil,workspace.agendaDraft == nil,workspace.agendaAgent.review == nil,!workspace.agenda.hasUnsavedEditorDrafts else{throw AgendaError.message("已有日程正在编辑，请先完成或关闭。")}
                            workspace.agendaCreationReview=AgendaCreationReview(events:events,owner:owner,verify:verify)
                            replyHandler(["status":"pending_review"],nil)
                        }
                    }catch{replyHandler(nil,error.localizedDescription)}
                };return
            }
            if command=="agenda-proposal",let proposal=body["proposal"] as? [String:Any]{try workspace?.reviewAgendaProposal(proposal);replyHandler(["ok":true],nil);return}
            if command=="agenda-draft",let id=body["id"] as? String {try workspace?.draftAgenda(id);replyHandler(["ok":true],nil);return}
            if command=="agenda-open",let id=body["id"] as? String {try workspace?.openLinkedAgenda(id);replyHandler(["ok":true],nil);return}
            if command=="agenda-related" {replyHandler(workspace?.agendaAgent.related(includeCancelled:body["includeCancelled"] as? Bool == true) ?? [],nil);return}
            if command=="credentials",let channel=body["channel"] as? String,let action=body["action"] as? String {
                let options=body["options"] as? [String:Any] ?? [:]
                // Security APIs can wait for user authorization. Keep the main thread responsive.
                let store=credentials
                credentialQueue.async {
                    do {let value=try store.call(channel,action,options);DispatchQueue.main.async{replyHandler(value,nil)}}
                    catch{let error=error.localizedDescription;DispatchQueue.main.async{replyHandler(nil,error)}}
                };return
            }
            if command=="preferences",let key=body["key"] as? String,Self.preferenceKeys.contains(key) {
                if let value=body["value"] as? String,value.utf8.count<=100000 {preferences[key]=value}else{preferences.removeValue(forKey:key)}
                if key == "ai-bro-language" { NativeL10n.shared.setLanguage(preferences[key] ?? "zh-CN") }
                try JSONEncoder().encode(preferences).write(to:prefsFile,options:.atomic);try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:prefsFile.path)
            } else if command=="language",let value=body["value"] as? String {
                let language=NativeL10n.normalize(value)
                preferences["ai-bro-language"]=language
                try JSONEncoder().encode(preferences).write(to:prefsFile,options:.atomic)
                try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:prefsFile.path)
                NativeL10n.shared.setLanguage(language)
            } else if command=="appearance",let value=body["value"] as? String {workspace?.webRequestedAppearance(value)}
            else if command=="auth",let string=body["url"] as? String,let url=URL(string:string),url.scheme=="https",["auth.openai.com","chatgpt.com","platform.openai.com"].contains(url.host ?? "") {NSWorkspace.shared.open(url)}
            else {throw AgendaError.message("不支持此桌面操作")}
            replyHandler(["ok":true],nil)
        }catch{replyHandler(nil,error.localizedDescription)}
    }
}
