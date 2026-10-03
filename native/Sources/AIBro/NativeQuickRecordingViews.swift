import AppKit
import SwiftUI

// Adapted from TO-DO Panel's recordings-page/library/detail structure:
// renderer/index.html:347–364, styles.css:2507–2565,
// renderer/workspace.js:1792–1919. The native store owns all real state.
enum NativeQuickRecordingLayout {
    static let splitThreshold: CGFloat = 700
    static func sidebarWidth(available: CGFloat) -> CGFloat { min(292, max(234, available * 0.27)) }
    static func clock(_ value: TimeInterval) -> String {
        let seconds = Int(min(Double(Int.max / 2), max(0, value.isFinite ? value : 0)))
        if seconds >= 3600 { return String(format: "%d:%02d:%02d", seconds / 3600, (seconds / 60) % 60, seconds % 60) }
        return String(format: "%02d:%02d", seconds / 60, seconds % 60)
    }
}

struct NativeQuickRecorderCard: View {
    @ObservedObject var store: NativeQuickRecordingStore
    var onFocus:()->Void = {}
    var canFocus:()->Bool = {true}
    @Environment(\.nativeQuickWidgetContext) private var widget
    private var compact: Bool { !widget.isDetail && widget.size == "mini" }
    var body: some View {
        if widget.isDetail {
            NativeQuickRecordingLibrary(store:store,onFocus:onFocus,canFocus:canFocus)
        } else if compact {
            // A mini tile has only about 46pt after its chrome. Keep a single
            // real action here; pause and the full library remain in Expand.
            HStack(spacing: 8) {
                Text(Self.clock(store.elapsed)).font(.system(size: 16, weight: .medium, design: .monospaced)).monospacedDigit()
                Spacer(minLength: 0)
                if let error = store.error { Image(systemName: "exclamationmark.circle").font(.system(size: 11)).foregroundStyle(.orange).help(error) }
                Button {
                    if store.phase == .recording || store.phase == .paused { store.stop() }
                    else { Task { await store.start() } }
                } label: {
                    Image(systemName: store.phase == .recording || store.phase == .paused ? "stop.fill" : "record.circle")
                        .font(.system(size: 13)).frame(width: 27, height: 27)
                        .background(.white.opacity(0.065), in: RoundedRectangle(cornerRadius: 7))
                }.buttonStyle(.plain).disabled(!store.available || !store.ready || store.phase == .authorizing || store.phase == .saving || store.transcribingID != nil)
                    .help(store.phase == .recording || store.phase == .paused ? nativeUI("结束并保存录音", "Finish and save recording") : nativeUI("开始录音", "Start recording"))
            }.frame(maxWidth: .infinity, alignment: .leading)
        } else {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    Circle().fill(store.phase == .recording ? Color.red : Color.secondary.opacity(0.6)).frame(width: 6, height: 6)
                    Text(Self.clock(store.elapsed)).font(.system(size: 21, weight: .medium, design: .monospaced)).monospacedDigit()
                    Spacer(minLength: 0)
                    if let error = store.error { Image(systemName: "exclamationmark.circle").font(.system(size: 11)).foregroundStyle(.orange).help(error) }
                    else if store.phase == .paused { Text(nativeUI("暂停", "Paused")).font(.system(size: 11)).foregroundStyle(.secondary) }
                }
                NativeQuickRecordingLevel(level: store.phase == .recording ? store.level : 0).frame(height: 3)
                NativeQuickRecordingControls(store: store, compact: true)
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    static func clock(_ value: TimeInterval) -> String { NativeQuickRecordingLayout.clock(value) }
}

/// The shell supplies the outside gutter. This view owns only the two content
/// surfaces, so changing tabs cannot accumulate another layer of page padding.
struct NativeQuickRecordingLibrary: View {
    @ObservedObject var store: NativeQuickRecordingStore
    var onFocus:()->Void = {}
    var canFocus:()->Bool = {true}
    @State private var mounted=false
    @State private var focusRequest=0
    @State private var showDeleted = false
    @State private var selectedID: String?
    @State private var query = ""
    @State private var compactDetail = false
    @State private var categoryFilter:String? = nil
    @State private var multi = NativeQuickRecordingSelection()
    @State private var selecting = false
    @FocusState private var focusedRow:String?
    @State private var batchRequest:NativeQuickRecordingBatchRequest?
    @State private var confirmingBatch = false
    @State private var categorizing=false
    @State private var showRealtimeSettings=false
    @State private var projectionCache = NativeQuickRecordingProjection.Cache()
    @Environment(\.colorScheme) private var colorScheme
    private var projection: NativeQuickRecordingProjection.Result {
        projectionCache.resolve(owner: ObjectIdentifier(store), available: store.available,
            items: store.items, query: query, showingDeleted: showDeleted, category: categoryFilter)
    }
    private var filtered: [NativeQuickRecordingItem] { projection.items }
    private var selection: NativeQuickRecordingItem? { filtered.first { $0.id == selectedID } }
    private var selectableIDs:[String] {filtered.filter{$0.state != "recording" && $0.id != store.transcribingID && store.transcriptDrafts[$0.id]==nil}.map(\.id)}
    private var categoryDraft:Binding<String> {Binding(get:{store.categoryDraft?.text ?? ""},set:{store.editCategory($0)})}
    private var filterCategories:[String] { projection.categories }
    private var activeCount: Int { projection.activeCount }

    var body: some View {
        GeometryReader { proxy in
            let split = proxy.size.width >= NativeQuickRecordingLayout.splitThreshold
            VStack(spacing: 12) {
              if !store.available {
                Text(nativeUI("当前工作区的录音暂不可用", "Recordings are unavailable in this workspace")).font(.system(size:12)).foregroundStyle(.secondary).frame(maxWidth:.infinity,maxHeight:.infinity)
              } else {
                toolbar(compact: !split)
                if let error = store.error {
                    Label(error, systemImage: "exclamationmark.circle")
                        .font(.system(size: 11)).foregroundStyle(.orange)
                        .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
                }
                if split {
                    HStack(spacing: 14) {
                        sidebar.frame(width: NativeQuickRecordingLayout.sidebarWidth(available: proxy.size.width))
                        detail(showBack: false).frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                } else if compactDetail, selection != nil {
                    detail(showBack: true)
                } else {
                    sidebar
                }
                if store.categoryDraft != nil || store.titleDraft != nil || store.suggestionDraft != nil || store.realtimeSettingsDraft != nil || store.speechSettingsDraft != nil {
                    Button(nativeUI("继续编辑未提交的录音更改", "Continue pending recording edit")){resumeMetadataEditor()}
                        .buttonStyle(.plain).font(.system(size:11)).frame(maxWidth:.infinity,alignment:.leading)
                }
                if let notice=store.batchNotice {
                    HStack(spacing:8) {
                        Text(notice).font(.system(size:11)).foregroundStyle(.secondary).lineLimit(1)
                        Spacer(minLength:4)
                        if store.canUndoBatch {Button(nativeUI("撤销", "Undo")){_ = store.undoBatch()}.buttonStyle(.plain).font(.system(size:11))}
                        Button{store.dismissBatchNotice()}label:{Image(systemName:"xmark").font(.system(size:9))}.buttonStyle(.plain).accessibilityLabel(nativeUI("关闭提示", "Dismiss notice"))
                    }
                }
              }
            }.frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
        }
        .onAppear { mounted=true;reconcileSelection();resumeMetadataEditor() }
        .onDisappear {mounted=false;projectionCache.clear();cancelRowFocus();store.cancelSuggestion();store.stopPlayback()}
        .onChange(of:selection?.id) { _, id in store.selectPlayback(id) }
        .onChange(of:selecting){_,active in if !active{cancelRowFocus()}}
        .onChange(of: filtered.map(\.id)) { _, _ in reconcileSelection();multi.reconcile(selectableIDs) }
        .onChange(of:store.available){_,available in if !available {projectionCache.clear();cancelRowFocus();multi.clear();selecting=false;selectedID=nil;compactDetail=false;categorizing=false;confirmingBatch=false;showRealtimeSettings=false}else{resumeMetadataEditor()}}
        .confirmationDialog(showDeleted ? nativeUI("恢复所选录音？", "Restore selected recordings?"):nativeUI("将所选录音移到最近删除？", "Move selected recordings to Deleted?"),isPresented:$confirmingBatch) {
            Button(showDeleted ? nativeUI("恢复", "Restore"):nativeUI("移到最近删除", "Move to Deleted")){if let batchRequest,store.applyBatch(batchRequest){multi.clear();selecting=false};batchRequest=nil}
            Button(nativeUI("取消", "Cancel"),role:.cancel){batchRequest=nil}
        } message:{Text(nativeUI("音频与转写文字会完整保留。", "Audio and transcript text are retained."))}
        .sheet(isPresented:Binding(get:{store.available && store.speechSettingsDraft != nil},set:{shown in if !shown && store.available{store.cancelSpeechSettings()}})) {
            NativeSpeechSettingsView(store:store,settings:store.speechSettings,onClose:{store.cancelSpeechSettings()})
                .preferredColorScheme(colorScheme)
        }
        .sheet(isPresented:$showRealtimeSettings) {
            NativeQuickRealtimeASRSettingsView(store:store,settings:store.realtimeSettings,onClose:{showRealtimeSettings=false})
                .preferredColorScheme(colorScheme)
        }
        .onChange(of: store.phase) { old, new in
            // An actual newly created recording is selected when capture starts.
            // Timer and meter ticks never change selection or animate the page.
            if new == .recording, old != .paused, let item = store.items.first(where: { $0.state == "recording" && $0.deletedAt == nil }) {
                showDeleted = false; query = ""; selectedID = item.id; compactDetail = true
            }
        }
    }

    private func toolbar(compact: Bool) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(nativeUI("录音资料库", "Recordings")).font(.system(size: 15, weight: .semibold))
                Text(store.isActive ? phaseLabel : nativeUI("本机音频与转写文字", "Local audio and transcripts"))
                    .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 8)
            if store.isActive {
                if !compact { NativeQuickRecordingLevel(level: store.phase == .recording ? store.level : 0).frame(width: 66, height: 3) }
                Text(NativeQuickRecordingLayout.clock(store.elapsed)).font(.system(size: 12, weight: .medium, design: .monospaced)).monospacedDigit()
            }
            Menu {
                Button(store.speechSettings.busy ? nativeUI("正在读取云转写设置…", "Loading cloud settings…") : nativeUI("云转写设置…", "Cloud transcription settings…")){openSpeechSettings()}.disabled(store.speechSettings.busy)
                Button(nativeUI("录音时实时转写…", "Transcribe while recording…")){focusEditor();store.beginRealtimeSettings();showRealtimeSettings=store.realtimeSettingsDraft != nil}
            } label: {Image(systemName:"slider.horizontal.3").font(.system(size:13)).frame(width:28,height:28)}
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                .disabled(store.isActive || store.transcribingID != nil)
                .accessibilityLabel(nativeUI("转写设置", "Transcription settings"))
            NativeQuickRecordingControls(store: store, compact: compact)
        }.frame(minHeight: 38)
    }

    private var phaseLabel: String {
        switch store.phase {
        case .idle: return nativeUI("已停止", "Stopped")
        case .authorizing: return nativeUI("等待麦克风授权", "Awaiting microphone permission")
        case .recording: return nativeUI("正在本机录音", "Recording on this Mac")
        case .paused: return nativeUI("录音已暂停", "Recording paused")
        case .saving: return nativeUI("正在保存录音", "Saving recording")
        }
    }

    private var sidebar: some View {
        VStack(alignment:.leading,spacing:10) {
            HStack(spacing:7) {
                Image(systemName:"magnifyingglass").font(.system(size:11)).foregroundStyle(.secondary)
                TextField(nativeUI("搜索录音与文字", "Search recordings"),text:$query).textFieldStyle(.plain).font(.system(size:12))
                    .onTapGesture {focusEditor()}
                    .accessibilityLabel(nativeUI("搜索录音与转写文字", "Search recordings and transcript text"))
                if !query.isEmpty {Button{query=""}label:{Image(systemName:"xmark.circle.fill").foregroundStyle(.secondary)}.buttonStyle(.plain).accessibilityLabel(nativeUI("清除搜索", "Clear search"))}
            }.padding(.horizontal,10).frame(height:32).background(.primary.opacity(0.04),in:RoundedRectangle(cornerRadius:8))
            HStack(spacing:4) {
                filterButton(nativeUI("全部", "All"),deleted:false)
                filterButton(nativeUI("最近删除", "Deleted"),deleted:true)
                Spacer(minLength:0)
                Menu {
                    Button(nativeUI("全部分类", "All categories")){categoryFilter=nil}
                    Button(nativeUI("未分类", "Uncategorized")){categoryFilter=""}
                    ForEach(filterCategories,id:\.self){value in Button(value){categoryFilter=value}}
                }label:{Text(categoryFilter.map{$0.isEmpty ? nativeUI("未分类", "Uncategorized"):$0} ?? nativeUI("分类", "Category")).lineLimit(1).frame(maxWidth:84)}
                    .menuStyle(.borderlessButton).font(.system(size:11)).fixedSize(horizontal:false,vertical:true)
            }
            HStack(spacing:9) {
                if selecting {
                    Text(nativeUI("已选 \(multi.ids.count)", "\(multi.ids.count) selected")).monospacedDigit().foregroundStyle(.secondary)
                    Button(nativeUI("全选", "Select all")){multi.all(selectableIDs);if let first=selectableIDs.first{focusRow(first,selectionOnly:true)}}.disabled(selectableIDs.isEmpty)
                    Spacer(minLength:0)
                    if !showDeleted {
                        Button {focusEditor();store.beginCategory(ids:multi.ids);categorizing = store.categoryDraft != nil}label:{Image(systemName:"folder")}
                            .disabled(!store.canBatch(ids:multi.ids)).accessibilityLabel(nativeUI("修改所选录音分类", "Categorize selected recordings"))
                            .popover(isPresented:$categorizing){categoryEditor}
                    }
                    Button(action:requestBatch){Image(systemName:showDeleted ? "arrow.uturn.backward":"trash")}
                        .disabled(!store.canBatch(ids:multi.ids)).accessibilityLabel(showDeleted ? nativeUI("恢复所选录音", "Restore selected recordings"):nativeUI("删除所选录音", "Delete selected recordings"))
                    Button(nativeUI("完成", "Done")){selecting=false;multi.clear()}
                } else {
                    Text(nativeUI("\(filtered.count) 段录音", "\(filtered.count) recordings")).foregroundStyle(.tertiary)
                    Spacer(minLength:0)
                    if store.canUndoBatch {Button{_ = store.undoBatch()}label:{Image(systemName:"arrow.uturn.backward")}.help(nativeUI("撤销上次批处理", "Undo last batch"))}
                    Button(nativeUI("选择", "Select")){selecting=true;if let first=selectableIDs.first{focusRow(first,selectionOnly:true)}}.disabled(selectableIDs.isEmpty)
                }
            }.font(.system(size:11)).buttonStyle(.plain).frame(minHeight:22)
            if filtered.isEmpty {listEmptyState.frame(maxWidth:.infinity,maxHeight:.infinity)}
            else {
                ScrollViewReader {proxy in
                    ScrollView {
                        LazyVStack(spacing:4) {
                            ForEach(filtered){item in
                                NativeQuickRecordingRow(item:item,selected:selectedID==item.id,playing:store.playingID==item.id,recording:item.state=="recording" && store.isActive,checked:selecting ? multi.ids.contains(item.id):nil,focus:$focusedRow) {choose(item.id)}
                                    .id(item.id)
                            }
                        }.padding(.vertical,2)
                    }.scrollIndicators(.automatic)
                     .onChange(of:focusedRow){_,id in if let id {proxy.scrollTo(id,anchor:.center)}}
                     .onKeyPress(phases:[.down,.repeat]){press in handleKey(press)}
                }
            }
        }.padding(12).frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.topLeading).background(NativeQuickRecordingSurface())
    }
    private var categoryEditor:some View {
        VStack(alignment:.leading,spacing:12) {
            Text(nativeUI("录音分类", "Recording category")).font(.headline)
            TextField(nativeUI("分类名称，留空为未分类", "Category, or leave empty"),text:categoryDraft).textFieldStyle(.roundedBorder).onSubmit{applyCategory()}
            if !store.categories.isEmpty {
                Picker(nativeUI("已有分类", "Existing categories"),selection:categoryDraft){Text(nativeUI("未分类", "Uncategorized")).tag("");ForEach(store.categories,id:\.self){Text($0).tag($0)}}.pickerStyle(.menu)
            }
            if let error=store.error {Text(error).font(.system(size:11)).foregroundStyle(.orange).fixedSize(horizontal:false,vertical:true)}
            HStack{Spacer();Button(nativeUI("取消", "Cancel")){store.cancelCategory();categorizing=false};Button(nativeUI("保存", "Save")){applyCategory()}.keyboardShortcut(.defaultAction)}
        }.padding(16).frame(width:280)
    }
    private func applyCategory(){
        if store.commitCategory(){categorizing=false;multi.clear();selecting=false}
    }
    private func resumeMetadataEditor(){
        guard store.available else{return}
        if store.speechSettingsDraft != nil {return}
        if store.realtimeSettingsDraft != nil {showRealtimeSettings=true;return}
        if let draft=store.categoryDraft {
            showDeleted=false;categoryFilter=nil;query="";selecting=true;compactDetail=false
            multi.all(draft.targets.map(\.id));categorizing=true
        }
        if let draft=store.titleDraft {
            showDeleted=false;categoryFilter=nil;query="";selectedID=draft.id;compactDetail=true;store.resumeTitle()
        }
        if let draft=store.suggestionDraft {
            showDeleted=false;categoryFilter=nil;query="";selectedID=draft.id;compactDetail=true;store.resumeSuggestion()
        }
    }
    private func requestBatch(){
        guard let request=store.makeBatch(ids:multi.ids,action:showDeleted ? .restore:.trash) else{return}
        batchRequest=request;confirmingBatch=true
    }
    private func cancelRowFocus(){focusRequest+=1;focusedRow=nil}
    private func focusEditor(){cancelRowFocus();onFocus()}
    private func openSpeechSettings(){focusEditor();store.beginSpeechSettings()}
    private func focusRow(_ id:String,selectionOnly:Bool=false){
        // Activate the nonactivating host first. The selection toolbar/row
        // changes must mount before requesting its concrete Button responder.
        onFocus();focusRequest+=1;let request=focusRequest;focusedRow=nil
        DispatchQueue.main.async {
            guard mounted,request==focusRequest,store.available,canFocus(),
                  !selectionOnly || selecting,filtered.contains(where:{$0.id==id}) else{return}
            focusedRow=id
        }
    }
    private func choose(_ id:String){
        focusRow(id)
        let flags=NSEvent.modifierFlags
        if selecting || flags.contains(.command) || flags.contains(.shift) {
            guard selectableIDs.contains(id) else{return};selecting=true
            multi.select(id,order:selectableIDs,extending:flags.contains(.shift),toggling:!flags.contains(.shift))
        } else {selectedID=id;multi.anchor(id);compactDetail=true}
    }
    private func handleKey(_ press:KeyPress)->KeyPress.Result {
        guard let id=focusedRow else{return .ignored}
        if press.modifiers == .command,press.characters.lowercased()=="a" {selecting=true;multi.all(selectableIDs);return .handled}
        if press.modifiers == .command,press.characters.lowercased()=="z",store.canUndoBatch {_ = store.undoBatch();return .handled}
        guard press.modifiers.isEmpty || press.modifiers == .shift else{return .ignored}
        if press.key == .escape,selecting{selecting=false;multi.clear();return .handled}
        if press.modifiers.isEmpty,press.key == .delete || press.key == .deleteForward {if selecting && !multi.ids.isEmpty{requestBatch();return .handled};return .ignored}
        if press.modifiers.isEmpty,press.key == .space,selecting{multi.select(id,order:selectableIDs,toggling:true);return .handled}
        if press.modifiers.isEmpty,press.key == .return{selectedID=id;compactDetail=true;return .handled}
        if press.key == .upArrow || press.key == .downArrow {
            let order=filtered.map(\.id);guard let index=order.firstIndex(of:id) else{return .ignored}
            let next=order[max(0,min(order.count-1,index+(press.key == .upArrow ? -1:1)))]
            if press.modifiers == .shift {selecting=true;if multi.anchor==nil{multi.anchor(id)};multi.select(next,order:selectableIDs,extending:true)}
            focusedRow=next;if !selecting{selectedID=next};return .handled
        }
        return .ignored
    }

    private func filterButton(_ title: String, deleted: Bool) -> some View {
        Button { showDeleted = deleted;categoryFilter=nil; compactDetail = false;multi.clear();selecting=false } label: {
            Text(title).font(.system(size: 11, weight: showDeleted == deleted ? .medium : .regular))
                .foregroundStyle(showDeleted == deleted ? Color.primary : Color.secondary)
                .padding(.horizontal, 9).padding(.vertical, 5)
                .background(showDeleted == deleted ? Color.white.opacity(0.085) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
        }.buttonStyle(.plain).accessibilityAddTraits(showDeleted == deleted ? .isSelected : [])
    }

    private var listEmptyState: some View {
        VStack(spacing: 9) {
            Image(systemName: query.isEmpty && categoryFilter==nil ? (showDeleted ? "trash" : "waveform") : "magnifyingglass")
                .font(.system(size: 24, weight: .light)).foregroundStyle(.tertiary)
            Text(query.isEmpty && categoryFilter==nil ? (showDeleted ? nativeUI("没有已删除的录音", "No deleted recordings") : nativeUI("还没有录音", "No recordings yet")) : nativeUI("没有找到匹配的录音", "No matching recordings"))
                .font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary)
            if !query.isEmpty || categoryFilter != nil {
                Button(nativeUI("清除筛选", "Clear filters")){query="";categoryFilter=nil}.buttonStyle(.plain).font(.system(size:11))
            }
            if query.isEmpty, categoryFilter==nil, !showDeleted {
                Text(nativeUI("录音结束后会自动收纳于此", "Finished recordings appear here"))
                    .font(.system(size: 11)).foregroundStyle(.tertiary).multilineTextAlignment(.center)
            }
        }.padding(12)
    }

    @ViewBuilder private func detail(showBack: Bool) -> some View {
        if let item = selection {
            NativeQuickRecordingDetail(store:store,item:item,showBack:showBack,onBack:{compactDetail=false},onFocus:focusEditor,onSpeechSettings:openSpeechSettings)
                .id(item.id)
        } else {
            VStack(spacing: 14) {
                Image(systemName: showDeleted ? "trash" : "mic")
                    .font(.system(size: 32, weight: .light)).foregroundStyle(.secondary)
                    .frame(width: 70, height: 70)
                    .background(.white.opacity(0.035), in: Circle())
                    .overlay(Circle().strokeBorder(.white.opacity(0.065)))
                VStack(spacing: 7) {
                    Text(showDeleted ? nativeUI("已删除的录音可以恢复", "Deleted recordings can be restored") : (activeCount == 0 ? nativeUI("开始第一段录音", "Make your first recording") : nativeUI("选择一段录音", "Select a recording")))
                        .font(.system(size: 17, weight: .medium))
                    Text(showDeleted ? nativeUI("选中左侧记录，即可查看并恢复。", "Choose a recording to review and restore it.") : nativeUI("录下课堂与讨论，在这里回放、转写和补充笔记。", "Record a class or conversation, then replay, transcribe and add notes here."))
                        .font(.system(size: 12)).foregroundStyle(.secondary).multilineTextAlignment(.center).lineSpacing(3)
                        .frame(maxWidth: 310)
                }
                if !showDeleted, activeCount == 0 {
                    Button { Task { await store.start() } } label: { Label(nativeUI("开始录音", "Start recording"), systemImage: "record.circle") }
                        .buttonStyle(NativeQuickRecordingButtonStyle(prominent: true)).disabled(!store.available || !store.ready || store.isActive || store.transcribingID != nil)
                        .padding(.top, 2)
                }
            }.padding(24).frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(NativeQuickRecordingSurface())
        }
    }

    private func reconcileSelection() {
        if !filtered.contains(where: { $0.id == selectedID }) { selectedID = filtered.first?.id }
        if filtered.isEmpty { compactDetail = false }
    }
}

private struct NativeQuickRecordingRow: View {
    let item: NativeQuickRecordingItem
    let selected: Bool
    let playing: Bool
    let recording: Bool
    var checked:Bool? = nil
    var focus:FocusState<String?>.Binding
    let action: () -> Void
    @State private var hovering = false
    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    if let checked {Image(systemName:checked ? "checkmark.square.fill":"square").font(.system(size:13)).foregroundStyle(checked ? Color.accentColor:Color.secondary)}
                    if recording { Circle().fill(.red).frame(width: 5, height: 5) }
                    else if playing { Image(systemName: "speaker.wave.2.fill").font(.system(size: 10)).foregroundStyle(.secondary) }
                    Text(item.title).font(.system(size: 12, weight: .medium)).lineLimit(1)
                    Spacer(minLength: 0)
                }
                if !item.transcript.isEmpty {
                    Text(String(item.transcript.prefix(180)).replacingOccurrences(of: "\n", with: " ")).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                }
                HStack(spacing: 8) {
                    Text((item.category.map{$0 + " · "} ?? "") + item.createdAt.formatted(date:.abbreviated,time:.shortened)).lineLimit(1)
                    Spacer(minLength: 0)
                    Text(item.state == "interrupted" ? nativeUI("待核对", "Recovered") : NativeQuickRecordingLayout.clock(item.duration))
                        .monospacedDigit().lineLimit(1)
                }.font(.system(size: 10)).foregroundStyle(.tertiary)
            }.padding(.horizontal, 10).padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading).contentShape(RoundedRectangle(cornerRadius: 9))
                .background((selected ? Color.white.opacity(0.08) : (hovering ? Color.white.opacity(0.035) : Color.clear)), in: RoundedRectangle(cornerRadius: 9))
                .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(selected ? Color.white.opacity(0.09) : Color.clear))
        }.buttonStyle(.plain)
            .focusable(true,interactions:[.edit,.activate]).focused(focus,equals:item.id)
            .onHover { hovering = $0 }
            .accessibilityAddTraits(selected ? .isSelected : [])
            .help(item.title)
    }
}

private struct NativeQuickRecordingDetail: View {
    @ObservedObject var store: NativeQuickRecordingStore
    let item: NativeQuickRecordingItem
    let showBack: Bool
    let onBack: () -> Void
    var onFocus:()->Void = {}
    var onSpeechSettings:()->Void = {}
    @State private var renaming = false
    @State private var reviewingSuggestion = false
    @State private var transcriptExpanded = true
    @Environment(\.colorScheme) private var colorScheme
    private var titleDraft:Binding<String> {Binding(get:{store.titleDraft?.id==item.id ? store.titleDraft?.text ?? "":""},set:{store.editTitle($0)})}
    @State private var editorSession=UUID()
    @FocusState private var transcriptFocused:Bool
    private var current: NativeQuickRecordingItem { store.items.first { $0.id == item.id } ?? item }
    private var isLive: Bool { current.state == "recording" && store.isActive }
    private var deleted: Bool { current.deletedAt != nil }
    private var transcribing: Bool { store.transcribingID == item.id }
    private var displayedTranscript:String {store.transcriptText(id:item.id) ?? current.transcript}

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            if showBack {
                Button(action: onBack) { Label(nativeUI("所有录音", "All recordings"), systemImage: "chevron.left") }
                    .font(.system(size: 11)).buttonStyle(.plain).foregroundStyle(.secondary)
            }
            header
            audio
            if isLive,store.realtimeSettings.configuration.enabled {
                Text(store.realtimeStatusText).font(.system(size:11)).foregroundStyle(store.realtime.hasGap ? Color.orange:Color.secondary)
                    .lineLimit(2).fixedSize(horizontal:false,vertical:true)
            }
            if deleted {
                deletedContent
            } else {
                transcript
            }
        }.padding(18).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(NativeQuickRecordingSurface())
            .onAppear{renaming=store.titleDraft?.id==item.id;reviewingSuggestion=store.suggestionDraft?.id==item.id}
            .onChange(of:store.editorResumeID){_,_ in if store.titleDraft?.id==item.id{renaming=true};if store.suggestionDraft?.id==item.id{reviewingSuggestion=true}}
            .onChange(of:renaming){_,_ in updateEditor()}
            .onChange(of:transcriptFocused){_,focused in if focused{onFocus()};updateEditor()}
            .onDisappear{store.setEditor(editorSession,id:item.id,active:false);store.cancelSuggestion(id:item.id)}
            .sheet(isPresented:$reviewingSuggestion,onDismiss:{store.cancelSuggestion(id:item.id)}) {
                NativeQuickRecordingSuggestionView(store:store,id:item.id,onClose:{reviewingSuggestion=false})
                    .preferredColorScheme(colorScheme)
            }
            .onChange(of:store.available){_,value in if !value{reviewingSuggestion=false}}
    }
    private func updateEditor(){store.setEditor(editorSession,id:item.id,active:renaming || transcriptFocused)}

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                Text(current.title).font(.system(size: 17, weight: .semibold)).lineLimit(2).textSelection(.enabled)
                Text((current.category.map{$0 + " · "} ?? "") + current.createdAt.formatted(date: .long, time: .shortened))
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            if !deleted, !isLive {
                Menu {
                    Button(nativeUI("重命名", "Rename")) { onFocus();store.beginTitle(id:item.id); renaming = store.titleDraft?.id==item.id }.disabled(store.suggestionDraft?.id==item.id)
                    Button(nativeUI("在访达中显示", "Show in Finder")) { reveal() }
                    Divider()
                    Button(nativeUI("移到最近删除", "Move to Deleted")) { store.setDeleted(id: item.id, deleted: true) }
                } label: { Image(systemName: "ellipsis").font(.system(size: 15)).frame(width: 26, height: 26) }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                    .accessibilityLabel(nativeUI("录音操作", "Recording actions"))
                    .popover(isPresented: $renaming) {
                        VStack(alignment: .leading, spacing: 12) {
                            Text(nativeUI("录音名称", "Recording title")).font(.headline)
                            TextField(nativeUI("名称", "Title"), text: titleDraft).textFieldStyle(.roundedBorder).onSubmit { saveTitle() }
                            HStack { Spacer(); Button(nativeUI("取消", "Cancel")) { store.cancelTitle();renaming = false }; Button(nativeUI("保存", "Save")) { saveTitle() }.keyboardShortcut(.defaultAction).disabled(titleDraft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
                        }.padding(16).frame(width: 300)
                    }
            }
        }
    }

    @ViewBuilder private var audio: some View {
        if !isLive {
            NativeQuickRecordingPlaybackControls(store: store, playback: store.playback, item: current, enabled: !store.isActive && !deleted)
        } else {
        HStack(spacing: 12) {
                Circle().fill(store.phase == .recording ? Color.red : Color.secondary).frame(width: 8, height: 8).frame(width: 30)
                VStack(alignment: .leading, spacing: 6) {
                    Text(store.phase == .paused ? nativeUI("录音已暂停", "Recording paused") : nativeUI("正在本机录音", "Recording on this Mac")).font(.system(size: 12, weight: .medium))
                    NativeQuickRecordingLevel(level: store.phase == .recording ? store.level : 0).frame(height: 3)
                }
            Spacer(minLength: 0)
            Text(NativeQuickRecordingLayout.clock(isLive ? store.elapsed : current.duration))
                .font(.system(size: 12, design: .monospaced)).monospacedDigit().foregroundStyle(.secondary)
        }.padding(.horizontal, 12).padding(.vertical, 10)
            .background(.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
        }
    }

    private var deletedContent: some View {
        VStack(spacing: 10) {
            Image(systemName: "arrow.uturn.backward").font(.system(size: 24, weight: .light)).foregroundStyle(.secondary)
            Text(nativeUI("音频与文字仍保留在本机", "Audio and text are still on this Mac")).font(.system(size: 13, weight: .medium))
            Button(nativeUI("恢复这段录音", "Restore recording")) { store.setDeleted(id: item.id, deleted: false) }
                .buttonStyle(NativeQuickRecordingButtonStyle(prominent: true))
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var transcript: some View {
        VStack(alignment: .leading, spacing: 9) {
            ViewThatFits(in: .horizontal) {
                HStack { transcriptHeading; Spacer(minLength: 12); transcriptActions }
                VStack(alignment: .leading, spacing: 8) { transcriptHeading; transcriptActions }
            }
            if !isLive || transcriptExpanded {
            ZStack(alignment: .topLeading) {
                if displayedTranscript.isEmpty {
                    Text(isLive ? (store.realtimeSettings.configuration.enabled ? nativeUI("开始说话，识别文字会显示在这里。", "Start speaking to see your transcript here.") : nativeUI("结束录音后，可以在这里转写和补充笔记。", "Transcribe and add notes here when recording finishes.")) : (transcribing ? (store.isCloudTranscribing ? nativeUI("正在上传并云端转写，可随时取消…", "Uploading and transcribing; you can cancel…") : nativeUI("正在本机识别这段音频…", "Recognizing this recording on your Mac…")) : nativeUI("可使用本机转写，或直接补充这段录音的重点。", "Transcribe locally, or write down the key points from this recording.")))
                        .font(.system(size: 12)).foregroundStyle(.tertiary).padding(.horizontal, 13).padding(.vertical, 12).allowsHitTesting(false)
                }
                TextEditor(text: Binding(get: { displayedTranscript }, set: { store.saveTranscript(id: item.id, text: $0) }))
                    .focused($transcriptFocused)
                    .font(.system(size: 13)).lineSpacing(5).scrollContentBackground(.hidden)
                    .padding(8).disabled(transcribing || isLive || store.suggestionDraft?.id==item.id)
                    .accessibilityLabel(nativeUI("转写文字与录音笔记", "Transcript and recording notes"))
            }.frame(minHeight: 70, maxHeight: .infinity)
                .background(.white.opacity(0.025), in: RoundedRectangle(cornerRadius: 9))
                .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(.white.opacity(0.055)))
            }
            HStack(spacing: 6) {
                if store.transcriptDrafts[item.id] != nil {
                    Text(nativeUI("文字尚未保存，输入已保留", "Text is not saved; input is retained")).font(.system(size:10)).foregroundStyle(.orange)
                    Button(nativeUI("重试保存", "Retry save")){store.retryTranscript(id:item.id)}.buttonStyle(.plain).font(.system(size:10))
                } else {
                Image(systemName: "lock").font(.system(size: 9))
                Text(current.transcriptionState == "partial" ? nativeUI("实时文字可能不完整，可重新转写。", "Live text may be incomplete; you can transcribe again.") : (current.transcriptionState == "realtime" || (isLive && store.realtimeSettings.configuration.enabled) ? nativeUI("百炼识别 · 音频与文字保存在本机", "Model Studio transcription · Audio and text saved locally") : (current.transcriptionState == "cloud" ? nativeUI("云端转写 · 在本机保存", "Cloud transcript · Saved on this Mac") : nativeUI("在本机保存", "Saved on this Mac")))).font(.system(size: 10))
                }
            }.foregroundStyle(.tertiary)
        }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var transcriptHeading: some View {
        HStack(spacing: 7) {
            if isLive {
                Button {transcriptExpanded.toggle()} label: {Image(systemName:transcriptExpanded ? "chevron.down":"chevron.right").font(.system(size:10))}
                    .buttonStyle(.plain).accessibilityLabel(transcriptExpanded ? nativeUI("折叠实时文字", "Collapse live text"):nativeUI("展开实时文字", "Expand live text"))
            }
            Text(nativeUI("转写与笔记", "Transcript & notes")).font(.system(size: 12, weight: .medium))
            if transcribing { ProgressView().controlSize(.mini) }
        }.fixedSize()
    }

    private var transcriptActions: some View {
        ViewThatFits(in:.horizontal) {
            HStack(spacing:8){transcriptionButtons;textButtons}
            VStack(alignment:.leading,spacing:8) {
                HStack(spacing:8){transcriptionButtons}
                HStack(spacing:8){textButtons}
            }
        }
    }
    @ViewBuilder private var transcriptionButtons: some View {
            if transcribing {
                Button(nativeUI("取消转写", "Cancel")) { store.cancelTranscription() }
                    .buttonStyle(NativeQuickRecordingButtonStyle())
            } else if displayedTranscript.isEmpty || current.transcriptionState == "partial", !isLive {
                Picker(nativeUI("转写语言", "Transcription language"), selection: $store.transcriptionLanguage) {
                    Text("中文").tag("zh-CN"); Text("English").tag("en-US")
                }.labelsHidden().pickerStyle(.menu).controlSize(.small).fixedSize()
                Button(current.transcriptionState == "partial" ? nativeUI("重新本机转写", "Transcribe again") : nativeUI("本机转写", "On-device")) { Task { await store.transcribe(id: item.id) } }
                    .buttonStyle(NativeQuickRecordingButtonStyle()).disabled(store.transcribingID != nil || store.isActive)
                if current.transcriptionState != "edited" {
                    Button(nativeUI("云端转写", "Cloud")) {
                        if store.speechSettings.configured {Task{await store.transcribeCloud(id:item.id)}} else {onSpeechSettings()}
                    }.buttonStyle(NativeQuickRecordingButtonStyle())
                        .disabled(store.transcribingID != nil || store.isActive || store.speechSettings.busy)
                        .help(nativeUI("将这段录音发送到独立配置的语音服务。", "Send this recording to your separately configured speech service."))
                }
            }
    }
    @ViewBuilder private var textButtons: some View {
            if !displayedTranscript.isEmpty {
                Button(nativeUI("智能整理", "Suggest title")) {onFocus();transcriptFocused=false;reviewingSuggestion=true}
                    .buttonStyle(NativeQuickRecordingButtonStyle())
                    .disabled(!store.canSuggest(id:item.id) && store.suggestionDraft?.id != item.id)
                    .help(displayedTranscript.utf16.count>200000 ? nativeUI("转写超过 200,000 字符，未截取或发送。请先整理为较短的录音笔记。", "The transcript exceeds 200,000 characters. Nothing is truncated or sent; shorten the recording notes first."):nativeUI("根据完整转写生成名称和分类，预览后自行采纳。", "Suggest a title and category from the complete transcript, then review before adopting."))
                Button { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(displayedTranscript, forType: .string) } label: { Image(systemName: "doc.on.doc").frame(width: 25, height: 25) }
                    .buttonStyle(.plain).help(nativeUI("复制文字", "Copy text"))
            }
    }

    private func saveTitle() {
        if store.commitTitle(){renaming=false}
    }
    private func reveal() { if let url = store.fileURL(id: item.id) { NSWorkspace.shared.activateFileViewerSelecting([url]) } }
}

private struct NativeQuickRecordingSuggestionView:View {
    @ObservedObject var store:NativeQuickRecordingStore
    let id:String
    let onClose:()->Void
    @State private var useTitle=false
    @State private var useCategory=false
    private var current:NativeQuickRecordingItem? {store.items.first{$0.id==id}}
    private var proposal:NativeQuickRecordingSuggestion? {store.suggestion?.id==id ? store.suggestion:nil}
    private var draft:NativeQuickRecordingSuggestionDraft? {store.suggestionDraft?.id==id ? store.suggestionDraft:nil}
    var body:some View {
        VStack(alignment:.leading,spacing:16) {
            HStack {
                Text(nativeUI("名称与分类建议", "Title & category suggestions")).font(.headline)
                Spacer()
                Button(action:onClose){Image(systemName:"xmark").frame(width:22,height:22)}.buttonStyle(.plain).accessibilityLabel(nativeUI("关闭建议", "Close suggestions"))
            }
            if let current {
                if let draft {
                    Text(nativeUI("已采纳为草稿，录音名称尚未改变。", "Adopted as a draft. The recording has not changed yet.")).font(.system(size:12)).foregroundStyle(.secondary)
                    if let title=draft.title {comparison(nativeUI("名称", "Title"),before:current.title,after:title)}
                    if let category=draft.category {comparison(nativeUI("分类", "Category"),before:current.category ?? nativeUI("未分类", "Uncategorized"),after:category)}
                } else if let proposal {
                    Text(nativeUI("选择要替换的字段。未勾选的名称或分类保持不变。", "Choose which fields to replace. Unchecked fields stay unchanged.")).font(.system(size:12)).foregroundStyle(.secondary)
                    Toggle(isOn:$useTitle){comparison(nativeUI("替换名称", "Replace title"),before:current.title,after:proposal.title)}.toggleStyle(.checkbox)
                    Toggle(isOn:$useCategory){comparison(nativeUI("替换分类", "Replace category"),before:current.category ?? nativeUI("未分类", "Uncategorized"),after:proposal.category)}.toggleStyle(.checkbox)
                    Text(proposal.model).font(.system(size:10)).foregroundStyle(.tertiary).lineLimit(1)
                } else {
                    Text(nativeUI("将完整转写交给已配置的默认模型，只生成建议。音频留在本机，原名称和分类由你决定是否更改。", "Send the complete transcript to your configured default model for suggestions. Audio stays on this Mac; you choose whether to change existing metadata.")).font(.system(size:12)).foregroundStyle(.secondary).fixedSize(horizontal:false,vertical:true)
                    if store.suggestingID==id {HStack(spacing:8){ProgressView().controlSize(.small);Text(nativeUI("正在生成建议…", "Generating suggestions…")).font(.system(size:12))}}
                }
            }
            if let issue=store.suggestionError {Text(issue).font(.system(size:11)).foregroundStyle(.orange).fixedSize(horizontal:false,vertical:true)}
            HStack(spacing:10) {
                if draft != nil {
                    Button(nativeUI("丢弃草稿", "Discard draft")){if store.discardSuggestion(){onClose()}}
                    Spacer()
                    Button(nativeUI("保存修改", "Save changes")){if store.saveSuggestion(){onClose()}}.keyboardShortcut(.defaultAction)
                } else if store.suggestingID==id {
                    Spacer();Button(nativeUI("停止生成", "Stop")){store.cancelSuggestion(id:id)}
                } else if proposal != nil {
                    Button(nativeUI("重新生成", "Regenerate")){useTitle=false;useCategory=false;Task{await store.generateSuggestion(id:id)}}
                    Spacer()
                    Button(nativeUI("采纳为草稿", "Adopt as draft")){_ = store.adoptSuggestion(title:useTitle,category:useCategory)}.disabled(!useTitle && !useCategory)
                } else {
                    Spacer();Button(nativeUI("生成建议", "Generate suggestions")){Task{await store.generateSuggestion(id:id)}}.disabled(!store.canSuggest(id:id))
                }
            }.controlSize(.small)
        }.padding(20).frame(width:380).fixedSize(horizontal:false,vertical:true)
    }
    private func comparison(_ label:String,before:String,after:String)->some View {
        VStack(alignment:.leading,spacing:5) {
            Text(label).font(.system(size:11,weight:.medium)).foregroundStyle(.secondary)
            Text(before).font(.system(size:11)).foregroundStyle(.secondary).lineLimit(2)
            Text(after).font(.system(size:13,weight:.medium)).textSelection(.enabled).fixedSize(horizontal:false,vertical:true)
        }.frame(maxWidth:.infinity,alignment:.leading)
    }
}

private struct NativeQuickRecordingControls: View {
    @ObservedObject var store: NativeQuickRecordingStore
    var compact = false
    var body: some View {
        HStack(spacing: 7) {
            if store.phase == .recording || store.phase == .paused {
                Button { store.togglePause() } label: {
                    Label(store.phase == .paused ? nativeUI("继续", "Resume") : nativeUI("暂停", "Pause"), systemImage: store.phase == .paused ? "play.fill" : "pause.fill")
                }.buttonStyle(NativeQuickRecordingButtonStyle())
                Button { store.stop() } label: {
                    Label(compact ? nativeUI("保存", "Save") : nativeUI("结束并保存", "Finish & save"), systemImage: "stop.fill")
                }.buttonStyle(NativeQuickRecordingButtonStyle(prominent: true))
            } else {
                Button { Task { await store.start() } } label: {
                    Label(store.phase == .authorizing ? nativeUI("等待授权", "Awaiting access") : (compact ? nativeUI("录音", "Record") : nativeUI("开始录音", "Start recording")), systemImage: "record.circle")
                }.buttonStyle(NativeQuickRecordingButtonStyle(prominent: true))
                    .disabled(!store.available || !store.ready || store.phase != .idle || store.transcribingID != nil)
            }
        }.fixedSize(horizontal: true, vertical: false)
    }
}

private struct NativeQuickRecordingLevel: View {
    let level: Double
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        GeometryReader { proxy in
            Capsule().fill(.white.opacity(0.065)).overlay(alignment: .leading) {
                Capsule().fill(Color.red.opacity(0.85)).frame(width: proxy.size.width * min(1, max(0, level)))
            }
        }.accessibilityLabel(nativeUI("实际麦克风音量", "Measured microphone level"))
            .accessibilityValue("\(Int(min(1, max(0, level)) * 100))%")
            .animation(reduceMotion ? nil : .linear(duration: 0.1), value: level)
    }
}

private struct NativeQuickRecordingSurface: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 14)
            .fill(LinearGradient(colors: [Color.white.opacity(0.045), Color.white.opacity(0.022)], startPoint: .topLeading, endPoint: .bottomTrailing))
            .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(.white.opacity(0.065)))
    }
}

private struct NativeQuickRecordingButtonStyle: ButtonStyle {
    var prominent = false
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.system(size: 11, weight: .medium))
            .padding(.horizontal, 10).frame(height: 28)
            .foregroundStyle(enabled ? Color.primary : Color.secondary.opacity(0.65))
            .background(Color.white.opacity(enabled ? (configuration.isPressed ? 0.14 : (prominent ? 0.105 : 0.045)) : 0.025), in: RoundedRectangle(cornerRadius: 7))
            .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(.white.opacity(prominent && enabled ? 0.12 : 0.065)))
            .contentShape(RoundedRectangle(cornerRadius: 7))
    }
}

/// Only this small view observes the 4 Hz playhead. The recordings list and
/// transcript editor remain subscribed to the store's discrete mutations.
struct NativeQuickRecordingPlaybackControls: View {
    let store: NativeQuickRecordingStore
    @ObservedObject var playback: NativeQuickRecordingPlayback
    let item: NativeQuickRecordingItem
    let enabled: Bool
    @State private var scrubToken: UUID?
    @FocusState private var timelineFocused: Bool
    private var current: Bool { playback.state.id == item.id }
    private var playing: Bool { current && playback.state.isPlaying }
    private var position: TimeInterval { current ? playback.state.displayedPosition : 0 }
    private var duration: TimeInterval { current ? playback.state.duration : max(0, item.duration.isFinite ? item.duration : 0) }
    private var sliderValue: Binding<Double> {
        Binding(get: { min(duration, position) }, set: { value in
            if let token = scrubToken { playback.previewSeek(token, to: value) }
            else { store.seekPlayback(id: item.id, to: value) }
        })
    }
    var body: some View {
        HStack(spacing: 10) {
            control(playing ? "pause.fill" : "play.fill", label: playing ? nativeUI("暂停回放", "Pause playback") : nativeUI("回放录音", "Play recording")) { store.play(id: item.id) }
            VStack(spacing: 2) {
                Slider(value: sliderValue, in: 0...max(1, duration), onEditingChanged: { editing in
                    if editing { scrubToken = store.beginPlaybackSeek(id: item.id) }
                    else if let token = scrubToken { playback.endSeek(token, commit: true); scrubToken = nil }
                }).controlSize(.small).focused($timelineFocused)
                    .accessibilityLabel(nativeUI("录音进度", "Recording position"))
                    .accessibilityValue(NativeQuickRecordingLayout.clock(position) + " / " + NativeQuickRecordingLayout.clock(duration))
                    .disabled(!enabled || duration <= 0)
                    .onKeyPress(phases: .down) { press in
                        guard enabled, timelineFocused, press.modifiers.intersection([.command, .control, .option, .shift]).isEmpty else { return .ignored }
                        if press.key == .escape, let token = scrubToken { playback.endSeek(token, commit: false); scrubToken = nil; return .handled }
                        let target: TimeInterval
                        switch press.key {
                        case .leftArrow: target = position - 5
                        case .rightArrow: target = position + 5
                        case .home: target = 0
                        case .end: target = duration
                        default: return .ignored
                        }
                        store.seekPlayback(id: item.id, to: target); return .handled
                    }
                HStack(spacing: 4) {
                    Text(NativeQuickRecordingLayout.clock(position)).monospacedDigit()
                    Spacer(minLength: 4)
                    Text(item.state == "interrupted" ? nativeUI("恢复的录音", "Recovered audio") : nativeUI("本机音频", "Local audio")).lineLimit(1)
                    Spacer(minLength: 4)
                    Text(NativeQuickRecordingLayout.clock(duration)).monospacedDigit()
                }.font(.system(size: 10)).foregroundStyle(.secondary)
            }
            control("gobackward.10", label: nativeUI("后退10秒", "Back 10 seconds")) { store.seekPlayback(id: item.id, to: position - 10) }
            control("goforward.10", label: nativeUI("前进10秒", "Forward 10 seconds")) { store.seekPlayback(id: item.id, to: position + 10) }
        }.padding(.horizontal, 10).padding(.vertical, 9)
            .background(.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
            .transaction { $0.animation = nil } // A real playhead is not an animated estimate.
            .onChange(of: item.id) { _, _ in scrubToken = nil }
            .onDisappear { scrubToken = nil; store.stopPlayback() }
    }
    private func control(_ symbol: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: symbol).font(.system(size: 13)).frame(width: 26, height: 30) }
            .buttonStyle(.plain).focusable(true, interactions: [.edit, .activate])
            .accessibilityLabel(label).help(label).disabled(!enabled || scrubToken != nil)
            .onKeyPress(keys: [.space, .return], phases: .down) { press in
                guard enabled, scrubToken == nil, press.modifiers.intersection([.command, .control, .option, .shift]).isEmpty else { return .ignored }
                action(); return .handled
            }
    }
}
