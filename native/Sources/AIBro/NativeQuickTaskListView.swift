import SwiftUI
import AppKit

struct NativeQuickTaskListView: View {
    @ObservedObject var workbench: NativeQuickWorkbenchStore
    var onOpened: () -> Void = {}
    var onFocus: () -> Void = {}
    var onEmptyFocus: () -> Void = {}
    @FocusState private var focusedControl: NativeQuickTaskRowFocus?
    private var focusedTask: String? {
        get { focusedControl?.taskID }
        nonmutating set {
            focusedControl = newValue.map { NativeQuickTaskRowFocus(taskID: $0, control: focusedControl?.control ?? .selection) }
        }
    }
    @State private var discardWorkflowRename = false
    @FocusState private var workflowNameFocused: Bool
    @State private var requestedFocus: String?
    @State private var focusRequest = 0
    @State private var motion = NativeQuickTaskMotionState()
    @StateObject private var completionFocus = NativeQuickTaskCompletionFocus()
    private var selecting: Bool {
        get { workbench.selectingTasks }
        nonmutating set { workbench.selectingTasks = newValue }
    }
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let motionInput = NativeQuickTaskMotionInput(workbench: workbench)
        let change = motion.next(motionInput)
        let presentation = change.state
        let byID = Dictionary(workbench.visibleTasks.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let rows = presentation.order.compactMap { byID[$0] }
        VStack(alignment: .leading, spacing: 8) {
            if workbench.ready {
                workflowBar
                if workbench.workflowNameDraft != nil { workflowNameEditor }
            }
            lifecycleNotice
            if !workbench.visibleTasks.isEmpty { selectionToolbar.disabled(workbench.workflowNameDraft != nil) }
            // Keep one scroll/row identity tree across the empty → first-row
            // boundary. Initial load/filter changes are baselines, not arrivals.
            ZStack {
                TimelineView(.periodic(from: .now, by: 60)) { time in
                  NativeQuickFocusScroll(focus:workbench.recordFocus) {
                   ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(rows) { item in
                                VStack(spacing: 0) {
                                    row(item, now: time.date, completed: presentation.completed[item.id] ?? item.isCompleted,
                                        revision: presentation.checkRevision[item.id] ?? 0)
                                        .background(NativeQuickRecordFocusMarker(focus:workbench.recordFocus,id:item.id))
                                        .background(NativeQuickTaskCompletionMarker(focus: completionFocus, id: item.id) { target in
                                            focusedControl = target
                                        })
                                    Divider().opacity(0.32).padding(.leading, 39)
                                }.id(item.id)
                                    .modifier(NativeQuickTaskArrivalEffect(revision: presentation.arrivalRevision[item.id] ?? 0, pending: change.pendingArrivals.contains(item.id)))
                                    .transition(reduceMotion ? .identity : .asymmetric(
                                        insertion: .opacity.combined(with: .scale(scale: 0.98, anchor: .topLeading)),
                                        removal: .opacity))
                            }
                        }.animation(reduceMotion || !change.moves ? nil : .timingCurve(0.22, 1, 0.36, 1, duration: 0.36), value: presentation.order)
                            .transaction { transaction in
                                if change.moves, let lease = completionFocus.pendingToken,
                                   let layout = completionFocus.beginReorder(lease, order: presentation.order) {
                                    transaction.addAnimationCompletion(criteria: .removed) {
                                        completionFocus.endReorder(lease, layout: layout)
                                    }
                                }
                            }
                    }.scrollIndicators(.hidden)
                    .task(id: completionFocus.restoration.map { NativeQuickTaskCompletionFocus.Position(token: $0.token, order: presentation.order) }) {
                        guard let request = completionFocus.restoration else { return }
                        await Task.yield()
                        guard !Task.isCancelled, completionFocus.owns(request.token) else { return }
                        // The mounted marker, not this scroll request, restores
                        // focus. Lazy rows may not exist until this positioning.
                        proxy.scrollTo(request.target.taskID, anchor: .center)
                        await Task.yield()
                        guard !Task.isCancelled else { return }
                        completionFocus.didRequestPosition(request.token)
                    }
                    .onChange(of: workbench.workflowFilter) { _, _ in
                        // A new category starts at its first task, not at the
                        // previous category's bottom. Ordinary updates never
                        // scroll or focus a row, including completion reorders.
                        if let id = change.categoryAnchorID { proxy.scrollTo(id, anchor: .top) }
                    }
                   }
                  }
                }.opacity(rows.isEmpty ? 0 : 1).allowsHitTesting(!rows.isEmpty).accessibilityHidden(rows.isEmpty)
                if rows.isEmpty {
                    if workbench.loading {
                        ProgressView().controlSize(.small).frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else { emptyState }
                }
            }
        }.background(NativeQuickTaskCompletionWindow(focus: completionFocus).allowsHitTesting(false).accessibilityHidden(true))
        .onChange(of: workbench.visibleTasks) { _, tasks in
            if let id = requestedFocus, tasks.contains(where: { $0.id == id }) { focusedTask = id; requestedFocus = nil }
        }
        .onChange(of: motionInput, initial: true) { _, input in motion = motion.next(input).state }
        .onChange(of: workbench.workflowFilter) { _, _ in completionFocus.cancel(); focusRequest += 1; focusedControl = nil }
        .onChange(of: workbench.selectingTasks) { _, active in completionFocus.cancel(); if !active { focusRequest += 1 } }
        .onChange(of: workbench.ready) { _, ready in if !ready { completionFocus.cancel() } }
        .onChange(of: workbench.hasTaskEditor) { _, editing in if editing { completionFocus.cancel() } }
        .onChange(of: workbench.recordFocus.target?.token) { _, target in if target != nil { completionFocus.cancel() } }
        .onDisappear { completionFocus.attach(nil); focusRequest += 1; focusedControl = nil; motion = .init() }
        .onKeyPress(phases: [.down, .repeat]) { press in
            // Only events from a focused task row arrive here. Text-editor
            // shortcuts elsewhere in the panel keep their normal semantics.
            guard let focusedTask else { return .ignored }
            var modifiers: NativeQuickTaskKeyModifiers = []
            if press.modifiers.contains(.command) { modifiers.insert(.command) }
            if press.modifiers.contains(.shift) { modifiers.insert(.shift) }
            if press.modifiers.contains(.option) { modifiers.insert(.option) }
            if press.modifiers.contains(.control) { modifiers.insert(.control) }
            let command = NativeQuickTaskCommand.match(press.characters, modifiers: modifiers)
            if command == .selectAll {
                selecting = true; workbench.selectAllTasks(); return .handled
            }
            if command == .undo, let notice = workbench.taskDeletionNotice, Date() < notice.expiresAt {
                undo(notice); return .handled
            }
            guard modifiers.isEmpty || modifiers == .shift else { return .ignored }
            if modifiers.isEmpty, press.key == .escape, selecting { selecting = false; workbench.clearTaskSelection(); return .handled }
            if modifiers.isEmpty, selecting, press.key == .delete || press.key == .deleteForward { removeSelection(); return .handled }
            if selecting, press.key == .space { select(focusedTask, extending: modifiers == .shift, control: focusedControl?.control ?? .selection); return .handled }
            if modifiers.isEmpty, !selecting, press.key == .space || press.key == .return {
                // These explicitly focusable controls do not receive the
                // Button's default activation in a nonactivating panel.
                // Handle one key-down; holding the key must not toggle back.
                guard press.phase == .down,
                      let control = focusedControl?.control,
                      let item = workbench.visibleTasks.first(where: { $0.id == focusedTask }) else { return .handled }
                activate(item, control: control, preservingKeyboardFocus: true)
                return .handled
            }
            if press.key == .upArrow || press.key == .downArrow {
                let ids = workbench.visibleTasks.map(\.id)
                guard let index = ids.firstIndex(of: focusedTask) else { return .ignored }
                let next = max(0, min(ids.count - 1, index + (press.key == .upArrow ? -1 : 1)))
                if modifiers == .shift {
                    selecting = true
                    if workbench.taskSelection.anchor == nil { workbench.selectTask(id: focusedTask) }
                    workbench.selectTask(id: ids[next], extending: true)
                }
                self.focusedTask = ids[next]; return .handled
            }
            return .ignored
        }
    }
    private var emptyState: some View {
        VStack(spacing: 9) {
            Image(systemName: "checklist").font(.system(size: 25, weight: .light)).foregroundStyle(.tertiary)
            Text(workbench.workflowFilter == nil ? nativeUI("给接下来留个位置", "Make room for what is next") : nativeUI("这个分类还没有待办", "No tasks in this category")).font(.system(size: 14, weight: .medium))
            Text(nativeUI("添加待办时可以选择分类。", "Choose a category when adding a task.")).font(.system(size: 11)).foregroundStyle(.secondary)
            if workbench.workflowFilter != nil { Button(nativeUI("查看全部", "Show all")) { workbench.setWorkflowFilter(nil) }.buttonStyle(.plain).font(.system(size: 11)).foregroundStyle(.tint) }
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    private var workflowBar: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 14) {
                workflowFilterButton(nil, title: nativeUI("全部", "All"))
                workflowFilterButton("", title: nativeUI("未分类", "Uncategorized"))
                Spacer(minLength: 0)
                Menu {
                    ForEach(NativeQuickTaskWorkflow.keys, id: \.self) { key in
                        Button(nativeUI("重命名", "Rename") + " · " + (workbench.workflowNames[key] ?? key)) {
                            if workbench.beginWorkflowRename(key) { focusRequest += 1; focusedControl = nil; onFocus(); workflowNameFocused = true }
                        }
                    }
                } label: { Image(systemName: "ellipsis").font(.system(size: 12)) }
                .menuStyle(.borderlessButton).frame(width: 20).disabled(workbench.hasTaskEditor || workbench.savingWorkflowName || workbench.workflowVersion == nil)
                .accessibilityLabel(nativeUI("重命名待办分类", "Rename task categories"))
            }.font(.system(size: 11)).padding(.horizontal, 6)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 110), spacing: 6)], spacing: 6) {
                ForEach(NativeQuickTaskWorkflow.keys, id: \.self) { key in
                    workflowFilterButton(key, title: workbench.workflowNames[key] ?? key, tile: true)
                }
            }
        }.disabled(workbench.lifecycleBusy)
    }
    private func workflowFilterButton(_ key: String?, title: String, tile: Bool = false) -> some View {
        let selected = workbench.workflowFilter == key
        return Button { workbench.setWorkflowFilter(key) } label: {
            HStack(spacing: 7) {
                Text(title).lineLimit(1)
                if tile { Spacer(minLength: 0) }
                Text(String(workbench.workflowCount(key))).monospacedDigit().foregroundStyle(.secondary)
            }.font(.system(size: 11, weight: selected ? .semibold : .regular))
                .foregroundStyle(selected ? Color.primary : Color.secondary)
                .padding(.horizontal, tile ? 10 : 0).padding(.vertical, tile ? 8 : 3)
                .frame(maxWidth: tile ? .infinity : nil)
                .background(RoundedRectangle(cornerRadius: 7).fill(tile ? Color.primary.opacity(selected ? 0.11 : 0.04) : Color.clear))
                .contentShape(Rectangle())
        }.buttonStyle(.plain).help(title)
            .accessibilityLabel(title).accessibilityValue(nativeUI("\(workbench.workflowCount(key)) 项未完成", "\(workbench.workflowCount(key)) incomplete"))
            .accessibilityAddTraits(selected ? .isSelected : [])
    }
    private var workflowNameEditor: some View {
        HStack(spacing: 10) {
            TextField(nativeUI("分类名称", "Category name"), text: Binding(get: { workbench.workflowNameDraft?.name ?? "" }, set: { workbench.workflowNameDraft?.name = $0 }))
                .textFieldStyle(.plain).focused($workflowNameFocused)
                .onSubmit { saveWorkflowName() }.onChange(of: workflowNameFocused) { _, value in if value { onFocus() } }
            if workbench.savingWorkflowName { ProgressView().controlSize(.mini) }
            Button(nativeUI("取消", "Cancel")) {
                if workbench.workflowNameDraft?.dirty == true { discardWorkflowRename = true }
                else { workbench.workflowNameDraft = nil }
            }
            Button(nativeUI("保存", "Save")) { saveWorkflowName() }
                .disabled(!NativeQuickTaskWorkflow.validName(workbench.workflowNameDraft?.name ?? ""))
        }.font(.system(size: 12)).buttonStyle(.plain).padding(10)
            .background(Color.primary.opacity(0.055), in: RoundedRectangle(cornerRadius: 8))
            .disabled(workbench.savingWorkflowName)
            .confirmationDialog(nativeUI("放弃分类名称更改？", "Discard category name changes?"), isPresented: $discardWorkflowRename) {
                Button(nativeUI("放弃更改", "Discard changes"), role: .destructive) { workbench.workflowNameDraft = nil }
                Button(nativeUI("继续编辑", "Keep editing"), role: .cancel) {}
            }
    }
    private func saveWorkflowName() {
        guard !workbench.savingWorkflowName else { return }
        Task { _ = await workbench.saveWorkflowRename() }
    }
    private var selectionToolbar: some View {
        HStack(spacing: 10) {
            if selecting {
                Text(nativeUI("已选 \(workbench.taskSelection.ids.count) 项", "\(workbench.taskSelection.ids.count) selected")).monospacedDigit().foregroundStyle(.secondary)
                Button(nativeUI("全选", "Select all")) { workbench.selectAllTasks() }.disabled(workbench.lifecycleBusy)
                Spacer(minLength: 0)
                Button { removeSelection() } label: { Image(systemName: "trash").font(.system(size: 12)) }
                    .disabled(!workbench.canDeleteSelectedTasks).accessibilityLabel(nativeUI("将所选待办移入回收站", "Move selected tasks to Trash"))
                Button(nativeUI("完成", "Done")) { selecting = false; workbench.clearTaskSelection() }
            } else {
                Spacer(minLength: 0)
                Button(nativeUI("选择", "Select")) {
                    selecting = true
                    if let id = workbench.visibleTasks.first?.id { focusRow(id, control: .selection) }
                }
                    .help(nativeUI("Shift 点击选择区间，⌘A 全选", "Shift-click selects a range; ⌘A selects all"))
            }
        }.font(.system(size: 11)).buttonStyle(.plain).padding(.horizontal, 6).frame(minHeight: 24)
    }
    private func select(_ id: String, extending: Bool, control: NativeQuickTaskRowFocus.Control) {
        selecting = true; workbench.selectTask(id: id, extending: extending, toggling: !extending)
        focusRow(id, control: control)
    }
    private func focusRow(_ id: String, control: NativeQuickTaskRowFocus.Control) {
        // The panel activates first. Its old field editor must not win over a
        // focus request made before the new selectable controls are installed.
        onFocus(); focusRequest += 1
        let request = focusRequest
        DispatchQueue.main.async {
            guard request == focusRequest, selecting, workbench.ready,
                  !workbench.busyTaskIDs.contains(id), workbench.visibleTasks.contains(where: { $0.id == id && $0.isSaving != true }) else { return }
            focusedControl = NativeQuickTaskRowFocus(taskID: id, control: control)
        }
    }
    private func activate(_ item: NativeQuickTaskItem, control: NativeQuickTaskRowFocus.Control, preservingKeyboardFocus: Bool = false) {
        if !preservingKeyboardFocus { completionFocus.cancel() }
        guard workbench.ready, workbench.workflowNameDraft == nil,
              !workbench.busyTaskIDs.contains(item.id), item.isSaving != true else { return }
        switch control {
        case .selection:
            let target = NativeQuickTaskRowFocus(taskID: item.id, control: control)
            let filter = workbench.workflowFilter, expectedCompletion = !item.isCompleted
            let token = preservingKeyboardFocus && focusedControl == target
                ? completionFocus.begin(target: target, canRestore: {
                    workbench.ready && workbench.workflowFilter == filter && !workbench.selectingTasks &&
                    !workbench.hasTaskEditor && workbench.recordFocus.target == nil &&
                    workbench.visibleTasks.contains { $0.id == item.id && $0.workspace == item.workspace && $0.projectId == item.projectId }
                }, isSettled: {
                    !workbench.busyTaskIDs.contains(item.id) && workbench.visibleTasks.contains {
                        $0.id == item.id && $0.isCompleted == expectedCompletion && $0.isSaving != true
                    }
                }) : nil
            Task {
                let saved = await workbench.setTaskCompleted(id: item.id, completed: expectedCompletion)
                if let token { completionFocus.acknowledge(token, saved: saved) }
            }
        case .title:
            Task { if await workbench.openTask(id: item.id) { onOpened() } }
        }
    }

    private func row(_ item: NativeQuickTaskItem, now: Date, completed: Bool, revision: Int) -> some View {
        let saving = workbench.busyTaskIDs.contains(item.id) || item.isSaving == true
        let unavailable = !workbench.ready || workbench.workflowNameDraft != nil
        let busy = saving || unavailable
        return HStack(alignment: .top, spacing: 11) {
            Button {
                guard !busy else { return }
                if selecting || NSEvent.modifierFlags.contains(.shift) { select(item.id, extending: NSEvent.modifierFlags.contains(.shift), control: .selection) }
                else { activate(item, control: .selection) }
            } label: {
                NativeQuickTaskCompletionGlyph(completed: completed, selecting: selecting,
                    selected: workbench.taskSelection.ids.contains(item.id),
                    busy: saving, revision: revision)
            // Saving must not revoke this button's keyboard-focus identity.
            // Its spinner and AX state remain explicit; the busy guard rejects
            // duplicate activation without a late focus-restoration callback.
            }.buttonStyle(.plain).disabled(unavailable)
                .focusable(!unavailable, interactions: [.edit, .activate])
                .focused($focusedControl, equals: NativeQuickTaskRowFocus(taskID: item.id, control: .selection))
                .accessibilityLabel(selecting ? nativeUI("选择待办", "Select task") : completed ? nativeUI("重新打开待办", "Reopen task") : nativeUI("完成待办", "Complete task"))
                .accessibilityValue(saving ? item.title + nativeUI("，正在保存", ", saving") : selecting ? item.title + (workbench.taskSelection.ids.contains(item.id) ? nativeUI("，已选择", ", selected") : nativeUI("，未选择", ", not selected")) : item.title)
            Button {
                if selecting || NSEvent.modifierFlags.contains(.shift) { select(item.id, extending: NSEvent.modifierFlags.contains(.shift), control: .title) }
                else { activate(item, control: .title) }
            } label: {
                VStack(alignment: .leading, spacing: 5) {
                    Text(item.title).font(.system(size: 13)).strikethrough(completed).foregroundStyle(completed ? Color.secondary : Color.primary).multilineTextAlignment(.leading).lineLimit(3)
                    HStack(spacing: 7) {
                        if !item.projectTitle.isEmpty { Text(item.projectTitle).lineLimit(1).foregroundStyle(.tertiary) }
                        NativeQuickTaskDeadlineView(item: item, now: now)
                    }.font(.system(size: 10))
                }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }.buttonStyle(.plain).disabled(busy)
                .focusable(!busy, interactions: [.edit, .activate])
                .focused($focusedControl, equals: NativeQuickTaskRowFocus(taskID: item.id, control: .title))
            if !selecting {
            Button { _ = workbench.beginEditingTask(id: item.id); onFocus() } label: {
                Image(systemName: "pencil").font(.system(size: 11)).foregroundStyle(.secondary)
            }.buttonStyle(.plain).disabled(busy || (workbench.editingTask != nil && workbench.editingTask?.original.id != item.id))
                .accessibilityLabel(nativeUI("编辑待办", "Edit task")).accessibilityValue(item.title)
            Button { remove(item) } label: {
                Image(systemName: "trash").font(.system(size: 11)).foregroundStyle(.secondary)
            }.buttonStyle(.plain).disabled(busy || workbench.lifecycleBusy || workbench.canRecoverTaskLifecycle || workbench.editingTask?.original.id == item.id)
                .accessibilityLabel(nativeUI("移入回收站", "Move task to Trash")).accessibilityValue(item.title)
            }
        }.padding(.vertical, 12).padding(.horizontal, 6)
            .background(RoundedRectangle(cornerRadius: 7).fill(workbench.taskSelection.ids.contains(item.id) ? Color.accentColor.opacity(0.11) : Color.clear))
            .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: workbench.taskSelection.ids.contains(item.id))
    }
    private func removeSelection() {
        guard workbench.canDeleteSelectedTasks else { return }
        let selected = workbench.taskSelection.ids, ids = workbench.visibleTasks.map(\.id)
        let first = ids.firstIndex(where: { selected.contains($0) }) ?? 0
        let neighbor = ids.dropFirst(first).first { !selected.contains($0) } ?? ids.prefix(first).last { !selected.contains($0) }
        Task {
            if await workbench.deleteSelectedTasks() {
                if let neighbor { focusedTask = neighbor } else { onEmptyFocus() }
            }
        }
    }
    private func undo(_ notice: NativeQuickTaskDeletionNotice) {
        Task { if await workbench.undoTaskDeletion() { requestedFocus = notice.id; if workbench.visibleTasks.contains(where: { $0.id == notice.id }) { focusedTask = notice.id; requestedFocus = nil } } }
    }
    private func remove(_ item: NativeQuickTaskItem) {
        let ids = workbench.visibleTasks.map(\.id), index = ids.firstIndex(of: item.id) ?? 0
        let neighbor = index + 1 < ids.count ? ids[index + 1] : index > 0 ? ids[index - 1] : nil
        Task {
            if await workbench.deleteTask(id: item.id) {
                if let neighbor { focusedTask = neighbor } else { onEmptyFocus() }
            }
        }
    }
    @ViewBuilder private var lifecycleNotice: some View {
        if workbench.ready && workbench.canRecoverTaskLifecycle {
            HStack(spacing: 10) {
                Text(workbench.pendingTaskLifecycle?.isDeletion == false ? nativeUI("恢复尚未确认", "Restore is unconfirmed") : nativeUI("删除尚未确认", "Delete is unconfirmed"))
                Spacer(minLength: 0)
                if workbench.pendingTaskLifecycle != nil {
                    Button(nativeUI("重试", "Retry")) { Task { _ = await workbench.retryTaskLifecycle() } }.disabled(workbench.lifecycleBusy)
                }
                Menu {
                    Button(nativeUI("保留恢复记录并继续", "Keep recovery record and continue")) { _ = workbench.preserveTaskLifecycleRecovery() }
                } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).frame(width: 18)
                    .help(nativeUI("已移入回收站的任务仍可在那里恢复", "Tasks moved to Trash remain recoverable there"))
            }.font(.system(size: 11)).buttonStyle(.plain).foregroundStyle(.secondary)
        } else if workbench.ready && workbench.lifecycleBusy {
            HStack(spacing: 7) { ProgressView().controlSize(.mini); Text(nativeUI("正在保存任务操作…", "Saving task operation…")) }.font(.system(size: 11)).foregroundStyle(.secondary)
        } else if workbench.ready, let notice = workbench.taskDeletionNotice {
            TimelineView(.periodic(from: .now, by: 0.25)) { time in
                if time.date < notice.expiresAt {
                    HStack(spacing: 10) {
                        Text(nativeUI("已移入回收站", "Moved to Trash"))
                        Text(notice.title).lineLimit(1).foregroundStyle(.secondary)
                        Spacer(minLength: 0)
                        Button(nativeUI("撤销", "Undo")) { undo(notice) }.buttonStyle(.plain).foregroundStyle(.tint)
                    }.font(.system(size: 11)).padding(.vertical, 5)
                }
            }
        }
    }
}

/// One keyboard operation owns a restore only until the next actual user
/// input. SwiftUI's automatic focus fallback during a LazyVStack reorder is
/// deliberately not an intent event. No task data or permanent order lives here.
@MainActor final class NativeQuickTaskCompletionFocus: ObservableObject {
    struct Request: Equatable {
        let token: UUID
        let target: NativeQuickTaskRowFocus
    }
    struct Position: Equatable {
        let token: UUID
        let order: [String]
    }
    @Published private(set) var restoration: Request?
    private var pending: Request?
    private var canRestore: (() -> Bool)?
    private var isSettled: (() -> Bool)?
    private var positioned: UUID?
    private var reorder: (order: [String], token: UUID)?
    private var lastReorder: [String]?
    var pendingToken: UUID? { pending?.token }
    private weak var window: NSWindow?
    private var monitor: Any?
    private var resignObserver: NSObjectProtocol?
    private var timeout: Task<Void, Never>?
    // Synthetic tests replace ownership only; production always checks the
    // actual originating window without activating it or using global monitors.
    private let keyboardOwned: (() -> Bool)?
    init(keyboardOwned: (() -> Bool)? = nil) { self.keyboardOwned = keyboardOwned }

    func attach(_ window: NSWindow?) {
        guard self.window !== window else { return }
        cancel(); self.window = window
    }
    func begin(target: NativeQuickTaskRowFocus, canRestore: @escaping () -> Bool, isSettled: @escaping () -> Bool = { true }) -> UUID? {
        cancel()
        guard hasKeyboardOwnership else { return nil }
        let request = Request(token: UUID(), target: target)
        pending = request; self.canRestore = canRestore; self.isSettled = isSettled
        if let window {
            monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel]) { [weak self, weak window] event in
                MainActor.assumeIsolated {
                    if event.window === window || (event.window == nil && NSApp.keyWindow === window) {
                        self?.receiveUserEvent(event)
                    }
                }
                return event // Observe intent; never consume normal interaction.
            }
            resignObserver = NotificationCenter.default.addObserver(forName: NSWindow.didResignKeyNotification, object: window, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.cancel() }
            }
        }
        return request.token
    }
    func receiveUserEvent(_ event: NSEvent) {
        // A held activation key is already rejected by the view's .down guard.
        // Every fresh key, including Tab/arrow/Escape, ends this old operation.
        if event.type == .keyDown && event.isARepeat { return }
        cancel()
    }
    func owns(_ token: UUID) -> Bool { pending?.token == token && hasKeyboardOwnership }
    func acknowledge(_ token: UUID, saved: Bool) {
        guard pending?.token == token else { return }
        guard saved, owns(token), canRestore?() == true else { cancel(); return }
        restoration = pending
        timeout = Task { @MainActor [weak self] in
            do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { return }
            guard self?.pending?.token == token else { return }; self?.cancel()
        }
    }
    func didRequestPosition(_ token: UUID) { if owns(token) { positioned = token } }
    func beginReorder(_ token: UUID, order: [String]) -> UUID? {
        guard owns(token), lastReorder != order else { return nil }
        let layout = UUID(); lastReorder = order; reorder = (order, layout); return layout
    }
    func endReorder(_ token: UUID, layout: UUID) {
        guard owns(token), reorder?.token == layout else { return }; reorder = nil
    }
    /// Called only by the matching row's live native geometry probe.
    @discardableResult func restore(_ request: Request, isVisible: Bool, apply: (NativeQuickTaskRowFocus) -> Void) -> Bool {
        guard restoration == request, owns(request.token), canRestore?() == true else {
            if pending?.token == request.token { cancel() }; return true
        }
        guard positioned == request.token, reorder == nil, isSettled?() == true, isVisible else { return false }
        apply(request.target); cancel(); return true
    }
    func cancel() {
        timeout?.cancel(); timeout = nil
        if let monitor { NSEvent.removeMonitor(monitor) }; monitor = nil
        if let resignObserver { NotificationCenter.default.removeObserver(resignObserver) }; resignObserver = nil
        pending = nil; canRestore = nil; isSettled = nil; positioned = nil; reorder = nil; lastReorder = nil
        if restoration != nil { restoration = nil }
    }
    private var hasKeyboardOwnership: Bool {
        if let keyboardOwned { return keyboardOwned() }
        // An accessibility action may focus an editor without a mouse NSEvent.
        // Never pull focus out of a native field editor in that case either.
        return window?.isKeyWindow == true && window?.isVisible == true && !(window?.firstResponder is NSTextView)
    }
    deinit {
        timeout?.cancel()
        if let monitor { NSEvent.removeMonitor(monitor) }
        if let resignObserver { NotificationCenter.default.removeObserver(resignObserver) }
    }
}

private struct NativeQuickTaskCompletionWindow: NSViewRepresentable {
    let focus: NativeQuickTaskCompletionFocus
    func makeNSView(context: Context) -> Probe { let view = Probe(); view.focus = focus; return view }
    func updateNSView(_ view: Probe, context: Context) { view.focus = focus; focus.attach(view.window) }
    static func dismantleNSView(_ view: Probe, coordinator: ()) { view.focus?.attach(nil); view.focus = nil }
    final class Probe: NSView {
        weak var focus: NativeQuickTaskCompletionFocus?
        override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); focus?.attach(window) }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
}

private struct NativeQuickTaskCompletionMarker: NSViewRepresentable {
    @ObservedObject var focus: NativeQuickTaskCompletionFocus
    let id: String
    let apply: (NativeQuickTaskRowFocus) -> Void
    func makeNSView(context: Context) -> NativeQuickTaskCompletionMount { NativeQuickTaskCompletionMount() }
    func updateNSView(_ view: NativeQuickTaskCompletionMount, context: Context) {
        view.acknowledge = { request, visible in focus.restore(request, isVisible: visible, apply: apply) }
        view.setRequest(focus.restoration?.target.taskID == id ? focus.restoration : nil)
    }
    static func dismantleNSView(_ view: NativeQuickTaskCompletionMount, coordinator: ()) { view.setRequest(nil); view.acknowledge = nil }
}

/// A row can be preloaded but clipped, so onAppear alone is not enough.
final class NativeQuickTaskCompletionMount: NSView {
    private var request: NativeQuickTaskCompletionFocus.Request?
    private var observation: Task<Void, Never>?
    var acknowledge: ((NativeQuickTaskCompletionFocus.Request, Bool) -> Bool)?
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    var hasVisibleRowGeometry: Bool {
        let clipped = visibleRect.intersection(bounds)
        return window != nil && !isHiddenOrHasHiddenAncestor && bounds.width >= 8 && bounds.height >= 8 &&
            clipped.width >= min(bounds.width, 120) && clipped.height >= min(bounds.height, 32)
    }
    func setRequest(_ next: NativeQuickTaskCompletionFocus.Request?) {
        guard request != next else { return }
        observation?.cancel(); observation = nil; request = next
        guard let next else { return }
        observation = Task { @MainActor [weak self] in
            for _ in 0..<100 {
                await Task.yield()
                guard let self, !Task.isCancelled, self.request == next else { return }
                if self.acknowledge?(next, self.hasVisibleRowGeometry) == true { return }
                do { try await Task.sleep(nanoseconds: 20_000_000) } catch { return }
            }
        }
    }
    deinit { observation?.cancel() }
}
