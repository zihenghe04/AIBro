import AppKit
import SwiftUI
import Combine
import Carbon.HIToolbox
import UniformTypeIdentifiers
import QuartzCore

/// Routes into the existing workspace. The panel keeps one recoverable, unsent
/// quick capture; the existing workspace remains the sole writer of saved notes.
enum NativeQuickAction: String, CaseIterable, Identifiable {
    case resume, newChat, quickNotes, search, agenda, activity, settings
    var id: String { rawValue }

    var title: String {
        switch self {
        case .resume: return nativeUI("继续工作", "Continue working")
        case .newChat: return nativeUI("新对话", "New chat")
        case .quickNotes: return nativeUI("随手记", "Quick notes")
        case .search: return nativeUI("搜索工作区", "Search workspace")
        case .agenda: return nativeUI("查看日程", "Open agenda")
        case .activity: return nativeUI("通知与变化", "Activity")
        case .settings: return nativeUI("设置", "Settings")
        }
    }

    var symbol: String {
        switch self {
        case .resume: return "arrow.up.right.square"
        case .newChat: return "square.and.pencil"
        case .quickNotes: return "note.text"
        case .search: return "magnifyingglass"
        case .agenda: return "calendar"
        case .activity: return "bell"
        case .settings: return "gearshape"
        }
    }
}

struct NativeQuickPanelModule {
    let content: () -> AnyView
    var onVisibilityChange: ((Bool) -> Void)?
    var onActivityChange: ((Bool) -> Void)? = nil
}

struct NativeQuickSettingsSection: Identifiable {
    let id: String
    let content: () -> AnyView
}

struct NativeQuickHomeModule: Identifiable {
    let id: String
    let title: String
    let symbol: String
    var content: (() -> AnyView)?
    var onVisibilityChange: ((Bool) -> Void)?
    var onActivityChange: ((Bool) -> Void)? = nil
    var canHide: (() -> Bool)?
}

struct NativeQuickVoiceStatus: Equatable {
    let title: String
    let symbol: String
    let isProcessing: Bool
    init(title: String, symbol: String = "waveform", isProcessing: Bool = false) {
        self.title = title; self.symbol = symbol; self.isProcessing = isProcessing
    }
}

@MainActor
final class NativeQuickEntryCoordinator: NSObject, ObservableObject {
    enum Mode: String, CaseIterable, Identifiable {
        case off, menuBar, edge, island
        var id: String { rawValue }
        var title: String {
            switch self {
            case .off: return nativeUI("关闭常驻入口", "Off")
            case .menuBar: return nativeUI("菜单栏", "Menu bar")
            case .edge: return nativeUI("屏幕侧边", "Screen edge")
            case .island: return nativeUI("顶部灵动岛", "Top island")
            }
        }
    }

    @Published var mode: Mode {
        didSet {
            guard oldValue != mode else { return }
            preferences.set(mode.rawValue, forKey: Self.modeKey)
            if configured { reconcileEntry() }
        }
    }
    @Published private(set) var busy = false
    @Published private(set) var unread = 0
    @Published private(set) var ready = false
    @Published private(set) var voiceStatus: NativeQuickVoiceStatus?
    @Published private(set) var voicePresented = false
    @Published private(set) var voiceContent: (() -> AnyView)?
    private var voiceOnEscape: (() -> Void)?
    private var voiceOnHide: (() -> Void)?
    private var sectionBeforeVoice: Section = .home
    var hotkeyMessage: String? { shortcutStore.issue }
    let shortcutStore: NativeQuickShortcutStore
    @Published private(set) var showingCapture = false
    @Published private(set) var captureFocusRequest = 0
    private(set) var navigationOwnsFocus = false
    struct HomeModuleRequest: Equatable { let id: String; let token: UUID }
    @Published private(set) var homeModuleRequest: HomeModuleRequest?
    private var homeModuleAcknowledgement: CheckedContinuation<Bool, Never>?
    private var homeModuleTimeout: Task<Void, Never>?
    private var notificationOccupiedRegion: CGRect?
    let capture = NativeQuickCaptureStore()
    let captureLibrary = NativeQuickCaptureLibraryStore()
    let links = NativeQuickLinksStore()
    @Published var captureLibraryVisible = false
    let workbench = NativeQuickWorkbenchStore()
    typealias Section = NativeQuickPanelSection
    let panelPreferences: NativeQuickPanelPreferences
    @Published private(set) var extensionModules: [Section: NativeQuickPanelModule] = [:]
    @Published private(set) var extensionHomeModules: [String: NativeQuickHomeModule] = [:]
    @Published private(set) var settingsSections: [NativeQuickSettingsSection] = []
    // User-owned drops only. Agent navigation conveys no clipboard/file access.
    var canReceiveFiles: () -> Bool = { false }
    var receiveFiles: ([NSItemProvider]) -> Bool = { _ in false }
    var onClipboardPasteSessionBegan: (() -> Void)?
    var onClipboardPasteSessionEnded: (() -> Void)?
    @Published private(set) var section: Section = .home
    @Published var taskDraft = ""
    @Published private(set) var presentation = NativeQuickPresentation()
    @Published private(set) var geometry = NativeQuickGeometry.resolve(screen: CGRect(x: 0, y: 0, width: 1440, height: 900), visible: CGRect(x: 0, y: 0, width: 1440, height: 876), safeTop: 0, placement: .island)
    private var motionTask: Task<Void, Never>?
    var keepRunning: Bool { mode != .off }

    private static let modeKey = "ai-bro-native-quick-entry-mode"
    private let preferences: UserDefaults
    private var configured = false
    private var onAction: ((NativeQuickAction) -> Void)?
    private var onQuit: (() -> Void)?
    private var panel: NativeQuickEntryPanel?
    private var screenAnchorID: UInt32?
    private var statusItem: NSStatusItem?
    private var previousApp: NSRunningApplication?
    private weak var previousKeyWindow: NSWindow?
    private var localMouseMonitor: Any?
    private var globalMouseMonitor: Any?
    private var entryLocalMonitor: Any?
    private var entryGlobalMonitor: Any?
    private var entryHoverTask: Task<Void, Never>?
    private var pointerWasInsideEntry = false
    private var observers: [NSObjectProtocol] = []
    private var workspaceObservers: [NSObjectProtocol] = []
    private var languageSubscription: AnyCancellable?
    private var panelPreferenceSubscription: AnyCancellable?
    private var shortcutSubscription: AnyCancellable?

    init(preferences: UserDefaults = .standard) {
        self.preferences = preferences
        self.panelPreferences = NativeQuickPanelPreferences(defaults: preferences)
        self.shortcutStore = NativeQuickShortcutStore(preferences: preferences)
        self.mode = preferences.string(forKey: Self.modeKey).flatMap(Mode.init(rawValue:)) ?? .off
        super.init()
        shortcutStore.onInvoke = { [weak self] in self?.togglePanel() }
        shortcutSubscription = shortcutStore.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
        panelPreferenceSubscription = panelPreferences.$configuration.dropFirst().receive(on: RunLoop.main).sink { [weak self] _ in
            MainActor.assumeIsolated { self?.reconcilePanelPreferences() }
        }
    }

    var availableSections: Set<Section> {
        var result = Set([Section.home, .tasks, .capture, .runs, .settings]).union(extensionModules.keys)
        if voiceContent != nil { result.insert(.voice) }
        return result
    }
    var visibleSections: [Section] {
        let visible = panelPreferences.visibleSections(available: availableSections)
        // An explicitly summoned hidden page still needs a selected tab; the
        // user's saved visibility preference is unchanged after leaving it.
        return Section.allCases.filter { visible.contains($0) || ($0 == .voice && section == .voice && voiceContent != nil) }
    }
    var usesTopIslandPresentation: Bool { mode == .island || presentation.temporaryTopEntry }
    var homeModules: [NativeQuickHomeModule] {
        let builtins = [NativeQuickHomeModule(id: "tasks", title: Section.tasks.title, symbol: Section.tasks.symbol),
            NativeQuickHomeModule(id: "note", title: Section.capture.title, symbol: Section.capture.symbol),
            NativeQuickHomeModule(id: "runs", title: Section.runs.title, symbol: Section.runs.symbol)]
        return builtins + extensionHomeModules.values.sorted { $0.id < $1.id }
    }
    func registerModule(_ section: Section, content: @escaping () -> AnyView, onVisibilityChange: ((Bool) -> Void)? = nil) {
        guard ![Section.home, .tasks, .capture, .voice, .runs, .settings].contains(section) else { return }
        extensionModules[section] = .init(content: content, onVisibilityChange: onVisibilityChange)
        reconcilePanelPreferences()
    }
    func registerSettingsSection(id: String, content: @escaping () -> AnyView) {
        let section = NativeQuickSettingsSection(id: id, content: content)
        if let index = settingsSections.firstIndex(where: { $0.id == id }) { settingsSections[index] = section }
        else { settingsSections.append(section) }
    }
    func configureVoice(content: @escaping () -> AnyView, onEscape: @escaping () -> Void,
                        onHide: @escaping () -> Void) {
        voiceContent = content; voiceOnEscape = onEscape; voiceOnHide = onHide
    }
    func updateVoiceStatus(_ status: NativeQuickVoiceStatus?) {
        guard voiceStatus != status else { return }
        voiceStatus = status
        if status == nil, voicePresented { dismissVoice(returnFocus: false) }
        updateStatusItem()
    }
    @discardableResult func showVoice(screenIntent: NativeQuickScreenSelection.Intent = .pointerSummon) -> Bool {
        guard configured, voiceContent != nil else { return false }
        if !voicePresented, let editor = panel?.firstResponder as? NSTextView, editor.hasMarkedText() { return false }
        panel?.makeFirstResponder(nil)
        if mode != .island, !presentation.temporaryTopEntry {
            presentation.setTemporaryTopEntry(true)
            if presentation.wantsExpanded { repositionWindows() }
        }
        select(.voice)
        openPanel(screenIntent: screenIntent)
        return isShowing(.voice)
    }
    func dismissVoice(returnFocus: Bool = true) {
        guard voicePresented else { return }
        dismiss(returnFocus: returnFocus)
    }
    func showWorkspaceFromVoice() {
        guard section == .voice else { return }
        select(availableSections.contains(sectionBeforeVoice) ? sectionBeforeVoice : .home)
    }
    func registerHomeModule(id: String, title: String, symbol: String, content: @escaping () -> AnyView,
                            onVisibilityChange: ((Bool) -> Void)? = nil, onActivityChange: ((Bool) -> Void)? = nil, canHide: (() -> Bool)? = nil) {
        guard !["tasks", "note", "runs"].contains(id) else { return }
        extensionHomeModules[id] = .init(id: id, title: title, symbol: symbol, content: content,
            onVisibilityChange: onVisibilityChange, onActivityChange: onActivityChange, canHide: canHide)
    }
    private func reconcilePanelPreferences() {
        if !visibleSections.contains(section) { select(.home) }
    }
    func setHomeModule(_ id: String, visible: Bool) {
        if !visible, extensionHomeModules[id]?.canHide?() == false { panelPreferences.reportCannotHide(); return }
        _ = panelPreferences.setHomeModule(id, visible: visible, available: homeModules.map(\.id))
    }

    func configure(onAction: @escaping (NativeQuickAction) -> Void, onQuit: @escaping () -> Void) {
        self.onAction = onAction
        self.onQuit = onQuit
        guard !configured else { return }
        configured = true
        observers.append(NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.repositionWindows() }
        })
        workspaceObservers.append(NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.dismiss(returnFocus: false)
                self?.repositionWindows()
            }
        })
        workspaceObservers.append(NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.repositionWindows() }
        })
        languageSubscription = NativeL10n.shared.$language.receive(on: RunLoop.main).sink { [weak self] _ in
            MainActor.assumeIsolated { self?.updateStatusItem() }
        }
        reconcileEntry()
    }

    func update(busy: Bool, unread: Int, ready: Bool) {
        let count = max(0, unread)
        guard self.busy != busy || self.unread != count || self.ready != ready else { return }
        if self.busy != busy { self.busy = busy }
        if self.unread != count { self.unread = count }
        if self.ready != ready { self.ready = ready }
        updateStatusItem()
    }

    func configureCapture(directory: URL, save: @escaping (NativeQuickCapturePayload) async throws -> String) {
        capture.configure(directory: directory, save: save)
    }

    func flushCaptureDraft() -> Bool {
        let creationSaved = capture.flushForQuit()
        let editSaved = captureLibrary.flushForQuit()
        if !editSaved { captureLibraryVisible = true }
        return creationSaved && editSaved
    }

    func focusCaptureInput() {
        guard !navigationOwnsFocus, section != .voice else { return }
        captureFocusRequest += 1
    }

    func navigationFocusChanged(_ ownsFocus: Bool) { navigationOwnsFocus = ownsFocus }

    func selectCaptureLibrary(_ visible: Bool) {
        panel?.makeFirstResponder(nil)
        _ = capture.flushDraft(); _ = captureLibrary.flushDraft()
        captureLibraryVisible = visible
    }

    func togglePanel() {
        if presentation.wantsExpanded { dismiss() } else { showPanel(screenIntent: .pointerSummon) }
    }

    /// A toast is click-through while entering or leaving. Its occupied region
    /// must also protect this local Button route, not only the hover monitor.
    /// Explicit shortcuts and workspace actions retain their own open paths.
    func openCollapsedEntry() {
        guard presentation.phase == .collapsed,
              notificationOccupiedRegion?.intersects(geometry.collapsed) != true else { return }
        showPanel()
    }

    func showCapture() {
        showPanel(section: .capture)
    }

    func showPanel(section requestedSection: Section? = nil, screenIntent: NativeQuickScreenSelection.Intent = .anchored) {
        guard configured else { return }
        if requestedSection == nil, voiceStatus != nil, voiceContent != nil {
            _ = showVoice(screenIntent: screenIntent); return
        }
        if let requestedSection, availableSections.contains(requestedSection) {
            select(requestedSection)
        } else if !presentation.wantsExpanded {
            select(panelPreferences.defaultSection(available: availableSections))
        }
        openPanel(screenIntent: screenIntent)
    }

    private func openPanel(screenIntent: NativeQuickScreenSelection.Intent) {
        if presentation.wantsExpanded {
            panel?.makeKeyAndOrderFront(nil)
            return
        }
        guard let targetScreen = screenForEntry(intent: screenIntent) else { return }
        let frontmost = NSWorkspace.shared.frontmostApplication
        if !voicePresented { onClipboardPasteSessionBegan?() }
        previousApp = frontmost?.processIdentifier == ProcessInfo.processInfo.processIdentifier ? nil : frontmost
        if let keyWindow = NSApp.keyWindow, keyWindow !== panel {
            previousKeyWindow = keyWindow
        } else { previousKeyWindow = nil }
        updateGeometry(on: targetScreen)
        ensurePanel()
        panel?.level = usesTopIslandPresentation ? NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1) : .floating
        // The AppKit window changes only at transition boundaries. SwiftUI
        // performs the visible shape animation inside this transparent canvas.
        panel?.setFrame(geometry.expanded, display: false)
        panel?.ignoresMouseEvents = false
        panel?.allowsKey = true
        panel?.makeKeyAndOrderFront(nil)
        if showingCapture && !voicePresented { NSApp.activate(ignoringOtherApps: true) }
        installOutsideClickMonitors()
        transition(expanded: true)
    }

    /// Opens the existing module detail without changing the user's home layout.
    /// The mounted HomeView confirms visibility, not merely the request setter.
    func showHomeModule(_ id: String) async -> Bool {
        guard configured, ready, homeModules.contains(where: { $0.id == id && $0.content != nil }),
              homeModuleAcknowledgement == nil else { return false }
        return await withCheckedContinuation { continuation in
            homeModuleAcknowledgement = continuation
            let request = HomeModuleRequest(id: id, token: UUID())
            showPanel(section: .home)
            homeModuleRequest = request
            homeModuleTimeout = Task { @MainActor [weak self] in
                do { try await Task.sleep(nanoseconds: 2_500_000_000) } catch { return }
                guard let self, self.homeModuleRequest == request else { return }
                self.finishHomeModuleNavigation(false)
            }
        }
    }
    func acknowledgeHomeModule(_ request: HomeModuleRequest) {
        guard homeModuleRequest == request, isShowing(.home), presentation.contentVisible else { return }
        finishHomeModuleNavigation(true)
    }
    private func finishHomeModuleNavigation(_ success: Bool) {
        homeModuleTimeout?.cancel(); homeModuleTimeout = nil
        let callback = homeModuleAcknowledgement; homeModuleAcknowledgement = nil
        homeModuleRequest = nil; callback?.resume(returning: success)
    }
    var notificationScreen: NSScreen? {
        guard !NSScreen.screens.isEmpty else { return nil }
        return screenForEntry()
    }
    var notificationProtectedFrame: CGRect? {
        guard presentation.phase != .collapsed, panel?.isVisible == true else { return nil }
        return panel?.frame
    }
    func setNotificationOccupiedRegion(_ region: CGRect?) {
        guard notificationOccupiedRegion != region else { return }
        notificationOccupiedRegion = region
        entryHoverTask?.cancel(); entryHoverTask = nil
        // After a toast leaves under the pointer, require exit/re-entry rather
        // than unexpectedly expanding the main island in its place.
        pointerWasInsideEntry = geometry.collapsed.contains(NSEvent.mouseLocation)
    }
    func isShowing(_ section: Section) -> Bool {
        presentation.wantsExpanded && self.section == section && panel?.isVisible == true
    }

    func escape() {
        if voicePresented {
            dismissContent(returnFocus: true, notifyVoice: false)
            voiceOnEscape?()
            return
        }
        if section == .tasks && workbench.endTaskSelection() { return }
        dismiss()
    }

    func dismiss(returnFocus: Bool = true) {
        dismissContent(returnFocus: returnFocus, notifyVoice: true)
    }
    private func dismissContent(returnFocus: Bool, notifyVoice: Bool) {
        let wasVoice = voicePresented
        voicePresented = false
        onClipboardPasteSessionEnded?()
        finishHomeModuleNavigation(false)
        panel?.makeFirstResponder(nil)
        if !wasVoice { _ = capture.flushDraft(); _ = captureLibrary.flushDraft(); _ = links.flushDraft() }
        let wasExpanded = presentation.wantsExpanded
        // Closing content is inert. Forward clicks to the user's current app
        // until the window has returned to its compact footprint.
        if wasExpanded { panel?.ignoresMouseEvents = true }
        transition(expanded: false)
        removeOutsideClickMonitors()
        let app = previousApp
        let window = previousKeyWindow
        previousApp = nil
        previousKeyWindow = nil
        if wasVoice && notifyVoice { voiceOnHide?() }
        guard returnFocus, wasExpanded else { return }
        let frontmostID = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let ownID = ProcessInfo.processInfo.processIdentifier
        if let app, !app.isTerminated {
            // A subsequent switch to a third app owns focus. Esc must not
            // reactivate an application the user has already left behind.
            if frontmostID == ownID || frontmostID == app.processIdentifier { app.activate(options: []) }
        } else if frontmostID == ownID, let window, window !== panel,
                  window.isVisible, !window.isMiniaturized, window.canBecomeKey {
            // Closing a nonactivating panel does not reliably restore the
            // workspace's key window, even though its responder is retained.
            window.makeKey()
        }
    }

    var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    /// Paste-back waits for the same closing transition, never a later reopening.
    func collapseForClipboardPaste() async -> Bool {
        guard isShowing(.clipboard) else { return false }
        dismiss(returnFocus: false)
        let generation = presentation.generation
        for _ in 0..<35 {
            guard !Task.isCancelled, presentation.generation == generation,
                  !presentation.wantsExpanded else { return false }
            if presentation.phase == .collapsed { return true }
            do { try await Task.sleep(nanoseconds: 20_000_000) } catch { return false }
        }
        return false
    }

    private func transition(expanded: Bool) {
        guard presentation.wantsExpanded != expanded else { return }
        motionTask?.cancel(); motionTask = nil
        let reduced = reduceMotion
        let token = presentation.generation &+ 1
        let contentAnimation: Animation? = reduced ? nil : .easeOut(duration:
            expanded ? 0.14 : NativeQuickPresentation.contentExitDuration)
        withAnimation(contentAnimation, completionCriteria: .removed) {
            _ = presentation.request(expanded: expanded, reducedMotion: reduced)
        } completion: { [weak self] in
            // Fade the body before shrinking the shell. A rapid reversal
            // invalidates this callback before it can touch the new opening.
            guard !expanded, !reduced else { return }
            self?.animateShell(token)
        }
        if reduced { finishTransition(token); return }
        if expanded {
            // Commit the collapsed shape on the larger transparent canvas
            // before asking SwiftUI to expand it. This is a drawing boundary,
            // not a guessed 16ms delay; it also avoids continuously resizing
            // the AppKit window during the animation.
            panel?.contentView?.layoutSubtreeIfNeeded()
            panel?.displayIfNeeded()
            CATransaction.flush()
            DispatchQueue.main.async { [weak self] in self?.animateShell(token) }
        }
        guard presentation.phase == .opening || presentation.phase == .closing else { return }
        motionTask = Task { @MainActor [weak self] in
            do {
                if expanded {
                    try await Task.sleep(nanoseconds: UInt64(NativeQuickPresentation.contentDelay * 1_000_000_000))
                    guard !Task.isCancelled, let self, self.presentation.generation == token else { return }
                    withAnimation(.easeOut(duration: 0.14)) { _ = self.presentation.revealContent(token) }
                    if self.showingCapture { self.focusCaptureInput() }
                }
                // Completion owns normal settlement. This bounded watchdog
                // only recovers an invisible/interrupted host with no receipt.
                try await Task.sleep(nanoseconds: UInt64(NativeQuickPresentation.completionWatchdog * 1_000_000_000))
                guard !Task.isCancelled else { return }
                self?.finishTransition(token)
            } catch { return }
        }
    }

    private func animateShell(_ token: UInt64) {
        guard presentation.generation == token,
              presentation.phase == .opening || presentation.phase == .closing else { return }
        let animation: Animation = presentation.wantsExpanded
            ? .timingCurve(0.22, 0.72, 0.18, 1, duration: NativeQuickPresentation.openingDuration)
            : .timingCurve(0.32, 0, 0.36, 1, duration: NativeQuickPresentation.closingDuration)
        withAnimation(animation, completionCriteria: .removed) {
            _ = presentation.animateShell(token)
        } completion: { [weak self] in
            self?.finishTransition(token)
        }
    }

    private func finishTransition(_ token: UInt64) {
        guard presentation.settle(token) else { return }
        motionTask?.cancel(); motionTask = nil
        if presentation.wantsExpanded {
            panel?.setFrame(geometry.expanded, display: true)
            if showingCapture { focusCaptureInput() }
        } else {
            if presentation.temporaryTopEntry {
                presentation.setTemporaryTopEntry(false)
                if let screen = screenForEntry() { updateGeometry(on: screen) }
                panel?.level = mode == .island ? NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1) : .floating
            }
            panel?.allowsKey = false
            panel?.ignoresMouseEvents = false
            if mode == .island || mode == .edge {
                panel?.setFrame(geometry.collapsed, display: true)
                panel?.orderFrontRegardless()
            } else { panel?.orderOut(nil) }
        }
    }

    private func ensurePanel() {
        guard panel == nil else { return }
        let window = NativeQuickEntryPanel(contentRect: geometry.collapsed,
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.isOpaque = false; window.backgroundColor = .clear
        window.hasShadow = false
        window.level = usesTopIslandPresentation ? NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1) : .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        window.hidesOnDeactivate = false; window.canHide = false
        window.isMovableByWindowBackground = false
        window.title = nativeUI("AI Bro 快捷工作台", "AI Bro quick workspace")
        window.setAccessibilityLabel(nativeUI("AI Bro 快捷工作台", "AI Bro quick workspace"))
        window.cancel = { [weak self] in self?.escape() }
        let hosting = NSHostingView(rootView: NativeQuickEntryView(coordinator: self))
        // GeometryReader consumes the canvas size; it must not publish an
        // intrinsic/minimum/maximum size back into this explicitly sized panel.
        hosting.sizingOptions = []
        hosting.frame = NSRect(origin: .zero, size: window.contentLayoutRect.size)
        hosting.autoresizingMask = [.width, .height]
        window.contentView = hosting
        panel = window
    }

    func select(_ section: Section, focusContent: Bool = true) {
        guard availableSections.contains(section) else { return }
        if section == .voice, self.section != .voice,
           let editor = panel?.firstResponder as? NSTextView, editor.hasMarkedText() { return }
        let leavingVoice = voicePresented && section != .voice
        if section == .voice, self.section != .voice {
            sectionBeforeVoice = self.section
            panel?.makeFirstResponder(nil)
        }
        voicePresented = section == .voice
        navigationOwnsFocus = !focusContent
        if self.section == .links && section != .links {
            if focusContent { panel?.makeFirstResponder(nil) }; _ = links.flushDraft()
        }
        if self.section == .capture && section != .capture {
            if focusContent { panel?.makeFirstResponder(nil) }; _ = capture.flushDraft(); _ = captureLibrary.flushDraft()
        }
        self.section = section; showingCapture = section == .capture
        // Selecting a different ordinary tab releases voice ownership before
        // cancellation calls back into dismissVoice; it must not close that tab.
        if leavingVoice { voiceOnHide?() }
        if showingCapture && presentation.contentVisible && focusContent {
            NSApp.activate(ignoringOtherApps: true)
            panel?.makeKeyAndOrderFront(nil); focusCaptureInput()
        }
    }

    func activateInput() {
        guard section != .voice else { return }
        navigationOwnsFocus = false
        NSApp.activate(ignoringOtherApps: true)
        panel?.makeKeyAndOrderFront(nil)
    }

    func revealFileShelfForDrop() {
        guard canReceiveFiles(), availableSections.contains(.shelf) else { return }
        showPanel(section: .shelf)
    }

    func stop() {
        finishHomeModuleNavigation(false)
        notificationOccupiedRegion = nil
        _ = capture.flushDraft(); _ = captureLibrary.flushDraft(); _ = links.flushDraft()
        dismiss(returnFocus: false)
        configured = false
        motionTask?.cancel(); motionTask = nil; presentation.reset()
        removeEntryWindows()
        unregisterHotkey()
        observers.forEach(NotificationCenter.default.removeObserver)
        observers.removeAll()
        workspaceObservers.forEach(NSWorkspace.shared.notificationCenter.removeObserver)
        workspaceObservers.removeAll()
        languageSubscription?.cancel()
        languageSubscription = nil
        panel?.close()
        panel = nil
        onAction = nil
        onQuit = nil
        voiceContent = nil; voiceStatus = nil; voicePresented = false
        voiceOnHide = nil; voiceOnEscape = nil
    }

    fileprivate func perform(_ action: NativeQuickAction) {
        guard ready || action == .resume || action == .settings else { return }
        if action == .quickNotes {
            // Text entry owns keyboard focus deliberately. The launcher can be
            // nonactivating; an editor must not leave typing in the prior app.
            NSApp.activate(ignoringOtherApps: true)
            panel?.makeKeyAndOrderFront(nil)
            select(.capture)
            return
        }
        dismiss(returnFocus: false)
        onAction?(action)
    }

    fileprivate func showLauncher() {
        panel?.makeFirstResponder(nil)
        _ = capture.flushDraft(); _ = captureLibrary.flushDraft()
        select(.tasks)
    }

    fileprivate func openAllCaptures() {
        guard ready else { return }
        dismiss(returnFocus: false)
        onAction?(.quickNotes)
    }

    fileprivate func quit() {
        dismiss(returnFocus: false)
        onQuit?()
    }

    fileprivate var statusDescription: String {
        if let voiceStatus { return voiceStatus.title }
        if busy { return nativeUI("正在执行", "Working") }
        if unread > 0 { return nativeUI("\(unread) 项新变化", "\(unread) new updates") }
        return ready ? nativeUI("准备就绪", "Ready") : nativeUI("正在准备工作区", "Preparing workspace")
    }

    @objc private func statusItemPressed(_ sender: Any?) { togglePanel() }

    private func reconcileEntry() {
        presentation.setTemporaryTopEntry(false)
        if mode == .off {
            dismiss(returnFocus: false)
            motionTask?.cancel(); motionTask = nil; presentation.reset()
            // Cancelling the closing callback must not leave its click-through
            // policy on the reusable panel when the entry is enabled again.
            panel?.allowsKey = false
            panel?.ignoresMouseEvents = false
            panel?.orderOut(nil)
            removeEntryWindows(); unregisterHotkey()
            return
        }
        if statusItem == nil {
            let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
            item.button?.target = self; item.button?.action = #selector(statusItemPressed(_:))
            item.button?.sendAction(on: [.leftMouseUp]); statusItem = item
        }
        updateStatusItem(); registerHotkeyIfNeeded()
        configureEntryPointerMonitor()
        guard let screen = screenForEntry() else { return }
        updateGeometry(on: screen); ensurePanel()
        panel?.level = mode == .island ? NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1) : .floating
        repositionWindows()
    }

    private func removeEntryWindows() {
        removeEntryPointerMonitor()
        if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }
        statusItem = nil
    }

    private func updateStatusItem() {
        guard let button = statusItem?.button else { return }
        let symbol = voiceStatus?.symbol ?? (busy ? "circle.dotted.circle" : unread > 0 ? "bubble.left.and.bubble.right.fill" : "bubble.left.and.bubble.right")
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "AI Bro")
        image?.isTemplate = true
        button.image = image
        button.imagePosition = .imageLeading
        button.title = unread > 0 ? " \(min(unread, 99))\(unread > 99 ? "+" : "")" : ""
        button.toolTip = "AI Bro · \(statusDescription) · \(shortcutStore.shortcut.label)"
        button.setAccessibilityLabel(nativeUI("打开 AI Bro 快捷入口", "Open AI Bro quick entry"))
        button.setAccessibilityValue(statusDescription)
    }

    private func screenID(_ screen: NSScreen) -> UInt32? {
        (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value
    }

    private func screenForEntry(intent: NativeQuickScreenSelection.Intent = .anchored) -> NSScreen? {
        let screens = NSScreen.screens
        let displays = screens.compactMap { screen -> NativeQuickScreenSelection.Display? in
            guard let id = screenID(screen) else { return nil }
            return .init(id: id, frame: screen.frame)
        }
        guard let selected = NativeQuickScreenSelection.select(displays: displays, intent: intent,
            pointer: NSEvent.mouseLocation, anchorID: screenAnchorID,
            panelFrame: panel?.isVisible == true ? panel?.frame : nil,
            mainID: NSScreen.main.flatMap { screenID($0) },
            isExpandedOrTransitioning: presentation.phase != .collapsed) else { return nil }
        return screens.first { screenID($0) == selected }
    }

    private func resolvedGeometry(on screen: NSScreen) -> NativeQuickGeometry {
        let placement: NativeQuickGeometry.Placement = usesTopIslandPresentation ? .island : mode == .edge ? .edge : .menu
        let menuAnchor: CGRect? = statusItem?.button?.window.flatMap { window in
            guard let menuScreen = window.screen, let menuID = screenID(menuScreen),
                  menuID == screenID(screen) else { return nil }
            return window.frame
        }
        return NativeQuickGeometry.resolve(screen: screen.frame, visible: screen.visibleFrame, safeTop: screen.safeAreaInsets.top,
            leftArea: screen.auxiliaryTopLeftArea, rightArea: screen.auxiliaryTopRightArea,
            placement: placement, menuAnchor: menuAnchor)
    }
    private func updateGeometry(on screen: NSScreen) {
        let next = resolvedGeometry(on: screen)
        geometry = next
        screenAnchorID = screenID(screen)
    }

    private func repositionWindows() {
        guard configured, let screen = screenForEntry() else { return }
        updateGeometry(on: screen)
        if reduceMotion, presentation.phase == .opening || presentation.phase == .closing {
            motionTask?.cancel(); motionTask = nil
            presentation.settleImmediately()
            if !presentation.wantsExpanded {
                presentation.setTemporaryTopEntry(false)
                updateGeometry(on: screen)
            }
            panel?.ignoresMouseEvents = false
            panel?.allowsKey = presentation.wantsExpanded
        }
        guard let panel else { return }
        panel.level = usesTopIslandPresentation ? NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1) : .floating
        let expanded = presentation.phase != .collapsed
        panel.setFrame(expanded ? geometry.expanded : geometry.collapsed, display: true)
        if expanded || mode == .edge || mode == .island { panel.orderFrontRegardless() }
        else { panel.orderOut(nil) }
    }

    private func configureEntryPointerMonitor() {
        removeEntryPointerMonitor()
        guard mode == .island else { return }
        // The system menu bar may own events over the hardware notch. Observe
        // mouse events (not keys) and use the same physical entry geometry.
        entryGlobalMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved, .leftMouseDown]) { [weak self] event in
            MainActor.assumeIsolated { self?.entryPointerChanged(clicked: event.type == .leftMouseDown) }
        }
        entryLocalMonitor = NSEvent.addLocalMonitorForEvents(matching: [.mouseMoved]) { [weak self] event in
            MainActor.assumeIsolated { self?.entryPointerChanged(clicked: false) }
            return event
        }
    }

    private func entryPointerChanged(clicked: Bool) {
        let inside = geometry.collapsed.contains(NSEvent.mouseLocation)
        if notificationOccupiedRegion?.contains(NSEvent.mouseLocation) == true {
            entryHoverTask?.cancel(); entryHoverTask = nil; pointerWasInsideEntry = inside; return
        }
        defer { pointerWasInsideEntry = inside }
        guard mode == .island, !presentation.wantsExpanded else { return }
        if !inside { entryHoverTask?.cancel(); entryHoverTask = nil; return }
        if clicked { entryHoverTask?.cancel(); entryHoverTask = nil; showPanel(); return }
        guard !pointerWasInsideEntry, entryHoverTask == nil, presentation.phase == .collapsed else { return }
        entryHoverTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(nanoseconds: 180_000_000) } catch { return }
            guard !Task.isCancelled, let self else { return }
            self.entryHoverTask = nil
            guard self.mode == .island, self.presentation.phase == .collapsed,
                  self.notificationOccupiedRegion?.contains(NSEvent.mouseLocation) != true,
                  self.geometry.collapsed.contains(NSEvent.mouseLocation) else { return }
            self.showPanel()
        }
    }

    private func removeEntryPointerMonitor() {
        entryHoverTask?.cancel(); entryHoverTask = nil
        if let entryLocalMonitor { NSEvent.removeMonitor(entryLocalMonitor) }
        if let entryGlobalMonitor { NSEvent.removeMonitor(entryGlobalMonitor) }
        entryLocalMonitor = nil; entryGlobalMonitor = nil; pointerWasInsideEntry = false
    }

    private func installOutsideClickMonitors() {
        removeOutsideClickMonitors()
        localMouseMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] event in
            MainActor.assumeIsolated {
                guard let self else { return }
                // Event ownership is authoritative for local clicks. The
                // global pointer may lag synthesized/accessibility input.
                if let window = event.window,
                   window === self.panel || window === self.statusItem?.button?.window { return }
                self.dismissIfOutside()
            }
            return event
        }
        // Mouse-only global monitoring does not request Accessibility/Input
        // Monitoring permission. The Carbon hotkey handles keys independently.
        globalMouseMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] _ in
            MainActor.assumeIsolated { self?.dismissIfOutside() }
        }
    }

    private func dismissIfOutside() {
        guard let panel, presentation.wantsExpanded, panel.isVisible else { return }
        // File pickers and previews belong to the panel until dismissed. Their
        // controls may extend beyond its footprint; they are not outside work.
        guard panel.attachedSheet == nil else { return }
        let pointer = NSEvent.mouseLocation
        if panel.frame.contains(pointer) || statusItem?.button?.window?.frame.contains(pointer) == true { return }
        // The clicked application now owns focus. Do not reactivate an older one.
        dismiss(returnFocus: false)
    }

    private func removeOutsideClickMonitors() {
        if let localMouseMonitor { NSEvent.removeMonitor(localMouseMonitor) }
        if let globalMouseMonitor { NSEvent.removeMonitor(globalMouseMonitor) }
        localMouseMonitor = nil
        globalMouseMonitor = nil
    }

    private func registerHotkeyIfNeeded() { shortcutStore.setActive(true) }
    private func unregisterHotkey() { shortcutStore.setActive(false) }

}

private final class NativeQuickEntryPanel: NSPanel {
    var cancel: (() -> Void)?
    var allowsKey = false
    override var canBecomeKey: Bool { allowsKey }
    override var canBecomeMain: Bool { false }
    override func cancelOperation(_ sender: Any?) { cancel?() }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == UInt16(kVK_Escape) { cancel?() } else { super.keyDown(with: event) }
    }
}

private struct NativeQuickEntryView: View {
    @ObservedObject var coordinator: NativeQuickEntryCoordinator
    @ObservedObject private var preferences: NativeQuickPanelPreferences
    @ObservedObject private var language = NativeL10n.shared
    @Environment(\.colorScheme) private var systemColorScheme
    private var island: Bool { coordinator.usesTopIslandPresentation }
    private var alignment: Alignment { coordinator.geometry.placement == .edge ? .trailing : .top }
    private var shellWidth: CGFloat { coordinator.presentation.shellExpanded ? coordinator.geometry.expanded.width : coordinator.geometry.collapsed.width }
    private var shellHeight: CGFloat { coordinator.presentation.shellExpanded ? coordinator.geometry.expanded.height : coordinator.geometry.collapsed.height }
    init(coordinator: NativeQuickEntryCoordinator) {
        self.coordinator = coordinator; self.preferences = coordinator.panelPreferences
    }

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: alignment) {
                shell.fill(island ? Color.black : Color(nsColor: .windowBackgroundColor))
                    .overlay(shell.strokeBorder(Color.primary.opacity(island ? 0.13 : 0.1), lineWidth: 0.5))
                    .frame(width: shellWidth, height: shellHeight)
                expandedContent
                    .frame(width: coordinator.geometry.expanded.width, height: coordinator.geometry.expanded.height)
                    .opacity(coordinator.presentation.visualContentVisible ? 1 : 0)
                    .disabled(!coordinator.presentation.contentVisible)
                    .allowsHitTesting(coordinator.presentation.contentVisible)
                    .accessibilityElement(children: coordinator.presentation.contentVisible ? .contain : .ignore)
                    .accessibilityHidden(!coordinator.presentation.contentVisible)
                collapsedContent
                    .frame(width: coordinator.geometry.collapsed.width, height: coordinator.geometry.collapsed.height)
                    .opacity(coordinator.presentation.shellExpanded ? 0 : 1)
                    .allowsHitTesting(coordinator.presentation.phase == .collapsed)
                    .accessibilityHidden(coordinator.presentation.phase != .collapsed)
            }
            .frame(width: coordinator.geometry.expanded.width, height: coordinator.geometry.expanded.height, alignment: alignment)
            .mask(shell.frame(width: shellWidth, height: shellHeight)
                .frame(width: coordinator.geometry.expanded.width, height: coordinator.geometry.expanded.height, alignment: alignment))
            .frame(width: proxy.size.width, height: proxy.size.height, alignment: alignment)
        }
        .environment(\.colorScheme, island ? .dark : systemColorScheme)
        .transaction { if coordinator.reduceMotion { $0.disablesAnimations = true } }
        .tint(island ? Color(red: 0.66, green: 0.85, blue: 0.72) : Color(red: 0.17, green: 0.45, blue: 0.37))
        .onExitCommand { coordinator.escape() }
        .onDrop(of: [UTType.fileURL.identifier], delegate: NativeQuickShelfDropDelegate(coordinator: coordinator))
    }

    private var shell: UnevenRoundedRectangle {
        let radius: CGFloat = coordinator.presentation.shellExpanded ? 24 : 12
        return UnevenRoundedRectangle(topLeadingRadius: island ? 0 : radius,
            bottomLeadingRadius: radius, bottomTrailingRadius: radius, topTrailingRadius: island ? 0 : radius, style: .continuous)
    }

    private var collapsedContent: some View {
        Button { coordinator.openCollapsedEntry() } label: {
            HStack(spacing: 8) {
                Image(systemName: coordinator.voiceStatus?.symbol ?? "square.stack.3d.up").font(.system(size: 12, weight: .medium))
                if coordinator.geometry.hardwareWidth > 0 {
                    Spacer(minLength: coordinator.geometry.hardwareWidth)
                } else { Text(coordinator.voiceStatus?.title ?? "AI Bro").font(.system(size: 11, weight: .semibold)).lineLimit(1) }
                if coordinator.voiceStatus?.isProcessing ?? coordinator.busy {
                    ProgressView().controlSize(.mini).frame(width: 12, height: 12)
                } else {
                    Circle().fill(coordinator.unread > 0 ? Color.accentColor : Color.primary.opacity(0.38)).frame(width: 5, height: 5)
                }
            }.padding(.horizontal, 12).frame(maxWidth: .infinity, maxHeight: .infinity)
                .contentShape(Rectangle())
        }.buttonStyle(.plain)
            .accessibilityLabel(coordinator.voiceStatus == nil ? nativeUI("展开 AI Bro 工作台", "Expand AI Bro workspace") : nativeUI("查看语音指令", "View voice command"))
            .accessibilityValue(coordinator.statusDescription)
            .help("AI Bro · \(coordinator.statusDescription) · \(coordinator.shortcutStore.shortcut.label)")
    }

    private var expandedContent: some View {
        VStack(spacing: 0) {
            if island { Color.clear.frame(height: coordinator.geometry.safeTop + 6).accessibilityHidden(true) }
            HStack(spacing: 10) {
                Button { coordinator.select(.home) } label: { Text("AI Bro").font(.system(size: 15, weight: .semibold)).foregroundStyle(.primary) }
                    .accessibilityLabel(nativeUI("AI Bro 首页", "AI Bro home"))
                if coordinator.busy { Circle().fill(Color.accentColor).frame(width: 5, height: 5).accessibilityLabel(nativeUI("有任务正在执行", "A task is running")) }
                Spacer()
                Button { coordinator.perform(.resume) } label: { Image(systemName: "arrow.up.right.square").frame(width: 26, height: 26) }
                    .help(nativeUI("打开完整工作区", "Open full workspace"))
                    .accessibilityLabel(nativeUI("打开完整工作区", "Open full workspace"))
                Button { coordinator.select(.settings) } label: { Image(systemName: "slider.horizontal.3").frame(width: 26, height: 26) }
                    .help(nativeUI("工作台设置", "Panel settings")).accessibilityLabel(nativeUI("工作台设置", "Panel settings"))
                Menu {
                    Button(nativeUI("新对话", "New chat")) { coordinator.perform(.newChat) }.disabled(!coordinator.ready)
                    Button(nativeUI("搜索工作区", "Search workspace")) { coordinator.perform(.search) }.disabled(!coordinator.ready)
                    Button(nativeUI("查看日程", "Open agenda")) { coordinator.perform(.agenda) }.disabled(!coordinator.ready)
                    Button(nativeUI("打开任务收件箱", "Open task inbox")) {
                        if let directory = coordinator.workbench.taskInbox.ensureDirectory() {
                            NSWorkspace.shared.open(directory)
                        }
                    }.disabled(!coordinator.ready)
                    Divider()
                    Picker(nativeUI("入口位置", "Entry location"), selection: $coordinator.mode) {
                        ForEach(NativeQuickEntryCoordinator.Mode.allCases) { mode in Text(mode.title).tag(mode) }
                    }
                    Button(nativeUI("工作区设置…", "Workspace settings…")) { coordinator.perform(.settings) }
                    Divider()
                    Button(nativeUI("退出 AI Bro", "Quit AI Bro")) { coordinator.quit() }
                } label: { Image(systemName: "ellipsis").frame(width: 24, height: 26) }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                    .accessibilityLabel(nativeUI("工作台选项", "Workspace options"))
                Button { coordinator.dismiss() } label: { Image(systemName: "chevron.up").font(.system(size: 11, weight: .semibold)).frame(width: 26, height: 26) }
                    .help(nativeUI("收起 · Esc", "Collapse · Esc"))
                    .accessibilityLabel(nativeUI("收起工作台", "Collapse workspace"))
            }.buttonStyle(.plain).foregroundStyle(.secondary).padding(.horizontal, 18).padding(.top, island ? 4 : 15).padding(.bottom, 13)
            NativeQuickNavigation(sections: coordinator.visibleSections.filter { $0 != .settings },
                                  selected: coordinator.section, visible: coordinator.presentation.contentVisible,
                                  reduceMotion: coordinator.reduceMotion, select: { section, keyboard in
                coordinator.select(section, focusContent: !keyboard)
            }, focusChanged: { coordinator.navigationFocusChanged($0) })
                .padding(.horizontal, 16).padding(.bottom, 10)
            Group {
                switch coordinator.section {
                case .home: NativeQuickHomeView(coordinator: coordinator)
                case .tasks: NativeQuickTasksView(coordinator: coordinator, workbench: coordinator.workbench)
                case .capture: NativeQuickCaptureSectionView(coordinator: coordinator)
                case .voice:
                    if let content = coordinator.voiceContent {
                        content().padding(.horizontal, 20).padding(.bottom, 18)
                    }
                case .runs: NativeQuickRunsView(coordinator: coordinator, workbench: coordinator.workbench)
                case .settings: NativeQuickPanelSettingsView(coordinator: coordinator)
                case .agenda, .links, .recordings, .vault, .clipboard, .shelf:
                    if let module = coordinator.extensionModules[coordinator.section] {
                        NativeQuickModuleHost(module: module, visible: coordinator.presentation.contentVisible)
                            .padding(.horizontal, 16).padding(.top, 2)
                    }
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .id(coordinator.section)
                .transition(.opacity)
                .animation(coordinator.reduceMotion ? nil : .easeOut(duration: 0.14), value: coordinator.section)
            HStack {
                Text(coordinator.hotkeyMessage ?? coordinator.shortcutStore.shortcut.label).font(.system(size: 10)).foregroundStyle(.tertiary).lineLimit(1)
                Spacer()
                Text(coordinator.ready ? nativeUI("本机工作区", "Local workspace") : nativeUI("正在连接工作区", "Connecting to workspace"))
                    .font(.system(size: 10)).foregroundStyle(.tertiary)
            }.padding(.horizontal, 20).padding(.bottom, 14).padding(.top, 6)
        }
    }
}

private struct NativeQuickShelfDropDelegate: DropDelegate {
    let coordinator: NativeQuickEntryCoordinator
    func validateDrop(info: DropInfo) -> Bool {
        coordinator.canReceiveFiles() && info.hasItemsConforming(to: [UTType.fileURL.identifier])
    }
    func dropEntered(info: DropInfo) {
        guard validateDrop(info: info) else { return }
        coordinator.revealFileShelfForDrop()
    }
    func dropUpdated(info: DropInfo) -> DropProposal? {
        DropProposal(operation: validateDrop(info: info) ? .copy : .forbidden)
    }
    func performDrop(info: DropInfo) -> Bool {
        guard validateDrop(info: info) else { return false }
        coordinator.revealFileShelfForDrop()
        return coordinator.receiveFiles(info.itemProviders(for: [UTType.fileURL.identifier]))
    }
}

private struct NativeQuickTasksView: View {
    @ObservedObject var coordinator: NativeQuickEntryCoordinator
    @ObservedObject var workbench: NativeQuickWorkbenchStore
    @FocusState private var inputFocused: Bool
    @State private var discardUnavailableEdit = false
    private var input: Binding<String> {
        Binding(get: { workbench.pendingTaskTitle ?? coordinator.taskDraft }, set: { value in
            if workbench.pendingTaskTitle == nil { coordinator.taskDraft = value }
        })
    }
    private var creationFields: Binding<NativeQuickTaskFields> {
        Binding(get: { workbench.pendingTaskFields ?? workbench.creationFields }, set: { value in
            if workbench.pendingTaskTitle == nil { workbench.creationFields = value }
        })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: "plus").font(.system(size: 12)).foregroundStyle(.tertiary)
                TextField(nativeUI("添加一件要做的事", "Add something to do"), text: input)
                    .textFieldStyle(.plain).font(.system(size: 13)).focused($inputFocused)
                    .onSubmit { create() }.disabled(workbench.creating || workbench.pendingTaskTitle != nil || !workbench.ready)
                if workbench.creating { ProgressView().controlSize(.mini) }
                else if !input.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Button { create() } label: { Image(systemName: "arrow.turn.down.left") }.buttonStyle(.plain)
                        .accessibilityLabel(workbench.pendingTaskTitle == nil ? nativeUI("添加待办", "Add task") : nativeUI("重试添加待办", "Retry adding task")).disabled(!workbench.ready)
                }
            }.padding(12).background(Color.primary.opacity(0.055), in: RoundedRectangle(cornerRadius: 10))
            NativeQuickTaskCreationFieldsView(workbench: workbench)
            if let error = workbench.error { Text(error).font(.system(size: 11)).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
            if let draft = workbench.editingTask {
                if workbench.ready && workbench.tasks.contains(where: { $0.id == draft.original.id }) {
                    NativeQuickTaskEditView(workbench: workbench, onFocus: { coordinator.activateInput() })
                } else {
                    HStack {
                        Text(nativeUI("编辑目标暂不可用，输入已保留。", "The edited task is unavailable. Your input is retained.")).foregroundStyle(.secondary)
                        Spacer()
                        Button(nativeUI("取消编辑", "Cancel edit")) { discardUnavailableEdit = true }
                    }.font(.system(size: 11))
                }
            }
            if workbench.canRecoverPendingTask {
                HStack(spacing: 14) {
                    if workbench.pendingTaskTitle != nil {
                        Button(nativeUI("重试", "Retry")) { create() }.disabled(!workbench.ready)
                    }
                    Button(nativeUI("保留恢复副本并新建", "Keep recovery copy and start new")) {
                        if workbench.preservePendingTaskAndStartNew() { coordinator.taskDraft = ""; _ = workbench.startNewTaskFields(); inputFocused = true }
                    }
                }.font(.system(size: 11)).buttonStyle(.plain).foregroundStyle(.tint)
            }
            if let recoveryURL = workbench.recoveryURL {
                Button(nativeUI("查看已保留的恢复副本", "Show preserved recovery copy")) {
                    NSWorkspace.shared.activateFileViewerSelecting([recoveryURL])
                }.font(.system(size: 11)).buttonStyle(.plain).foregroundStyle(.secondary)
            }
            NativeQuickTaskListView(workbench: workbench, onOpened: { coordinator.dismiss(returnFocus: false) },
                                    onFocus: { inputFocused = false; coordinator.activateInput() }, onEmptyFocus: { inputFocused = true })
        }.padding(.horizontal, 20).padding(.top, 4)
            .confirmationDialog(nativeUI("放弃待办更改？", "Discard task changes?"), isPresented: $discardUnavailableEdit) {
                Button(nativeUI("放弃更改", "Discard changes"), role: .destructive) { workbench.editingTask = nil }
                Button(nativeUI("继续保留", "Keep input"), role: .cancel) {}
            }
            .onChange(of: inputFocused) { _, focused in if focused { coordinator.activateInput() } }
            .onChange(of: coordinator.presentation.contentVisible) { _, visible in if !visible { inputFocused = false } }
    }
    private func create() {
        guard !workbench.creating, workbench.ready, !input.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let submitted = input.wrappedValue
        workbench.refreshCreationDeadline()
        let submittedFields = creationFields.wrappedValue
        Task {
            let saved = await workbench.createTask(title: submitted, fields: submittedFields)
            if saved && coordinator.taskDraft.trimmingCharacters(in: .whitespacesAndNewlines) == submitted.trimmingCharacters(in: .whitespacesAndNewlines) {
                coordinator.taskDraft = ""
                _ = workbench.resetCreationFields(after: submittedFields)
            }
        }
    }
}

private struct NativeQuickRunsView: View {
    @ObservedObject var coordinator: NativeQuickEntryCoordinator
    @ObservedObject var workbench: NativeQuickWorkbenchStore
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let error = workbench.error { Text(error).font(.system(size: 11)).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
            if workbench.loading && workbench.runs.isEmpty {
                ProgressView().controlSize(.small).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if workbench.runs.isEmpty {
                quickEmpty(symbol: "waveform.path", title: nativeUI("暂时没有运行", "No runs yet"), detail: nativeUI("工作区里的执行进展会出现在这里。", "Progress from your workspace appears here."))
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(workbench.runs) { item in
                            HStack(alignment: .top, spacing: 11) {
                                Group {
                                    if item.isActive { ProgressView().controlSize(.mini) }
                                    else { Image(systemName: "circle.fill").font(.system(size: 6)).foregroundStyle(.secondary) }
                                }.frame(width: 18, height: 20)
                                Button { Task { if await workbench.openRun(id: item.id) { coordinator.dismiss(returnFocus: false) } } } label: {
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(item.title).font(.system(size: 13, weight: .medium)).lineLimit(2)
                                        Text(item.statusLabel).font(.system(size: 10)).foregroundStyle(item.isActive ? Color.accentColor : .secondary)
                                        if !item.detail.isEmpty { Text(item.detail).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(2) }
                                    }.multilineTextAlignment(.leading).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                                }.buttonStyle(.plain)
                                if item.canCancel {
                                    Button { Task { _ = await workbench.cancelRun(id: item.id) } } label: {
                                        if workbench.cancellingRunIDs.contains(item.id) { ProgressView().controlSize(.mini) }
                                        else { Image(systemName: "stop.fill").font(.system(size: 8)).frame(width: 26, height: 26).background(Color.primary.opacity(0.08), in: Circle()) }
                                    }.buttonStyle(.plain).disabled(workbench.cancellingRunIDs.contains(item.id))
                                        .accessibilityLabel(nativeUI("停止这次运行", "Stop this run")).accessibilityValue(item.title)
                                }
                            }.padding(.vertical, 14)
                            Divider().opacity(0.45)
                        }
                    }
                }.scrollIndicators(.hidden)
            }
        }.padding(.horizontal, 20).padding(.top, 4)
    }
}

private func quickEmpty(symbol: String, title: String, detail: String) -> some View {
    VStack(alignment: .center, spacing: 11) {
        Spacer(minLength: 15)
        Image(systemName: symbol).font(.system(size: 25, weight: .light)).foregroundStyle(.tertiary)
        Text(title).font(.system(size: 13, weight: .medium))
        Text(detail).font(.system(size: 11)).foregroundStyle(.secondary).multilineTextAlignment(.center)
        Spacer(minLength: 20)
    }.frame(maxWidth: .infinity, maxHeight: .infinity)
}


private struct NativeQuickCaptureSectionView: View {
    @ObservedObject var coordinator: NativeQuickEntryCoordinator
    var body: some View {
        VStack(spacing: 12) {
            Picker(nativeUI("随记视图", "Capture view"), selection: Binding(get: { coordinator.captureLibraryVisible }, set: { coordinator.selectCaptureLibrary($0) })) {
                Text(nativeUI("新建随记", "New capture")).tag(false)
                Text(nativeUI("已保存", "Saved captures")).tag(true)
            }.pickerStyle(.segmented).labelsHidden().frame(width: 228).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16)
            if coordinator.captureLibraryVisible {
                NativeQuickCaptureLibraryView(store: coordinator.captureLibrary, onFocus: { coordinator.activateInput() }, onNew: {
                    _ = coordinator.captureLibrary.flushDraft()
                    if coordinator.capture.savedID != nil { coordinator.capture.newCapture() }
                    coordinator.captureLibraryVisible = false
                    coordinator.focusCaptureInput()
                }).padding(.horizontal, 16).padding(.bottom, 16)
            } else {
                NativeQuickCaptureView(coordinator: coordinator, capture: coordinator.capture)
            }
        }.onChange(of: coordinator.captureLibraryVisible) { _, _ in
            _ = coordinator.capture.flushDraft(); _ = coordinator.captureLibrary.flushDraft()
        }
    }
}

private struct NativeQuickCaptureView: View {
    @ObservedObject var coordinator: NativeQuickEntryCoordinator
    @ObservedObject var capture: NativeQuickCaptureStore
    @ObservedObject private var language = NativeL10n.shared
    @State private var textFocused = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if capture.savedID != nil {
                receipt
            } else {
                editor
            }
        }
        .task(id: coordinator.captureFocusRequest) {
            textFocused = false
            await Task.yield()
            guard !Task.isCancelled else { return }
            textFocused = !coordinator.navigationOwnsFocus && coordinator.presentation.contentVisible && coordinator.showingCapture && !capture.inputLocked && capture.savedID == nil
        }
        .onChange(of: coordinator.presentation.contentVisible) { _, visible in
            if !visible { textFocused = false }
        }
        .onChange(of: capture.savedID) { _, value in
            textFocused = !coordinator.navigationOwnsFocus && coordinator.presentation.contentVisible && value == nil && !capture.inputLocked
        }
        .onChange(of: capture.inputLocked) { _, locked in
            if !coordinator.navigationOwnsFocus && coordinator.presentation.contentVisible && !locked && capture.savedID == nil { textFocused = true }
        }
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: 12) {
            ZStack(alignment: .topLeading) {
                if capture.inputLocked {
                    ScrollView {
                        Text(capture.text.isEmpty ? nativeUI("草稿等待恢复", "Draft awaiting recovery") : capture.text)
                            .font(.system(size: 14)).lineSpacing(4)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(10)
                    }
                    .accessibilityLabel(nativeUI("随记内容，只读", "Quick note, read only"))
                } else {
                    NativeQuickCaptureTextEditor(text: $capture.text, focused: $textFocused,
                        locked: capture.inputLocked, fontSize: 14,
                        label: nativeUI("随记内容", "Quick note text"), onFocus: { coordinator.activateInput() })
                        .padding(5)
                    if capture.text.isEmpty {
                        Text(nativeUI("记下一个想法…", "Catch a thought…"))
                            .font(.system(size: 14)).foregroundStyle(.tertiary)
                            .padding(.horizontal, 10).padding(.vertical, 13)
                            .allowsHitTesting(false).accessibilityHidden(true)
                    }
                }
            }
            .frame(minHeight: 150, maxHeight: .infinity)
            .background(Color.primary.opacity(0.025), in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.primary.opacity(0.08)))

            HStack(spacing: 7) {
                Image(systemName: "number").font(.system(size: 12)).foregroundStyle(.tertiary)
                TextField(nativeUI("标签，可选 · 以逗号分隔", "Tags, optional · comma separated"), text: $capture.tags)
                    .font(.system(size: 12)).textFieldStyle(.plain)
                    .disabled(capture.inputLocked)
                    .accessibilityLabel(nativeUI("随记标签，以逗号分隔", "Note tags, comma separated"))
            }.padding(.horizontal, 4)

            if capture.text.utf16.count > 200_000 {
                Text(nativeUI("正文超出 200,000 个字符，文字仍保留，请缩短后保存。", "The text exceeds 200,000 characters. It is retained; shorten it before saving."))
                    .font(.system(size: 11)).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }
            if let draftError = capture.draftError {
                recoveryMessage(draftError, retryDraft: true)
            } else if let error = capture.error {
                recoveryMessage(error, retryDraft: false)
            }

            if let recoveryURL = capture.recoveryURL {
                Button(nativeUI("查看已保留的恢复副本", "Show preserved recovery copy")) {
                    NSWorkspace.shared.activateFileViewerSelecting([recoveryURL])
                }
                .font(.system(size: 11)).buttonStyle(.plain).foregroundStyle(.secondary)
            }

            HStack(spacing: 12) {
                Button(nativeUI("打开全部随记", "Open all notes")) { coordinator.openAllCaptures() }
                    .font(.system(size: 11)).buttonStyle(.plain).foregroundStyle(.secondary)
                    .disabled(!coordinator.ready)
                Spacer(minLength: 0)
                Button {
                    textFocused = false
                    Task { await capture.saveCapture() }
                } label: {
                    HStack(spacing: 6) {
                        if capture.saving { ProgressView().controlSize(.mini) }
                        Text(capture.saving ? nativeUI("保存中", "Saving") : capture.pending != nil ? nativeUI("重试保存", "Retry save") : nativeUI("保存", "Save"))
                            .font(.system(size: 12, weight: .medium))
                    }.frame(minWidth: 55)
                }
                .buttonStyle(.borderedProminent).controlSize(.regular)
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(!capture.canSave || !coordinator.ready)
            }
            Text(nativeUI("⌘↩ 保存 · ↩ 换行", "⌘↩ Save · ↩ New line"))
                .font(.system(size: 10)).foregroundStyle(.tertiary)
        }
        .padding(18)
    }

    private func recoveryMessage(_ message: String, retryDraft: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            ScrollView {
                Text(message).font(.system(size: 11)).foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
            }.frame(maxHeight: 46)
            HStack(spacing: 14) {
                if retryDraft {
                    Button(nativeUI("重试保留草稿", "Retry keeping draft")) { _ = capture.flushDraft() }
                        .disabled(capture.saving)
                }
                Button(nativeUI("复制内容", "Copy text")) {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(capture.text, forType: .string)
                }.disabled(capture.text.isEmpty)
            }.font(.system(size: 11)).buttonStyle(.plain).foregroundStyle(.tint)
            if capture.canStartWithRecovery {
                Button(nativeUI("保留恢复副本并新建", "Keep a recovery copy and start new")) {
                    textFocused = false
                    if capture.preserveRecoveryAndStartNew() { coordinator.focusCaptureInput() }
                }
                .font(.system(size: 11)).buttonStyle(.plain).foregroundStyle(.tint)
                .help(nativeUI("先保留原始草稿，再开始新随记；不会再次发送原内容。", "Preserve the original draft before starting a new note. The original is not resent."))
            }
        }
    }

    private var receipt: some View {
        VStack(alignment: .leading, spacing: 16) {
            Spacer(minLength: 10)
            Image(systemName: "checkmark.circle")
                .font(.system(size: 28, weight: .light)).foregroundStyle(.tint)
                .accessibilityHidden(true)
            Text(nativeUI("已保存到随记", "Saved to your notes"))
                .font(.system(size: 19, weight: .semibold))
            Text(nativeUI("可以回到手头的事，或再记下一条。", "Return to what you were doing, or capture another thought."))
                .font(.system(size: 13)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if let draftError = capture.draftError { recoveryMessage(draftError, retryDraft: true) }
            Spacer(minLength: 10)
            Button(nativeUI("打开全部随记", "Open all notes")) { coordinator.openAllCaptures() }
                .font(.system(size: 12)).buttonStyle(.plain).foregroundStyle(.tint)
                .disabled(!coordinator.ready)
            HStack {
                Button(nativeUI("再记一条", "New note")) {
                    capture.newCapture()
                    coordinator.focusCaptureInput()
                }.buttonStyle(.bordered)
                Spacer()
                Button(nativeUI("完成", "Done")) { coordinator.dismiss() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.return, modifiers: .command)
            }
        }.padding(22)
    }
}
