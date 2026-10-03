import AppKit
import SwiftUI
import Combine
import Quartz

/// The access lease outlives Quick Look's asynchronous rendering, and is only
/// released after its view has closed. No preview copies or opens the original.
@MainActor final class NativeQuickFileShelfPreviewResource: Identifiable {
    let id = UUID()
    let item: NativeQuickFileShelfItem
    let url: URL
    private var lease: NativeQuickFileShelfCopyBatch?
    private weak var host: NativeQuickFileShelfQuickLookView?
    private(set) var isValid = true
    init(item: NativeQuickFileShelfItem, batch: NativeQuickFileShelfCopyBatch) {
        self.item = item; url = batch.urls[0]; lease = batch
    }
    func attach(_ host: NativeQuickFileShelfQuickLookView) -> Bool {
        guard isValid, lease != nil, self.host == nil else { return false }
        self.host = host; return true
    }
    func invalidate() {
        isValid = false
        // A mounted host owns teardown. Keep access until it detaches/closes QL.
        if host == nil { lease = nil }
    }
    func didDetach(_ host: NativeQuickFileShelfQuickLookView) {
        guard self.host === host else { return }
        self.host = nil; isValid = false; lease = nil
    }
}

/// One explicit selection snapshot. A later selection, hidden page, private
/// space, or removed reference invalidates it, including an in-flight resolve.
@MainActor final class NativeQuickFileShelfPreviewController: ObservableObject {
    @Published private(set) var presented = false
    @Published private(set) var loading = false
    @Published private(set) var index = 0
    @Published private(set) var resource: NativeQuickFileShelfPreviewResource?
    @Published private(set) var issue: String?
    private(set) var items: [NativeQuickFileShelfItem] = []
    weak var table: NSTableView?
    private weak var store: NativeQuickFileShelfStore?
    private var subscriptions = Set<AnyCancellable>()
    private var work: Task<Void, Never>?
    private var generation: UInt64 = 0
    private let resolve: @Sendable ([NativeQuickFileShelfItem]) async throws -> NativeQuickFileShelfCopyBatch
    init(store: NativeQuickFileShelfStore,
         resolve: @escaping @Sendable ([NativeQuickFileShelfItem]) async throws -> NativeQuickFileShelfCopyBatch = { try await NativeQuickFileShelfCopyBatch.resolve($0) }) {
        self.store = store; self.resolve = resolve
        store.$visible.sink { [weak self] value in if !value { self?.close(restoreFocus: false) } }.store(in: &subscriptions)
        store.$available.sink { [weak self] value in if !value { self?.close(restoreFocus: false) } }.store(in: &subscriptions)
        store.$selection.sink { [weak self] selection in
            guard let self, self.presented else { return }
            if selection != Set(self.items.map(\.id)) { self.close(restoreFocus: false) }
        }.store(in: &subscriptions)
        store.$rows.sink { [weak self] rows in
            guard let self, self.presented else { return }
            if !self.items.allSatisfy({ item in rows.contains { $0.item == item } }) { self.close(restoreFocus: false) }
        }.store(in: &subscriptions)
    }
    deinit { work?.cancel() }
    var canOpen: Bool { store?.canCopySelection == true }
    var currentName: String { resource?.url.lastPathComponent ?? (items.indices.contains(index) ? items[index].name : "") }
    var count: Int { items.count }
    var canGoBack: Bool { presented && index > 0 }
    var canGoForward: Bool { presented && index + 1 < items.count }
    @discardableResult func open() -> Bool {
        guard let store, canOpen else { return false }
        close(restoreFocus: false)
        items = store.rows.filter { store.selection.contains($0.id) }.map(\.item)
        guard !items.isEmpty else { return false }
        // The table stays mounted for exact scroll restoration, but must not
        // keep handling Delete/arrow keys while its rows are visually hidden.
        if let table, table.window?.firstResponder === table { table.window?.makeFirstResponder(nil) }
        presented = true; select(0); return true
    }
    func move(_ offset: Int) {
        guard presented, items.indices.contains(index + offset) else { return }
        select(index + offset)
    }
    private func contextIsCurrent() -> Bool {
        guard let store, store.available, store.visible, store.loaded, presented,
              store.selection == Set(items.map(\.id)) else { return false }
        return items.allSatisfy { item in store.rows.contains { $0.item == item } }
    }
    private func select(_ next: Int) {
        generation &+= 1; let token = generation
        work?.cancel(); resource?.invalidate(); resource = nil; issue = nil
        index = next; loading = true
        let item = items[next]
        work = Task { @MainActor [weak self, resolve] in
            do {
                // Re-resolve on each navigation, never reuse a cached path.
                let batch = try await resolve([item])
                guard let self, self.generation == token, self.contextIsCurrent(), !Task.isCancelled else { return }
                self.loading = false; self.work = nil
                guard batch.urls.count == 1 else { self.showUnavailable(item); return }
                self.resource = NativeQuickFileShelfPreviewResource(item: item, batch: batch)
            } catch {
                guard let self, self.generation == token, self.contextIsCurrent(), !Task.isCancelled else { return }
                self.loading = false; self.work = nil; self.showUnavailable(item)
            }
        }
    }
    private func showUnavailable(_ item: NativeQuickFileShelfItem) {
        resource?.invalidate(); resource = nil
        issue = nativeUI("原文件不可访问，无法预览。可查看其他选中项，或返回后重新添加原件。", "The original is unavailable. Preview another selected item, or go back and add the original again.")
        store?.referenceUnavailable(item.id)
    }
    func close(restoreFocus: Bool = true) {
        let wasPresented = presented, savedSelection = Set(items.map(\.id))
        generation &+= 1; let token = generation
        work?.cancel(); work = nil; resource?.invalidate(); resource = nil
        presented = false; loading = false; issue = nil; items = []; index = 0
        guard wasPresented, restoreFocus else { return }
        // The retained table keeps selection and scroll. Defer only until the
        // overlay is removed; never activate an app or steal another window.
        DispatchQueue.main.async { [weak self] in
            guard let self, self.generation == token, !self.presented,
                  let store = self.store, store.available, store.visible,
                  store.selection == savedSelection, let table = self.table,
                  let window = table.window, window.isKeyWindow else { return }
            window.makeFirstResponder(table)
        }
    }
}

struct NativeQuickFileShelfPreview: View {
    @ObservedObject var controller: NativeQuickFileShelfPreviewController
    @FocusState private var backFocused: Bool
    var body: some View {
        VStack(spacing: 12) {
            HStack(spacing: 10) {
                Button { controller.close() } label: { Label(nativeUI("返回", "Back"), systemImage: "chevron.left") }
                    .focused($backFocused)
                    .help(nativeUI("返回文件列表（空格 / Esc）", "Back to files (Space / Esc)"))
                    .accessibilityLabel(nativeUI("关闭预览并返回文件列表", "Close preview and return to files"))
                Text(controller.currentName).font(.system(size: 13, weight: .medium)).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 4)
                Text("\(controller.index + 1) / \(controller.count)").monospacedDigit().font(.system(size: 11)).foregroundStyle(.secondary)
                Button { controller.move(-1) } label: { Image(systemName: "chevron.left") }
                    .disabled(!controller.canGoBack).accessibilityLabel(nativeUI("预览上一项", "Preview previous item"))
                Button { controller.move(1) } label: { Image(systemName: "chevron.right") }
                    .disabled(!controller.canGoForward).accessibilityLabel(nativeUI("预览下一项", "Preview next item"))
            }.buttonStyle(.plain)
            if controller.loading {
                ProgressView(nativeUI("正在读取预览…", "Loading preview…")).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let resource = controller.resource {
                if resource.item.isDirectory {
                    VStack(spacing: 12) {
                        Image(systemName: "folder").font(.system(size: 42)).foregroundStyle(.secondary)
                        Text(resource.url.lastPathComponent).font(.headline).textSelection(.enabled)
                        Text(nativeUI("文件夹 · 原件留在原处", "Folder · Original stays in place")).foregroundStyle(.secondary)
                        Text(resource.url.deletingLastPathComponent().path).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                    }.frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    NativeQuickFileShelfQuickLook(resource: resource).id(resource.id)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else {
                VStack(spacing: 12) {
                    Image(systemName: "doc.badge.exclamationmark").font(.system(size: 30)).foregroundStyle(.secondary)
                    Text(controller.issue ?? nativeUI("无法预览此文件", "This file could not be previewed"))
                        .font(.callout).multilineTextAlignment(.center).frame(maxWidth: 380)
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(NativeQuickFileShelfPreviewKeys(controller: controller).frame(width: 0, height: 0))
        .onAppear { backFocused = true }
        .onExitCommand { controller.close() }
    }
}

struct NativeQuickFileShelfQuickLook: NSViewRepresentable {
    let resource: NativeQuickFileShelfPreviewResource
    func makeNSView(context: Context) -> NativeQuickFileShelfQuickLookView {
        NativeQuickFileShelfQuickLookView(resource: resource)
    }
    func updateNSView(_ view: NativeQuickFileShelfQuickLookView, context: Context) {}
    static func dismantleNSView(_ view: NativeQuickFileShelfQuickLookView, coordinator: ()) { view.dismantle() }
}

/// QLPreviewView.close is terminal. One host owns it; controller invalidation
/// must never close a view still mounted in SwiftUI or close it a second time.
@MainActor final class NativeQuickFileShelfQuickLookView: NSView {
    private var preview: QLPreviewView?
    private var resource: NativeQuickFileShelfPreviewResource?
    private var dismantled = false
    init(resource: NativeQuickFileShelfPreviewResource,
         makePreview: () -> QLPreviewView? = { QLPreviewView(frame: .zero, style: .normal) }) {
        super.init(frame: .zero)
        guard resource.attach(self) else { return }
        self.resource = resource
        guard let view = makePreview() else { resource.didDetach(self); self.resource = nil; return }
        preview = view
        view.autostarts = false; view.shouldCloseWithWindow = false
        view.translatesAutoresizingMaskIntoConstraints = false
        addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: leadingAnchor), view.trailingAnchor.constraint(equalTo: trailingAnchor),
            view.topAnchor.constraint(equalTo: topAnchor), view.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])
        view.previewItem = resource.url as NSURL
        view.setAccessibilityLabel(nativeUI("文件预览", "File preview"))
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    func dismantle() {
        guard !dismantled else { return }; dismantled = true
        if let view = preview {
            if let responder = window?.firstResponder as? NSView,
               responder === view || responder.isDescendant(of: view) { window?.makeFirstResponder(nil) }
            view.removeFromSuperview()
            view.close()
        }
        preview = nil
        resource?.didDetach(self); resource = nil
    }
}

/// Quick Look's descendants can own first responder. A local, window-scoped
/// handler closes only this active inline preview; no global keyboard monitor.
private struct NativeQuickFileShelfPreviewKeys: NSViewRepresentable {
    let controller: NativeQuickFileShelfPreviewController
    func makeNSView(context: Context) -> NativeQuickFileShelfPreviewKeyView { NativeQuickFileShelfPreviewKeyView(controller: controller) }
    func updateNSView(_ view: NativeQuickFileShelfPreviewKeyView, context: Context) {}
    static func dismantleNSView(_ view: NativeQuickFileShelfPreviewKeyView, coordinator: ()) { view.stop() }
}
final class NativeQuickFileShelfPreviewKeyView: NSView {
    private weak var controller: NativeQuickFileShelfPreviewController?
    private var monitor: Any?
    init(controller: NativeQuickFileShelfPreviewController) { self.controller = controller; super.init(frame: .zero) }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow(); stop()
        guard window != nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            MainActor.assumeIsolated {
                guard let self, let controller = self.controller, controller.presented,
                      let window = self.window, event.window === window else { return event }
                let modifiers = event.modifierFlags.intersection([.command, .control, .option, .shift])
                guard modifiers.isEmpty, event.keyCode == 53 || event.keyCode == 49 else { return event }
                if !event.isARepeat { controller.close() }
                return nil
            }
        }
    }
    func stop() { if let monitor { NSEvent.removeMonitor(monitor) }; monitor = nil }
    deinit { if let monitor { NSEvent.removeMonitor(monitor) } }
}
