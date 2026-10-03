import SwiftUI
import AppKit

struct NativeQuickLinksView: View {
    @ObservedObject var store: NativeQuickLinksStore
    var onFocus: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @StateObject private var orderFocus = NativeQuickLinkOrderFocus()
    @StateObject private var drag = NativeQuickLinkDrag()
    @State private var selection = Set<String>()
    @State private var selectionAnchor: String?
    @State private var removing: [NativeQuickLinkRow] = []
    @State private var confirmRemove = false
    @State private var confirmDiscard = false
    @State private var deletingGroup: NativeQuickLinkGroup?
    @State private var confirmDeleteGroup = false
    @State private var queryTask: Task<Void,Never>?
    private struct Group: Identifiable { let id: String; let title: String; let detail: String; let rows: [NativeQuickLinkRow]; var metadata: NativeQuickLinkGroup? }
    private var groups: [Group] {
        var order:[String]=[], byID:[String:[NativeQuickLinkRow]]=[:]
        for row in store.rows {
            let key=store.groupBySite ? store.siteGroupID(for:row) : row.groupID
            if byID[key]==nil { order.append(key) }; byID[key,default:[]].append(row)
        }
        if !store.groupBySite {
            for group in store.groups where byID[group.id]==nil { order.append(group.id); byID[group.id]=[] }
        }
        return order.compactMap { id in
            let rows=byID[id] ?? [], metadata=store.groupBySite ? nil : store.groups.first{$0.id==id}
            guard let first=rows.first else {
                guard let metadata else { return nil }
                return Group(id:id,title:metadata.folder,detail:[metadata.workspace,metadata.projectTitle].filter{!$0.isEmpty}.joined(separator:" · "),rows:[],metadata:metadata)
            }
            return Group(id:id,title:store.groupBySite ? id : first.folder,
                detail:store.groupBySite ? "" : [first.workspace,first.projectTitle].filter{!$0.isEmpty}.joined(separator:" · "),rows:rows,metadata:metadata)
        }
    }
    var body: some View {
        VStack(alignment:.leading,spacing:14) {
            toolbar
            if let error=store.error ?? store.refreshError { Text(error).font(.system(size:12)).foregroundStyle(.red).fixedSize(horizontal:false,vertical:true) }
            if let error=store.draftError { Text(error).font(.system(size:12)).foregroundStyle(.red).fixedSize(horizontal:false,vertical:true) }
            if let error=store.viewStateError { Text(error).font(.system(size:11)).foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true) }
            if let notice=store.notice { Text(notice).font(.system(size:11)).foregroundStyle(.secondary) }
            if !store.available {
                Spacer(); Text(nativeUI("链接库暂不可用", "Link library unavailable")).foregroundStyle(.secondary).frame(maxWidth:.infinity); Spacer()
            } else {
                if store.pending != nil { pendingNotice }
                if store.editing && store.pending == nil { editor }
                else if store.showingTrash && store.pending == nil { trash }
                else { library }
            }
        }.padding(.horizontal,8).padding(.top,6).font(.system(size:13))
            .background(NativeQuickLinkOrderWindow(focus:orderFocus))
            .task { await store.refresh() }
            .onDisappear { store.setVisible(false);orderFocus.cancel();drag.cancel();queryTask?.cancel();store.clearRecordFocus(); _ = store.flushDraft() }
            .onChange(of:store.query) { _,_ in
                orderFocus.cancel(); drag.cancel(); queryTask?.cancel(); queryTask=Task { @MainActor in
                    do { try await Task.sleep(nanoseconds:180_000_000) } catch { return }
                    guard !Task.isCancelled else { return }; await store.refresh()
                }
            }
            .onChange(of:store.rows) { _,rows in selection.formIntersection(Set(rows.map(\.id))) }
            .onChange(of:store.groupBySite) { _,_ in orderFocus.cancel();drag.cancel() }
            .onChange(of:store.showingTrash) { _,_ in orderFocus.cancel();drag.cancel() }
            .onChange(of:store.editing) { _,_ in orderFocus.cancel();drag.cancel() }
            .onChange(of:store.visible) { _,visible in if !visible {orderFocus.cancel();drag.cancel()} }
            .onChange(of:store.available) { _,value in orderFocus.cancel();drag.cancel(); if value { Task { await store.refresh() } } else { selection=[] } }
            .confirmationDialog(nativeUI("将所选 \(removing.count) 个链接移入回收站？", "Move \(removing.count) selected links to Trash?"),isPresented:$confirmRemove) {
                Button(nativeUI("移入回收站", "Move to Trash"),role:.destructive) { let rows=removing; Task { await store.remove(rows); if store.pending==nil { selection=[] } } }
                Button(nativeUI("取消", "Cancel"),role:.cancel) {}
            } message: { Text(nativeUI("会从主资料库与项目中同步移除；原件和派生产出保留，可在最近删除中恢复。", "This also removes the sources from the main library and projects. Originals and derived outputs are retained; restore them from Recently Deleted.")) }
            .confirmationDialog(nativeUI("放弃当前输入？", "Discard current input?"),isPresented:$confirmDiscard) {
                Button(nativeUI("放弃输入", "Discard input"),role:.destructive) { _ = store.discardDraft(); Task { await store.refresh() } }
                Button(nativeUI("继续处理", "Keep working"),role:.cancel) {}
            } message: { Text(store.pending == nil ? nativeUI("尚未保存的修改将被丢弃。", "Unsaved changes will be discarded.") : nativeUI("这只停止重试，不撤销可能已经保存的操作。请核对资料库。", "This stops retrying; it does not undo an operation that may already be saved. Review the library.")) }
            .confirmationDialog(nativeUI("删除这个空分组？", "Delete this empty folder?"),isPresented:$confirmDeleteGroup) {
                Button(nativeUI("删除空分组", "Delete empty folder"),role:.destructive) {
                    if let group=deletingGroup { Task { await store.deleteGroup(group) } }
                }
                Button(nativeUI("取消", "Cancel"),role:.cancel) {}
            } message: { Text(nativeUI("仅移除主资料库中的空目录。若其他位置已加入资料，将拒绝删除。", "Removes only the shared empty folder. Deletion is refused if sources were added elsewhere.")) }
    }
    private var pendingNotice: some View {
        HStack(spacing:12) {
            if store.fetchingID != nil {
                ProgressView().controlSize(.small)
                Text(store.fetchingMetadata ? nativeUI("正在获取网站信息与图标，原资料保持不变。", "Fetching website details and icon; saved sources are unchanged.") : nativeUI("正在获取原件，收藏已保存在本机。", "Fetching the original; your bookmark is saved locally.")).font(.system(size:12))
            } else { Text(nativeUI("上次操作正在等待确认。", "The previous operation is awaiting confirmation.")).font(.system(size:12)) }
            Spacer()
            Button(nativeUI("重试原操作", "Retry operation")) { Task { await store.retry() } }.disabled(store.saving)
            Button(nativeUI("停止重试", "Stop retrying")) { confirmDiscard=true }.disabled(store.saving)
        }.padding(12).background(.primary.opacity(0.04),in:RoundedRectangle(cornerRadius:10))
    }
    private var toolbar: some View {
        HStack(spacing:12) {
            if store.editing {
                Text(store.editingGroup ? (store.editingExisting ? nativeUI("重命名分组", "Rename folder") : nativeUI("新建分组", "New folder")) : (store.editingExisting ? nativeUI("编辑链接", "Edit link") : nativeUI("收藏链接", "Save link"))).fontWeight(.medium)
                Spacer()
            } else {
                HStack(spacing:7) {
                    Image(systemName:"magnifyingglass").foregroundStyle(.secondary)
                    TextField(nativeUI("查找标题、网址或项目", "Find title, URL or project"),text:$store.query).textFieldStyle(.plain)
                }.padding(.horizontal,11).padding(.vertical,9).background(.primary.opacity(0.05),in:RoundedRectangle(cornerRadius:9)).frame(maxWidth:390)
                Picker(nativeUI("分组方式", "Group by"),selection:$store.groupBySite) {
                    Text(nativeUI("文件夹", "Folder")).tag(false); Text(nativeUI("站点", "Site")).tag(true)
                }.pickerStyle(.segmented).labelsHidden().frame(width:130)
                Spacer(minLength:8)
            }
            if !selection.isEmpty && !store.editing && !store.showingTrash {
                Button(nativeUI("删除 \(selection.count) 项", "Delete \(selection.count)")) { requestRemove(store.rows.filter{selection.contains($0.id)}) }.disabled(store.hasUnsettledEditor)
            }
            Menu {
                Toggle(nativeUI("新增公开链接自动获取网站信息", "Fetch website details for new public links"), isOn: Binding(get:{store.automaticMetadata},set:{store.setAutomaticMetadata($0)}))
                    .disabled(!store.canChangeAutomaticMetadata)
            } label: { Image(systemName:"slider.horizontal.3").frame(width:22,height:24) }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                .help(nativeUI("链接选项", "Link options")).accessibilityLabel(nativeUI("链接选项", "Link options"))
            Button { Task { await store.refresh() } } label:{Image(systemName:"arrow.clockwise")}
                .help(nativeUI("刷新链接", "Refresh links")).accessibilityLabel(nativeUI("刷新链接", "Refresh links")).disabled(store.loading)
            if !store.editing {
                Button(store.showingTrash ? nativeUI("所有链接", "All links") : nativeUI("最近删除", "Recently Deleted")) { selection=[]; store.showingTrash.toggle() }
                if !store.showingTrash {
                    Button { store.beginGroup(); onFocus() } label:{Image(systemName:"folder.badge.plus")}
                        .accessibilityLabel(nativeUI("新建分组", "New folder")).help(nativeUI("新建分组", "New folder"))
                        .disabled(store.hasUnsettledEditor || !store.available)
                }
                Button { store.beginNew(); onFocus() } label:{Label(nativeUI("收藏链接", "Save link"),systemImage:"plus")}.disabled(store.hasUnsettledEditor || !store.available)
            }
        }.buttonStyle(.plain).font(.system(size:12))
    }
    private enum LibraryItem: Identifiable {
        case header(Group), link(NativeQuickLinkRow), empty(Group)
        var id:String {switch self {case .header(let g):return "group:"+g.id;case .link(let r):return "link:"+r.id;case .empty(let g):return "empty:"+g.id}}
    }
    private var libraryItems:[LibraryItem] {
        groups.flatMap { group -> [LibraryItem] in
            [.header(group)] + (store.isGroupCollapsed(group.id) ? [] : group.rows.isEmpty ? [.empty(group)] : group.rows.map { .link($0) })
        }
    }
    private var library: some View {
      NativeQuickFocusScroll(focus:store.recordFocus) {
       NativeQuickFocusScroll(focus:orderFocus.position) {
        ScrollView {
            // One ID namespace keeps the same row/native handle mounted when
            // moving between folders; nested per-folder ForEach cannot do this.
            LazyVStack(alignment:.leading,spacing:3) {
                if groups.isEmpty {
                    VStack(spacing:9) {
                        Image(systemName:"link").font(.system(size:25,weight:.light)).foregroundStyle(.secondary)
                        Text(store.query.isEmpty ? nativeUI("随手收藏，回到项目继续使用", "Save a link and return to it in your project") : nativeUI("没有匹配的链接", "No matching links"))
                        if store.query.isEmpty { Text(nativeUI("网址会先保存到本机。现有网页资料也会显示在这里。", "URLs save locally first. Existing webpage sources appear here too.")).font(.system(size:12)).foregroundStyle(.secondary) }
                    }.frame(maxWidth:.infinity).padding(.vertical,60)
                }
                ForEach(libraryItems) { item in
                    switch item {
                    case .header(let group):
                        dropRegion(groupID:group.id) {groupHeader(group).padding(.horizontal,4).padding(.top,14).padding(.bottom,2)}
                    case .empty(let group):
                        dropRegion(groupID:group.id) {
                            Text(nativeUI("暂无链接 · 点击 + 收藏到这里", "No links yet · Use + to save one here"))
                                .font(.system(size:11)).foregroundStyle(.tertiary).padding(.leading,24).padding(.vertical,12).frame(maxWidth:.infinity,alignment:.leading)
                        }
                    case .link(let row):
                        dropRegion(groupID:row.groupID,rowID:row.id) {linkRow(row)}
                            .id(row.id).background(NativeQuickRecordFocusMarker(focus:store.recordFocus,id:row.id))
                            .background(NativeQuickRecordFocusMarker(focus:orderFocus.position,id:row.id))
                            .opacity(drag.source?.id==row.id ? 0.38:1)
                            .transition(.opacity)
                    }
                }
            }.padding(.vertical,4).padding(.horizontal,1)
                .animation(reduceMotion ? nil : .smooth(duration:0.26),value:store.orderRevision)
        }.scrollIndicators(.hidden)
       }
      }
    }
    private func dropRegion<Content:View>(groupID:String,rowID:String?=nil,@ViewBuilder content:@escaping ()->Content)->some View {
        NativeQuickLinkDropRegion(drag:drag,groupID:groupID,rowID:rowID,canPlace:{store.canPlace($0,at:$1)},commit:commitDrag,content:content)
    }
    private func groupHeader(_ group: Group) -> some View {
        HStack(spacing:9) {
            Button {
                orderFocus.cancel();drag.cancel()
                withAnimation(reduceMotion ? nil : .easeInOut(duration:0.18)) {
                    store.toggleGroup(group.id)
                }
            } label: {
                HStack(spacing:8) {
                    Image(systemName:"chevron.right").font(.system(size:9,weight:.semibold)).rotationEffect(.degrees(store.isGroupCollapsed(group.id) ? 0 : 90)).frame(width:12)
                    Text(group.title).fontWeight(.medium).lineLimit(1)
                    Text("\(group.rows.count)").foregroundStyle(.tertiary).monospacedDigit()
                }
            }.buttonStyle(.plain).disabled(store.isSearching)
                .accessibilityLabel((store.isGroupCollapsed(group.id) ? nativeUI("展开 ", "Expand ") : nativeUI("折叠 ", "Collapse ")) + group.title)
            if !group.detail.isEmpty { Text(group.detail).font(.system(size:11)).foregroundStyle(.secondary).lineLimit(1) }
            if drag.target?.groupID==group.id && drag.target?.rowID==nil {
                Text(nativeUI("移到组末尾", "Move to end")).font(.system(size:11)).foregroundStyle(Color.accentColor)
            }
            Spacer()
            if !store.groupBySite {
                Button { if let metadata=group.metadata { store.beginNew(in:metadata); onFocus() } else if let row=group.rows.first { store.beginNew(in:row); onFocus() } } label:{ Image(systemName:"plus").frame(width:23,height:23) }
                    .buttonStyle(.plain).disabled(store.hasUnsettledEditor).accessibilityLabel(nativeUI("添加到 ", "Add to ")+group.title)
                Menu {
                    if let metadata=group.metadata {
                        Button(nativeUI("重命名分组", "Rename group")) { store.beginGroup(metadata); onFocus() }
                            .disabled(store.isSearching || store.hasUnsettledEditor || !metadata.canRename)
                        if !metadata.blockedReason.isEmpty { Text(NativeQuickLinksError.rejected(metadata.blockedReason).localizedDescription) }
                        if metadata.canDelete {
                            Button(nativeUI("删除空分组", "Delete empty folder"),role:.destructive) { deletingGroup=metadata; confirmDeleteGroup=true }
                                .disabled(store.isSearching || store.hasUnsettledEditor)
                        }
                    }
                    if !group.rows.isEmpty {
                        Button(nativeUI("删除组内链接", "Delete links in group"),role:.destructive) { requestRemove(group.rows) }.disabled(store.isSearching || store.hasUnsettledEditor)
                    }
                } label:{Image(systemName:"ellipsis").frame(width:25,height:23)}.menuStyle(.borderlessButton).fixedSize().accessibilityLabel(group.title + nativeUI(" 分组操作", " group actions"))
            }
        }.font(.system(size:12)).foregroundStyle(.secondary).padding(.bottom,5)
    }
    private func linkRow(_ row: NativeQuickLinkRow) -> some View {
        HStack(spacing:9) {
            NativeQuickLinkDragHandle(row:row,drag:drag,enabled:store.canDrag(row),highlighted:drag.source?.id==row.id || drag.savingID==row.id,
                onFocus:onFocus,valid:store.dragValidator(for:row),canMove:{store.canReorder(row,action:$0)},move:{reorder(row,action:$0)})
                .frame(width:16,height:30)
            Button { select(row) } label:{Image(systemName:selection.contains(row.id) ? "checkmark.circle.fill" : "circle").foregroundStyle(selection.contains(row.id) ? Color.accentColor : Color.secondary.opacity(0.5)).frame(width:18,height:30)}
                .buttonStyle(.plain).accessibilityLabel(nativeUI("选择 ", "Select ") + row.title).accessibilityAddTraits(selection.contains(row.id) ? .isSelected : [])
            if drag.savingID==row.id {ProgressView().controlSize(.small).frame(width:26).accessibilityLabel(nativeUI("正在保存链接位置", "Saving link position"))}
            else {NativeQuickLinkIcon(dataURL:row.iconDataUrl,site:row.site)}
            Button { Task { await store.open(row) } } label: {
                VStack(alignment:.leading,spacing:4) {
                    Text(row.title).font(.system(size:13,weight:.medium)).lineLimit(2).foregroundStyle(.primary)
                    Text(row.site + (store.groupBySite ? " · " + row.folder : "")).font(.system(size:11)).foregroundStyle(.secondary).lineLimit(1)
                    if let description=row.siteDescription,!description.isEmpty {Text(description).font(.system(size:11)).foregroundStyle(.secondary).lineLimit(2)}
                    if row.fetchStatus=="failed", let error=row.fetchError, !error.isEmpty {
                        Text(error).font(.system(size:11)).foregroundStyle(.secondary).lineLimit(2)
                    }
                    if row.metadataStatus=="failed",let error=row.metadataError,!error.isEmpty {Text(error).font(.system(size:11)).foregroundStyle(.secondary).lineLimit(2)}
                }.frame(maxWidth:.infinity,alignment:.leading).contentShape(Rectangle())
            }.buttonStyle(.plain).help(row.url).accessibilityLabel(nativeUI("在浏览器打开：", "Open in browser: ") + row.title)
            if row.hasContent { Button { Task { await store.open(row,inLibrary:true) } } label:{Image(systemName:"doc.text").frame(width:28,height:30)}.buttonStyle(.plain).help(nativeUI("查看已保存资料", "View saved source")).accessibilityLabel(nativeUI("查看已保存资料：", "View saved source: ")+row.title) }
            else if row.canFetch == true {
                Button { Task { await store.fetchContent(row) } } label:{Image(systemName:row.fetchStatus=="failed" ? "arrow.clockwise" : "arrow.down.to.line").frame(width:28,height:30)}
                    .buttonStyle(.plain).disabled(store.hasUnsettledEditor)
                    .help(row.fetchStatus=="failed" ? nativeUI("重试获取正文", "Retry download") : nativeUI("获取正文", "Download content"))
                    .accessibilityLabel((row.fetchStatus=="failed" ? nativeUI("重试获取正文：", "Retry download: ") : nativeUI("获取正文：", "Download content: ")) + row.title)
            }
            Menu {
                Button(nativeUI("编辑标题与归属", "Edit title and destination")) { store.beginEditing(row); onFocus() }.disabled(store.hasUnsettledEditor)
                Button(nativeUI("在浏览器打开", "Open in browser")) { Task { await store.open(row) } }
                Button(nativeUI("在资料库查看", "View in library")) { Task { await store.open(row,inLibrary:true) } }
                if row.canFetch == true { Button(row.fetchStatus=="failed" ? nativeUI("重试获取正文", "Retry download") : nativeUI("获取正文", "Download content")) { Task { await store.fetchContent(row) } }.disabled(store.hasUnsettledEditor) }
                Button(row.metadataStatus=="failed" ? nativeUI("重试网站信息与图标", "Retry website details and icon") : nativeUI("获取网站信息与图标", "Fetch website details and icon")) {Task{await store.fetchMetadata(row)}}.disabled(store.hasUnsettledEditor)
                Divider()
                ForEach(NativeQuickLinkOrderAction.allCases, id:\.self) { action in
                    Button(action.title) { reorder(row,action:action) }.disabled(!store.canReorder(row,action:action))
                }
                if store.groupBySite || store.isSearching {
                    Text(nativeUI("在文件夹视图清除搜索后排序", "Clear search in Folder view to reorder"))
                }
                Divider()
                Button(nativeUI("移入回收站", "Move to Trash"),role:.destructive) { requestRemove([row]) }.disabled(store.hasUnsettledEditor)
            } label:{Image(systemName:"ellipsis").frame(width:28,height:30)}.menuStyle(.borderlessButton).fixedSize()
                .accessibilityLabel(row.title + nativeUI(" 更多操作", " more actions"))
        }.padding(.horizontal,7).padding(.vertical,8).background(selection.contains(row.id) || drag.settledID==row.id ? Color.accentColor.opacity(0.10) : Color.primary.opacity(0.025),in:RoundedRectangle(cornerRadius:10))
    }
    private func reorder(_ row: NativeQuickLinkRow, action: NativeQuickLinkOrderAction) {
        guard store.canReorder(row,action:action) else { return }
        arrange(row) { await store.reorder(row,action:action) }
    }
    private func commitDrag(_ row:NativeQuickLinkRow,target:NativeQuickLinkDropTarget) {
        guard store.canPlace(row,at:target) else {drag.cancel();return}
        arrange(row) { await store.place(row,at:target) }
    }
    private func arrange(_ row:NativeQuickLinkRow,save:@escaping () async->Bool) {
        guard store.visible,store.available else{return}
        onFocus()
        let token=orderFocus.begin(canRestore:store.moveFocusValidator(for:row))
        drag.beginSaving(row.id)
        Task { @MainActor in
            let saved=await save()
            drag.finishSaving(row.id,confirmed:saved)
            guard let token else{return}
            guard saved,orderFocus.owns(token) else{orderFocus.cancel(token);return}
            // Reveal only while this operation still owns the interaction.
            // No delayed callback expands a folder the user just collapsed.
            store.revealOrderedLink(row.id)
            await orderFocus.restore(token,id:row.id) { _ = drag.focus(row.id) }
        }
    }
    private var editor: some View {
        VStack(alignment:.leading,spacing:18) {
            if !store.editingGroup {
            VStack(alignment:.leading,spacing:7) {
                Text(nativeUI("网址", "URL")).foregroundStyle(.secondary)
                TextField("https://…",text:$store.url).textFieldStyle(.roundedBorder).disabled(store.editingExisting)
            }
            VStack(alignment:.leading,spacing:7) {
                Text(nativeUI("标题", "Title")).foregroundStyle(.secondary)
                TextField(nativeUI("留空时使用网站名称", "Use the site name when left blank"),text:$store.title).textFieldStyle(.roundedBorder)
            }
            }
            HStack(alignment:.top,spacing:16) {
                VStack(alignment:.leading,spacing:7) {
                    Text(nativeUI("保存位置", "Destination")).foregroundStyle(.secondary)
                    Picker(nativeUI("空间", "Workspace"),selection:$store.workspace) {
                        Text(nativeUI("日常", "Daily")).tag("日常"); Text(nativeUI("课程", "Courses")).tag("课程"); Text(nativeUI("科研", "Research")).tag("科研")
                    }.labelsHidden().onChange(of:store.workspace){_,_ in store.projectID=""}
                    Picker(nativeUI("项目", "Project"),selection:$store.projectID) {
                        Text(nativeUI("未归入项目", "No project")).tag("")
                        ForEach(store.projects.filter{$0.workspace==store.workspace}) { project in Text(project.title).tag(project.id) }
                    }.labelsHidden()
                }.frame(maxWidth:.infinity,alignment:.leading).disabled(store.editingGroup && store.editingExisting)
                VStack(alignment:.leading,spacing:7) {
                    Text(nativeUI("文件夹", "Folder")).foregroundStyle(.secondary)
                    TextField(nativeUI("分组名称", "Group name"),text:$store.folder).textFieldStyle(.roundedBorder)
                    siteGroupSuggestion
                }.frame(maxWidth:.infinity,alignment:.leading)
            }
            if !store.editingGroup && !store.editingExisting {
                Toggle(nativeUI("新增公开链接自动获取网站信息", "Fetch website details for new public links"), isOn: Binding(get:{store.automaticMetadata},set:{store.setAutomaticMetadata($0)}))
                    .toggleStyle(.switch).controlSize(.small).disabled(!store.canChangeAutomaticMetadata)
            }
            Text(store.editingGroup ? nativeUI("这是共享资料目录，空目录也会保留。", "This is a shared library folder, retained even when empty.") : !store.editingExisting && store.automaticMetadata ? nativeUI("先保存收藏，再访问公开网站获取标题、简介与图标；保留手填内容。", "Saves the bookmark first, then visits the public site for its title, description and icon. Your own content stays intact.") : nativeUI("仅保存网址与这些信息，不会自动访问网站。", "Saves the URL and these details without automatically visiting the site.")).font(.system(size:11)).foregroundStyle(.secondary)
            HStack {
                Spacer()
                Button(nativeUI("取消", "Cancel")) { if store.hasChanges { confirmDiscard=true } else { _ = store.discardDraft() } }
                Button(store.editingGroup ? nativeUI("保存分组", "Save folder") : nativeUI("保存链接", "Save link")) { Task { await store.saveEditor() } }.keyboardShortcut("s",modifiers:.command).disabled(!store.canSave)
            }
            Spacer(minLength:0)
        }.font(.system(size:12)).disabled(store.inputLocked).frame(maxWidth:640,alignment:.leading).padding(.top,8).frame(maxWidth:.infinity,alignment:.center)
    }
    @ViewBuilder private var siteGroupSuggestion: some View {
        let suggestions=store.siteGroupSuggestions
        if suggestions.count==1,let group=suggestions.first {
            if store.folder==group.folder {
                Label(nativeUI("与同站点收藏保存在一起", "Save with this site's bookmarks"),systemImage:"link")
                    .font(.system(size:11)).foregroundStyle(.secondary)
            } else {
                Button { _ = store.useSiteGroupSuggestion(group) } label: {
                    Label(nativeUI("使用已有分组：\(group.folder)", "Use existing folder: \(group.folder)"),systemImage:"link")
                        .lineLimit(2).multilineTextAlignment(.leading)
                }.buttonStyle(.plain).font(.system(size:11)).foregroundStyle(Color.accentColor)
                    .help(nativeUI("同站点的链接已在当前项目的这个分组中", "This site has bookmarks in this folder within the current project"))
            }
        } else if suggestions.count>1 {
            Menu {
                ForEach(suggestions) { group in
                    Button { _ = store.useSiteGroupSuggestion(group) } label: {
                        if store.folder==group.folder {Label(group.folder,systemImage:"checkmark")}
                        else {Text(group.folder)}
                    }
                }
            } label: {Label(nativeUI("同站点有 \(suggestions.count) 个分组，选择…", "This site has \(suggestions.count) folders. Choose…"),systemImage:"link")}
                .font(.system(size:11)).menuStyle(.borderlessButton).fixedSize(horizontal:false,vertical:true)
        }
    }
    private var trash: some View {
        ScrollView {
            LazyVStack(alignment:.leading,spacing:10) {
                if store.trash.isEmpty { Text(nativeUI("没有从链接库删除的资料", "No sources deleted from the link library")).foregroundStyle(.secondary).frame(maxWidth:.infinity).padding(.vertical,50) }
                ForEach(store.trash) { entry in
                    HStack(spacing:12) {
                        Image(systemName:"trash").foregroundStyle(.secondary)
                        VStack(alignment:.leading,spacing:4) {
                            Text(entry.title).lineLimit(2)
                            Text(nativeUI("\(entry.count) 个链接", "\(entry.count) links")).font(.system(size:11)).foregroundStyle(.secondary)
                        }.frame(maxWidth:.infinity,alignment:.leading)
                        Button(nativeUI("恢复", "Restore")) { Task { await store.restore(entry) } }.disabled(store.hasUnsettledEditor)
                    }.padding(12).background(.primary.opacity(0.035),in:RoundedRectangle(cornerRadius:10))
                }
            }.padding(.vertical,4)
        }.scrollIndicators(.hidden)
    }
    private func requestRemove(_ rows: [NativeQuickLinkRow]) { guard !rows.isEmpty else { return }; removing=rows; confirmRemove=true }
    private func select(_ row: NativeQuickLinkRow) {
        let visible=groups.filter{!store.isGroupCollapsed($0.id)}.flatMap(\.rows)
        if NSEvent.modifierFlags.contains(.shift), let anchor=selectionAnchor, let start=visible.firstIndex(where:{$0.id==anchor}), let end=visible.firstIndex(where:{$0.id==row.id}) { selection.formUnion(visible[min(start,end)...max(start,end)].map(\.id)) }
        else { if !selection.insert(row.id).inserted { selection.remove(row.id) }; selectionAnchor=row.id }
    }
}

/// A single explicit ordering action may return to its own menu after the
/// durable reply. New user input always wins over LazyVStack's focus fallback.
/// This owns presentation only; no link order or retry data is cached here.
@MainActor final class NativeQuickLinkOrderFocus: ObservableObject {
    let position = NativeQuickRecordFocus()
    private var token: UUID?
    private var canRestore: (() -> Bool)?
    private weak var window: NSWindow?
    private var monitor: Any?
    private var resignObserver: NSObjectProtocol?
    // Tests replace ownership only. Production checks the actual originating
    // window and never activates it, reads accessibility or monitors globally.
    private let keyboardOwned: (() -> Bool)?
    init(keyboardOwned: (() -> Bool)? = nil) { self.keyboardOwned = keyboardOwned }
    func attach(_ window: NSWindow?) {
        guard self.window !== window else { return }
        cancel(); self.window = window
    }
    func begin(canRestore: @escaping () -> Bool) -> UUID? {
        cancel()
        guard hasKeyboardOwnership, canRestore() else { return nil }
        let token = UUID(); self.token = token; self.canRestore = canRestore
        if let window {
            monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown,.leftMouseDown,.rightMouseDown,.otherMouseDown,.scrollWheel]) { [weak self, weak window] event in
                MainActor.assumeIsolated {
                    if event.window === window || (event.window == nil && NSApp.keyWindow === window) { self?.receiveUserEvent(event) }
                }
                return event
            }
            resignObserver = NotificationCenter.default.addObserver(forName:NSWindow.didResignKeyNotification,object:window,queue:.main) { [weak self] _ in
                MainActor.assumeIsolated { self?.cancel() }
            }
        }
        return token
    }
    func receiveUserEvent(_ event: NSEvent) {
        if event.type == .keyDown && event.isARepeat { return }
        cancel()
    }
    func owns(_ token: UUID) -> Bool { self.token == token && hasKeyboardOwnership && canRestore?() == true }
    func restore(_ token: UUID, id: String, apply: () -> Void) async {
        guard owns(token) else { if self.token == token { cancel() }; return }
        let mounted = await position.present(id:id,show:{},canPresent:{[weak self] in self?.owns(token) == true},isPresented:{[weak self] in self?.hasKeyboardOwnership == true})
        // ACK can resume after another input event. Revalidate synchronously
        // with the retained native geometry before setting SwiftUI focus.
        guard mounted, owns(token), position.isStillPresented(id:id) else { if self.token == token { cancel() }; return }
        apply(); cancel()
    }
    func cancel() {
        token = nil; canRestore = nil; position.cancel()
        if let monitor { NSEvent.removeMonitor(monitor) }; monitor = nil
        if let resignObserver { NotificationCenter.default.removeObserver(resignObserver) }; resignObserver = nil
    }
    func cancel(_ token: UUID) { if self.token == token { cancel() } }
    private var hasKeyboardOwnership: Bool {
        if let keyboardOwned { return keyboardOwned() }
        return window?.isKeyWindow == true && window?.isVisible == true && !(window?.firstResponder is NSTextView)
    }
    deinit {
        if let monitor { NSEvent.removeMonitor(monitor) }
        if let resignObserver { NotificationCenter.default.removeObserver(resignObserver) }
    }
}

private struct NativeQuickLinkOrderWindow: NSViewRepresentable {
    let focus: NativeQuickLinkOrderFocus
    func makeNSView(context: Context) -> Probe { let view=Probe(); view.focus=focus; return view }
    func updateNSView(_ view: Probe, context: Context) { view.focus=focus; focus.attach(view.window) }
    static func dismantleNSView(_ view: Probe, coordinator: ()) { view.focus?.attach(nil); view.focus=nil }
    final class Probe: NSView {
        weak var focus: NativeQuickLinkOrderFocus?
        override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); focus?.attach(window) }
        override func hitTest(_ point:NSPoint) -> NSView? { nil }
    }
}
