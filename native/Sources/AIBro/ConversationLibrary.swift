import SwiftUI
import WebKit

struct ConversationEntry:Identifiable,Decodable {let id:String;let title:String;let folderId:String;let archived:Bool;let projectId:String?;let updatedAt:Double?}
struct ConversationFolder:Identifiable,Decodable {let id:String;let title:String;let archived:Bool}
struct ConversationTarget:Identifiable {
    let kind:String;let id:String;let title:String;var folderId="";var archived=false
    init(kind:String,id:String,title:String){self.kind=kind;self.id=id;self.title=title}
    init(_ item:ConversationEntry){kind="conversation";id=item.id;title=item.title;folderId=item.folderId;archived=item.archived}
    init(_ item:ConversationFolder){kind="folder";id=item.id;title=item.title;archived=item.archived}
}
extension Workspace {
    @discardableResult func manageConversation(_ command:[String:String]) async -> Bool {
        do {
            guard ready else{throw CocoaError(.validationMissingMandatoryProperty)}
            let result=try await web.callAsyncJavaScript("return window.NativeConversationActions.perform(command)",arguments:["command":command],in:nil,contentWorld:.page)
            return result as? Bool == true
        }catch{self.error=error.localizedDescription;return false}
    }
}
struct ConversationManager:View {
    @ObservedObject private var nativeLanguage = NativeL10n.shared
    @ObservedObject var model:Workspace
    let target:ConversationTarget
    @State private var name=""
    @State private var folder=""
    @State private var deleting=false
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
                    Button(nativeUI("移入回收站", "Move to Trash"),role:.destructive){deleting=true}
                }
                Text(target.kind=="folder" ? nativeUI("归档会收起文件夹中的对话；取消归档时会恢复。", "Archiving hides the chats in this folder. Unarchive it to restore them."):nativeUI("归档后的对话可在“对话”页面的归档入口恢复。", "Restore archived chats from the archive on the Chats page.")).font(.caption).foregroundStyle(.secondary)
            }
            if failed{Text(nativeUI("保存未完成，请关闭后重试。", "Could not save. Close this dialog and try again.")).font(.caption).foregroundStyle(.red)}
            HStack{Spacer();Button(working ? nativeUI("正在保存…", "Saving…"):nativeUI("保存", "Save")){run(target.id.isEmpty ? "create":"save")}.buttonStyle(.borderedProminent).disabled(name.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)}
        }.padding(26).frame(width:440).background(StudioPalette.canvas).disabled(working)
        .onAppear{name=target.title;folder=(model.snapshot?.conversationFolders ?? []).contains(where:{$0.id==target.folderId && !$0.archived}) ? target.folderId:""}
        .confirmationDialog(target.kind=="folder" ? nativeUI("将文件夹及其中的对话移入回收站？", "Move this folder and its chats to Trash?"):nativeUI("将此对话移入回收站？", "Move this chat to Trash?"),isPresented:$deleting,titleVisibility:.visible){Button(nativeUI("移入回收站", "Move to Trash"),role:.destructive){run("delete")};Button(nativeUI("取消", "Cancel"),role:.cancel){}}message:{Text(nativeUI("可以从回收站恢复。项目中的笔记、任务和原始资料会保留。", "You can restore these from Trash. Project notes, tasks and source files are kept."))}
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
