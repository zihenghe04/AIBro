import SwiftUI

/// The "今天" home page: the brief, today's events and the tasks that need
/// attention. A skeleton on existing tokens; motion is designed separately.
struct TodayView:View {
    @ObservedObject private var nativeLanguage=NativeL10n.shared
    @ObservedObject var model:Workspace
    @ObservedObject var store:AgendaStore
    @ObservedObject var workbench:NativeQuickWorkbenchStore
    @State private var brief:TodayBrief? = nil
    @State private var briefNotice:String? = nil
    @State private var generating=false
    var body:some View {
        GeometryReader { geometry in
            TimelineView(.periodic(from:.now,by:60)) { context in
                let digest=digest(context.date)
                ScrollView {
                    VStack(alignment:.leading,spacing:24) {
                        header(digest)
                        TodayQuickAddBar(model:model,store:store,workbench:workbench)
                        briefCard(digest)
                        if geometry.size.width < 900 {
                            VStack(alignment:.leading,spacing:24) {eventsColumn(digest);tasksColumn(digest)}
                        } else {
                            HStack(alignment:.top,spacing:28) {
                                eventsColumn(digest).frame(maxWidth:.infinity,alignment:.topLeading)
                                tasksColumn(digest).frame(maxWidth:.infinity,alignment:.topLeading)
                            }
                        }
                    }.padding(.horizontal,geometry.size.width < 850 ? 30:48).padding(.top,22).padding(.bottom,32).frame(maxWidth:1180)
                    .frame(maxWidth:.infinity)
                }.background(StudioPalette.canvas)
                .task(id:digest.date) {reloadBrief(digest.date)}
            }
        }
    }
    func digest(_ now:Date)->TodayDigest {
        let window=TodayDigest.window(now:now)
        return TodayDigest(occurrences:store.occurrences(from:window.from,to:window.to),tasks:model.snapshot?.tasks ?? [],now:now)
    }
    func reloadBrief(_ day:String) {brief=TodayBrief.load(dataDirectory:model.dataDirectory,day:day)}

    func header(_ digest:TodayDigest)->some View {
        VStack(alignment:.leading,spacing:8) {
            Text(nativeUI("今天", "TODAY")).font(.system(size:11,weight:.medium)).tracking(2).foregroundStyle(.secondary)
            Text(digest.now.nativeFormatted(.dateTime.month().day().weekday(.wide))).font(.system(size:28,weight:.semibold))
            Text(countsLine(digest)).font(.system(size:12)).foregroundStyle(.secondary)
        }.accessibilityElement(children:.combine)
    }
    func countsLine(_ digest:TodayDigest)->String {
        if digest.empty {return nativeUI("今天没有日程，也没有到期或遗留的任务。", "No events today and nothing due or left over.")}
        var parts:[String]=[]
        if !digest.events.isEmpty {parts.append(nativeUI("\(digest.events.count) 个日程", "\(digest.events.count) events"))}
        if !digest.due.isEmpty {parts.append(nativeUI("\(digest.due.count) 项今天到期", "\(digest.due.count) due today"))}
        if !digest.carryover.isEmpty {parts.append(nativeUI("\(digest.carryover.count) 项昨天没做完", "\(digest.carryover.count) left from yesterday"))}
        if !digest.overdue.isEmpty {parts.append(nativeUI("\(digest.overdue.count) 项更早过期", "\(digest.overdue.count) overdue"))}
        return parts.joined(separator:" · ")
    }

    func briefCard(_ digest:TodayDigest)->some View {
        VStack(alignment:.leading,spacing:12) {
            HStack(spacing:8) {
                Label(nativeUI("今日简报", "Today's brief"),systemImage:"text.alignleft").font(.system(size:13,weight:.semibold))
                Spacer()
                if let brief {
                    Text(briefMeta(brief)).font(.system(size:10)).foregroundStyle(.secondary)
                }
                Button {model.openWorkspaceSettings(category:"notifications")} label:{
                    Image(systemName:"gearshape").font(.system(size:11))
                }.buttonStyle(LiftStyle()).help(nativeUI("简报设置：时间、开关和声音", "Brief settings: time, switch and sounds"))
                .accessibilityLabel(nativeUI("简报设置", "Brief settings"))
                Button {generate(digest.date)} label:{
                    Label(brief == nil ? nativeUI("现在生成", "Generate now"):nativeUI("重新整理", "Refresh"),systemImage:"arrow.clockwise").font(.system(size:11))
                }.buttonStyle(LiftStyle()).disabled(!model.ready || generating)
                .help(nativeUI("按今天的日程和任务整理简报；设置了问答模型时再由它写一段", "Assemble the brief from today's agenda and tasks; the Q&A model adds a paragraph if one is set"))
            }
            if let brief {
                if let text=brief.text,!text.isEmpty {Text(text).font(.system(size:13)).textSelection(.enabled)}
                else {
                    VStack(alignment:.leading,spacing:6) {
                        ForEach(Array((brief.lines ?? []).enumerated()),id:\.offset) {_,line in Text(line).font(.system(size:13))}
                    }.textSelection(.enabled)
                }
                if let briefNotice {
                    Text(briefNotice).font(.system(size:10)).foregroundStyle(StudioPalette.amber)
                }
                if brief.partial == true {
                    Text(nativeUI("部分导入的重复日程按近似规则展开，时间以日程页为准。", "Some imported recurring events are approximate; the agenda page is authoritative.")).font(.system(size:10)).foregroundStyle(StudioPalette.amber)
                }
            } else {
                Text(nativeUI("今日简报尚未生成", "Today's brief is not ready yet")).font(.system(size:13)).foregroundStyle(.secondary)
                Text(nativeUI("每天 08:30 自动整理一次，也可以现在生成。", "It is assembled every day at 08:30, or generate it now.")).font(.system(size:11)).foregroundStyle(.tertiary)
            }
        }.padding(18).frame(maxWidth:.infinity,alignment:.leading)
        .background(StudioPalette.panel,in:RoundedRectangle(cornerRadius:16))
        .overlay(RoundedRectangle(cornerRadius:16).strokeBorder(StudioPalette.line.opacity(0.45),lineWidth:0.5))
    }
    func briefMeta(_ brief:TodayBrief)->String {
        let source=brief.source == "ai" ? nativeUI("AI 整理", "AI"):nativeUI("规则整理", "Rules")
        guard let saved=brief.savedAt else{return source}
        return source+" · "+Date(timeIntervalSince1970:saved).nativeFormatted(.dateTime.hour().minute())
    }
    func generate(_ day:String) {
        generating=true
        Task {
            briefNotice=await model.generateTodayBrief()
            generating=false
            reloadBrief(day)
        }
    }

    func eventsColumn(_ digest:TodayDigest)->some View {
        section(nativeUI("日程", "Agenda"),count:digest.events.count) {
            if digest.events.isEmpty {placeholder(nativeUI("今天没有日程", "No events today"))}
            ForEach(digest.events.prefix(TodayDigest.limit)) {item in eventRow(item)}
            more(digest.events.count)
        }
    }
    func tasksColumn(_ digest:TodayDigest)->some View {
        VStack(alignment:.leading,spacing:24) {
            section(nativeUI("今天到期", "Due today"),count:digest.due.count) {
                if digest.due.isEmpty {placeholder(nativeUI("今天没有到期的任务", "Nothing due today"))}
                ForEach(digest.due.prefix(TodayDigest.limit)) {item in taskRow(item,digest:digest)}
                more(digest.due.count)
            }
            if !digest.carryover.isEmpty {
                section(nativeUI("昨天没做完", "Left from yesterday"),count:digest.carryover.count) {
                    ForEach(digest.carryover.prefix(TodayDigest.limit)) {item in taskRow(item,digest:digest)}
                    more(digest.carryover.count)
                }
            }
            if !digest.overdue.isEmpty {
                section(nativeUI("更早过期", "Overdue"),count:digest.overdue.count) {
                    ForEach(digest.overdue.prefix(TodayDigest.limit)) {item in taskRow(item,digest:digest)}
                    more(digest.overdue.count)
                }
            }
        }
    }
    func section<Content:View>(_ title:String,count:Int,@ViewBuilder content:()->Content)->some View {
        VStack(alignment:.leading,spacing:10) {
            HStack(alignment:.firstTextBaseline,spacing:8) {
                Text(title).font(.system(size:18,weight:.semibold))
                if count>0 {Text(count,format:.number).font(.system(size:12)).monospacedDigit().foregroundStyle(.secondary)}
            }.accessibilityAddTraits(.isHeader)
            content()
        }
    }
    func placeholder(_ text:String)->some View {
        Text(text).font(.system(size:12)).foregroundStyle(.secondary).padding(16).frame(maxWidth:.infinity,alignment:.leading)
            .background(StudioPalette.panel.opacity(0.6),in:RoundedRectangle(cornerRadius:16))
    }
    @ViewBuilder func more(_ count:Int)->some View {
        if count>TodayDigest.limit {
            Button(nativeUI("还有 \(count-TodayDigest.limit) 项，在日程页查看", "\(count-TodayDigest.limit) more in Agenda")) {model.openWorkspace("agenda")}
                .font(.system(size:11)).buttonStyle(.plain).foregroundStyle(.secondary)
        }
    }

    func eventRow(_ item:TodayItem)->some View {
        Button {openAgenda(item)} label:{
            HStack(alignment:.top,spacing:14) {
                Text(timeText(item)).font(.system(size:12,weight:.medium)).monospacedDigit().frame(width:92,alignment:.leading)
                    .foregroundStyle(item.state == "past" ? .tertiary:.secondary)
                VStack(alignment:.leading,spacing:5) {
                    Text(item.title).font(.system(size:13,weight:.medium)).lineLimit(2).foregroundStyle(item.state == "past" ? .secondary:.primary)
                    if !item.location.isEmpty {Text(item.location).font(.system(size:10)).foregroundStyle(.secondary).lineLimit(1)}
                }
                Spacer(minLength:0)
                if let badge=stateBadge(item.state) {
                    Text(badge).font(.system(size:10,weight:.medium)).foregroundStyle(StudioPalette.jade)
                        .padding(.horizontal,7).padding(.vertical,3).background(StudioPalette.jade.opacity(0.12),in:Capsule())
                }
            }.padding(.vertical,14).padding(.horizontal,16).frame(maxWidth:.infinity,alignment:.leading).contentShape(Rectangle())
        }.buttonStyle(LiftStyle())
        .background(StudioPalette.panel,in:RoundedRectangle(cornerRadius:16))
        .overlay(RoundedRectangle(cornerRadius:16).strokeBorder(StudioPalette.line.opacity(0.45),lineWidth:0.5))
        .help(nativeUI("在日程页打开", "Open in Agenda"))
    }
    func timeText(_ item:TodayItem)->String {
        if item.allDay {return nativeUI("全天", "All day")}
        let start=item.at.nativeFormatted(.dateTime.hour(.twoDigits(amPM:.omitted)).minute())
        guard let end=item.end else{return start}
        return start+"–"+end.nativeFormatted(.dateTime.hour(.twoDigits(amPM:.omitted)).minute())
    }
    func stateBadge(_ state:String)->String? {
        state == "now" ? nativeUI("进行中", "Now"):state == "next" ? nativeUI("接下来", "Next"):nil
    }

    func taskRow(_ item:TodayItem,digest:TodayDigest)->some View {
        HStack(alignment:.top,spacing:0) {
            if let task=item.task {TaskCompletionButton(model:model,task:task).padding(.leading,10).padding(.top,10)}
            else {Image(systemName:"checklist").font(.system(size:12)).foregroundStyle(.secondary).frame(width:22).padding(.leading,10).padding(.top,14)}
            Button {if let task=item.task {model.reveal("task",task.id)} else {openAgenda(item)}} label:{
                HStack(alignment:.top,spacing:12) {
                    VStack(alignment:.leading,spacing:6) {
                        Text(item.title).font(.system(size:13,weight:.medium)).foregroundStyle(.primary).lineLimit(2)
                        HStack(spacing:5) {
                            if let task=item.task,!task.workspace.isEmpty {Circle().fill(StudioPalette.space(task.workspace)).frame(width:4,height:4);Text(NativeL10n.space(task.workspace));Text("·")}
                            Text(dueText(item,digest:digest)).foregroundStyle(item.late || item.at<Calendar.current.startOfDay(for:digest.now) ? StudioPalette.coral:Color.secondary)
                            if item.priority == "high" {Text("·");Text(nativeUI("高优先级", "High priority")).foregroundStyle(StudioPalette.amber)}
                        }.font(.system(size:10)).foregroundStyle(.secondary)
                    }
                    Spacer(minLength:0)
                    Image(systemName:"chevron.right").font(.system(size:9)).foregroundStyle(.tertiary).padding(.top,4)
                }.padding(.vertical,14).padding(.trailing,16).padding(.leading,6)
                    .frame(maxWidth:.infinity,alignment:.leading).contentShape(Rectangle())
            }.buttonStyle(LiftStyle()).help(item.task == nil ? nativeUI("在日程页打开", "Open in Agenda"):nativeUI("打开任务详情", "Open task details"))
        }.background(StudioPalette.panel,in:RoundedRectangle(cornerRadius:16))
            .overlay(RoundedRectangle(cornerRadius:16).strokeBorder(StudioPalette.line.opacity(0.45),lineWidth:0.5))
    }
    func dueText(_ item:TodayItem,digest:TodayDigest)->String {
        let calendar=Calendar.current
        let time=item.dayOnly || item.allDay ? "":" "+item.at.nativeFormatted(.dateTime.hour(.twoDigits(amPM:.omitted)).minute())
        if calendar.isDate(item.at,inSameDayAs:digest.now) {
            if item.late {return nativeUI("今天\(time) 已过时间", "Today\(time), past due")}
            return item.dayOnly || item.allDay ? nativeUI("今天截止", "Due today"):nativeUI("今天\(time) 截止", "Due today\(time)")
        }
        if let yesterday=calendar.date(byAdding:.day,value:-1,to:digest.now),calendar.isDate(item.at,inSameDayAs:yesterday) {return nativeUI("昨天\(time)", "Yesterday\(time)")}
        return item.at.nativeFormatted(.dateTime.month().day())+time
    }
    func openAgenda(_ item:TodayItem) {
        if let occurrence=item.occurrence,!occurrence.event.id.hasPrefix("task:") {try? model.openLinkedAgenda(occurrence.event.id);store.focusDate=occurrence.start}
        else {store.focusDate=item.at}
        model.openWorkspace("agenda")
    }
}

extension Workspace {
    /// Asks the main window to assemble today's brief from rules, then asks the
    /// Q&A model (read-only) to write the paragraph on top. Returns a notice when
    /// the model part did not happen; the rules brief is always kept.
    func generateTodayBrief() async -> String? {
        guard ready else{return nativeUI("工作区还没加载好", "The workspace is not ready yet")}
        do {
            let result=try await web.callAsyncJavaScript("const ai=window.NativeTodayAI;if(ai)return await ai.compose({trigger:'manual'});const plugin=window.AIBroTodayPlugin;if(!plugin)return {ok:false,notice:{zh:'简报功能还没加载',en:'The brief is not available yet'}};await plugin.brief({trigger:'manual'});return {ok:true};",arguments:[:],in:nil,contentWorld:.page)
            return TodayBriefOutcome.notice(result)
        } catch {
            return nativeUI("简报没有生成：", "The brief was not generated: ")+error.localizedDescription
        }
    }
}

enum TodayBriefOutcome {
    /// nil on success; otherwise the localized notice from NativeTodayAI.
    static func notice(_ result:Any?)->String? {
        guard let dictionary=result as? [String:Any] else{return nativeUI("简报没有生成", "The brief was not generated")}
        if (dictionary["ok"] as? Bool) == true {return nil}
        if let notice=dictionary["notice"] as? [String:Any],let text=notice[nativeUI("zh", "en")] as? String,!text.isEmpty {return text}
        return nativeUI("简报没有生成", "The brief was not generated")
    }
}
