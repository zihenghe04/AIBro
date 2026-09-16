import Foundation
@main struct AgendaSyncTests {
 static func main() throws {
  var checks=0
  func check(_ pass:Bool,_ name:String){precondition(pass,name);checks+=1}
  func date(_ text:String,_ zone:String="Asia/Shanghai")throws->Date {try AgendaImport.date("",text,fallbackZone:zone).0}
  var e=AgendaEvent();e.id="ics:original uid / with unsafe chars";e.title="每周课程";e.timeZone="Asia/Shanghai";e.start=try date("20260914T083000");e.end=try date("20260914T100000");e.frequency="weekly";e.weekdays=[2,4];e.count=4;e.projectID="project-1"
  let id=AgendaWire.noteID(e)
  check(id.range(of:"^[a-zA-Z0-9_-]+$",options:.regularExpression) != nil,"wire identifier safe")
  let encoded=try AgendaWire.encode(e,noteID:id,previous:nil,now:1)
  check(try AgendaWire.decode(encoded,id:e.id)==e,"round trip every native field")
  let created=AgendaWire.plan(events:[e],receipts:[:],notes:[:]);check(created.changes.count==1 && created.conflicts.isEmpty,"new local push")
  let receipt=AgendaSyncReceipt(event:e,note:encoded)
  check(AgendaWire.plan(events:[e],receipts:[id:receipt],notes:[id:encoded]).changes.isEmpty,"acknowledged state converges")
  var remote=e;remote.title="手机改标题"
  let remoteNote=try AgendaWire.encode(remote,noteID:id,previous:encoded,now:2)
  let pull=AgendaWire.plan(events:[e],receipts:[id:receipt],notes:[id:remoteNote]);check(pull.changes.first?.after.title==remote.title && pull.changes.first?.writeNote==nil,"remote edit pulls")
  var local=e;local.location="Mac 改地点"
  let push=AgendaWire.plan(events:[local],receipts:[id:receipt],notes:[id:encoded]);check(push.changes.first?.writeNote != nil,"local edit pushes")
  let conflict=AgendaWire.plan(events:[local],receipts:[id:receipt],notes:[id:remoteNote]);check(conflict.conflicts.count==1 && conflict.changes.isEmpty,"two-sided edits never overwrite")
  let remove=AgendaWire.plan(events:[e],receipts:[id:receipt],notes:[:]);check(remove.changes.first?.after.deleted==true,"missing synced note cancels native event")
  let deleted=remove.changes[0].after
  let restore=AgendaWire.plan(events:[e],receipts:[id:.init(event:deleted,note:nil)],notes:[:]);check(restore.changes.first?.writeNote != nil,"restore recreates note after deletion")
  let phone=AgendaWire.plan(events:[],receipts:[:],notes:[id:encoded]);check(phone.changes.first?.after.id=="mobile:"+id,"new phone event retains wire identity")
  check(AgendaWire.noteID(phone.changes[0].after)==id,"phone round trip cannot duplicate")
  let invalid=AgendaWire.plan(events:[e],receipts:[id:receipt],notes:[id:"{}"]);check(invalid.warnings.count==1 && invalid.changes.isEmpty,"invalid remote preserves existing event")
  // A crash after remote write but before baseline persistence converges without duplication.
  let replay=AgendaWire.plan(events:[e],receipts:[:],notes:[id:encoded]);check(replay.conflicts.isEmpty && replay.changes.count==1 && replay.changes[0].writeNote==nil,"lost acknowledgement replay")
  var fractional=e;fractional.start=fractional.start.addingTimeInterval(0.000321)
  let fractionalNote=try AgendaWire.encode(fractional,noteID:id,previous:nil)
  check(AgendaWire.plan(events:[fractional],receipts:[:],notes:[id:fractionalNote]).conflicts.isEmpty,"submillisecond dates do not cause false conflict")
  // Produce fixtures from the actual Swift recurrence engine for the mobile tests.
  var examples:[AgendaEvent]=[]
  e.excluded=[try date("20260916T083000")];e.completed=[e.start];examples.append(e)
  var monthly=e;monthly.id="month";monthly.frequency="monthly";monthly.count=3;monthly.weekdays=[];monthly.start=try date("20260131T090000");monthly.end=monthly.start.addingTimeInterval(3600);monthly.excluded=[];examples.append(monthly)
  var dst=e;dst.id="dst";dst.timeZone="America/New_York";dst.frequency="daily";dst.count=3;dst.excluded=[];dst.start=try date("20260307T090000","America/New_York");dst.end=dst.start.addingTimeInterval(3600);examples.append(dst)
  var gap=dst;gap.id="gap";gap.start=try date("20260307T023000","America/New_York");gap.end=gap.start.addingTimeInterval(3600);examples.append(gap)
  var all=dst;all.id="all";all.allDay=true;all.start=try date("20260307T000000","America/New_York");all.end=try date("20260308T000000","America/New_York");examples.append(all)
  var bi=e;bi.id="biweekly";bi.interval=2;bi.count=6;bi.excluded=[];examples.append(bi)
  let from=try date("20260101T000000","UTC"),to=try date("20261231T000000","UTC")
  let fixtures=try examples.map {item -> [String:Any] in
    ["note":try AgendaWire.object(AgendaWire.encode(item,noteID:AgendaWire.noteID(item),previous:nil)),"from":from.timeIntervalSince1970*1000,"to":to.timeIntervalSince1970*1000,"occurrences":AgendaEngine.occurrences(item,from:from,to:to).map{["start":$0.start.timeIntervalSince1970*1000,"end":$0.end.timeIntervalSince1970*1000]}]
  }
  if CommandLine.arguments.count>1 {try JSONSerialization.data(withJSONObject:fixtures,options:[.sortedKeys]).write(to:URL(fileURLWithPath:CommandLine.arguments[1]))}
  print("PASS \(checks) agenda bridge checks; \(fixtures.count) native recurrence fixtures")
 }
}
