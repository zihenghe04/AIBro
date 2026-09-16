import Foundation

@main struct OverviewTasksTests {
    static func main() throws {
        var calendar=Calendar(identifier:.gregorian)
        calendar.timeZone=TimeZone(identifier:"America/Los_Angeles")!
        let now=calendar.date(from:DateComponents(year:2026,month:9,day:16,hour:12))!
        func task(_ id:String,_ day:String?=nil,status:String="todo",priority:String="medium",start:Double?=nil,waiting:Bool=false,due:Double?=nil)->ContentRecord {
            ContentRecord(id:id,title:id,workspace:id.hasPrefix("research") ? "科研":"日常",projectId:"",kind:"task",status:status,start:start,due:due,completed:nil,dueDay:day,priority:priority,waitingOnDependencies:waiting)
        }
        let items=[task("late","2026-09-15"),task("today","2026-09-16"),task("timed-late",due:now.addingTimeInterval(-60).timeIntervalSince1970*1000),task("research-near","2026-09-17"),task("high","2026-09-28",priority:"high"),task("blocked","2026-09-17",status:"blocked"),task("waiting",priority:"high",waiting:true),task("not-started","2026-09-20",priority:"high",start:now.addingTimeInterval(86400).timeIntervalSince1970*1000),task("free"),task("done","2026-09-15",status:"done"),task("trash","2026-09-15",status:"deleted"),task("archived",status:"archived")]
        let summary=OverviewTaskSummary(tasks:items,now:now,calendar:calendar)
        assert(summary.pending.count==9)
        assert(Set(summary.overdue.map(\.id))==["late","timed-late"])
        assert(summary.today.map(\.id)==["today"],"Date-only due days must not shift to yesterday in western timezones")
        assert(Set(summary.unscheduled.map(\.id))==["waiting","free"])
        assert(summary.next.map(\.id)==["research-near","high","free"],"Exclude blocked, dependency-waiting and future-start tasks; imminent deadline before later high priority")
        assert(summary.space("科研").pending.count==1)
        assert(summary.deadline(task("invalid","2026-02-30"))==nil)
        let tomorrow=OverviewTaskSummary(tasks:items,now:calendar.date(byAdding:.day,value:1,to:now)!,calendar:calendar)
        assert(tomorrow.overdue.contains{$0.id=="today"},"Classification must update across midnight without workspace mutations")
        let noToday=OverviewTaskSummary(tasks:items.filter{$0.id != "today"},now:now,calendar:calendar)
        assert(noToday.today.isEmpty && !noToday.next.isEmpty)
        let legacy=Data("""
        {"id":"old","title":"old","workspace":"日常","projectId":"","kind":"task","status":"todo"}
        """.utf8)
        let decoded=try JSONDecoder().decode(ContentRecord.self,from:legacy)
        assert(decoded.priority==nil && decoded.waitingOnDependencies==nil)
        print("Overview task grouping, local dates, urgency, dependency readiness, rollover and legacy decoding passed")
    }
}
