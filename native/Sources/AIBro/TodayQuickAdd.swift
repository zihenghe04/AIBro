import SwiftUI

/// One sentence to an event or a task. Parsing is the rule set in
/// app/today-parse.js; nothing is written until the user confirms. Events go
/// through the shared review sheet, tasks through the quick workbench.
struct TodayQuickAddBar:View {
    @ObservedObject var model:Workspace
    @ObservedObject var store:AgendaStore
    @ObservedObject var workbench:NativeQuickWorkbenchStore
    @State private var text=""
    @State private var task:TodayTaskDraft?
    @State private var busy=false
    @State private var issue=""
    private var available:Bool {model.ready && model.snapshot?.privateMode == false}
    var body:some View {
        VStack(alignment:.leading,spacing:10) {
            HStack(spacing:10) {
                Image(systemName:"plus.bubble").foregroundStyle(.secondary)
                TextField(nativeUI("一句话添加，例如：明天下午三点组会，提前半小时提醒", "Add in one sentence, e.g. group meeting tomorrow 3pm"),text:$text)
                    .textFieldStyle(.plain).font(.system(size:14)).onSubmit(parse).disabled(!available || busy)
                if busy {ProgressView().controlSize(.small)}
                Button(nativeUI("预览", "Preview"),action:parse).buttonStyle(LiftStyle())
                    .disabled(!available || busy || text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
            }
            .padding(.horizontal,14).padding(.vertical,10)
            .background(StudioPalette.panel,in:RoundedRectangle(cornerRadius:10))
            .overlay(RoundedRectangle(cornerRadius:10).stroke(Color.primary.opacity(0.08)))
            if let task {taskPreview(task)}
            if !issue.isEmpty {Text(issue).font(.system(size:11)).foregroundStyle(StudioPalette.amber)}
            else if let error=workbench.error,task != nil {Text(error).font(.system(size:11)).foregroundStyle(StudioPalette.amber)}
        }
    }
    func taskPreview(_ draft:TodayTaskDraft)->some View {
        HStack(alignment:.firstTextBaseline,spacing:10) {
            Text(nativeUI("任务", "Task")).font(.system(size:10,weight:.semibold)).padding(.horizontal,6).padding(.vertical,2)
                .background(Color.primary.opacity(0.07),in:Capsule())
            VStack(alignment:.leading,spacing:3) {
                Text(draft.title).font(.system(size:13,weight:.medium))
                Text(draft.dueText).font(.system(size:11)).foregroundStyle(.secondary)
            }
            Spacer()
            Button(nativeUI("取消", "Cancel")){task=nil}.buttonStyle(LiftStyle())
            Button(nativeUI("添加", "Add")){addTask(draft)}.buttonStyle(LiftStyle()).keyboardShortcut(.defaultAction)
                .disabled(!available || workbench.creating || !workbench.ready)
        }.padding(12).background(StudioPalette.panel,in:RoundedRectangle(cornerRadius:10))
    }

    func parse() {
        let sentence=text.trimmingCharacters(in:.whitespacesAndNewlines)
        guard available,!busy,!sentence.isEmpty else{return}
        busy=true;issue="";task=nil
        Task { @MainActor in
            defer{busy=false}
            do {
                let result=try await model.web.callAsyncJavaScript("return window.TodayParse ? window.TodayParse.parseRules(text,{}) : null",arguments:["text":sentence],in:nil,contentWorld:.page)
                guard let parsed=result as? [String:Any] else{issue=nativeUI("页面还没准备好，请稍后再试。", "The page is not ready yet. Try again shortly.");return}
                let title=(parsed["title"] as? String ?? "").trimmingCharacters(in:.whitespacesAndNewlines)
                guard !title.isEmpty else{issue=nativeUI("没看出要做什么，请写明事项。", "Couldn't tell what to add. Name the item.");return}
                if parsed["kind"] as? String == "event" {try reviewEvent(parsed,title:title)}
                else {task=TodayTaskDraft(title:title,dueAt:(parsed["dueAt"] as? String).map{.text($0)})}
                if (parsed["reasons"] as? [String] ?? []).contains(where:{["no-date","vague-time"].contains($0)}) {
                    issue=nativeUI("没识别出具体日期或时刻，已按今天处理，请在预览里确认。", "No exact date or time found; it defaults to today. Check the preview.")
                }
            } catch {issue=error.localizedDescription}
        }
    }
    func reviewEvent(_ parsed:[String:Any],title:String) throws {
        guard let owner=store.storageIdentity else{throw AgendaError.message(nativeUI("日程还没加载完。", "The agenda is still loading."))}
        guard model.agendaCreationReview == nil,model.agendaDraft == nil,model.agendaAgent.review == nil,!store.hasUnsavedEditorDrafts else{
            throw AgendaError.message(nativeUI("已有日程正在编辑，请先完成或关闭。", "Another event is being edited. Finish or close it first."))
        }
        guard let start=parsed["start"] as? Double,let end=parsed["end"] as? Double else{throw AgendaError.message(nativeUI("没识别出时间。", "No time found."))}
        var event=AgendaEvent()
        event.title=title;event.start=Date(timeIntervalSince1970:start/1000);event.end=Date(timeIntervalSince1970:end/1000)
        event.allDay=parsed["allDay"] as? Bool ?? false
        if let zone=parsed["timeZone"] as? String,TimeZone(identifier:zone) != nil {event.timeZone=zone}
        event.frequency=parsed["frequency"] as? String ?? "none";event.weekdays=parsed["weekdays"] as? [Int] ?? []
        // Rules return null when the sentence names no reminder: keep the agenda default for timed events.
        event.reminderMinutes=parsed["reminderMinutes"] as? Int ?? (event.allDay ? nil:15)
        event.source=nativeUI("一句话添加", "One-sentence add")
        try event.validate()
        model.agendaCreationReview=AgendaCreationReview(events:[event],owner:owner,verify:{[weak model] in
            guard let model else{return false}
            return model.ready && model.snapshot?.privateMode == false && model.agenda.storageIdentity == owner
        })
        text=""
    }
    func addTask(_ draft:TodayTaskDraft) {
        var fields=NativeQuickTaskFields();fields.dueAt=draft.dueAt
        Task { @MainActor in
            if await workbench.createTask(title:draft.title,fields:fields) {task=nil;text=""}
        }
    }
}

struct TodayTaskDraft:Equatable {
    let title:String
    let dueAt:NativeQuickTaskDate?
    var dueText:String {
        guard let dueAt,let date=dueAt.date else{return nativeUI("不设截止", "No due date")}
        return nativeUI("截止 ", "Due ")+(dueAt.isDay ? date.nativeFormatted(.dateTime.month().day().weekday()):date.nativeFormatted(.dateTime.month().day().weekday().hour().minute()))
    }
}
