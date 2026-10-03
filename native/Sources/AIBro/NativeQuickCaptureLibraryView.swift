import SwiftUI
import AppKit

/// TO-DO Panel's notes library composition: searchable list, selected detail,
/// and an in-place editor. Persistence deliberately follows AI Bro's explicit
/// Save/version contract rather than upstream's 220 ms archive overwrite.
struct NativeQuickCaptureLibraryView: View {
    @ObservedObject var store: NativeQuickCaptureLibraryStore
    var onFocus: () -> Void = {}
    var onNew: () -> Void = {}
    @State private var showingDiscard = false
    @State private var showingDelete = false
    @State private var deletingID: String?
    @State private var showingStopRetry = false
    @State private var narrowDetail = false
    @State private var editorFocused = false
    var body: some View {
        GeometryReader { geometry in
            let compact = geometry.size.width < 590
            let showDetail = narrowDetail || store.focusedRecordID != nil
            VStack(alignment:.leading,spacing:10) {
            if store.available { lifecycleStatus }
            HStack(spacing:0) {
                if !compact || !showDetail { library.frame(width:compact ? nil:230) }
                if !compact { Divider().padding(.horizontal,14) }
                if !compact || showDetail {
                    VStack(alignment:.leading,spacing:10) {
                        if compact {
                            Button { editorFocused = false; _ = store.flushDraft();store.clearRecordFocus(); narrowDetail = false } label: { Label(nativeUI("随记列表", "Captures"),systemImage:"chevron.left") }.buttonStyle(.plain).font(.system(size:11)).foregroundStyle(.secondary)
                        }
                        detail.background(NativeQuickRecordFocusMarker(focus:store.recordFocus,id:store.selectedID ?? ""))
                    }.frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.topLeading)
                }
            }
            }
        }
        .task(id:String(store.available) + ":" + store.query) {
            if !store.query.isEmpty { do { try await Task.sleep(nanoseconds:180_000_000) } catch { return } }
            guard !Task.isCancelled else { return }; await store.refresh()
        }
        .onDisappear { editorFocused = false;store.cancelTitleGeneration();store.clearRecordFocus(); _ = store.flushDraft() }
        .confirmationDialog(nativeUI("放弃这条随记的本次编辑？", "Discard this capture's draft?"),isPresented:$showingDiscard) {
            Button(nativeUI("放弃草稿，重新载入", "Discard draft and reload"),role:.destructive) { Task { await store.discardSelectedDraft() } }
            Button(nativeUI("继续编辑", "Keep editing"),role:.cancel) {}
        } message: { Text(nativeUI("会重新载入工作区当前版本，不会删除已保存的随记。", "Reloads the current workspace version. The saved capture is not deleted.")) }
        .confirmationDialog(nativeUI("将这条随记移入回收站？", "Move this capture to Trash?"),isPresented:$showingDelete) {
            Button(nativeUI("移入回收站", "Move to Trash"),role:.destructive) { guard deletingID == store.selectedID else { return }; editorFocused = false; Task { await store.removeSelected() } }
            Button(nativeUI("取消", "Cancel"),role:.cancel) {}
        } message: { Text(nativeUI("只删除这条原始随记；附件、由此产生的笔记和任务会保留。可在“最近删除”中恢复。", "Only this original capture is removed. Attachments, derived notes and tasks remain. Restore it from Recently Deleted.")) }
        .confirmationDialog(nativeUI("保留恢复记录并结束重试？", "Keep recovery record and stop retrying?"),isPresented:$showingStopRetry) {
            Button(nativeUI("保留记录，结束重试", "Keep record and stop")) { _ = store.keepLifecycleRecovery() }
            Button(nativeUI("继续处理", "Keep retrying"),role:.cancel) {}
        } message: { Text(nativeUI("这不会撤销可能已经保存的删除或恢复操作。恢复记录会保留在本机。", "This does not undo a deletion or restore that may already have saved. A recovery record remains on this Mac.")) }
    }
    @ViewBuilder private var lifecycleStatus: some View {
        if let pending = store.pendingLifecycle {
            VStack(alignment:.leading,spacing:6) {
                HStack(spacing:8) {
                    if store.saving { ProgressView().controlSize(.mini) }
                    Text(nativeUI(pending.action == "remove" ? "正在确认删除":"正在确认恢复", pending.action == "remove" ? "Confirming deletion":"Confirming restore")).font(.system(size:11,weight:.medium))
                    Text(pending.title).font(.system(size:11)).foregroundStyle(.secondary).lineLimit(1)
                    Spacer(minLength:0)
                    Button(nativeUI("重试", "Retry")) { Task { await store.retryLifecycle() } }.buttonStyle(.plain).disabled(store.saving)
                    Button(nativeUI("保留恢复记录", "Keep recovery record")) { showingStopRetry = true }.buttonStyle(.plain).disabled(store.saving)
                }
                if let message = store.draftError ?? store.lifecycleError { Text(message).font(.system(size:11)).foregroundStyle(.red).fixedSize(horizontal:false,vertical:true) }
            }.padding(10).background(.primary.opacity(0.035),in:RoundedRectangle(cornerRadius:9))
        } else if let notice = store.notice { Text(notice).font(.system(size:11)).foregroundStyle(.secondary) }
    }
    private var library: some View {
        VStack(alignment:.leading,spacing:12) {
            HStack {
                Text(store.showingTrash ? nativeUI("最近删除", "Recently Deleted") : nativeUI("随记", "Captures")).font(.system(size:15,weight:.semibold))
                Text(String(store.showingTrash ? store.trash.count : store.total)).font(.system(size:10,design:.monospaced)).foregroundStyle(.tertiary)
                Spacer()
                Button { Task { await store.refresh(); if !store.showingTrash, let id = store.selectedID { await store.select(id) } } } label: { Image(systemName:"arrow.clockwise") }.buttonStyle(.plain).help(nativeUI("刷新随记", "Refresh captures")).disabled(store.loading || store.saving)
                Button(action:onNew) { Image(systemName:"plus") }.buttonStyle(.plain).help(nativeUI("新建随记", "New capture"))
            }
            Button(store.showingTrash ? nativeUI("所有随记", "All captures") : nativeUI("最近删除", "Recently Deleted")) { editorFocused = false; narrowDetail = false; Task { await store.toggleTrash() } }.buttonStyle(.plain).font(.system(size:11)).foregroundStyle(.secondary).disabled(store.saving)
            if !store.showingTrash {
            HStack(spacing:6) {
                Image(systemName:"magnifyingglass").foregroundStyle(.tertiary)
                TextField(nativeUI("搜索内容与标签", "Search text and tags"),text:$store.query).textFieldStyle(.plain).font(.system(size:12)).onTapGesture(perform:onFocus)
                if !store.query.isEmpty { Button { store.query = "" } label: { Image(systemName:"xmark.circle.fill").foregroundStyle(.tertiary) }.buttonStyle(.plain).help(nativeUI("清空搜索", "Clear search")) }
            }.padding(8).background(.primary.opacity(0.035),in:RoundedRectangle(cornerRadius:8))
            }
            if let error = store.error { Text(error).font(.system(size:11)).foregroundStyle(.red).fixedSize(horizontal:false,vertical:true) }
            ScrollView {
                LazyVStack(alignment:.leading,spacing:4) {
                    if store.showingTrash {
                        ForEach(store.trash) { item in trashRow(item) }
                        if store.trash.isEmpty && !store.loading { Text(nativeUI("在这里恢复从灵动岛删除的随记", "Captures deleted from the island can be restored here")).font(.system(size:12)).foregroundStyle(.secondary).padding(.vertical,24).frame(maxWidth:.infinity) }
                    } else {
                    ForEach(store.rows) { note in
                        Button { editorFocused = false; Task { await store.select(note.id); if store.selectedID == note.id { narrowDetail = true } } } label: {
                            VStack(alignment:.leading,spacing:5) {
                                HStack(alignment:.firstTextBaseline,spacing:5) {
                                    Text(note.title).font(.system(size:12,weight:.medium)).lineLimit(1)
                                    if store.hasDraft(note.id) { Circle().fill(Color.accentColor).frame(width:4,height:4).accessibilityLabel(nativeUI("有编辑草稿", "Has an edit draft")) }
                                    Spacer(minLength:0)
                                }
                                Text(note.excerpt.isEmpty ? nativeUI("附件随记", "Capture with attachments") : note.excerpt).font(.system(size:11)).foregroundStyle(.secondary).lineLimit(2)
                                Text(Date(timeIntervalSince1970:note.updatedAt/1000),style:.date).font(.system(size:9,design:.monospaced)).foregroundStyle(.tertiary)
                            }.frame(maxWidth:.infinity,alignment:.leading).padding(.horizontal,10).padding(.vertical,10)
                                .background(store.selectedID == note.id ? Color.accentColor.opacity(0.10):Color.primary.opacity(0.025),in:RoundedRectangle(cornerRadius:9))
                        }.buttonStyle(.plain).disabled(store.saving || store.pendingLifecycle != nil).accessibilityAddTraits(store.selectedID == note.id ? .isSelected:[])
                    }
                    if store.rows.isEmpty && !store.loading { Text(store.query.isEmpty ? nativeUI("保存的随记会出现在这里", "Your saved captures appear here") : nativeUI("没有匹配的随记", "No matching captures")).font(.system(size:12)).foregroundStyle(.secondary).padding(.vertical,24).frame(maxWidth:.infinity) }
                    }
                    if store.loading { ProgressView().controlSize(.small).frame(maxWidth:.infinity).padding(10) }
                    else if !store.showingTrash && store.nextOffset != nil { Button(nativeUI("载入更多", "Load more")) { Task { await store.refresh(loadMore:true) } }.buttonStyle(.plain).font(.system(size:11)).foregroundStyle(.tint).frame(maxWidth:.infinity).padding(10) }
                }
            }
        }.frame(maxHeight:.infinity,alignment:.top)
    }
    @ViewBuilder private var detail: some View {
        if store.showingTrash {
            Text(nativeUI("恢复后，原随记会回到资料库。附件和派生成果保留。", "Restored captures return to the library. Attachments and derived work are retained.")).font(.system(size:12)).foregroundStyle(.secondary).frame(maxWidth:.infinity,maxHeight:.infinity)
        } else if let note = store.selected {
            VStack(alignment:.leading,spacing:10) {
                HStack(alignment:.top,spacing:12) {
                    VStack(alignment:.leading,spacing:4) {
                        if store.editing {
                            TextField(nativeUI("随记标题", "Capture title"),text:$store.title).textFieldStyle(.plain).font(.system(size:15,weight:.semibold)).disabled(store.inputLocked).accessibilityLabel(nativeUI("编辑随记标题", "Edit capture title")).onTapGesture(perform:onFocus)
                        } else { Text(note.title).font(.system(size:15,weight:.semibold)).lineLimit(2) }
                        HStack(spacing:6) {
                            Text(nativeUI("原始随记", "Original capture"))
                            Text(Date(timeIntervalSince1970:note.updatedAt/1000),style:.date)
                        }.font(.system(size:10)).foregroundStyle(.secondary)
                    }
                    Spacer(minLength:0)
                    Button { Task { await store.open() } } label: { Image(systemName:"arrow.up.right.square") }.buttonStyle(.plain).help(nativeUI("在主窗口打开", "Open in main window")).disabled(store.saving)
                    if !store.editing { Button(nativeUI(store.hasDraft(note.id) ? "继续编辑":"编辑", store.hasDraft(note.id) ? "Resume edit":"Edit")) { onFocus(); store.beginEditing(); editorFocused = true }.buttonStyle(.plain).font(.system(size:11)).disabled(!store.canEdit) }
                    if !store.editing { Button { deletingID = note.id; showingDelete = true } label: { Image(systemName:"trash") }.buttonStyle(.plain).help(nativeUI("移入回收站", "Move to Trash")).disabled(!store.canRemoveSelected) }
                }
                HStack(spacing:8) {
                    Button { onFocus(); Task { await store.generateTitle() } } label: {
                        Label(nativeUI("智能命名", "Suggest title"),systemImage:"sparkles")
                    }.buttonStyle(.plain).disabled(!store.canGenerateTitle)
                        .help(nativeUI("用已配置的模型概括正文，人工标题保持优先；采纳后保存修改。", "Summarize with your configured model. Manual titles take priority; review the suggestion and save changes."))
                    if store.generatingTitle {
                        ProgressView().controlSize(.mini)
                        Text(nativeUI("正在生成标题…", "Generating title…")).foregroundStyle(.secondary)
                        Button(nativeUI("停止", "Stop")) { store.cancelTitleGeneration() }.buttonStyle(.plain)
                    }
                    Spacer(minLength:0)
                }.font(.system(size:11))
                if let suggestion = store.suggestedTitle {
                    VStack(alignment:.leading,spacing:6) {
                        Text(suggestion).font(.system(size:13,weight:.medium)).textSelection(.enabled).fixedSize(horizontal:false,vertical:true)
                        HStack(spacing:10) {
                            if let model = store.titleModel { Text(model).lineLimit(1).foregroundStyle(.secondary) }
                            Spacer(minLength:0)
                            Button(nativeUI("不用此标题", "Dismiss")) { store.cancelTitleGeneration() }.buttonStyle(.plain)
                            Button(nativeUI("采纳到标题", "Use title")) { onFocus(); store.applySuggestedTitle() }.buttonStyle(.plain).foregroundStyle(.tint)
                        }.font(.system(size:11))
                    }.padding(10).background(.primary.opacity(0.035),in:RoundedRectangle(cornerRadius:8))
                }
                if let message = store.titleError { Text(message).font(.system(size:11)).foregroundStyle(.red).fixedSize(horizontal:false,vertical:true) }
                if store.editing {
                    NativeQuickCaptureTextEditor(text:$store.text, focused:$editorFocused, locked:store.inputLocked,
                        label:nativeUI("编辑随记正文", "Edit capture text"), onFocus:onFocus)
                        .id(note.id).padding(8).background(.primary.opacity(0.025),in:RoundedRectangle(cornerRadius:9))
                        .help(nativeUI("⌘B 加粗 · ⌘I 斜体 · 回车续列表", "⌘B bold · ⌘I italic · Return continues lists"))
                    TextField(nativeUI("标签，以逗号分隔", "Tags, comma separated"),text:$store.tags).textFieldStyle(.plain).font(.system(size:11)).padding(8).background(.primary.opacity(0.025),in:RoundedRectangle(cornerRadius:7)).disabled(store.inputLocked)
                    if store.text.utf16.count > 200_000 { Text(nativeUI("正文最多 200,000 个字符。", "Text supports up to 200,000 characters.")).font(.system(size:11)).foregroundStyle(.red) }
                    if !store.validTitle { Text(nativeUI("标题不能为空，最多 500 个字符且不含换行。", "Use a nonempty title up to 500 characters without line breaks.")).font(.system(size:11)).foregroundStyle(.red) }
                    if let message = store.draftError ?? store.editError { Text(message).font(.system(size:11)).foregroundStyle(.red).fixedSize(horizontal:false,vertical:true) }
                    HStack(spacing:12) {
                        Button(nativeUI("保留草稿", "Keep draft")) { editorFocused = false; store.endEditing() }.buttonStyle(.plain).disabled(store.saving)
                        if store.conflicted || store.pending != nil || store.draftError != nil {
                            Button(nativeUI("复制草稿", "Copy draft")) { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(store.title + "\n\n" + store.text,forType:.string) }.buttonStyle(.plain)
                        }
                        if store.hasChanges { Button(nativeUI("放弃编辑", "Discard edit")) { showingDiscard = true }.buttonStyle(.plain).foregroundStyle(.secondary).disabled(store.saving) }
                        Spacer(minLength:0)
                        if store.saving { ProgressView().controlSize(.mini) }
                        Button(store.pending == nil ? nativeUI("保存修改", "Save changes") : nativeUI("重试保存", "Retry save")) { editorFocused = false; Task { await store.save() } }.buttonStyle(.borderedProminent).controlSize(.small).disabled(!store.canSave)
                    }.font(.system(size:11))
                } else {
                    ScrollView {
                        VStack(alignment:.leading,spacing:16) {
                            Text(note.content ?? "").font(.system(size:13)).lineSpacing(5).textSelection(.enabled).frame(maxWidth:.infinity,alignment:.leading)
                            if !note.tags.isEmpty { Text(note.tags.map { "#" + $0 }.joined(separator:"  ")).font(.system(size:11)).foregroundStyle(.secondary) }
                            linkedSection(nativeUI("原始附件", "Original attachments"),note.attachments ?? [])
                            linkedSection(nativeUI("由此产生的成果", "Derived work"),note.derived ?? [])
                            if let message = store.draftError ?? store.editError { Text(message).font(.system(size:11)).foregroundStyle(.red).fixedSize(horizontal:false,vertical:true) }
                        }.padding(.vertical,4)
                    }
                    if store.hasDraft(note.id) { Text(nativeUI("本机保留了未提交的编辑草稿。", "An unpublished edit draft is retained on this Mac.")).font(.system(size:10)).foregroundStyle(.secondary) }
                }
            }.frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.topLeading)
        } else {
            VStack(spacing:12) {
                if store.selecting { ProgressView().controlSize(.small) }
                else { Image(systemName:"note.text").font(.system(size:24,weight:.light)).foregroundStyle(.tertiary) }
                Text(store.editError ?? nativeUI("选择一条随记", "Select a capture")).font(.system(size:12)).foregroundStyle(.secondary).multilineTextAlignment(.center)
                if let message = store.draftError { Text(message).font(.system(size:11)).foregroundStyle(.red) }
            }.frame(maxWidth:.infinity,maxHeight:.infinity)
        }
    }
    private func trashRow(_ item: NativeQuickCaptureLibraryTrash) -> some View {
        HStack(spacing:10) {
            VStack(alignment:.leading,spacing:5) {
                Text(item.title).font(.system(size:12,weight:.medium)).lineLimit(2)
                Text(Date(timeIntervalSince1970:item.deletedAt/1000),style:.date).font(.system(size:9,design:.monospaced)).foregroundStyle(.tertiary)
            }
            Spacer(minLength:0)
            Button(nativeUI("恢复", "Restore")) { Task { await store.restore(item) } }.buttonStyle(.plain).font(.system(size:11)).disabled(!store.canEdit || store.hasUnsettledEditor).accessibilityLabel(nativeUI("恢复 ", "Restore ") + item.title)
        }.padding(10).background(.primary.opacity(0.025),in:RoundedRectangle(cornerRadius:9))
    }
    @ViewBuilder private func linkedSection(_ title: String, _ links: [NativeQuickCaptureLibraryLink]) -> some View {
        if !links.isEmpty {
            VStack(alignment:.leading,spacing:7) {
                Text(title).font(.system(size:10,weight:.medium)).foregroundStyle(.secondary)
                ForEach(links,id:\.identity) { link in
                    Button { Task { await store.open(link) } } label: { HStack(spacing:7) { Image(systemName:link.type == "task" ? "checkmark.circle":"doc.text"); Text(link.title).lineLimit(2); Spacer(minLength:0); Image(systemName:"arrow.up.right").font(.system(size:9)) } }.buttonStyle(.plain).font(.system(size:11))
                }
            }
        }
    }
}
