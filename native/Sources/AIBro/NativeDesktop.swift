import Foundation
import AppKit
import WebKit

@MainActor final class NativeDesktop:NSObject,WKScriptMessageHandlerWithReply {
    weak var workspace:Workspace?
    var openQuickPanel:((NativeQuickPanelOpenRequest,@escaping () async -> Bool) async -> NativeQuickPanelOpenResult)?
    var speechDictation:NativeSpeechDictation?
    var openSpeechSettings:(() async -> Bool)?
    private let credentialQueue=DispatchQueue(label:"app.aibro.credentials")
    private let vectorQueue=DispatchQueue(label:"app.aibro.vector-index",qos:.utility)
    let vectors:NativeVectorStore
    let credentials:NativeCredentials
    let prefsFile:URL
    var preferences:[String:String]
    static let preferenceKeys=Set(["workstation-api-base","workstation-api-model","workstation-api-protocol","workstation-api-protocol-learned","workstation-openai-model","workstation-provider","aibro-embedding-settings-v1","ai-bro-language","workstation-ui"])
    init(data:URL,production:Bool) {
        vectors=NativeVectorStore(folder:data)
        prefsFile=data.appendingPathComponent("native-preferences.json")
        preferences=(try? Data(contentsOf:prefsFile)).flatMap{try? JSONDecoder().decode([String:String].self,from:$0)} ?? [:]
        let old=production ? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/ai-workstation-studio"):nil
        credentials=NativeCredentials(folder:data.appendingPathComponent("native-credentials"),legacy:old,service:production ? "app.ai-workstation.studio.native-credentials":"app.aibro.preview-credentials")
        super.init()
        NativeL10n.shared.setLanguage(preferences["ai-bro-language"] ?? "zh-CN")
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
                        if action=="load" {result=try store.load(profile)}
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
            } else if command=="appearance",let value=body["value"] as? String {workspace?.setAppearance(value)}
            else if command=="auth",let string=body["url"] as? String,let url=URL(string:string),url.scheme=="https",["auth.openai.com","chatgpt.com","platform.openai.com"].contains(url.host ?? "") {NSWorkspace.shared.open(url)}
            else {throw AgendaError.message("不支持此桌面操作")}
            replyHandler(["ok":true],nil)
        }catch{replyHandler(nil,error.localizedDescription)}
    }
}
