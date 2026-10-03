import Foundation
import Combine

func nativeUI(_ zh:String,_ en:String)->String {en}
struct ContentRecord {let id:String;let title:String;let workspace:String;let projectId:String;let kind:String;let status:String;let start:Double?;let due:Double?;let completed:Double?;var dueDay:String?=nil;var updated:Double?=nil;var reminderMinutes:Int?=nil;var reminderDisabled:Bool?=nil}

@main struct NativeQuickAgendaTests {
    @MainActor static func main() async throws {
        let root=FileManager.default.temporaryDirectory.appendingPathComponent("aibro-quick-agenda-"+UUID().uuidString)
        try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
        defer{try? FileManager.default.removeItem(at:root)}
        var checks=0
        func check(_ condition:Bool,_ name:String){precondition(condition,name);checks+=1;print("PASS",name)}
        func folder(_ name:String)throws->URL{let value=root.appendingPathComponent(name);try FileManager.default.createDirectory(at:value,withIntermediateDirectories:true);return value}
        func sample(_ id:String,_ start:Date)->AgendaEvent{var event=AgendaEvent();event.id=id;event.title="Synthetic event";event.projectID="project";event.start=start;event.end=start.addingTimeInterval(1200);event.reminderMinutes=nil;return event}
        let day=Calendar.current.startOfDay(for:Date().addingTimeInterval(86400)),start=day.addingTimeInterval(15*3600)
        let directory=try folder("shared"),agenda=AgendaStore();agenda.load(folder:directory,qa:true)
        var context=NativeQuickAgendaContext(ready:true,privateMode:false,
            projects:[AgendaEditingProject(id:"project",title:"Public project")],
            documents:[AgendaEditingDocument(id:"note",title:"Public source",projectID:"project",kind:"note")],taskIDs:["task"],projectID:"project")
        let quick=NativeQuickAgendaStore();var openedTasks:[String]=[],openedDays:[Date]=[],changes=0
        agenda.onChanged={changes+=1}
        quick.configure(agenda:agenda,context:{context},openTask:{id in openedTasks.append(id);return true},openAgenda:{openedDays.append($0)})
        quick.date=day
        check(quick.ready && quick.beginNew(),"quick editor uses the ready shared store")
        quick.updateDraft{$0.title="Island event";$0.start=start;$0.end=start.addingTimeInterval(1200);$0.documentID="note"}
        check(quick.hasUnsavedEditorDraft && agenda.hasUnsavedEditorDrafts,"island draft participates in the original App quit gate")
        let eventID=quick.editing!.event.id
        check(quick.saveEditor() && quick.savedEventID==eventID && !quick.hasEditor && !agenda.hasUnsavedEditorDrafts,"saved UI requires a confirmed shared archive commit")
        let reloaded=AgendaStore();reloaded.load(folder:directory,qa:true)
        check(reloaded.events.first{$0.id==eventID}?.title=="Island event" && reloaded.events.first{$0.id==eventID}?.kind=="event","island creates a real event surviving independent disk reload")
        check(reloaded.operationReceipts.count==1 && changes==1,"event and stable operation receipt persist together with one real change callback")
        var main=sample("main-created",start.addingTimeInterval(3600));try agenda.save(main,expected:nil)
        check(quick.occurrences.contains{$0.event.id==main.id},"main App event changes project directly into the island without another calendar store")
        agenda.updateTasks([ContentRecord(id:"task",title:"Deadline task",workspace:"科研",projectId:"project",kind:"task",status:"todo",start:nil,due:start.timeIntervalSince1970*1000,completed:nil)])
        let task=quick.occurrences.first{$0.taskID=="task"}!
        check(!quick.beginEditing(task) && task.event.kind=="task" && agenda.events.count==2,"task deadline remains a projection and cannot be edited as a real event")
        check(await quick.openTask(task) && openedTasks==["task"],"task occurrence opens the same main task ID")
        let original=quick.occurrences.first{$0.event.id==main.id}!
        check(quick.beginEditing(original),"existing event editor captures displayed baseline")
        quick.updateDraft{$0.title="Island unsaved title"}
        main.title="Newer main edit";try agenda.save(main,expected:original.event)
        check(!quick.saveEditor() && quick.editing?.event.title=="Island unsaved title" && agenda.events.first{$0.id==main.id}?.title==main.title,"concurrent edit rejects overwrite and keeps the island input")
        check(quick.reloadEditor() && quick.editing?.baseline==main && !quick.hasUnsavedEditorDraft,"explicit reload adopts current baseline without automatically replacing dirty input")
        quick.updateDraft{$0.title="Confirmed edit";$0.location="Room 2";$0.reminderMinutes=5}
        check(quick.saveEditor(),"fresh baseline can save the same event ID")
        let editedReload=AgendaStore();editedReload.load(folder:directory,qa:true)
        check(editedReload.events.first{$0.id==main.id}?.location=="Room 2" && editedReload.events.count==2,"editing updates the original record and preserves independent event identity")
        let current=agenda.events.first{$0.id==main.id}!,once=quick.occurrences.first{$0.event.id==main.id}!
        check(quick.beginEditing(once),"privacy test starts from a real public occurrence")
        quick.updateDraft{$0.details="Retained draft body"}
        context.privateMode=true;quick.refreshContext()
        check(quick.occurrences.isEmpty && !quick.canDisplayEditor && !quick.saveEditor() && quick.editing?.event.details=="Retained draft body","global private mode hides list and editor without discarding input")
        context.privateMode=false;context.projects=[];quick.refreshContext()
        check(quick.occurrences.isEmpty && !quick.canDisplayEditor && !quick.saveEditor(),"removed or private project cannot leak list rows or relabel an existing editor")
        context.projects=[AgendaEditingProject(id:"project",title:"Public project")];context.documents=[]
        check(!quick.occurrences.contains{$0.event.id==eventID},"unavailable linked source hides its event even when the project is public")
        context.documents=[AgendaEditingDocument(id:"note",title:"Public source",projectID:"project",kind:"note")]
        var hidden=current;hidden.projectID="unavailable-project";try agenda.save(hidden,expected:current)
        check(!quick.canDisplayEditor && quick.editing?.event.details=="Retained draft body","a newer private event owner hides an old public editor body")
        check(quick.discardEditor() && !agenda.hasUnsavedEditorDrafts,"explicit discard clears only the island's dirty session")
        context.projects.append(AgendaEditingProject(id:"project",title:"Duplicate owner"))
        check(quick.projects.isEmpty && quick.occurrences.isEmpty,"ambiguous public project identity is not a valid owner")
        context.projects=[AgendaEditingProject(id:"project",title:"Public project")]
        let valid=sample("scope",start),scope=context.scope
        var crossing=valid;crossing.documentID="note";crossing.projectID="other"
        do{try scope.validate(crossing,expected:nil);fatalError("cross-project source accepted")}catch{}
        check(!scope.canAccess(crossing),"shared editor rules refuse unavailable and cross-project source ownership")
        var allDay=valid;AgendaEditorFields.allDay(&allDay,enabled:true)
        check(allDay.start==Calendar.current.startOfDay(for:valid.start) && Calendar.current.dateComponents([.day],from:allDay.start,to:allDay.end).day==1,"shared all-day helper retains exclusive next-day end")
        allDay.count=4;AgendaEditorFields.repeatUntil(&allDay,date:day)
        check(allDay.count==nil && allDay.until==Calendar.current.date(byAdding:.day,value:1,to:day)!.addingTimeInterval(-1),"shared repeat end helper preserves end-of-day rule and clears count explicitly")
        var series=sample("series",start);series.frequency="weekly";series.count=3;series.weekdays=[Calendar.current.component(.weekday,from:start)]
        try agenda.save(series,expected:nil);quick.upcoming=true
        check(quick.occurrences.filter{$0.event.id==series.id}.count==1,"upcoming query uses the real recurrence engine within the selected seven days")
        quick.changeDay(7)
        check(quick.occurrences.contains{$0.event.id==series.id && $0.start != series.start},"next range projects subsequent occurrences with the same series ID")
        quick.openAgenda();check(openedDays==[quick.date],"main agenda opening retains selected day")
        // Stable receipts survive ordinary main saves, preference writes and sync.
        let request="operation-once",created=sample("idempotent",start)
        let receipt=try agenda.commit(created,expected:nil,requestID:request)
        var newer=created;newer.title="Human edit after commit";try agenda.save(newer,expected:created)
        let replay=try agenda.commit(created,expected:nil,requestID:request)
        check(receipt==replay && agenda.events.first{$0.id==created.id}==newer,"lost-ACK replay acknowledges its original operation without overwriting a later human edit")
        var collision=created;collision.title="Different request"
        do{_ = try agenda.commit(collision,expected:nil,requestID:request);fatalError("receipt collision accepted")}catch{}
        check(agenda.events.first{$0.id==created.id}==newer,"changed parameters under one request cannot overwrite the stored event")
        let restart=AgendaStore();restart.load(folder:directory,qa:true)
        let restartedReceipt=try restart.commit(created,expected:nil,requestID:request)
        check(restartedReceipt==receipt && restart.events.first{$0.id==created.id}==newer,"receipt is durable across independent store restart")
        var preferences=agenda.preferences;preferences.taskReminderMinutes=30;try agenda.updatePreferences(preferences)
        try agenda.acknowledgeSync([])
        let afterSync=AgendaStore();afterSync.load(folder:directory,qa:true)
        check(afterSync.operationReceipts[request]==receipt,"main preferences and sync saves preserve operation metadata")
        // A failed archive commit leaves both published state and draft unchanged.
        let failedDir=try folder("failure"),failed=AgendaStore();failed.load(folder:failedDir,qa:true)
        let failedQuick=NativeQuickAgendaStore();failedQuick.configure(agenda:failed,context:{context},openTask:{_ in false},openAgenda:{_ in})
        check(failedQuick.beginNew(),"failed-save test has a real isolated editor")
        failedQuick.updateDraft{$0.title="Uncommitted input"}
        try FileManager.default.createDirectory(at:failedDir.appendingPathComponent("agenda.json"),withIntermediateDirectories:true)
        check(!failedQuick.saveEditor() && failedQuick.savedEventID==nil && failedQuick.editing?.event.title=="Uncommitted input" && failed.events.isEmpty && failed.operationReceipts.isEmpty,"disk failure preserves input and never publishes saved event or receipt")
        let another=try folder("replacement");failed.load(folder:another,qa:true)
        check(!failedQuick.canDisplayEditor && !failedQuick.saveEditor() && failedQuick.hasUnsavedEditorDraft,"reloading the same store with another archive cannot move an old draft into a new workspace")
        let corrupt=try folder("corrupt");try Data("broken".utf8).write(to:corrupt.appendingPathComponent("agenda.json"));failed.load(folder:corrupt,qa:true)
        check(!failed.storageReady,"a failed load cannot retain a previous archive's ready permission")
        // Existing archives with no operations field continue to decode.
        let legacyDir=try folder("legacy"),legacyEvent=sample("legacy",start)
        let legacyData=try JSONEncoder().encode(AgendaArchive(events:[legacyEvent],preferences:AgendaPreferences(),sync:nil))
        try legacyData.write(to:legacyDir.appendingPathComponent("agenda.json"));let legacy=AgendaStore();legacy.load(folder:legacyDir,qa:true)
        check(legacy.storageReady && legacy.events==[legacyEvent] && legacy.operationReceipts.isEmpty,"old archive decodes without a new operation ledger")
        afterSync.load(folder:corrupt,qa:true)
        var rejectedReplay=false
        do{_ = try afterSync.commit(created,expected:nil,requestID:request)}catch{rejectedReplay=true}
        check(rejectedReplay && !afterSync.storageReady && afterSync.storageIdentity==nil,"failed archive rebind cannot acknowledge a cached receipt from the old owner")
        let empty=try folder("rebind-empty"),oldIdentity=agenda.storageIdentity
        agenda.load(folder:empty,qa:true)
        check(agenda.storageReady && agenda.storageIdentity != oldIdentity && agenda.events.isEmpty && agenda.syncReceipts.isEmpty && agenda.operationReceipts.isEmpty && agenda.occurrences(from:day,to:day.addingTimeInterval(7*86400)).isEmpty,"rebinding to an empty directory never grants old events, task projections or receipts a new owner")
        print("\(checks) quick agenda checks passed")
    }
}
