import SwiftUI

struct OverviewActions:View {
    @ObservedObject var model:Workspace
    let now:Date
    let compact:Bool
    @State private var selectedSpace:String? = nil
    @State private var category:String? = nil
    @ObservedObject private var language=NativeL10n.shared
    var all:OverviewTaskSummary {OverviewTaskSummary(tasks:model.snapshot?.tasks ?? [],now:now)}
    var summary:OverviewTaskSummary {selectedSpace.map{all.space($0)} ?? all}
    var primary:[ContentRecord] {
        switch category {
        case "late":return summary.overdue
        case "today":return summary.today
        case "future":return summary.upcoming
        case "undated":return summary.unscheduled
        default:return summary.overdue.isEmpty && summary.today.isEmpty ? summary.next:summary.overdue+summary.today
        }
    }
    var title:String {
        switch category {
        case "late":return nativeUI("逾期待处理", "Overdue tasks")
        case "today":return nativeUI("今天到期", "Due today")
        case "future":return nativeUI("接下来的截止日期", "Upcoming deadlines")
        case "undated":return nativeUI("还没定时间的事", "Without a deadline")
        default:return !summary.overdue.isEmpty ? nativeUI("先照顾这些事", "These need your attention"):!summary.today.isEmpty ? nativeUI("今天要做", "For today"):nativeUI("接下来，先做这些", "A good place to start")
        }
    }
    var subtitle:String {
        if category != nil{return nativeUI("点击任务继续查看与调整", "Select a task to review or update it")}
        if !summary.overdue.isEmpty {return nativeUI("逾期事项在前，今天的安排紧随其后。", "Overdue first, followed by what is due today.")}
        if !summary.today.isEmpty {return nativeUI("把今天的事情放在一起，按截止时间查看。", "Today's tasks, together in deadline order.")}
        return nativeUI("今天没有到期任务，提前推进一点也很好。", "Nothing due today. Make a little headway on what is next.")
    }
    var body:some View {
        VStack(alignment:.leading,spacing:24) {
            HStack(spacing:0) {
                statistic("late",nativeUI("逾期待处理", "Overdue"),all.overdue.count,"clock.badge.exclamationmark",StudioPalette.coral)
                statistic("today",nativeUI("今天到期", "Due today"),all.today.count,"sun.max",StudioPalette.jade)
                statistic("future",nativeUI("后续已排期", "Upcoming"),all.upcoming.count,"calendar",StudioPalette.sky)
                statistic("undated",nativeUI("尚未排期", "No deadline"),all.unscheduled.count,"tray",StudioPalette.neutral)
            }.padding(.vertical,2)
            Divider().opacity(0.45)
            VStack(alignment:.leading,spacing:20) {
                ViewThatFits(in:.horizontal) {
                    HStack(alignment:.center){heading;Spacer(minLength:16);filters}
                    VStack(alignment:.leading,spacing:14){heading;filters}
                }
                if model.snapshot == nil {
                    ProgressView(nativeUI("正在读取任务…", "Loading tasks…")).padding(.vertical,28)
                } else if all.pending.isEmpty {
                    empty(nativeUI("暂时没有待办，给下一步留一点空间。", "No pending tasks. Make room for your next step."))
                } else {
                    let layout=compact ? AnyLayout(VStackLayout(alignment:.leading,spacing:24)):AnyLayout(HStackLayout(alignment:.top,spacing:28))
                    layout {
                        VStack(alignment:.leading,spacing:12) {
                            HStack {Text(title).font(.system(size:16,weight:.semibold));Spacer();Text("\(primary.count)").font(.system(size:12,design:.rounded)).foregroundStyle(.secondary)}
                            if primary.isEmpty {empty(nativeUI("这里暂时没有任务。其他安排在右侧或下方。", "No tasks in this group. Other plans are shown alongside."))}
                            taskList(primary,recommended:category == nil && summary.overdue.isEmpty && summary.today.isEmpty)
                        }.frame(maxWidth:.infinity,alignment:.topLeading)
                        VStack(alignment:.leading,spacing:12) {
                            let showingNext=category == nil && (!summary.overdue.isEmpty || !summary.today.isEmpty)
                            let secondary=showingNext ? summary.next:Array(summary.upcoming.filter{item in !primary.contains{$0.id==item.id}})
                            HStack{Text(showingNext ? nativeUI("接下来", "Next up"):nativeUI("后续安排", "On the horizon")).font(.system(size:16,weight:.semibold));Spacer();Image(systemName:"arrow.up.right").foregroundStyle(.tertiary)}
                            if secondary.isEmpty {empty(nativeUI("暂无其他已排期事项。", "No other scheduled tasks."))}
                            ForEach(Array(secondary.prefix(3))){task in taskRow(task,recommended:showingNext)}
                            if category != "undated" && !summary.unscheduled.isEmpty {
                                Button {category="undated"} label:{HStack{Image(systemName:"tray");Text(nativeUI("\(summary.unscheduled.count) 件事还没定时间", "\(summary.unscheduled.count) tasks without a deadline"));Spacer();Image(systemName:"arrow.right")}.font(.system(size:11)).foregroundStyle(.secondary).padding(.vertical,14)}.buttonStyle(LiftStyle())
                            }
                            if !summary.blocked.isEmpty {
                                DisclosureGroup(nativeUI("\(summary.blocked.count) 项等待推进条件", "\(summary.blocked.count) waiting on prerequisites")) {
                                    ForEach(summary.blocked){task in taskRow(task,recommended:false)}
                                }.font(.system(size:11)).tint(StudioPalette.amber)
                            }
                        }.frame(maxWidth:compact ? .infinity:300,alignment:.topLeading)
                    }
                }
            }
        }
    }
    var heading:some View {
        VStack(alignment:.leading,spacing:6){HStack(spacing:8){Text(nativeUI("今天与接下来", "Today & beyond")).font(.system(size:20,weight:.semibold));Text(now.nativeFormatted(.dateTime.month().day())).font(.system(size:11)).foregroundStyle(.secondary)};Text(subtitle).font(.system(size:11)).foregroundStyle(.secondary)}
    }
    var filters:some View {
        HStack(spacing:4){filter(nil,nativeUI("全部", "All"));filter("日常",NativeL10n.space("日常"));filter("课程",NativeL10n.space("课程"));filter("科研",NativeL10n.space("科研"))}
            .padding(4).background(StudioPalette.panel,in:Capsule()).overlay(Capsule().strokeBorder(StudioPalette.line.opacity(0.6),lineWidth:0.5))
    }
    func filter(_ space:String?,_ title:String)->some View {
        Button{selectedSpace=space}label:{Text(title).font(.system(size:11,weight:selectedSpace==space ? .semibold:.regular)).foregroundStyle(selectedSpace==space ? StudioPalette.jade:.secondary).padding(.horizontal,12).padding(.vertical,7).background(selectedSpace==space ? StudioPalette.jade.opacity(0.1):.clear,in:Capsule())}.buttonStyle(.plain).accessibilityAddTraits(selectedSpace==space ? .isSelected:[])
    }
    func statistic(_ id:String,_ title:String,_ value:Int,_ symbol:String,_ tint:Color)->some View {
        Button {category=category==id ? nil:id;selectedSpace=nil} label:{
            VStack(alignment:.leading,spacing:9){Label(title,systemImage:symbol).font(.system(size:11)).foregroundStyle(.secondary);HStack(alignment:.firstTextBaseline,spacing:7){Text(value,format:.number).font(.system(size:28,weight:.medium,design:.rounded)).monospacedDigit().foregroundStyle(value>0 && id=="late" ? tint:.primary);if category==id{Image(systemName:"arrow.down.right").font(.system(size:11)).foregroundStyle(tint)}}}.frame(maxWidth:.infinity,alignment:.leading).padding(.leading,12).padding(.vertical,10).background(category==id ? tint.opacity(0.065):.clear,in:RoundedRectangle(cornerRadius:14))
        }.buttonStyle(LiftStyle()).accessibilityLabel("\(title)，\(value)")
    }
    func taskList(_ tasks:[ContentRecord],recommended:Bool)->some View {
        VStack(spacing:9){ForEach(Array(tasks.prefix(4))){task in taskRow(task,recommended:recommended)}
            if tasks.count>4{DisclosureGroup(nativeUI("再查看 \(tasks.count-4) 项", "Show \(tasks.count-4) more")){ForEach(Array(tasks.dropFirst(4))){task in taskRow(task,recommended:recommended)}}.font(.system(size:11)).tint(StudioPalette.jade).padding(.top,4)}
        }
    }
    func taskRow(_ task:ContentRecord,recommended:Bool)->some View {
        HStack(alignment:.top,spacing:0) {
            TaskCompletionButton(model:model,task:task)
                .padding(.leading,10).padding(.top,10)
            Button {model.reveal("task",task.id)} label:{
              HStack(alignment:.top,spacing:12) {
                VStack(alignment:.leading,spacing:7) {
                    Text(task.title).font(.system(size:13,weight:.medium)).foregroundStyle(.primary).lineLimit(2)
                    HStack(spacing:5){Circle().fill(StudioPalette.space(task.workspace)).frame(width:4,height:4);Text(NativeL10n.space(task.workspace));Text("·");Text(deadlineText(task)).foregroundStyle(summary.isOverdue(task) ? StudioPalette.coral:.secondary)}.font(.system(size:10)).foregroundStyle(.secondary)
                    if summary.isBlocked(task){Text(nativeUI("等待前置条件，可打开任务调整", "Waiting on prerequisites; open to review")).font(.system(size:10)).foregroundStyle(StudioPalette.amber)}
                    else if recommended {Text(reason(task)).font(.system(size:10)).foregroundStyle(.secondary)}
                    else if task.priority=="high" {Text(nativeUI("高优先级", "High priority")).font(.system(size:9,weight:.medium)).foregroundStyle(StudioPalette.amber)}
                }
                Spacer(minLength:0)
                Image(systemName:"chevron.right").font(.system(size:9)).foregroundStyle(.tertiary).padding(.top,4)
              }.padding(.vertical,16).padding(.trailing,16).padding(.leading,6)
                .frame(maxWidth:.infinity,alignment:.leading).contentShape(Rectangle())
            }.buttonStyle(LiftStyle()).help(nativeUI("打开任务详情", "Open task details"))
        }.background(StudioPalette.panel,in:RoundedRectangle(cornerRadius:16))
            .overlay(RoundedRectangle(cornerRadius:16).strokeBorder(StudioPalette.line.opacity(0.45),lineWidth:0.5))
    }
    func deadlineText(_ task:ContentRecord)->String {
        guard let date=summary.deadline(task) else{return nativeUI("未排期", "No deadline")}
        let day=date.nativeFormatted(.dateTime.month().day())
        if summary.isOverdue(task){return nativeUI("已逾期 · \(day)", "Overdue · \(day)")}
        if summary.isToday(task){return task.dueDay != nil ? nativeUI("今天到期", "Due today"):nativeUI("今天 ", "Today ")+date.nativeFormatted(.dateTime.hour().minute())}
        return day + (task.dueDay == nil ? " · "+date.nativeFormatted(.dateTime.hour().minute()):"")
    }
    func reason(_ task:ContentRecord)->String {
        if task.priority=="high" {return nativeUI("高优先级 · 可以提前推进", "High priority · Ready to start")}
        if task.status=="in_progress" {return nativeUI("正在进行 · 接着上次继续", "In progress · Pick up where you left off")}
        return summary.deadline(task) != nil ? nativeUI("已有安排 · 可以提前开始", "Scheduled · Ready to start"):nativeUI("尚未排期 · 可安排一个合适的时间", "Unscheduled · Find a suitable time")
    }
    func empty(_ text:String)->some View {Text(text).font(.system(size:12)).foregroundStyle(.secondary).lineSpacing(5).frame(maxWidth:.infinity,alignment:.leading).padding(.vertical,22)}
}
