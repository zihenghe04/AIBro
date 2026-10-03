import AppKit
import SwiftUI
import AVFoundation
import Combine
import UniformTypeIdentifiers

/// Each host calls the child store's visibility hook. No polling or capture is
/// started by constructing this object or by merely opening the island.
@MainActor final class NativeQuickMediaStore: ObservableObject {
    let mirror = NativeQuickMirrorStore()
    let recordings = NativeQuickRecordingStore()
    let windows = NativeQuickWindowsStore()
    let music = NativeQuickMusicStore()
    func configure(directory: URL) { recordings.configure(directory: directory) }
    func setVisible(_ value: Bool) {
        mirror.setVisible(value); recordings.setVisible(value)
        windows.setVisible(value); music.setVisible(value)
    }
    func shutdown() { mirror.setVisible(false); recordings.shutdown(); windows.shutdown(); music.shutdown() }
}

struct NativeQuickWindowItem: Identifiable {
    let id: String
    let pid: pid_t
    let title: String
    let appName: String
    let icon: NSImage?
    var applicationIdentity: String = ""
    var bounds: CGRect? = nil
}

@MainActor final class NativeQuickWindowsStore: ObservableObject {
    enum LoadState: Equatable { case unavailable, waiting, loading, ready, failed }
    typealias Scan = @Sendable () async throws -> NativeQuickWindowSnapshot
    typealias Observe = (@escaping @MainActor () -> Void) -> (() -> Void)
    typealias PrepareActivation = @Sendable (NativeQuickWindowActivation.Target) async -> NativeQuickWindowActivation.Prepared
    typealias ApplyActivation = @MainActor (NativeQuickWindowActivation.Prepared) -> NativeQuickWindowActivation.Result
    @Published private(set) var items: [NativeQuickWindowItem] = []
    @Published private(set) var error: String?
    @Published private(set) var needsWindowTitles = false
    @Published private(set) var activatingID: String?
    @Published private(set) var hiddenIDs: Set<String> = []
    @Published private(set) var state: LoadState = .unavailable
    @Published private(set) var available = false
    @Published private(set) var interactionGeneration: UInt64 = 0
    private let scan: Scan
    private let permission: () -> Bool
    private let observe: Observe
    private let prepareActivation: PrepareActivation
    private let applyActivation: ApplyActivation
    private var activationTask: Task<Void,Never>?
    private var activationGeneration: UInt64 = 0
    private var stopObserving: (() -> Void)?
    private var refreshTask: Task<Void, Never>?
    private var refreshRequested = false
    private var visible = false
    private var active = false
    private var generation: UInt64 = 0
    private var loaded = false
    private var hiddenWindows = Set<String>()
    private var hiddenApplications = Set<pid_t>()
    var hiddenCount: Int { hiddenWindows.count + hiddenApplications.count }
    var isRefreshing: Bool { state == .loading }
    var allowsWindowGesture: Bool { available && visible && active && !isRefreshing }

    init(scan: Scan? = nil, permission: @escaping () -> Bool = { CGPreflightScreenCaptureAccess() },
         observe: Observe? = nil, prepareActivation: @escaping PrepareActivation = NativeQuickWindowActivation.prepare,
         applyActivation: @escaping ApplyActivation = NativeQuickWindowActivation.apply) {
        let scanner = NativeQuickWindowScanner()
        self.scan = scan ?? { try await scanner.scan() }
        self.permission = permission
        self.prepareActivation = prepareActivation; self.applyActivation = applyActivation
        self.observe = observe ?? { changed in
            let center = NSWorkspace.shared.notificationCenter
            let token = center.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { changed() }
            }
            return { center.removeObserver(token) }
        }
    }
    func setAvailable(_ value: Bool) {
        guard available != value else { return }; available = value
        if !value {
            stopWork(); items = []; hiddenWindows = []; hiddenApplications = []; hiddenIDs = []; error = nil; needsWindowTitles = false; loaded = false; state = .unavailable
        } else { state = .waiting; reconcileActivity() }
    }
    // Early visibility permits explicit actions; automatic work waits for the
    // presentation's settled phase. Ordinary collapse retains only app pixels
    // and names, never hidden window-title snapshots.
    func setVisible(_ value: Bool) {
        guard visible != value else { return }; visible = value
        if !value { stopWork(); stripTitles(); state = available ? (loaded ? .ready : .waiting) : .unavailable }
        else { scrubIfPermissionRevoked(); reconcileActivity() }
    }
    func setActivity(_ value: Bool) {
        guard active != value else { return }; active = value
        if !value { stopWork() }
        else { reconcileActivity() }
    }
    private func reconcileActivity() {
        guard available, visible, active else { return }
        if stopObserving == nil {
            stopObserving = observe { [weak self] in self?.refreshAutomatically() }
            refreshAutomatically()
        }
    }
    private func refreshAutomatically() { guard active else { return }; startRefresh() }
    // This is a real action even during opening; only automatic refresh is
    // deferred. The scanner and icon decoder still run outside MainActor.
    func refresh() { startRefresh() }
    private func startRefresh() {
        guard available, visible else { return }
        scrubIfPermissionRevoked()
        if refreshTask != nil { refreshRequested = true; return }
        interactionGeneration &+= 1
        generation &+= 1
        let token = generation, scan = scan
        state = .loading; error = nil
        refreshTask = Task { @MainActor [weak self] in
            do {
                let snapshot = try await scan()
                guard !Task.isCancelled, let self, self.generation == token, self.available, self.visible else { return }
                let titlesAllowed = snapshot.canReadTitles && self.permission()
                var seen = Set<String>()
                self.items = snapshot.rows.compactMap { row in
                    let title = titlesAllowed ? row.title : ""
                    guard seen.insert(title.isEmpty ? "app:\(row.pid)" : row.id).inserted else { return nil }
                    return NativeQuickWindowItem(id: row.id, pid: row.pid, title: title, appName: row.appName,
                        icon: row.icon.map { NSImage(cgImage: $0, size: NSSize(width: 32, height: 32)) }, applicationIdentity: row.applicationIdentity, bounds: titlesAllowed ? row.bounds : nil)
                }
                self.needsWindowTitles = !self.items.isEmpty && !self.permission()
                if titlesAllowed { self.hiddenWindows.formIntersection(Set(self.items.map(\.id))) }
                self.hiddenApplications.formIntersection(Set(self.items.map(\.pid)))
                self.updateHiddenProjection()
                self.loaded = true; self.state = .ready
                self.finishRefresh(token)
            } catch {
                guard !Task.isCancelled, let self, self.generation == token, self.available, self.visible else { return }
                self.scrubIfPermissionRevoked()
                self.error = nativeUI("无法刷新窗口，请重试。", "Could not refresh windows. Try again.")
                self.state = .failed
                self.finishRefresh(token)
            }
        }
    }
    private func finishRefresh(_ token: UInt64) {
        guard generation == token else { return }
        refreshTask = nil
        let again = refreshRequested; refreshRequested = false
        if again { startRefresh() }
    }
    private func stopWork() {
        interactionGeneration &+= 1
        activationGeneration &+= 1; activationTask?.cancel(); activationTask = nil; activatingID = nil
        generation &+= 1
        refreshTask?.cancel(); refreshTask = nil; refreshRequested = false
        stopObserving?(); stopObserving = nil
        if state == .loading { state = available ? (loaded ? .ready : .waiting) : .unavailable }
    }
    private func stripTitles() {
        guard items.contains(where: { !$0.title.isEmpty }) else { return }
        interactionGeneration &+= 1
        var representatives: [pid_t: NativeQuickWindowItem] = [:], order: [pid_t] = []
        for item in items {
            if representatives[item.pid] == nil { representatives[item.pid] = item; order.append(item.pid) }
            else if let previous = representatives[item.pid], hiddenWindows.contains(previous.id), !hiddenWindows.contains(item.id) { representatives[item.pid] = item }
        }
        items = order.compactMap { representatives[$0] }.map {
            .init(id: $0.id, pid: $0.pid, title: "", appName: $0.appName, icon: $0.icon, applicationIdentity: $0.applicationIdentity)
        }
        updateHiddenProjection()
    }
    private func updateHiddenProjection() {
        hiddenIDs = Set(items.filter { hiddenApplications.contains($0.pid) || (!$0.title.isEmpty && hiddenWindows.contains($0.id)) }.map(\.id))
    }
    private func scrubIfPermissionRevoked() {
        if !permission() { stripTitles(); needsWindowTitles = !items.isEmpty }
    }
    func shutdown() { setAvailable(false); visible = false; active = false }
    func hide(id: String) {
        guard available, visible, let item = items.first(where: { $0.id == id }) else { return }
        if item.title.isEmpty { hiddenApplications.insert(item.pid) } else { hiddenWindows.insert(id) }
        if activatingID == id {
            activationGeneration &+= 1; activationTask?.cancel(); activationTask = nil; activatingID = nil
        }
        updateHiddenProjection()
    }
    func hideFromGesture(_ item: NativeQuickWindowItem, generation: UInt64) {
        if !item.title.isEmpty && !permission() { scrubIfPermissionRevoked(); return }
        guard allowsWindowGesture, interactionGeneration == generation,
              items.contains(where: { $0.id == item.id && $0.pid == item.pid && $0.title == item.title && $0.applicationIdentity == item.applicationIdentity }),
              !hiddenIDs.contains(item.id) else { return }
        hide(id: item.id)
    }
    func showAll() { hiddenWindows.removeAll(); hiddenApplications.removeAll(); updateHiddenProjection() }
    func requestWindowTitles() { guard available, visible else { return }; _ = CGRequestScreenCaptureAccess(); refresh() }
    func requestWindowControl() { guard available, visible else { return }; _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) }
    func activate(_ item: NativeQuickWindowItem) {
        guard available, visible, activatingID != item.id else { return }
        scrubIfPermissionRevoked()
        guard items.contains(where: { $0.id == item.id && $0.title == item.title && $0.applicationIdentity == item.applicationIdentity }), !hiddenIDs.contains(item.id) else { return }
        activationGeneration &+= 1; let token = activationGeneration
        activationTask?.cancel(); error = nil; activatingID = item.id
        let target = NativeQuickWindowActivation.Target(id:item.id,pid:item.pid,title:item.title,applicationIdentity:item.applicationIdentity)
        let prepare = prepareActivation
        activationTask = Task { @MainActor [weak self] in
            let prepared = await prepare(target)
            guard let self, !Task.isCancelled, self.activationGeneration == token, self.available, self.visible else { return }
            self.scrubIfPermissionRevoked()
            defer { self.activatingID = nil; self.activationTask = nil }
            guard prepared.target == target, !self.hiddenIDs.contains(item.id),
                  self.items.contains(where: { $0.id == item.id && $0.title == item.title && $0.applicationIdentity == item.applicationIdentity }) else { return }
            switch self.applyActivation(prepared) {
            case .raised, .applicationOnly: break
            case .controlPermission: self.error = nativeUI("已切换应用。精确选择窗口需要窗口读取与辅助功能权限。", "Switched app. Exact window selection needs window-reading and Accessibility permission.")
            case .ambiguous: self.error = nativeUI("已切换应用；无法唯一对应此窗口，未猜测具体窗口。", "Switched app; the matching windows could not be uniquely identified.")
            case .unavailable: self.error = nativeUI("已切换应用；未能读取此窗口的位置。", "Switched app; this window's position could not be read.")
            case .changed: self.error = nativeUI("已切换应用；窗口已变化，请刷新后选择。", "Switched app; the window changed. Refresh before selecting it again.")
            case .closed: self.refresh(); self.error = nativeUI("窗口已关闭，请重新选择。", "The window has closed. Select another window.")
            case .failed: self.error = nativeUI("此窗口暂时无法置前，请重试。", "This window could not be raised. Try again.")
            }
        }
    }
}

enum NativeQuickWindowListing {
    // Numbering follows CG IDs, not front-to-back scan order or search order.
    static func appLabel(_ item: NativeQuickWindowItem, among items: [NativeQuickWindowItem]) -> String {
        guard !item.title.isEmpty else { return item.appName }
        let peers = items.filter { $0.pid == item.pid && $0.applicationIdentity == item.applicationIdentity && !$0.title.isEmpty }
            .sorted { (UInt32($0.id.split(separator: ":").last ?? "") ?? 0) < (UInt32($1.id.split(separator: ":").last ?? "") ?? 0) }
        guard peers.count > 1, let index = peers.firstIndex(where: { $0.id == item.id }) else { return item.appName }
        return item.appName + " · " + String(index + 1)
    }
    static func matching(_ items: [NativeQuickWindowItem], hidden: Set<String>, query: String = "") -> [NativeQuickWindowItem] {
        let terms = query.split(whereSeparator: \.isWhitespace).map(String.init)
        return items.filter { item in
            !hidden.contains(item.id) && terms.allSatisfy {
                item.appName.localizedCaseInsensitiveContains($0) || item.title.localizedCaseInsensitiveContains($0)
            }
        }
    }
    static func previewLimit(size: String) -> Int {
        switch size { case "mini": return 2; case "small": return 2; case "large": return 8; default: return 4 }
    }
}

struct NativeQuickWindowsCard: View {
    @ObservedObject var store: NativeQuickWindowsStore
    @Environment(\.nativeQuickWidgetContext) private var widget
    @Environment(\.accessibilityReduceMotion) private var reducedMotion
    @State private var query = ""
    @State private var windowFrames: [String: CGRect] = [:]
    @State private var surfaceID = UUID()
    @StateObject private var interaction = NativeQuickWindowInteractionController()
    private var visibleItems: [NativeQuickWindowItem] { NativeQuickWindowListing.matching(store.items, hidden: store.hiddenIDs) }
    private var results: [NativeQuickWindowItem] { NativeQuickWindowListing.matching(store.items, hidden: store.hiddenIDs, query: query) }
    var body: some View {
        Group {
            if widget.isDetail { detail }
            else { preview }
        }
        .onDisappear { interaction.cancel() }
    }
    // No inner ScrollView on the home canvas: every wheel/momentum event has
    // exactly one owner there. The explicit count/link keeps the rest reachable.
    private var preview: some View {
        VStack(alignment: .leading, spacing: 7) {
            if widget.size == "mini" {
                HStack(spacing: 7) {
                    Text(nativeUI("窗口", "Windows")).font(.system(size: 10)).foregroundStyle(.secondary)
                    ForEach(Array(visibleItems.prefix(2))) { item in
                        windowTile(item, compact: true)
                    }
                    Spacer(minLength: 0)
                    if store.isRefreshing { ProgressView().controlSize(.mini).accessibilityLabel(nativeUI("正在刷新窗口", "Refreshing windows")) }
                    expandButton
                }.frame(maxHeight: .infinity)
            } else {
                HStack {
                    Text(nativeUI("当前窗口", "Current windows")).font(.system(size: 11)).foregroundStyle(.secondary)
                    Spacer()
                    refreshButton
                }
                if visibleItems.isEmpty {
                    Text(emptyMessage).font(.system(size: 11)).foregroundStyle(.secondary)
                } else {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 62, maximum: 112), spacing: 6)], spacing: 7) {
                        ForEach(Array(visibleItems.prefix(NativeQuickWindowListing.previewLimit(size: widget.size)))) { item in
                            windowTile(item, compact: false)
                        }
                    }
                }
                if !visibleItems.isEmpty, let error = store.error {
                    Text(error).font(.system(size: 10)).foregroundStyle(.orange).lineLimit(2)
                }
                Spacer(minLength: 0)
                expandButton
            }
        }
        .background(NativeQuickWindowPointerSurface(controller: interaction, frames: windowFrames,
            owner: store.interactionGeneration, enabled: store.allowsWindowGesture) { [weak store, reducedMotion] id, generation in
                guard let store, let item = store.items.first(where: { $0.id == id }) else { return }
                withAnimation(reducedMotion ? nil : .easeOut(duration: 0.18)) {
                    store.hideFromGesture(item, generation: generation)
                }
            })
        .coordinateSpace(name: surfaceID)
        .onPreferenceChange(NativeQuickWindowFrames.self) { if windowFrames != $0 { windowFrames = $0 } }
        .overlay(alignment: .bottom) {
            if interaction.gesture.phase == .dragging {
                Text(interaction.gesture.removeReady
                    ? nativeUI("松开即可隐藏 · 不会关闭应用", "Release to hide · app stays open")
                    : nativeUI("拖出卡片可隐藏 · Esc 取消", "Drag outside to hide · Esc cancels"))
                    .font(.system(size: 10, weight: .medium)).lineLimit(2)
                    .padding(.horizontal, 9).padding(.vertical, 6)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
                    .foregroundStyle(interaction.gesture.removeReady ? Color.orange : Color.secondary)
                    .allowsHitTesting(false).accessibilityHidden(true)
            }
        }
    }
    private func windowTile(_ item: NativeQuickWindowItem, compact: Bool) -> some View {
        let dragging = interaction.gesture.phase == .dragging && interaction.gesture.source == item.id
        let transform = NativeQuickWindowProximity.transform(point: interaction.pointer,
            frame: windowFrames[item.id] ?? .zero, reducedMotion: reducedMotion)
        return ZStack {
            Button {
                guard interaction.gesture.mayActivate(now: ProcessInfo.processInfo.systemUptime) else { return }
                store.activate(item)
            } label: {
                VStack(spacing: compact ? 0 : 4) {
                    appIcon(item, size: compact ? 23 : 25)
                        .scaleEffect(dragging ? (reducedMotion ? 1 : 1.06) : transform.scale, anchor: .bottom)
                        .offset(y: dragging ? 0 : transform.lift)
                        .animation(reducedMotion || dragging ? nil : .spring(response: 0.18, dampingFraction: 0.84), value: transform)
                    if !compact { Text(appLabel(item)).font(.system(size: 10)).lineLimit(1) }
                }
                .frame(maxWidth: compact ? nil : .infinity).padding(.vertical, compact ? 0 : 3)
                .contentShape(Rectangle())
            }.buttonStyle(.plain)
                .help(windowLabel(item) + "\n" + nativeUI("长按后拖出卡片可隐藏", "Hold, then drag outside this card to hide"))
                .accessibilityLabel(windowLabel(item))
                .contextMenu { Button(nativeUI("在窗口卡片中隐藏", "Hide from window card")) { store.hide(id: item.id) } }
                .offset(dragging ? interaction.gesture.translation : .zero)
                .opacity(dragging && interaction.gesture.removeReady ? 0.45 : 1)
        }
        .background(GeometryReader { geometry in
            Color.clear.preference(key: NativeQuickWindowFrames.self, value: [item.id: geometry.frame(in: .named(surfaceID))])
        })
        .zIndex(dragging ? 10 : 0)
    }
    private var detail: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                TextField(nativeUI("搜索应用或窗口标题", "Search apps or window titles"), text: $query)
                    .textFieldStyle(.roundedBorder).accessibilityLabel(nativeUI("搜索全部窗口", "Search all windows"))
                Text(store.state == .waiting || (store.isRefreshing && store.items.isEmpty) ? "…" : "\(results.count)").font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
                refreshButton
            }
            ScrollView {
                LazyVStack(spacing: 4) {
                    if results.isEmpty {
                        Text(query.isEmpty ? emptyMessage : nativeUI("没有匹配的窗口", "No matching windows"))
                            .font(.callout).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 16)
                    }
                    ForEach(results) { item in
                        HStack(spacing: 10) {
                            Button { store.activate(item) } label: {
                                HStack(spacing: 10) {
                                    appIcon(item, size: 30)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(appLabel(item)).font(.system(size: 12, weight: .medium))
                                        if !item.title.isEmpty { Text(item.title).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(2) }
                                    }.frame(maxWidth: .infinity, alignment: .leading)
                                }.padding(.vertical, 8).contentShape(Rectangle())
                            }.buttonStyle(.plain).help(windowLabel(item))
                            Button { store.hide(id: item.id) } label: { Image(systemName: "minus.circle").font(.system(size: 14)).frame(width: 28, height: 28) }
                                .buttonStyle(.plain).foregroundStyle(.secondary).accessibilityLabel(nativeUI("隐藏", "Hide ") + windowLabel(item))
                        }
                        if item.id != results.last?.id { Divider().opacity(0.4) }
                    }
                    if let error = store.error { Text(error).font(.caption).foregroundStyle(.orange).frame(maxWidth: .infinity, alignment: .leading) }
                }
            }.scrollIndicators(.automatic)
            HStack(spacing: 14) {
                if store.hiddenCount > 0 {
                    Button(nativeUI("恢复隐藏项（\(store.hiddenCount)）", "Restore hidden items (\(store.hiddenCount))")) { store.showAll() }
                }
                if store.needsWindowTitles { Button(nativeUI("允许读取窗口标题", "Allow window titles")) { store.requestWindowTitles() } }
                if !AXIsProcessTrusted() { Button(nativeUI("允许精确切换窗口", "Allow exact window switching")) { store.requestWindowControl() } }
                Spacer(minLength: 0)
            }.buttonStyle(.plain).font(.system(size: 11)).foregroundStyle(.secondary)
        }.padding(.bottom, 8)
    }
    private var expandButton: some View {
        Button { widget.expand?() } label: {
            HStack(spacing: 4) {
                Text(store.state == .waiting || (store.isRefreshing && store.items.isEmpty)
                    ? nativeUI("读取中…", "Loading…")
                    : widget.size == "mini" ? "\(visibleItems.count)" : nativeUI("查看全部 \(visibleItems.count) 个窗口", "View all \(visibleItems.count) windows"))
                Image(systemName: "chevron.right").font(.system(size: 8, weight: .medium))
            }.font(.system(size: 10)).foregroundStyle(.secondary)
        }.buttonStyle(.plain).accessibilityLabel(nativeUI("查看全部 \(visibleItems.count) 个窗口", "View all \(visibleItems.count) windows"))
    }
    private var refreshButton: some View {
        Button { store.refresh() } label: {
            Group {
                if store.isRefreshing { ProgressView().controlSize(.mini) }
                else { Image(systemName: "arrow.clockwise").font(.system(size: 11)) }
            }.frame(width: 22, height: 22)
        }.buttonStyle(.plain).disabled(!store.available || store.isRefreshing)
            .help(nativeUI("刷新窗口", "Refresh windows"))
            .accessibilityLabel(store.isRefreshing ? nativeUI("正在刷新窗口", "Refreshing windows") : nativeUI("刷新窗口", "Refresh windows"))
    }
    @ViewBuilder private func appIcon(_ item: NativeQuickWindowItem, size: CGFloat) -> some View {
        Group {
            if store.activatingID == item.id {
                ProgressView().controlSize(.small).frame(width: size, height: size)
                    .accessibilityLabel(nativeUI("正在选择窗口", "Selecting window"))
            } else if let icon = item.icon { Image(nsImage: icon).resizable().frame(width: size, height: size) }
            else { Image(systemName: "macwindow").font(.system(size: size * 0.7)).frame(width: size, height: size).foregroundStyle(.secondary) }
        }
    }
    private func appLabel(_ item: NativeQuickWindowItem) -> String { NativeQuickWindowListing.appLabel(item, among:store.items) }
    private func windowLabel(_ item: NativeQuickWindowItem) -> String { appLabel(item) + (item.title.isEmpty ? "" : " · " + item.title) }
    private var emptyMessage: String {
        if !store.available { return nativeUI("当前工作区不可用", "Workspace unavailable") }
        if store.state == .waiting || store.isRefreshing { return nativeUI("正在读取窗口…", "Loading windows…") }
        if let error = store.error { return error }
        return store.hiddenIDs.isEmpty ? nativeUI("没有可切换的窗口", "No available windows") : nativeUI("窗口已隐藏，可在全部窗口中恢复", "Windows are hidden. Restore them in All windows.")
    }
}

enum NativeQuickLocalRepeatMode: String, CaseIterable, Codable {
    case off, all, one
    var symbol: String { self == .one ? "repeat.1" : "repeat" }
    var label: String {
        switch self {
        case .off: return nativeUI("循环关闭", "Repeat off")
        case .all: return nativeUI("列表循环", "Repeat all")
        case .one: return nativeUI("单曲循环", "Repeat one")
        }
    }
    var nextMode: Self { self == .off ? .all : self == .all ? .one : .off }
    func completionIndex(current: Int, count: Int, successfully: Bool) -> Int? {
        guard successfully, count > 0, (0..<count).contains(current) else { return nil }
        if self == .one { return current }
        if current + 1 < count { return current + 1 }
        return self == .all ? 0 : nil
    }
}

private struct NativeQuickLocalMusicState: Codable {
    let bookmarks: [Data]
    let index: Int
    let position: TimeInterval
    let volume: Double
    let repeatMode: NativeQuickLocalRepeatMode
    let source: String
}

@MainActor final class NativeQuickMusicStore: NSObject, ObservableObject, AVAudioPlayerDelegate {
    enum Source: String, CaseIterable { case spotify, local }
    let spotify = NativeQuickNowPlayingStore()
    @Published var source: Source = .spotify {
        didSet { spotify.setVisible(visible && source == .spotify); if source != .local { cancelSeek() }; persistLocalState() }
    }
    private var visible = false
    @Published private(set) var tracks: [URL] = []
    @Published private(set) var index = 0
    @Published private(set) var playing = false
    @Published private(set) var error: String?
    @Published private(set) var duration: TimeInterval = 0
    @Published private(set) var position: TimeInterval = 0
    @Published private(set) var seeking = false
    @Published private(set) var seekPosition: TimeInterval = 0
    @Published var volume: Double = 0.7 {
        didSet {
            let normalized = volume.isFinite ? min(1, max(0, volume)) : 0.7
            if volume != normalized { volume = normalized; return }
            player?.volume = Float(volume); persistLocalState()
        }
    }
    @Published var repeatMode: NativeQuickLocalRepeatMode = .off { didSet { persistLocalState() } }
    private var player: AVAudioPlayer?
    private weak var seekPlayer: AVAudioPlayer?
    private var securityScopes: Set<URL> = []
    private var bookmarks: [URL: Data] = [:]
    private let preferences: UserDefaults
    // The default calls the real engine. Tests may inject a silent start probe;
    // no test needs to start an output device or touch another music app.
    private let startPlayer: (AVAudioPlayer) -> Bool
    private var restoring = true
    private static let stateKey = "AIBroQuickLocalMusicState.v1"

    init(preferences: UserDefaults = .standard, startPlayer: @escaping (AVAudioPlayer) -> Bool = { $0.play() }) {
        self.preferences = preferences; self.startPlayer = startPlayer
        super.init()
        restoreLocalState(); restoring = false
    }
    var currentTitle: String? { tracks.indices.contains(index) ? tracks[index].deletingPathExtension().lastPathComponent : nil }
    var canSeek: Bool { player != nil && duration.isFinite && duration > 0 }
    var playbackPosition: TimeInterval {
        if !playing, duration > 0, position >= duration { return duration }
        let value = player?.currentTime ?? position
        return min(duration, max(0, value.isFinite ? value : 0))
    }
    func setVisible(_ value: Bool) {
        visible = value; spotify.setVisible(value && source == .spotify)
        if !value { cancelSeek(); persistLocalState() }
        // Explicitly started playback continues; a source switch never changes
        // playback/volume in either player. The view owns its visible-only clock.
    }
    func chooseTracks() {
        let panel = NSOpenPanel(); panel.allowedContentTypes = [.audio]; panel.allowsMultipleSelection = true; panel.canChooseDirectories = false
        panel.prompt = nativeUI("加入播放列表", "Add to playlist")
        panel.begin { [weak self] response in MainActor.assumeIsolated {
            guard response == .OK, let self else { return }
            self.addTracks(panel.urls); self.source = .local
        } }
    }
    func addTracks(_ urls: [URL]) {
        let wasEmpty = tracks.isEmpty
        for original in urls where original.isFileURL {
            let url = original.standardizedFileURL
            guard !tracks.contains(url) else { continue }
            if url.startAccessingSecurityScopedResource() { securityScopes.insert(url) }
            bookmarks[url] = try? url.bookmarkData(options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil)
            tracks.append(url)
        }
        if wasEmpty && !tracks.isEmpty { loadTrack(at: 0, autoplay: false) }
        persistLocalState()
    }
    func toggle() {
        if playing { player?.pause(); playing = false; position = playbackPosition; persistLocalState(); return }
        if player == nil { loadTrack(at: index, autoplay: false) }
        guard let player else { return }
        if playbackPosition >= max(0, duration - 0.02) { player.currentTime = 0; position = 0 }
        playing = startPlayer(player)
        error = playing ? nil : nativeUI("无法开始播放，请重新选择音频。", "Could not start playback. Choose the audio again.")
    }
    func previous() { guard !tracks.isEmpty else { return }; selectTrack(at: (index - 1 + tracks.count) % tracks.count) }
    func next() { guard !tracks.isEmpty else { return }; selectTrack(at: (index + 1) % tracks.count) }
    func selectTrack(at index: Int) { loadTrack(at: index, autoplay: true); persistLocalState() }
    func removeTrack(at removed: Int) {
        guard tracks.indices.contains(removed) else { return }
        cancelSeek()
        let wasPlaying = playing, wasCurrent = removed == index, url = tracks[removed]
        if wasCurrent { stopPlayer() }
        tracks.remove(at: removed); bookmarks.removeValue(forKey: url)
        if securityScopes.remove(url) != nil { url.stopAccessingSecurityScopedResource() }
        if tracks.isEmpty { index = 0; duration = 0; position = 0; error = nil }
        else if wasCurrent { loadTrack(at: min(removed, tracks.count - 1), autoplay: wasPlaying) }
        else if removed < index { index -= 1 }
        persistLocalState()
    }
    func beginSeek() {
        guard canSeek, let player else { return }
        seekPlayer = player; seekPosition = playbackPosition; seeking = true
    }
    func updateSeek(_ value: TimeInterval) {
        guard value.isFinite, canSeek else { return }
        if seeking { seekPosition = min(duration, max(0, value)) }
        else { seek(to: value) } // Keyboard/accessibility adjustments commit immediately.
    }
    func endSeek() {
        guard seeking else { return }
        let value = seekPosition, sameTrack = seekPlayer === player
        cancelSeek()
        if sameTrack { seek(to: value) }
    }
    func cancelSeek() { seeking = false; seekPlayer = nil }
    func seek(to value: TimeInterval) {
        guard value.isFinite, canSeek, let player else { return }
        // A drag to the right edge should locate the ending, not accidentally
        // advance the queue in the completion callback during the gesture.
        player.currentTime = min(max(0, value), max(0, duration - 0.01))
        position = playbackPosition; persistLocalState()
    }
    private func loadTrack(at selected: Int, autoplay: Bool) {
        guard tracks.indices.contains(selected) else { return }
        stopPlayer(); index = selected; duration = 0; position = 0
        do {
            let next = try AVAudioPlayer(contentsOf: tracks[selected])
            guard next.duration.isFinite, next.duration > 0 else { throw CocoaError(.fileReadCorruptFile) }
            next.delegate = self; next.volume = Float(volume)
            player = next; duration = next.duration; error = nil
            if autoplay {
                playing = startPlayer(next)
                if !playing { error = nativeUI("无法开始播放这个音频文件。", "This audio file could not start playing.") }
            }
        } catch { player = nil; playing = false; self.error = nativeUI("音频无法读取，可能已被移动或删除。可从列表移除后重新添加。", "Audio could not be read. It may have moved or been deleted; remove it from the list and add it again.") }
    }
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor [weak self] in self?.finishPlayback(player, successfully: flag) }
    }
    func finishPlayback(_ completed: AVAudioPlayer, successfully flag: Bool) {
        guard player === completed else { return }
        cancelSeek(); playing = false
        if let next = repeatMode.completionIndex(current: index, count: tracks.count, successfully: flag) {
            loadTrack(at: next, autoplay: true)
        } else {
            position = flag ? duration : playbackPosition
            if flag { completed.currentTime = max(0, duration - 0.01) }
            else { error = nativeUI("播放意外中断，请重试或移除此音频。", "Playback was interrupted. Retry or remove this audio.") }
        }
        persistLocalState()
    }
    private func stopPlayer() {
        cancelSeek(); player?.delegate = nil; player?.stop(); player = nil; playing = false
    }
    private func persistLocalState() {
        guard !restoring else { return }
        let saved = tracks.filter { bookmarks[$0] != nil }
        let current = tracks.indices.contains(index) ? tracks[index] : nil
        let selected = current.flatMap { saved.firstIndex(of: $0) } ?? 0
        let state = NativeQuickLocalMusicState(bookmarks: saved.compactMap { bookmarks[$0] }, index: selected,
                                               position: playbackPosition, volume: volume, repeatMode: repeatMode, source: source.rawValue)
        if let data = try? JSONEncoder().encode(state) { preferences.set(data, forKey: Self.stateKey) }
    }
    private func restoreLocalState() {
        guard let data = preferences.data(forKey: Self.stateKey), let state = try? JSONDecoder().decode(NativeQuickLocalMusicState.self, from: data) else { return }
        volume = state.volume.isFinite ? min(1, max(0, state.volume)) : 0.7
        repeatMode = state.repeatMode; source = Source(rawValue: state.source) ?? .local
        var restoredSelection: Int?
        for (offset, bookmark) in state.bookmarks.enumerated() {
            var stale = false
            guard let url = try? URL(resolvingBookmarkData: bookmark, options: [.withSecurityScope, .withoutUI, .withoutMounting], relativeTo: nil, bookmarkDataIsStale: &stale), url.isFileURL else { continue }
            let track = url.standardizedFileURL
            if track.startAccessingSecurityScopedResource() { securityScopes.insert(track) }
            if offset == state.index { restoredSelection = tracks.count }
            tracks.append(track)
            bookmarks[track] = stale ? (try? track.bookmarkData(options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil)) ?? bookmark : bookmark
        }
        guard !tracks.isEmpty else { return }
        loadTrack(at: restoredSelection ?? 0, autoplay: false)
        if restoredSelection != nil { seek(to: state.position) }
        // Never autoplay after launch, including when the last run was playing.
    }
    func shutdown() {
        position = playbackPosition; persistLocalState(); spotify.setVisible(false); stopPlayer()
        securityScopes.forEach { $0.stopAccessingSecurityScopedResource() }; securityScopes.removeAll()
    }
}

struct NativeQuickMusicCard: View {
    @ObservedObject var store: NativeQuickMusicStore
    @ObservedObject private var spotify: NativeQuickNowPlayingStore
    @Environment(\.nativeQuickWidgetContext) private var widget
    init(store: NativeQuickMusicStore) { self.store = store; self.spotify = store.spotify }
    private var compact: Bool { !widget.isDetail && widget.size == "mini" }
    var body: some View {
        Group {
            if compact { miniContent }
            else {
                VStack(alignment: .leading, spacing: 9) {
                    HStack(spacing: 8) {
                        sourceMenu
                        Spacer(minLength: 0)
                        if store.source == .spotify && spotify.busy {
                            ProgressView().controlSize(.mini).accessibilityLabel(spotify.snapshot.state == .launching ? nativeUI("正在启动 Spotify", "Starting Spotify") : nativeUI("读取 Spotify", "Reading Spotify"))
                        }
                        Button { store.chooseTracks() } label: { Image(systemName: "folder.badge.plus").font(.system(size: 11)).frame(width: 22, height: 22) }
                            .buttonStyle(.plain).help(nativeUI("添加本地音频", "Add local audio"))
                            .accessibilityLabel(nativeUI("添加本地音频", "Add local audio"))
                    }.foregroundStyle(.secondary)
                    if store.source == .spotify { spotifyContent } else { localContent }
                }
            }
        }
    }
    private var sourceMenu: some View {
        Menu {
            Button("Spotify") { store.source = .spotify }
            Button(nativeUI("本地音频", "Local audio")) { store.source = .local }
            Button(nativeUI("添加本地音频…", "Add local audio…")) { store.chooseTracks() }
        } label: {
            HStack(spacing: 4) {
                Text(store.source == .spotify ? "Spotify" : nativeUI("本地", "Local"))
                Image(systemName: "chevron.down").font(.system(size: 8, weight: .semibold))
            }.font(.system(size: 10, weight: .medium))
        }.menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .accessibilityLabel(nativeUI("音乐来源", "Music source"))
    }
    private var miniContent: some View {
        HStack(spacing: 7) {
            sourceMenu.foregroundStyle(.secondary)
            if store.source == .local { localCompact }
            else {
                Text(spotify.snapshot.title.isEmpty ? spotify.snapshot.statusText : spotify.snapshot.title)
                    .font(.system(size: 11)).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                Button { spotify.performPrimaryAction() } label: {
                    Image(systemName: spotify.primaryActionSymbol)
                        .frame(width: 26, height: 26)
                }.buttonStyle(.plain).disabled(spotify.busy)
                    .accessibilityLabel(spotify.primaryActionTitle).help(spotify.controlError ?? spotify.primaryActionTitle)
            }
        }
    }
    private var spotifyContent: some View {
        VStack(alignment: .leading, spacing: compact ? 5 : 9) {
            if spotify.snapshot.canControl {
                Text(spotify.snapshot.title.isEmpty ? spotify.snapshot.statusText : spotify.snapshot.title)
                    .font(.system(size: compact ? 11 : 13, weight: .medium)).lineLimit(compact ? 1 : 2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if !compact {
                    Text([spotify.snapshot.artist, spotify.snapshot.state == .playing ? "" : spotify.snapshot.statusText].filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                }
                if spotify.snapshot.canSeek { spotifyProgress }
                HStack(spacing: 0) {
                    if let shuffling = spotify.snapshot.shuffling {
                        Button { spotify.setShuffling(!shuffling) } label: {
                            Image(systemName: "shuffle").frame(width: 28, height: 28)
                                .foregroundStyle(shuffling ? Color.accentColor : Color.secondary)
                        }.accessibilityLabel(nativeUI("Spotify 随机播放", "Spotify shuffle"))
                            .accessibilityValue(shuffling ? nativeUI("开", "On") : nativeUI("关", "Off"))
                            .help(shuffling ? nativeUI("关闭随机播放", "Turn shuffle off") : nativeUI("开启随机播放", "Turn shuffle on"))
                    }
                    Spacer(minLength: 4)
                    Button { spotify.previous() } label: { Image(systemName: "backward.fill").frame(width: 30, height: 28) }
                        .accessibilityLabel(nativeUI("Spotify 上一首", "Previous Spotify track"))
                    Button { spotify.playPause() } label: { Image(systemName: spotify.snapshot.state == .playing ? "pause.fill" : "play.fill").frame(width: 36, height: 28) }
                        .accessibilityLabel(spotify.snapshot.state == .playing ? nativeUI("暂停 Spotify", "Pause Spotify") : nativeUI("播放 Spotify", "Play Spotify"))
                    Button { spotify.next() } label: { Image(systemName: "forward.fill").frame(width: 30, height: 28) }
                        .accessibilityLabel(nativeUI("Spotify 下一首", "Next Spotify track"))
                    Spacer(minLength: 4)
                    if let repeating = spotify.snapshot.repeating {
                        Button { spotify.setRepeating(!repeating) } label: {
                            Image(systemName: "repeat").frame(width: 28, height: 28)
                                .foregroundStyle(repeating ? Color.accentColor : Color.secondary)
                        }.accessibilityLabel(nativeUI("Spotify 循环开关", "Spotify repeat switch"))
                            .accessibilityValue(repeating ? nativeUI("开", "On") : nativeUI("关", "Off"))
                            .help(nativeUI("循环开关；本地接口不支持选择单曲循环", "Repeat on/off; the local interface cannot select repeat-one"))
                    }
                }.buttonStyle(.plain).disabled(spotify.busy || spotify.seeking)
            } else {
                Text(spotify.snapshot.statusText).font(.system(size: compact ? 10 : 11)).foregroundStyle(.secondary)
                    .lineLimit(compact ? 2 : 3).frame(maxWidth: .infinity, alignment: .leading)
                Button(spotify.primaryActionTitle) { spotify.performPrimaryAction() }
                    .buttonStyle(.bordered).controlSize(.small).disabled(spotify.busy)
            }
            if let error = spotify.controlError {
                Text(error).font(.system(size: 10)).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
    private var spotifyProgress: some View {
        TimelineView(.animation(minimumInterval: 0.5, paused: spotify.snapshot.state != .playing || spotify.seeking)) { _ in
            let position = spotify.seeking ? spotify.seekPosition : spotify.snapshot.displayedPosition(at: ProcessInfo.processInfo.systemUptime)
            let duration = max(0.001, spotify.snapshot.duration ?? 0)
            VStack(spacing: 0) {
                Slider(value: Binding(get: { position }, set: { spotify.updateSeek($0) }), in: 0...duration,
                       onEditingChanged: { editing in if editing { spotify.beginSeek() } else { spotify.endSeek() } })
                    .controlSize(.mini)
                    .accessibilityLabel(nativeUI("Spotify 播放进度", "Spotify playback position"))
                    .accessibilityValue("\(musicTime(position)) / \(musicTime(duration))")
                HStack {
                    Text(musicTime(position))
                    Spacer(minLength: 0)
                    Text(musicTime(duration))
                }.font(.system(size: 9, design: .monospaced)).foregroundStyle(.secondary).monospacedDigit()
            }
        }.onDisappear { spotify.cancelSeek() }
    }
    private func musicTime(_ value: TimeInterval) -> String {
        let seconds = Int(max(0, min(value.isFinite ? value : 0, 604800)))
        return seconds >= 3600 ? String(format: "%d:%02d:%02d", seconds / 3600, (seconds / 60) % 60, seconds % 60) : String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
    private var localCompact: some View {
        HStack(spacing: 8) {
            Text(store.currentTitle ?? nativeUI("添加音乐", "Add music")).font(.system(size: 11)).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
            Button { if store.tracks.isEmpty { store.chooseTracks() } else { store.toggle() } }
                label: { Image(systemName: store.tracks.isEmpty ? "plus" : store.playing ? "pause.fill" : "play.fill").frame(width: 26, height: 26) }
                .buttonStyle(.plain).accessibilityLabel(store.tracks.isEmpty ? nativeUI("选择音频", "Choose audio") : store.playing ? nativeUI("暂停音乐", "Pause music") : nativeUI("播放音乐", "Play music"))
        }
    }
    private var localProgress: some View {
        TimelineView(.animation(minimumInterval: 0.5, paused: !store.playing || store.seeking)) { _ in
            let position = store.seeking ? store.seekPosition : store.playbackPosition
            VStack(spacing: 0) {
                Slider(value: Binding(get: { position }, set: { store.updateSeek($0) }), in: 0...max(0.001, store.duration),
                       onEditingChanged: { editing in if editing { store.beginSeek() } else { store.endSeek() } })
                    .controlSize(.mini).disabled(!store.canSeek)
                    .accessibilityLabel(nativeUI("本地音频播放进度", "Local audio playback position"))
                    .accessibilityValue("\(musicTime(position)) / \(musicTime(store.duration))")
                HStack {
                    Text(musicTime(position))
                    Spacer(minLength: 0)
                    Text(musicTime(store.duration))
                }.font(.system(size: 9, design: .monospaced)).foregroundStyle(.secondary).monospacedDigit()
            }.transaction { $0.animation = nil }
        }.onDisappear { store.cancelSeek() }
    }
    private var localPlaylistMenu: some View {
        Menu {
            ForEach(Array(store.tracks.enumerated()), id: \.offset) { offset, url in
                Menu(url.deletingPathExtension().lastPathComponent) {
                    Button(nativeUI("播放", "Play")) { store.selectTrack(at: offset) }
                    Button(nativeUI("从列表移除", "Remove from playlist"), role: .destructive) { store.removeTrack(at: offset) }
                }
            }
            if !store.tracks.isEmpty { Divider() }
            Button(nativeUI("添加本地音频…", "Add local audio…")) { store.chooseTracks() }
        } label: {
            Image(systemName: "list.bullet").font(.system(size: 11)).frame(width: 24, height: 24)
        }.menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .accessibilityLabel(nativeUI("本地播放列表", "Local playlist"))
    }
    private var localContent: some View {
        VStack(alignment: .leading, spacing: widget.isDetail ? 8 : 4) {
            HStack(spacing: 9) {
                Image(systemName: "music.note").font(.system(size: 17)).frame(width: 28, height: 28).background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
                VStack(alignment: .leading, spacing: 3) {
                    Text(store.currentTitle ?? nativeUI("听一点音乐", "A little music")).font(.system(size: 12, weight: .medium)).lineLimit(1)
                    Text(store.tracks.isEmpty ? nativeUI("本机播放列表", "Local playlist") : "\(store.index + 1) / \(store.tracks.count)").font(.system(size: 10)).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading)
                localPlaylistMenu.foregroundStyle(.secondary)
            }
            if !store.tracks.isEmpty { localProgress }
            HStack(spacing: 0) {
                Button { store.previous() } label: { Image(systemName: "backward.fill").frame(width: 30, height: 26) }
                    .disabled(store.tracks.isEmpty).help(nativeUI("上一首", "Previous")).accessibilityLabel(nativeUI("本地音频上一首", "Previous local track"))
                Button { store.toggle() } label: { Image(systemName: store.playing ? "pause.fill" : "play.fill").frame(width: 34, height: 26) }
                    .disabled(store.tracks.isEmpty).help(store.playing ? nativeUI("暂停", "Pause") : nativeUI("播放", "Play"))
                    .accessibilityLabel(store.playing ? nativeUI("暂停本地音频", "Pause local audio") : nativeUI("播放本地音频", "Play local audio"))
                Button { store.next() } label: { Image(systemName: "forward.fill").frame(width: 30, height: 26) }
                    .disabled(store.tracks.isEmpty).help(nativeUI("下一首", "Next")).accessibilityLabel(nativeUI("本地音频下一首", "Next local track"))
                Spacer(minLength: 6)
                if !widget.isDetail && widget.size == "medium" {
                    Image(systemName: "speaker.wave.1").font(.system(size: 9)).foregroundStyle(.secondary).padding(.trailing, 4)
                    Slider(value: $store.volume, in: 0...1).controlSize(.mini).frame(width: 64)
                        .accessibilityLabel(nativeUI("本地音频音量", "Local audio volume"))
                    Spacer(minLength: 6)
                }
                Button { store.repeatMode = store.repeatMode.nextMode } label: {
                    Image(systemName: store.repeatMode.symbol).frame(width: 28, height: 26)
                        .foregroundStyle(store.repeatMode == .off ? Color.secondary : Color.accentColor)
                }.help(store.repeatMode.label).accessibilityLabel(nativeUI("本地音频循环模式", "Local repeat mode"))
                    .accessibilityValue(store.repeatMode.label)
            }.buttonStyle(.plain)
            if widget.isDetail || widget.size == "large" {
              HStack(spacing: 6) {
                Image(systemName: "speaker.wave.1").font(.system(size: 10)).foregroundStyle(.secondary)
                Slider(value: $store.volume, in: 0...1).controlSize(.mini).accessibilityLabel(nativeUI("本地音频音量", "Local audio volume"))
            }
            }
            if let error = store.error {
                if widget.isDetail { Text(error).font(.system(size: 10)).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
                else { Button(nativeUI("查看播放问题", "Review playback issue")) { widget.expand?() }.buttonStyle(.plain).font(.system(size: 9)).foregroundStyle(.orange) }
            }
        }
    }
}
