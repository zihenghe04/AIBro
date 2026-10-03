import Foundation
import Combine
import Darwin

struct NativeQuickCapturePayload: Codable, Equatable {
    let id: String
    let text: String
    let tags: [String]
}

/// Only the unsent input and an immutable retry envelope live here. Published
/// captures are written by the existing JavaScript workspace and durable store.
@MainActor final class NativeQuickCaptureStore: ObservableObject {
    @Published var text = "" { didSet { inputChanged() } }
    @Published var tags = "" { didSet { inputChanged() } }
    @Published private(set) var saving = false
    @Published private(set) var pending: NativeQuickCapturePayload?
    @Published private(set) var error: String?
    @Published private(set) var draftError: String?
    @Published private(set) var savedID: String?
    @Published private(set) var recoveryURL: URL?

    private struct Draft: Codable {
        let version: Int
        let id: String
        let text: String
        let tags: String
        let pending: NativeQuickCapturePayload?
        let savedID: String?
        let recoveryDirectory: String?
    }
    private var id = NativeQuickCaptureStore.newID()
    private var file: URL?
    private var saveOperation: ((NativeQuickCapturePayload) async throws -> String)?
    private var write: (Data, URL) throws -> Void
    private var loading = false
    private var loadFailed = false
    private var dirty = false
    private var debounce: Task<Void, Never>?

    init(write: @escaping (Data, URL) throws -> Void = { data, file in
        try data.write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }) { self.write = write }

    var inputLocked: Bool { saving || pending != nil || loadFailed || savedID != nil }
    var canStartWithRecovery: Bool { file != nil && !saving && savedID == nil && (pending != nil || loadFailed) }
    var canSave: Bool {
        !saving && !loadFailed && savedID == nil && saveOperation != nil &&
        (pending != nil || (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && text.utf16.count <= 200_000))
    }
    private static func newID() -> String { "quick_capture_" + UUID().uuidString.lowercased() }
    private static func validID(_ value: String) -> Bool {
        value.hasPrefix("quick_capture_") && UUID(uuidString: String(value.dropFirst("quick_capture_".count))) != nil
    }
    private static func validRecoveryDirectory(_ value: String) -> Bool {
        let prefix = "native-quick-capture-recovery-"
        return value.hasPrefix(prefix) && UUID(uuidString: String(value.dropFirst(prefix.count))) != nil
    }
    private static func parsedTags(_ value: String) -> [String] {
        var seen = Set<String>()
        return value.components(separatedBy: CharacterSet(charactersIn: ",，"))
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    func configure(directory: URL, save: @escaping (NativeQuickCapturePayload) async throws -> String) {
        saveOperation = save
        let destination = directory.appendingPathComponent("native-quick-capture-draft.json")
        guard file != destination else { return }
        // A coordinator belongs to one Workspace. Never move unsaved input into
        // another workspace if a caller accidentally tries to rebind it.
        guard file == nil else {
            draftError = nativeUI("快捷草稿属于另一个工作区，请返回原工作区保存。", "This draft belongs to another workspace. Save it there first.")
            saveOperation = nil
            return
        }
        file = destination
        loadDraft()
    }

    private func loadDraft() {
        guard let file else { return }
        do {
            guard FileManager.default.fileExists(atPath: file.path) else {
                loadFailed = false; draftError = nil
                return
            }
            let draft = try JSONDecoder().decode(Draft.self, from: Data(contentsOf: file))
            guard draft.version == 1, Self.validID(draft.id),
                  draft.savedID == nil || draft.savedID == draft.id,
                  draft.recoveryDirectory == nil || Self.validRecoveryDirectory(draft.recoveryDirectory!),
                  draft.pending == nil || (draft.pending?.id == draft.id && draft.pending?.text == draft.text && draft.pending?.tags == Self.parsedTags(draft.tags)),
                  !(draft.pending != nil && draft.savedID != nil) else { throw CocoaError(.fileReadCorruptFile) }
            loading = true
            id = draft.id; text = draft.text; tags = draft.tags
            pending = draft.pending; savedID = draft.savedID
            recoveryURL = draft.recoveryDirectory.map { file.deletingLastPathComponent().appendingPathComponent($0, isDirectory: true) }
            loading = false; dirty = false; loadFailed = false; draftError = nil
            if pending != nil {
                error = nativeUI("上次保存尚未确认。重试会核对同一条随记，不会重复创建。", "The last save was not confirmed. Retry checks the same capture without creating a duplicate.")
            }
        } catch {
            loadFailed = true
            draftError = nativeUI("无法读取上次快捷草稿，原文件已保留。请重试读取。", "Could not read the previous quick draft. Its file is preserved. Retry loading it.")
        }
    }

    private func inputChanged() {
        guard !loading else { return }
        dirty = true; error = nil
        debounce?.cancel()
        debounce = Task { @MainActor [weak self] in
            do { try await Task.sleep(nanoseconds: 300_000_000) } catch { return }
            guard !Task.isCancelled else { return }
            _ = self?.flushDraft()
        }
    }

    @discardableResult func flushDraft() -> Bool {
        debounce?.cancel(); debounce = nil
        if loadFailed { loadDraft(); return !loadFailed }
        guard let file else { return text.isEmpty && pending == nil }
        guard dirty else { return draftError == nil }
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            let draft = Draft(version: 1, id: id, text: text, tags: tags, pending: pending, savedID: savedID, recoveryDirectory: recoveryURL?.lastPathComponent)
            try write(JSONEncoder().encode(draft), file)
            dirty = false; draftError = nil
            return true
        } catch {
            draftError = nativeUI("快捷草稿尚未保存到本机。请重试保存，或复制文字后再退出。", "The quick draft is not saved locally. Retry saving, or copy the text before quitting.")
            return false
        }
    }

    func flushForQuit() -> Bool {
        let durable = flushDraft()
        // Do not terminate a live workspace write. An uncertain result after a
        // failed request may safely survive quitting via the persisted envelope.
        return durable && !saving
    }

    func saveCapture() async {
        guard canSave, let saveOperation else { return }
        if pending == nil {
            pending = NativeQuickCapturePayload(id: id, text: text, tags: Self.parsedTags(tags))
            dirty = true
        }
        // The request ID and exact text must be on disk BEFORE any workspace
        // mutation. A missing acknowledgement can then be retried after restart.
        guard flushDraft(), let payload = pending else { return }
        saving = true; error = nil
        defer { saving = false }
        do {
            let receipt = try await saveOperation(payload)
            guard receipt == payload.id else { throw NativeQuickCaptureError.unconfirmed }
            pending = nil; savedID = receipt; dirty = true
            // Keep the acknowledged text until the user explicitly starts a
            // new capture. If this write fails, disk still has the retry envelope.
            _ = flushDraft()
        } catch {
            self.error = error.localizedDescription
        }
    }

    func newCapture() {
        guard savedID != nil, !saving, flushDraft() else { return }
        let old = (id, text, tags, savedID)
        loading = true
        id = Self.newID(); text = ""; tags = ""; savedID = nil; error = nil
        loading = false; dirty = true
        // Do not offer fresh input if clearing the previous receipt failed.
        if !flushDraft() {
            loading = true
            id = old.0; text = old.1; tags = old.2; savedID = old.3
            loading = false; dirty = true
        }
    }

    private func syncFile(_ file: URL) throws {
        let handle = try FileHandle(forWritingTo: file)
        defer { try? handle.close() }
        try handle.synchronize()
    }

    private func syncDirectory(_ directory: URL) throws {
        let descriptor = Darwin.open(directory.path, O_RDONLY)
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { Darwin.close(descriptor) }
        guard Darwin.fsync(descriptor) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    }

    private func preserve(_ bytes: Data, at file: URL) throws {
        try write(bytes, file)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        try syncFile(file)
    }

    /// Explicitly end an unrecoverable retry without silently sending it again.
    /// Keep both the exact original bytes (even invalid JSON) and the current
    /// in-memory envelope before allowing a new ID or editable input.
    @discardableResult func preserveRecoveryAndStartNew() -> Bool {
        guard canStartWithRecovery, let file else { return false }
        debounce?.cancel(); debounce = nil
        let manager = FileManager.default
        let directory = file.deletingLastPathComponent()
        let recovery = directory.appendingPathComponent("native-quick-capture-recovery-" + UUID().uuidString.lowercased(), isDirectory: true)
        let staged = directory.appendingPathComponent(".native-quick-capture-reset-" + UUID().uuidString.lowercased())
        var original: Data?
        var replaced = false
        defer { try? manager.removeItem(at: staged) }
        do {
            if manager.fileExists(atPath: file.path) {
                let attributes = try manager.attributesOfItem(atPath: file.path)
                guard attributes[.type] as? FileAttributeType == .typeRegular else { throw CocoaError(.fileReadCorruptFile) }
                original = try Data(contentsOf: file)
            }
            try manager.createDirectory(at: directory, withIntermediateDirectories: true)
            try manager.createDirectory(at: recovery, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            if let original { try preserve(original, at: recovery.appendingPathComponent("original.json")) }
            let retained = Draft(version: 1, id: id, text: text, tags: tags, pending: pending, savedID: savedID, recoveryDirectory: recoveryURL?.lastPathComponent)
            try preserve(JSONEncoder().encode(retained), at: recovery.appendingPathComponent("input.json"))
            try syncDirectory(recovery)
            try syncDirectory(directory)

            let nextID = Self.newID()
            let fresh = Draft(version: 1, id: nextID, text: "", tags: "", pending: nil, savedID: nil, recoveryDirectory: recovery.lastPathComponent)
            // Prepare and sync a separate file first. Disk/permission failure
            // here leaves the original file and in-memory envelope untouched.
            try preserve(JSONEncoder().encode(fresh), at: staged)
            guard Darwin.rename(staged.path, file.path) == 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
            replaced = true
            try syncDirectory(directory)
            loading = true
            id = nextID; text = ""; tags = ""; pending = nil; savedID = nil
            loading = false; loadFailed = false; dirty = false
            recoveryURL = recovery; error = nil; draftError = nil
            return true
        } catch {
            if replaced {
                // A directory-sync failure after rename is uncommon, but must
                // not leave a blank draft as the only discoverable state.
                if let original {
                    try? original.write(to: file, options: .atomic)
                    try? manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
                    try? syncFile(file)
                } else { try? manager.removeItem(at: file) }
                try? syncDirectory(directory)
            }
            draftError = nativeUI("尚未完成恢复副本保存，当前草稿仍保留。请检查本机存储后重试。", "The recovery copy is not complete. Your current draft is retained. Check local storage and retry.")
            return false
        }
    }
}

enum NativeQuickCaptureError: LocalizedError {
    case unavailable, unconfirmed, rejected(String)
    var errorDescription: String? {
        switch self {
        case .unavailable: return nativeUI("工作区尚未就绪，草稿已保留，请稍后重试。", "The workspace is not ready. Your draft is retained; retry shortly.")
        case .unconfirmed: return nativeUI("保存结果尚未确认，草稿已保留，请重试。", "The save is not confirmed. Your draft is retained; retry.")
        case .rejected(let reason):
            switch reason {
            case "conflict": return nativeUI("请先在工作区处理同步冲突，再重试保存。", "Resolve the workspace sync conflict, then retry saving.")
            case "removed": return nativeUI("这条随记已被移入回收站或归档。请先在工作区恢复它，再重试。", "This capture was trashed or archived. Restore it in the workspace before retrying.")
            case "collision", "changed": return nativeUI("随记标识或内容已有变化，未覆盖原记录。请复制文字并在工作区核对。", "The capture identity or content changed. Nothing was overwritten. Copy the text and review it in the workspace.")
            case "invalid": return nativeUI("请检查随记内容；正文最多 200,000 个字符。", "Check the capture text; it supports up to 200,000 characters.")
            case "busy", "hydrating", "trash_paused": return nativeUI("工作区正在处理内容，草稿已保留，请稍后重试。", "The workspace is busy. Your draft is retained; retry shortly.")
            default: return nativeUI("未能确认保存到工作区，草稿已保留，请重试。", "Could not confirm the workspace save. Your draft is retained; retry.")
            }
        }
    }
}
