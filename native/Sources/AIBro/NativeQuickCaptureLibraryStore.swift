import Foundation
import Combine
import Darwin

struct NativeQuickCaptureLibraryLink: Codable, Equatable, Identifiable {
    let type: String
    let id: String
    let title: String
    var identity: String { type + ":" + id }
}
struct NativeQuickCaptureLibraryNote: Codable, Equatable, Identifiable {
    let id: String
    let title: String
    let excerpt: String
    let tags: [String]
    let createdAt: Double
    let updatedAt: Double
    var content: String?
    var attachments: [NativeQuickCaptureLibraryLink]?
    var derived: [NativeQuickCaptureLibraryLink]?
    var recordVersion: String?
    var titleSource: String?
}
struct NativeQuickCaptureLibraryEdit: Codable, Equatable {
    let requestId: String
    let id: String
    let expectedVersion: Double
    let text: String
    let tags: [String]
    var title: String? = nil
    var titleSource: String? = nil
    var expectedRecordVersion: String? = nil
    var payload: [String: Any] {
        var value: [String: Any] = ["action":"update", "requestId":requestId, "id":id, "expectedVersion":expectedVersion, "text":text, "tags":tags]
        if let title { value["title"] = title }
        if let titleSource { value["titleSource"] = titleSource; value["expectedRecordVersion"] = expectedRecordVersion }
        return value
    }
}
struct NativeQuickCaptureLibraryTrash: Codable, Equatable, Identifiable {
    let id: String
    let title: String
    let deletedAt: Double
    let version: String
}
struct NativeQuickCaptureLibraryLifecycle: Codable, Equatable {
    let requestId: String
    let action: String
    let title: String
    var id: String?
    var expectedVersion: Double?
    var expectedRecordVersion: String?
    var trashId: String?
    var trashVersion: String?
    var valid: Bool {
        guard requestId.hasPrefix("quick_capture_lifecycle_"), requestId == requestId.lowercased(),
              UUID(uuidString:String(requestId.dropFirst("quick_capture_lifecycle_".count))) != nil else { return false }
        if action == "remove" { return id?.isEmpty == false && (id?.utf16.count ?? 0) <= 512 && expectedVersion?.isFinite == true && (expectedVersion ?? -1) >= 0 && expectedVersion?.rounded() == expectedVersion && expectedRecordVersion?.isEmpty == false && trashId == nil && trashVersion == nil }
        return action == "restore" && trashId?.isEmpty == false && trashVersion?.isEmpty == false && id == nil && expectedVersion == nil && expectedRecordVersion == nil
    }
    var payload: [String: Any] {
        var value: [String: Any] = ["action":action,"requestId":requestId]
        if action == "remove", let id, let expectedVersion, let expectedRecordVersion { value["id"] = id; value["expectedVersion"] = expectedVersion; value["expectedRecordVersion"] = expectedRecordVersion }
        if action == "restore", let trashId, let trashVersion { value["trashId"] = trashId; value["expectedVersion"] = trashVersion }
        return value
    }
}
private struct NativeQuickCaptureLibraryReply: Decodable {
    let status: String
    var reason: String?
    var rows: [NativeQuickCaptureLibraryNote]?
    var note: NativeQuickCaptureLibraryNote?
    var total: Int?
    var nextOffset: Int?
    var id: String?
    var requestId: String?
    var version: Double?
    var trash: [NativeQuickCaptureLibraryTrash]?
    var action: String?
    var trashId: String?
    var title: String?
    var model: String?
    var recordVersion: String?
    var expectedVersion: Double?
}

/// Saved notes remain in state.notes. This file holds only explicit user edits
/// and immutable retry envelopes, never a second published notes database.
@MainActor final class NativeQuickCaptureLibraryStore: ObservableObject {
    let recordFocus = NativeQuickRecordFocus()
    @Published private(set) var focusedRecordID: String?
    typealias Request = ([String: Any]) async throws -> [String: Any]
    @Published var query = ""
    @Published private(set) var rows: [NativeQuickCaptureLibraryNote] = []
    @Published private(set) var total = 0
    @Published private(set) var nextOffset: Int?
    @Published private(set) var selected: NativeQuickCaptureLibraryNote?
    @Published private(set) var loading = false
    @Published private(set) var selecting = false
    @Published private(set) var saving = false
    @Published private(set) var editing = false
    @Published private(set) var error: String?
    @Published private(set) var editError: String?
    @Published private(set) var draftError: String?
    @Published private(set) var conflicted = false
    @Published private(set) var available = true
    @Published private(set) var trash: [NativeQuickCaptureLibraryTrash] = []
    @Published private(set) var showingTrash = false
    @Published private(set) var pendingLifecycle: NativeQuickCaptureLibraryLifecycle?
    @Published private(set) var lifecycleError: String?
    @Published private(set) var notice: String?
    @Published private(set) var generatingTitle = false
    @Published private(set) var suggestedTitle: String?
    @Published private(set) var titleModel: String?
    @Published private(set) var titleError: String?
    @Published var title = "" { didSet { changed(titleChanged:title != oldValue) } }
    @Published var text = "" { didSet { changed() } }
    @Published var tags = "" { didSet { changed() } }
    private struct Draft: Codable, Equatable {
        let id: String
        let version: Double
        let originalText: String
        let originalTags: [String]
        var originalTitle: String?
        var title: String?
        var titleSource: String?
        var titleRecordVersion: String?
        var text: String
        var tags: String
        var pending: NativeQuickCaptureLibraryEdit?
        var dirty: Bool { text != originalText || NativeQuickCaptureLibraryStore.parseTags(tags) != originalTags || (title != nil && title != originalTitle) || titleSource == "model" || pending != nil }
    }
    private struct SavedDrafts: Codable { let version: Int; let drafts: [String: Draft]; var lifecycle: NativeQuickCaptureLibraryLifecycle? }
    private var drafts: [String: Draft] = [:]
    private var directory: URL?
    private var request: Request?
    private var openAction: ((String, String) async -> Bool)?
    private let write: (Data, URL) throws -> Void
    private var restoring = false
    private var unreadable = false
    private var draftDirty = false
    private var listEpoch = 0
    private var selectionEpoch = 0
    private var editorEpoch = 0
    private var titleGeneration = 0
    private var titleRequestID: String?
    private var applyingGeneratedTitle = false
    private struct TitleSnapshot {
        let id: String, title: String, text: String, tags: String, recordVersion: String
        let version: Double
        let selection: Int, editor: Int
    }
    private var titleSnapshot: TitleSnapshot?
    private var debounce: Task<Void, Never>?
    private var draftFile: URL? { directory?.appendingPathComponent("native-quick-capture-library-drafts.json") }
    var selectedID: String? { selected?.id }
    var pending: NativeQuickCaptureLibraryEdit? { selected.flatMap { drafts[$0.id]?.pending } }
    var inputLocked: Bool { saving || pending != nil || pendingLifecycle != nil || unreadable || !available }
    var hasChanges: Bool { selected.flatMap { drafts[$0.id] }?.dirty == true }
    var hasUnsettledEditor: Bool { saving || pendingLifecycle != nil || (editing && hasChanges) }
    var canEdit: Bool { available && !saving && !unreadable && pendingLifecycle == nil }
    var validTitle: Bool { !title.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty && title.utf16.count <= 500 && !title.unicodeScalars.contains(where:CharacterSet.controlCharacters.contains) }
    var canSave: Bool { available && editing && !saving && !unreadable && request != nil && pendingLifecycle == nil && hasChanges && (pending != nil || (validTitle && text.utf16.count <= 200_000 && (!text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty || !(selected?.attachments ?? []).isEmpty))) }
    var canRemoveSelected: Bool { canEdit && selected?.recordVersion?.isEmpty == false && !hasChanges && !editing }
    var canGenerateTitle: Bool {
        guard canEdit, !inputLocked, !selecting, !generatingTitle, !conflicted, !showingTrash, let note = selected,
              Self.validRecordVersion(note.recordVersion), !text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,
              text.utf16.count <= 200_000 else { return false }
        let source = note.titleSource ?? (note.title == String((note.content ?? "").trimmingCharacters(in:.whitespacesAndNewlines).components(separatedBy:"\n").first?.prefix(70) ?? "") ? "content":"user")
        guard source != "user", source != "unknown" else { return false }
        return title == note.title || drafts[note.id]?.titleSource == "model"
    }
    private static func validRecordVersion(_ value: String?) -> Bool {
        value?.range(of:"^sha256:[a-f0-9]{64}$",options:.regularExpression) != nil
    }
    func hasDraft(_ id: String) -> Bool { drafts[id]?.dirty == true }
    nonisolated static func parseTags(_ text: String) -> [String] {
        var seen = Set<String>()
        return text.components(separatedBy: CharacterSet(charactersIn: ",，")).map { $0.trimmingCharacters(in:.whitespacesAndNewlines) }.filter { !$0.isEmpty && seen.insert($0).inserted }
    }
    init(write: @escaping (Data, URL) throws -> Void = { data, url in
        try data.write(to:url,options:.atomic)
        try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:url.path)
    }) { self.write = write }
    func configure(directory: URL, request: @escaping Request, open: @escaping (String, String) async -> Bool) {
        guard self.directory == nil || self.directory == directory else {
            setAvailable(false); self.request = nil; draftError = nativeUI("编辑草稿属于另一个工作区。", "This draft belongs to another workspace."); return
        }
        self.request = request; self.openAction = open
        guard self.directory == nil else { return }
        self.directory = directory
        guard let file = draftFile, FileManager.default.fileExists(atPath:file.path) else { return }
        do {
            let saved = try JSONDecoder().decode(SavedDrafts.self,from:Data(contentsOf:file))
            guard [1,2].contains(saved.version), saved.lifecycle == nil || saved.lifecycle?.valid == true, saved.drafts.allSatisfy({ key,draft in
                // Unpublished invalid input must remain editable after a
                // restart. Publishing limits apply to the immutable request,
                // not to recovery of the user's locally retained text.
                key == draft.id && !key.isEmpty && draft.version.isFinite && draft.version >= 0 && draft.version.rounded() == draft.version &&
                (draft.titleSource == nil || draft.titleSource == "model" && Self.validRecordVersion(draft.titleRecordVersion)) &&
                (draft.pending?.titleSource == nil || draft.pending?.titleSource == "model" && draft.pending?.titleSource == draft.titleSource && draft.pending?.expectedRecordVersion == draft.titleRecordVersion) &&
                (draft.pending == nil || (draft.text.utf16.count <= 200_000 && draft.pending?.id == key && draft.pending?.text == draft.text && draft.pending?.tags == Self.parseTags(draft.tags) && (draft.pending?.title == nil || (draft.pending?.title == draft.title?.trimmingCharacters(in:.whitespacesAndNewlines) && !(draft.pending?.title ?? "").isEmpty && (draft.pending?.title?.utf16.count ?? 0) <= 500 && !(draft.pending?.title ?? "").unicodeScalars.contains(where:CharacterSet.controlCharacters.contains))) && draft.pending?.expectedVersion == draft.version && draft.pending?.requestId.hasPrefix("quick_capture_edit_") == true && UUID(uuidString:String((draft.pending?.requestId ?? "").dropFirst("quick_capture_edit_".count))) != nil))
            }) else { throw CocoaError(.fileReadCorruptFile) }
            drafts = saved.drafts; pendingLifecycle = saved.lifecycle
        } catch { unreadable = true; draftError = nativeUI("无法读取编辑草稿，原文件已保留。可在主窗口查看随记。", "The edit draft could not be read. Its file is preserved; use the main window to view captures.") }
    }
    func setAvailable(_ value: Bool) {
        let value = value && request != nil
        guard value != available else { return }; available = value
        if !value {
            cancelTitleGeneration()
            recordFocus.cancel(); focusedRecordID=nil
            _ = flushDraft(); listEpoch += 1; selectionEpoch += 1; rows = []; trash = []; showingTrash = false; total = 0; nextOffset = nil; selected = nil; editing = false; loading = false; selecting = false; notice = nil; lifecycleError = nil
            restoring = true; title = ""; text = ""; tags = ""; restoring = false
            error = nativeUI("当前工作区的随记暂不可用。", "Captures are not available in the current workspace.")
        }
    }
    func prepareRecordFocus(id: String, canPresent: () -> Bool = { true }) async -> Bool {
        guard available,!editing,!hasUnsettledEditor,!hasDraft(id),!unreadable,canPresent() else{return false}
        // Agent navigation must not use select(): a human can begin editing the
        // current note while this read is in flight. Validate before applying
        // any selected record, text, view mode, or editor state.
        selectionEpoch += 1
        let epoch=selectionEpoch,editor=editorEpoch,previousID=selectedID,owner=directory
        selecting=true
        defer {if epoch==selectionEpoch {selecting=false}}
        do {
            let reply=try await response(["action":"get","id":id])
            guard epoch==selectionEpoch,editor==editorEpoch,directory==owner,selectedID==previousID,
                  available,!editing,!hasUnsettledEditor,!hasDraft(id),!unreadable,canPresent(),!Task.isCancelled else{return false}
            guard reply.status=="ready",let note=reply.note,note.id==id,note.content != nil else{return false}
            selected=note;conflicted=false;editError=nil;showingTrash=false
            restoring=true;title=note.title;text=note.content ?? "";tags=note.tags.joined(separator:", ");restoring=false
            focusedRecordID=id
            return true
        } catch {return false}
    }
    func clearRecordFocus() {recordFocus.cancel();focusedRecordID=nil}
    func focusRecord(id:String,show:()->Void,canPresent:@escaping()->Bool,isPresented:@escaping()->Bool) async -> Bool {
        guard let note=selected,note.id==id else{return false}
        let valid = { [weak self] in
            guard let self else{return false}
            return self.available && !self.editing && !self.hasUnsettledEditor && !self.hasDraft(id) && self.selectedID==id &&
                self.selected?.recordVersion==note.recordVersion && self.selected?.updatedAt==note.updatedAt && canPresent()
        }
        return await recordFocus.present(id:id,show:show,canPresent:valid,isPresented:isPresented)
    }
    private func response(_ payload: [String: Any]) async throws -> NativeQuickCaptureLibraryReply {
        guard available, let request else { throw NativeQuickCaptureError.unavailable }
        let raw = try await request(payload)
        return try JSONDecoder().decode(NativeQuickCaptureLibraryReply.self,from:JSONSerialization.data(withJSONObject:raw))
    }
    func refresh(loadMore: Bool = false) async {
        guard available else { return }
        if showingTrash { await refreshTrash(); return }
        if loadMore && (loading || nextOffset == nil) { return }
        listEpoch += 1; let epoch = listEpoch, needle = query, offset = loadMore ? nextOffset ?? 0 : 0
        loading = true; error = nil
        defer { if epoch == listEpoch { loading = false } }
        do {
            let reply = try await response(["action":"list","query":needle,"offset":offset])
            guard epoch == listEpoch, query == needle, available else { return }
            guard reply.status == "ready", let items = reply.rows else { throw NativeQuickCaptureError.rejected(reply.reason ?? "unavailable") }
            if loadMore { let ids = Set(rows.map(\.id)); rows += items.filter { !ids.contains($0.id) } } else { rows = items }
            total = reply.total ?? rows.count; nextOffset = reply.nextOffset
        } catch { if epoch == listEpoch { self.error = error.localizedDescription } }
    }
    func select(_ id: String) async {
        guard !saving, pendingLifecycle == nil, (!editing || flushDraft()), available else { return }
        cancelTitleGeneration()
        focusedRecordID=nil
        selectionEpoch += 1; let epoch = selectionEpoch
        selecting = true; editError = nil
        defer { if epoch == selectionEpoch { selecting = false } }
        do {
            let reply = try await response(["action":"get","id":id])
            guard epoch == selectionEpoch, available else { return }
            guard reply.status == "ready", let note = reply.note, note.id == id, note.content != nil else { throw NativeQuickCaptureError.rejected(reply.reason ?? "removed") }
            selected = note; conflicted = drafts[id].map { $0.version != note.updatedAt } ?? false
            editing = drafts[id]?.dirty == true
            // V1 drafts predate independent titles. Their old retry envelope
            // stays unchanged; a fresh edit takes the current title as baseline.
            if var draft = drafts[id], draft.title == nil { draft.originalTitle = note.title; draft.title = note.title; drafts[id] = draft }
            restoring = true; title = drafts[id]?.title ?? note.title; text = drafts[id]?.text ?? note.content ?? ""; tags = drafts[id]?.tags ?? note.tags.joined(separator:", "); restoring = false
            if conflicted { editError = nativeUI("这条随记已在其他位置修改。当前草稿保留，未覆盖最新内容。", "This capture changed elsewhere. Your draft is retained and the latest note was not overwritten.") }
        } catch {
            guard epoch == selectionEpoch else { return }
            selected = nil; editing = false; restoring = true; title = ""; text = ""; tags = ""; restoring = false; editError = error.localizedDescription
        }
    }
    func beginEditing() {
        guard let note = selected, note.content != nil, canEdit else { return }
        if drafts[note.id] == nil { drafts[note.id] = Draft(id:note.id,version:note.updatedAt,originalText:note.content ?? "",originalTags:note.tags,originalTitle:note.title,title:note.title,text:note.content ?? "",tags:note.tags.joined(separator:", ")) }
        editorEpoch += 1
        editing = true
    }
    func endEditing() { if !saving && flushDraft() { cancelTitleGeneration(); editing = false } }
    /// Cancelling also clears unaccepted model text. It never touches the
    /// editor draft, accepted title, or published workspace record.
    func cancelTitleGeneration() {
        let active = titleRequestID
        titleGeneration += 1; titleRequestID = nil; generatingTitle = false
        suggestedTitle = nil; titleModel = nil; titleSnapshot = nil; titleError = nil
        if let active, let request { Task { _ = try? await request(["action":"title-cancel","requestId":active]) } }
    }
    private func titleSnapshotMatches(_ snapshot: TitleSnapshot) -> Bool {
        available && editing && !inputLocked && !conflicted && !showingTrash &&
        selectedID == snapshot.id && selected?.updatedAt == snapshot.version && selected?.recordVersion == snapshot.recordVersion &&
        selectionEpoch == snapshot.selection && editorEpoch == snapshot.editor && title == snapshot.title && text == snapshot.text && tags == snapshot.tags
    }
    func generateTitle() async {
        guard canGenerateTitle, let note = selected, let recordVersion = note.recordVersion else { return }
        if !editing { beginEditing() }
        guard editing, flushDraft() else { return }
        cancelTitleGeneration()
        let generation = titleGeneration, id = "quick_capture_title_" + UUID().uuidString.lowercased()
        let snapshot = TitleSnapshot(id:note.id,title:title,text:text,tags:tags,recordVersion:recordVersion,version:note.updatedAt,selection:selectionEpoch,editor:editorEpoch)
        titleRequestID = id; generatingTitle = true
        defer { if titleGeneration == generation { generatingTitle = false; titleRequestID = nil } }
        do {
            let reply = try await response(["action":"title-generate","requestId":id,"id":note.id,"expectedVersion":note.updatedAt,"expectedRecordVersion":recordVersion,"text":snapshot.text])
            guard generation == titleGeneration, titleSnapshotMatches(snapshot), !Task.isCancelled else { return }
            guard reply.status == "generated" else { titleError = Self.titleFailure(reply.reason); return }
            guard reply.id == note.id, reply.requestId == id, reply.expectedVersion == snapshot.version, reply.recordVersion == snapshot.recordVersion,
                  let result = reply.title, !result.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,
                  result.unicodeScalars.count <= 80, !result.unicodeScalars.contains(where:CharacterSet.controlCharacters.contains) else {
                titleError = Self.titleFailure("invalid_response"); return
            }
            titleSnapshot = snapshot; suggestedTitle = result; titleModel = reply.model
        } catch {
            if generation == titleGeneration, available { titleError = Self.titleFailure("model_failed") }
        }
    }
    func applySuggestedTitle() {
        guard let snapshot = titleSnapshot, let result = suggestedTitle, titleSnapshotMatches(snapshot), var draft = drafts[snapshot.id] else {
            cancelTitleGeneration(); return
        }
        // Adopt into the ordinary local editor draft, never directly publish.
        // A subsequent manual edit owns the title and clears model provenance.
        applyingGeneratedTitle = true; title = result; applyingGeneratedTitle = false
        draft.title = result; draft.titleSource = "model"; draft.titleRecordVersion = snapshot.recordVersion
        drafts[snapshot.id] = draft; draftDirty = true
        cancelTitleGeneration(); _ = flushDraft()
    }
    private static func titleFailure(_ reason: String?) -> String {
        switch reason {
        case "not_configured": return nativeUI("请先在设置中配置模型，再生成标题。", "Configure a model in Settings before generating a title.")
        case "manual_title": return nativeUI("人工标题已保留，未生成替换标题。", "The manual title is retained; no replacement was generated.")
        case "changed", "removed": return nativeUI("随记已有变化，未采纳旧标题。请重新打开后重试。", "The capture changed. No stale title was adopted; reopen it and retry.")
        case "private", "cancelled": return nativeUI("已停止生成，原文与草稿保留。", "Generation stopped. The original and draft are retained.")
        case "timeout": return nativeUI("标题生成超过 30 秒，已停止；可重试，草稿保留。", "Title generation exceeded 30 seconds and stopped. Retry; your draft is retained.")
        case "context_length": return nativeUI("正文超过当前模型的上下文容量，未截断发送或更改草稿。", "The text exceeds this model's context capacity. It was not truncated and your draft is unchanged.")
        case "invalid_response": return nativeUI("模型未返回有效标题，原文与草稿保留。", "The model did not return a valid title. The original and draft are retained.")
        case "busy", "unavailable", "hydrating", "conflict": return nativeUI("工作区或模型暂不可用，草稿保留，请稍后重试。", "The workspace or model is unavailable. Your draft is retained; retry shortly.")
        default: return nativeUI("标题生成失败，请检查模型连接后重试。原文与草稿保留。", "Title generation failed. Check the model connection and retry. The original and draft are retained.")
        }
    }
    private func changed(titleChanged: Bool = false) {
        guard !restoring, editing, let id = selected?.id, var draft = drafts[id], draft.pending == nil, !saving else { return }
        if !applyingGeneratedTitle {
            cancelTitleGeneration()
            // Body/tag edits do not turn an independent model title into a
            // human title. Only an actual title-field change takes ownership.
            if titleChanged { draft.titleSource = nil; draft.titleRecordVersion = nil }
        }
        draft.title = title; draft.text = text; draft.tags = tags; drafts[id] = draft; draftDirty = true; editError = nil
        debounce?.cancel(); debounce = Task { @MainActor [weak self] in
            do { try await Task.sleep(nanoseconds:300_000_000) } catch { return }
            guard !Task.isCancelled else { return }; _ = self?.flushDraft()
        }
    }
    @discardableResult func flushDraft() -> Bool {
        debounce?.cancel(); debounce = nil
        guard !unreadable else { return false }
        guard draftDirty else { return draftError == nil }
        guard let file = draftFile else { draftError = nativeUI("编辑草稿尚未配置保存位置。", "The edit draft has no storage location."); return false }
        do {
            try FileManager.default.createDirectory(at:file.deletingLastPathComponent(),withIntermediateDirectories:true)
            // Stage separately so a write callback that writes and then throws
            // cannot consume the last durable retry envelope during ACK clear.
            let staged = file.deletingLastPathComponent().appendingPathComponent(".capture-draft-" + UUID().uuidString)
            defer { try? FileManager.default.removeItem(at:staged) }
            try write(JSONEncoder().encode(SavedDrafts(version:2,drafts:drafts.filter { $0.value.dirty },lifecycle:pendingLifecycle)),staged)
            try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:staged.path)
            let handle = try FileHandle(forWritingTo:staged); try handle.synchronize(); try handle.close()
            guard rename(staged.path,file.path) == 0 else { throw POSIXError(POSIXErrorCode(rawValue:errno) ?? .EIO) }
            draftDirty = false; draftError = nil; return true
        } catch { draftError = nativeUI("编辑草稿尚未保存到本机。请重试或复制内容后再退出。", "The edit draft is not saved locally. Retry or copy it before quitting."); return false }
    }
    func flushForQuit() -> Bool {
        // A pre-existing unreadable file is already preserved on disk and the
        // editor is locked. It must not make every subsequent quit impossible.
        unreadable ? !saving : flushDraft() && !saving
    }
    func save() async {
        guard canSave, let id = selected?.id, var draft = drafts[id] else { return }
        cancelTitleGeneration()
        if draft.pending == nil {
            guard !conflicted else { editError = nativeUI("请先核对最新版本；当前草稿仍保留。", "Review the latest version first; your draft is retained."); return }
            let changedTitle = draft.titleSource == "model" || draft.title != draft.originalTitle
            draft.pending = NativeQuickCaptureLibraryEdit(requestId:"quick_capture_edit_" + UUID().uuidString.lowercased(),id:id,expectedVersion:draft.version,text:draft.text,tags:Self.parseTags(draft.tags),title:changedTitle ? draft.title?.trimmingCharacters(in:.whitespacesAndNewlines) : nil,titleSource:draft.titleSource,expectedRecordVersion:draft.titleRecordVersion); drafts[id] = draft; draftDirty = true
        }
        guard flushDraft(), let payload = draft.pending else { return }
        saving = true; editError = nil
        defer { saving = false }
        do {
            let reply = try await response(payload.payload)
            guard reply.status == "saved" else { if ["changed","removed","collision"].contains(reply.reason ?? "") { conflicted = true }; throw NativeQuickCaptureError.rejected(reply.reason ?? "unavailable") }
            guard reply.id == id, reply.requestId == payload.requestId, let note = reply.note, note.id == id, note.updatedAt == reply.version, note.content == payload.text, note.tags == payload.tags, payload.title == nil || note.title == payload.title, payload.titleSource == nil || note.titleSource == payload.titleSource else { throw NativeQuickCaptureError.unconfirmed }
            // Do not clear a retry envelope on disk until its replacement is
            // durable. If that write fails, the exact envelope remains usable.
            let old = drafts[id]; drafts.removeValue(forKey:id); draftDirty = true
            if !flushDraft() { drafts[id] = old; draftDirty = true; return }
            if available { selected = note; editing = false; conflicted = false; rows = rows.map { $0.id == id ? note : $0 }; restoring = true; title = note.title; restoring = false }
        } catch { editError = error.localizedDescription }
    }
    /// The UI asks explicitly before discarding. Disk failure keeps the draft.
    func discardSelectedDraft() async {
        guard !saving, pendingLifecycle == nil, let id = selected?.id else { return }
        cancelTitleGeneration()
        let old = drafts.removeValue(forKey:id); draftDirty = true
        guard flushDraft() else { drafts[id] = old; draftDirty = true; return }
        editing = false; await select(id)
    }
    func open(_ link: NativeQuickCaptureLibraryLink? = nil) async {
        guard !saving, pendingLifecycle == nil, (!editing || flushDraft()), let selected else { return }
        if await openAction?(link?.type ?? "note",link?.id ?? selected.id) != true { editError = nativeUI("暂时无法打开，请先处理主窗口中的编辑或弹窗。", "Could not open it yet. Resolve the main window's editor or dialog first.") }
    }

    func toggleTrash() async {
        guard available, !saving, (!editing || flushDraft()) else { return }
        cancelTitleGeneration()
        showingTrash.toggle(); listEpoch += 1; selectionEpoch += 1
        await refresh()
    }
    private func refreshTrash() async {
        guard available else { return }
        listEpoch += 1; let epoch = listEpoch
        loading = true; error = nil
        defer { if epoch == listEpoch { loading = false } }
        do {
            let reply = try await response(["action":"trash"])
            guard epoch == listEpoch, available, showingTrash else { return }
            guard reply.status == "ready", let items = reply.trash else { throw NativeQuickCaptureError.rejected(reply.reason ?? "unavailable") }
            trash = items
        } catch { if epoch == listEpoch { self.error = error.localizedDescription } }
    }
    func removeSelected() async {
        guard canRemoveSelected, let note = selected, let version = note.recordVersion else { return }
        pendingLifecycle = NativeQuickCaptureLibraryLifecycle(requestId:"quick_capture_lifecycle_" + UUID().uuidString.lowercased(),action:"remove",title:note.title,id:note.id,expectedVersion:note.updatedAt,expectedRecordVersion:version)
        draftDirty = true; await retryLifecycle()
    }
    func restore(_ entry: NativeQuickCaptureLibraryTrash) async {
        guard canEdit, !hasUnsettledEditor, !entry.version.isEmpty else { return }
        pendingLifecycle = NativeQuickCaptureLibraryLifecycle(requestId:"quick_capture_lifecycle_" + UUID().uuidString.lowercased(),action:"restore",title:entry.title,trashId:entry.id,trashVersion:entry.version)
        draftDirty = true; await retryLifecycle()
    }
    func retryLifecycle() async {
        guard available, !saving, !unreadable, let pending = pendingLifecycle, pending.valid, flushDraft() else { return }
        saving = true; lifecycleError = nil; notice = nil
        defer { saving = false }
        do {
            let reply = try await response(pending.payload)
            guard reply.status == "saved" else { throw NativeQuickCaptureError.rejected(reply.reason ?? "unavailable") }
            guard reply.action == pending.action, reply.requestId == pending.requestId, reply.id?.isEmpty == false, reply.trashId?.isEmpty == false,
                  pending.action == "remove" ? reply.id == pending.id : reply.trashId == pending.trashId else { throw NativeQuickCaptureError.unconfirmed }
            pendingLifecycle = nil; draftDirty = true
            guard flushDraft() else { pendingLifecycle = pending; draftDirty = true; return }
            guard available else { return }
            if pending.action == "remove" {
                rows.removeAll { $0.id == pending.id }
                if selected?.id == pending.id { selected = nil; editing = false; restoring = true; title = ""; text = ""; tags = ""; restoring = false }
                notice = nativeUI("已移入回收站，可在“最近删除”中恢复。", "Moved to Trash. Restore it from Recently Deleted.")
            } else { trash.removeAll { $0.id == pending.trashId }; notice = nativeUI("已恢复到随记库。", "Restored to captures.") }
            await refresh()
        } catch {
            if available {
                if case NativeQuickCaptureError.rejected(let reason) = error, ["editing","editor_busy","draft_in_progress"].contains(reason) { lifecycleError = nativeUI("请先保存或结束主窗口对这条随记的编辑，再重试。", "Save or finish this capture's editor in the main window, then retry.") }
                else { lifecycleError = error.localizedDescription }
            }
        }
    }
    /// This explicitly ends automatic recovery attempts; it does not roll back
    /// a possibly committed operation. The immutable envelope remains on disk.
    func keepLifecycleRecovery() -> Bool {
        guard !saving, !unreadable, let pending = pendingLifecycle, let directory else { return false }
        do {
            let file = directory.appendingPathComponent(pending.requestId + "-recovery.json")
            try write(JSONEncoder().encode(pending),file)
            try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:file.path)
            pendingLifecycle = nil; draftDirty = true
            guard flushDraft() else { pendingLifecycle = pending; draftDirty = true; return false }
            lifecycleError = nil; notice = nativeUI("重试记录已保留到本机；可能已完成的操作不会被撤销。", "The retry record was retained on this Mac. A possibly completed operation is not undone.")
            return true
        } catch { lifecycleError = nativeUI("恢复记录尚未保存，请重试。", "The recovery record could not be saved. Please retry."); return false }
    }
}
