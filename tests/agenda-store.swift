import Foundation
struct ContentRecord {let id:String;let title:String;let workspace:String;let projectId:String;let kind:String;let status:String;let start:Double?;let due:Double?;let completed:Double?;var dueDay:String?=nil}
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
  try store.restore(remind);check(!store.plannedNotifications(now:now.addingTimeInterval(3500)).contains{$0.2=="Reminder"},"past trigger never fires unexpectedly on reopen")
  preferences.taskReminderMinutes=15;try store.updatePreferences(preferences)
  check(store.plannedNotifications(now:now).contains{$0.2=="Date only" && $0.1==dated.start.addingTimeInterval(-900)},"task reminder preference participates in scheduling")
  preferences.briefingHour=99;do{try store.updatePreferences(preferences);fatalError("invalid time accepted")}catch{};check(store.preferences.briefingHour != 99,"invalid notification preferences never persist")
  let corrupt=folder.appendingPathComponent("corrupt");try FileManager.default.createDirectory(at:corrupt,withIntermediateDirectories:true);try Data("broken".utf8).write(to:corrupt.appendingPathComponent("agenda.json"));let bad=AgendaStore();bad.load(folder:corrupt,qa:true);do{try bad.save(event);fatalError("corrupt store overwritten")}catch{};check(try String(contentsOf:corrupt.appendingPathComponent("agenda.json"),encoding:.utf8)=="broken","corrupt store is not overwritten")
  print("\(count) agenda store checks passed")
 }
}
