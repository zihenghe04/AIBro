import Foundation

struct AgendaEvent: Codable, Identifiable, Equatable {
    var id = UUID().uuidString
    var title = ""
    var kind = "event"
    var start = Date()
    var end = Date().addingTimeInterval(3600)
    var allDay = false
    var timeZone = TimeZone.current.identifier
    var location = ""
    var details = ""
    var projectID = ""
    var documentID = ""
    var documentKind = "note"
    var frequency = "none"
    var interval = 1
    var weekdays: [Int] = [] // Calendar weekday: Sunday = 1
    var until: Date? = nil
    var count: Int? = nil
    var excluded: [Date] = []
    var completed: [Date] = []
    var reminderMinutes: Int? = 15
    var source = ""
    var deleted = false
    func calendar() -> Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: timeZone) ?? .current; c.firstWeekday = 2; return c }
    func validate() throws {
        guard !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, end > start, TimeZone(identifier: timeZone) != nil,
              ["none","daily","weekly","monthly"].contains(frequency), (1...52).contains(interval), weekdays.allSatisfy({(1...7).contains($0)}),
              count == nil || count! > 0, until == nil || until! >= start,
              reminderMinutes == nil || (0...10080).contains(reminderMinutes!) else { throw AgendaError.message("请检查标题、起止时间、时区和重复规则。") }
    }
}
struct AgendaOccurrence: Identifiable {
    var event: AgendaEvent
    var start: Date
    var end: Date
    var taskID: String? = nil
    var id: String { event.id + "@" + String(Int(start.timeIntervalSince1970)) }
    var isDone: Bool { event.completed.contains(start) }
}
enum AgendaError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let s) = self { return s }; return nil }
}
enum AgendaEngine {
    static func occurrences(_ event: AgendaEvent, from: Date, to: Date) -> [AgendaOccurrence] {
        guard !event.deleted, to > from, (try? event.validate()) != nil else { return [] }
        let cal = event.calendar(), duration = event.end.timeIntervalSince(event.start)
        let base = cal.startOfDay(for: event.start)
        let stop = min(to, event.until ?? to)
        let days = max(0, cal.dateComponents([.day], from: base, to: stop).day ?? 0)
        var result: [AgendaOccurrence] = [], total = 0
        if event.frequency == "none" {
            if event.start < to && event.end > from && !event.excluded.contains(event.start) { result.append(.init(event:event,start:event.start,end:event.end)) }; return result
        }
        // Iterate calendar days, not 86400-second steps: repeated local times survive DST.
        for offset in 0...days {
            guard let day = cal.date(byAdding:.day,value:offset,to:base) else {continue}
            var matches = false
            switch event.frequency {
            case "daily": matches = offset % event.interval == 0
            case "weekly":
                let week = cal.dateInterval(of:.weekOfYear,for:day)!.start
                let first = cal.dateInterval(of:.weekOfYear,for:base)!.start
                let weeks = (cal.dateComponents([.day],from:first,to:week).day ?? 0) / 7
                matches = weeks % event.interval == 0 && (event.weekdays.isEmpty ? [cal.component(.weekday,from:base)] : event.weekdays).contains(cal.component(.weekday,from:day))
            case "monthly":
                let months = (cal.component(.year,from:day)-cal.component(.year,from:base))*12 + cal.component(.month,from:day)-cal.component(.month,from:base)
                matches = months % event.interval == 0 && cal.component(.day,from:day) == cal.component(.day,from:base)
            default: break
            }
            if !matches {continue}
            let t = cal.dateComponents([.hour,.minute,.second],from:event.start)
            guard let start = cal.date(bySettingHour:t.hour ?? 0,minute:t.minute ?? 0,second:t.second ?? 0,of:day), start >= event.start else {continue}
            if start > stop {break}; total += 1
            if let count = event.count, total > count {break}
            let end: Date
            if event.allDay { end = cal.date(byAdding:.day,value:max(1,cal.dateComponents([.day],from:event.start,to:event.end).day ?? 1),to:start)! }
            else { end = start.addingTimeInterval(duration) }
            if start < to && end > from && !event.excluded.contains(start) {result.append(.init(event:event,start:start,end:end))}
        }
        return result
    }
}
struct AgendaImportResult { var events: [AgendaEvent] = []; var warnings: [String] = [] }
/// Deliberately explicit supported iCalendar subset. Unsupported recurrence is
/// rejected per event rather than silently converted to a single appointment.
enum AgendaImport {
    static func ics(_ text: String, fallbackZone: String = TimeZone.current.identifier) -> AgendaImportResult {
        var result = AgendaImportResult(), lines: [String] = []
        for line in text.replacingOccurrences(of:"\r\n",with:"\n").split(separator:"\n",omittingEmptySubsequences:false).map(String.init) {
            if (line.hasPrefix(" ") || line.hasPrefix("\t")), !lines.isEmpty { lines[lines.count-1] += line.dropFirst() } else {lines.append(line)}
        }
        let isTimetable = lines.contains { $0.uppercased().hasPrefix("PRODID:") && $0.localizedCaseInsensitiveContains("WakeUpSchedule") }
        var block: [String] = [], inside = false
        for line in lines {
            if line == "BEGIN:VEVENT" {inside = true;block=[]}
            else if line == "END:VEVENT", inside {
                do { var event = try parseEvent(block, fallbackZone:fallbackZone); if isTimetable {event.kind="course";event.source="WakeUp 课表"}; result.events.append(event) }
                catch {result.warnings.append(error.localizedDescription)}
                inside = false
            } else if inside {block.append(line)}
        }
        if inside {result.warnings.append("有未闭合的 VEVENT，未导入该条目。")}
        if result.events.isEmpty && result.warnings.isEmpty {result.warnings.append("没有找到可导入的 VEVENT 日程。")}
        return result
    }
    private static func parseEvent(_ lines:[String],fallbackZone:String) throws -> AgendaEvent {
        var props:[String:[(String,String)]] = [:], alarm = false
        for line in lines {
            if line == "BEGIN:VALARM" {alarm=true;continue};if line == "END:VALARM" {alarm=false;continue}
            if alarm {continue}
            guard let colon=line.firstIndex(of:":") else {continue}
            let header=String(line[..<colon]), value=String(line[line.index(after:colon)...]), name=String(header.split(separator:";")[0]).uppercased()
            props[name,default:[]].append((header,value))
        }
        func value(_ key:String)->String {props[key]?.first?.1 ?? ""}
        let title=unescape(value("SUMMARY"))
        func fail(_ why:String)->AgendaError {.message("\(title.isEmpty ? "未命名日程":title)：\(why)")}
        if ["RECURRENCE-ID","RDATE","EXRULE","DURATION"].contains(where:{props[$0] != nil}) {throw fail("含暂不支持的例外日期/时长规则，请先在原日历中导出具体日程。")}
        if value("STATUS") == "CANCELLED" {throw fail("已取消，未导入；已有日程请手动核对。")}
        guard let startProp=props["DTSTART"]?.first else {throw fail("缺少开始时间")}
        let parsed=try date(startProp.0,startProp.1,fallbackZone:fallbackZone)
        var event=AgendaEvent();event.title=title;event.start=parsed.0;event.timeZone=parsed.1;event.allDay=parsed.2;event.reminderMinutes=nil
        event.kind="meeting";event.location=unescape(value("LOCATION"));event.details=unescape(value("DESCRIPTION"));event.source="iCalendar"
        let uid=value("UID");if !uid.isEmpty {event.id="ics:"+uid}
        if let p=props["DTEND"]?.first {event.end=try date(p.0,p.1,fallbackZone:parsed.1).0}
        else {event.end=parsed.2 ? event.calendar().date(byAdding:.day,value:1,to:event.start)! : event.start.addingTimeInterval(3600)}
        if let rule=props["RRULE"]?.first?.1 {
            guard props["RRULE"]?.count == 1 else {throw fail("存在多条重复规则")}
            var fields:[String:String]=[:]
            for part in rule.split(separator:";") {let pair=part.split(separator:"=",maxSplits:1).map(String.init);guard pair.count==2,fields[pair[0]]==nil else {throw fail("重复规则无效")};fields[pair[0]]=pair[1]}
            guard Set(fields.keys).isSubset(of:["FREQ","INTERVAL","BYDAY","UNTIL","COUNT","WKST"]), fields["WKST"]==nil || fields["WKST"]=="MO", ["DAILY","WEEKLY","MONTHLY"].contains(fields["FREQ"] ?? "") else {throw fail("重复规则超出支持范围，未做降级导入")}
            event.frequency=fields["FREQ"]!.lowercased()
            if let v=fields["INTERVAL"] {guard let n=Int(v) else {throw fail("重复间隔无效")};event.interval=n}
            if let v=fields["COUNT"] {guard let n=Int(v) else {throw fail("重复次数无效")};event.count=n}
            if fields["UNTIL"] != nil && fields["COUNT"] != nil {throw fail("UNTIL 与 COUNT 不能同时存在")}
            if let v=fields["UNTIL"] {event.until=try date("UNTIL",v,fallbackZone:parsed.1).0;if v.count==8 {event.until=event.calendar().date(byAdding:.day,value:1,to:event.until!)!.addingTimeInterval(-1)}}
            if let v=fields["BYDAY"] {
                let names=["SU":1,"MO":2,"TU":3,"WE":4,"TH":5,"FR":6,"SA":7], values=v.split(separator:",").map(String.init)
                guard event.frequency=="weekly",values.allSatisfy({names[$0] != nil}) else {throw fail("仅支持每周的 BYDAY 规则")}
                event.weekdays=values.compactMap{names[$0]}
            }
        }
        for p in props["EXDATE"] ?? [] {for v in p.1.split(separator:",") {event.excluded.append(try date(p.0,String(v),fallbackZone:parsed.1).0)}}
        try event.validate();return event
    }
    static func date(_ header:String,_ text:String,fallbackZone:String) throws -> (Date,String,Bool) {
        let utc=text.hasSuffix("Z"), allDay=text.count==8
        var zone=utc ? "UTC":fallbackZone
        for part in header.split(separator:";").dropFirst() {if part.hasPrefix("TZID=") {zone=String(part.dropFirst(5)).trimmingCharacters(in:CharacterSet(charactersIn:"\""))}}
        guard let tz=TimeZone(identifier:zone) else {throw AgendaError.message("不支持时区 \(zone)，未猜测时间。")}
        let f=DateFormatter();f.locale=Locale(identifier:"en_US_POSIX");f.calendar=Calendar(identifier:.gregorian);f.timeZone=tz;f.isLenient=false;f.dateFormat=allDay ? "yyyyMMdd":utc ? "yyyyMMdd'T'HHmmss'Z'":"yyyyMMdd'T'HHmmss"
        guard let d=f.date(from:text), f.string(from:d)==text else {throw AgendaError.message("日历日期无效：\(text)")};return (d,zone,allDay)
    }
    static func unescape(_ s:String)->String {s.replacingOccurrences(of:"\\n",with:"\n").replacingOccurrences(of:"\\N",with:"\n").replacingOccurrences(of:"\\,",with:",").replacingOccurrences(of:"\\;",with:";").replacingOccurrences(of:"\\\\",with:"\\")}
    // Course CSV uses explicit clock times; period-based schedules can be mapped
    // in the editor. Each row is one teaching slot, repeated in chosen weeks.
    static func courses(_ text:String, semester:Date, zone:String) -> AgendaImportResult {
        var result=AgendaImportResult();var cal=Calendar(identifier:.gregorian);cal.timeZone=TimeZone(identifier:zone) ?? .current
        guard TimeZone(identifier:zone) != nil,let base=cal.date(from:Calendar.current.dateComponents([.year,.month,.day],from:semester)),cal.component(.weekday,from:base)==2 else {return .init(warnings:["学期必须从第一周周一开始，且时区有效。"])}
        let rows=csv(text)
        guard rows.count>1 else {return .init(warnings:["请使用课程 CSV 模板，至少填写一行。"])}
        for (offset,row) in rows.dropFirst().enumerated() {
            do {
                guard row.count>=8,let weekday=Int(row[1]),(1...7).contains(weekday),let first=Int(row[4]),let last=Int(row[5]),first>=1,last>=first,last<=60,["全部","单周","双周"].contains(row[6]) else {throw AgendaError.message("星期/周次/单双周无效")}
                func clock(_ s:String)->(Int,Int)? {let p=s.split(separator:":");guard p.count==2,let h=Int(p[0]),let m=Int(p[1]),(0...23).contains(h),(0...59).contains(m) else{return nil};return(h,m)}
                guard let a=clock(row[2]),let b=clock(row[3]),a.0*60+a.1 < b.0*60+b.1 else {throw AgendaError.message("起止时间无效，使用 HH:mm")}
                for week in first...last where row[6]=="全部" || (row[6]=="单周" ? week%2==1:week%2==0) {
                    let day=cal.date(byAdding:.day,value:(week-1)*7+weekday-1,to:base)!
                    var e=AgendaEvent();e.title=row[0];e.kind="course";e.start=cal.date(bySettingHour:a.0,minute:a.1,second:0,of:day)!;e.end=cal.date(bySettingHour:b.0,minute:b.1,second:0,of:day)!;e.timeZone=zone;e.location=row[7];e.source="课表 CSV · 第 \(week) 周";e.details="第 \(week) 周 · \(row[6])";e.reminderMinutes=15
                    e.id="course:"+row.prefix(8).joined(separator:"|")+"@"+String(Int(e.start.timeIntervalSince1970));try e.validate();result.events.append(e)
                }
            } catch {result.warnings.append("第 \(offset+2) 行：\(error.localizedDescription)")}
        }
        return result
    }
    static func csv(_ text:String)->[[String]] {
        var rows:[[String]]=[],row:[String]=[],field="",quoted=false;let chars=Array(text.replacingOccurrences(of:"\r\n",with:"\n"));var i=0
        while i<chars.count {let c=chars[i];if c=="\"" {if quoted && i+1<chars.count && chars[i+1]=="\"" {field.append(c);i+=1}else{quoted.toggle()}}else if c=="," && !quoted {row.append(field);field=""}else if c=="\n" && !quoted {row.append(field);if row.contains(where:{!$0.isEmpty}){rows.append(row)};row=[];field=""}else{field.append(c)};i+=1}
        row.append(field);if row.contains(where:{!$0.isEmpty}){rows.append(row)};return rows
    }
    static let courseTemplate="课程名称,星期(1为周一),开始时间,结束时间,开始周,结束周,全部/单周/双周,地点\n线性代数,1,08:30,10:00,1,16,全部,教学楼 A201\n"
}
