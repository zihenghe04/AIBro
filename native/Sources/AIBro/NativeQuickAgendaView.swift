import SwiftUI

struct NativeQuickAgendaView: View {
    @ObservedObject var store: NativeQuickAgendaStore
    var onFocus: () -> Void
    @State private var confirmDiscard = false
    @State private var reload = false
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Button { store.changeDay(-1) } label: { Image(systemName: "chevron.left") }.accessibilityLabel(nativeUI("前一天", "Previous day"))
                Button(nativeUI("今天", "Today")) { store.today() }
                Button { store.changeDay(1) } label: { Image(systemName: "chevron.right") }.accessibilityLabel(nativeUI("后一天", "Next day"))
                Text(store.date.formatted(.dateTime.month().day().weekday())).fontWeight(.medium)
                Spacer()
                Picker(nativeUI("范围", "Range"), selection: $store.upcoming) {
                    Text(nativeUI("当天", "Day")).tag(false); Text(nativeUI("7 天", "7 days")).tag(true)
                }.pickerStyle(.segmented).labelsHidden().frame(width: 110)
                Button { _ = store.beginNew(); onFocus() } label: { Image(systemName: "plus") }
                    .disabled(!store.ready || store.hasEditor).accessibilityLabel(nativeUI("新建日程", "New event"))
            }.buttonStyle(.plain).font(.system(size: 12))
            if let error = store.error { Text(error).font(.system(size: 11)).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
            if store.savedEventID != nil { Text(nativeUI("已保存到本机日程", "Saved to local agenda")).font(.system(size: 11)).foregroundStyle(.secondary) }
            if store.hasEditor {
                if store.canDisplayEditor {
                    NativeQuickAgendaEditor(store: store, onFocus: onFocus, onCancel: { requestDiscard(reload: false) }, onReload: { requestDiscard(reload: true) })
                } else {
                    HStack {
                        Text(nativeUI("编辑目标暂不可用，输入已保留。", "The editing target is unavailable. Your input is retained."))
                        Spacer(); Button(nativeUI("取消编辑", "Cancel edit")) { requestDiscard(reload: false) }
                    }.font(.system(size: 11)).foregroundStyle(.secondary)
                }
            } else if !store.ready {
                Text(nativeUI("日程暂不可用", "Agenda unavailable")).font(.system(size: 12)).foregroundStyle(.secondary)
            } else {
              NativeQuickFocusScroll(focus:store.recordFocus) {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if store.occurrences.isEmpty { Text(nativeUI("这段时间没有安排", "No scheduled items in this range")).font(.system(size: 12)).foregroundStyle(.secondary).padding(.vertical, 26) }
                        ForEach(store.occurrences) { occurrence in
                            Button {
                                if occurrence.taskID != nil { Task { _ = await store.openTask(occurrence) } }
                                else { _ = store.beginEditing(occurrence); onFocus() }
                            } label: {
                                HStack(alignment: .top, spacing: 11) {
                                    Image(systemName: occurrence.taskID == nil ? "calendar" : "checklist").foregroundStyle(.secondary).frame(width: 18)
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(occurrence.event.title).font(.system(size: 13)).foregroundStyle(.primary).multilineTextAlignment(.leading).lineLimit(3)
                                        HStack(spacing: 7) {
                                            Text(occurrence.taskID == nil ? nativeUI("日程", "Event") : nativeUI("任务截止", "Task deadline"))
                                            Text(timeLabel(occurrence))
                                            if occurrence.event.frequency != "none" { Image(systemName: "repeat") }
                                        }.font(.system(size: 10)).foregroundStyle(.secondary)
                                        if let project = store.projects.first(where: { $0.id == occurrence.event.projectID }) { Text(project.title).font(.system(size: 10)).foregroundStyle(.tertiary).lineLimit(1) }
                                    }.frame(maxWidth: .infinity, alignment: .leading)
                                    Image(systemName: occurrence.taskID == nil ? "pencil" : "arrow.up.right").font(.system(size: 10)).foregroundStyle(.tertiary)
                                }.padding(.vertical, 12).contentShape(Rectangle())
                            }.buttonStyle(.plain).id(occurrence.id)
                                .background(NativeQuickRecordFocusMarker(focus:store.recordFocus,id:occurrence.id))
                            Divider().opacity(0.45)
                        }
                    }
                }.scrollIndicators(.hidden)
              }
            }
            Button(nativeUI("在主窗口打开日程", "Open agenda in main window")) { store.openAgenda() }
                .font(.system(size: 11)).buttonStyle(.plain).foregroundStyle(.secondary).disabled(!store.ready)
        }.padding(.horizontal, 4).padding(.top, 4)
            .confirmationDialog(nativeUI("放弃日程更改？", "Discard event changes?"), isPresented: $confirmDiscard) {
                Button(nativeUI("放弃更改", "Discard changes"), role: .destructive) { if reload { _ = store.reloadEditor() } else { _ = store.discardEditor() } }
                Button(nativeUI("继续编辑", "Keep editing"), role: .cancel) {}
            }
    }
    private func requestDiscard(reload: Bool) {
        self.reload = reload
        if store.hasUnsavedEditorDraft { confirmDiscard = true }
        else if reload { _ = store.reloadEditor() } else { _ = store.discardEditor() }
    }
    private func timeLabel(_ value: AgendaOccurrence) -> String {
        let day = store.upcoming ? value.start.formatted(.dateTime.month().day()) + " · " : ""
        if value.event.allDay { return day + nativeUI("全天", "All day") }
        return day + value.start.formatted(date: .omitted, time: .shortened) + "–" + value.end.formatted(date: .omitted, time: .shortened)
    }
}

private struct NativeQuickAgendaEditor: View {
    @ObservedObject var store: NativeQuickAgendaStore
    var onFocus: () -> Void
    var onCancel: () -> Void
    var onReload: () -> Void
    @FocusState private var focused: Bool
    private var event: AgendaEvent { store.editing?.event ?? AgendaEvent() }
    private func field<Value>(_ key: WritableKeyPath<AgendaEvent, Value>) -> Binding<Value> {
        Binding(get: { store.editing?.event[keyPath: key] ?? event[keyPath: key] }, set: { value in store.updateDraft { $0[keyPath: key] = value } })
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(store.editing?.baseline == nil ? nativeUI("新建日程", "New event") : nativeUI("编辑日程", "Edit event")).font(.system(size: 13, weight: .medium))
                Spacer(); Button(nativeUI("取消", "Cancel"), action: onCancel)
                if store.editing?.baseline != nil && store.error != nil { Button(nativeUI("载入最新", "Load latest"), action: onReload) }
                Button(nativeUI("保存", "Save")) { _ = store.saveEditor() }.keyboardShortcut("s", modifiers: .command)
                    .disabled(event.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !store.ready || store.saving)
            }.buttonStyle(.plain).font(.system(size: 11))
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    TextField(nativeUI("日程名称", "Event title"), text: field(\.title)).textFieldStyle(.roundedBorder).focused($focused)
                    HStack {
                        Picker(nativeUI("类型", "Type"), selection: field(\.kind)) { Text(nativeUI("日程", "Event")).tag("event"); Text(nativeUI("课程", "Course")).tag("course"); Text(nativeUI("会议", "Meeting")).tag("meeting") }
                        Toggle(nativeUI("全天", "All day"), isOn: Binding(get: { event.allDay }, set: { value in store.updateDraft { AgendaEditorFields.allDay(&$0, enabled: value) } }))
                    }
                    DatePicker(nativeUI("开始", "Start"), selection: field(\.start), displayedComponents: event.allDay ? [.date] : [.date, .hourAndMinute])
                    DatePicker(event.allDay ? nativeUI("结束（不含该日）", "End (exclusive)") : nativeUI("结束", "End"), selection: field(\.end), displayedComponents: event.allDay ? [.date] : [.date, .hourAndMinute])
                    Picker(nativeUI("时区", "Time zone"), selection: field(\.timeZone)) { ForEach(TimeZone.knownTimeZoneIdentifiers, id: \.self) { Text($0).tag($0) } }
                    TextField(nativeUI("地点 / 会议链接", "Location / Meeting link"), text: field(\.location)).textFieldStyle(.roundedBorder)
                    Picker(nativeUI("所属项目", "Project"), selection: Binding(get: { event.projectID }, set: { value in store.updateDraft { $0.projectID = value; $0.documentID = "" } })) {
                        Text(nativeUI("独立日程", "Standalone event")).tag("")
                        ForEach(store.projects) { Text($0.title).tag($0.id) }
                    }
                    Picker(nativeUI("关联资料", "Linked source"), selection: Binding(get: { event.documentID }, set: { value in store.updateDraft { $0.documentID = value; $0.documentKind = store.documents(projectID: $0.projectID).first(where: { $0.id == value })?.kind ?? "note" } })) {
                        Text(nativeUI("不关联资料", "No linked source")).tag("")
                        ForEach(store.documents(projectID: event.projectID)) { Text($0.title).tag($0.id) }
                    }
                    Picker(nativeUI("提前提醒", "Reminder"), selection: Binding(get: { event.reminderMinutes ?? -1 }, set: { value in store.updateDraft { $0.reminderMinutes = value < 0 ? nil : value } })) {
                        Text(nativeUI("不提醒", "No reminder")).tag(-1); Text(nativeUI("到点", "At start")).tag(0)
                        ForEach([5,15,30,60,1440], id: \.self) { value in Text(nativeUI("提前 \(value) 分钟", "\(value) minutes before")).tag(value) }
                        if let minutes = event.reminderMinutes, ![0,5,15,30,60,1440].contains(minutes) { Text(nativeUI("提前 \(minutes) 分钟", "\(minutes) minutes before")).tag(minutes) }
                    }
                    recurrence
                    Text(nativeUI("备注", "Notes")).foregroundStyle(.secondary)
                    TextEditor(text: field(\.details)).frame(minHeight: 75).overlay(RoundedRectangle(cornerRadius: 6).stroke(.primary.opacity(0.1)))
                }.font(.system(size: 11)).padding(.trailing, 3)
                    .environment(\.timeZone, TimeZone(identifier: event.timeZone) ?? .current)
                    .environment(\.calendar, event.calendar())
            }.scrollIndicators(.hidden)
        }.padding(12).background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
            .onChange(of: focused) { _, value in if value { onFocus() } }
    }
    @ViewBuilder private var recurrence: some View {
        Picker(nativeUI("重复", "Repeat"), selection: field(\.frequency)) {
            Text(nativeUI("不重复", "Never")).tag("none"); Text(nativeUI("每天", "Daily")).tag("daily")
            Text(nativeUI("每周", "Weekly")).tag("weekly"); Text(nativeUI("每月同日", "Monthly on same day")).tag("monthly")
        }
        if event.frequency != "none" {
            Stepper(nativeUI("间隔 \(event.interval)", "Interval \(event.interval)"), value: field(\.interval), in: 1...52)
            if event.frequency == "weekly" {
                HStack(spacing: 5) {
                    ForEach(Array(zip([2,3,4,5,6,7,1], ["一","二","三","四","五","六","日"])), id: \.0) { day, label in
                        Button { store.updateDraft { if $0.weekdays.contains(day) { $0.weekdays.removeAll { $0 == day } } else { $0.weekdays.append(day) } } }
                        label: { Text(NativeL10n.weekday(label)).frame(width: 26, height: 26).background(event.weekdays.contains(day) ? Color.accentColor.opacity(0.15) : Color.primary.opacity(0.04), in: Circle()) }
                            .buttonStyle(.plain).accessibilityAddTraits(event.weekdays.contains(day) ? .isSelected : [])
                    }
                }
            }
            Toggle(nativeUI("重复截止日", "Repeat end date"), isOn: Binding(get: { event.until != nil }, set: { value in store.updateDraft { AgendaEditorFields.repeatUntil(&$0, date: value ? $0.calendar().date(byAdding: .month, value: 4, to: $0.start) : nil) } }))
            if event.until != nil { DatePicker(nativeUI("重复至", "Repeat until"), selection: Binding(get: { event.until ?? Date() }, set: { value in store.updateDraft { AgendaEditorFields.repeatUntil(&$0, date: value) } }), displayedComponents: .date) }
            if let count = event.count { Text(nativeUI("原规则：共 \(count) 次", "Original rule: \(count) occurrences")).foregroundStyle(.secondary) }
            Text(nativeUI("保存更改整个系列。调整或跳过单次日程请打开主窗口。", "Saving updates the series. Open the main window to reschedule or skip one occurrence.")).foregroundStyle(.secondary)
        }
    }
}
