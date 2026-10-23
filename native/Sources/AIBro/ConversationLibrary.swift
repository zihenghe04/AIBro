import SwiftUI
import WebKit

struct ConversationEntry:Identifiable,Decodable {
    let id:String;let title:String;let folderId:String;let archived:Bool;let projectId:String?;let updatedAt:Double?
    var pinned:Bool? = nil;var summary:String? = nil;var summaryGoal:String? = nil;var summaryOutcome:String? = nil;var messageCount:Int? = nil
    var isPinned:Bool {pinned == true}
    static func ordered(_ a:Self,_ b:Self)->Bool {if a.isPinned != b.isPinned{return a.isPinned};if a.updatedAt != b.updatedAt{return (a.updatedAt ?? 0)>(b.updatedAt ?? 0)};return a.id<b.id}
}

struct ConversationQuickLook:View {
    @ObservedObject private var nativeLanguage = NativeL10n.shared
    let conversation:ConversationEntry
    let open:()->Void
    @Environment(\.dismiss) private var dismiss
    var body:some View {
        VStack(alignment:.leading,spacing:18) {
            HStack {Label(nativeUI("对话速览","Chat preview"),systemImage:"text.alignleft").font(.headline);Spacer();Button(nativeUI("关闭","Close")){dismiss()}}
            Text(conversation.title).font(.title3.bold()).lineLimit(3)
            ScrollView {VStack(alignment:.leading,spacing:14) {
                if let goal=conversation.summaryGoal,!goal.isEmpty {Text(nativeUI("最近目标","Latest goal")).font(.caption).foregroundStyle(.secondary);Text(goal).textSelection(.enabled)}
                if let outcome=conversation.summaryOutcome,!outcome.isEmpty {Text(nativeUI("最近答复摘录","Latest reply excerpt")).font(.caption).foregroundStyle(.secondary);Text(outcome).textSelection(.enabled)}
                else {Text(nativeUI("尚无对应答复","No matching reply yet")).foregroundStyle(.secondary)}
            }.frame(maxWidth:.infinity,alignment:.leading)}
            HStack {Text(nativeUI("\(conversation.messageCount ?? 0) 条消息 · 原文保留","\(conversation.messageCount ?? 0) messages · Originals retained")).font(.caption).foregroundStyle(.secondary);Spacer();Button(nativeUI("打开对话","Open chat")){dismiss();open()}.buttonStyle(LiftStyle())}
        }.padding(24).frame(width:480,height:380).background(StudioPalette.canvas)
    }
}
struct ConversationFolder:Identifiable,Decodable {let id:String;let title:String;let archived:Bool}
struct ConversationTarget:Identifiable {
    let kind:String;let id:String;let title:String;var folderId="";var archived=false
    init(kind:String,id:String,title:String){self.kind=kind;self.id=id;self.title=title}
    init(_ item:ConversationEntry){kind="conversation";id=item.id;title=item.title;folderId=item.folderId;archived=item.archived}
    init(_ item:ConversationFolder){kind="folder";id=item.id;title=item.title;archived=item.archived}
}
/// One undo for the chat or folder just moved to Trash, matching the web workspace's undo toast.
struct TrashUndo:Identifiable,Equatable {let id:String;let title:String;let folder:Bool}
extension Workspace {
    @discardableResult func manageConversation(_ command:[String:String]) async -> Bool {
        do {
            guard ready else{throw CocoaError(.validationMissingMandatoryProperty)}
            let result=try await web.callAsyncJavaScript("return window.NativeConversationActions.perform(command)",arguments:["command":command],in:nil,contentWorld:.page)
            // A delete answers with the new trash record's id so it can be undone.
            if command["action"]=="delete",let trashID=result as? String,!trashID.isEmpty {trashUndo=TrashUndo(id:trashID,title:command["name"] ?? "",folder:command["kind"]=="folder");return true}
            return result as? Bool == true
        }catch{self.error=error.localizedDescription;return false}
    }
    func undoTrash(_ undo:TrashUndo) async {
        if trashUndo?.id==undo.id {trashUndo=nil}
        do {
            let result=try await web.callAsyncJavaScript("return window.NativeConversationActions.perform(command)",arguments:["command":["action":"undoTrash","id":undo.id]],in:nil,contentWorld:.page)
            if result as? Bool != true {error=nativeUI("这条记录已不在回收站，无法撤销。", "This item is no longer in Trash, so it can't be undone.")}
        }catch{self.error=error.localizedDescription}
    }
}
/// Bottom capsule offering Undo for six seconds after a chat moves to Trash.
struct TrashUndoBanner:View {
    @ObservedObject private var nativeLanguage = NativeL10n.shared
    @ObservedObject var model:Workspace
    var body:some View {
        if let undo=model.trashUndo {
            HStack(spacing:12) {
                Text(undo.folder ? nativeUI("已将文件夹“\(undo.title)”移入回收站", "Moved folder “\(undo.title)” to Trash"):nativeUI("已将“\(undo.title)”移入回收站", "Moved “\(undo.title)” to Trash")).lineLimit(2)
                Button(nativeUI("撤销", "Undo")){Task{await model.undoTrash(undo)}}.buttonStyle(.borderless).fontWeight(.semibold)
            }
            .font(.callout).padding(.horizontal,18).padding(.vertical,9)
            .background(.regularMaterial,in:Capsule()).shadow(color:.black.opacity(0.12),radius:10,y:3)
            .padding(.bottom,28).transition(.move(edge:.bottom).combined(with:.opacity))
            .accessibilityElement(children:.contain)
            .task(id:undo.id){try? await Task.sleep(nanoseconds:6_000_000_000);if model.trashUndo?.id==undo.id {withAnimation{model.trashUndo=nil}}}
        }
    }
}
struct ConversationManager:View {
    @ObservedObject private var nativeLanguage = NativeL10n.shared
    @ObservedObject var model:Workspace
    let target:ConversationTarget
    @State private var name=""
    @State private var folder=""
    @State private var working=false
    @State private var failed=false
    @Environment(\.dismiss) private var dismiss
    var body:some View {
        VStack(alignment:.leading,spacing:20) {
            HStack{Label(target.id.isEmpty ? nativeUI("新建对话文件夹", "New chat folder"):target.kind=="folder" ? nativeUI("管理文件夹", "Manage folder"):nativeUI("管理对话", "Manage chat"),systemImage:target.kind=="folder" ? "folder":"bubble.left").font(.title2.bold());Spacer();Button(nativeUI("取消", "Cancel")){dismiss()}}
            TextField(target.kind=="folder" ? nativeUI("文件夹名称", "Folder name"):nativeUI("对话名称", "Chat name"),text:$name).textFieldStyle(.roundedBorder)
            if target.kind=="conversation" {
                AgendaChoice(title:nativeUI("放入文件夹", "Move to folder"),value:$folder,options:[("",nativeUI("未分组对话", "Unfiled chats"))]+(model.snapshot?.conversationFolders ?? []).filter{!$0.archived}.map{($0.id,$0.title)})
            }
            if !target.id.isEmpty {
                Divider()
                HStack {
                    Button(target.archived ? nativeUI("取消归档", "Unarchive"):nativeUI("归档", "Archive")){run(target.archived ? "restore":"archive")}
                    Spacer()
                    Button(nativeUI("移入回收站", "Move to Trash"),role:.destructive){run("delete")}
                }
                Text(target.kind=="folder" ? nativeUI("归档会收起文件夹中的对话；取消归档时会恢复。移入回收站后可立即撤销，或在回收站恢复。", "Archiving hides the chats in this folder. Unarchive it to restore them. Moving to Trash can be undone right away or restored from Trash."):nativeUI("归档后的对话可在“对话”页面的归档入口恢复。移入回收站后可立即撤销，或在回收站恢复。", "Restore archived chats from the archive on the Chats page. Moving to Trash can be undone right away or restored from Trash.")).font(.caption).foregroundStyle(.secondary)
            }
            if failed{Text(nativeUI("保存未完成，请关闭后重试。", "Could not save. Close this dialog and try again.")).font(.caption).foregroundStyle(.red)}
            HStack{Spacer();Button(working ? nativeUI("正在保存…", "Saving…"):nativeUI("保存", "Save")){run(target.id.isEmpty ? "create":"save")}.buttonStyle(.borderedProminent).disabled(name.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)}
        }.padding(26).frame(width:440).background(StudioPalette.canvas).disabled(working)
        .onAppear{name=target.title;folder=(model.snapshot?.conversationFolders ?? []).contains(where:{$0.id==target.folderId && !$0.archived}) ? target.folderId:""}
    }
    private func run(_ action:String){working=true;Task{let ok=await model.manageConversation(["kind":target.kind,"id":target.id,"action":action,"name":name,"folderId":folder]);working=false;if ok{dismiss()}else{failed=true}}}
}
struct ConversationArchive:View {
    @ObservedObject private var nativeLanguage = NativeL10n.shared
    @ObservedObject var model:Workspace
    @State private var target:ConversationTarget?
    @Environment(\.dismiss) private var dismiss
    private var folders:[ConversationFolder]{(model.snapshot?.conversationFolders ?? []).filter(\.archived)}
    private var chats:[ConversationEntry]{(model.snapshot?.conversationLibrary ?? []).filter(\.archived)}
    var body:some View {
        VStack(alignment:.leading,spacing:20){
            HStack{Label(nativeUI("已归档对话", "Archived chats"),systemImage:"archivebox").font(.title2.bold());Spacer();Button(nativeUI("关闭", "Close")){dismiss()}}
            ScrollView{VStack(alignment:.leading,spacing:10){
                if folders.isEmpty && chats.isEmpty{Text(nativeUI("暂无归档内容", "Nothing archived yet")).foregroundStyle(.secondary).frame(maxWidth:.infinity).padding(50)}
                ForEach(folders){folder in Button{target=ConversationTarget(folder)}label:{Label(folder.title,systemImage:"folder").frame(maxWidth:.infinity,alignment:.leading).padding(12)}.buttonStyle(LiftStyle())}
                ForEach(chats){item in Button{target=ConversationTarget(item)}label:{Label(item.title,systemImage:"bubble.left").frame(maxWidth:.infinity,alignment:.leading).padding(12)}.buttonStyle(LiftStyle())}
            }}
        }.padding(24).frame(width:500,height:450).background(StudioPalette.canvas)
        .sheet(item:$target){item in ConversationManager(model:model,target:item)}
    }
}
