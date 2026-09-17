import SwiftUI
import AppKit
import UniformTypeIdentifiers
import PDFKit
import Vision

private enum ScheduleTextReader {
    static func read(_ url:URL) throws -> String {
        if url.pathExtension.lowercased()=="pdf" {
            guard let document=PDFDocument(url:url) else {throw AgendaError.message(nativeUI("无法打开 PDF。", "Unable to open the PDF."))}
            var output:[String]=[]
            for index in 0..<document.pageCount {
                try Task.checkCancellation();guard let page=document.page(at:index) else{continue}
                let text=page.string ?? ""
                if text.trimmingCharacters(in:.whitespacesAndNewlines).count>20 {output.append(nativeUI("第 \(index+1) 页\n", "Page \(index+1)\n")+text)}
                else {let image=page.thumbnail(of:NSSize(width:1800,height:2400),for:.mediaBox);guard let cg=image.cgImage(forProposedRect:nil,context:nil,hints:nil) else{throw AgendaError.message(nativeUI("第 \(index+1) 页无法识别", "Unable to recognize page \(index+1)"))};output.append(nativeUI("第 \(index+1) 页\n", "Page \(index+1)\n")+(try recognize(cg)))}
            }
            return output.joined(separator:"\n\n")
        }
        guard let image=NSImage(contentsOf:url),let cg=image.cgImage(forProposedRect:nil,context:nil,hints:nil) else {throw AgendaError.message(nativeUI("无法读取图片。", "Unable to read the image."))}
        return try recognize(cg)
    }
    private static func recognize(_ image:CGImage)throws->String {
        let request=VNRecognizeTextRequest();request.recognitionLevel = .accurate;request.recognitionLanguages=["zh-Hans","en-US"];request.usesLanguageCorrection=true
        try VNImageRequestHandler(cgImage:image).perform([request]);return (request.results ?? []).compactMap{$0.topCandidates(1).first?.string}.joined(separator:"\n")
    }
}
struct AgendaImportView:View {
    @ObservedObject private var nativeLanguage = NativeL10n.shared
    @ObservedObject var model:Workspace
    @ObservedObject var store:AgendaStore
    @Environment(\.dismiss) private var dismiss
    @State private var format="ics"
    @State private var text=""
    @State private var semester=Date()
    @State private var zone=TimeZone.current.identifier
    @State private var project=""
    @State private var replacing=false
    @State private var review:AgendaImportResult?
    @State private var selected=Set<String>()
    @State private var issue=""
    @State private var busy=false
    @State private var work:Task<Void,Never>?
    @State private var ambiguities:[String]=[]
    var body:some View {
        VStack(alignment:.leading,spacing:16) {
            header; formatPicker; semesterPicker; helpText; textInput; importOptions; progress; actions
            if !issue.isEmpty {Text(issue).font(.caption).foregroundStyle(.red)}
            previewRows
        }.padding(24).frame(width:740,height:700).background(StudioPalette.canvas).interactiveDismissDisabled(busy).onDisappear{work?.cancel()}
    }
    @ViewBuilder private var header:some View {
            HStack{Text(nativeUI("导入课程与会议", "Import courses & meetings")).font(.title2.bold());Spacer();Button(nativeUI("关闭", "Close")){work?.cancel();model.web.evaluateJavaScript("window.NativeAgendaAI?.cancel()",completionHandler:nil);dismiss()}}
    }
    @ViewBuilder private var formatPicker:some View {
            HStack{ForEach([("ics",nativeUI("日历 .ics", "Calendar .ics")),("csv",nativeUI("课程表 CSV", "Timetable CSV")),("scan",nativeUI("图片 / PDF", "Image / PDF"))],id:\.0){key,label in Button{format=key;review=nil;issue=""}label:{Text(label).padding(10).background(format==key ? StudioPalette.jade.opacity(0.12):.clear,in:Capsule())}.buttonStyle(.plain).disabled(busy)};Spacer();Button(nativeUI("选择文件", "Choose file")){choose()}.disabled(busy)}
    }
    private var courseCalendar:Calendar {var calendar=Calendar(identifier:.gregorian);calendar.timeZone=TimeZone(identifier:zone) ?? .current;return calendar}
    @ViewBuilder private var semesterPicker:some View {
            if format != "ics" {HStack{DatePicker(nativeUI("第一周周一", "Monday of week 1"),selection:$semester,displayedComponents:.date).environment(\.calendar,courseCalendar).environment(\.timeZone,courseCalendar.timeZone);Spacer();AgendaChoice(title:nativeUI("课表时区", "Timetable time zone"),value:$zone,options:TimeZone.knownTimeZoneIdentifiers.map{($0,$0)}).frame(width:200)}.onChange(of:semester){_,_ in review=nil}.onChange(of:zone){_,_ in review=nil}}
    }
    @ViewBuilder private var helpText:some View {
            if format=="scan" {
                Text(nativeUI("先在本机提取文字，再使用当前对话模型整理。补充节次对应时间与周次后，点击 AI 整理；识别结果需要校对。", "Extract text locally, then organize it with the current chat model. Add class times and week numbers before using AI. Review the recognized results.")).font(.caption).foregroundStyle(.secondary)
            }else if format=="csv" {HStack{Text(nativeUI("使用钟点时间；单/双周以第一周为基准。可把 AI 返回的 CSV 粘贴在下方。", "Use clock times. Odd/even weeks count from week 1. Paste the CSV returned by AI below.")).font(.caption);Spacer();Button(nativeUI("填入示例模板", "Use example template")){text=AgendaImport.courseTemplate;review=nil}}}
    }
    @ViewBuilder private var textInput:some View {
            TextEditor(text:$text).font(.system(size:12,design:.monospaced)).frame(minHeight:120,maxHeight:180).overlay(RoundedRectangle(cornerRadius:10).stroke(StudioPalette.line)).onChange(of:text){_,_ in review=nil}
    }
    @ViewBuilder private var importOptions:some View {
            HStack{AgendaChoice(title:nativeUI("导入所属项目", "Import into project"),value:$project,options:[("",nativeUI("保持独立日程", "Keep events independent"))]+(model.snapshot?.projects ?? []).map{($0.id,$0.title)});Toggle(nativeUI("更新同 UID 的已有日程", "Update existing events with the same UID"),isOn:$replacing).font(.caption)}
    }
    @ViewBuilder private var progress:some View {
            if busy {HStack{ProgressView().controlSize(.small);Text(nativeUI("正在处理课表…", "Processing timetable…"));Button(nativeUI("停止", "Stop")){work?.cancel();model.web.evaluateJavaScript("window.NativeAgendaAI?.cancel()",completionHandler:nil);busy=false}}}
    }
    @ViewBuilder private var actions:some View {
            HStack{Button(format=="scan" ? nativeUI("AI 整理成课表", "Organize with AI"):nativeUI("生成导入预览", "Preview import")){if format=="scan"{extractAI()}else{parse()}}.buttonStyle(.borderedProminent).disabled(busy||text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty);if let review{Text(nativeUI("\(review.events.count) 条有效 · \(selected.count) 条待导入", "\(review.events.count) valid · \(selected.count) selected")).font(.caption)};Spacer();Button(nativeUI("导入所选", "Import selected")){commit()}.disabled(review==nil||selected.isEmpty||busy)}
    }
    private var previewRows:some View {
        ScrollView {
            VStack(alignment:.leading,spacing:8) {
                ForEach(Array(ambiguities.enumerated()),id:\.offset) { item in
                    Label(item.element,systemImage:"exclamationmark.circle").font(.caption).foregroundStyle(StudioPalette.amber)
                }
                if let result=review {
                    ForEach(Array(result.warnings.enumerated()),id:\.offset) {item in
                        Label(item.element,systemImage:"exclamationmark.triangle").font(.caption).foregroundStyle(StudioPalette.amber)
                    }
                    ForEach(result.events) {event in importRow(event)}
                }
            }
        }.frame(maxHeight:.infinity)
    }
    private func importRow(_ event:AgendaEvent)->some View {
        let unit=["daily":nativeUI("天", "days"),"weekly":nativeUI("周", "weeks"),"monthly":nativeUI("月", "months")][event.frequency] ?? ""
        let rule=event.frequency=="none" ? nativeUI("单次", "Once"):nativeUI("每 \(event.interval) \(unit)", "Every \(event.interval) \(unit)")+(event.count.map{nativeUI(" · 共 \($0) 次", " · \($0) occurrences")} ?? "")+(event.until.map{nativeUI(" · 至 \($0.nativeFormatted(date:.abbreviated,time:.omitted))", " · until \($0.nativeFormatted(date:.abbreviated,time:.omitted))")} ?? "")
        let subtitle=[agendaKind(event.kind),event.start.nativeFormatted(),event.location,rule].filter{!$0.isEmpty}.joined(separator:" · ")
        let binding=Binding<Bool>(get:{selected.contains(event.id)},set:{yes in if yes{selected.insert(event.id)}else{selected.remove(event.id)}})
        return Toggle(isOn:binding) {
            VStack(alignment:.leading,spacing:3) {
                Text(event.title).fontWeight(.medium)
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
                if store.events.contains(where:{$0.id==event.id}) {
                    Text(replacing ? nativeUI("将更新已有日程", "Will update existing event"):nativeUI("已存在，将跳过", "Already exists; will skip")).font(.caption).foregroundStyle(StudioPalette.amber)
                }
            }
        }.padding(8)
    }
    private func choose(){let panel=NSOpenPanel();panel.allowsMultipleSelection=false;panel.allowedContentTypes=format=="scan" ? [.pdf,.image]:format=="csv" ? [.commaSeparatedText,.plainText]:[UTType(filenameExtension:"ics") ?? .plainText];panel.begin{response in guard response == .OK,let url=panel.url else{return};if format=="scan"{busy=true;work=Task{do{let job=Task.detached{try ScheduleTextReader.read(url)};let result=try await withTaskCancellationHandler(operation:{try await job.value},onCancel:{job.cancel()});try Task.checkCancellation();text=result;if result.isEmpty{issue=nativeUI("未识别到文字，可换一张清晰图片。", "No text found. Try a clearer image.")}}catch{if !Task.isCancelled{issue=error.localizedDescription}};busy=false}}else{do{text=try String(contentsOf:url,encoding:.utf8);review=nil}catch{issue=nativeUI("请提供 UTF-8 编码文件：", "Please use a UTF-8 encoded file: ")+error.localizedDescription}}}}
    private func extractAI(){busy=true;issue="";review=nil;work=Task{do{let result=try await model.web.callAsyncJavaScript("return await window.NativeAgendaAI.extract(text)",arguments:["text":text],in:nil,contentWorld:.page);try Task.checkCancellation();guard let object=result as? [String:Any],let csv=object["csv"] as? String else{throw AgendaError.message(nativeUI("模型返回格式无效", "The model returned an invalid format"))};ambiguities=object["uncertainties"] as? [String] ?? [];text=csv;format="csv"}catch{if !Task.isCancelled{issue=error.localizedDescription}};busy=false}}
    private func parse(){issue="";if format=="csv",courseCalendar.component(.weekday,from:semester) != 2 {issue=nativeUI("请选择学期第一周的周一。", "Select the Monday of the first semester week.");return};let parsed=format=="ics" ? AgendaImport.ics(text,fallbackZone:zone):AgendaImport.courses(text,semester:semester,zone:zone);var seen=Set<String>();let unique=parsed.events.filter{seen.insert($0.id).inserted};review=AgendaImportResult(events:unique,warnings:parsed.warnings+(unique.count<parsed.events.count ? [nativeUI("文件内重复条目已合并。", "Duplicate entries in the file were merged.")]:[]));selected=Set(unique.map(\.id))}
    private func commit(){guard let review else{return};do{try store.importEvents(review.events.filter{selected.contains($0.id)},replace:replacing,projectID:project);dismiss()}catch{issue=error.localizedDescription}}
}

struct AgendaReminderSettings:View {
    @ObservedObject private var nativeLanguage = NativeL10n.shared
    @ObservedObject var store:AgendaStore
    @Environment(\.dismiss) private var dismiss
    @State private var settings=AgendaPreferences()
    @State private var issue=""
    var body:some View {
        VStack(alignment:.leading,spacing:18){HStack{Text(nativeUI("日程提醒", "Agenda reminders")).font(.title2.bold());Spacer();Button(nativeUI("关闭", "Close")){dismiss()}}
            Label(NativeL10n.notificationStatus(store.notificationStatus),systemImage:"bell").font(.callout)
            Button(nativeUI("允许系统通知", "Allow system notifications")){Task{await store.requestNotifications();settings=store.preferences}}
            Toggle(nativeUI("启用日程提醒", "Enable event reminders"),isOn:$settings.notifications)
            AgendaChoice(title:nativeUI("任务截止提醒", "Task deadline reminders"),value:Binding(get:{settings.taskReminderMinutes.map(String.init) ?? "off"},set:{settings.taskReminderMinutes=Int($0)}),options:[("off",nativeUI("任务不提醒", "No task reminders")),("0",nativeUI("截止时提醒", "At the deadline")),("15",nativeUI("提前 15 分钟", "15 minutes before")),("60",nativeUI("提前 1 小时", "1 hour before")),("1440",nativeUI("提前 1 天", "1 day before"))])
            Toggle(nativeUI("每天提醒今日安排", "Daily agenda reminder"),isOn:$settings.briefing)
            if settings.briefing {HStack{Stepper(nativeUI("\(settings.briefingHour) 时", "Hour: \(settings.briefingHour)"),value:$settings.briefingHour,in:0...23);Stepper(nativeUI("\(settings.briefingMinute) 分", "Minute: \(settings.briefingMinute)"),value:$settings.briefingMinute,in:0...59)}}
            Toggle(nativeUI("在通知中显示日程标题", "Show event titles in notifications"),isOn:$settings.showTitles)
            Text(nativeUI("任务单独设置的提醒优先；普通任务沿用以上设置。首次允许通知时启用任务提前 1 小时提醒。仅填写日期的任务按当天 09:00 作为提醒基准，不会改写其截止时间。默认隐藏通知正文中的个人安排。已排程通知交由 macOS；专注模式或系统设置可能影响展示。每日提醒由系统持续重复。具体日程在应用运行时每 5 分钟及每次修改后补排未来 30 天内最近的 60 条，待补排数量会显示；长期不打开应用，具体日程的后续通知不会自动补排。", "Per-task reminders override this default. First-time notification setup enables one-hour task reminders. Date-only tasks use 09:00 for reminders without changing their deadlines. Event details are hidden by default. macOS delivers scheduled notifications; Focus and system settings can affect delivery. Daily briefings repeat automatically. While the app is running, it schedules the next 60 event reminders within 30 days, refreshing every 5 minutes and after edits. Remaining reminders are counted. Open the app periodically to schedule later events.")).font(.caption).foregroundStyle(.secondary)
            HStack{Button(nativeUI("发送测试通知", "Send test notification")){Task{await store.testNotification()}}.disabled(!store.preferences.notifications);Spacer();Button(nativeUI("保存提醒设置", "Save reminder settings")){do{try store.updatePreferences(settings);dismiss()}catch{issue=error.localizedDescription}}.buttonStyle(.borderedProminent)}
            if !issue.isEmpty{Text(issue).foregroundStyle(.red)}
        }.padding(26).frame(width:540).background(StudioPalette.canvas).onAppear{settings=store.preferences}
    }
}
