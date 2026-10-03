import SwiftUI

@MainActor struct NativeQuickClipboardView: View {
    @ObservedObject var store: NativeQuickClipboardStore
    @ObservedObject var pasteBack: NativeQuickClipboardPasteBack
    var onFocus: () -> Void = {}
    init(store: NativeQuickClipboardStore, pasteBack: NativeQuickClipboardPasteBack? = nil, onFocus: @escaping () -> Void = {}) {
        self.store = store; self.pasteBack = pasteBack ?? NativeQuickClipboardPasteBack(); self.onFocus = onFocus
    }
    @State private var confirmEnable = false
    @State private var confirmClear = false
    @State private var permanentIDs = Set<String>()
    @State private var confirmPermanent = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private enum Control: Hashable { case search, filter, copy(String), paste(String), favorite(String), delete(String), undo }
    @FocusState private var focusedControl: Control?
    private var active: [NativeQuickClipboardItem] { store.items.filter { $0.deletedAt == nil } }
    private var trash: [NativeQuickClipboardItem] { store.items.filter { $0.deletedAt != nil } }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Label(nativeUI("剪贴板", "Clipboard"), systemImage: "clipboard").font(.system(size: 14, weight: .semibold))
                Text(modeLabel).font(.system(size: 10)).foregroundStyle(.secondary)
                Spacer(minLength: 8)
                if store.mode == .recording {
                    Button(nativeUI("暂停", "Pause")) { Task { await store.setMode(.paused) } }.controlSize(.small)
                } else {
                    Button(store.mode == .off ? nativeUI("启用", "Enable") : nativeUI("继续记录", "Resume")) {
                        if store.mode == .off { confirmEnable = true } else { Task { await store.setMode(.recording) } }
                    }.controlSize(.small)
                }
                Menu {
                    Button(store.showingTrash ? nativeUI("返回历史", "Back to history") : nativeUI("最近删除", "Recently Deleted")) { store.showingTrash.toggle() }
                    Button(nativeUI("保留设置…", "Retention settings…")) { onFocus(); store.openRetentionSettings() }
                    Divider()
                    Button(nativeUI("关闭采集", "Turn capture off")) { Task { await store.setMode(.off) } }.disabled(store.mode == .off)
                    Button(store.showingTrash ? nativeUI("永久清空最近删除…", "Empty Recently Deleted…") : nativeUI("清空历史…", "Clear history…"), role: .destructive) {
                        if store.showingTrash { permanentIDs = Set(trash.map(\.id)); confirmPermanent = true } else { confirmClear = true }
                    }.disabled(store.showingTrash ? trash.isEmpty : active.isEmpty)
                } label: { Image(systemName: "ellipsis").frame(width: 24, height: 24) }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                    .accessibilityLabel(nativeUI("剪贴板选项", "Clipboard options"))
            }.disabled(!store.available || !store.loaded || store.busy)
            HStack(spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField(nativeUI("搜索文字与链接", "Search text and links"), text: $store.query)
                        .textFieldStyle(.plain).focused($focusedControl, equals: .search).onTapGesture { onFocus() }
                    if !store.query.isEmpty { Button { store.query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }.buttonStyle(.plain).accessibilityLabel(nativeUI("清除搜索", "Clear search")) }
                }.font(.system(size: 12)).padding(.horizontal, 9).padding(.vertical, 7)
                    .background(.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
                Picker(nativeUI("类型", "Type"), selection: $store.filter) {
                    Text(nativeUI("全部", "All")).tag(NativeQuickClipboardFilter.all)
                    Text(nativeUI("文字", "Text")).tag(NativeQuickClipboardFilter.text)
                    Text(nativeUI("图片", "Images")).tag(NativeQuickClipboardFilter.image)
                    Text(nativeUI("收藏", "Favorites")).tag(NativeQuickClipboardFilter.favorites)
                }.labelsHidden().pickerStyle(.segmented).frame(width: 220).focused($focusedControl, equals: .filter)
            }.disabled(!store.available)
            if let error = store.error { Text(error).font(.system(size: 11)).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
            else if let notice = store.notice { Text(notice).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(2) }
            if store.showingTrash {
                HStack {
                    Text(nativeUI("最近删除 · 保留 7 天，受总容量限制", "Recently Deleted · 7 days, within the storage limit")).font(.system(size: 10)).foregroundStyle(.secondary)
                    Spacer()
                    Button(nativeUI("返回历史", "Back to history")) { store.showingTrash = false }.buttonStyle(.plain).font(.system(size: 11))
                }
            }
            // The module owns exactly one scroll region. Rows have no nested
            // editors, scrollable previews, or wheel handlers.
            ScrollView {
                LazyVStack(spacing: 5) {
                    if !store.available { empty(nativeUI("解锁工作区后可查看剪贴板历史。", "Unlock the workspace to view clipboard history.")) }
                    else if !store.loaded { empty(store.error == nil ? nativeUI("正在读取本机历史…", "Loading local history…") : nativeUI("历史暂不可用。", "History is unavailable.")) }
                    else if store.filteredItems.isEmpty {
                        empty(emptyMessage)
                    } else { ForEach(store.filteredItems) { item in row(item) } }
                }.padding(.vertical, 2)
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
            if let undo = store.deletionUndo {
                HStack(spacing: 8) {
                    Text(undo.retention != nil
                         ? nativeUI("设置已更新 · 整理 \(undo.ids.count) 条", "Settings updated · \(undo.ids.count) items moved")
                         : nativeUI("已移入最近删除 · \(undo.ids.count) 条", "Moved to Recently Deleted · \(undo.ids.count)"))
                        .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                    Button(undo.retention != nil ? nativeUI("撤销设置与整理", "Undo settings & cleanup") : nativeUI("撤销", "Undo")) { onFocus(); Task { await store.undoDeletion() } }
                        .buttonStyle(.plain).fontWeight(.semibold).focused($focusedControl, equals: .undo)
                        .disabled(store.busy || !store.available)
                        .accessibilityLabel(undo.retention != nil ? nativeUI("撤销保留设置与整理", "Undo retention settings and cleanup") : nativeUI("撤销本次删除", "Undo this deletion"))
                    Button { store.dismissDeletionUndo() } label: { Image(systemName: "xmark").frame(width: 22, height: 22) }
                        .buttonStyle(.plain).foregroundStyle(.secondary)
                        .accessibilityLabel(nativeUI("关闭撤销提示", "Dismiss undo notice"))
                }.font(.system(size: 11)).padding(.horizontal, 10).padding(.vertical, 5)
                    .background(.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8))
                    .transition(.opacity)
            }
            HStack {
                Text(nativeUI("仅本机 · 不同步", "On this Mac · Not synced"))
                if !trash.isEmpty && !store.showingTrash {
                    Button(nativeUI("最近删除 (\(trash.count))", "Recently Deleted (\(trash.count))")) { store.showingTrash = true }.buttonStyle(.plain)
                }
                Spacer()
                Text("\(store.items.count) / 100 · 32 MB")
            }.font(.system(size: 9)).foregroundStyle(.secondary)
        }.padding(.horizontal, 8).padding(.top, 4).padding(.bottom, 6)
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.16), value: store.deletionUndo?.deletionID)
            .onAppear { store.setVisible(true) }.onDisappear { store.setVisible(false) }
            .sheet(isPresented: Binding(get: { store.previewID != nil && store.available }, set: { if !$0 { store.closePreview() } })) {
                NativeQuickClipboardPreviewView(store: store)
            }
            .sheet(isPresented: Binding(get: { store.retentionSettingsOpen && store.available }, set: { if !$0 { store.closeRetentionSettings() } })) {
                NativeQuickClipboardRetentionView(store: store)
            }
            .alert(nativeUI("启用本机剪贴板历史？", "Enable local clipboard history?"), isPresented: $confirmEnable) {
                Button(nativeUI("启用", "Enable")) { Task { await store.setMode(.recording) } }
                Button(nativeUI("取消", "Cancel"), role: .cancel) {}
            } message: {
                Text(nativeUI("启用后，应用运行时会记录新复制的文字和图片，不读取已有剪贴板。内容只保存在本机；带密码或敏感标记的内容会跳过。复制无标记的敏感内容前，请先暂停。", "After enabling, records newly copied text and images while the app runs, without reading the existing clipboard. History stays local; password and sensitive markers are excluded. Pause before copying unmarked sensitive information."))
            }
            .confirmationDialog(nativeUI("将全部历史移入最近删除？", "Move all history to Recently Deleted?"), isPresented: $confirmClear) {
                Button(nativeUI("移入最近删除", "Move to Recently Deleted"), role: .destructive) { Task { await store.remove(Set(active.map(\.id))) } }
                Button(nativeUI("取消", "Cancel"), role: .cancel) {}
            } message: { Text(nativeUI("包含 \(active.filter(\.isFavorite).count) 条收藏。删除后可立即撤销，或在 7 天内从最近删除恢复，受总容量限制；不会清空系统剪贴板。", "Includes \(active.filter(\.isFavorite).count) favorites. Undo immediately, or restore from Recently Deleted within 7 days, subject to the storage limit. The system clipboard is not cleared.")) }
            .confirmationDialog(nativeUI("永久删除所选记录？", "Permanently delete selected items?"), isPresented: $confirmPermanent) {
                Button(nativeUI("永久删除", "Delete permanently"), role: .destructive) { let ids = permanentIDs; Task { await store.remove(ids, permanently: true) } }
                Button(nativeUI("取消", "Cancel"), role: .cancel) {}
            }
    }
    private var emptyMessage: String {
        if !store.query.isEmpty { return nativeUI("没有匹配的记录。", "No matching items.") }
        if store.showingTrash {
            return trash.isEmpty ? nativeUI("最近删除是空的。", "Recently Deleted is empty.")
                : nativeUI("没有符合当前筛选的记录。", "No items match this filter.")
        }
        if store.mode == .off && active.isEmpty {
            return nativeUI("默认关闭。启用后记录新复制的文字、链接和图片，只保存在这台 Mac。", "Off by default. Enable to keep newly copied text, links and images on this Mac only.")
        }
        if store.filter == .favorites { return nativeUI("暂无收藏。点击记录旁的星标，方便下次找到。", "No favorites. Star an item to find it here next time.") }
        return active.isEmpty ? nativeUI("新复制的内容会出现在这里。", "Newly copied content will appear here.")
            : nativeUI("没有符合当前筛选的记录。", "No items match this filter.")
    }
    private var modeLabel: String {
        switch store.mode {
        case .off: return nativeUI("未启用", "Off")
        case .paused: return nativeUI("已暂停", "Paused")
        case .recording: return store.available ? nativeUI("记录中", "Recording") : nativeUI("已暂停", "Paused")
        }
    }
    private func empty(_ text: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: store.showingTrash ? "trash" : "clipboard").font(.system(size: 24, weight: .light)).foregroundStyle(.tertiary)
            Text(text).font(.system(size: 12)).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 320)
        }.padding(.vertical, 35).frame(maxWidth: .infinity)
    }
    private func row(_ item: NativeQuickClipboardItem) -> some View {
        HStack(alignment: .center, spacing: 10) {
            Button { Task { await store.copy(item) } } label: {
                HStack(alignment: .center, spacing: 10) {
                    if item.kind == .image {
                        Group {
                            if let image = store.thumbnails[item.id] { Image(nsImage: image).resizable().scaledToFit() }
                            else { Image(systemName: "photo").foregroundStyle(.secondary) }
                        }.frame(width: 66, height: 48).background(.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 5))
                    }
                    VStack(alignment: .leading, spacing: 5) {
                        Text(item.text ?? nativeUI("图片 · \(item.width ?? 0) × \(item.height ?? 0)", "Image · \(item.width ?? 0) × \(item.height ?? 0)"))
                            .font(.system(size: 12)).lineLimit(3).multilineTextAlignment(.leading).frame(maxWidth: .infinity, alignment: .leading)
                        Text(item.createdAt, style: .relative).font(.system(size: 9)).foregroundStyle(.secondary)
                    }
                }.contentShape(Rectangle())
            }.buttonStyle(.plain).disabled(store.busy || item.deletedAt != nil)
                .focused($focusedControl, equals: .copy(item.id))
                .accessibilityLabel(item.kind == .image ? nativeUI("再次复制图片", "Copy image again") : nativeUI("再次复制文字", "Copy text again"))
            if item.deletedAt == nil {
                if pasteBack.targetName != nil {
                Button {
                    onFocus()
                    Task {
                        let message = await pasteBack.perform(copy: { canCommit in await store.copy(item, canCommit: canCommit) },
                                                              isCopyCurrent: { store.isCopyCurrent($0) })
                        store.reportPasteNotice(message)
                    }
                } label: { Image(systemName: "arrow.up.backward.square").font(.system(size: 12)).frame(width: 26, height: 28) }
                    .buttonStyle(.plain).foregroundStyle(.secondary)
                    .focused($focusedControl, equals: .paste(item.id))
                    .help(pasteBack.actionLabel).accessibilityLabel(pasteBack.actionLabel)
                }
                Button {
                    if store.filter == .favorites && item.isFavorite { moveFocusBeforeRemoving(item, from: .favorite(item.id)) }
                    Task { await store.toggleFavorite(item) }
                } label: { Image(systemName: item.isFavorite ? "star.fill" : "star").font(.system(size: 12)).frame(width: 26, height: 28) }
                    .buttonStyle(.plain).foregroundStyle(item.isFavorite ? Color.accentColor : .secondary)
                    .focused($focusedControl, equals: .favorite(item.id))
                    .help(item.isFavorite ? nativeUI("取消收藏", "Remove favorite") : nativeUI("收藏", "Favorite"))
                    .accessibilityLabel(item.isFavorite ? nativeUI("取消收藏记录", "Unfavorite clipboard item") : nativeUI("收藏记录", "Favorite clipboard item"))
                Button { onFocus(); store.showPreview(item) } label: { Image(systemName: "eye").font(.system(size: 12)).frame(width: 28, height: 28) }
                    .buttonStyle(.plain).help(nativeUI("完整预览", "Preview full content"))
                    .accessibilityLabel(item.kind == .image ? nativeUI("预览图片", "Preview image") : nativeUI("预览完整文字", "Preview full text"))
            }
            if item.deletedAt != nil {
                Button { Task { await store.restore([item.id]) } } label: { Image(systemName: "arrow.uturn.backward").frame(width: 26, height: 28) }
                    .buttonStyle(.plain).help(nativeUI("恢复", "Restore")).accessibilityLabel(nativeUI("恢复剪贴记录", "Restore clipboard item"))
            }
            Button {
                if item.deletedAt != nil { permanentIDs = [item.id]; confirmPermanent = true }
                else { moveFocusBeforeRemoving(item, from: .delete(item.id)); Task { await store.remove([item.id]) } }
            } label: { Image(systemName: item.deletedAt == nil ? "trash" : "xmark").font(.system(size: 11)).foregroundStyle(.secondary).frame(width: 26, height: 28) }
                .buttonStyle(.plain).accessibilityLabel(item.deletedAt == nil ? nativeUI("删除剪贴记录", "Delete clipboard item") : nativeUI("永久删除剪贴记录", "Permanently delete clipboard item"))
                .focused($focusedControl, equals: .delete(item.id))
        }.padding(10).background(.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 9))
            .disabled(store.busy || pasteBack.busy).task(id: item.id) { await store.loadThumbnail(item) }
    }
    private func moveFocusBeforeRemoving(_ item: NativeQuickClipboardItem, from control: Control) {
        guard focusedControl == control, let index = store.filteredItems.firstIndex(where: { $0.id == item.id }) else { return }
        let rows = store.filteredItems
        let neighbor = index + 1 < rows.count ? rows[index + 1] : index > 0 ? rows[index - 1] : nil
        // Set only keyboard focus owned by the disappearing control, before
        // the await. A user's later click in another field must always win.
        focusedControl = neighbor.map { .copy($0.id) } ?? .filter
    }
}

/// A native form/impact preview, not an implicit capture permission prompt.
struct NativeQuickClipboardRetentionView: View {
    @ObservedObject var store: NativeQuickClipboardStore
    @Environment(\.colorScheme) private var colorScheme
    @State private var policy: NativeQuickClipboardRetention
    init(store: NativeQuickClipboardStore) { self.store = store; _policy = State(initialValue: store.retentionPolicy) }
    private func size(_ bytes: Int) -> String { ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .binary) }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(nativeUI("保留设置", "Retention settings")).font(.system(size: 15, weight: .semibold))
            Text(nativeUI("只整理未收藏的历史，不改变采集开关。", "Organizes nonfavorite history without changing capture.")).font(.system(size: 12)).foregroundStyle(.secondary)
            VStack(spacing: 13) {
                Picker(nativeUI("保留天数", "Keep history for"), selection: Binding(get: { policy.days ?? 0 }, set: { policy.days = $0 == 0 ? nil : $0 })) {
                    Text(nativeUI("不限天数", "No age limit")).tag(0)
                    ForEach([1,7,30,90], id: \.self) { days in Text(nativeUI("\(days) 天", "\(days) days")).tag(days) }
                }
                Picker(nativeUI("未收藏条数", "Nonfavorite items"), selection: $policy.itemLimit) {
                    ForEach([10,25,50,100], id: \.self) { count in Text(nativeUI("最多 \(count) 条", "Up to \(count)")).tag(count) }
                }
            }.pickerStyle(.menu).font(.system(size: 12)).disabled(store.busy)
            VStack(alignment: .leading, spacing: 8) {
                if let preview = store.retentionPreview, preview.policy == policy {
                    Text(nativeUI("将移至最近删除 \(preview.ids.count) 条 · 内容 \(size(preview.bytes))", "Move \(preview.ids.count) items to Recently Deleted · \(size(preview.bytes)) of content"))
                        .font(.system(size: 13, weight: .medium)).fixedSize(horizontal: false, vertical: true)
                    Text(nativeUI("保留 \(preview.favoriteCount) 条收藏 · 当前内容共 \(size(preview.totalBytes))", "Keep \(preview.favoriteCount) favorites · \(size(preview.totalBytes)) of content in history"))
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                } else if store.retentionLoading { ProgressView(nativeUI("计算影响…", "Calculating impact…")).controlSize(.small) }
                else {
                    Button(nativeUI("重新预览影响", "Preview impact again")) { Task { await store.prepareRetention(policy) } }.disabled(store.busy)
                }
                if let error = store.retentionError { Text(error).font(.system(size: 11)).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(12).background(.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 9))
            Text(nativeUI("移动不会立即释放空间，可从最近删除恢复。后续新采集会再次按此规则整理。收藏、历史和最近删除仍共用 100 条 / 32 MiB 上限；最近删除最多保留 7 天。", "Moving items does not immediately free space; restore them from Recently Deleted. New captures apply this policy again. Favorites, history and Trash still share the 100-item / 32 MiB limit. Trash lasts up to 7 days."))
                .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                Button(nativeUI("恢复默认选项", "Use defaults")) { policy = .legacy }.buttonStyle(.plain).disabled(store.busy)
                Spacer()
                Button(nativeUI("取消", "Cancel")) { store.closeRetentionSettings() }.keyboardShortcut(.cancelAction).disabled(store.busy)
                Button(nativeUI("应用并整理", "Apply and organize")) { Task { await store.applyRetention() } }
                    .keyboardShortcut(.defaultAction).disabled(store.busy || store.retentionLoading || store.retentionPreview?.policy != policy)
            }.font(.system(size: 12))
        }.padding(22).frame(width: 490)
            .preferredColorScheme(colorScheme)
            .task(id: policy) { await store.prepareRetention(policy) }
    }
}

struct NativeQuickClipboardPreviewView: View {
    @ObservedObject var store: NativeQuickClipboardStore
    @Environment(\.colorScheme) private var colorScheme
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(store.previewItem?.kind == .image ? nativeUI("图片预览", "Image preview") : nativeUI("文字预览", "Text preview")).font(.system(size: 14, weight: .semibold))
                Spacer()
                if let item = store.previewItem {
                    Text(item.kind == .image ? "\(item.width ?? 0) × \(item.height ?? 0)" : nativeUI("\(item.bytes) 字节", "\(item.bytes) bytes")).font(.system(size: 11)).foregroundStyle(.secondary)
                }
            }
            Group {
                if !store.available || store.previewID == nil { Color.clear }
                else if store.previewLoading { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) }
                else if let error = store.previewError {
                    Text(error).font(.system(size: 12)).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(24).frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let text = store.previewText {
                    NativeQuickClipboardPreviewText(text: text)
                } else if let image = store.previewImage {
                    GeometryReader { geometry in
                        Image(nsImage: image).resizable().scaledToFit().frame(width: geometry.size.width, height: geometry.size.height)
                            .accessibilityLabel(nativeUI("原始剪贴图片，适配预览区域", "Original clipboard image, fitted to the preview"))
                    }
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 8))
            HStack {
                if store.previewItem?.kind == .text { Text(nativeUI("可选取文字复制", "Select text to copy a passage")).font(.system(size: 11)).foregroundStyle(.secondary) }
                Spacer()
                Button(nativeUI("关闭", "Close")) { store.closePreview() }.keyboardShortcut(.cancelAction)
                Button(nativeUI("复制", "Copy")) { if let item = store.previewItem { Task { await store.copy(item) } } }
                    .disabled(!store.available || store.busy || store.previewLoading || store.previewError != nil || store.previewItem == nil)
            }
        }.padding(20).frame(width: 620, height: 430)
            // A SwiftUI environment override alone does not theme AppKit's
            // separate sheet window. Keep its native chrome and content in the
            // same scheme; edge mode inherits the system's current preference.
            .preferredColorScheme(colorScheme)
    }
}

/// A single read-only native scroll surface keeps 256 KiB text selectable and
/// wrapped without building one SwiftUI view per line or truncating the content.
struct NativeQuickClipboardPreviewText: NSViewRepresentable {
    let text: String
    @Environment(\.colorScheme) private var colorScheme
    private func applyAppearance(_ scroll: NSScrollView, textView: NSTextView) {
        let appearance = NSAppearance(named: colorScheme == .dark ? .darkAqua : .aqua)
        scroll.appearance = appearance
        textView.appearance = appearance
        textView.textColor = .labelColor
    }
    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView(); scroll.drawsBackground = false; scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true
        let view = NSTextView(frame: NSRect(x: 0, y: 0, width: 560, height: 300))
        view.isEditable = false; view.isSelectable = true; view.drawsBackground = false
        view.font = .systemFont(ofSize: 13); view.textColor = .labelColor; view.textContainerInset = NSSize(width: 12, height: 12)
        view.isVerticallyResizable = true; view.isHorizontallyResizable = false; view.autoresizingMask = [.width]
        view.minSize = NSSize(width: 0, height: 300); view.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        view.textContainer?.widthTracksTextView = true; view.textContainer?.containerSize = NSSize(width: 560, height: CGFloat.greatestFiniteMagnitude)
        view.layoutManager?.allowsNonContiguousLayout = true; view.string = text
        view.setAccessibilityLabel(nativeUI("完整剪贴文字，可选取", "Full clipboard text, selectable"))
        scroll.documentView = view; applyAppearance(scroll, textView: view); return scroll
    }
    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let view = scroll.documentView as? NSTextView else { return }
        applyAppearance(scroll, textView: view)
        if view.string != text { view.string = text }
    }
    static func dismantleNSView(_ scroll: NSScrollView, coordinator: ()) { (scroll.documentView as? NSTextView)?.string = "" }
}
