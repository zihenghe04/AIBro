import Foundation
import WebKit

extension Workspace {
    var voiceWorkspaceAvailable:Bool {
        guard ready,snapshot?.privateMode == false,let origin,let url=web.url,
              url.scheme == "http",url.host == origin.host,url.port == origin.port else{return false}
        return true
    }
    /// The web owner creates the new conversation and durably acknowledges its
    /// user message. Native code never injects text into the active composer.
    func submitVoiceInstruction(requestID:String,text:String) async -> [String:Any] {
        guard voiceWorkspaceAvailable,UUID(uuidString:requestID) != nil,!text.isEmpty,
              text.utf8.count<=NativeSpeechService.responseLimit else{return ["status":"deferred","reason":"unavailable","requestId":requestID]}
        guard snapshot?.modalOpen != true,!agenda.hasUnsavedEditorDrafts,
              web.window?.attachedSheet == nil else{return ["status":"deferred","reason":"editing","requestId":requestID]}
        let expectedOrigin=origin
        let payload:[String:Any]=["requestId":requestID,"text":text,"workspace":"日常","projectId":""]
        do {
            let value=try await web.callAsyncJavaScript("""
            if (!window.QuickVoiceCommand?.submit) return {status:'deferred',reason:'unavailable',requestId:payload.requestId};
            return await window.QuickVoiceCommand.submit(payload);
            """,arguments:["payload":payload],in:nil,contentWorld:.page)
            guard voiceWorkspaceAvailable,origin==expectedOrigin,
                  let reply=value as? [String:Any],reply["requestId"] as? String==requestID else {
                return ["status":"uncertain","reason":"unconfirmed","requestId":requestID]
            }
            return reply
        }catch{return ["status":"uncertain","reason":"unconfirmed","requestId":requestID]}
    }
}
