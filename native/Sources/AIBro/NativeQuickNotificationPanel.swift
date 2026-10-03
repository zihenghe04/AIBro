import AppKit
import SwiftUI
import Combine

struct NativeQuickNotificationGeometry: Equatable {
    let frame: CGRect
    let safeTop: CGFloat
    let collapsedWidth: CGFloat
    var contentHeight: CGFloat { frame.height - safeTop }

    static func resolve(screen: CGRect, visible: CGRect, safeTop: CGFloat,
                        leftArea: CGRect? = nil, rightArea: CGRect? = nil) -> Self {
        let safe = max(0, safeTop, screen.maxY - visible.maxY)
        let notch = leftArea.flatMap { left in rightArea.map { max(0, $0.minX - left.maxX) } } ?? 0
        let available = max(1, screen.width - 24)
        let width = min(available, max(400, notch + 64))
        let height = min(max(1, screen.height - 12), safe + 65)
        return .init(frame: CGRect(x: screen.midX - width / 2, y: screen.maxY - height, width: width, height: height),
                     safeTop: min(safe, max(0, height - 1)), collapsedWidth: min(width, max(200, notch)))
    }
    static func resolve(_ screen: NSScreen) -> Self {
        resolve(screen: screen.frame, visible: screen.visibleFrame, safeTop: screen.safeAreaInsets.top,
                leftArea: screen.auxiliaryTopLeftArea, rightArea: screen.auxiliaryTopRightArea)
    }
}

/// Native adaptation of TO-DO Panel notification.css/js at
/// 1deb3cac1e32599f13b1d6b30a7e52af76f67efd (MIT).
/// A separate, never-key notification surface. It never calls activate(),
/// makeKey(), or a main-island transition, and cannot replace its draft focus.
@MainActor final class NativeQuickNotificationPanel {
    struct Context {
        var screen: NSScreen
        var allowed: Bool
        /// Protect the expanded island's occupied area. If it intersects this
        /// notification, defer the toast with its remaining time preserved.
        /// The caller can instead reserve a free header slot and protect only
        /// the editor region. Never resize or navigate the main panel here.
        var protectedFrame: CGRect?
        var reducedMotion: Bool
        init(screen: NSScreen, allowed: Bool = true, protectedFrame: CGRect? = nil,
             reducedMotion: Bool = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion) {
            self.screen = screen; self.allowed = allowed; self.protectedFrame = protectedFrame
            self.reducedMotion = reducedMotion
        }
    }
    let queue: NativeQuickNotificationQueue
    private var context: Context?
    private var window: NativeQuickNotificationWindow?
    private var historyWindow: NSPanel?
    private var historyEvents: [NativeQuickNotificationEvent] = []
    private var subscription: AnyCancellable?
    private var activating: Task<Void, Never>?
    private var lastRegion: CGRect?
    private var stopped = false
    private let open: @MainActor (NativeQuickNotificationEvent.Destination) async -> Bool
    private let regionChanged: @MainActor (CGRect?) -> Void

    init(queue: NativeQuickNotificationQueue,
         open: @escaping @MainActor (NativeQuickNotificationEvent.Destination) async -> Bool,
         onOccupiedRegionChanged: @escaping @MainActor (CGRect?) -> Void = { _ in }) {
        self.queue = queue; self.open = open; self.regionChanged = onOccupiedRegionChanged
        // @Published notifies before assignment; reconcile on the next turn.
        subscription = queue.objectWillChange.receive(on: RunLoop.main).sink { [weak self] _ in self?.synchronize() }
        queue.setPresentationAllowed(false)
    }
    deinit { subscription?.cancel(); activating?.cancel() }

    func updateContext(_ context: Context?) {
        guard !stopped else { return }
        self.context = context
        synchronize()
    }
    func stop() {
        guard !stopped else { return }
        stopped = true; subscription?.cancel(); subscription = nil
        activating?.cancel(); activating = nil
        queue.setPresentationAllowed(false)
        closeHistory()
        window?.orderOut(nil); window?.close(); window = nil
        publishRegion(nil)
    }
    func closeHistory() { historyWindow?.orderOut(nil); historyWindow?.close(); historyWindow = nil; historyEvents = [] }
    /// The history window holds a display snapshot, not a second event store.
    /// Revoking a task/run must also revoke a previously opened title immediately.
    func reconcileHistory() {
        guard !historyEvents.isEmpty else { return }
        if queue.events(for: historyEvents.map(\.id)) != historyEvents { closeHistory() }
    }
    func retainHistory(runIDs: Set<String>) {
        if historyEvents.contains(where: { event in
            if case .run(let id) = event.destination { return !runIDs.contains(id) }
            return false
        }) { closeHistory() }
    }

    /// Explicit click navigation, unlike passive delivery, may open a normal
    /// keyboard-accessible panel. Copy every grouped ID before the queue advances.
    func showHistory(_ identifiers: [String]) -> Bool {
        guard !stopped else { return false }
        let events = queue.events(for: identifiers)
        guard !events.isEmpty, events.count == Set(identifiers).count else { return false }
        closeHistory()
        let panel = NSPanel(contentRect: CGRect(x: 0, y: 0, width: 430, height: min(480, 85 + events.count * 72)),
                            styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        panel.title = nativeUI("通知来源", "Notification sources")
        panel.isReleasedWhenClosed = false; panel.minSize = NSSize(width: 360, height: 220)
        panel.contentView = NSHostingView(rootView: NativeQuickNotificationHistoryView(events: events, open: { [weak self, weak panel] event in
            guard let self, let panel, self.queue.ownerID == event.ownerID, self.historyWindow === panel,
                  self.queue.events(for: [event.id]).first == event else { return false }
            let opened = await self.open(event.destination)
            guard self.historyWindow === panel else { return false }
            if opened { self.closeHistory() }
            return opened
        }))
        historyWindow = panel
        historyEvents = events
        panel.center(); panel.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        return panel.isVisible
    }
    private func synchronize() {
        guard !stopped else { return }
        reconcileHistory()
        guard let context else { conceal(); return }
        let geometry = NativeQuickNotificationGeometry.resolve(context.screen)
        let obstructed = context.protectedFrame.map { $0.intersects(geometry.frame) } ?? false
        guard context.allowed, !obstructed else { conceal(); return }
        queue.setPresentationAllowed(true)
        queue.setReducedMotion(context.reducedMotion)
        guard queue.current != nil else {
            window?.orderOut(nil); window?.close(); window = nil; publishRegion(nil)
            return
        }
        let panel: NativeQuickNotificationWindow
        if let existing = window { panel = existing }
        else {
            panel = NativeQuickNotificationWindow(contentRect: geometry.frame)
            window = panel
            let host = NativeQuickNotificationHostingView(rootView: NativeQuickNotificationView(queue: queue, geometry: geometry,
                activate: { [weak self] in self?.activate() }, dismiss: { [weak queue] in queue?.dismissCurrent() }))
            panel.contentView = host
        }
        if let host = panel.contentView as? NativeQuickNotificationHostingView {
            host.rootView = NativeQuickNotificationView(queue: queue, geometry: geometry,
                activate: { [weak self] in self?.activate() }, dismiss: { [weak queue] in queue?.dismissCurrent() })
        }
        // Constant canvas through the shape animation, no 60 Hz NSWindow resize.
        if panel.frame != geometry.frame { panel.setFrame(geometry.frame, display: false) }
        panel.ignoresMouseEvents = queue.phase != .visible
        panel.orderFrontRegardless()
        // Suppress the main island's hover entry for the whole notification
        // lifetime, including animation when this panel is click-through.
        publishRegion(geometry.frame)
        if queue.phase == .visible {
            queue.setHovering(geometry.frame.contains(NSEvent.mouseLocation))
        }
    }
    private func conceal() {
        queue.setPresentationAllowed(false)
        queue.setHovering(false)
        window?.orderOut(nil)
        publishRegion(nil)
    }
    private func publishRegion(_ region: CGRect?) {
        guard lastRegion != region else { return }
        lastRegion = region; regionChanged(region)
    }
    private func activate() {
        guard activating == nil else { return }
        activating = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.queue.activateCurrent(using: self.open)
            self.activating = nil
        }
    }
}

final class NativeQuickNotificationWindow: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
    init(contentRect: NSRect) {
        super.init(contentRect: contentRect, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        backgroundColor = .clear; isOpaque = false; hasShadow = false
        level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 2)
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        hidesOnDeactivate = false; isReleasedWhenClosed = false; animationBehavior = .none
        acceptsMouseMovedEvents = true; becomesKeyOnlyIfNeeded = true
        setAccessibilityRoleDescription(nativeUI("顶部通知", "Top notification"))
    }
}

private final class NativeQuickNotificationHostingView: NSHostingView<NativeQuickNotificationView> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

private struct NativeQuickNotificationView: View {
    @ObservedObject var queue: NativeQuickNotificationQueue
    let geometry: NativeQuickNotificationGeometry
    let activate: () -> Void
    let dismiss: () -> Void
    @State private var expanded = false
    @State private var contentVisible = false
    @State private var reveal: Task<Void, Never>?
    private enum Focus: Hashable { case open, dismiss }
    @AccessibilityFocusState private var focusedControl: Focus?

    var body: some View {
        ZStack(alignment: .top) {
            UnevenRoundedRectangle(topLeadingRadius: 0, bottomLeadingRadius: expanded ? 16 : 10,
                bottomTrailingRadius: expanded ? 16 : 10, topTrailingRadius: 0)
                .fill(Color(red: 0.045, green: 0.045, blue: 0.05))
                .overlay(alignment: .bottom) { Color.white.opacity(0.08).frame(height: 0.5) }
                .frame(width: expanded ? geometry.frame.width : geometry.collapsedWidth,
                       height: expanded ? geometry.frame.height : geometry.safeTop)
            if let item = queue.current {
                HStack(spacing: 8) {
                    Button(action: activate) {
                        HStack(spacing: 12) {
                            Image(systemName: symbol(item)).font(.system(size: 17, weight: .medium))
                                .foregroundStyle(accent(item)).frame(width: 28, height: 28)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(title(item)).font(.system(size: 13.5, weight: .semibold)).lineLimit(1)
                                HStack(spacing: 6) {
                                    Text(source(item)).font(.system(size: 10.5, weight: .medium)).foregroundStyle(accent(item))
                                        .fixedSize(horizontal: true, vertical: false)
                                    Text(queue.activationFailed ? nativeUI("暂时无法打开，请稍后重试", "Cannot open yet. Try again shortly.") : detail(item))
                                        .font(.system(size: 11)).foregroundStyle(.white.opacity(0.65)).lineLimit(1)
                                }
                            }.frame(maxWidth: .infinity, alignment: .leading)
                            if queue.pendingEventCount > 0 {
                                Text("+\(queue.pendingEventCount)").font(.system(size: 10.5, weight: .medium)).monospacedDigit()
                                    .foregroundStyle(.white.opacity(0.7)).padding(.horizontal, 6).padding(.vertical, 3)
                                    .background(.white.opacity(0.07), in: Capsule())
                                    .accessibilityLabel(nativeUI("另有 \(queue.pendingEventCount) 条通知", "\(queue.pendingEventCount) more notifications"))
                            }
                        }.contentShape(Rectangle())
                    }.buttonStyle(.plain).disabled(queue.isActivating)
                        .accessibilityLabel(title(item) + ", " + source(item) + ", " + detail(item))
                        .accessibilityHint(nativeUI("打开通知来源", "Open the notification source"))
                        .accessibilityFocused($focusedControl, equals: .open)
                    Button(action: dismiss) { Image(systemName: "xmark").font(.system(size: 10, weight: .medium)).frame(width: 20, height: 28) }
                        .buttonStyle(.plain).foregroundStyle(.white.opacity(0.55))
                        .accessibilityLabel(nativeUI("关闭此通知", "Dismiss notification"))
                        .accessibilityFocused($focusedControl, equals: .dismiss)
                }.foregroundStyle(.white).padding(.horizontal, 16)
                    .frame(height: geometry.contentHeight).padding(.top, geometry.safeTop)
                    .opacity(contentVisible ? 1 : 0).offset(y: contentVisible ? 0 : -4)
                    .allowsHitTesting(queue.phase == .visible)
                    .accessibilityHidden(queue.phase != .visible)
            }
        }.frame(width: geometry.frame.width, height: geometry.frame.height, alignment: .top)
            .clipped().preferredColorScheme(.dark)
            .onHover { queue.setHovering($0) }
            .onChange(of: focusedControl) { _, value in queue.setAccessibilityFocused(value != nil) }
            .onAppear { applyPhase() }
            .onChange(of: queue.phase) { _, _ in applyPhase() }
            .onChange(of: queue.current?.id) { _, _ in applyPhase() }
            .onChange(of: queue.reducedMotion) { _, _ in applyPhase() }
            .onDisappear { reveal?.cancel(); queue.setHovering(false); queue.setAccessibilityFocused(false) }
    }
    private func applyPhase() {
        reveal?.cancel(); reveal = nil
        let reduced = queue.reducedMotion
        if queue.phase == .entering || queue.phase == .visible {
            withAnimation(reduced ? nil : .timingCurve(0.22, 1, 0.36, 1, duration: NativeQuickNotificationQueue.entryDuration)) { expanded = true }
            if reduced || queue.phase == .visible { contentVisible = true }
            else {
                let token = queue.generation
                reveal = Task { @MainActor in
                    do { try await Task.sleep(nanoseconds: 90_000_000) } catch { return }
                    guard !Task.isCancelled, queue.generation == token else { return }
                    withAnimation(.easeOut(duration: 0.15)) { contentVisible = true }
                }
            }
        } else {
            withAnimation(reduced ? nil : .easeOut(duration: 0.12)) { contentVisible = false }
            withAnimation(reduced ? nil : .timingCurve(0.4, 0, 0.2, 1, duration: 0.28).delay(0.04)) { expanded = false }
        }
    }
    private func title(_ item: NativeQuickNotificationItem) -> String {
        item.isSummary ? nativeUI("还有 \(item.events.count) 条更新", "\(item.events.count) more updates") : item.events[0].title
    }
    private func source(_ item: NativeQuickNotificationItem) -> String {
        guard !item.isSummary else { return nativeUI("通知", "Notifications") }
        switch item.events[0].source {
        case .task: return nativeUI("任务", "Task")
        case .agenda: return nativeUI("日程", "Agenda")
        case .pomodoro: return nativeUI("番茄钟", "Focus timer")
        case .agent: return "AI Bro Agent"
        case .clipboard: return nativeUI("剪贴板", "Clipboard")
        case .externalCodex: return nativeUI("外部 Codex", "External Codex")
        case .externalClaude: return nativeUI("外部 Claude", "External Claude")
        case .externalGPT: return nativeUI("外部 GPT", "External GPT")
        }
    }
    private func detail(_ item: NativeQuickNotificationItem) -> String {
        if item.isSummary { return nativeUI("打开最近通知，逐条查看来源", "Open recent notifications and their sources") }
        return item.events[0].detail
    }
    private func symbol(_ item: NativeQuickNotificationItem) -> String {
        guard !item.isSummary else { return "tray.full" }
        switch item.events[0].source {
        case .task: return "checklist"
        case .agenda: return "calendar"
        case .pomodoro: return "timer"
        case .clipboard: return "doc.on.clipboard"
        case .agent:
            switch item.events[0].outcome {
            case .completed: return "checkmark.circle"
            case .failed: return "exclamationmark.circle"
            case .stopped, .rejected: return "stop.circle"
            case .interrupted: return "pause.circle"
            case .information: return "info.circle"
            }
        case .externalCodex, .externalClaude, .externalGPT: return "arrow.down.left.circle"
        }
    }
    private func accent(_ item: NativeQuickNotificationItem) -> Color {
        guard !item.isSummary else { return .white.opacity(0.8) }
        switch item.events[0].source {
        case .task, .agenda: return Color(red: 0.94, green: 0.68, blue: 0.34)
        case .pomodoro: return Color(red: 0.53, green: 0.73, blue: 0.96)
        case .agent:
            return item.events[0].outcome == .completed ? Color(red: 0.43, green: 0.83, blue: 0.65) : Color(red: 0.94, green: 0.68, blue: 0.34)
        case .clipboard, .externalCodex, .externalClaude, .externalGPT: return .white.opacity(0.8)
        }
    }
}


private struct NativeQuickNotificationHistoryView: View {
    let events: [NativeQuickNotificationEvent]
    let open: @MainActor (NativeQuickNotificationEvent) async -> Bool
    @State private var opening: String?
    @State private var failed: String?
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(events) { event in
                    Button {
                        opening = event.id; failed = nil
                        Task { @MainActor in
                            let success = await open(event)
                            if !success { failed = event.id }
                            opening = nil
                        }
                    } label: {
                        HStack(alignment: .top, spacing: 12) {
                            Image(systemName: event.source == .clipboard ? "doc.on.clipboard" : event.source == .pomodoro ? "timer" : "bubble.left.and.text.bubble.right")
                                .foregroundStyle(.secondary).frame(width: 24)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(event.title).font(.system(size: 13, weight: .medium)).lineLimit(2)
                                Text(event.detail).font(.system(size: 11)).foregroundStyle(.secondary)
                                if failed == event.id {
                                    Text(nativeUI("暂时无法打开，原内容与草稿均已保留", "Cannot open yet. Your content and drafts are retained.")).font(.system(size: 11)).foregroundStyle(.orange)
                                }
                            }.frame(maxWidth: .infinity, alignment: .leading)
                            if !event.source.isExternal { Image(systemName: "arrow.up.right").font(.system(size: 11)).foregroundStyle(.secondary) }
                        }.padding(14).contentShape(Rectangle())
                    }.buttonStyle(.plain).disabled(opening != nil || event.source.isExternal)
                    Divider().padding(.leading, 50)
                }
            }.padding(8)
        }.accessibilityLabel(nativeUI("最近通知及原始来源", "Recent notifications and original sources"))
    }
}
