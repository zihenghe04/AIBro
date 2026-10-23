import SwiftUI

/// Project filtering and folder disclosure preserve the same conversation IDs.
struct ConversationHub:View {
    @ObservedObject private var nativeLanguage = NativeL10n.shared
    @ObservedObject var model:Workspace
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage private var collapsedFoldersJSON:String
    @State private var query=""
    @State private var searchCollapsed:Set<String>=[]
    @State private var target:ConversationTarget?
    @State private var archive=false
    @State private var preview:ConversationEntry?
    init(model:Workspace) {
        self.model=model
        _collapsedFoldersJSON=AppStorage(wrappedValue:"[]","ConversationHub.collapsedFolders."+model.dataDirectory.standardizedFileURL.path)
    }
    private var folders:[ConversationFolder] {(model.snapshot?.conversationFolders ?? []).filter{!$0.archived}}
    private var searching:Bool {!query.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty}
    private var collapsed:Set<String> {Set((try? JSONDecoder().decode([String].self,from:Data(collapsedFoldersJSON.utf8))) ?? [])}
    private var chats:[ConversationEntry] {
        let term=query.trimmingCharacters(in:.whitespacesAndNewlines)
        let matchingFolders=Set(folders.filter{$0.title.localizedCaseInsensitiveContains(term)}.map(\.id))
        return (model.snapshot?.conversationLibrary ?? []).filter { item in
            !item.archived && (model.conversationProjectFilter.isEmpty || item.projectId==model.conversationProjectFilter) &&
            (!searching || item.title.localizedCaseInsensitiveContains(term) || (item.summary ?? "").localizedCaseInsensitiveContains(term) || matchingFolders.contains(item.folderId))
        }.sorted(by:ConversationEntry.ordered)
    }
    private struct Group:Identifiable {let id:String;let folder:ConversationFolder?;let chats:[ConversationEntry]}
    private var groups:[Group] {
        let currentChats=chats,known=Set(folders.map(\.id))
        let grouped=Dictionary(grouping:currentChats,by:{$0.folderId})
        var result=folders.compactMap { folder -> Group? in
            let members=grouped[folder.id] ?? []
            if members.isEmpty && (searching || !model.conversationProjectFilter.isEmpty) {return nil}
            return Group(id:"folder:"+folder.id,folder:folder,chats:members)
        }
        let unfiled=currentChats.filter{!known.contains($0.folderId)}
        if !unfiled.isEmpty {result.append(Group(id:"unfiled",folder:nil,chats:unfiled))}
        return result
    }
    private func isExpanded(_ id:String)->Bool {!(searching ? searchCollapsed:collapsed).contains(id)}
    private func setExpanded(_ expanded:Bool,ids:[String]) {
        var next=searching ? searchCollapsed:collapsed
        for id in ids {if expanded{next.remove(id)}else{next.insert(id)}}
        withAnimation(reduceMotion ? nil:.easeInOut(duration:0.18)) {
            if searching {searchCollapsed=next}
            else if let bytes=try? JSONEncoder().encode(next.sorted()) {collapsedFoldersJSON=String(decoding:bytes,as:UTF8.self)}
        }
    }
    var body:some View {
        let visibleGroups=groups
        VStack(alignment:.leading,spacing:18) {
            VStack(alignment:.leading,spacing:14) {
                VStack(alignment:.leading,spacing:7){Text(nativeUI("对话", "Chats")).font(.system(size:28,weight:.semibold));Text(nativeUI("继续一个想法，或回到正在推进的项目。", "Continue an idea, or return to a project in progress.")).foregroundStyle(.secondary)}
                HStack {
                    Button {model.command("organize-conversations")} label:{Label(nativeUI("整理建议", "Organize"),systemImage:"sparkles")}.buttonStyle(LiftStyle()).disabled(!model.ready)
                    Button {target=ConversationTarget(kind:"folder",id:"",title:"")} label:{Label(nativeUI("新文件夹", "New folder"),systemImage:"folder.badge.plus")}.buttonStyle(LiftStyle())
                    Button {archive=true} label:{Label(nativeUI("已归档", "Archived"),systemImage:"archivebox")}.buttonStyle(LiftStyle())
                    Button {model.command("new")} label:{Label(nativeUI("新对话", "New chat"),systemImage:"plus")}.buttonStyle(LiftStyle())
                }
            }
            TextField(nativeUI("搜索对话或文件夹…", "Search chats or folders…"),text:$query).textFieldStyle(.roundedBorder)
            HStack {
                AgendaChoice(title:nativeUI("项目", "Projects"),value:$model.conversationProjectFilter,options:[("",nativeUI("全部项目", "All projects"))]+(model.snapshot?.projects ?? []).map{($0.id,$0.title)})
                Spacer()
                Text(nativeUI("\(chats.count) 个对话", "\(chats.count) chats")).font(.caption).foregroundStyle(.secondary)
                Menu {
                    Button(nativeUI("全部展开", "Expand all")){setExpanded(true,ids:visibleGroups.map(\.id))}
                    Button(nativeUI("全部折叠", "Collapse all")){setExpanded(false,ids:visibleGroups.map(\.id))}
                } label:{Image(systemName:"list.bullet.indent").frame(width:28,height:28)}.menuStyle(.borderlessButton).fixedSize().help(nativeUI("文件夹显示", "Folder display")).accessibilityLabel(nativeUI("文件夹显示", "Folder display"))
            }
            ScrollView {
                LazyVStack(alignment:.leading,spacing:18) {
                    if visibleGroups.isEmpty {Text(nativeUI("这里还没有对话。可以新建，或调整筛选条件。", "No chats here yet. Start one or adjust the filters.")).foregroundStyle(.secondary).frame(maxWidth:.infinity).padding(50)}
                    ForEach(visibleGroups) { group in
                        VStack(alignment:.leading,spacing:8) {
                            folderHeader(group)
                            if isExpanded(group.id) {
                                LazyVStack(spacing:8) {
                                    if group.chats.isEmpty {Text(nativeUI("此文件夹暂无对话，可将对话拖到文件夹标题。", "No chats yet. Drag a chat onto the folder heading.")).font(.callout).foregroundStyle(.secondary).frame(maxWidth:.infinity,alignment:.leading).padding(16)}
                                    ForEach(group.chats){chat in conversationRow(chat)}
                                }.padding(.leading,24).overlay(alignment:.leading){Rectangle().fill(StudioPalette.line).frame(width:1).padding(.leading,9)}
                            }
                        }
                    }
                }.padding(.bottom,16)
            }
        }.padding(30).background(StudioPalette.canvas)
        .onChange(of:query){_,_ in searchCollapsed=[]}
        .sheet(item:$target){ConversationManager(model:model,target:$0)}
        .sheet(isPresented:$archive){ConversationArchive(model:model)}
        .sheet(item:$preview){chat in ConversationQuickLook(conversation:chat){model.selection="chat:"+chat.id}}
    }
    private func folderHeader(_ group:Group)->some View {
        let title=group.folder?.title ?? nativeUI("未分组对话", "Unfiled chats")
        let expanded=isExpanded(group.id)
        return HStack(spacing:4) {
            Button {setExpanded(!expanded,ids:[group.id])} label:{
                HStack(spacing:9) {
                    Image(systemName:"chevron.right").font(.system(size:10,weight:.semibold)).rotationEffect(.degrees(expanded ? 90:0)).frame(width:16)
                    Image(systemName:group.folder == nil ? "tray":"folder").font(.system(size:13))
                    Text(title).font(.system(size:13,weight:.semibold)).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength:8)
                    Text("\(group.chats.count)").font(.system(size:12)).monospacedDigit().foregroundStyle(.secondary)
                }.foregroundStyle(.secondary).padding(.vertical,8).padding(.horizontal,4).contentShape(Rectangle())
            }.buttonStyle(.plain).help(title).accessibilityLabel(title).accessibilityValue((expanded ? nativeUI("已展开", "Expanded"):nativeUI("已折叠", "Collapsed"))+nativeUI("，\(group.chats.count) 个对话", ", \(group.chats.count) chats"))
                .onKeyPress(.rightArrow){setExpanded(true,ids:[group.id]);return .handled}
                .onKeyPress(.leftArrow){setExpanded(false,ids:[group.id]);return .handled}
            if let folder=group.folder {
                Button {target=ConversationTarget(folder)} label:{Image(systemName:"ellipsis").frame(width:28,height:28)}.buttonStyle(.plain).help(nativeUI("管理文件夹", "Manage folder")).accessibilityLabel(nativeUI("管理文件夹：", "Manage folder: ")+title)
            }
        }.contextMenu{if let folder=group.folder{Button(nativeUI("管理文件夹", "Manage folder")){target=ConversationTarget(folder)}}}
            .dropDestination(for:String.self){values,_ in
                guard let value=values.first,value.hasPrefix("aibro-chat:"),let chat=(model.snapshot?.conversationLibrary ?? []).first(where:{$0.id==String(value.dropFirst(11)) && !$0.archived})else{return false}
                let destination=group.folder?.id ?? ""
                guard chat.folderId != destination else{return true}
                Task{if await model.manageConversation(["action":"move","kind":"conversation","id":chat.id,"folderId":destination]){setExpanded(true,ids:[group.id])}}
                return true
            }
    }
    private func conversationRow(_ chat:ConversationEntry)->some View {
        HStack(spacing:4) {
            Button {model.selection="chat:"+chat.id} label:{
                HStack(spacing:12){Image(systemName:chat.isPinned ? "pin.fill":"bubble.left").foregroundStyle(StudioPalette.jade);VStack(alignment:.leading,spacing:6){Text(chat.title).font(.system(size:14,weight:.medium)).lineLimit(2);if let summary=chat.summary,!summary.isEmpty{Text(summary).font(.system(size:12)).foregroundStyle(.secondary).lineLimit(2)};Text(subtitle(chat)).font(.caption).foregroundStyle(.secondary)};Spacer()}.frame(maxWidth:.infinity,alignment:.leading).padding(14)
            }.buttonStyle(.plain)
            VStack(spacing:6) {
                Button {preview=chat} label:{Image(systemName:"text.alignleft").frame(width:28,height:28)}.buttonStyle(.plain).help(nativeUI("摘要速览","Preview summary")).accessibilityLabel(nativeUI("速览：","Preview: ")+chat.title)
                Button {Task{await model.manageConversation(["kind":"conversation","id":chat.id,"action":"pin","pinned":chat.isPinned ? "false":"true"])}} label:{Image(systemName:chat.isPinned ? "pin.slash":"pin").frame(width:28,height:28)}.buttonStyle(.plain).help(chat.isPinned ? nativeUI("取消置顶","Unpin"):nativeUI("置顶对话","Pin chat")).accessibilityLabel((chat.isPinned ? nativeUI("取消置顶：","Unpin: "):nativeUI("置顶：","Pin: "))+chat.title)
            }
            Button {target=ConversationTarget(chat)} label:{Image(systemName:"ellipsis").padding(12)}.buttonStyle(LiftStyle()).help(nativeUI("管理对话", "Manage chat"))
        }.background(StudioPalette.panel,in:RoundedRectangle(cornerRadius:14)).overlay(RoundedRectangle(cornerRadius:14).stroke(StudioPalette.line,lineWidth:1)).draggable("aibro-chat:"+chat.id)
            .contextMenu{Button(nativeUI("重命名 / 移动", "Rename / Move")){target=ConversationTarget(chat)};Button(nativeUI("归档", "Archive")){Task{await model.manageConversation(["kind":"conversation","id":chat.id,"action":"archive"])}};Button(nativeUI("移入回收站", "Move to Trash"),role:.destructive){Task{await model.manageConversation(["kind":"conversation","id":chat.id,"action":"delete","name":chat.title])}}}
    }
    private func subtitle(_ chat:ConversationEntry)->String {
        let owner=(model.snapshot?.projects ?? []).first{$0.id==chat.projectId}?.title ?? (chat.projectId?.isEmpty == false ? nativeUI("原项目不可用", "Original project unavailable"):nativeUI("独立对话", "Standalone chat"))
        let date=Date(timeIntervalSince1970:(chat.updatedAt ?? 0)/1000).nativeFormatted(date:.abbreviated,time:.omitted)
        return owner+" · "+date
    }
}

struct NativeWorkspaceLocation:Codable,Equatable {
    var view:String
    var projectID:String?
    var conversationID:String?
    var section:String?
    init(view:String,projectID:String?=nil,conversationID:String?=nil,section:String?=nil) {
        self.view=view == "dashboard" ? "overview":view == "research-projects" ? "research":view
        self.projectID=self.view == "project" ? projectID:nil
        self.conversationID=self.view == "agent" ? conversationID:nil
        self.section=self.view == "project" || ["daily","courses","research"].contains(self.view) ? section:nil
        if view == "research-projects" {self.section="projects"}
    }
    init?(selection:String?,projectSection:String?,spaceSections:[String:String]) {
        guard let selection else{return nil}
        if selection.hasPrefix("project:"){self.init(view:"project",projectID:String(selection.dropFirst(8)),section:projectSection)}
        else if selection.hasPrefix("chat:"){self.init(view:"agent",conversationID:String(selection.dropFirst(5)))}
        else {self.init(view:selection,section:spaceSections[selection])}
    }
    static func validSpaceSection(_ section:String,view:String)->Bool {
        ["projects","knowledge","tasks","overview"].contains(section) || (view == "research" && section == "papers")
    }
    func available(projects:Set<String>,conversations:Set<String>)->Bool {
        if view == "project" {return projectID.map{!$0.isEmpty && projects.contains($0)} == true && (section == nil || ["conversations","knowledge","outputs","tasks","schedule","overview"].contains(section!))}
        if view == "agent" {return conversationID.map{$0.isEmpty || conversations.contains($0)} ?? true}
        if ["daily","courses","research"].contains(view) {return section == nil || Self.validSpaceSection(section!,view:view)}
        return ["overview","conversations","agenda","captures","wiki","trash","settings"].contains(view) && section == nil
    }
}

struct SpaceNavigation:View {
    @ObservedObject private var nativeLanguage = NativeL10n.shared
    @ObservedObject var model:Workspace
    let view:String
    private var workspace:String {["daily":"日常","courses":"课程","research":"科研"][view] ?? "日常"}
    private var selected:String {model.selection == "wiki" ? "wiki":model.spaceSections[view] ?? "projects"}
    private var tabs:[(String,String)] {
        var value=[("projects",nativeUI("项目", "Projects")),("knowledge",nativeUI("资料", "Sources")),("tasks",nativeUI("任务", "Tasks")),("overview",nativeUI("概览", "Overview"))]
        if view == "research" {value += [("papers",nativeUI("文献", "Papers")),("wiki",nativeUI("知识库 Wiki", "Knowledge wiki"))]}
        return value
    }
    var body:some View {
        HStack(spacing:8) {
            ScrollView(.horizontal) {
                HStack(spacing:5){ForEach(tabs,id:\.0){id,title in
                    Button {model.openWorkspace(id == "wiki" ? "wiki":view,section:id == "wiki" ? nil:id)} label:{
                        Text(title).font(.system(size:12,weight:.medium)).padding(.horizontal,16).padding(.vertical,10)
                            .background(selected==id ? StudioPalette.space(workspace).opacity(0.12):Color.clear,in:RoundedRectangle(cornerRadius:10))
                    }.buttonStyle(.plain).disabled(!model.ready).accessibilityAddTraits(selected==id ? .isSelected:[])
                }}
            }.scrollIndicators(.hidden)
            Button {model.command("new-space-conversation",workspace)} label:{Label(nativeUI("空间新对话", "New space chat"),systemImage:"square.and.pencil").font(.system(size:12))}.buttonStyle(LiftStyle()).disabled(!model.ready)
        }.padding(.horizontal,30).padding(.vertical,12).background(StudioPalette.canvas)
    }
}
struct SpaceProjects:View {
    @ObservedObject private var nativeLanguage = NativeL10n.shared
    @ObservedObject var model:Workspace
    let view:String
    let space:String
    @State private var query=""
    private var projects:[Item] {
        let term=query.trimmingCharacters(in:.whitespacesAndNewlines)
        return (model.snapshot?.projects ?? []).filter{$0.workspace==space && (term.isEmpty || $0.title.localizedCaseInsensitiveContains(term))}
    }
    var body:some View {
        VStack(alignment:.leading,spacing:20) {
            VStack(alignment:.leading,spacing:8){Text(nativeUI("\(space)项目", "Projects")).font(.system(size:28,weight:.semibold));Text(nativeUI("围绕一个目标组织对话、资料与成果。", "Keep conversations, sources and outputs around one goal.")).foregroundStyle(.secondary)}
            TextField(nativeUI("搜索此空间的项目…", "Search projects in this space…"),text:$query).textFieldStyle(.roundedBorder).accessibilityLabel(nativeUI("搜索此空间的项目", "Search projects in this space"))
            ScrollView {LazyVStack(alignment:.leading,spacing:12) {
                ForEach(projects) {project in
                    let chats=(model.snapshot?.conversationLibrary ?? []).filter{!$0.archived && $0.projectId==project.id}.count
                    let documents=(model.snapshot?.documents ?? []).filter{$0.projectId==project.id}.count
                    HStack(spacing:12) {
                        Button {model.openProject(project.id)} label:{
                            HStack(spacing:14){Image(systemName:"folder").foregroundStyle(StudioPalette.space(space));VStack(alignment:.leading,spacing:7){Text(project.title).font(.system(size:15,weight:.medium)).lineLimit(2);Text(nativeUI("\(chats) 个对话 · \(documents) 份资料", "\(chats) chats · \(documents) sources")).font(.caption).foregroundStyle(.secondary)};Spacer()}.padding(22).frame(maxWidth:.infinity,alignment:.leading)
                        }.buttonStyle(.plain)
                        Button {model.command("new-project-conversation",project.id)} label:{Label(nativeUI("项目新对话", "New project chat"),systemImage:"plus")}.buttonStyle(LiftStyle()).disabled(!model.ready).padding(.trailing,18)
                    }.background(StudioPalette.panel,in:RoundedRectangle(cornerRadius:16)).overlay(RoundedRectangle(cornerRadius:16).stroke(StudioPalette.line,lineWidth:1))
                }
                if projects.isEmpty {
                    VStack(spacing:10){Image(systemName:query.isEmpty ? "folder":"magnifyingglass").font(.system(size:26)).foregroundStyle(.secondary);Text(query.isEmpty ? nativeUI("此空间还没有项目", "No projects in this space yet"):nativeUI("没有匹配的项目", "No matching projects")).font(.headline);Text(query.isEmpty ? nativeUI("可以先开始空间对话，再把具体目标整理成项目。", "Start a space chat, then organize a concrete goal into a project."):nativeUI("试试项目名称中的其他关键词。", "Try another word from the project name.")).foregroundStyle(.secondary)}.frame(maxWidth:.infinity).padding(.vertical,48)
                }
            }}
        }.padding(30).background(StudioPalette.canvas)
    }
}
