import Foundation
import SwiftUI

struct AgendaCreationReview:Identifiable {
    let id=UUID()
    let events:[AgendaEvent]
    let owner:URL
    let verify:@MainActor () async -> Bool
}

/// A sheet owned by the workspace, not the calendar route. Closing it reveals the same chat.
struct AgendaCreationReviewView:View {
    @ObservedObject var model:Workspace
    @ObservedObject var store:AgendaStore
    let review:AgendaCreationReview
    @Environment(\.dismiss) private var dismiss
    @State private var selected:Set<String>
    @State private var editing:AgendaEvent?
    @State private var saving=false
    @State private var issue=""
    init(model:Workspace,store:AgendaStore,review:AgendaCreationReview) {
        self.model=model;self.store=store;self.review=review
        _selected=State(initialValue:Set(review.events.map(\.id)))
    }
    private var saved:Set<String>{Set(store.events.map(\.id))}
    private var pending:[AgendaEvent]{review.events.filter{!saved.contains($0.id)}}
    private var picked:[AgendaEvent]{pending.filter{selected.contains($0.id)}}
    private func when(_ event:AgendaEvent)->String {
        let formatter=DateFormatter();formatter.locale=NativeL10n.locale;formatter.timeZone=TimeZone(identifier:event.timeZone)
        formatter.dateStyle = .medium;formatter.timeStyle = .short
        let start=formatter.string(from:event.start);formatter.dateStyle = .none
        return start+" – "+formatter.string(from:event.end)+" · "+event.timeZone
    }
    private func rules(_ event:AgendaEvent)->String {
        let frequencies=["daily":nativeUI("每天", "Daily"),"weekly":nativeUI("每周", "Weekly"),"monthly":nativeUI("每月", "Monthly")]
        let repeatText=event.frequency == "none" ? nativeUI("不重复", "Does not repeat"):nativeUI("重复：", "Repeats: ")+(frequencies[event.frequency] ?? event.frequency)
        let reminder=event.reminderMinutes.map{nativeUI("提前 \($0) 分钟提醒", "Reminder \($0) minutes before")} ?? nativeUI("不提醒", "No reminder")
        return repeatText+" · "+reminder
    }
    private func confirm() {
        let events=picked;guard !saving,!events.isEmpty else{return};saving=true;issue=""
        Task { @MainActor in
            defer{saving=false}
            do {
                guard await review.verify(),model.ready,model.snapshot?.privateMode == false,store.storageIdentity==review.owner else {throw AgendaError.message(nativeUI("提案或来源已变化，未保存。请关闭后重新生成。", "The proposal or source changed. Nothing was saved. Close and generate it again."))}
                let scope=AgendaEditingScope(projects:(model.snapshot?.projects ?? []).map{AgendaEditingProject(id:$0.id,title:$0.title)},documents:(model.snapshot?.documents ?? []).map{AgendaEditingDocument(id:$0.id,title:$0.title,projectID:$0.projectId,kind:$0.kind)})
                for event in events {try scope.validate(event,expected:nil)}
                _ = try store.createProposals(events)
                if pending.isEmpty{dismiss()}
            }catch{issue=error.localizedDescription}
        }
    }
    var body:some View {
        VStack(spacing:0) {
            HStack(alignment:.top) {
                VStack(alignment:.leading,spacing:6) {
                    Text(nativeUI("审阅日程", "Review events")).font(.title2.weight(.semibold))
                    Text(nativeUI("已保存 \(review.events.count-pending.count) / \(review.events.count) 条", "Saved \(review.events.count-pending.count) of \(review.events.count)")).font(.callout).foregroundStyle(.secondary)
                }
                Spacer()
                Button(nativeUI("关闭", "Close")){dismiss()}.disabled(saving).keyboardShortcut(.cancelAction)
            }.padding(24)
            Divider()
            ScrollView {
                VStack(spacing:0) {
                    ForEach(review.events){proposal in
                        let event=store.events.first(where:{$0.id==proposal.id}) ?? proposal
                        HStack(alignment:.top,spacing:12) {
                            if saved.contains(event.id){Image(systemName:"checkmark.circle.fill").foregroundStyle(StudioPalette.jade).frame(width:20)}
                            else{Toggle("",isOn:Binding(get:{selected.contains(event.id)},set:{if $0{selected.insert(event.id)}else{selected.remove(event.id)}})).labelsHidden().toggleStyle(.checkbox).accessibilityLabel(nativeUI("选择日程：", "Select event: ")+event.title).disabled(saving)}
                            VStack(alignment:.leading,spacing:7) {
                                Text(event.title).font(.headline).textSelection(.enabled)
                                if event.deleted{Text(nativeUI("已取消", "Cancelled")).font(.caption).foregroundStyle(.secondary)}
                                Text(when(event)).font(.callout).foregroundStyle(.secondary)
                                if !event.location.isEmpty {Label(event.location,systemImage:"mappin.and.ellipse").font(.callout).foregroundStyle(.secondary)}
                                Text(rules(event)).font(.caption).foregroundStyle(.secondary)
                                if event.details.contains("结束时间未指定") {Text(nativeUI("结束时间未指定，当前按 1 小时显示，可在编辑中调整。", "No end time was specified. The current duration is 1 hour; edit to adjust.")).font(.caption).foregroundStyle(.secondary)}
                            }.frame(maxWidth:.infinity,alignment:.leading)
                            if !saved.contains(event.id){Button(nativeUI("编辑", "Edit")){editing=event}.disabled(saving)}
                        }.padding(.vertical,18)
                        if event.id != review.events.last?.id {Divider()}
                    }
                }.padding(.horizontal,24)
            }
            Divider()
            VStack(alignment:.leading,spacing:12) {
                if !issue.isEmpty{Text(issue).foregroundStyle(.red).font(.callout).textSelection(.enabled)}
                HStack {
                    if !pending.isEmpty {Button(selected.isSuperset(of:Set(pending.map(\.id))) ? nativeUI("取消全选", "Deselect all"):nativeUI("全选", "Select all")){if selected.isSuperset(of:Set(pending.map(\.id))){selected=[]}else{selected=Set(pending.map(\.id))}}.disabled(saving)}
                    Spacer()
                    if saving{ProgressView().controlSize(.small)}
                    Button(nativeUI("确认保存 \(picked.count) 条", "Save \(picked.count) events")){confirm()}.buttonStyle(.borderedProminent).disabled(saving || picked.isEmpty).keyboardShortcut(.defaultAction)
                }
            }.padding(24)
        }.frame(width:640,height:min(680,CGFloat(review.events.count)*130+210)).background(StudioPalette.canvas)
        .interactiveDismissDisabled(saving)
        .sheet(item:$editing){event in AgendaEditor(model:model,store:store,event:event,verifySave:{await review.verify() && store.storageIdentity==review.owner}).id(event.id)}
    }
}
