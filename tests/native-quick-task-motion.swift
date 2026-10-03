import Foundation
import SwiftUI
func nativeUI(_ zh:String,_ en:String)->String { en }
@MainActor final class MotionReplyGate {
    var continuation:CheckedContinuation<[String:Any],Never>?
    func wait() async->[String:Any] { await withCheckedContinuation { continuation=$0 } }
    func release(_ value:[String:Any]) { continuation?.resume(returning:value);continuation=nil }
}
@main struct TaskMotionChecks {
    @MainActor static func main() async throws {
        var count=0
        func check(_ value:Bool,_ message:String){precondition(value,message);count+=1;print("PASS "+message)}
        typealias Item=NativeQuickTaskMotionInput.Item
        func item(_ id:String,_ done:Bool=false,_ pending:Bool=false)->Item {.init(id:id,completed:done,pending:pending)}
        var state=NativeQuickTaskMotionState()
        func accept(_ input:NativeQuickTaskMotionInput)->NativeQuickTaskMotionState.Change {let change=state.next(input);state=change.state;return change}
        let first=accept(.init(items:[item("a"),item("b"),item("c",true)]))
        check(!first.moves && first.arrivals.isEmpty && first.categoryAnchorID == nil && state.checkRevision.isEmpty,"initial historical rows establish a baseline without entrances or check pulses")
        let poll=accept(.init(items:[item("a"),item("b"),item("c",true)]))
        check(!poll.moves && poll.arrivals.isEmpty && poll.categoryAnchorID == nil,"unchanged polling cannot replay entrances or move the list")
        _=accept(.init(items:[item("b"),item("c",true),item("a",true,true)]))
        check(state.order==["b","c","a"] && state.completed["a"]==false && state.checkRevision["a"]==nil,"pending feedback keeps unchecked state without inventing another order")
        _=accept(.init(items:[item("b"),item("c",true),item("a",true)]))
        check(state.order==["b","c","a"] && state.checkRevision["a"]==1,"accepted completion advances one check trigger while retaining canonical order")
        let settle=accept(.init(items:[item("b"),item("c",true),item("a",true)]))
        check(!settle.moves && state.checkRevision["a"]==1,"later delivery of the same saved snapshot does not repeat completion feedback")
        _=accept(.init(items:[item("a",false,true),item("b"),item("c",true)]))
        check(state.order==["a","b","c"] && state.completed["a"]==true,"pending reopen leaves confirmed completion visible until accepted")
        _=accept(.init(items:[item("a"),item("b"),item("c",true)]))
        check(state.completed["a"]==false && state.checkRevision["a"]==2,"reopen advances the keyframe trigger and resets the old completion pulse")
        _=accept(.init(items:[item("b"),item("c",true),item("a",true)]))
        check(state.checkRevision["a"]==3,"rapid confirmed reverse and re-complete use fresh triggers, not delayed callbacks")
        _=accept(.init(items:[item("new",false,true),item("b"),item("c",true),item("a",true)]))
        check(state.order.first=="new" && state.arrivalRevision["new"]==nil,"unacknowledged new task stays in canonical order without a success arrival")
        let arrival=accept(.init(items:[item("new"),item("b"),item("c",true),item("a",true)]))
        check(arrival.arrivals==["new"] && state.arrivalRevision["new"]==1 && state.order.first=="new","only the acknowledged new identity gets a single insertion")
        _=accept(.init(items:[item("b"),item("c",true),item("a",true)]))
        let undo=accept(.init(items:[item("new"),item("b"),item("c",true),item("a",true)]))
        check(undo.arrivals==["new"] && state.order.first=="new","restoring a deleted real ID inserts it without copying a task body")
        let filter=accept(.init(filter:"P0",items:[item("new"),item("b"),item("c",true),item("a",true)],visibleIDs:["c","a"]))
        check(!filter.moves && filter.arrivals.isEmpty && state.checkRevision.isEmpty,"filter changes are new display baselines, not creation or completion events")
        check(filter.categoryAnchorID == "c", "category switch reveals its first actual visible task instead of retaining another category bottom")
        let categoryPoll=accept(.init(filter:"P0",items:[item("new"),item("b"),item("c",true),item("a",true)],visibleIDs:["c","a"]))
        check(categoryPoll.categoryAnchorID == nil,"later snapshots in the same category never request another scroll")
        let emptyCategory=accept(.init(filter:"P1",items:[item("new"),item("b"),item("c",true),item("a",true)],visibleIDs:[]))
        check(emptyCategory.categoryAnchorID == nil,"switching to an empty category never scrolls to an invisible row")
        let privateState=accept(.init(ready:false,items:[]))
        check(!privateState.moves && state.order.isEmpty && state.completed.isEmpty && state.checkRevision.isEmpty,"privacy/not-ready immediately clears every retained presentation identity")
        let resumed=accept(.init(items:[item("new"),item("b"),item("c",true),item("a",true)]))
        check(!resumed.moves && resumed.arrivals.isEmpty,"returning from private state never animates historical tasks as new")
        let pendingTitle=accept(.init(items:[item("new",false,true),item("b"),item("c",true),item("a",true)]))
        check(!pendingTitle.moves && state.order.count==4,"busy edits of known rows preserve the same membership and order")
        _=accept(.init(items:[item("new"),item("b"),item("c",true),item("a",true)]))
        check(state.checkRevision.isEmpty,"title/date-only saves never create a completion trigger")

        let directory=URL(fileURLWithPath:CommandLine.arguments[1]),store=NativeQuickWorkbenchStore(),gate=MotionReplyGate()
        store.configure(directory:directory,command:{_ in await gate.wait()},openTask:{_ in false},openRun:{_ in false})
        defer{store.taskInbox.setAvailable(false)}
        func task(_ id:String,done:Bool=false,saving:Bool=false)->NativeQuickTaskItem {.init(id:id,title:"Fictional task "+id,projectTitle:"Synthetic",dueLabel:"",isCompleted:done,version:done ? "v2":"v1",isSaving:saving,workspace:"课程",projectId:"p")}
        func snapshot(_ tasks:[NativeQuickTaskItem])->NativeQuickWorkbenchSnapshot {.init(version:1,status:"ready",reason:nil,tasks:tasks,runs:[],taskCount:tasks.count,runCount:0)}
        store.accept(snapshot([task("one"),task("two")]))
        state = .init();_=accept(.init(workbench:store))
        let update=Task {await store.setTaskCompleted(id:"one",completed:true)}
        while gate.continuation==nil {await Task.yield()}
        let duplicate = await store.setTaskCompleted(id:"one",completed:true)
        check(!duplicate && gate.continuation != nil,"saving completion control cannot issue a duplicate real Workbench command")
        store.accept(snapshot([task("two"),task("one",done:true)]))
        _=accept(.init(workbench:store))
        check(state.order==["two","one"] && state.completed["one"]==false,"real Workbench local command lease prevents early check feedback without forking canonical order")
        gate.release(["status":"saved","id":"one"]);let success=await update.value
        _=accept(.init(workbench:store))
        check(success && state.order==["two","one"] && state.checkRevision["one"]==1,"real saved command release permits exactly one completion feedback")
        let reopen=Task {await store.setTaskCompleted(id:"one",completed:false)}
        while gate.continuation==nil {await Task.yield()}
        _=accept(.init(workbench:store));gate.release(["status":"deferred","reason":"changed"]);let failed=await reopen.value
        let failure=accept(.init(workbench:store))
        check(!failed && !failure.moves && state.completed["one"]==true && state.checkRevision["one"]==1,"failed real command cannot falsely play a reopen or completion animation")
        check(store.beginEditingTask(id:"two"),"real task editor opens beside a presentation projection")
        store.editingTask?.title="Unsaved fictional draft";store.selectTask(id:"two")
        let draft=store.editingTask,selection=store.taskSelection
        _=accept(.init(workbench:store))
        check(store.editingTask==draft && store.taskSelection==selection,"presentation reconciliation cannot mutate the real draft, selection or persistence")
        print("\(count) task motion checks; actual native Views compile, no GUI, database or provider")
    }
}
