import SwiftUI

/// Project and folder filters are views over the same persisted conversation IDs.
struct ConversationHub:View {
    @ObservedObject private var nativeLanguage = NativeL10n.shared
    @ObservedObject var model:Workspace
    @State private var query=""
    @State private var folder="all"
    @State private var target:ConversationTarget?
    @State private var archive=false
    private var folders:[ConversationFolder] {(model.snapshot?.conversationFolders ?? []).filter{!$0.archived}}
    private var chats:[ConversationEntry] {
        (model.snapshot?.conversationLibrary ?? []).filter { item in
            !item.archived && (model.conversationProjectFilter.isEmpty || item.projectId==model.conversationProjectFilter) &&
            (folder=="all" || (folder=="unfiled" ? item.folderId.isEmpty:item.folderId==folder)) &&
            (query.isEmpty || item.title.localizedCaseInsensitiveContains(query))
        }.sorted{($0.updatedAt ?? 0)>($1.updatedAt ?? 0)}
    }
    var body:some View {
        VStack(alignment:.leading,spacing:20) {
            HStack {
                VStack(alignment:.leading,spacing:7){Text(nativeUI("对话", "Chats")).font(.system(size:28,weight:.semibold));Text(nativeUI("继续一个想法，或回到正在推进的项目。", "Continue an idea, or return to a project in progress.")).foregroundStyle(.secondary)}
                Spacer()
                Button {target=ConversationTarget(kind:"folder",id:"",title:"")} label:{Label(nativeUI("新建文件夹", "New folder"),systemImage:"folder.badge.plus")}.buttonStyle(LiftStyle())
                Button {archive=true} label:{Label(nativeUI("已归档", "Archived"),systemImage:"archivebox")}.buttonStyle(LiftStyle())
                Button {model.command("new");model.selection="agent"} label:{Label(nativeUI("新对话", "New chat"),systemImage:"plus")}.buttonStyle(LiftStyle())
            }
            TextField(nativeUI("搜索对话…", "Search chats…"),text:$query).textFieldStyle(.roundedBorder)
            HStack {
                AgendaChoice(title:nativeUI("项目", "Projects"),value:$model.conversationProjectFilter,options:[("",nativeUI("全部项目", "All projects"))]+(model.snapshot?.projects ?? []).map{($0.id,$0.title)})
                AgendaChoice(title:nativeUI("文件夹", "Folder"),value:$folder,options:[("all",nativeUI("全部文件夹", "All folders")),("unfiled",nativeUI("未分组", "Unfiled"))]+folders.map{($0.id,$0.title)})
                if let f=folders.first(where:{$0.id==folder}){Button(nativeUI("管理文件夹", "Manage folder")){target=ConversationTarget(f)}.buttonStyle(LiftStyle())}
                Spacer();Text(nativeUI("\(chats.count) 个对话", "\(chats.count) chats")).font(.caption).foregroundStyle(.secondary)
            }
            if !folders.isEmpty {
                ScrollView(.horizontal){HStack(spacing:8){ForEach(folders){f in
                    Button(f.title){folder=f.id}.buttonStyle(LiftStyle()).padding(8).background(folder==f.id ? StudioPalette.jade.opacity(0.1):Color.clear,in:RoundedRectangle(cornerRadius:10))
                        .contextMenu{Button(nativeUI("管理文件夹", "Manage folder")){target=ConversationTarget(f)}}
                        .dropDestination(for:String.self){values,_ in guard let value=values.first,value.hasPrefix("aibro-chat:"),let chat=(model.snapshot?.conversationLibrary ?? []).first(where:{$0.id==String(value.dropFirst(11)) && !$0.archived})else{return false};Task{await model.manageConversation(["action":"save","kind":"conversation","id":chat.id,"name":chat.title,"folderId":f.id])};return true}
                }}}.scrollIndicators(.hidden)
            }
            ScrollView {
                LazyVStack(spacing:10) {
                    if chats.isEmpty{Text(nativeUI("这里还没有对话。可以新建，或调整筛选条件。", "No chats here yet. Start one or adjust the filters.")).foregroundStyle(.secondary).padding(50)}
                    ForEach(chats){chat in
                        HStack {
                            Button {model.selection="chat:"+chat.id} label:{
                                HStack(spacing:14){Image(systemName:"bubble.left").foregroundStyle(StudioPalette.jade);VStack(alignment:.leading,spacing:7){Text(chat.title).font(.system(size:14,weight:.medium)).lineLimit(2);Text(subtitle(chat)).font(.caption).foregroundStyle(.secondary)};Spacer()}.frame(maxWidth:.infinity,alignment:.leading).padding(17)
                            }.buttonStyle(.plain)
                            Button {target=ConversationTarget(chat)} label:{Image(systemName:"ellipsis").padding(14)}.buttonStyle(LiftStyle()).help(nativeUI("管理对话", "Manage chat"))
                        }.background(StudioPalette.panel,in:RoundedRectangle(cornerRadius:16)).overlay(RoundedRectangle(cornerRadius:16).stroke(StudioPalette.line,lineWidth:1)).draggable("aibro-chat:"+chat.id)
                        .contextMenu{Button(nativeUI("重命名 / 移动", "Rename / Move")){target=ConversationTarget(chat)};Button(nativeUI("归档", "Archive")){Task{await model.manageConversation(["kind":"conversation","id":chat.id,"action":"archive"])}};Button(nativeUI("移入回收站", "Move to Trash"),role:.destructive){target=ConversationTarget(chat)}}
                    }
                }
            }
        }.padding(30).background(StudioPalette.canvas)
        .sheet(item:$target){ConversationManager(model:model,target:$0)}
        .sheet(isPresented:$archive){ConversationArchive(model:model)}
    }
    private func subtitle(_ chat:ConversationEntry)->String {
        let owner=(model.snapshot?.projects ?? []).first{$0.id==chat.projectId}?.title ?? (chat.projectId?.isEmpty == false ? nativeUI("原项目不可用", "Original project unavailable"):nativeUI("独立对话", "Standalone chat"))
        let date=Date(timeIntervalSince1970:(chat.updatedAt ?? 0)/1000).nativeFormatted(date:.abbreviated,time:.omitted)
        return owner+" · "+date
    }
}

struct ResearchNavigation:View {
    @ObservedObject private var nativeLanguage = NativeL10n.shared
    @ObservedObject var model:Workspace
    private var tabs:[(String,String)] {[("research",nativeUI("工作台", "Workbench")),("research-projects",nativeUI("研究项目", "Research projects")),("wiki",nativeUI("知识库 Wiki", "Knowledge wiki"))]}
    var body:some View {
        HStack(spacing:8){ForEach(tabs,id:\.0){id,title in
            Button {if model.selection==id {model.spaceContent=false}else{model.selection=id}} label:{Text(title).font(.system(size:12,weight:.medium)).padding(.horizontal,18).padding(.vertical,10).background(model.selection==id ? StudioPalette.iris.opacity(0.12):Color.clear,in:RoundedRectangle(cornerRadius:10))}.buttonStyle(.plain).accessibilityAddTraits(model.selection==id ? .isSelected:[])
        };Spacer()}.padding(.horizontal,30).padding(.vertical,12).background(StudioPalette.canvas)
    }
}
struct ResearchProjects:View {
    @ObservedObject private var nativeLanguage = NativeL10n.shared
    @ObservedObject var model:Workspace
    var body:some View {
        ScrollView{LazyVStack(alignment:.leading,spacing:16){
            Text(nativeUI("研究项目", "Research projects")).font(.system(size:28,weight:.semibold))
            Text(nativeUI("把资料、实验和对话留在同一个研究目标下。", "Keep sources, experiments and conversations under one research goal.")).foregroundStyle(.secondary)
            ForEach((model.snapshot?.projects ?? []).filter{$0.workspace=="科研"}){project in
                HStack{Button{model.selection="project:"+project.id}label:{Label(project.title,systemImage:"folder").font(.headline).frame(maxWidth:.infinity,alignment:.leading).padding(24)}.buttonStyle(.plain);Button(nativeUI("新建项目对话", "New project chat")){model.command("new-project-conversation",project.id)}.buttonStyle(LiftStyle()).padding(16)}.background(StudioPalette.panel,in:RoundedRectangle(cornerRadius:18))
            }
            if !(model.snapshot?.projects ?? []).contains(where:{$0.workspace=="科研"}){Text(nativeUI("还没有研究项目，可以在科研对话中描述你的研究目标。", "No research projects yet. Describe your research goal in a chat to get started.")).foregroundStyle(.secondary).padding(.vertical,30)}
            Button(nativeUI("开始科研对话", "Start a research chat")){model.command("new-research-conversation")}.buttonStyle(LiftStyle())
        }.padding(30)}.background(StudioPalette.canvas)
    }
}
