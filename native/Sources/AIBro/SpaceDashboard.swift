import SwiftUI
import Charts

private struct DayActivity:Identifiable {var id:Date {date};let date:Date;let count:Int}
private struct StatusSlice:Identifiable {var id:String {key};let key:String;let title:String;let count:Int;let color:Color}
private func projectTint(_ id:String)->Color { let colors=[StudioPalette.jade,StudioPalette.sky,StudioPalette.iris,StudioPalette.amber];return colors[id.utf8.reduce(0){($0+Int($1))%4}] }
private func date(_ millis:Double?)->Date? { millis.map{Date(timeIntervalSince1970:$0/1000)} }
private func statusTitle(_ status:String)->String { ["done":nativeUI("已完成", "Done"),"in_progress":nativeUI("进行中", "In progress"),"todo":nativeUI("待开始", "To do"),"blocked":nativeUI("受阻", "Blocked")][status] ?? nativeUI("待开始", "To do") }

struct DashboardCard<Content:View>:View {
    @ObservedObject private var nativeLanguage = NativeL10n.shared
    @Environment(\.colorScheme) private var scheme
    var tint:Color = StudioPalette.jade
    let content:Content
    init(tint:Color=StudioPalette.jade,@ViewBuilder content:()->Content){self.tint=tint;self.content=content()}
    var body:some View {
        VStack(alignment:.leading,spacing:18) { content }.padding(22).frame(maxWidth:.infinity,alignment:.leading)
            .background(StudioPalette.panel,in:RoundedRectangle(cornerRadius:22))
            .overlay(RoundedRectangle(cornerRadius:22).strokeBorder(StudioPalette.line.opacity(0.7),lineWidth:1).allowsHitTesting(false))
            .shadow(color:.black.opacity(scheme == .dark ? 0.08:0.025),radius:14,y:5)
    }
}
struct SpaceDashboard:View {
    @ObservedObject private var nativeLanguage = NativeL10n.shared
    @ObservedObject var model:Workspace
    let space:String
    var projectID:String?=nil
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var filter:String?=nil
    @State private var selectedAngle:Int?=nil
    @State private var selectedDay:Date?=nil
    @State private var mapProject:String=""
    private var tasks:[ContentRecord] {(model.snapshot?.tasks ?? []).filter{$0.workspace==space && (projectID==nil || $0.projectId==projectID)}}
    private var projects:[Item] {(model.snapshot?.projects ?? []).filter{$0.workspace==space && (projectID==nil || $0.id==projectID)}}
    private var documents:[ContentRecord] {(model.snapshot?.documents ?? []).filter{$0.workspace==space && (projectID==nil || $0.projectId==projectID)}}
    private var tint:Color {StudioPalette.space(space)}
    private var slices:[StatusSlice] { [StatusSlice(key:"done",title:nativeUI("已完成", "Done"),count:tasks.filter{$0.status=="done"}.count,color:StudioPalette.jade),StatusSlice(key:"in_progress",title:nativeUI("进行中", "In progress"),count:tasks.filter{$0.status=="in_progress"}.count,color:StudioPalette.amber),StatusSlice(key:"todo",title:nativeUI("待开始", "To do"),count:tasks.filter{$0.status=="todo"}.count,color:StudioPalette.neutral),StatusSlice(key:"blocked",title:nativeUI("受阻", "Blocked"),count:tasks.filter{$0.status=="blocked"}.count,color:StudioPalette.coral)] }
    private var completed:Int {tasks.filter{$0.status=="done"}.count}
    private var filtered:[ContentRecord] {tasks.filter{filter==nil || $0.status==filter}.sorted{($0.due ?? .greatestFiniteMagnitude)<($1.due ?? .greatestFiniteMagnitude)}}
    private var scheduled:[ContentRecord] { tasks.filter{$0.start != nil || $0.due != nil}.sorted{($0.start ?? $0.due ?? 0)<($1.start ?? $1.due ?? 0)} }
    private var days:[DayActivity] {let cal=Calendar.current;let today=cal.startOfDay(for:Date());return (-13...0).map{offset in let d=cal.date(byAdding:.day,value:offset,to:today)!;return DayActivity(date:d,count:tasks.filter{$0.status=="done" && date($0.completed).map{cal.isDate($0,inSameDayAs:d)} == true}.count)}}
    var body:some View {
        GeometryReader { geo in
            ScrollView {
                LazyVStack(alignment:.leading,spacing:20) {
                    header
                    if geo.size.width>=800 {
                        HStack(alignment:.top,spacing:18){completion.frame(width:330);activity.frame(minWidth:300)}.modifier(RowEntrance(order:2))
                    }else{
                        completion.modifier(RowEntrance(order:2));activity.modifier(RowEntrance(order:3))
                    }
                    timeline.modifier(RowEntrance(order:3))
                    if geo.size.width>=800 {
                        HStack(alignment:.top,spacing:18){projectProgress.frame(minWidth:280);taskList.frame(minWidth:320)}.modifier(RowEntrance(order:4))
                    }else{
                        projectProgress.modifier(RowEntrance(order:4));taskList.modifier(RowEntrance(order:5))
                    }
                    knowledgeMap.modifier(RowEntrance(order:5))
                    Text(nativeUI("图表来自当前空间的已保存数据 · 点击任务、项目或知识节点可查看详情", "Charts use saved workspace data. Select a task, project or knowledge item to explore it.")).font(.system(size:10)).foregroundStyle(.secondary).padding(.vertical,6)
                }.padding(geo.size.width<800 ? 24:36).frame(maxWidth:1320).frame(maxWidth:.infinity)
            }.background(StudioPalette.canvas)
        }
    }
    private var header:some View {
        HStack(alignment:.center) {
            VStack(alignment:.leading,spacing:10) {
                Text("\(NativeL10n.space(space).uppercased()) / WORKSPACE").font(.system(size:9,weight:.semibold)).tracking(2).foregroundStyle(tint).modifier(RowEntrance(order:0))
                Text(projectID != nil ? (projects.first?.title ?? nativeUI("项目", "Projects")) : space == "日常" ? nativeUI("让日常，有条不紊。", "Make room for everyday life."):space == "课程" ? nativeUI("让学习，形成体系。", "Connect what you learn."):nativeUI("让发现，持续生长。", "Keep discovery moving.")).font(.system(size:28,weight:.semibold)).tracking(-0.8).modifier(RowEntrance(order:1))
                Text(nativeUI("\(projects.count) 个项目 · \(tasks.count-completed) 项待办 · \(documents.count) 份知识与资料", "\(projects.count) \(projects.count == 1 ? "project":"projects") · \(tasks.count-completed) to do · \(documents.count) notes & sources")).font(.system(size:12)).foregroundStyle(.secondary).modifier(RowEntrance(order:2))
            }
            Spacer(minLength:16)
            VStack(alignment:.trailing,spacing:10){Button {model.reveal(projectID==nil ? "create-task":"create-project-task",projectID ?? space)} label:{Label(nativeUI("添加事项", "Add task"),systemImage:"plus").font(.system(size:12,weight:.semibold)).padding(.horizontal,16).padding(.vertical,12)}.buttonStyle(LiftStyle()).modifier(GlassSurface())
                Button(projectID==nil ? nativeUI("全部内容 →", "All content →"):nativeUI("文件与内容 →", "Files & content →")){model.spaceContent=true}.buttonStyle(.plain).font(.system(size:11)).foregroundStyle(.secondary)}
        }.padding(.bottom,6)
    }
    private func heading(_ title:String,_ detail:String)->some View { VStack(alignment:.leading,spacing:5){Text(title).font(.system(size:15,weight:.semibold));Text(detail).font(.system(size:10)).foregroundStyle(.secondary)} }
    private var completion:some View {
        DashboardCard(tint:StudioPalette.jade) {
            heading(nativeUI("完成度", "Completion"),nativeUI("每一个完成，都在积累", "Every finished step adds up"))
            HStack(spacing:20) {
                ZStack {
                    if tasks.isEmpty { Circle().stroke(.primary.opacity(0.07),lineWidth:15) }
                    else { Chart(slices.filter{$0.count>0}) { slice in
                        SectorMark(angle:.value(nativeUI("任务", "Tasks"),slice.count),innerRadius:.ratio(0.77),angularInset:3).cornerRadius(5).foregroundStyle(slice.color.gradient).opacity(filter==nil || filter==slice.key ? 1:0.25)
                    }.chartLegend(.hidden).chartAngleSelection(value:$selectedAngle)
                        .onChange(of:selectedAngle){_,value in guard let value else{return};var sum=0;for slice in slices{sum+=slice.count;if value<sum{withAnimation(reduceMotion ? nil:.easeInOut(duration:0.2)){filter=slice.key};break}}}
                    }
                    VStack(spacing:4){Text(tasks.isEmpty ? "—":"\(Int(Double(completed)/Double(tasks.count)*100))%").font(.system(size:29,weight:.medium,design:.rounded));Text(nativeUI("\(completed) / \(tasks.count) 已完成", "\(completed) / \(tasks.count) done")).font(.system(size:9)).foregroundStyle(.secondary)}.allowsHitTesting(false)
                }.frame(width:134,height:134).accessibilityLabel(nativeUI("已完成\(completed)项，共\(tasks.count)项任务", "\(completed) of \(tasks.count) tasks completed"))
                VStack(spacing:14) {ForEach(slices){slice in Button{choose(slice.key)} label:{HStack(spacing:7){Circle().fill(slice.color).frame(width:6,height:6);Text(slice.title);Spacer();Text("\(slice.count)").monospacedDigit().fontWeight(.medium)}.font(.system(size:10)).foregroundStyle(filter==slice.key ? slice.color:.primary)}.buttonStyle(.plain).accessibilityLabel(nativeUI("筛选\(slice.title)，\(slice.count)项", "Filter \(slice.title), \(slice.count) tasks"))}}
            }.padding(.top,20).frame(height:157)
        }
    }
    private var activity:some View {
        DashboardCard(tint:tint) {
            HStack(alignment:.top){heading(nativeUI("行动节奏", "Activity"),nativeUI("过去 14 天 · 已完成任务", "Completed tasks · Last 14 days"));Spacer();VStack(alignment:.trailing,spacing:3){Text("\(days.reduce(0){$0+$1.count})").font(.system(size:25,weight:.medium,design:.rounded));Text(nativeUI("次完成", "completed")).font(.system(size:9)).foregroundStyle(.secondary)}}
            Chart(days) { day in
                BarMark(x:.value(nativeUI("日期", "Date"),day.date,unit:.day),y:.value(nativeUI("完成", "Completed"),day.count),width:.ratio(0.52)).cornerRadius(4).foregroundStyle(LinearGradient(colors:[tint,tint.opacity(0.78)],startPoint:.top,endPoint:.bottom))
                if let selectedDay,Calendar.current.isDate(day.date,inSameDayAs:selectedDay){RuleMark(x:.value(nativeUI("日期", "Date"),day.date)).foregroundStyle(tint.opacity(0.35)).lineStyle(StrokeStyle(lineWidth:1,dash:[3,3])).annotation(position:.top){Text(nativeUI("\(day.date.nativeFormatted(.dateTime.month().day())) · \(day.count) 项", "\(day.date.nativeFormatted(.dateTime.month().day())) · \(day.count) tasks")).font(.system(size:9)).padding(5).background(.regularMaterial,in:Capsule())}}
            }.chartYScale(domain:0...max(2,(days.map(\.count).max() ?? 0)+1)).chartXAxis{AxisMarks(values:.stride(by:.day,count:3)){_ in AxisValueLabel(format:NativeL10n.dateTime.month().day()).font(.system(size:9));AxisTick()}}.chartYAxis{AxisMarks(position:.leading,values:.automatic(desiredCount:3)){_ in AxisGridLine(stroke:StrokeStyle(lineWidth:0.5,dash:[3,4]));AxisValueLabel().font(.system(size:9))}}
                .chartXSelection(value:$selectedDay).frame(height:123).padding(.top,14)
        }
    }
    private func choose(_ key:String){withAnimation(reduceMotion ? nil:.easeInOut(duration:0.2)){filter=filter==key ? nil:key}}
    private var timeline:some View {
        DashboardCard(tint:tint) {
            HStack{heading(nativeUI("日程轨迹", "Timeline"),nativeUI("左右滑动查看日期 · 点击任务查看详情", "Scroll to explore dates · Select a task for details"));Spacer();Text(nativeUI("\(scheduled.count) 已排期", "\(scheduled.count) scheduled")).font(.system(size:10)).foregroundStyle(.secondary)}
            if scheduled.isEmpty {empty(nativeUI("给任务设置日期后，计划会在这里展开。", "Add dates to your tasks to see the plan here."),"calendar")}
            else {
                ScrollView(.vertical) {
                    HStack(alignment:.top,spacing:16) {
                    VStack(spacing:0){ForEach(scheduled){task in Button{model.reveal("task",task.id)} label:{Text(task.title).font(.system(size:10)).lineLimit(1).frame(width:126,height:34,alignment:.leading).contentShape(Rectangle())}.buttonStyle(.plain).help(task.title)}}.padding(.top,18)
                    GeometryReader { viewport in
                    TimelineHorizontalScroll(width:max(viewport.size.width,timelineWidth),height:CGFloat(scheduled.count)*34+38) {
                    Chart {
                        ForEach(scheduled) { task in
                            if let start=date(task.start),let due=date(task.due),start<=due {
                                BarMark(xStart:.value(nativeUI("开始", "Start"),start),xEnd:.value(nativeUI("结束", "End"),due),y:.value(nativeUI("任务", "Tasks"),task.id),height:.fixed(17)).cornerRadius(6).foregroundStyle(projectTint(task.projectId).gradient).opacity(task.status=="done" ? 0.65:1).accessibilityLabel(Text(task.title))
                            } else if let point=date(task.due ?? task.start){PointMark(x:.value(nativeUI("日期", "Date"),point),y:.value(nativeUI("任务", "Tasks"),task.id)).foregroundStyle(projectTint(task.projectId)).symbolSize(65).accessibilityLabel(Text(task.title))}
                        }
                        RuleMark(x:.value(nativeUI("今天", "Today"),Date())).foregroundStyle(tint.opacity(0.5)).lineStyle(StrokeStyle(lineWidth:1,dash:[3,4])).annotation(position:.top,alignment:.leading){Text(nativeUI("今天", "Today")).font(.system(size:9)).foregroundStyle(tint)}
                    }.chartXScale(domain:timelineDomain).chartYScale(domain:scheduled.map(\.id)).chartXAxis{AxisMarks(values:.stride(by:.day,count:tickStride)){_ in AxisGridLine(stroke:StrokeStyle(lineWidth:0.5,dash:[2,4]));AxisValueLabel(format:NativeL10n.dateTime.month().day()).font(.system(size:9))}}
.chartYAxis(.hidden)
                        .chartOverlay{proxy in GeometryReader{g in Rectangle().fill(.clear).contentShape(Rectangle()).onTapGesture{point in if let plot=proxy.plotFrame {let y=point.y-g[plot].origin.y;if let id:String=proxy.value(atY:y),scheduled.contains(where:{$0.id==id}) {model.reveal("task",id)}}}}}
                        .chartPlotStyle{plot in plot.frame(height:CGFloat(scheduled.count)*34)}
                        .frame(width:max(viewport.size.width,timelineWidth),height:CGFloat(scheduled.count)*34+20)
                        .padding(.top,18)
                    }
                    .accessibilityLabel(nativeUI("日程日期轴，左右滚动查看", "Timeline dates. Scroll horizontally to explore."))
                    }.frame(height:CGFloat(scheduled.count)*34+74)
                    }.padding(.top,0)
                }.frame(height:min(330,max(198,CGFloat(scheduled.count)*34+74)))
            }
            Text(nativeUI("\(tasks.count-scheduled.count) 项尚未排期 · 日期可在任务详情中调整", "\(tasks.count-scheduled.count) unscheduled · Set dates in task details")).font(.system(size:9)).foregroundStyle(.secondary).padding(.top,10)
        }
    }
    // Keep a readable day scale; padding protects endpoint dots and axis labels.
    private var timelineDomain:ClosedRange<Date> {
        let calendar=Calendar.current
        let all=scheduled.flatMap{[date($0.start),date($0.due)].compactMap{$0}}+[Date()]
        let first=calendar.startOfDay(for:all.min()!)
        let start=calendar.date(byAdding:.day,value:-1,to:first)!
        let end=calendar.date(byAdding:.day,value:2,to:calendar.startOfDay(for:all.max()!))!
        return start...max(end,calendar.date(byAdding:.day,value:14,to:start)!)
    }
    private var timelineDays:Int {max(1,Calendar.current.dateComponents([.day],from:timelineDomain.lowerBound,to:timelineDomain.upperBound).day ?? 14)}
    private var timelineWidth:CGFloat {min(24000,CGFloat(timelineDays)*88)}
    private var tickStride:Int {max(1,Int(ceil(Double(timelineDays)/Double(timelineWidth/88))))}
    private var projectProgress:some View {
        DashboardCard(tint:StudioPalette.amber) {
            heading(nativeUI("项目进度", "Project progress"),nativeUI("把大目标拆成可以完成的小步", "Big goals, achievable steps"))
            VStack(spacing:18){ForEach(projects){project in
                let owned=tasks.filter{$0.projectId==project.id};let done=owned.filter{$0.status=="done"}.count
                Button {model.selection="project:"+project.id} label:{VStack(alignment:.leading,spacing:9){HStack{Text(project.title).font(.system(size:12,weight:.medium)).lineLimit(1);Spacer();Text(owned.isEmpty ? "—":"\(Int(Double(done)/Double(owned.count)*100))%").font(.system(size:11,weight:.medium)).foregroundStyle(projectTint(project.id))};GeometryReader{g in ZStack(alignment:.leading){Capsule().fill(projectTint(project.id).opacity(0.12));Capsule().fill(projectTint(project.id).gradient).frame(width:owned.isEmpty ? 0:g.size.width*Double(done)/Double(owned.count))}}.frame(height:6);Text(nativeUI("\(done) / \(owned.count) 项已完成", "\(done) / \(owned.count) done")).font(.system(size:9)).foregroundStyle(.secondary)}.padding(.vertical,5)}.buttonStyle(LiftStyle())
            }}.padding(.top,20)
            if projects.isEmpty{empty(nativeUI("创建项目，让每一步都有归处。", "Create a project to give each step a home."),"folder")}
        }
    }
    private var taskList:some View {
        DashboardCard(tint:tint) {
            HStack{heading(filter.map{statusTitle($0)} ?? nativeUI("任务清单", "Tasks"),nativeUI("点击任务编辑 · 点击圆环状态筛选", "Select a task to edit · Filter by completion status"));Spacer();if filter != nil{Button(nativeUI("全部", "All")){withAnimation{filter=nil}}.buttonStyle(.plain).font(.caption).foregroundStyle(tint)}}
            ScrollView{LazyVStack(spacing:0){ForEach(filtered){task in Button{model.reveal("task",task.id)} label:{HStack(spacing:10){Image(systemName:task.status=="done" ? "checkmark.circle.fill":task.status=="blocked" ? "exclamationmark.circle":"circle").foregroundStyle(task.status=="done" ? StudioPalette.jade:task.status=="blocked" ? StudioPalette.coral:tint).font(.system(size:16));VStack(alignment:.leading,spacing:5){Text(task.title).font(.system(size:11,weight:.medium)).lineLimit(2);Text(date(task.due).map{$0.nativeFormatted(.dateTime.month().day())} ?? nativeUI("未设置日期", "No date set")).font(.system(size:9)).foregroundStyle(.secondary)};Spacer();Circle().fill(projectTint(task.projectId)).frame(width:5,height:5)}.frame(maxWidth:.infinity,alignment:.leading).padding(.vertical,13).contentShape(Rectangle())}.buttonStyle(LiftStyle());Divider().opacity(0.3)}}}.frame(maxHeight:250).padding(.top,14)
            if filtered.isEmpty{empty(nativeUI("这里暂时没有任务。", "No tasks here yet."),"checkmark.circle")}
        }
    }
    private var knowledgeMap:some View {
        let current=projects.first(where:{$0.id==mapProject}) ?? projects.first
        let children=(tasks+documents).filter{$0.projectId==current?.id}
        return DashboardCard(tint:StudioPalette.jade) {
            HStack{heading(nativeUI("知识脉络", "Knowledge connections"),nativeUI("连线表示实际项目归属，不代表 AI 推断的语义关系", "Connections show saved project membership, not AI-inferred relationships."));Spacer();if projectID == nil { ProjectChoice(projects:projects,selection:$mapProject).frame(maxWidth:240) }}
            if let current {
                HStack(spacing:0){Button {model.selection="project:"+current.id} label:{VStack(alignment:.leading,spacing:10){Image(systemName:"folder.fill").foregroundStyle(projectTint(current.id));Text(current.title).font(.system(size:13,weight:.semibold));Text(nativeUI("\(children.count) 个关联条目", "\(children.count) linked items")).font(.system(size:10)).foregroundStyle(.secondary)}.padding(20).frame(width:180,alignment:.leading).background(projectTint(current.id).opacity(0.1),in:RoundedRectangle(cornerRadius:20))}.buttonStyle(LiftStyle())
                    Rectangle().fill(projectTint(current.id).opacity(0.35)).frame(width:26,height:1)
                    ScrollView {
                        LazyVStack(spacing:9) {
                            ForEach(children) { item in
                                HStack(spacing:0) {
                                    Rectangle().fill(projectTint(current.id).opacity(0.3)).frame(width:16,height:1)
                                    Button {model.reveal(item.kind,item.id)} label: {
                                        HStack(spacing:9) {
                                            Image(systemName:item.kind=="task" ? "checklist":item.kind=="note" ? "doc.text":"doc").foregroundStyle(projectTint(current.id))
                                            Text(item.title).font(.system(size:11)).lineLimit(1)
                                            Spacer()
                                            Text(item.kind=="task" ? nativeUI("任务", "Tasks"):item.kind=="note" ? nativeUI("笔记", "Notes"):nativeUI("资料", "Sources")).font(.system(size:9)).foregroundStyle(.secondary)
                                        }.padding(11).background(projectTint(current.id).opacity(0.065),in:RoundedRectangle(cornerRadius:12))
                                    }.buttonStyle(LiftStyle()).contextMenu {
                                        if item.kind=="import" {
                                            Button(model.desktop?.preferences["ai-bro-language"]=="en" ? "Show in Finder":nativeUI("在 Finder 中显示", "Show in Finder"),systemImage:"folder") {model.revealInFinder(item.id)}
                                        }
                                    }
                                }
                            }
                        }.overlay(alignment:.leading){Rectangle().fill(projectTint(current.id).opacity(0.3)).frame(width:1)}
                    }.frame(maxHeight:220)
                }.padding(.top,24)
                if children.isEmpty{Text(nativeUI("尚无已关联的任务或知识。", "No linked tasks or knowledge yet.")).font(.caption).foregroundStyle(.secondary)}
            } else {empty(nativeUI("项目中的任务、笔记与资料会在这里连接起来。", "Project tasks, notes and sources come together here."),"point.3.connected.trianglepath.dotted")}
        }
    }
    private func empty(_ title:String,_ symbol:String)->some View{Label(title,systemImage:symbol).font(.system(size:11)).foregroundStyle(.secondary).padding(.vertical,30).frame(maxWidth:.infinity,alignment:.leading)}
}


/// A searchable project popover keeps selection in context instead of opening an OS menu.
private struct ProjectChoice:View {
    @ObservedObject private var nativeLanguage = NativeL10n.shared
    let projects:[Item]
    @Binding var selection:String
    @State private var expanded=false
    @State private var query=""
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var title:String{projects.first(where:{$0.id==selection})?.title ?? projects.first?.title ?? nativeUI("选择项目", "Choose a project")}
    var body:some View {
        Button {query="";expanded.toggle()} label:{HStack(spacing:9){Image(systemName:"folder").foregroundStyle(StudioPalette.jade);Text(title).lineLimit(1);Spacer(minLength:4);Image(systemName:"chevron.down").font(.system(size:9,weight:.semibold)).rotationEffect(.degrees(expanded ? 180:0))}.font(.system(size:11,weight:.medium)).padding(11).background(StudioPalette.jade.opacity(0.07),in:RoundedRectangle(cornerRadius:12))}
            .buttonStyle(LiftStyle()).accessibilityLabel(nativeUI("选择知识脉络项目", "Choose a project to explore its connections")).accessibilityValue(title)
            .animation(reduceMotion ? nil:.easeOut(duration:0.16),value:expanded)
            .popover(isPresented:$expanded,arrowEdge:.bottom){VStack(alignment:.leading,spacing:10){Text(nativeUI("项目", "Projects")).font(.system(size:11,weight:.semibold)).foregroundStyle(.secondary)
                if projects.count>6 {TextField(nativeUI("搜索项目", "Search projects"),text:$query).textFieldStyle(.roundedBorder)}
                ScrollView{VStack(spacing:4){ForEach(projects.filter{query.isEmpty || $0.title.localizedCaseInsensitiveContains(query)}){project in
                    Button {selection=project.id;expanded=false} label:{HStack(spacing:10){Circle().fill(projectTint(project.id)).frame(width:7,height:7);Text(project.title).lineLimit(2);Spacer();if project.title==title{Image(systemName:"checkmark").foregroundStyle(StudioPalette.jade)}}.font(.system(size:12)).padding(11).frame(maxWidth:.infinity,alignment:.leading).background(project.title==title ? StudioPalette.jade.opacity(0.1):.clear,in:RoundedRectangle(cornerRadius:10))}.buttonStyle(LiftStyle())
                }}}.frame(maxHeight:260)
            }.padding(14).frame(width:280)}
    }
}
