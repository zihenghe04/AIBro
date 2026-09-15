import Foundation
@main struct AgendaTests {
 static func main() throws {
  func d(_ value:String,_ zone:String="Asia/Shanghai")throws->Date {try AgendaImport.date("",value,fallbackZone:zone).0}
  var checks=0
  func check(_ value:Bool,_ label:String){precondition(value,label);checks+=1;print("PASS",label)}
  var e=AgendaEvent();e.title="Weekly class";e.start=try d("20260914T083000");e.end=try d("20260914T100000");e.frequency="weekly";e.weekdays=[2,4];e.count=4;e.timeZone="Asia/Shanghai"
  let rangeStart=try d("20260901T000000"),rangeEnd=try d("20261001T000000")
  let list=AgendaEngine.occurrences(e,from:rangeStart,to:rangeEnd)
  check(list.count==4,"weekly count and BYDAY")
  e.excluded=[list[1].start];check(AgendaEngine.occurrences(e,from:rangeStart,to:rangeEnd).count==3,"excluded occurrence still consumes COUNT")
  check(AgendaEngine.occurrences(e,from:try d("20260922T000000"),to:rangeEnd).count==1,"late range retains original count")
  e.frequency="monthly";e.count=nil;e.weekdays=[];e.start=try d("20260131T090000");e.end=e.start.addingTimeInterval(3600);e.excluded=[]
  check(AgendaEngine.occurrences(e,from:try d("20260101T000000"),to:try d("20260401T000000")).count==2,"monthly skips nonexistent February day")
  e.frequency="daily";e.start=try d("20260307T090000","America/New_York");e.end=e.start.addingTimeInterval(3600);e.timeZone="America/New_York";e.count=3
  let dst=AgendaEngine.occurrences(e,from:e.start,to:e.start.addingTimeInterval(4*86400))
  check(dst.count==3 && dst.allSatisfy{e.calendar().component(.hour,from:$0.start)==9} && dst[1].start.timeIntervalSince(dst[0].start)==23*3600,"DST preserves local clock time")
  let source="BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:meeting-1\r\nSUMMARY:Project\\, Review\r\nDTSTART;TZID=Asia/Shanghai:20260914T090000\r\nDTEND;TZID=Asia/Shanghai:20260914T100000\r\nRRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3\r\nEXDATE;TZID=Asia/Shanghai:20260921T090000\r\nDESCRIPTION:one\\n\r\n two\r\nEND:VEVENT\r\nEND:VCALENDAR"
  let imported=AgendaImport.ics(source)
  check(imported.events.count==1 && imported.warnings.isEmpty,"ICS import")
  check(imported.events[0].title=="Project, Review" && imported.events[0].details=="one\ntwo","unfold and unescape")
  check(AgendaEngine.occurrences(imported.events[0],from:rangeStart,to:rangeEnd).count==2,"ICS exclusions")
  let unsupported=source.replacingOccurrences(of:"FREQ=WEEKLY;BYDAY=MO;COUNT=3",with:"FREQ=YEARLY")
  check(AgendaImport.ics(unsupported).events.isEmpty && AgendaImport.ics(unsupported).warnings.count==1,"unsupported recurrence never silently becomes one-time")
  check(AgendaImport.ics(source.replacingOccurrences(of:"Asia/Shanghai",with:"Unknown/City")).events.isEmpty,"unknown timezone rejects import")
  let allDay=AgendaImport.ics("BEGIN:VEVENT\nSUMMARY:Day\nDTSTART;VALUE=DATE:20260914\nEND:VEVENT")
  check(allDay.events.count==1 && allDay.events[0].allDay && allDay.events[0].end>allDay.events[0].start,"all-day exclusive end")
  let csv="课程名称,星期,开始,结束,开始周,结束周,单双周,地点\n\"Math, A\",1,08:30,10:00,1,4,单周,Room\nMath B,3,10:30,12:00,1,4,双周,Room\nBad,8,08:00,09:00,1,4,全部,Room"
  let courses=AgendaImport.courses(csv,semester:try d("20260914"),zone:"Asia/Shanghai")
  check(courses.events.count==4 && courses.warnings.count==1,"course parity and per-row errors")
  check(courses.events[0].title=="Math, A" && courses.events[1].start==d2("20260928T083000"),"CSV quoted field and semester weeks")
  check(courses.events.map(\.id)==AgendaImport.courses(csv,semester:try d("20260914"),zone:"Asia/Shanghai").events.map(\.id),"stable import IDs")
  let wakeup=source.replacingOccurrences(of:"BEGIN:VCALENDAR",with:"BEGIN:VCALENDAR\r\nPRODID:-//YZune//WakeUpSchedule//EN")
  check(AgendaImport.ics(wakeup).events.first?.kind=="course","WakeUp ICS recognized as courses")
  let encoded=try JSONEncoder().encode(courses.events);check(try JSONDecoder().decode([AgendaEvent].self,from:encoded)==courses.events,"event persistence roundtrip")
  print("\(checks) agenda core checks passed")
 }
 static func d2(_ s:String)->Date {try! AgendaImport.date("",s,fallbackZone:"Asia/Shanghai").0}
}
