import Foundation
import AppKit
import WebKit

@MainActor final class NativeDesktop:NSObject,WKScriptMessageHandlerWithReply {
    weak var workspace:Workspace?
    private let credentialQueue=DispatchQueue(label:"app.aibro.credentials")
    let credentials:NativeCredentials
    let prefsFile:URL
    var preferences:[String:String]
    static let preferenceKeys=Set(["workstation-api-base","workstation-api-model","workstation-openai-model","workstation-provider","aibro-embedding-settings-v1","ai-bro-language","workstation-ui"])
    init(data:URL,production:Bool) {
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
            if command=="agenda-related" {let events=workspace?.agenda.events.filter{!$0.deleted && !$0.documentID.isEmpty} ?? [];replyHandler(events.map{["id":$0.id,"title":$0.title,"documentID":$0.documentID,"start":$0.start.timeIntervalSince1970*1000] as [String:Any]},nil);return}
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
