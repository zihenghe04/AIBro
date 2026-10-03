import Foundation
import Combine
import SwiftUI
func nativeUI(_ zh:String,_ en:String)->String { en }
@MainActor final class ReplyGate {
    var continuation:CheckedContinuation<[String:Any],Never>?
    func wait() async->[String:Any] { await withCheckedContinuation { continuation=$0 } }
    func release(_ value:[String:Any]) { continuation?.resume(returning:value);continuation=nil }
}
@main struct WorkflowTests {
    @MainActor static func main() async throws {
        let directory=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true)
        let names=NativeQuickTaskWorkflow.defaults
        func row(_ id:String,_ category:String?,done:Bool=false)->NativeQuickTaskItem {
            NativeQuickTaskItem(id:id,title:"Synthetic "+id,projectTitle:"Synthetic course",dueLabel:"",isCompleted:done,version:"v1",workspace:"课程",projectId:"project",workflowCategory:category)
        }
        let rows=[row("a","P0"),row("b","P0",done:true),row("c","P1"),row("d",nil)]
        func snapshot(ready:Bool=true)->NativeQuickWorkbenchSnapshot {
            NativeQuickWorkbenchSnapshot(version:1,status:ready ? "ready":"deferred",reason:ready ? nil:"private",tasks:ready ? rows:[],runs:[],taskCount:3,runCount:0,workflowNames:names,workflowVersion:"names-v1")
        }
        func check(_ valid:Bool,_ label:String) { precondition(valid,label);print("PASS: "+label) }
        let gate=ReplyGate(),store=NativeQuickWorkbenchStore();var payloads:[[String:Any]]=[];var delayed=false
        store.configure(directory:directory,command:{ payload in
            payloads.append(payload)
            if delayed { return await gate.wait() }
            if payload["action"] as? String == "rename-task-workflow" {
                var renamed=names;renamed[payload["category"] as! String]=payload["name"] as? String
                return ["status":"saved","id":payload["id"]!,"workflowNames":renamed,"workflowVersion":"names-v2"]
            }
            return ["status":"saved","id":payload["id"]!]
        },openTask:{_ in false},openRun:{_ in false})
        defer { store.taskInbox.setAvailable(false) }
        store.accept(snapshot())
        check(store.workflowCount(nil)==3 && store.workflowCount("P0")==1 && store.workflowCount("")==1,"Counts include only unfinished canonical projected tasks")
        store.setWorkflowFilter("P0")
        check(store.visibleTasks.map(\.id)==["a","b"],"Category view retains completed tasks")
        store.selectAllTasks();check(store.taskSelection.ids==Set(["a","b"]),"Select all only selects visible category")
        store.setWorkflowFilter("P1");check(store.taskSelection.ids.isEmpty && store.visibleTasks.map(\.id)==["c"],"Switching category clears hidden selection")
        check(store.beginEditingTask(id:"a"),"Shared task editor opens")
        store.editingTask?.fields.workflowCategory=nil
        check(store.hasUnsavedTaskEditorDraft,"Clearing workflow protects the task editor draft")
        check(await store.saveEditingTask(),"Workflow edit goes through real store command")
        let patch=payloads.last?["patch"] as? [String:Any]
        check(patch?["workflowCategory"] is NSNull && patch?["workspace"] as? String == "课程" && patch?["projectId"] as? String == "project","Explicit null clears membership without changing task scope")
        check(store.beginWorkflowRename("P0"),"Category rename uses current snapshot baseline")
        store.workflowNameDraft?.name="Reading"
        check(store.hasTaskEditor && store.hasUnsavedTaskEditorDraft && !store.beginEditingTask(id:"c"),"Rename draft blocks competing native editors and quit")
        check(await store.saveWorkflowRename(),"Durable rename ACK updates native labels")
        check(store.workflowNames["P0"]=="Reading" && store.workflowNameDraft==nil,"Successful ACK clears exact draft")
        check(store.beginWorkflowRename("P1"),"Second category rename opens")
        store.workflowNameDraft?.name="Submitted";delayed=true
        let request=Task { await store.saveWorkflowRename() }
        while gate.continuation == nil { await Task.yield() }
        store.workflowNameDraft?.name="Newer input"
        gate.release(["status":"saved","id":"quick_task_workflow_names","workflowNames":names.merging(["P1":"Submitted"]){_,n in n},"workflowVersion":"names-v3"])
        check(await request.value && store.workflowNameDraft?.name=="Newer input","Late rename ACK does not discard a newer draft")
        check(store.workflowNameDraft?.original=="Submitted" && store.workflowNameDraft?.expectedVersion=="names-v3","Newer text rebases only its original and expected version to exact ACK")
        delayed=false
        check(await store.saveWorkflowRename(),"Rebased newer draft can save without discarding its text")
        check(payloads.last?["expectedVersion"] as? String == "names-v3" && payloads.last?["name"] as? String == "Newer input","Second save sends the acknowledged CAS version with the newer name")
        delayed=true
        check(store.beginWorkflowRename("P2"),"Privacy scenario opens isolated rename")
        store.workflowNameDraft?.name="Unconfirmed"
        let privateRequest=Task { await store.saveWorkflowRename() }
        while gate.continuation == nil { await Task.yield() }
        store.accept(snapshot(ready:false));store.accept(snapshot())
        let currentError=store.error
        gate.release(["status":"error","reason":"invalid"])
        check(!(await privateRequest.value) && store.workflowNameDraft?.name=="Unconfirmed","Privacy generation change retains unconfirmed draft")
        check(store.error==currentError,"Old-generation rejection does not overwrite current workspace error")
        store.workflowNameDraft=nil
        check(store.beginWorkflowRename("P3"),"Canonical projection race starts from a captured baseline")
        store.workflowNameDraft?.name="Older ACK"
        let reordered=Task { await store.saveWorkflowRename() }
        while gate.continuation == nil { await Task.yield() }
        let newer=NativeQuickWorkbenchSnapshot(version:1,status:"ready",reason:nil,tasks:rows,runs:[],taskCount:3,runCount:0,
            workflowNames:names.merging(["P0":"New canonical label"]){_,n in n},workflowVersion:"names-newer")
        store.accept(newer)
        gate.release(["status":"saved","id":"quick_task_workflow_names","workflowNames":names.merging(["P3":"Older ACK"]){_,n in n},"workflowVersion":"names-older-ack"])
        check(!(await reordered.value),"An old rename ACK cannot overtake a newer canonical projection")
        store.accept(newer)
        check(store.workflowVersion=="names-newer" && store.workflowNames["P0"]=="New canonical label" && store.workflowNameDraft?.name=="Older ACK","Snapshot dedupe retains newer names and the unresolved draft")
        let legacy=try JSONDecoder().decode(NativeQuickTaskFields.self,from:Data(#"{"workspace":"课程","projectId":"project","dueAt":null}"#.utf8))
        check(legacy.workflowCategory==nil && legacy.payload["workflowCategory"]==nil,"Old pending field encoding retains legacy fingerprint")
        let fresh=NativeQuickTaskFields(workspace:"课程",projectId:"project",workflowCategory:"P3")
        let restored=try JSONDecoder().decode(NativeQuickTaskFields.self,from:JSONEncoder().encode(fresh))
        check(restored==fresh && restored.payload["workflowCategory"] as? String == "P3","New pending category survives serialization")
        check(!NativeQuickTaskFields(workflowCategory:"invalid").valid,"Unknown category is rejected before native dispatch")
        let pendingDirectory=directory.appendingPathComponent("pending",isDirectory:true)
        let first=NativeQuickWorkbenchStore();var pendingID:String?
        first.configure(directory:pendingDirectory,command:{ payload in
            pendingID=payload["id"] as? String
            return ["status":"error","reason":"storage_failed"]
        },openTask:{_ in false},openRun:{_ in false})
        first.accept(snapshot())
        check(!(await first.createTask(title:"Durable workflow task",fields:fresh)),"Unconfirmed creation retains a recoverable request")
        first.taskInbox.setAvailable(false)
        let restart=NativeQuickWorkbenchStore();var restoredID:String?
        restart.configure(directory:pendingDirectory,command:{ payload in
            restoredID=payload["id"] as? String
            check(payload["workflowCategory"] as? String == "P3","Restart dispatches the original workflow category")
            return ["status":"saved","id":payload["id"]!]
        },openTask:{_ in false},openRun:{_ in false})
        restart.accept(snapshot())
        check(restart.pendingTaskFields==fresh,"Real pending envelope restores category and scope")
        check(await restart.createTask(title:"Durable workflow task",fields:fresh),"Retry receives durable ACK without a new identity")
        check(pendingID==restoredID,"Workflow creation retry preserves the stable task ID")
        restart.taskInbox.setAvailable(false)
    }
}
