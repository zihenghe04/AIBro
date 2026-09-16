import Foundation
import WebKit

extension Workspace {
    func requestAgendaSync() {
        guard ready,!agendaSyncRunning else{return}
        agendaSyncRunning=true
        Task { @MainActor in
            defer {agendaSyncRunning=false}
            do {
                guard let raw = try await web.callAsyncJavaScript("return await window.NativeAgendaSync.read()",arguments:[:],in:nil,contentWorld:.page) as? String,
                      let notes = try JSONSerialization.jsonObject(with:Data(raw.utf8)) as? [String:String] else {throw AgendaError.message("日程同步返回无效数据")}
                let plan=AgendaWire.plan(events:agenda.events,receipts:agenda.syncReceipts,notes:notes)
                agendaSyncConflicts=plan.conflicts
                let writes=plan.changes.filter{$0.writeNote != nil}
                var acknowledged=Set<String>()
                if !writes.isEmpty {
                    let batch:[[String:Any]]=writes.map{["id":$0.noteID,"expected":$0.expectedNote as Any? ?? NSNull(),"note":$0.writeNote!]}
                    guard let accepted=try await web.callAsyncJavaScript("return await window.NativeAgendaSync.write(changes)",arguments:["changes":batch],in:nil,contentWorld:.page) as? [String] else {throw AgendaError.message("日程保存未确认")}
                    acknowledged=Set(accepted)
                }
                // Pulls refer to the exact read snapshot. If notes changed during a write,
                // do not acknowledge the old snapshot; the next pass will read it again.
                let verifiedRaw=try await web.callAsyncJavaScript("return await window.NativeAgendaSync.read()",arguments:[:],in:nil,contentWorld:.page) as? String
                let verified=try verifiedRaw.flatMap{try JSONSerialization.jsonObject(with:Data($0.utf8)) as? [String:String]} ?? [:]
                let accepted=try plan.changes.filter{change in
                    if change.writeNote != nil{return acknowledged.contains(change.noteID)}
                    return try AgendaWire.stamp(verified[change.noteID]) == change.expectedNote
                }
                if !accepted.isEmpty {try agenda.acknowledgeSync(accepted)}
                agendaSyncStatus = !plan.warnings.isEmpty ? plan.warnings.joined(separator:"；") : plan.conflicts.isEmpty ? "日程已接入工作区同步" : "有 \(plan.conflicts.count) 条日程需要选择保留版本"
            } catch {agendaSyncStatus="日程等待同步：\(error.localizedDescription)"}
        }
    }
    func resolveAgendaSync(_ conflict:AgendaSyncConflict,useRemote:Bool) {
        do{try agenda.resolveSync(conflict,useRemote:useRemote);agendaSyncConflicts.removeAll{$0.id==conflict.id};requestAgendaSync()}
        catch{agendaSyncStatus=error.localizedDescription}
    }
}
