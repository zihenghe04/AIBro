import Foundation

/// A proposal's project is a real identity, independent of explanatory notes.
/// Missing fields can inherit only their source; an explicit empty field stays empty.
enum AgendaProposalProject {
    static func resolve(_ proposal:[String:Any],sourceProjectID:String?,conversationProjectID:String?,availableProjectIDs:[String]) throws -> String {
        var explicit:[String]=[]
        for key in ["projectID","projectId","courseId"] where proposal.keys.contains(key) {
            if proposal[key] is NSNull {explicit.append("");continue}
            guard let value=proposal[key] as? String,value.isEmpty || (!value.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty && value.count<=200) else {
                throw AgendaError.message("日程提案的所属项目无效。")
            }
            explicit.append(value)
        }
        guard Set(explicit).count<=1 else {throw AgendaError.message("日程提案的所属项目字段不一致。")}
        let id=explicit.first ?? sourceProjectID ?? conversationProjectID ?? ""
        if let sourceProjectID,sourceProjectID != id {
            throw AgendaError.message("日程不能改变来源随记的项目归属。请解除资料关联后选择其他项目。")
        }
        guard id.isEmpty || availableProjectIDs.filter({$0==id}).count==1 else {
            throw AgendaError.message("日程所属项目已不可用，请重新选择后生成提案。")
        }
        return id
    }
}
