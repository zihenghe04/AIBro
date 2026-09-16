import Foundation

struct ContentRecord: Identifiable, Decodable {
    let id:String; let title:String; let workspace:String; let projectId:String
    let kind:String; let status:String; let start:Double?; let due:Double?
    let completed:Double?; let dueDay:String?
    var updated:Double? = nil
    var reminderMinutes:Int? = nil
    var reminderDisabled:Bool? = nil
    var priority:String? = nil
    var waitingOnDependencies:Bool? = nil
}

/// Calendar-day deadlines stay local; timed deadlines retain their exact instant.
struct OverviewTaskSummary {
    let tasks:[ContentRecord]
    let now:Date
    var calendar:Calendar = .current
    var pending:[ContentRecord] {tasks.filter{!["done","archived","deleted"].contains($0.status)}}
    func deadline(_ task:ContentRecord)->Date? {
        if let day=task.dueDay {
            let parts=day.split(separator:"-").compactMap{Int($0)}
            guard parts.count==3 else{return nil}
            let components=DateComponents(year:parts[0],month:parts[1],day:parts[2])
            guard let date=calendar.date(from:components),calendar.dateComponents([.year,.month,.day],from:date)==components else{return nil}
            return date
        }
        guard let millis=task.due,millis.isFinite else{return nil}
        return Date(timeIntervalSince1970:millis/1000)
    }
    func isOverdue(_ task:ContentRecord)->Bool {
        guard let due=deadline(task) else{return false}
        return due < (task.dueDay == nil ? now:calendar.startOfDay(for:now))
    }
    func isToday(_ task:ContentRecord)->Bool {
        guard let due=deadline(task) else{return false}
        return !isOverdue(task) && calendar.isDate(due,inSameDayAs:now)
    }
    func isBlocked(_ task:ContentRecord)->Bool {task.status=="blocked" || task.waitingOnDependencies==true}
    func canStart(_ task:ContentRecord)->Bool {
        !isBlocked(task) && (task.start.map{Date(timeIntervalSince1970:$0/1000)<=now} ?? true)
    }
    func priority(_ task:ContentRecord)->Int {task.priority=="high" ? 0:task.priority=="low" ? 2:1}
    func byDeadline(_ a:ContentRecord,_ b:ContentRecord)->Bool {
        let first=deadline(a) ?? .distantFuture,second=deadline(b) ?? .distantFuture
        if first != second{return first<second}
        if priority(a) != priority(b){return priority(a)<priority(b)}
        return a.id<b.id
    }
    var overdue:[ContentRecord] {pending.filter(isOverdue).sorted(by:byDeadline)}
    var today:[ContentRecord] {pending.filter(isToday).sorted(by:byDeadline)}
    var upcoming:[ContentRecord] {pending.filter{deadline($0) != nil && !isOverdue($0) && !isToday($0)}.sorted(by:byDeadline)}
    var unscheduled:[ContentRecord] {pending.filter{deadline($0)==nil}.sorted{priority($0)==priority($1) ? $0.id<$1.id:priority($0)<priority($1)}}
    var blocked:[ContentRecord] {pending.filter(isBlocked)}
    var next:[ContentRecord] {
        pending.filter{!isOverdue($0) && !isToday($0) && canStart($0)}.sorted { a,b in
            // Imminent deadlines first, then priority/ongoing work; never invent a date.
            let limit=calendar.date(byAdding:.day,value:3,to:now) ?? now
            let nearA=deadline(a).map{$0<=limit} ?? false,nearB=deadline(b).map{$0<=limit} ?? false
            if nearA != nearB{return nearA}
            if nearA{return byDeadline(a,b)}
            if priority(a) != priority(b){return priority(a)<priority(b)}
            if (a.status=="in_progress") != (b.status=="in_progress"){return a.status=="in_progress"}
            return byDeadline(a,b)
        }
    }
    func space(_ name:String)->OverviewTaskSummary {OverviewTaskSummary(tasks:pending.filter{$0.workspace==name},now:now,calendar:calendar)}
}
