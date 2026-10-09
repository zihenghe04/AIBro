import Foundation
struct ContentRecord {let id:String;let title:String;let workspace:String;let projectId:String;let kind:String;let status:String;let start:Double?;let due:Double?;let completed:Double?;var dueDay:String?=nil;var updated:Double?=nil;var reminderMinutes:Int?=nil;var reminderDisabled:Bool?=nil}
@main struct AgendaStoreTests {
 @MainActor static func main() throws {
  let folder=FileManager.default.temporaryDirectory.appendingPathComponent("agenda-test-"+UUID().uuidString);try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true);defer{try? FileManager.default.removeItem(at:folder)}
  var count=0;func check(_ ok:Bool,_ label:String){precondition(ok,label);count+=1;print("PASS",label)}
  let store=AgendaStore();store.load(folder:folder,qa:true)
  var event=AgendaEvent();event.title="Synthetic course";event.start=Date().addingTimeInterval(3600);event.end=event.start.addingTimeInterval(3600);event.frequency="weekly";event.count=3
  try store.save(event);let loaded=AgendaStore();loaded.load(folder:folder,qa:true);check(loaded.events==[event],"saved event survives independent reload")
  try store.importEvents([event],replace:false,projectID:"");check(store.events.count==1,"reimport deduplicates UID")
  var updated=event;updated.title="Updated course";try store.importEvents([updated],replace:true,projectID:"p");check(store.events.count==1 && store.events[0].title==updated.title && store.events[0].projectID=="p","replace is explicit and binds project")
  let before=store.events;var invalid=event;invalid.id="bad";invalid.title="";do{try store.importEvents([invalid],replace:false,projectID:"");fatalError("invalid accepted")}catch{};check(store.events==before,"invalid import leaves state unchanged")
  let range=Date().addingTimeInterval(30*86400);let first=store.occurrences(from:Date(),to:range).first!;try store.skip(first);check(store.occurrences(from:Date(),to:range).count==2,"skip only one occurrence")
  let second=store.occurrences(from:Date(),to:range).first!;let moved=second.start.addingTimeInterval(7200);try store.move(second,to:moved);check(store.occurrences(from:Date(),to:range).count==2 && store.occurrences(from:Date(),to:range).contains{$0.start==moved},"move occurrence keeps remaining series")
  let target=store.occurrences(from:Date(),to:range).first!;try store.toggleDone(target);check(store.occurrences(from:Date(),to:range).first!.isDone,"occurrence completion persists")
  try store.cancel(store.events[0]);check(store.events[0].deleted,"cancellation is recoverable")
  try store.restore(store.events[0]);check(!store.events[0].deleted,"cancelled event restores")
  var preferences=store.preferences;preferences.briefing=true;try store.updatePreferences(preferences);let reload=AgendaStore();reload.load(folder:folder,qa:true);check(reload.preferences.briefing,"reminder settings survive reload")
  store.updateTasks([ContentRecord(id:"t",title:"Due",workspace:"日常",projectId:"p",kind:"task",status:"todo",start:nil,due:Date().addingTimeInterval(1000).timeIntervalSince1970*1000,completed:nil)])
  check(store.occurrences(from:Date(),to:range).contains{$0.taskID=="t"},"existing task deadline appears")
  store.updateTasks([]);check(!store.occurrences(from:Date(),to:range).contains{$0.taskID=="t"},"deleted task disappears")
  let day=Calendar.current.startOfDay(for:Date().addingTimeInterval(86400))
  let f=DateFormatter();f.dateFormat="yyyy-MM-dd"
  store.updateTasks([ContentRecord(id:"day-task",title:"Date only",workspace:"日常",projectId:"p",kind:"task",status:"todo",start:nil,due:day.timeIntervalSince1970*1000,completed:nil,dueDay:f.string(from:day))])
  let dated=store.occurrences(from:day,to:day.addingTimeInterval(86400)).first{$0.taskID=="day-task"}!
  check(dated.event.allDay && Calendar.current.component(.hour,from:dated.start)==9,"date-only deadline uses local day and 09:00 reminder base")
  let now=Date();var remind=AgendaEvent();remind.id="notify";remind.title="Reminder";remind.start=now.addingTimeInterval(3600);remind.end=now.addingTimeInterval(7200);remind.reminderMinutes=15
  try store.save(remind)
  check(store.plannedNotifications(now:now).first{$0.0=="agenda-event-"+AgendaOccurrence(event:remind,start:remind.start,end:remind.end).id}?.1==remind.start.addingTimeInterval(-900),"advance reminder computes exact firing time")
  let reminder=store.occurrences(from:now,to:range).first{$0.event.id=="notify"}!
  try store.toggleDone(reminder);check(!store.plannedNotifications(now:now).contains{$0.2=="Reminder"},"completed occurrence has no pending reminder")
  try store.save(remind);try store.cancel(remind);check(!store.plannedNotifications(now:now).contains{$0.2=="Reminder"},"cancelled series has no reminder")
  try store.restore(store.events.first{$0.id==remind.id}!);check(!store.plannedNotifications(now:now.addingTimeInterval(3500)).contains{$0.2=="Reminder"},"past trigger never fires unexpectedly on reopen")
  preferences.taskReminderMinutes=15;try store.updatePreferences(preferences)
  check(store.plannedNotifications(now:now).contains{$0.2=="Date only" && $0.1==dated.start.addingTimeInterval(-900)},"task reminder preference participates in scheduling")
  var t=ContentRecord(id:"explicit",title:"Explicit",workspace:"日常",projectId:"",kind:"task",status:"todo",start:nil,due:now.addingTimeInterval(600).timeIntervalSince1970*1000,completed:nil)
  t.reminderMinutes=0;store.updateTasks([t]);check(store.plannedNotifications(now:now).contains{$0.2=="Explicit" && abs($0.1.timeIntervalSince(now)-600)<0.01},"explicit exact reminder overrides global advance")
  t.reminderDisabled=true;store.updateTasks([t]);check(!store.plannedNotifications(now:now).contains{$0.2=="Explicit"},"per task off overrides global preference")
  t.reminderDisabled=false;t.reminderMinutes=nil;t.updated=now.timeIntervalSince1970*1000;preferences.taskReminderMinutes=60;try store.updatePreferences(preferences);store.updateTasks([t]);check(store.plannedNotifications(now:now).contains{$0.2=="Explicit" && abs($0.1.timeIntervalSince(now)-600)<0.01},"new task inside advance window falls back to deadline")
  t.updated=now.addingTimeInterval(-7200).timeIntervalSince1970*1000;store.updateTasks([t]);check(!store.plannedNotifications(now:now).contains{$0.2=="Explicit"},"already elapsed advance reminder is not scheduled again")
  preferences.taskReminderMinutes=0;try store.updatePreferences(preferences);check(store.plannedNotifications(now:now).contains{$0.2=="Explicit"},"changing global preference rebuilds task reminders")
  preferences.briefingHour=99;do{try store.updatePreferences(preferences);fatalError("invalid time accepted")}catch{};check(store.preferences.briefingHour != 99,"invalid notification preferences never persist")
  let corrupt=folder.appendingPathComponent("corrupt");try FileManager.default.createDirectory(at:corrupt,withIntermediateDirectories:true);try Data("broken".utf8).write(to:corrupt.appendingPathComponent("agenda.json"));let bad=AgendaStore();bad.load(folder:corrupt,qa:true);do{try bad.save(event);fatalError("corrupt store overwritten")}catch{};check(try String(contentsOf:corrupt.appendingPathComponent("agenda.json"),encoding:.utf8)=="broken","corrupt store is not overwritten")
  var edited=AgendaEvent();edited.title="Editor baseline";try store.save(edited,expected:nil)
  let baseline=edited;edited.title="Latest synced version";try store.save(edited)
  var stale=baseline;stale.title="Unsaved editor text"
  do{try store.save(stale,expected:baseline);fatalError("stale editor overwrote synced version")}catch{}
  check(store.events.first{$0.id==edited.id}==edited && stale.title=="Unsaved editor text","stale edit rejected while caller draft and latest event survive")
  do{try store.save(stale,expected:nil);fatalError("new editor overwrote existing identity")}catch{}
  check(store.events.first{$0.id==edited.id}==edited,"new draft baseline cannot overwrite event created elsewhere")
  stale.title="Confirmed fresh edit";try store.save(stale,expected:edited)
  let confirmed=AgendaStore();confirmed.load(folder:folder,qa:true)
  check(confirmed.events.first{$0.id==stale.id}==stale,"fresh editor commit confirmed by independent disk reload")
  var failureDraft=AgendaEvent();failureDraft.title="Unsaved failure draft"
  do{try bad.save(failureDraft,expected:nil);fatalError("failed editor save accepted")}catch{}
  check(bad.events.isEmpty && failureDraft.title=="Unsaved failure draft","failed storage commit leaves store and editor draft intact")
  let firstSession=UUID(),secondSession=UUID();store.setEditorDraft(firstSession,dirty:false)
  check(!store.hasUnsavedEditorDrafts,"pristine editor does not block exit")
  store.setEditorDraft(firstSession,dirty:true);store.setEditorDraft(secondSession,dirty:true);store.endEditorDraft(firstSession)
  check(store.hasUnsavedEditorDrafts,"closing one editor does not clear another dirty session")
  store.setEditorDraft(secondSession,dirty:false)
  check(!store.hasUnsavedEditorDrafts,"reverting editor to its original values clears dirty exit gate")
  store.setEditorDraft(secondSession,dirty:true);store.endEditorDraft(secondSession)
  check(!store.hasUnsavedEditorDrafts,"confirmed save or explicit discard removes editor exit gate")
  var invalidDay=ContentRecord(id:"invalid-day",title:"Invalid calendar day",workspace:"日常",projectId:"p",kind:"task",status:"todo",start:nil,due:day.timeIntervalSince1970*1000,completed:nil,dueDay:"2026-02-30")
  store.updateTasks([invalidDay])
  check(!store.occurrences(from:day.addingTimeInterval(-86400),to:day.addingTimeInterval(172800)).contains{$0.taskID==invalidDay.id} && !store.plannedNotifications(now:now).contains{$0.2==invalidDay.title},"invalid calendar day never falls back to normalized timestamp or reminder")
  invalidDay.dueDay=f.string(from:day);invalidDay=ContentRecord(id:"day-only-without-millis",title:"Valid local day",workspace:"日常",projectId:"p",kind:"task",status:"todo",start:nil,due:nil,completed:nil,dueDay:invalidDay.dueDay)
  store.updateTasks([invalidDay])
  check(store.occurrences(from:day,to:Calendar.current.date(byAdding:.day,value:1,to:day)!).contains{$0.taskID==invalidDay.id && $0.event.allDay},"valid day-only record does not require a redundant parsed timestamp")
  let oldOccurrence=AgendaOccurrence(event:baseline,start:baseline.start,end:baseline.end)
  do{try store.skip(oldOccurrence);fatalError("stale skip accepted")}catch{}
  do{try store.toggleDone(oldOccurrence);fatalError("stale completion accepted")}catch{}
  do{try store.cancel(baseline);fatalError("stale cancel accepted")}catch{}
  do{try store.restore(baseline);fatalError("stale restore accepted")}catch{}
  do{try store.move(oldOccurrence,to:baseline.start.addingTimeInterval(3600));fatalError("stale move accepted")}catch{}
  check(store.events.first{$0.id==stale.id}==stale,"all stale detail actions reject without overwriting latest event")
  let emptyFolder=folder.appendingPathComponent("empty");try FileManager.default.createDirectory(at:emptyFolder,withIntermediateDirectories:true)
  let empty=AgendaStore();empty.load(folder:emptyFolder,qa:true)
  var removedSeries=baseline;removedSeries.frequency="weekly"
  let removedOccurrence=AgendaOccurrence(event:removedSeries,start:removedSeries.start,end:removedSeries.end)
  do{try empty.move(removedOccurrence,to:removedSeries.start.addingTimeInterval(3600));fatalError("removed series move accepted")}catch{}
  do{try empty.save(removedSeries,expected:removedSeries);fatalError("removed series editor resurrected event")}catch{}
  check(empty.events.isEmpty,"removed recurring event cannot crash movement or be resurrected by stale editor")
  var batchA=AgendaEvent();batchA.id="agenda_batch_a";batchA.title="Synthetic lecture A"
  var batchB=batchA;batchB.id="agenda_batch_b";batchB.title="Synthetic lecture B"
  let batchBefore=store.events
  var invalidBatch=batchB;invalidBatch.title=""
  do{try store.createProposals([batchA,invalidBatch]);fatalError("partial batch saved")}catch{}
  check(store.events==batchBefore,"invalid batch saves nothing")
  check(try store.createProposals([batchA,batchB])==[batchA.id,batchB.id],"batch creates all selected events")
  let batchReload=AgendaStore();batchReload.load(folder:folder,qa:true)
  check(batchReload.events.suffix(2)==[batchA,batchB],"batch persisted atomically and survives reload")
  var editedBatch=batchA;editedBatch.title="Human correction";try store.save(editedBatch)
  check(try store.createProposals([batchA,batchB]).isEmpty,"repeated confirmation creates no duplicates")
  check(store.events.first{$0.id==batchA.id}==editedBatch,"repeated proposal never overwrites human correction")
  try store.cancel(batchB)
  do{try store.createProposals([batchA,batchB]);fatalError("cancelled event recreated")}catch{}
  check(store.events.first{$0.id==batchB.id}?.deleted==true,"cancelled proposal is never resurrected")
  print("\(count) agenda store checks passed")
 }
}
