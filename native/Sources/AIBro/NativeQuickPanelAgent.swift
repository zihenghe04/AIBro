import Foundation

/// A presentation-only request, authenticated against the current host tool run.
/// It conveys no save, device capture, paste, clipboard or execution authority.
struct NativeQuickPanelOpenRequest {
    enum Section:String,CaseIterable { case home,tasks,capture,runs,agenda,links }
    struct Owner {
        let runID:String
        let conversationID:String
        let projectID:String?
        let workspace:String
        let userMessageID:String
        let toolCallID:String
    }
    let token:String
    let section:Section
    let recordType:String?
    let recordID:String?
    let owner:Owner
    // Populated only by the trusted page's authorization reply, never parsed
    // from model arguments. Native agenda records use this exact current turn.
    var authorizedUserText: String? = nil

    init?(_ envelope:[String:Any]) {
        func identifier(_ value:Any?)->String? {
            guard let text=value as? String,!text.isEmpty,text.utf8.count<=2048,
                  text.unicodeScalars.allSatisfy({!CharacterSet.controlCharacters.contains($0)}) else{return nil}
            return text
        }
        guard Set(envelope.keys)==Set(["token","request"]),
              let token=envelope["token"] as? String,UUID(uuidString:token) != nil,
              let request=envelope["request"] as? [String:Any],
              Set(request.keys).isSubset(of:Set(["section","recordType","recordId","owner"])),
              let sectionName=request["section"] as? String,let section=Section(rawValue:sectionName),
              let fields=request["owner"] as? [String:Any],
              Set(fields.keys)==Set(["runId","conversationId","projectId","workspace","userMessageId","toolCallId"]),
              let runID=identifier(fields["runId"]),let conversationID=identifier(fields["conversationId"]),
              let workspace=identifier(fields["workspace"]),let userMessageID=identifier(fields["userMessageId"]),
              let toolCallID=identifier(fields["toolCallId"]) else{return nil}
        let projectID=identifier(fields["projectId"])
        guard projectID != nil || fields["projectId"] is NSNull else{return nil}
        let recordType=identifier(request["recordType"]),recordID=identifier(request["recordId"])
        guard (request["recordType"] == nil && request["recordId"] == nil) || (recordType != nil && recordID != nil) else{return nil}
        self.token=token;self.section=section;self.recordType=recordType;self.recordID=recordID
        self.owner=Owner(runID:runID,conversationID:conversationID,projectID:projectID,workspace:workspace,userMessageID:userMessageID,toolCallID:toolCallID)
    }
}

enum NativeQuickPanelOpenResult {
    case opened(section:NativeQuickPanelOpenRequest.Section)
    case positioned(section:NativeQuickPanelOpenRequest.Section,recordType:String,recordID:String)
    case deferred(reason:String)
    case unsupported(reason:String)
    case denied(reason:String)

    /// Keep the final native guard after the last asynchronous host lease hop.
    /// Callers reuse their exact target/editor/presentation predicates here.
    @MainActor func confirmed(verify: () async -> Bool, isPresented: () -> Bool) async -> Self {
        guard await verify() else{return .denied(reason:"authorization_changed")}
        guard isPresented() else{return .deferred(reason:"presentation_changed")}
        return self
    }

    var payload:[String:Any] {
        let status:String,reason:String
        switch self {
        case .opened(let section):return ["type":"quick_panel_open","status":"opened","opened":true,"section":section.rawValue]
        case .positioned(let section,let recordType,let recordID):return ["type":"quick_panel_open","status":"opened","opened":true,"section":section.rawValue,"recordType":recordType,"recordId":recordID,"positioned":true]
        case .deferred(let value):status="deferred";reason=value
        case .unsupported(let value):status="unsupported";reason=value
        case .denied(let value):status="denied";reason=value
        }
        return ["type":"quick_panel_open","status":status,"opened":false,"reason":reason]
    }
}
