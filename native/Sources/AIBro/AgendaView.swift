import SwiftUI
import UniformTypeIdentifiers
import AppKit

private func agendaTint(_ kind:String)->Color {kind=="course" ? StudioPalette.sky:kind=="meeting" ? StudioPalette.iris:kind=="task" ? StudioPalette.amber:StudioPalette.jade}
func agendaKind(_ kind:String)->String {["course":nativeUI("课程", "Courses"),"meeting":nativeUI("会议", "Meeting"),"task":nativeUI("任务", "Tasks"),"event":nativeUI("日程", "Agenda")][kind] ?? nativeUI("日程", "Agenda")}
struct AgendaChoice:View {
    @ObservedObject private var nativeLanguage = NativeL10n.shared
    let title:String
    @Binding var value:String
    let options:[(String,String)]
    @State private var open=false
    @State private var query=""
    var body:some View {
        Button{open.toggle()}label:{HStack{Text(options.first{$0.0==value}?.1 ?? title).lineLimit(1);Spacer();Image(systemName:"chevron.up.chevron.down").font(.caption2)}.padding(10).frame(minWidth:120).background(.primary.opacity(0.035),in:RoundedRectangle(cornerRadius:10))}.buttonStyle(.plain).accessibilityLabel(title)
            .popover(isPresented:$open) {
                VStack(alignment:.leading,spacing:5) {
                    Text(title).font(.caption).foregroundStyle(.secondary)
                    if options.count>6 {TextField(nativeUI("搜索", "Search"),text:$query).textFieldStyle(.roundedBorder)}
                    ScrollView {
                        VStack(spacing:3) {
                            ForEach(options.filter{query.isEmpty || $0.1.localizedCaseInsensitiveContains(query)},id:\.0) { option in
                                Button {value=option.0;open=false} label: {
                                    HStack {Text(option.1);Spacer();if value==option.0{Image(systemName:"checkmark")}}
                                        .padding(9).contentShape(Rectangle())
                                }.buttonStyle(LiftStyle())
                            }
                        }
                    }.frame(maxHeight:270)
                }.padding(12).frame(width:260)
            }
    }
}
private struct AgendaDaySelection:Identifiable {
    let date:Date
    var id:Date {date}
}

struct AgendaView:View {
    @ObservedObject private var nativeLanguage = NativeL10n.shared
    @ObservedObject var model:Workspace
    @ObservedObject var store:AgendaStore
    @State private var mode="今日"
    @State private var kind="all"
    @State private var query=""
    @State private var editor:AgendaEvent?
    @State private var detail:AgendaOccurrence?
    @State private var selectedDay:AgendaDaySelection?
    @State private var importing=false
    @State private var settings=false
    @State private var trash=false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var cal:Calendar {var c=Calendar.current;c.firstWeekday=2;return c}
    private var days:[Date] {
        let focus=store.focusDate
        if mode=="月" {let first=cal.dateInterval(of:.month,for:focus)!.start;let start=cal.date(byAdding:.day,value: -((cal.component(.weekday,from:first)+5)%7),to:first)!;return (0..<42).map{cal.date(byAdding:.day,value:$0,to:start)!}}
        if mode=="周" {let start=cal.dateInterval(of:.weekOfYear,for:focus)!.start;return (0..<7).map{cal.date(byAdding:.day,value:$0,to:start)!}}
        return [cal.startOfDay(for:focus)]
    }
    private func items(_ day:Date)->[AgendaOccurrence] {store.occurrences(from:cal.startOfDay(for:day),to:cal.date(byAdding:.day,value:1,to:cal.startOfDay(for:day))!).filter{(kind=="all" || $0.event.kind==kind) && (query.isEmpty || $0.event.title.localizedCaseInsensitiveContains(query))}}
    var body:some View {
        ScrollView {
            VStack(alignment:.leading,spacing:22){
                ViewThatFits(in:.horizontal) {
                    HStack(alignment:.center,spacing:24){agendaHeading;Spacer(minLength:16);headerActions}
                    VStack(alignment:.leading,spacing:16){agendaHeading;headerActions}
                }.modifier(RowEntrance(order:0))
                HStack{ForEach(["今日","周","月"],id:\.self){value in Button{withAnimation(reduceMotion ? nil:.easeInOut(duration:0.18)){mode=value;if value=="今日"{store.focusDate=Date()}}}label:{Text(NativeL10n.agendaMode(value)).padding(.horizontal,18).padding(.vertical,9).background(mode==value ? StudioPalette.jade.opacity(0.15):.clear,in:Capsule())}.buttonStyle(.plain)};Spacer();Button{shift(-1)}label:{Image(systemName:"chevron.left")};Text(store.focusDate.nativeFormatted(.dateTime.year().month().day())).font(.headline).monospacedDigit();Button{shift(1)}label:{Image(systemName:"chevron.right")};Button(nativeUI("今天", "Today")){store.focusDate=Date()}}.buttonStyle(LiftStyle())
                HStack{AgendaChoice(title:nativeUI("日程类型", "Event type"),value:$kind,options:[("all",nativeUI("全部安排", "All events")),("course",nativeUI("课程", "Courses")),("meeting",nativeUI("会议", "Meeting")),("task",nativeUI("任务截止", "Task deadlines")),("event",nativeUI("其他日程", "Other events"))]).frame(width:155);TextField(nativeUI("搜索日程", "Search events"),text:$query).textFieldStyle(.roundedBorder);Button{trash=true}label:{Image(systemName:"archivebox")}.help(nativeUI("已取消日程", "Cancelled events"))}
                if mode=="今日" {dayAgenda(store.focusDate)} else {
                    LazyVGrid(columns:Array(repeating:GridItem(.flexible(),spacing:8),count:7),spacing:8){ForEach(["一","二","三","四","五","六","日"],id:\.self){Text(nativeUI("周"+$0, NativeL10n.weekday($0))).font(.caption).foregroundStyle(.secondary)};ForEach(days,id:\.self){day in dayCell(day)}}
                    dayAgenda(store.focusDate)
                }
                HStack{Image(systemName:"bell");Text(NativeL10n.notificationStatus(store.notificationStatus));Spacer();Text(nativeUI("本机时间：\(TimeZone.current.identifier)", "Local time: \(TimeZone.current.identifier)"))}.font(.caption).foregroundStyle(.secondary)
                Text(nativeUI("日程保存在当前本机工作区。已设截止日期的任务自动显示；拖动日程到日期可调整本次安排。", "Events are saved in this local workspace. Tasks with deadlines appear automatically. Drag an event to another day to reschedule that occurrence.")).font(.caption).foregroundStyle(.secondary)
            }.padding(30).frame(maxWidth:1400).frame(maxWidth:.infinity)
        }.background(StudioPalette.canvas)
        .sheet(item:$selectedDay){selection in AgendaDayDetail(model:model,store:store,date:selection.date)}
        .sheet(item:$editor){event in AgendaEditor(model:model,store:store,event:event)}
        .sheet(item:$model.agendaDraft){event in AgendaEditor(model:model,store:store,event:event)}
        .sheet(item:$model.agendaLinkedDetail){occurrence in AgendaDetail(model:model,store:store,occurrence:occurrence)}
        .sheet(item:$detail){occurrence in AgendaDetail(model:model,store:store,occurrence:occurrence)}
        .sheet(isPresented:$importing){AgendaImportView(model:model,store:store)}
        .sheet(isPresented:$settings){AgendaReminderSettings(store:store)}
        .sheet(isPresented:$trash){VStack(alignment:.leading,spacing:16){Text(nativeUI("已取消日程", "Cancelled events")).font(.title2);ScrollView{ForEach(store.events.filter(\.deleted)){event in HStack{Text(event.title);Spacer();Button(nativeUI("恢复", "Restore")){perform{try store.restore(event)}}}.padding(10)}};Button(nativeUI("关闭", "Close")){trash=false}}.padding(24).frame(width:480,height:360)}
        .alert(nativeUI("日程中心", "Agenda"),isPresented:Binding(get:{store.error != nil},set:{if !$0{store.error=nil}})){Button(nativeUI("好", "OK")){store.error=nil}}message:{Text(store.error ?? "")}
    }
    private var agendaHeading:some View {
        VStack(alignment:.leading,spacing:8) {
            Text(nativeUI("AGENDA / 日程中心", "YOUR AGENDA")).font(.system(size:10,weight:.semibold)).tracking(2).foregroundStyle(StudioPalette.jade)
            Text(nativeUI("给每一天，留好位置。", "Make space for each day.")).font(.system(size:28,weight:.semibold)).fixedSize(horizontal:true,vertical:false)
            Text(nativeUI("课程、会议与行动，连接到你的知识库。", "Courses, meetings and next steps, connected to your knowledge.")).font(.callout).foregroundStyle(.secondary)
        }
    }
    private var headerActions:some View {
        HStack(alignment:.center,spacing:8) {
            Button{settings=true}label:{headerLabel(nativeUI("提醒", "Reminders"),icon:"bell.badge")}
            Button{importing=true}label:{headerLabel(nativeUI("导入", "Import"),icon:"square.and.arrow.down")}
            Button{newEvent()}label:{headerLabel(nativeUI("新建日程", "New event"),icon:"plus")}.modifier(GlassSurface())
        }.buttonStyle(LiftStyle()).fixedSize(horizontal:true,vertical:false)
    }
    private func headerLabel(_ text:String,icon:String)->some View {
        HStack(alignment:.center,spacing:8) {
            Image(systemName:icon).frame(width:20,height:20)
            Text(text).lineLimit(1)
        }.font(.system(size:14,weight:.semibold)).padding(.horizontal,14).frame(height:44).contentShape(Capsule())
    }
    private func dayCell(_ day:Date)->some View {
        let entries=items(day),selected=cal.isDate(day,inSameDayAs:store.focusDate)
        return VStack(alignment:.leading,spacing:6){Button{showDay(day)}label:{HStack{Text(day.nativeFormatted(.dateTime.day())).font(.system(size:14,weight:.semibold)).foregroundStyle(mode=="月" && !cal.isDate(day,equalTo:store.focusDate,toGranularity:.month) ? .secondary:.primary);Spacer();if cal.isDateInToday(day){Circle().fill(StudioPalette.jade).frame(width:5,height:5)}}.contentShape(Rectangle())}.buttonStyle(.plain).accessibilityLabel(nativeUI("查看 \(day.nativeFormatted(.dateTime.month().day().weekday())) 的安排", "View events for \(day.nativeFormatted(.dateTime.month().day().weekday()))"))
            ForEach(entries.prefix(mode=="周" ? 8:3)){entry in Button{open(entry)}label:{HStack(spacing:4){RoundedRectangle(cornerRadius:2).fill(agendaTint(entry.event.kind)).frame(width:3,height:20);Text(entry.event.title).font(.system(size:11)).lineLimit(1).strikethrough(entry.isDone)}.padding(5).frame(maxWidth:.infinity,alignment:.leading).frame(height:30).background(agendaTint(entry.event.kind).opacity(0.10),in:RoundedRectangle(cornerRadius:6))}.buttonStyle(.plain).draggable(entry.id)}
            if entries.count>(mode=="周" ? 8:3){Button{showDay(day)}label:{Text(nativeUI("还有 \(entries.count-(mode=="周" ? 8:3)) 项", "\(entries.count-(mode=="周" ? 8:3)) more")).font(.caption2).foregroundStyle(.secondary)}.buttonStyle(.plain)};Spacer(minLength:0)
        }.padding(10).frame(height:mode=="周" ? 340:168,alignment:.topLeading).background {
            Button{showDay(day)}label:{
                RoundedRectangle(cornerRadius:14).fill(selected ? StudioPalette.jade.opacity(0.08):StudioPalette.panel).contentShape(RoundedRectangle(cornerRadius:14))
            }.buttonStyle(.plain).accessibilityLabel(nativeUI("查看 \(day.nativeFormatted(.dateTime.month().day().weekday())) 的全部安排", "View all events for \(day.nativeFormatted(.dateTime.month().day().weekday()))")).help(nativeUI("查看当天全部安排", "View all events for this day"))
        }.overlay(RoundedRectangle(cornerRadius:14).stroke(selected ? StudioPalette.jade.opacity(0.45):StudioPalette.line,lineWidth:1).allowsHitTesting(false))
            .dropDestination(for:String.self){values,_ in guard let id=values.first,let entry=store.occurrences(from:cal.date(byAdding:.year,value:-1,to:day)!,to:cal.date(byAdding:.year,value:1,to:day)!).first(where:{$0.id==id}),entry.taskID==nil else{return false};let parts=cal.dateComponents([.hour,.minute,.second],from:entry.start);let target=cal.date(bySettingHour:parts.hour ?? 0,minute:parts.minute ?? 0,second:parts.second ?? 0,of:day)!;perform{try store.move(entry,to:target)};return true}
    }
    private func dayAgenda(_ date:Date)->some View {
        let entries=items(date)
        return DashboardCard {
            HStack{Text(date.nativeFormatted(.dateTime.month().day().weekday())).font(.title3.bold());Spacer();Text(nativeUI("\(entries.count) 项安排", "\(entries.count) events")).foregroundStyle(.secondary)}
            if entries.isEmpty {VStack(spacing:12){Image(systemName:"sun.max").font(.system(size:30)).foregroundStyle(StudioPalette.amber);Text(nativeUI("这一天还有留白", "A little room in the day")).font(.headline);Button(nativeUI("安排一件事", "Add an event")){newEvent()}}.frame(maxWidth:.infinity).padding(30)}
            ForEach(entries){entry in Button{open(entry)}label:{HStack(spacing:14){RoundedRectangle(cornerRadius:3).fill(agendaTint(entry.event.kind)).frame(width:4,height:42);VStack(alignment:.leading,spacing:4){Text(entry.event.allDay ? nativeUI("全天", "All day"):entry.start.nativeFormatted(date:.omitted,time:.shortened)).font(.system(size:13,weight:.semibold)).monospacedDigit();Text(agendaKind(entry.event.kind)).font(.caption).foregroundStyle(.secondary)}.frame(width:65,alignment:.leading);VStack(alignment:.leading,spacing:5){Text(entry.event.title).font(.headline).strikethrough(entry.isDone);Text(entry.event.location.isEmpty ? (model.snapshot?.projects.first{$0.id==entry.event.projectID}?.title ?? nativeUI("独立日程", "Standalone event")):entry.event.location).font(.caption).foregroundStyle(.secondary)};Spacer();if entry.isDone{Image(systemName:"checkmark.circle.fill").foregroundStyle(StudioPalette.jade)};Image(systemName:"chevron.right").font(.caption).foregroundStyle(.secondary)}.padding(.vertical,8).contentShape(Rectangle())}.buttonStyle(LiftStyle()).draggable(entry.id)}
        }
    }
    private func showDay(_ day:Date){store.focusDate=day;selectedDay=AgendaDaySelection(date:day)}
    private func newEvent(){var e=AgendaEvent();let cal=Calendar.current;e.start=cal.date(bySettingHour:9,minute:0,second:0,of:store.focusDate)!;e.end=e.start.addingTimeInterval(3600);editor=e}
    private func shift(_ n:Int){store.focusDate=cal.date(byAdding:mode=="月" ? .month:mode=="周" ? .weekOfYear:.day,value:n,to:store.focusDate)!}
    private func open(_ entry:AgendaOccurrence){if let id=entry.taskID {model.selection="agent";model.reveal("task",id)}else{detail=entry}}
    private func perform(_ action:()throws->Void){do{try action()}catch{store.error=error.localizedDescription}}
}

/// A date opens its own complete agenda, independent of the month grid's filters.
private struct AgendaDayDetail:View {
    @ObservedObject private var nativeLanguage = NativeL10n.shared
    @ObservedObject var model:Workspace
    @ObservedObject var store:AgendaStore
    @State var date:Date
    @State private var detail:AgendaOccurrence?
    @State private var editor:AgendaEvent?
    @Environment(\.dismiss) private var dismiss
    private var entries:[AgendaOccurrence] {
        let c=Calendar.current,start=c.startOfDay(for:date)
        return store.occurrences(from:start,to:c.date(byAdding:.day,value:1,to:start)!)
    }
    var body:some View {
        VStack(alignment:.leading,spacing:0) {
            HStack(spacing:12) {
                VStack(alignment:.leading,spacing:5) {
                    Text(date.nativeFormatted(.dateTime.month().day().weekday())).font(.title2.bold())
                    Text(nativeUI("\(entries.count) 项安排 · 本机时间", "\(entries.count) events · Local time")).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button{changeDay(-1)}label:{Image(systemName:"chevron.left").frame(width:28,height:28)}.help(nativeUI("前一天", "Previous day"))
                Button{changeDay(1)}label:{Image(systemName:"chevron.right").frame(width:28,height:28)}.help(nativeUI("后一天", "Next day"))
                Button(nativeUI("关闭", "Close")){dismiss()}
            }.padding(24)
            Divider()
            ScrollView {
                VStack(alignment:.leading,spacing:10) {
                    if entries.isEmpty {
                        VStack(spacing:12) {
                            Image(systemName:"sun.max").font(.system(size:34)).foregroundStyle(StudioPalette.amber)
                            Text(nativeUI("这一天还有留白", "A little room in the day")).font(.headline)
                            Text(nativeUI("添加课程、会议或想做的事。", "Add a course, meeting or something you want to do.")).foregroundStyle(.secondary)
                        }.frame(maxWidth:.infinity).padding(.vertical,60)
                    }
                    ForEach(entries){entry in
                        Button{open(entry)}label:{
                            HStack(alignment:.top,spacing:14) {
                                RoundedRectangle(cornerRadius:3).fill(agendaTint(entry.event.kind)).frame(width:4,height:48)
                                VStack(alignment:.leading,spacing:6) {
                                    Text(entry.event.title).font(.headline).strikethrough(entry.isDone).fixedSize(horizontal:false,vertical:true)
                                    HStack(spacing:8) {
                                        Text(entry.event.allDay ? nativeUI("全天", "All day"):entry.start.nativeFormatted(date:.omitted,time:.shortened)+" – "+entry.end.nativeFormatted(date:.omitted,time:.shortened)).monospacedDigit()
                                        Text(agendaKind(entry.event.kind))
                                    }.font(.subheadline).foregroundStyle(.secondary)
                                    if !entry.event.location.isEmpty {Label(entry.event.location,systemImage:"mappin.and.ellipse").font(.caption).foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true)}
                                }
                                Spacer(minLength:8)
                                Image(systemName:entry.isDone ? "checkmark.circle.fill":"chevron.right").foregroundStyle(entry.isDone ? StudioPalette.jade:Color.secondary)
                            }.padding(16).frame(maxWidth:.infinity,alignment:.leading).background(StudioPalette.panel,in:RoundedRectangle(cornerRadius:14)).contentShape(RoundedRectangle(cornerRadius:14))
                        }.buttonStyle(LiftStyle())
                    }
                }.padding(20)
            }
            Divider()
            HStack{Text(nativeUI("点击安排查看详情", "Select an event for details")).font(.caption).foregroundStyle(.secondary);Spacer();Button{newEvent()}label:{Label(nativeUI("新建日程", "New event"),systemImage:"plus")}.buttonStyle(.borderedProminent)}.padding(20)
        }.frame(width:580,height:560).background(StudioPalette.canvas)
        .sheet(item:$detail){entry in AgendaDetail(model:model,store:store,occurrence:entry)}
        .sheet(item:$editor){event in AgendaEditor(model:model,store:store,event:event)}
    }
    private func changeDay(_ amount:Int){date=Calendar.current.date(byAdding:.day,value:amount,to:date)!;store.focusDate=date}
    private func newEvent(){var event=AgendaEvent();event.start=Calendar.current.date(bySettingHour:9,minute:0,second:0,of:date)!;event.end=event.start.addingTimeInterval(3600);editor=event}
    private func open(_ entry:AgendaOccurrence){
        if let id=entry.taskID {dismiss();model.selection="agent";model.reveal("task",id)}else{detail=entry}
    }
}

struct AgendaEditor:View {
    @ObservedObject private var nativeLanguage = NativeL10n.shared
    @ObservedObject var model:Workspace
    @ObservedObject var store:AgendaStore
    @State var event:AgendaEvent
    @State private var issue=""
    @Environment(\.dismiss) private var dismiss
    var body:some View {
        VStack(spacing:0){HStack{Text(nativeUI("日程详情", "Event details")).font(.title2.bold());Spacer();Button(nativeUI("取消", "Cancel")){dismiss()};Button(nativeUI("保存", "Save")){do{if !event.documentID.isEmpty && !store.events.contains(where:{$0.id==event.id}) && !(model.snapshot?.documents?.contains(where:{$0.id==event.documentID}) ?? false){throw AgendaError.message(nativeUI("来源资料已不可用，请重新选择关联资料。", "The source is no longer available. Choose another linked source."))};try store.save(event);dismiss()}catch{issue=error.localizedDescription}}.buttonStyle(.borderedProminent)}.padding(22)
            ScrollView{VStack(alignment:.leading,spacing:17){TextField(nativeUI("日程名称", "Event title"),text:$event.title).font(.title3).textFieldStyle(.roundedBorder)
                if event.source=="随记" {Text(nativeUI("由随记创建的日程草稿。请确认日期、时间和提醒；保存前不会安排通知。", "Drafted from a quick note. Check the date, time and reminder. Notifications are scheduled only after saving.")).font(.caption).foregroundStyle(.secondary)}
                AgendaChoice(title:nativeUI("类型", "Type"),value:$event.kind,options:[("event",nativeUI("日程", "Agenda")),("course",nativeUI("课程", "Courses")),("meeting",nativeUI("会议", "Meeting"))])
                Toggle(nativeUI("全天", "All day"),isOn:$event.allDay).onChange(of:event.allDay){_,yes in if yes{let c=event.calendar();event.start=c.startOfDay(for:event.start);event.end=c.date(byAdding:.day,value:1,to:event.start)!}}
                DatePicker(nativeUI("开始", "Start"),selection:$event.start,displayedComponents:event.allDay ? [.date]:[.date,.hourAndMinute]);DatePicker(event.allDay ? nativeUI("结束（不含该日）", "End (exclusive)"):nativeUI("结束", "End"),selection:$event.end,displayedComponents:event.allDay ? [.date]:[.date,.hourAndMinute])
                AgendaChoice(title:nativeUI("时区", "Time zone"),value:$event.timeZone,options:TimeZone.knownTimeZoneIdentifiers.map{($0,$0)})
                TextField(nativeUI("地点 / 会议链接", "Location / Meeting link"),text:$event.location).textFieldStyle(.roundedBorder)
                AgendaChoice(title:nativeUI("重复", "Repeat"),value:$event.frequency,options:[("none",nativeUI("不重复", "Never")),("daily",nativeUI("每天", "Daily")),("weekly",nativeUI("每周", "Weekly")),("monthly",nativeUI("每月同日", "Monthly on the same day"))])
                if event.frequency != "none" {
                    Stepper(nativeUI("每 \(event.interval) \(event.frequency=="weekly" ? "周":event.frequency=="monthly" ? "月":"天")", "Every \(event.interval) \(event.frequency=="weekly" ? "weeks":event.frequency=="monthly" ? "months":"days")"),value:$event.interval,in:1...52)
                    if event.frequency=="weekly"{HStack{ForEach(Array(zip([2,3,4,5,6,7,1],["一","二","三","四","五","六","日"])),id:\.0){day,label in Button{if event.weekdays.contains(day){event.weekdays.removeAll{$0==day}}else{event.weekdays.append(day)}}label:{Text(NativeL10n.weekday(label)).padding(10).background(event.weekdays.contains(day) ? StudioPalette.jade.opacity(0.2):.primary.opacity(0.04),in:Circle())}.buttonStyle(.plain)}}}
                    Toggle(nativeUI("设置重复截止日", "Set an end date"),isOn:Binding(get:{event.until != nil},set:{event.until=$0 ? event.calendar().date(byAdding:.month,value:4,to:event.start):nil;event.count=nil}))
                    if event.until != nil {DatePicker(nativeUI("重复至", "Repeat until"),selection:Binding(get:{event.until!},set:{event.until=event.calendar().date(byAdding:.day,value:1,to:event.calendar().startOfDay(for:$0))!.addingTimeInterval(-1)}),displayedComponents:.date)}
                    if let count=event.count {Text(nativeUI("导入规则：共 \(count) 次", "Imported rule: \(count) occurrences")).font(.caption)}
                    Text(nativeUI("保存将更新整个系列；调课可在日程详情中选择‘调整本次’或‘跳过本次’。", "Saving updates the whole series. Use Reschedule occurrence or Skip occurrence in event details to change just one.")).font(.caption).foregroundStyle(.secondary)
                }
                AgendaChoice(title:nativeUI("提前提醒", "Reminder"),value:Binding(get:{event.reminderMinutes.map(String.init) ?? "off"},set:{event.reminderMinutes=Int($0)}),options:[("off",nativeUI("不提醒", "No reminder")),("0",nativeUI("到点提醒", "At start time")),("5",nativeUI("提前 5 分钟", "5 minutes before")),("15",nativeUI("提前 15 分钟", "15 minutes before")),("30",nativeUI("提前 30 分钟", "30 minutes before")),("60",nativeUI("提前 1 小时", "1 hour before")),("1440",nativeUI("提前 1 天", "1 day before"))])
                AgendaChoice(title:nativeUI("所属项目", "Project"),value:$event.projectID,options:[("",nativeUI("独立日程", "Standalone event"))]+(model.snapshot?.projects ?? []).map{($0.id,$0.title)}).onChange(of:event.projectID){_,_ in event.documentID=""}
                AgendaChoice(title:nativeUI("关联资料", "Linked source"),value:$event.documentID,options:[("",nativeUI("不关联资料", "No linked source"))]+(model.snapshot?.documents ?? []).filter{event.projectID.isEmpty || $0.projectId==event.projectID}.map{($0.id,$0.title)}).onChange(of:event.documentID){_,value in event.documentKind=model.snapshot?.documents?.first{$0.id==value}?.kind ?? "note"}
                Text(nativeUI("备注", "Notes")).font(.headline);TextEditor(text:$event.details).frame(height:90).overlay(RoundedRectangle(cornerRadius:8).stroke(.primary.opacity(0.1)))
                if !issue.isEmpty{Text(issue).foregroundStyle(.red)}
            }.padding(22)}
        }.frame(width:570,height:690).background(StudioPalette.canvas)
    }
}

struct AgendaDetail:View {
    @ObservedObject private var nativeLanguage = NativeL10n.shared
    @ObservedObject var model:Workspace
    @ObservedObject var store:AgendaStore
    let occurrence:AgendaOccurrence
    @State private var editing=false
    @State private var moving=false
    @State private var target=Date()
    @State private var issue=""
    @Environment(\.dismiss) private var dismiss
    var body:some View {
        VStack(alignment:.leading,spacing:18){HStack{Label(agendaKind(occurrence.event.kind),systemImage:"calendar").foregroundStyle(agendaTint(occurrence.event.kind));Spacer();Button(nativeUI("关闭", "Close")){dismiss()}}
            Text(occurrence.event.title).font(.title.bold());Text(occurrence.start.nativeFormatted()+" — "+occurrence.end.nativeFormatted(date:.omitted,time:.shortened));Text(occurrence.event.timeZone).font(.caption).foregroundStyle(.secondary)
            if !occurrence.event.location.isEmpty{Label(occurrence.event.location,systemImage:"mappin.and.ellipse")}
            if !occurrence.event.details.isEmpty {ScrollView{Text(occurrence.event.details).frame(maxWidth:.infinity,alignment:.leading)}.frame(maxHeight:120)}
            HStack{if !occurrence.event.projectID.isEmpty{Button(nativeUI("打开项目", "Open project")){model.selection="project:"+occurrence.event.projectID;dismiss()}};if !occurrence.event.documentID.isEmpty{Button(nativeUI("打开关联资料", "Open linked source")){model.selection="agent";model.reveal(occurrence.event.documentKind,occurrence.event.documentID);dismiss()}}}
            Divider();HStack{Button(occurrence.isDone ? nativeUI("标为未完成", "Mark incomplete"):nativeUI("标记完成", "Mark complete")){perform{try store.toggleDone(occurrence)}};Button(nativeUI("编辑整个日程", "Edit series")){editing=true};Button(nativeUI("调整本次", "Reschedule occurrence")){target=occurrence.start;moving=true}}
            if moving {DatePicker(nativeUI("改到", "Move to"),selection:$target);Button(nativeUI("保存本次调整", "Save this change")){perform{try store.move(occurrence,to:target)}}}
            HStack{if occurrence.event.frequency != "none" {Button(nativeUI("跳过本次", "Skip occurrence")){perform{try store.skip(occurrence)}}};Spacer();Button(nativeUI("取消整个日程", "Cancel series"),role:.destructive){perform{try store.cancel(occurrence.event)}}}
            if !issue.isEmpty{Text(issue).foregroundStyle(.red)}
        }.padding(26).frame(width:570).background(StudioPalette.canvas).sheet(isPresented:$editing,onDismiss:{dismiss()}){AgendaEditor(model:model,store:store,event:occurrence.event)}
    }
    private func perform(_ action:()throws->Void){do{try action();dismiss()}catch{issue=error.localizedDescription}}
}
