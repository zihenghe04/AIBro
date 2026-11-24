import Foundation

/// One row on the today page: a workspace task, an agenda event or an agenda to-do.
struct TodayItem:Identifiable {
    enum Source {case task,agenda}
    let source:Source
    let id:String
    let title:String
    let at:Date
    var end:Date? = nil
    var dayOnly=false
    var allDay=false
    var location=""
    var priority="medium"
    /// Events only: allDay, past, now, next or later.
    var state=""
    /// Due today and its time has passed.
    var late=false
    var task:ContentRecord? = nil
    var occurrence:AgendaOccurrence? = nil
}

/// What today holds, grouped with the rules of app/today-digest.js: today's
/// events, deadlines falling today, yesterday's unfinished and older overdue.
/// Pure; the page passes agenda occurrences and the workspace tasks.
struct TodayDigest {
    static let limit=12
    let now:Date
    let events:[TodayItem]
    let due:[TodayItem]
    let carryover:[TodayItem]
    let overdue:[TodayItem]
    var empty:Bool {events.isEmpty && due.isEmpty && carryover.isEmpty && overdue.isEmpty}
    var late:Int {due.filter(\.late).count}

    /// The window of agenda occurrences the digest needs: two weeks back for
    /// overdue agenda to-dos, through the end of today.
    static func window(now:Date,calendar:Calendar = .current)->(from:Date,to:Date) {
        let today=calendar.startOfDay(for:now)
        return (calendar.date(byAdding:.day,value:-14,to:today) ?? today,calendar.date(byAdding:.day,value:1,to:today) ?? now)
    }
    static func dayKey(_ date:Date,calendar:Calendar = .current)->String {
        let c=calendar.dateComponents([.year,.month,.day],from:date)
        return String(format:"%04d-%02d-%02d",c.year ?? 0,c.month ?? 0,c.day ?? 0)
    }
    var date:String {Self.dayKey(now)}

    init(occurrences:[AgendaOccurrence],tasks:[ContentRecord],now:Date,calendar:Calendar = .current) {
        self.now=now
        let today=calendar.startOfDay(for:now)
        let tomorrow=calendar.date(byAdding:.day,value:1,to:today) ?? now,yesterday=calendar.date(byAdding:.day,value:-1,to:today) ?? now
        let summary=OverviewTaskSummary(tasks:tasks,now:now,calendar:calendar)
        let pending:[TodayItem]=summary.pending.compactMap{task in
            guard let due=summary.deadline(task) else{return nil}
            return TodayItem(source:.task,id:task.id,title:task.title,at:due,dayOnly:task.dueDay != nil,priority:task.priority ?? "medium",task:task)
        }
        // Task deadlines the agenda mirrors (taskID set) already come from the tasks above.
        let rows=occurrences.filter{$0.taskID == nil && !$0.event.deleted}.map{row in
            TodayItem(source:.agenda,id:row.id,title:row.event.title,at:row.start,end:row.end,allDay:row.event.allDay,location:row.event.location,occurrence:row)
        }
        var events=rows.filter{$0.occurrence?.event.kind != "task" && $0.at<tomorrow && ($0.end ?? $0.at)>today}
            .sorted{$0.allDay != $1.allDay ? $0.allDay:$0.at<$1.at}
        var nextMarked=false
        for index in events.indices {
            let item=events[index]
            if item.allDay {events[index].state="allDay"}
            else if (item.end ?? item.at)<=now {events[index].state="past"}
            else if item.at<=now {events[index].state="now"}
            else if !nextMarked {events[index].state="next";nextMarked=true}
            else {events[index].state="later"}
        }
        // Agenda to-dos count like tasks; done occurrences drop out.
        let todos=rows.filter{$0.occurrence?.event.kind == "task" && $0.occurrence?.isDone == false}
        let deadlines=pending+todos
        let priority={(item:TodayItem)->Int in item.priority=="high" ? 0:item.priority=="low" ? 2:1}
        let byTime={(a:TodayItem,b:TodayItem)->Bool in a.at != b.at ? a.at<b.at:priority(a) != priority(b) ? priority(a)<priority(b):a.id<b.id}
        self.events=events
        due=deadlines.filter{$0.at>=today && $0.at<tomorrow}.map{item in
            var value=item
            value.late=item.source == .task ? !item.dayOnly && item.at<now:!item.allDay && (item.end ?? item.at)<=now
            return value
        }.sorted(by:byTime)
        carryover=deadlines.filter{$0.at>=yesterday && $0.at<today}.sorted(by:byTime)
        overdue=deadlines.filter{$0.at<yesterday}.sorted(by:byTime)
    }
}

/// The saved brief, `<data>/today/briefs/YYYY-MM-DD.json` (app/today_store.py).
/// `lines` come from the rules; `text` is the optional AI wording.
struct TodayBrief:Decodable,Equatable {
    var date:String
    var source:String? = nil
    var lines:[String]? = nil
    var text:String? = nil
    var partial:Bool? = nil
    var savedAt:Double? = nil
    static func url(dataDirectory:URL,day:String)->URL {
        dataDirectory.appendingPathComponent("today/briefs/"+day+".json")
    }
    static func load(dataDirectory:URL,day:String)->TodayBrief? {
        let url=url(dataDirectory:dataDirectory,day:day)
        guard (try? url.resourceValues(forKeys:[.isSymbolicLinkKey]).isSymbolicLink) != true,
              let data=try? Data(contentsOf:url),data.count <= 64*1024 else{return nil}
        guard let brief=try? JSONDecoder().decode(TodayBrief.self,from:data),brief.date == day else{return nil}
        return brief
    }
}
