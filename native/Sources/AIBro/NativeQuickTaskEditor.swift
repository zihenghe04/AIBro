import SwiftUI

/// The island edits fields of the shared task record, never a calendar event.
struct NativeQuickTaskFieldsView: View {
    @Binding var fields: NativeQuickTaskFields
    let projects: [NativeQuickProjectItem]
    var workflowNames: [String: String] = NativeQuickTaskWorkflow.defaults
    var disabled = false
    var onDeadlineChange: (() -> Void)?
    var deadlineDefault: NativeQuickTaskDeadlineDefault?
    var onDefaultChange: ((NativeQuickTaskDeadlineDefault) -> Void)?
    private var candidates: [NativeQuickProjectItem] { projects.filter { $0.workspace == fields.workspace } }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 12) {
                Picker(nativeUI("空间", "Space"), selection: $fields.workspace) {
                    Text(nativeUI("日常", "Daily")).tag("日常")
                    Text(nativeUI("课程", "Courses")).tag("课程")
                    Text(nativeUI("科研", "Research")).tag("科研")
                }.frame(maxWidth: 160)
                Picker(nativeUI("项目", "Project"), selection: Binding(get: { fields.projectId ?? "" }, set: { fields.projectId = $0.isEmpty ? nil : $0 })) {
                    Text(nativeUI("无项目", "No project")).tag("")
                    ForEach(candidates) { project in Text(project.title).tag(project.id) }
                    if let id = fields.projectId, !candidates.contains(where: { $0.id == id }) {
                        Text(nativeUI("原项目不可用", "Original project unavailable")).tag(id)
                    }
                }.frame(maxWidth: .infinity)
            }
            HStack(spacing: 12) {
                Picker(nativeUI("分类", "Category"), selection: Binding(get: { fields.workflowCategory ?? "" }, set: { fields.workflowCategory = $0.isEmpty ? nil : $0 })) {
                    Text(nativeUI("未分类", "Uncategorized")).tag("")
                    ForEach(NativeQuickTaskWorkflow.keys, id: \.self) { key in Text(workflowNames[key] ?? key).tag(key) }
                }.frame(maxWidth: 220)
                Spacer(minLength: 0)
            }
            HStack(spacing: 12) {
                Toggle(nativeUI("截止日期", "Deadline"), isOn: Binding(get: { fields.dueAt != nil }, set: { setDeadline($0 ? .day(Date()) : nil) }))
                    .toggleStyle(.checkbox)
                if fields.dueAt != nil {
                    DatePicker("", selection: Binding(get: { fields.dueAt?.date ?? Date() }, set: { setDeadline(fields.dueAt?.isDay == true ? .day($0) : .time($0)) }),
                               displayedComponents: fields.dueAt?.isDay == true ? [.date] : [.date, .hourAndMinute])
                        .labelsHidden().accessibilityLabel(nativeUI("任务截止日期", "Task deadline"))
                    Toggle(nativeUI("时间", "Time"), isOn: Binding(get: { fields.dueAt?.isDay == false }, set: {
                        let date = fields.dueAt?.date ?? Date(); setDeadline($0 ? .time(date) : .day(date))
                    })).toggleStyle(.checkbox)
                } else { Text(nativeUI("无截止日期", "No deadline")).foregroundStyle(.secondary) }
                Spacer(minLength: 0)
                Menu {
                    ForEach(NativeQuickTaskDeadlinePreset.allCases, id: \.self) { preset in
                        Button(preset.title) {
                            let value = preset.deadline(now: Date(), calendar: .autoupdatingCurrent)
                            // A menu may stay open over the 23:30 boundary. Never silently
                            // turn an expired Today command into a different day or no date.
                            if preset == .none || value != nil { setDeadline(value) }
                        }.disabled(preset == .today && preset.deadline(now: Date(), calendar: .autoupdatingCurrent) == nil)
                    }
                    if let deadlineDefault, let onDefaultChange {
                        Divider()
                        Menu(nativeUI("新任务默认", "New task default")) {
                            ForEach(NativeQuickTaskDeadlineDefault.allCases, id: \.self) { value in
                                Button { onDefaultChange(value) } label: {
                                    if value == deadlineDefault { Label(value.title, systemImage: "checkmark") }
                                    else { Text(value.title) }
                                }
                            }
                        }
                    }
                } label: { Image(systemName: "calendar.badge.clock") }
                    .menuStyle(.borderlessButton).fixedSize()
                    .accessibilityLabel(nativeUI("快捷截止日期", "Quick deadline"))
            }
        }.font(.system(size: 11)).disabled(disabled)
            .onChange(of: fields.workspace) { _, _ in
                // Only an explicit space change clears an incompatible project.
                // Snapshot updates do not silently unlink an unavailable owner.
                if let id = fields.projectId, !candidates.contains(where: { $0.id == id }) { fields.projectId = nil }
            }
    }
    private func setDeadline(_ value: NativeQuickTaskDate?) { onDeadlineChange?(); fields.dueAt = value }
}

private extension NativeQuickTaskDeadlinePreset {
    var title: String {
        switch self {
        case .today: return nativeUI("今晚 23:30", "Tonight, 23:30")
        case .tomorrow: return nativeUI("明晚 23:30", "Tomorrow night, 23:30")
        case .week: return nativeUI("一周后", "In one week")
        case .none: return nativeUI("无截止日期", "No deadline")
        }
    }
}
private extension NativeQuickTaskDeadlineDefault {
    var title: String {
        switch self {
        case .none: return nativeUI("无截止日期", "No deadline")
        case .nextEvening: return nativeUI("下一个 23:30", "Next 23:30")
        case .tomorrowEvening: return nativeUI("明晚 23:30", "Tomorrow night, 23:30")
        }
    }
}

/// Only creation receives automatic defaults. Saved-task editors use the same
/// explicit shortcuts without subscribing their dates to a clock.
struct NativeQuickTaskCreationFieldsView: View {
    @ObservedObject var workbench: NativeQuickWorkbenchStore
    private let clock = Timer.publish(every: 60, on: .main, in: .common).autoconnect()
    private var fields: Binding<NativeQuickTaskFields> {
        Binding(get: { workbench.pendingTaskFields ?? workbench.creationFields }, set: {
            if workbench.pendingTaskTitle == nil { workbench.creationFields = $0 }
        })
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            NativeQuickTaskFieldsView(fields: fields, projects: workbench.projects, workflowNames: workbench.workflowNames,
                disabled: workbench.creating || workbench.pendingTaskTitle != nil || !workbench.ready || workbench.deadlinePreferenceBusy,
                onDeadlineChange: { workbench.markCreationDeadlineManual() }, deadlineDefault: workbench.creationDeadlineDefault,
                onDefaultChange: { value in Task { await workbench.setCreationDeadlineDefault(value) } })
            if let error = workbench.deadlinePreferenceError {
                HStack(spacing: 8) {
                    Text(error).foregroundStyle(.red)
                    Button(nativeUI("重新读取", "Reload")) { Task { await workbench.loadCreationDeadlinePreference(forceReload: true) } }
                        .disabled(workbench.deadlinePreferenceBusy)
                }.font(.system(size: 11)).fixedSize(horizontal: false, vertical: true)
            }
        }
        .task { await workbench.loadCreationDeadlinePreference(); workbench.refreshCreationDeadline() }
        .onChange(of: workbench.ready) { _, _ in workbench.refreshCreationDeadline() }
        .onReceive(clock) { _ in workbench.refreshCreationDeadline() }
        .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didWakeNotification)) { _ in workbench.refreshCreationDeadline() }
        .onReceive(NotificationCenter.default.publisher(for: .NSCalendarDayChanged)) { _ in workbench.refreshCreationDeadline() }
        .onReceive(NotificationCenter.default.publisher(for: .NSSystemClockDidChange)) { _ in workbench.refreshCreationDeadline() }
        .onReceive(NotificationCenter.default.publisher(for: .NSSystemTimeZoneDidChange)) { _ in workbench.refreshCreationDeadline() }
    }
}

struct NativeQuickTaskEditView: View {
    @ObservedObject var workbench: NativeQuickWorkbenchStore
    var onFocus: () -> Void
    @State private var confirmDiscard = false
    @State private var reload = false
    @FocusState private var focused: Bool
    private var busy: Bool { workbench.editingTask.map { workbench.busyTaskIDs.contains($0.original.id) } ?? false }
    private var title: Binding<String> {
        Binding(get: { workbench.editingTask?.title ?? "" }, set: { workbench.editingTask?.title = $0 })
    }
    private var fields: Binding<NativeQuickTaskFields> {
        Binding(get: { workbench.editingTask?.fields ?? NativeQuickTaskFields() }, set: { workbench.editingTask?.fields = $0 })
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            TextField(nativeUI("任务名称", "Task title"), text: title).textFieldStyle(.plain).font(.system(size: 13))
                .focused($focused).onSubmit { save() }.disabled(busy)
            NativeQuickTaskFieldsView(fields: fields, projects: workbench.projects, workflowNames: workbench.workflowNames, disabled: busy)
            HStack(spacing: 14) {
                Button(nativeUI("取消", "Cancel")) {
                    reload = false
                    if workbench.hasUnsavedTaskEditorDraft { confirmDiscard = true } else { workbench.editingTask = nil }
                }.disabled(busy)
                if workbench.taskEditorConflict {
                    Button(nativeUI("载入最新", "Load latest")) {
                        reload = true
                        if workbench.hasUnsavedTaskEditorDraft { confirmDiscard = true } else { _ = workbench.reloadEditingTask() }
                    }.disabled(busy)
                }
                Spacer()
                if busy { ProgressView().controlSize(.mini) }
                Button(nativeUI("保存更改", "Save changes")) { save() }
                    .disabled(busy || !workbench.ready || title.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .keyboardShortcut("s", modifiers: .command)
            }.font(.system(size: 11))
        }.padding(12).background(Color.primary.opacity(0.055), in: RoundedRectangle(cornerRadius: 10))
            .confirmationDialog(nativeUI("放弃待办更改？", "Discard task changes?"), isPresented: $confirmDiscard) {
                Button(nativeUI("放弃更改", "Discard changes"), role: .destructive) {
                    if reload { _ = workbench.reloadEditingTask() } else { workbench.editingTask = nil }
                }
                Button(nativeUI("继续编辑", "Keep editing"), role: .cancel) {}
            }
            .onChange(of: focused) { _, value in if value { onFocus() } }
    }
    private func save() { guard !busy else { return }; Task { _ = await workbench.saveEditingTask() } }
}
