import AppKit
import SwiftUI

struct NativeQuickFileShelfView: View {
    @ObservedObject var store: NativeQuickFileShelfStore
    @StateObject private var preview: NativeQuickFileShelfPreviewController
    var onFocus: () -> Void = {}
    init(store: NativeQuickFileShelfStore, onFocus: @escaping () -> Void = {}) {
        self.store = store; self.onFocus = onFocus
        _preview = StateObject(wrappedValue: NativeQuickFileShelfPreviewController(store: store))
    }
    var body: some View {
        ZStack {
            // Retain the actual table so returning preserves selection, scroll,
            // and keyboard position instead of constructing another list.
            fileList.opacity(preview.presented ? 0 : 1)
                .allowsHitTesting(!preview.presented).accessibilityHidden(preview.presented)
            if preview.presented { NativeQuickFileShelfPreview(controller: preview) }
        }
        .onAppear { store.setVisible(true) }
        .onDisappear { preview.close(restoreFocus: false); store.setVisible(false) }
        // The containing island owns file-URL drops for both collapsed and
        // expanded states. A second onDrop here would enqueue the same transfer.
    }
    private var fileList: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Label(nativeUI("文件暂存", "File shelf"), systemImage: "tray")
                    .font(.system(size: 14, weight: .semibold))
                Text("\(store.rows.count)/100").font(.system(size: 11)).monospacedDigit().foregroundStyle(.secondary)
                Spacer(minLength: 4)
                if store.busy { ProgressView().controlSize(.small) }
                Button { store.chooseFiles(onFocus: onFocus) } label: { Label(nativeUI("添加", "Add"), systemImage: "plus") }
                    .disabled(store.busy || !store.available || !store.loaded)
                    .help(nativeUI("添加文件或文件夹引用", "Add file or folder references"))
            }
            if !store.available {
                emptyState(title: nativeUI("当前空间不可用", "Unavailable in this space"), subtitle: nativeUI("文件暂存仅在普通本机空间中开放。", "The shelf is available outside private spaces."))
            } else if store.rows.isEmpty {
                emptyState(title: nativeUI("文件在手边，原件留在原处", "Keep files close, originals in place"), subtitle: nativeUI("拖入文件或文件夹，再从这里拖到需要的地方。", "Drop files or folders here, then drag them where you need them."))
            } else {
                NativeQuickFileShelfTable(store: store, preview: preview, onFocus: onFocus)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            if let error = store.error {
                Text(error).font(.system(size: 11)).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel(nativeUI("文件暂存错误：", "File shelf error: ") + error)
            } else if let notice = store.notice {
                Text(notice).font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 12) {
                if !store.selection.isEmpty {
                    Text(nativeUI("已选 \(store.selection.count) 项", "\(store.selection.count) selected")).font(.system(size: 11)).foregroundStyle(.secondary)
                    Button(nativeUI("预览", "Preview")) { onFocus(); preview.open() }
                        .disabled(!preview.canOpen)
                        .help(nativeUI("预览选中的文件（空格）", "Preview selected files (Space)"))
                    Button(nativeUI("复制文件", "Copy files")) { store.copySelection() }
                        .disabled(!store.canCopySelection)
                        .help(nativeUI("复制选中的文件引用（⌘C），然后在 Finder 中粘贴", "Copy selected file references (⌘C), then paste in Finder"))
                    Button(nativeUI("在 Finder 显示", "Show in Finder")) { store.revealSelection() }
                    Button(nativeUI("移除引用", "Remove references")) { store.removeSelection() }
                        .disabled(store.busy || !store.available)
                } else {
                    Text(nativeUI("仅保留引用 · 拖出复制 · 原文件不变", "References only · Drag to copy · Originals stay put"))
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                if store.canUndo { Button(nativeUI("撤销移除", "Undo removal")) { store.undoRemoval() }.disabled(store.busy || !store.available) }
                Button { store.refresh() } label: { Image(systemName: "arrow.clockwise") }
                    .help(nativeUI("检查原文件", "Check originals")).accessibilityLabel(nativeUI("检查原文件", "Check originals"))
                    .disabled(store.busy || !store.available)
            }.font(.system(size: 11)).buttonStyle(.plain)
        }
    }
    private func emptyState(title: String, subtitle: String) -> some View {
        VStack(spacing: 9) {
            Image(systemName: "tray.and.arrow.down").font(.system(size: 26, weight: .light)).foregroundStyle(.secondary)
            Text(title).font(.system(size: 13, weight: .medium))
            Text(subtitle).font(.system(size: 11)).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }.padding(.horizontal, 24).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct NativeQuickFileShelfTable: NSViewRepresentable {
    @ObservedObject var store: NativeQuickFileShelfStore
    let preview: NativeQuickFileShelfPreviewController
    var onFocus: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(store: store, onFocus: onFocus) }
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView(); scroll.hasVerticalScroller = true; scroll.drawsBackground = false
        scroll.autohidesScrollers = true; scroll.borderType = .noBorder
        let table = NativeQuickFileShelfTableView()
        let column = NSTableColumn(identifier: .init("file")); column.resizingMask = .autoresizingMask
        table.addTableColumn(column); table.headerView = nil; table.rowHeight = 47
        table.intercellSpacing = NSSize(width: 0, height: 3); table.backgroundColor = .clear
        table.allowsMultipleSelection = true; table.allowsEmptySelection = true
        table.columnAutoresizingStyle = .lastColumnOnlyAutoresizingStyle
        table.setDraggingSourceOperationMask(.copy, forLocal: true)
        table.setDraggingSourceOperationMask(.copy, forLocal: false)
        table.dataSource = context.coordinator; table.delegate = context.coordinator
        table.onFocus = onFocus
        table.onRemove = { [weak store] in store?.removeSelection() }
        table.onUndo = { [weak store] in guard let store, store.canUndo else { return false }; store.undoRemoval(); return true }
        table.canCopy = { [weak store] in store?.canCopySelection == true }
        table.onCopy = { [weak store] in store?.copySelection() ?? false }
        table.onPreview = { [weak preview] in preview?.open() ?? false }
        preview.table = table
        table.onPrepareDrag = { [weak coordinator = context.coordinator] indexes in coordinator?.prepareDrag(indexes) == true }
        table.onFinishUnstartedDrag = { [weak coordinator = context.coordinator] in coordinator?.finishUnstartedDrag() }
        table.target = context.coordinator; table.doubleAction = #selector(Coordinator.reveal)
        table.setAccessibilityLabel(nativeUI("暂存的文件，可多选并拖出复制", "Staged files. Select multiple files and drag to copy."))
        scroll.documentView = table; context.coordinator.table = table
        context.coordinator.update(); return scroll
    }
    func updateNSView(_ view: NSScrollView, context: Context) { context.coordinator.onFocus = onFocus; context.coordinator.update() }
    static func dismantleNSView(_ view: NSScrollView, coordinator: Coordinator) { coordinator.finishUnstartedDrag() }

    @MainActor final class Coordinator: NSObject, NSTableViewDataSource, NSTableViewDelegate {
        let store: NativeQuickFileShelfStore
        var onFocus: () -> Void
        weak var table: NSTableView?
        private var rows: [NativeQuickFileShelfRow] = []
        private var updating = false
        private var dragBatch: NativeQuickFileShelfCopyBatch?
        private var dragItems: [Int: NativeQuickFileShelfItem] = [:]
        private var dragURLs: [Int: URL] = [:]
        private var dragSelection = Set<String>()
        private var dragPrepared = false
        private var dragging = false
        init(store: NativeQuickFileShelfStore, onFocus: @escaping () -> Void) { self.store = store; self.onFocus = onFocus }
        func update() {
            guard let table else { return }; updating = true; defer { updating = false }
            if rows != store.rows { rows = store.rows; table.reloadData() }
            let indexes = IndexSet(rows.indices.filter { store.selection.contains(rows[$0].id) })
            if table.selectedRowIndexes != indexes { table.selectRowIndexes(indexes, byExtendingSelection: false) }
        }
        func numberOfRows(in tableView: NSTableView) -> Int { rows.count }
        func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
            guard rows.indices.contains(row) else { return nil }
            let item = rows[row]
            let cell = NativeQuickFileShelfCell()
            cell.title.stringValue = item.name
            cell.subtitle.stringValue = item.url?.deletingLastPathComponent().path ?? nativeUI("原文件不可访问 · 重新添加或移除引用", "Original unavailable · Add it again or remove the reference")
            cell.subtitle.textColor = item.available ? .secondaryLabelColor : .systemOrange
            cell.icon.image = item.url.map { NSWorkspace.shared.icon(forFile: $0.path) } ?? NSImage(systemSymbolName: "doc.badge.exclamationmark", accessibilityDescription: nil)
            cell.toolTip = item.url?.path ?? item.item.path
            cell.setAccessibilityElement(true); cell.setAccessibilityRole(.cell)
            cell.setAccessibilityLabel(item.name + (item.available ? "" : nativeUI("，原文件不可访问", ", original unavailable")))
            return cell
        }
        func tableViewSelectionDidChange(_ notification: Notification) {
            guard !updating, let table else { return }
            store.selection = Set(table.selectedRowIndexes.compactMap { rows.indices.contains($0) ? rows[$0].id : nil })
        }
        /// AppKit otherwise drops each nil writer independently and silently
        /// starts a smaller batch. Validate every participating row first.
        func prepareDrag(_ indexes: IndexSet) -> Bool {
            guard !dragging else { return false }
            releaseAccess(); dragPrepared = true
            guard store.canPrepareDrag, !indexes.isEmpty, indexes.allSatisfy({ rows.indices.contains($0) }), rows == store.rows else { return false }
            let items = indexes.map { rows[$0].item }
            do {
                let batch = try NativeQuickFileShelfCopyBatch(items: items)
                guard batch.urls.count == indexes.count else { store.rejectDrag(missing: []); return false }
                dragItems = Dictionary(uniqueKeysWithValues: zip(indexes, items))
                dragURLs = Dictionary(uniqueKeysWithValues: zip(indexes, batch.urls))
                dragSelection = store.selection; dragBatch = batch
                return true
            } catch {
                if case NativeQuickFileShelfCopyError.missing(let ids) = error { store.rejectDrag(missing: ids) }
                else { store.rejectDrag(missing: []) }
                return false
            }
        }
        func tableView(_ tableView: NSTableView, pasteboardWriterForRow row: Int) -> NSPasteboardWriting? {
            guard dragPrepared, dragBatch != nil, store.canPrepareDrag, !dragging,
                  store.selection == dragSelection, rows.indices.contains(row),
                  rows[row].item == dragItems[row], rows == store.rows else { return nil }
            return dragURLs[row].map { $0 as NSURL }
        }
        func tableView(_ tableView: NSTableView, draggingSession session: NSDraggingSession, willBeginAt screenPoint: NSPoint, forRowIndexes rowIndexes: IndexSet) {
            dragging = true
            // The system session retains its source table. Keep the coordinator
            // and security-scoped batch alive even if SwiftUI removes the page.
            (tableView as? NativeQuickFileShelfTableView)?.dragSessionOwner = self
        }
        func tableView(_ tableView: NSTableView, draggingSession session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
            dragging = false
            releaseAccess()
            (tableView as? NativeQuickFileShelfTableView)?.dragSessionOwner = nil
            // Never remove references or originals after a successful/cancelled
            // drag. Receiving apps may copy; source advertises no move operation.
        }
        func finishUnstartedDrag() { if !dragging { releaseAccess() } }
        private func releaseAccess() { dragBatch = nil; dragItems = [:]; dragURLs = [:]; dragSelection = []; dragPrepared = false }
        @objc func reveal() { store.revealSelection() }
    }
}

/// Explicit copy-only policy, including modifier keys and in-app destinations.
final class NativeQuickFileShelfTableView: NSTableView {
    var onFocus: () -> Void = {}
    var onRemove: () -> Void = {}
    var onUndo: () -> Bool = { false }
    var canCopy: () -> Bool = { false }
    var onCopy: () -> Bool = { false }
    var onPreview: () -> Bool = { false }
    var onPrepareDrag: (IndexSet) -> Bool = { _ in false }
    var onFinishUnstartedDrag: () -> Void = {}
    var dragSessionOwner: AnyObject?
    @objc func copy(_ sender: Any?) { if window?.firstResponder === self, canCopy() { _ = onCopy() } }
    override func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        item.action == #selector(copy(_:)) ? window?.firstResponder === self && canCopy() : super.validateUserInterfaceItem(item)
    }
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let modifiers = event.modifierFlags.intersection([.command, .control, .option, .shift])
        if window?.firstResponder === self, modifiers == .command, event.charactersIgnoringModifiers?.lowercased() == "c", canCopy() {
            return onCopy()
        }
        return super.performKeyEquivalent(with: event)
    }
    override func mouseDown(with event: NSEvent) {
        onFinishUnstartedDrag(); onFocus(); super.mouseDown(with: event)
        // A press that never starts a session has no ended callback.
        onFinishUnstartedDrag()
    }
    override func canDragRows(with rowIndexes: IndexSet, at mouseDownPoint: NSPoint) -> Bool {
        guard super.canDragRows(with: rowIndexes, at: mouseDownPoint) else { onFinishUnstartedDrag(); return false }
        return onPrepareDrag(rowIndexes)
    }
    override func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation { .copy }
    override func ignoreModifierKeys(for session: NSDraggingSession) -> Bool { true }
    override func keyDown(with event: NSEvent) {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if window?.firstResponder === self, flags.intersection([.command, .control, .option, .shift]).isEmpty,
           event.keyCode == 49, !event.isARepeat, onPreview() { return }
        if event.keyCode == 51 || event.keyCode == 117 { onRemove(); return }
        if flags.contains(.command), !flags.contains(.shift), event.charactersIgnoringModifiers?.lowercased() == "z", onUndo() { return }
        super.keyDown(with: event)
    }
}

private final class NativeQuickFileShelfCell: NSTableCellView {
    let title = NSTextField(labelWithString: "")
    let subtitle = NSTextField(labelWithString: "")
    let icon = NSImageView()
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        title.font = .systemFont(ofSize: 12, weight: .medium); title.lineBreakMode = .byTruncatingMiddle
        subtitle.font = .systemFont(ofSize: 10); subtitle.lineBreakMode = .byTruncatingMiddle
        icon.imageScaling = .scaleProportionallyDown
        let text = NSStackView(views: [title, subtitle]); text.orientation = .vertical; text.alignment = .leading; text.spacing = 3
        let row = NSStackView(views: [icon, text]); row.orientation = .horizontal; row.alignment = .centerY; row.spacing = 10
        row.translatesAutoresizingMaskIntoConstraints = false; addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 9), row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -9),
            row.centerYAnchor.constraint(equalTo: centerYAnchor), icon.widthAnchor.constraint(equalToConstant: 28), icon.heightAnchor.constraint(equalToConstant: 28),
            title.widthAnchor.constraint(equalTo: text.widthAnchor), subtitle.widthAnchor.constraint(equalTo: text.widthAnchor)
        ])
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}
