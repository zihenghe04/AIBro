import Foundation
import SwiftUI
import UserNotifications

struct AgendaPreferences: Codable, Equatable {
    var notifications = false
    var taskReminderMinutes: Int? = nil
    var briefing = false
    var briefingHour = 8
    var briefingMinute = 0
    var showTitles = false
    func validate() throws {
        guard (0...23).contains(briefingHour),(0...59).contains(briefingMinute),taskReminderMinutes == nil || (0...10080).contains(taskReminderMinutes!) else {throw AgendaError.message("提醒时间无效。")}
    }
}
struct AgendaArchive: Codable {var version=1;var events:[AgendaEvent]=[];var preferences=AgendaPreferences()}
@MainActor final class AgendaStore: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    @Published private(set) var events:[AgendaEvent]=[]
    @Published var preferences=AgendaPreferences()
    @Published var error:String?
    @Published var notificationStatus="提醒未启用"
    @Published var queued=0
    @Published var deferred=0
    @Published var focusDate=Date()
    var onOpen:(()->Void)?
    var onChanged:(()->Void)?
    private var file:URL?
    private var tasks:[AgendaOccurrence]=[]
    private var taskKey=""
    private var scheduleWork:Task<Void,Never>?
    private var refreshTimer:Timer?
    private var revision=0
    private var reconciling=false
    private var qa=false
    private var loaded=false
    var center:UNUserNotificationCenter {UNUserNotificationCenter.current()}
    func load(folder:URL,qa:Bool) {
        self.qa=qa;file=folder.appendingPathComponent("agenda.json")
        do {
            if FileManager.default.fileExists(atPath:file!.path) {
                let archive=try JSONDecoder().decode(AgendaArchive.self,from:Data(contentsOf:file!))
                guard archive.version==1 else {throw AgendaError.message("日程数据版本不兼容，未覆盖原文件。")}
                guard Set(archive.events.map(\.id)).count==archive.events.count else {throw AgendaError.message("日程记录存在重复标识")};for event in archive.events {try event.validate()}
                try archive.preferences.validate();events=archive.events;preferences=archive.preferences
            }
            loaded=true
        }catch{self.error="日程读取失败：\(error.localizedDescription)";return}
        if !qa {center.delegate=self;center.setNotificationCategories([UNNotificationCategory(identifier:"AIBRO_AGENDA",actions:[UNNotificationAction(identifier:"LATER",title:"10 分钟后提醒",options:[])],intentIdentifiers:[])])}
        refreshTimer=Timer.scheduledTimer(withTimeInterval:300,repeats:true){[weak self]_ in Task{@MainActor in self?.reschedule()}}
        reschedule()
    }
    private func persist(_ items:[AgendaEvent],_ settings:AgendaPreferences) throws {
        guard loaded,let file else {throw AgendaError.message("日程存储尚未就绪，未写入。")}
        let bytes=try JSONEncoder().encode(AgendaArchive(events:items,preferences:settings))
        try bytes.write(to:file,options:.atomic)
    }
    func save(_ event:AgendaEvent) throws {
        try event.validate();var next=events
        if let index=next.firstIndex(where:{$0.id==event.id}) {next[index]=event}else{next.append(event)}
        try persist(next,preferences);events=next;reschedule();onChanged?()
    }
    func importEvents(_ items:[AgendaEvent],replace:Bool, projectID:String) throws {
        guard Set(items.map(\.id)).count == items.count else {throw AgendaError.message("导入存在重复标识，请重新生成预览。")};var next=events
        for var event in items {try event.validate();if !projectID.isEmpty {event.projectID=projectID}
            if let i=next.firstIndex(where:{$0.id==event.id}) {if replace {next[i]=event}}
            else{next.append(event)}
        }
        try persist(next,preferences);events=next;reschedule();onChanged?()
    }
    func updatePreferences(_ value:AgendaPreferences) throws {try value.validate();try persist(events,value);preferences=value;reschedule()}
    func skip(_ occurrence:AgendaOccurrence) throws {var e=occurrence.event;e.excluded.append(occurrence.start);try save(e)}
    func toggleDone(_ occurrence:AgendaOccurrence) throws {var e=occurrence.event;if let i=e.completed.firstIndex(of:occurrence.start){e.completed.remove(at:i)}else{e.completed.append(occurrence.start)};try save(e)}
    func cancel(_ event:AgendaEvent) throws {var e=event;e.deleted=true;try save(e)}
    func restore(_ event:AgendaEvent) throws {var e=event;e.deleted=false;try save(e)}
    func move(_ occurrence:AgendaOccurrence,to date:Date) throws {
        var copy=occurrence.event
        if copy.frequency != "none" {
            var original=copy;original.excluded.append(occurrence.start)
            copy.id=UUID().uuidString;copy.frequency="none";copy.count=nil;copy.until=nil;copy.excluded=[];copy.completed=[]
            copy.start=date;copy.end=date.addingTimeInterval(occurrence.end.timeIntervalSince(occurrence.start));try copy.validate()
            var next=events;next[next.firstIndex(where:{$0.id==original.id})!]=original;next.append(copy);try persist(next,preferences);events=next;reschedule();onChanged?()
        } else {let duration=copy.end.timeIntervalSince(copy.start);copy.start=date;copy.end=date.addingTimeInterval(duration);try save(copy)}
    }
    func updateTasks(_ records:[ContentRecord]) {
        let key=records.map{"\($0.id)|\($0.title)|\($0.status)|\($0.due ?? 0)|\($0.dueDay ?? "")|\($0.projectId)"}.joined(separator:"\n")
        guard key != taskKey else{return};taskKey=key
        tasks=records.compactMap{task in guard task.status != "done",let stamp=task.due else{return nil}
            var event=AgendaEvent();event.id="task:"+task.id;event.title=task.title;event.kind="task";event.start=Date(timeIntervalSince1970:stamp/1000);event.end=event.start.addingTimeInterval(60);event.projectID=task.projectId;event.reminderMinutes=nil
            if let day=task.dueDay {
                let formatter=DateFormatter();formatter.locale=Locale(identifier:"en_US_POSIX");formatter.dateFormat="yyyy-MM-dd";formatter.timeZone = .current
                if let date=formatter.date(from:day) {event.start=Calendar.current.date(bySettingHour:9,minute:0,second:0,of:date)!;event.end=event.start.addingTimeInterval(60);event.allDay=true}
            }
            return AgendaOccurrence(event:event,start:event.start,end:event.end,taskID:task.id)
        };objectWillChange.send();reschedule()
    }
    func occurrences(from:Date,to:Date)->[AgendaOccurrence] {
        (events.flatMap{AgendaEngine.occurrences($0,from:from,to:to)}+tasks.filter{$0.start>=from && $0.start<to}).sorted{$0.start == $1.start ? $0.id<$1.id:$0.start<$1.start}
    }
    func requestNotifications() async {
        guard !qa else {notificationStatus="独立验证模式：不申请通知权限";return}
        do {
            let allowed=try await center.requestAuthorization(options:[.alert,.sound,.badge])
            var settings=preferences;settings.notifications=allowed;try updatePreferences(settings)
            if !allowed {notificationStatus="通知未获授权，请在系统设置中允许 AI Bro 通知。"}
        }catch{self.error=error.localizedDescription}
    }
    func testNotification() async {
        guard !qa else {return}
        do {let content=UNMutableNotificationContent();content.title="AI Bro 提醒已连接";content.body="这是一条本机测试通知。";content.sound = .default
            try await center.add(UNNotificationRequest(identifier:"agenda-test",content:content,trigger:UNTimeIntervalNotificationTrigger(timeInterval:5,repeats:false)))
        }catch{self.error=error.localizedDescription}
    }
    func reschedule() {
        revision+=1
        if reconciling {return}
        scheduleWork?.cancel()
        scheduleWork=Task {
            try? await Task.sleep(nanoseconds:250_000_000);guard !Task.isCancelled else{return}
            reconciling=true
            var expected:Int
            repeat {expected=revision;await reconcile(expected)} while expected != revision
            reconciling=false
        }
    }
    // Pure planning is separately testable without requesting OS permissions.
    func plannedNotifications(now:Date)->[(String,Date,String,Date)] {
        let limit=Calendar.current.date(byAdding:.day,value:30,to:now)!
        var planned:[(String,Date,String,Date)]=[]
        for occurrence in occurrences(from:now.addingTimeInterval(-86400),to:limit) where !occurrence.isDone {
            let minutes=occurrence.taskID == nil ? occurrence.event.reminderMinutes:preferences.taskReminderMinutes
            guard let minutes else{continue}
            let fire=occurrence.start.addingTimeInterval(-Double(minutes)*60)
            if fire>now {planned.append(("agenda-event-"+occurrence.id,fire,occurrence.event.title,occurrence.start))}
        }
        return planned.sorted{$0.1 == $1.1 ? $0.0<$1.0:$0.1<$1.1}
    }
    private func reconcile(_ expected:Int) async {
        guard !qa,loaded else{return}
        let status=await center.notificationSettings()
        guard expected==revision else{return}
        let authorized=status.authorizationStatus == .authorized || status.authorizationStatus == .provisional
        guard preferences.notifications,authorized else {
            let pending=await center.pendingNotificationRequests();guard expected==revision else{return}
            center.removePendingNotificationRequests(withIdentifiers:pending.filter{$0.identifier.hasPrefix("agenda-")}.map(\.identifier));queued=0;deferred=0
            notificationStatus=preferences.notifications ? "系统通知未授权；请在系统设置中开启。":"提醒未启用";return
        }
        let now=Date(),cal=Calendar.current,limit=cal.date(byAdding:.day,value:30,to:now)!
        let planned=plannedNotifications(now:now);deferred=max(0,planned.count-60)
        let desired=Array(planned.prefix(60)),existing=await center.pendingNotificationRequests()
        guard expected==revision else{return}
        let validOccurrences=Set(occurrences(from:now.addingTimeInterval(-86400),to:limit).filter{!$0.isDone}.map(\.id))
        center.removePendingNotificationRequests(withIdentifiers:existing.filter{$0.identifier.hasPrefix("agenda-snooze-") && ($0.content.userInfo["occurrenceID"] as? String).map{!validOccurrences.contains($0)} == true}.map(\.identifier))
        var ids=Set(desired.map{$0.0});if preferences.briefing {ids.insert("agenda-brief-daily")}
        center.removePendingNotificationRequests(withIdentifiers:existing.filter{$0.identifier.hasPrefix("agenda-") && !$0.identifier.hasPrefix("agenda-snooze-") && $0.identifier != "agenda-test" && !ids.contains($0.identifier)}.map(\.identifier))
        var accepted=0
        if preferences.briefing {
            let content=UNMutableNotificationContent();content.title="今日安排";content.body="新的一天，打开 AI Bro 查看课程、会议与待办。";content.sound = .default;content.categoryIdentifier="AIBRO_AGENDA"
            var parts=DateComponents();parts.hour=preferences.briefingHour;parts.minute=preferences.briefingMinute
            do{try await center.add(UNNotificationRequest(identifier:"agenda-brief-daily",content:content,trigger:UNCalendarNotificationTrigger(dateMatching:parts,repeats:true)));accepted+=1}catch{self.error=error.localizedDescription}
        }
        for (id,date,title,start) in desired {
            guard expected==revision,!Task.isCancelled else{return}
            let content=UNMutableNotificationContent();content.title=id.hasPrefix("agenda-brief") ? "今日安排":"日程提醒"
            content.body=preferences.showTitles ? title:"打开 AI Bro 查看安排。";content.sound = .default;content.categoryIdentifier="AIBRO_AGENDA";content.userInfo=["date":start.timeIntervalSince1970,"occurrenceID":String(id.dropFirst("agenda-event-".count))]
            var components=cal.dateComponents([.year,.month,.day,.hour,.minute,.second],from:date);components.timeZone=cal.timeZone
            do {try await center.add(UNNotificationRequest(identifier:id,content:content,trigger:UNCalendarNotificationTrigger(dateMatching:components,repeats:false)));accepted+=1}
            catch {self.error="通知排程失败：\(error.localizedDescription)"}
        }
        guard expected==revision else{return};queued=accepted
        notificationStatus="已交给系统 \(accepted) 条 · 未来 30 天\(deferred>0 ? " · \(deferred) 条待后续补排":"")"
    }
    nonisolated func userNotificationCenter(_ center:UNUserNotificationCenter,willPresent notification:UNNotification,withCompletionHandler completionHandler:@escaping(UNNotificationPresentationOptions)->Void){completionHandler([.banner,.sound])}
    nonisolated func userNotificationCenter(_ center:UNUserNotificationCenter,didReceive response:UNNotificationResponse,withCompletionHandler completionHandler:@escaping()->Void){
        if response.actionIdentifier=="LATER",let content=response.notification.request.content.mutableCopy() as? UNMutableNotificationContent {
            center.add(UNNotificationRequest(identifier:"agenda-snooze-"+UUID().uuidString,content:content,trigger:UNTimeIntervalNotificationTrigger(timeInterval:600,repeats:false))){_ in completionHandler()}
        } else {Task{@MainActor in if let stamp=response.notification.request.content.userInfo["date"] as? Double {self.focusDate=Date(timeIntervalSince1970:stamp)}else{self.focusDate=Date()};self.onOpen?();completionHandler()}}
    }
}
