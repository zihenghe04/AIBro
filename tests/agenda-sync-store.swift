import Foundation
struct ContentRecord {let id:String;let title:String;let status:String;let due:Double?;let dueDay:String?;let projectId:String;var updated:Double?=nil;var reminderMinutes:Int?=nil;var reminderDisabled:Bool?=nil}
@main struct AgendaSyncStoreTests {
 @MainActor static func main() throws {
  let folder=FileManager.default.temporaryDirectory.appendingPathComponent("aibro-agenda-store-"+UUID().uuidString)
  try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true)
  defer{try? FileManager.default.removeItem(at:folder)}
  var e=AgendaEvent();e.id="fixture";e.title="Persisted";e.start=Date(timeIntervalSince1970:1789500000);e.end=e.start.addingTimeInterval(3600);e.timeZone="Asia/Shanghai"
  let store=AgendaStore();store.load(folder:folder,qa:true);try store.save(e)
  let first=AgendaWire.plan(events:store.events,receipts:store.syncReceipts,notes:[:])
  try store.acknowledgeSync(first.changes)
  let reopened=AgendaStore();reopened.load(folder:folder,qa:true)
  precondition(reopened.events==[e] && reopened.syncReceipts.count==1,"baseline and native events reopen together")
  let id=AgendaWire.noteID(e),base=reopened.syncReceipts[id]!
  var remote=e;remote.title="Phone edit"
  let note=try AgendaWire.encode(remote,noteID:id,previous:base.note)
  let plan=AgendaWire.plan(events:reopened.events,receipts:reopened.syncReceipts,notes:[id:note])
  var newer=e;newer.location="Edited during sync";try reopened.save(newer)
  try reopened.acknowledgeSync(plan.changes)
  precondition(reopened.events==[newer] && reopened.syncReceipts[id]!.event==e,"pull never overwrites edit made while awaiting cloud")
  let conflict=AgendaWire.plan(events:reopened.events,receipts:reopened.syncReceipts,notes:[id:note]).conflicts[0]
  try reopened.resolveSync(conflict,useRemote:true)
  let resolution=AgendaWire.plan(events:reopened.events,receipts:reopened.syncReceipts,notes:[id:note])
  try reopened.acknowledgeSync(resolution.changes)
  precondition(reopened.events==[remote],"explicit remote conflict resolution")
  let path=folder.appendingPathComponent("agenda.json"),backup=folder.appendingPathComponent("last-good.json")
  try FileManager.default.moveItem(at:path,to:backup);try FileManager.default.createDirectory(at:path,withIntermediateDirectories:false)
  var broken=remote;broken.title="Should not publish"
  do{try reopened.save(broken);fatalError("write should fail")}catch{}
  precondition(reopened.events==[remote],"failed write keeps in-memory state")
  let persisted=try JSONDecoder().decode(AgendaArchive.self,from:Data(contentsOf:backup))
  precondition(persisted.events==[remote],"last durable snapshot retained")
  print("PASS native agenda receipt persistence, concurrent-edit guard, conflict resolution and failed-save rollback")
 }
}
