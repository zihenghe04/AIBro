import AppKit
import Combine
import CryptoKit

// Behavior reference: TO-DO Panel (MIT), commit 1deb3cac1e32599f13b1d6b30a7e52af76f67efd.
// Attribution: docs/licenses/to-do-panel-MIT.txt. Native implementation uses
// changeCount rather than reading old clipboard contents to establish a baseline.
enum NativeQuickClipboardMode: String, Codable { case off, paused, recording }
enum NativeQuickClipboardKind: String, Codable { case text, image }
enum NativeQuickClipboardFilter: String { case all, text, image, favorites }
struct NativeQuickClipboardItem: Codable, Equatable, Identifiable {
    var id: String
    var kind: NativeQuickClipboardKind
    var text: String?
    var bytes: Int
    var width: Int?
    var height: Int?
    var createdAt: Date
    var deletedAt: Date?
    // Optional additions preserve version-1 archives without a migration.
    var favorite: Bool?
    var deletionID: String?
    var isFavorite: Bool { favorite == true }
}
struct NativeQuickClipboardDeletionUndo: Equatable {
    let deletionID: String
    var ids: Set<String>
    let expiresAt: Date
    var retention: NativeQuickClipboardRetentionReceipt? = nil
}
struct NativeQuickClipboardUndoResult {
    let state: NativeQuickClipboardState
    let restoredIDs: Set<String>
}
struct NativeQuickClipboardState: Codable {
    var version = 1
    var mode: NativeQuickClipboardMode = .off
    var items: [NativeQuickClipboardItem] = []
    var retention: NativeQuickClipboardRetention? = nil
    var retentionPolicy: NativeQuickClipboardRetention { retention ?? .legacy }
    func retentionStamp() throws -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return SHA256.hash(data: try encoder.encode(self)).map { String(format: "%02x", $0) }.joined()
    }
}
struct NativeQuickClipboardRetention: Codable, Equatable, Hashable {
    // nil keeps the old age-unlimited behavior; the total hard budget remains
    // 100 items INCLUDING favorites and Trash, not 100 plus favorites.
    var days: Int?
    var itemLimit: Int
    static let legacy = Self(days: nil, itemLimit: 100)
    var valid: Bool { (days == nil || [1,7,30,90].contains(days!)) && [10,25,50,100].contains(itemLimit) }
    func candidates(in items: [NativeQuickClipboardItem], at now: Date) -> [NativeQuickClipboardItem] {
        let cutoff = days.map { now.addingTimeInterval(-Double($0) * 24 * 60 * 60) }
        let ordinary = items.filter { $0.deletedAt == nil && !$0.isFavorite }
        return ordinary.enumerated().compactMap { index,item in
            index >= itemLimit || cutoff.map { item.createdAt < $0 } == true ? item : nil
        }
    }
}
struct NativeQuickClipboardRetentionPreview: Equatable {
    let policy: NativeQuickClipboardRetention
    let stamp: String
    let at: Date
    let ids: Set<String>
    let bytes: Int
    let totalBytes: Int
    let favoriteCount: Int
}
struct NativeQuickClipboardRetentionReceipt: Equatable {
    let previousPolicy: NativeQuickClipboardRetention?
    let previousItems: [NativeQuickClipboardItem]
    let afterStamp: String
    let deletionID: String
    let at: Date
}
struct NativeQuickClipboardRetentionResult {
    let state: NativeQuickClipboardState
    let receipt: NativeQuickClipboardRetentionReceipt
}
/// Authorization is checked again after expensive image processing. Revocation
/// and the bounded disk commit share a lock; a revoked capture cannot commit.
final class NativeQuickClipboardCaptureGate: @unchecked Sendable {
    private let lock = NSLock()
    private var valid = true
    func revoke() { lock.lock(); valid = false; lock.unlock() }
    func commit<T>(_ body: () throws -> T) throws -> T {
        lock.lock(); defer { lock.unlock() }
        guard valid else { throw CancellationError() }
        return try body()
    }
}
struct NativeQuickClipboardPayload { let kind: NativeQuickClipboardKind; let data: Data }
struct NativeQuickClipboardPreviewPayload {
    let text: String?
    let image: CGImage?
    static let maximumImageEdge = 1600
}
enum NativeQuickClipboardError: Error, Equatable { case unsafePath, corrupt, tooLarge, unsupported, writeFailed, protectedCapacity, undoUnavailable, retentionChanged }

@MainActor protocol NativeQuickClipboardPasteboard: AnyObject {
    var changeCount: Int { get }
    var types: [String] { get }
    func data(forType type: String) -> Data?
    func write(_ payload: NativeQuickClipboardPayload) -> Bool
}
@MainActor final class NativeQuickSystemClipboard: NativeQuickClipboardPasteboard {
    private var board: NSPasteboard { .general }
    var changeCount: Int { board.changeCount }
    var types: [String] { (board.pasteboardItems ?? []).flatMap { $0.types.map(\.rawValue) } }
    func data(forType type: String) -> Data? { board.data(forType: .init(type)) }
    func write(_ payload: NativeQuickClipboardPayload) -> Bool {
        let item = NSPasteboardItem()
        guard item.setData(payload.data, forType: payload.kind == .text ? .string : .png),
              item.setString("AI Bro", forType: .init(NativeQuickClipboardPolicy.ownMarker)) else { return false }
        board.clearContents()
        return board.writeObjects([item])
    }
}
enum NativeQuickClipboardPolicy {
    static let ownMarker = "app.aibro.clipboard.self-write"
    static let maxTextBytes = 256 * 1024
    static let maxInputImageBytes = 16 * 1024 * 1024
    static let maxImageBytes = 8 * 1024 * 1024
    static let maxDiskBytes = 32 * 1024 * 1024
    static let maxItems = 100
    static let undoLifetime: TimeInterval = 5
    static let textType = NSPasteboard.PasteboardType.string.rawValue
    static let imageTypes = [NSPasteboard.PasteboardType.png.rawValue, NSPasteboard.PasteboardType.tiff.rawValue, "public.jpeg"]
    static func excluded(_ types: [String]) -> Bool {
        types.contains { value in
            let type = value.lowercased()
            return type == ownMarker || ["concealed", "transient", "autogenerated", "password", "sensitive", "com.agilebits.onepassword"].contains { type.contains($0) }
        }
    }
    static func fingerprint(_ payload: NativeQuickClipboardPayload) -> String {
        var bytes = Data(payload.kind.rawValue.utf8); bytes.append(0); bytes.append(payload.data)
        return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
    static func sensitiveText(_ text: String) -> Bool {
        // Public pasteboard markers remain the primary protection. Unmarked
        // arbitrary passwords cannot be reliably inferred from plain text.
        text.contains("-----BEGIN PRIVATE KEY-----") || text.contains("-----BEGIN RSA PRIVATE KEY-----") || text.contains("-----BEGIN OPENSSH PRIVATE KEY-----")
    }
}

@MainActor final class NativeQuickClipboardStore: ObservableObject {
    @Published private(set) var mode: NativeQuickClipboardMode = .off
    @Published private(set) var items: [NativeQuickClipboardItem] = []
    @Published private(set) var loaded = false
    @Published private(set) var busy = false
    @Published private(set) var available = false
    @Published private(set) var notice: String?
    @Published private(set) var error: String?
    @Published private(set) var thumbnails: [String: NSImage] = [:]
    @Published private(set) var previewID: String?
    @Published private(set) var previewText: String?
    @Published private(set) var previewImage: NSImage?
    @Published private(set) var previewLoading = false
    @Published private(set) var previewError: String?
    @Published private(set) var deletionUndo: NativeQuickClipboardDeletionUndo?
    @Published private(set) var retentionPolicy = NativeQuickClipboardRetention.legacy
    @Published private(set) var retentionSettingsOpen = false
    @Published private(set) var retentionPreview: NativeQuickClipboardRetentionPreview?
    @Published private(set) var retentionLoading = false
    @Published private(set) var retentionError: String?
    @Published var query = ""
    @Published var showingTrash = false
    @Published var filter: NativeQuickClipboardFilter = .all
    private let pasteboard: NativeQuickClipboardPasteboard
    private let archive: NativeQuickClipboardArchive
    private let schedulesPolling: Bool
    private let payloadRead: (String) async throws -> NativeQuickClipboardPayload
    private let retentionPreviewRead: (NativeQuickClipboardRetention, Date) async throws -> NativeQuickClipboardRetentionPreview
    private let previewRead: (String) async throws -> NativeQuickClipboardPreviewPayload
    private var previewGeneration = 0
    private var retentionGeneration = 0
    private var retentionSession = 0
    private var previewTask: Task<Void, Never>?
    private var lastCount: Int?
    private var copyReceipt: (count: Int, generation: Int)?
    private var generation = 0
    private var polling: Task<Void, Never>?
    private var loadingTask: Task<Void, Never>?
    private var captureInFlight = false
    private var captureGate: NativeQuickClipboardCaptureGate?
    private var requestedThumbnails = Set<String>()
    private var visible = false
    private var modePersistenceFailed = false
    private var mutationGate: NativeQuickClipboardCaptureGate?
    private var undoExpiryTask: Task<Void, Never>?
    private let now: () -> Date
    init(directory: URL, pasteboard: NativeQuickClipboardPasteboard? = nil, schedulesPolling: Bool = true,
         previewRead: ((String) async throws -> NativeQuickClipboardPreviewPayload)? = nil,
         payloadRead: ((String) async throws -> NativeQuickClipboardPayload)? = nil,
         retentionPreviewRead: ((NativeQuickClipboardRetention, Date) async throws -> NativeQuickClipboardRetentionPreview)? = nil,
         now: @escaping () -> Date = Date.init) {
        self.pasteboard = pasteboard ?? NativeQuickSystemClipboard()
        let archive = NativeQuickClipboardArchive(directory: directory)
        self.archive = archive
        self.previewRead = previewRead ?? { id in try await archive.preview(id: id) }
        self.payloadRead = payloadRead ?? { id in try await archive.payload(id: id) }
        self.retentionPreviewRead = retentionPreviewRead ?? { policy, date in try await archive.previewRetention(policy, now: date) }
        self.schedulesPolling = schedulesPolling
        self.now = now
        loadingTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do { let state = try await archive.load(); apply(state); loaded = true; reconcileMonitoring() }
            catch { self.error = nativeUI("无法读取本机剪贴板历史，原文件未被覆盖。", "Could not read local clipboard history. Existing files were not overwritten.") }
        }
    }
    deinit { polling?.cancel(); loadingTask?.cancel(); previewTask?.cancel(); undoExpiryTask?.cancel(); mutationGate?.revoke() }
    var previewItem: NativeQuickClipboardItem? { items.first { $0.id == previewID && $0.deletedAt == nil } }
    var filteredItems: [NativeQuickClipboardItem] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return items.filter { item in
            (showingTrash == (item.deletedAt != nil)) && (filter == .all || filter == .favorites && item.isFavorite || filter.rawValue == item.kind.rawValue) &&
                (needle.isEmpty || (item.text ?? nativeUI("图片", "Image")).localizedStandardContains(needle))
        }
    }
    func setAvailable(_ value: Bool) {
        guard value != available else { return }; available = value; reconcileMonitoring()
        if !value { mutationGate?.revoke(); mutationGate = nil; dismissDeletionUndo(); closePreview(); closeRetentionSettings(); items = []; thumbnails.removeAll(); requestedThumbnails.removeAll(); query = ""; notice = nil; error = nil }
        else if loaded {
            let token = generation
            Task { @MainActor [weak self] in
                guard let self else { return }
                do { let state = try await archive.load(); guard available, generation == token else { return }; apply(state) }
                catch { guard available else { return }; self.error = nativeUI("无法读取本机剪贴板历史。", "Could not load local clipboard history.") }
            }
        }
    }
    func setVisible(_ value: Bool) {
        visible = value
        if !value { closePreview(); closeRetentionSettings(); thumbnails.removeAll(); requestedThumbnails.removeAll() }
    }
    func shutdown() { setAvailable(false); captureGate?.revoke(); captureGate = nil; loadingTask?.cancel() }
    func setMode(_ value: NativeQuickClipboardMode) async {
        guard loaded, !busy, available else { return }
        captureGate?.revoke(); captureGate = nil
        generation += 1; polling?.cancel(); polling = nil; lastCount = nil; busy = true
        defer { busy = false; reconcileMonitoring() }
        do { let state = try await archive.setMode(value); modePersistenceFailed = false; apply(state); error = nil; notice = value == .recording ? nativeUI("已开始记录之后新复制的内容。", "Recording newly copied content from now on.") : nativeUI("已停止采集；已有历史保留在本机。", "Capture stopped. Existing history stays on this Mac.") }
        catch { self.error = nativeUI("未能保存采集设置，当前已停止采集。", "Could not save capture settings. Capture has stopped."); modePersistenceFailed = true; mode = .paused }
    }
    private func apply(_ state: NativeQuickClipboardState) {
        mode = modePersistenceFailed ? .paused : state.mode; items = available ? state.items : []
        retentionPolicy = state.retentionPolicy
        let stamp = try? state.retentionStamp()
        if let preview = retentionPreview, preview.stamp != stamp {
            retentionPreview = nil
            retentionError = nativeUI("历史已变化，请重新预览并确认。", "History changed. Preview again before confirming.")
        }
        let ids = Set(items.map(\.id)); thumbnails = thumbnails.filter { ids.contains($0.key) }
        if previewID != nil && previewItem == nil { closePreview() }
        if var undo = deletionUndo {
            if let receipt = undo.retention {
                if receipt.afterStamp != stamp { dismissDeletionUndo() }
                return
            }
            undo.ids.formIntersection(items.filter { $0.deletedAt != nil && $0.deletionID == undo.deletionID }.map(\.id))
            if undo.ids.isEmpty { dismissDeletionUndo() } else { deletionUndo = undo }
        }
    }
    func openRetentionSettings() {
        guard loaded, available, !busy else { return }
        closePreview(); retentionSession += 1; retentionSettingsOpen = true; retentionPreview = nil; retentionError = nil
    }
    func closeRetentionSettings() {
        retentionGeneration += 1; retentionSession += 1; retentionSettingsOpen = false
        retentionPreview = nil; retentionLoading = false; retentionError = nil
    }
    func prepareRetention(_ policy: NativeQuickClipboardRetention) async {
        guard available, loaded, retentionSettingsOpen else { return }
        retentionGeneration += 1; let request = retentionGeneration, token = generation
        retentionPreview = nil; retentionLoading = true; retentionError = nil
        defer { if request == retentionGeneration { retentionLoading = false } }
        do {
            let preview = try await retentionPreviewRead(policy, now())
            guard available, retentionSettingsOpen, request == retentionGeneration, token == generation, !Task.isCancelled else { return }
            retentionPreview = preview
        } catch {
            guard available, retentionSettingsOpen, request == retentionGeneration, token == generation, !Task.isCancelled else { return }
            retentionError = nativeUI("无法预览保留设置，已有历史未改变。", "Could not preview retention settings. History is unchanged.")
        }
    }
    func applyRetention() async {
        guard available, loaded, !busy, retentionSettingsOpen, let preview = retentionPreview else { return }
        busy = true; defer { busy = false }
        let gate = beginMutation(), token = generation, session = retentionSession
        defer { endMutation(gate) }
        do {
            let result = try await archive.applyRetention(preview, now: now(), gate: gate)
            guard available, generation == token else { return }
            apply(result.state)
            if retentionSession == session { closeRetentionSettings() }
            error = nil; notice = nil
            showDeletionUndo(.init(deletionID: result.receipt.deletionID, ids: Set(result.receipt.previousItems.map(\.id)),
                expiresAt: result.receipt.at.addingTimeInterval(NativeQuickClipboardPolicy.undoLifetime), retention: result.receipt))
        } catch {
            guard available, generation == token, retentionSettingsOpen, retentionSession == session else { return }
            if error as? NativeQuickClipboardError == .retentionChanged {
                // A capture can commit just before beginMutation revokes its
                // old UI callback. Refresh that durable state as well as the
                // impact, so cancelling this dialog cannot leave a stale list.
                if let latest = try? await archive.load() {
                    guard available, generation == token, retentionSettingsOpen, retentionSession == session else { return }
                    apply(latest)
                }
                await prepareRetention(preview.policy)
                guard available, generation == token, retentionSettingsOpen, retentionSession == session else { return }
                retentionError = nativeUI("历史已变化，已重新计算。请查看影响后再次确认。", "History changed and the impact was recalculated. Review it before confirming again.")
            } else {
                retentionError = nativeUI("设置未保存，历史和原策略保持不变。", "Settings were not saved. History and the previous policy are unchanged.")
            }
        }
    }
    func showPreview(_ item: NativeQuickClipboardItem) {
        guard available, loaded, visible, !busy, items.contains(where: { $0.id == item.id && $0.deletedAt == nil }) else { return }
        closePreview()
        previewID = item.id; previewLoading = true
        let token = previewGeneration
        previewTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let payload = try await previewRead(item.id)
                guard available, visible, previewGeneration == token, previewID == item.id, !Task.isCancelled else { return }
                guard previewItem != nil else { closePreview(); return }
                previewText = payload.text
                previewImage = payload.image.map { NSImage(cgImage: $0, size: NSSize(width: $0.width, height: $0.height)) }
                previewLoading = false; previewTask = nil
            } catch {
                guard available, visible, previewGeneration == token, previewID == item.id, !Task.isCancelled else { return }
                previewText = nil; previewImage = nil; previewLoading = false; previewTask = nil
                previewError = nativeUI("无法读取这条记录。原始内容可能已移除或损坏，请关闭预览后重试。", "This item could not be read. Its original content may be missing or damaged. Close the preview and try again.")
            }
        }
    }
    func closePreview() {
        previewGeneration += 1; previewTask?.cancel(); previewTask = nil
        previewID = nil; previewText = nil; previewImage = nil; previewLoading = false; previewError = nil
    }
    private func reconcileMonitoring() {
        captureGate?.revoke(); captureGate = nil
        generation += 1; polling?.cancel(); polling = nil; lastCount = nil
        guard loaded, available, mode == .recording else { return }
        // Opt-in, resume, app restart and privacy unlock all establish a fresh
        // count-only baseline. They never read the pre-existing clipboard.
        lastCount = pasteboard.changeCount
        captureGate = NativeQuickClipboardCaptureGate()
        guard schedulesPolling else { return }
        polling = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 450_000_000) } catch { return }
                guard let self else { return }; self.pollOnce()
            }
        }
    }
    func pollOnce() {
        guard loaded, available, mode == .recording, !busy, !captureInFlight else { return }
        let count = pasteboard.changeCount
        guard count != lastCount else { return }
        lastCount = count
        let types = pasteboard.types
        guard !NativeQuickClipboardPolicy.excluded(types) else { return }
        let payload: NativeQuickClipboardPayload
        if types.contains(NativeQuickClipboardPolicy.textType), let data = pasteboard.data(forType: NativeQuickClipboardPolicy.textType), !data.isEmpty {
            guard data.count <= NativeQuickClipboardPolicy.maxTextBytes else { notice = nativeUI("这段文字过大，未记入历史。", "This text is too large to save in history."); return }
            guard let text = String(data: data, encoding: .utf8), !NativeQuickClipboardPolicy.sensitiveText(text) else { return }
            payload = .init(kind: .text, data: data)
        } else if let type = NativeQuickClipboardPolicy.imageTypes.first(where: { types.contains($0) }), let data = pasteboard.data(forType: type) {
            guard !data.isEmpty, data.count <= NativeQuickClipboardPolicy.maxInputImageBytes else { notice = nativeUI("这张图片过大，未记入历史。", "This image is too large to save in history."); return }
            payload = .init(kind: .image, data: data)
        } else { return }
        // Clipboard ownership can change while a promised payload is delivered.
        guard pasteboard.changeCount == count, !NativeQuickClipboardPolicy.excluded(pasteboard.types) else { return }
        guard let gate = captureGate else { return }
        captureInFlight = true; let token = generation
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { captureInFlight = false }
            do {
                let state = try await archive.capture(payload, gate: gate)
                guard generation == token, available, mode == .recording else { return }
                apply(state); error = nil
            } catch {
                guard generation == token else { return }
                self.error = error as? NativeQuickClipboardError == .protectedCapacity
                    ? nativeUI("收藏或可撤销记录已占满容量，未保存新内容。请取消部分收藏或移除记录后再复制。", "Favorites or undoable items fill the storage limit. New content was not saved. Unfavorite or remove items, then copy again.")
                    : nativeUI("这项内容未能保存到剪贴板历史。", "This item could not be saved to clipboard history.")
            }
        }
    }
    /// Returns a count-only receipt. It never exposes clipboard contents to a
    /// navigation action, and an explicit later copy invalidates the receipt.
    @discardableResult
    func copy(_ item: NativeQuickClipboardItem, canCommit: () -> Bool = { true }) async -> Int? {
        guard available, loaded, !busy, item.deletedAt == nil, canCommit() else { return nil }
        busy = true; defer { busy = false }
        let token = generation, clipboardVersion = pasteboard.changeCount
        do {
            let payload = try await payloadRead(item.id)
            guard available, generation == token, !Task.isCancelled, canCommit() else { return nil }
            // Reading a stored image may finish after the user copies something
            // elsewhere. Their newer clipboard takes precedence over this request.
            guard pasteboard.changeCount == clipboardVersion else {
                error = nil
                notice = nativeUI("剪贴板已改变，保留了新内容。可再次点击复制。", "Clipboard changed. Your newer content was kept. Click Copy again if needed.")
                return nil
            }
            guard pasteboard.write(payload) else { throw NativeQuickClipboardError.writeFailed }
            lastCount = pasteboard.changeCount
            copyReceipt = (pasteboard.changeCount, token)
            error = nil; notice = nativeUI("已复制，可粘贴到其他应用。", "Copied. Paste it into another app.")
            return copyReceipt?.count
        } catch {
            guard available, generation == token, canCommit() else { return nil }
            self.error = nativeUI("复制失败，历史记录仍然保留。", "Copy failed. The history item is retained.")
            return nil
        }
    }
    func isCopyCurrent(_ count: Int) -> Bool {
        available && copyReceipt?.count == count && copyReceipt?.generation == generation && pasteboard.changeCount == count
    }
    func reportPasteNotice(_ message: String?) {
        guard available, let message else { return }
        error = nil; notice = message
    }
    func remove(_ ids: Set<String>, permanently: Bool = false) async {
        guard available, loaded, !busy else { return }; busy = true; defer { busy = false }
        let gate = beginMutation(), token = generation, deletionID = UUID().uuidString, deletedAt = now()
        defer { endMutation(gate) }
        do {
            let result = try await archive.remove(ids: ids, permanently: permanently, deletionID: deletionID, now: deletedAt, gate: gate)
            guard available, generation == token else { return }
            apply(result); error = nil
            let removed = Set(result.items.filter { $0.deletionID == deletionID && $0.deletedAt != nil }.map(\.id))
            if !permanently && !removed.isEmpty {
                showDeletionUndo(.init(deletionID: deletionID, ids: removed, expiresAt: deletedAt.addingTimeInterval(NativeQuickClipboardPolicy.undoLifetime)))
                notice = deletionUndo == nil ? nativeUI("已移入最近删除，可恢复。", "Moved to Recently Deleted. You can restore it.") : nil
            } else { notice = permanently ? nativeUI("已永久删除。", "Permanently deleted.") : nativeUI("没有可删除的记录。", "No items to delete.") }
        } catch {
            guard available, generation == token else { return }
            self.error = nativeUI("删除未保存，原记录保留。", "Deletion was not saved. Original items are retained.")
        }
    }
    func toggleFavorite(_ item: NativeQuickClipboardItem) async {
        guard available, loaded, !busy, let current = items.first(where: { $0.id == item.id && $0.deletedAt == nil }) else { return }
        busy = true; defer { busy = false }
        let gate = beginMutation(), token = generation
        defer { endMutation(gate) }
        do {
            let result = try await archive.setFavorite(id: current.id, favorite: !current.isFavorite, gate: gate)
            guard available, generation == token else { return }
            apply(result); error = nil; notice = nil
        } catch {
            guard available, generation == token else { return }
            self.error = nativeUI("收藏变更未保存，原状态保留。", "The favorite change was not saved. Its previous state is retained.")
        }
    }
    func undoDeletion() async {
        guard available, loaded, !busy, let undo = deletionUndo else { return }
        guard now() < undo.expiresAt else {
            dismissDeletionUndo()
            notice = undo.retention != nil
                ? nativeUI("即时撤销已到期。可重新调整保留设置，或从最近删除恢复记录。", "Quick undo expired. Adjust retention settings again, or restore items from Recently Deleted.")
                : nativeUI("即时撤销已到期，仍可在最近删除中恢复。", "Quick undo expired. You can still restore from Recently Deleted.")
            return
        }
        busy = true; defer { busy = false }
        let gate = beginMutation(), token = generation
        defer { endMutation(gate) }
        do {
            if let receipt = undo.retention {
                let result = try await archive.undoRetention(receipt, now: now(), gate: gate)
                guard available, generation == token else { return }
                apply(result); dismissDeletionUndo(); error = nil
                notice = nativeUI("已撤销整理，原保留设置和记录已恢复。", "Cleanup undone. Previous retention settings and items restored.")
                return
            }
            let result = try await archive.undoDeletion(ids: undo.ids, deletionID: undo.deletionID, now: now(), gate: gate)
            guard available, generation == token else { return }
            let count = result.restoredIDs.count
            apply(result.state); dismissDeletionUndo(); error = nil
            notice = nativeUI("已撤销删除，恢复 \(count) 条记录。", "Deletion undone. Restored \(count) items.")
        } catch {
            guard available, generation == token else { return }
            self.error = undo.retention != nil && error as? NativeQuickClipboardError == .retentionChanged
                ? nativeUI("历史或设置已变化，未覆盖后续操作。可重新调整设置或恢复记录。", "History or settings changed. Later changes were not overwritten. Adjust settings again or restore items.")
                : nativeUI("撤销未保存。记录可能已移除或内容不可用，请查看最近删除。", "Undo was not saved. An item may have been removed or its content is unavailable. Check Recently Deleted.")
        }
    }
    func dismissDeletionUndo() { undoExpiryTask?.cancel(); undoExpiryTask = nil; deletionUndo = nil }
    private func showDeletionUndo(_ undo: NativeQuickClipboardDeletionUndo) {
        dismissDeletionUndo()
        guard undo.expiresAt > now() else { return }
        deletionUndo = undo
        let delay = undo.expiresAt.timeIntervalSince(now())
        undoExpiryTask = Task { @MainActor [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(max(0, delay) * 1_000_000_000)) } catch { return }
            guard let self, self.deletionUndo?.deletionID == undo.deletionID else { return }
            self.dismissDeletionUndo()
        }
    }
    private func beginMutation() -> NativeQuickClipboardCaptureGate {
        // Discard any older in-flight capture projection before a user edit.
        // Keep the current changeCount baseline; favorites never read/recopy it.
        captureGate?.revoke(); generation += 1
        captureGate = mode == .recording ? NativeQuickClipboardCaptureGate() : nil
        let gate = NativeQuickClipboardCaptureGate(); mutationGate = gate; return gate
    }
    private func endMutation(_ gate: NativeQuickClipboardCaptureGate) { if mutationGate === gate { mutationGate = nil } }
    func restore(_ ids: Set<String>) async {
        guard available, loaded, !busy else { return }; busy = true; defer { busy = false }
        let gate = beginMutation(), token = generation
        defer { endMutation(gate) }
        do {
            let result = try await archive.restore(ids: ids, gate: gate)
            guard available, generation == token else { return }
            apply(result); error = nil; notice = nativeUI("已恢复。", "Restored.")
        } catch {
            guard available, generation == token else { return }
            self.error = nativeUI("恢复失败，请重试。", "Restore failed. Try again.")
        }
    }
    func loadThumbnail(_ item: NativeQuickClipboardItem) async {
        guard visible, available, item.kind == .image, thumbnails[item.id] == nil, !requestedThumbnails.contains(item.id) else { return }
        requestedThumbnails.insert(item.id)
        let token = generation
        let bytes = try? await archive.thumbnail(id: item.id)
        guard visible, available, generation == token, items.contains(where: { $0.id == item.id }) else { return }
        if let bytes, let image = NSImage(data: bytes) { thumbnails[item.id] = image }
    }
}
