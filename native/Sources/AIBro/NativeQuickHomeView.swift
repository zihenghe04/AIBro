import AppKit
import SwiftUI

/// Opacity/masking does not unmount a SwiftUI view. Explicit visibility keeps
/// media and pollers stopped while the transparent panel remains in memory.
struct NativeQuickModuleHost: View {
    let module: NativeQuickPanelModule
    let visible: Bool
    var active: Bool = false
    private var shouldWork: Bool { visible && active }
    var body: some View {
        module.content()
            .onAppear { module.onVisibilityChange?(visible); module.onActivityChange?(shouldWork) }
            .onChange(of: visible) { _, value in module.onVisibilityChange?(value) }
            .onChange(of: shouldWork) { _, value in module.onActivityChange?(value) }
            .onDisappear { module.onVisibilityChange?(false); module.onActivityChange?(false) }
    }
}

private struct NativeQuickBentoLayout: Layout {
    let geometry: NativeQuickBentoGeometry.Result
    let width: CGFloat
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        CGSize(width: width, height: geometry.height)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (item, frame) in zip(subviews, geometry.frames) {
            item.place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                anchor: .topLeading, proposal: ProposedViewSize(frame.size))
        }
    }
}

struct NativeQuickHomeView: View {
    @ObservedObject var coordinator: NativeQuickEntryCoordinator
    @ObservedObject private var preferences: NativeQuickPanelPreferences
    @ObservedObject private var workbench: NativeQuickWorkbenchStore
    @ObservedObject private var capture: NativeQuickCaptureStore
    @State private var noteFocused = false
    @State private var expandedModuleID: String?
    @State private var geometryCache = NativeQuickBentoGeometry.Cache()
    @StateObject private var reorder = NativeQuickHomeReorderController()
    @ScaledMetric(relativeTo: .body) private var minimumRowHeight: CGFloat = 88
    init(coordinator: NativeQuickEntryCoordinator) {
        self.coordinator = coordinator; self.preferences = coordinator.panelPreferences
        self.workbench = coordinator.workbench; self.capture = coordinator.capture
    }
    private var available: [String] { coordinator.homeModules.map(\.id) }
    private var visible: [String] { preferences.visibleHomeIDs(available: available) }
    private var automatic: Bool { preferences.usesAutomaticLayout(available: available) }
    private var layoutRevision: [String] { visible.map { $0 + ":" + preferences.preferredSize($0).rawValue } }
    private var usesDefaultHomeSizes: Bool {
        let defaults = NativeQuickPanelPreferences.Configuration()
        return preferences.configuration.homeSizes == defaults.homeSizes
    }
    var body: some View {
        ZStack(alignment: .top) {
            // Retaining the canvas preserves its scroll position and draft state.
            // Only the selected module keeps its lifecycle active in detail.
            dashboard
                .opacity(expandedModuleID == nil ? 1 : 0)
                .allowsHitTesting(expandedModuleID == nil)
                .accessibilityHidden(expandedModuleID != nil)
            if let id = expandedModuleID,
               let module = coordinator.homeModules.first(where: { $0.id == id }),
               let content = module.content {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 10) {
                        Button { expandedModuleID = nil } label: {
                            Label(nativeUI("首页", "Home"), systemImage: "chevron.left")
                        }.buttonStyle(.plain).font(.system(size: 12))
                            .accessibilityLabel(nativeUI("返回灵动岛首页", "Back to island home"))
                        Divider().frame(height: 13)
                        Text(module.title).font(.system(size: 13, weight: .medium))
                        Spacer()
                    }.padding(.horizontal, 20)
                    // Each detail owns its one scrolling surface. Wrapping it
                    // again would recreate the nested wheel conflict.
                    NativeQuickModuleHost(module: .init(content: content,
                        onVisibilityChange: visible.contains(id) ? nil : module.onVisibilityChange,
                        onActivityChange: visible.contains(id) ? nil : module.onActivityChange),
                        visible: coordinator.presentation.contentVisible && coordinator.section == .home,
                        active: coordinator.presentation.phase == .expanded)
                        .environment(\.nativeQuickWidgetContext, NativeQuickWidgetContext(size: preferences.preferredSize(id).rawValue, isDetail: true))
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                        .padding(.horizontal, 16)
                        .onAppear { acknowledgeNotificationDetail(id) }
                        .onChange(of: coordinator.homeModuleRequest) { _, _ in acknowledgeNotificationDetail(id) }
                        .onChange(of: coordinator.presentation.contentVisible) { _, _ in acknowledgeNotificationDetail(id) }
                }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
        .onChange(of: coordinator.homeModuleRequest) { _, request in
            if let request, coordinator.homeModules.contains(where: { $0.id == request.id && $0.content != nil }) {
                expandedModuleID = request.id
            }
        }
        .onAppear { if let request = coordinator.homeModuleRequest { expandedModuleID = request.id } }
        .onChange(of: expandedModuleID) { _, _ in reorder.cancel(animated: false); noteFocused = false; _ = capture.flushDraft() }
        .onChange(of: preferences.configuration) { _, _ in reorder.cancel(animated: false) }
        .onChange(of: coordinator.section) { _, _ in reorder.cancel(animated: false) }
        .onChange(of: coordinator.reduceMotion) { _, value in reorder.reduceMotion = value }
        .onAppear { reorder.reduceMotion = coordinator.reduceMotion }
        .onChange(of: visible) { _, ids in
            if let id = expandedModuleID, !ids.contains(id) { expandedModuleID = nil }
        }
    }
    private func acknowledgeNotificationDetail(_ id: String) {
        guard expandedModuleID == id, let request = coordinator.homeModuleRequest, request.id == id else { return }
        // Layout/appearance must finish before releasing the source notification.
        DispatchQueue.main.async { coordinator.acknowledgeHomeModule(request) }
    }
    private var dashboard: some View {
        GeometryReader { viewport in
          let canvasWidth = max(1, viewport.size.width - 32)
          let geometry = geometryCache.resolve(.init(
            dimensions: visible.map { .init(size: preferences.preferredSize($0).rawValue) },
            width: canvasWidth, viewportHeight: max(0, viewport.size.height - 37),
            minimumRowHeight: minimumRowHeight, automatic: automatic,
            compactWindowIndex: usesDefaultHomeSizes ? visible.firstIndex(of: "windows") : nil))
          ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    if reorder.interaction.phase == .dragging {
                        Text(reorder.interaction.target == nil
                             ? nativeUI("拖到另一个组件 · Esc 取消", "Drag onto another widget · Esc cancels")
                             : nativeUI("松手交换位置 · Esc 取消", "Release to swap · Esc cancels"))
                            .font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
                    } else {
                        Text(Date.now, format: .dateTime.month().day().weekday(.wide))
                            .font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button { coordinator.select(.settings) } label: { Image(systemName: "rectangle.3.group") }
                        .buttonStyle(.plain).foregroundStyle(.secondary)
                        .help(nativeUI("调整首页组件", "Customize home widgets"))
                        .accessibilityLabel(nativeUI("调整首页组件", "Customize home widgets"))
                }.padding(.horizontal, 2)
                if let issue = preferences.issue {
                    Text(issue).font(.system(size: 11)).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                }
                NativeQuickBentoLayout(geometry: geometry, width: canvasWidth) {
                    ForEach(Array(visible.enumerated()), id: \.element) { index, id in
                        if let module = coordinator.homeModules.first(where: { $0.id == id }) {
                            tile(module, size: NativeQuickPanelPreferences.Size(rawValue: geometry.slots[index].widgetSize) ?? .medium)
                        }
                    }
                }.animation(coordinator.reduceMotion ? nil : .timingCurve(0.22, 1, 0.36, 1, duration: 0.56), value: layoutRevision)
            }.padding(.horizontal, 16).padding(.top, 3).padding(.bottom, 10)
          }.scrollIndicators(.automatic)
        }
            .onChange(of: noteFocused) { _, focused in if focused { coordinator.activateInput() } }
            .onChange(of: coordinator.presentation.contentVisible) { _, value in
                if !value { reorder.cancel(animated: false); noteFocused = false; _ = capture.flushDraft() }
            }
            .onDisappear { reorder.cancel(animated: false); noteFocused = false; _ = capture.flushDraft() }
    }
    private func tile(_ module: NativeQuickHomeModule, size: NativeQuickPanelPreferences.Size) -> some View {
        let hasOwnHeading = ["pomodoro", "commands", "windows"].contains(module.id)
        let hasOwnPadding = ["pomodoro", "commands"].contains(module.id)
        let compactNote = module.id == "note" && size == .mini
        let tilePadding: CGFloat = hasOwnPadding ? 0 : compactNote ? 8 : 12
        let dragging = reorder.interaction.phase == .dragging
        let source = reorder.interaction.source == module.id
        let target = reorder.interaction.target == module.id
        let expected = preferences.configuration
        return VStack(alignment: .leading, spacing: hasOwnHeading ? 2 : compactNote ? 5 : 11) {
            HStack(spacing: 6) {
                Image(systemName: "line.3.horizontal").font(.system(size: 9, weight: .medium))
                    .foregroundStyle(source ? Color.accentColor : Color.secondary)
                    .help(nativeUI("长按后拖动交换位置", "Hold, then drag to swap"))
                    .accessibilityHidden(true)
                if !hasOwnHeading {
                    Image(systemName: module.symbol).font(.system(size: 10, weight: .medium))
                    Text(module.title).font(.system(size: 11, weight: .medium))
                }
                Spacer(minLength: 0)
                if module.id == "note" { noteAction }
                Button { openDetails(module) } label: { Image(systemName: "arrow.up.left.and.arrow.down.right").font(.system(size: 10)).frame(width: 19, height: 19) }
                    .buttonStyle(.plain).help(nativeUI("展开", "Expand ") + module.title)
                    .accessibilityLabel(nativeUI("展开", "Expand ") + module.title)
                Menu { tileActions(module) } label: { Image(systemName: "ellipsis").font(.system(size: 10)).frame(width: 19, height: 19) }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                    .accessibilityLabel(nativeUI("调整", "Customize ") + module.title)
            }.foregroundStyle(.secondary)
                .padding(.horizontal, hasOwnPadding ? 12 : 0).padding(.top, hasOwnPadding ? 8 : 0)
            Group {
                switch module.id {
                case "tasks": tasks(size: size)
                case "note": note(size: size)
                case "runs": runs
                default:
                    if let content = module.content {
                        NativeQuickModuleHost(module: .init(content: content, onVisibilityChange: module.onVisibilityChange, onActivityChange: module.onActivityChange),
                            visible: coordinator.presentation.contentVisible && coordinator.section == .home
                                && (expandedModuleID == nil || expandedModuleID == module.id),
                            active: coordinator.presentation.phase == .expanded)
                            .environment(\.nativeQuickWidgetContext, NativeQuickWidgetContext(size: size.rawValue, isDetail: false, expand: { openDetails(module) }))
                    }
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).clipped()
        }.padding(tilePadding).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(Color.primary.opacity(0.055), in: RoundedRectangle(cornerRadius: 15))
            .overlay(RoundedRectangle(cornerRadius: 15).strokeBorder(
                source || target ? Color.accentColor.opacity(target ? 0.8 : 0.55) : Color.primary.opacity(0.065), lineWidth: source || target ? 1.5 : 0.5)
                .allowsHitTesting(false))
            .overlay {
                NativeQuickHomeReorderSurface(id: module.id, title: module.title, controller: reorder,
                    visibleIDs: visible, headerTop: hasOwnPadding ? 8 : tilePadding,
                    headerTrailingInset: module.id == "note" ? 96 : 64,
                    enabled: coordinator.presentation.contentVisible && coordinator.section == .home && expandedModuleID == nil && visible.count > 1) { commit in
                        _ = preferences.swapHome(commit.source, with: commit.target, available: available, expected: expected)
                    }
            }
            .shadow(color: .black.opacity(dragging && source ? 0.2 : 0), radius: dragging && source ? 14 : 0, y: dragging && source ? 6 : 0)
            .opacity(dragging && !source && !target ? 0.78 : 1)
            // AppKit window coordinates point up; SwiftUI offsets point down.
            .offset(x: source ? reorder.interaction.translation.width : 0,
                    y: source ? -reorder.interaction.translation.height : 0)
            .zIndex(dragging && source ? 20 : 0)
            .accessibilityElement(children: .contain)
            .accessibilityAction(named: Text(nativeUI("向前移动", "Move earlier"))) { preferences.moveHome(module.id, offset: -1, available: available) }
            .accessibilityAction(named: Text(nativeUI("向后移动", "Move later"))) { preferences.moveHome(module.id, offset: 1, available: available) }
            .contextMenu { tileActions(module) }
    }
    @ViewBuilder private func tileActions(_ module: NativeQuickHomeModule) -> some View {
        Button(nativeUI("向前移动", "Move earlier")) { preferences.moveHome(module.id, offset: -1, available: available) }
        Button(nativeUI("向后移动", "Move later")) { preferences.moveHome(module.id, offset: 1, available: available) }
        if !automatic {
            Picker(nativeUI("组件大小", "Widget size"), selection: Binding(get: { preferences.preferredSize(module.id) }, set: { preferences.setSize($0, for: module.id) })) {
                ForEach(NativeQuickPanelPreferences.Size.allCases) { Text($0.title).tag($0) }
            }
        }
        Divider()
        Button(nativeUI("隐藏组件", "Hide widget")) { coordinator.setHomeModule(module.id, visible: false) }
            .disabled(visible.count <= 1 || module.canHide?() == false)
    }
    private func openDetails(_ module: NativeQuickHomeModule) {
        if let section = destination(module.id) { coordinator.select(section) }
        else if module.content != nil { expandedModuleID = module.id }
    }
    private func destination(_ id: String) -> NativeQuickPanelSection? {
        if id == "note" { return .capture }
        guard let section = NativeQuickPanelSection(rawValue: id), coordinator.availableSections.contains(section) else { return nil }
        return section
    }
    private func tasks(size: NativeQuickPanelPreferences.Size) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            let pending = workbench.tasks.filter { !$0.isCompleted }
            if workbench.loading { ProgressView().controlSize(.small) }
            else if pending.isEmpty {
                Text(workbench.ready ? nativeUI("暂无待办", "No pending tasks") : nativeUI("工作区暂不可用", "Workspace unavailable"))
                    .font(.system(size: 13)).foregroundStyle(.secondary)
            } else {
                ForEach(Array(pending.prefix(size == .mini ? 1 : 3))) { task in
                    HStack(alignment: .top, spacing: 8) {
                        Button { Task { _ = await workbench.setTaskCompleted(id: task.id, completed: true) } } label: {
                            if workbench.busyTaskIDs.contains(task.id) { ProgressView().controlSize(.mini) }
                            else { Image(systemName: "circle").font(.system(size: 14)).foregroundStyle(.secondary) }
                        }.buttonStyle(.plain).disabled(!workbench.ready || task.isSaving == true || workbench.busyTaskIDs.contains(task.id))
                            .accessibilityLabel(nativeUI("完成待办：", "Complete task: ") + task.title)
                        Button { Task { if await workbench.openTask(id: task.id) { coordinator.dismiss(returnFocus: false) } } } label: {
                            Text(task.title).font(.system(size: 12)).lineLimit(2).multilineTextAlignment(.leading).frame(maxWidth: .infinity, alignment: .leading)
                        }.buttonStyle(.plain)
                    }
                }
            }
            if let error = workbench.error { Text(error).font(.system(size: 10)).foregroundStyle(.red).lineLimit(3) }
            Spacer(minLength: 0)
            Button { coordinator.select(.tasks) } label: { Label(nativeUI("添加待办", "Add task"), systemImage: "plus").font(.system(size: 11)) }
                .buttonStyle(.plain).foregroundStyle(.tint)
        }
    }
    @ViewBuilder private var noteAction: some View {
        if capture.error != nil || capture.draftError != nil {
            Button { coordinator.select(.capture) } label: {
                Image(systemName: "exclamationmark.circle").frame(width: 19, height: 19)
            }.buttonStyle(.plain).foregroundStyle(.red)
                .help(capture.error ?? capture.draftError ?? "")
                .accessibilityLabel(nativeUI("查看随记保存问题", "Review note save issue"))
        } else if capture.savedID != nil {
            Button { capture.newCapture(); noteFocused = true } label: {
                Image(systemName: "plus").frame(width: 19, height: 19)
            }.buttonStyle(.plain).foregroundStyle(.tint)
                .help(nativeUI("已保存 · 再记一条", "Saved · New note"))
                .accessibilityLabel(nativeUI("随记已保存，再记一条", "Note saved. New note"))
        } else {
            Button {
                noteFocused = false
                Task { await capture.saveCapture() }
            } label: {
                Group {
                    if capture.saving { ProgressView().controlSize(.mini) }
                    else { Image(systemName: "arrow.down.circle") }
                }.frame(width: 19, height: 19)
            }.buttonStyle(.plain).foregroundStyle(.tint)
                .disabled(!capture.canSave || !coordinator.ready)
                .help(capture.pending == nil ? nativeUI("保存随记", "Save note") : nativeUI("重试保存随记", "Retry saving note"))
                .accessibilityLabel(capture.pending == nil ? nativeUI("保存随记", "Save note") : nativeUI("重试保存随记", "Retry saving note"))
        }
    }
    private func note(size: NativeQuickPanelPreferences.Size) -> some View {
        Group {
            if capture.savedID != nil {
                Text(capture.text).font(.system(size: 12)).foregroundStyle(.secondary)
                    .lineLimit(size == .mini ? 2 : 5)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else {
                ZStack(alignment: .topLeading) {
                    NativeQuickCaptureTextEditor(text: $capture.text, focused: $noteFocused,
                        locked: capture.inputLocked, fontSize: 12, lineSpacing: size == .mini ? 2 : 4,
                        routesHomeWheel: true,
                        label: nativeUI("首页随记", "Home quick note"), onFocus: { coordinator.activateInput() })
                    if capture.text.isEmpty { Text(nativeUI("记下一闪而过的想法…", "Catch a thought…")).font(.system(size: 11)).foregroundStyle(.tertiary).padding(.top, 4).allowsHitTesting(false) }
                }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
    }
    private var runs: some View {
        VStack(alignment: .leading, spacing: 9) {
            let active = workbench.runs.filter(\.isActive)
            if workbench.loading { ProgressView().controlSize(.small) }
            else if let run = active.first ?? workbench.runs.first {
                HStack(spacing: 6) {
                    if run.isActive { ProgressView().controlSize(.mini) }
                    Text(run.statusLabel).font(.system(size: 10)).foregroundStyle(.secondary)
                }
                Text(run.title).font(.system(size: 12, weight: .medium)).lineLimit(3)
                Spacer(minLength: 0)
                Button(nativeUI("查看进展", "View progress")) { coordinator.select(.runs) }.font(.system(size: 11)).buttonStyle(.plain).foregroundStyle(.tint)
            } else {
                Text(workbench.ready ? nativeUI("暂时没有运行", "No runs yet") : nativeUI("工作区暂不可用", "Workspace unavailable"))
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }
        }
    }
}

struct NativeQuickPanelSettingsView: View {
    @ObservedObject var coordinator: NativeQuickEntryCoordinator
    @ObservedObject private var preferences: NativeQuickPanelPreferences
    init(coordinator: NativeQuickEntryCoordinator) { self.coordinator = coordinator; self.preferences = coordinator.panelPreferences }
    private var modules: [NativeQuickHomeModule] {
        preferences.orderedHomeIDs(available: coordinator.homeModules.map(\.id)).compactMap { id in coordinator.homeModules.first { $0.id == id } }
    }
    private var visibleHome: [String] { preferences.visibleHomeIDs(available: modules.map(\.id)) }
    private var automatic: Bool { preferences.usesAutomaticLayout(available: modules.map(\.id)) }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 11) {
                    heading(nativeUI("灵动岛与快捷入口", "Dynamic Island & quick entry"))
                    Toggle(nativeUI("启用常驻入口", "Enable persistent entry"), isOn: Binding(
                        get: { coordinator.isEnabled }, set: { coordinator.setEnabled($0) }
                    )).toggleStyle(.switch).controlSize(.small)
                    Text(nativeUI("随 AI Bro 启动；关闭主窗口后仍可使用，退出 App 后关闭。", "Starts with AI Bro. Stays available when the main window closes; quits with the app."))
                        .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    Picker(nativeUI("入口位置", "Entry location"), selection: Binding(
                        get: { coordinator.preferredEnabledMode }, set: { coordinator.mode = $0 }
                    )) {
                        ForEach(NativeQuickEntryCoordinator.Mode.allCases.filter { $0 != .off }) { Text($0.title).tag($0) }
                    }.pickerStyle(.menu).disabled(!coordinator.isEnabled)
                    Picker(nativeUI("默认展开页", "Default page"), selection: Binding(get: {
                        preferences.defaultSection(available: coordinator.availableSections)
                    }, set: { preferences.setDefault($0, available: coordinator.availableSections) })) {
                        ForEach(coordinator.visibleSections) { Text($0.title).tag($0) }
                    }.pickerStyle(.menu)
                    NativeQuickShortcutView(store: coordinator.shortcutStore)
                }
                ForEach(coordinator.settingsSections) { section in section.content() }
                VStack(alignment: .leading, spacing: 12) {
                    heading(nativeUI("显示功能", "Visible features"))
                    ForEach(NativeQuickPanelSection.allCases.filter { $0.canHide && coordinator.availableSections.contains($0) }) { item in
                        Toggle(isOn: Binding(get: { !preferences.configuration.hiddenSections.contains(item) }, set: { preferences.setSection(item, visible: $0) })) {
                            Label(item.title, systemImage: item.symbol).font(.system(size: 12))
                        }.toggleStyle(.switch).controlSize(.small)
                    }
                }
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        heading(nativeUI("首页组件", "Home widgets")); Spacer()
                        Button(nativeUI("重置布局", "Reset layout")) { preferences.resetLayout() }.font(.system(size: 10)).buttonStyle(.plain).foregroundStyle(.secondary)
                    }
                    Text(automatic ? nativeUI("自动填充 · 原有大小偏好已保留", "Auto fill · Preferred sizes are retained") : nativeUI("拖动首页组件调整顺序 · 至少保留一个", "Drag home widgets to reorder · Keep at least one"))
                        .font(.system(size: 10)).foregroundStyle(.secondary)
                    ForEach(modules) { module in
                        VStack(alignment: .leading, spacing: 6) {
                            Toggle(isOn: Binding(get: { visibleHome.contains(module.id) }, set: { coordinator.setHomeModule(module.id, visible: $0) })) {
                                Label(module.title, systemImage: module.symbol).font(.system(size: 12))
                            }.toggleStyle(.switch).controlSize(.small)
                                .disabled(visibleHome.contains(module.id) && (visibleHome.count == 1 || module.canHide?() == false))
                            if !automatic {
                                HStack(spacing: 10) {
                                    Picker(nativeUI("大小", "Size"), selection: Binding(get: { preferences.preferredSize(module.id) }, set: { preferences.setSize($0, for: module.id) })) {
                                        ForEach(NativeQuickPanelPreferences.Size.allCases) { Text($0.title).tag($0) }
                                    }.pickerStyle(.menu).labelsHidden().controlSize(.small)
                                    Spacer()
                                    Button { preferences.moveHome(module.id, offset: -1, available: modules.map(\.id)) } label: { Image(systemName: "chevron.up") }.disabled(modules.first?.id == module.id)
                                        .accessibilityLabel(nativeUI("向前移动", "Move earlier") + module.title)
                                    Button { preferences.moveHome(module.id, offset: 1, available: modules.map(\.id)) } label: { Image(systemName: "chevron.down") }.disabled(modules.last?.id == module.id)
                                        .accessibilityLabel(nativeUI("向后移动", "Move later") + module.title)
                                }.buttonStyle(.plain).font(.system(size: 10)).foregroundStyle(.secondary).padding(.leading, 23)
                            }
                        }
                    }
                }
                if let issue = preferences.issue { Text(issue).font(.system(size: 11)).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
            }.frame(maxWidth: 760, alignment: .leading).padding(.horizontal, 20).padding(.top, 5).padding(.bottom, 12).frame(maxWidth: .infinity)
        }.scrollIndicators(.hidden)
    }
    private func heading(_ text: String) -> some View { Text(text).font(.system(size: 12, weight: .semibold)) }
}
