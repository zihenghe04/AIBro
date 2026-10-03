import Foundation
import Combine

struct NativeQuickLinkRow: Codable, Equatable, Identifiable {
    let id: String
    let title: String
    let url: String
    let site: String
    let folder: String
    let workspace: String
    let projectId: String?
    let projectTitle: String
    let version: String
    let createdAt: Double
    let hasContent: Bool
    let order: Double
    var canFetch: Bool?
    var fetchStatus: String?
    var fetchError: String?
    var iconDataUrl: String?
    var siteDescription: String?
    var metadataStatus: String?
    var metadataError: String?
    var groupID: String { [workspace,projectId ?? "",folder].joined(separator:"\u{1f}") }
}
struct NativeQuickLinkGroup: Codable, Equatable, Identifiable {
    let id: String
    let folder: String
    let workspace: String
    let projectId: String?
    let projectTitle: String
    let folderId: String?
    let version: String
    let linkIDs: [String]
    let canRename: Bool
    let canDelete: Bool
    let blockedReason: String
}
struct NativeQuickLinkProject: Codable, Equatable, Identifiable { let id: String; let title: String; let workspace: String }
struct NativeQuickLinkTrash: Codable, Equatable, Identifiable { let id: String; let title: String; let count: Int; let version: String; let deletedAt: Double }
enum NativeQuickLinkOrderAction: CaseIterable {
    case up, down, first, last
    var title: String {
        switch self {
        case .up: return nativeUI("上移", "Move up")
        case .down: return nativeUI("下移", "Move down")
        case .first: return nativeUI("置顶", "Move to top")
        case .last: return nativeUI("置底", "Move to bottom")
        }
    }
    func destination(from index: Int, count: Int) -> Int {
        switch self {
        case .up: return max(0, index - 1)
        case .down: return min(count - 1, index + 1)
        case .first: return 0
        case .last: return count - 1
        }
    }
}
/// A visual insertion boundary, expressed in stable record/folder IDs. The
/// destination index is computed only after removing the moving record.
struct NativeQuickLinkDropTarget: Equatable {
    let groupID: String
    var rowID: String? = nil
    var after = false
}
private struct NativeQuickLinksReply: Decodable {
    let status: String
    var reason: String?
    var rows: [NativeQuickLinkRow]?
    var groups: [NativeQuickLinkGroup]?
    var folderId: String?
    var groupId: String?
    var previousGroupId: String?
    var projects: [NativeQuickLinkProject]?
    var trash: [NativeQuickLinkTrash]?
    var requestId: String?
    var action: String?
    var ids: [String]?
    var trashId: String?
    var duplicate: Bool?
    var url: String?
    var id: String?
    var fetchStatus: String?
    var fetchError: String?
    var hasText: Bool?
    var metadataStatus: String?
    var metadataError: String?
    var iconStatus: String?
    var hasMetadata: Bool?
}
enum NativeQuickLinksError: LocalizedError {
    case unavailable, unconfirmed, rejected(String)
    var errorDescription: String? {
        switch self {
        case .unavailable: return nativeUI("链接库暂不可用。", "The link library is unavailable.")
        case .unconfirmed: return nativeUI("尚未收到保存确认，请重试原操作。", "The save is unconfirmed. Retry the original operation.")
        case .rejected(let reason):
            switch reason {
            case "changed", "collision": return nativeUI("资料已在其他位置修改。当前输入保留，请核对最新内容。", "The source changed elsewhere. Your input is retained; review the latest version.")
            case "removed": return nativeUI("资料或原归属已移除，未重新创建。", "The source or its destination was removed. Nothing was recreated.")
            case "folder_exists": return nativeUI("此位置已有同名目录，请使用现有目录或更换名称。", "This destination already has that folder. Use it or choose another name.")
            case "folder_shared": return nativeUI("此目录还含其他类型资料。请在主资料库整理，未更改任何内容。", "This folder also contains other source types. Organize them in the main library; nothing was changed.")
            case "folder_children": return nativeUI("此目录含子目录，不能只从链接库改名或删除。", "This folder has subfolders and cannot be renamed or removed from the link library.")
            case "folder_not_empty", "folder_protected": return nativeUI("此目录不为空或包含受保护资料，未更改任何内容。", "This folder is not empty or contains protected sources. Nothing was changed.")
            case "invalid": return nativeUI("请检查网址、标题和保存位置。", "Check the URL, title and destination.")
            case "storage_failed": return nativeUI("未确认写入本机；重试会沿用同一操作，不重复新增。", "Local saving is unconfirmed. Retry reuses this operation without creating a duplicate.")
            case "private": return nativeUI("私密内容不会显示在链接库。", "Private content is not shown in the link library.")
            default: return nativeUI("当前无法完成操作。输入保留，请稍后重试。", "The operation is unavailable. Your input is retained; retry later.")
            }
        }
    }
}

/// Published links belong to imports in the workspace. Only this editor's
/// unsent draft and immutable retry envelope are saved beside the workspace.
@MainActor final class NativeQuickLinksStore: ObservableObject {
    let recordFocus = NativeQuickRecordFocus()
    @Published private(set) var focusedRecordID: String?
    typealias Request = ([String: Any]) async throws -> [String: Any]
    @Published var query = "" {didSet{focusedRecordID=nil;if oldValue != query { presentationEpoch += 1 }}}
    // Presentation preferences are local to this workspace, independent of
    // record edits and the retry journal. Searches reveal matches temporarily.
    private struct ViewState: Codable {
        var version = 1
        var groupBySite = false
        var automaticMetadata: Bool? = nil
        var collapsedFolders = Set<String>()
        var collapsedSites = Set<String>()
    }
    @Published private var viewState = ViewState()
    @Published private(set) var viewStateError: String?
    @Published private(set) var refreshError: String?
    @Published private(set) var visible = false
    private var visibilityEpoch = 0
    private var presentationEpoch = 0
    private var automaticMetadataEpoch = 0
    var automaticMetadata: Bool { !viewStateReadOnly && viewState.automaticMetadata == true }
    var canChangeAutomaticMetadata: Bool { available && !viewStateReadOnly && directory != nil }
    /// A local opt-in, never a trigger to scan or retry existing bookmarks.
    func setAutomaticMetadata(_ value: Bool) {
        guard canChangeAutomaticMetadata, let file = viewStateFile else { return }
        automaticMetadataEpoch += 1
        var next = viewState; next.automaticMetadata = value
        // Closing the network opt-in takes effect even if local persistence fails.
        if !value { viewState = next }
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try write(JSONEncoder().encode(next), file); viewState = next; viewStateError = nil
        } catch {
            viewStateError = nativeUI("网站信息选项尚未保存，请重新设置。", "The website-details option was not saved. Set it again to retry.")
        }
    }
    func setVisible(_ value: Bool) {
        if visible != value { visibilityEpoch += 1; visible = value; automaticMetadataEpoch += 1 }
    }
    /// Conservative front-door filter only. The existing backend still resolves
    /// DNS, rejects private addresses and validates every redirect and favicon.
    static func permitsAutomaticMetadata(_ raw: String) -> Bool {
        guard let url = URL(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.user == nil, url.password == nil,
              let host = url.host?.lowercased(), host.contains("."), !host.hasSuffix("."), !host.contains(":"),
              let suffix = host.split(separator: ".").last, suffix.contains(where: { $0.isLetter }) else { return false }
        return !["localhost", "local", "internal", "lan", "test", "invalid", "example", "onion", "home.arpa"].contains { host == $0 || host.hasSuffix("." + $0) }
    }
    private var viewStateReadOnly = false
    var groupBySite: Bool {
        get { viewState.groupBySite }
        set {
            guard available, viewState.groupBySite != newValue else { return }
            presentationEpoch += 1; viewState.groupBySite = newValue; saveViewState()
        }
    }
    var isSearching: Bool { !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    func siteGroupID(for row: NativeQuickLinkRow) -> String {
        NativeQuickLinkSitePolicy.siteKey(for: row.url) ?? row.site
    }
    func isGroupCollapsed(_ id: String) -> Bool {
        if let focusedRecordID,rows.contains(where:{$0.id==focusedRecordID && (groupBySite ? siteGroupID(for:$0):$0.groupID)==id}) {return false}
        guard !isSearching else { return false }
        if !groupBySite { return viewState.collapsedFolders.contains(id) }
        if viewState.collapsedSites.contains(id) { return true }
        guard !viewState.collapsedSites.isEmpty else { return false }
        // Preserve a former exact-host collapsed state only when every current
        // member host was collapsed. Reading a new projection never rewrites it.
        let hosts = Set(rows.filter { siteGroupID(for:$0)==id }.map(\.site))
        return !hosts.isEmpty && hosts.isSubset(of:viewState.collapsedSites)
    }
    func toggleGroup(_ id: String) {
        guard available, !isSearching, !id.isEmpty else { return }
        let wasCollapsed = isGroupCollapsed(id)
        presentationEpoch += 1
        focusedRecordID=nil
        if groupBySite {
            if wasCollapsed {
                viewState.collapsedSites.remove(id)
                viewState.collapsedSites.subtract(rows.filter { siteGroupID(for:$0)==id }.map(\.site))
            } else { viewState.collapsedSites.insert(id) }
        } else {
            if !viewState.collapsedFolders.insert(id).inserted { viewState.collapsedFolders.remove(id) }
        }
        saveViewState()
    }
    @Published var showingTrash = false { didSet { if oldValue != showingTrash { presentationEpoch += 1 } } }
    @Published private(set) var rows: [NativeQuickLinkRow] = []
    @Published private(set) var orderRevision = 0
    @Published private(set) var groups: [NativeQuickLinkGroup] = []
    @Published private(set) var projects: [NativeQuickLinkProject] = []
    @Published private(set) var trash: [NativeQuickLinkTrash] = []
    @Published private(set) var loading = false
    @Published private(set) var saving = false
    @Published private(set) var available = false
    @Published private(set) var editing = false
    @Published private(set) var error: String?
    @Published private(set) var draftError: String?
    @Published private(set) var notice: String?
    @Published var url = "" { didSet { changed(); updateSiteFolderDefault() } }
    @Published var title = "" { didSet { changed() } }
    @Published var folder = "链接收藏" { didSet { if !loadingDraft && !applyingSiteFolderDefault && editing { acceptsSiteFolderDefault=false }; changed() } }
    @Published var workspace = "日常" { didSet { changed(); updateSiteFolderDefault() } }
    @Published var projectID = "" { didSet { changed(); updateSiteFolderDefault() } }
    @Published private(set) var pending: Data?
    private struct Form: Codable, Equatable {
        var url: String; var title: String; var folder: String; var workspace: String; var projectID: String
        static let empty = Self(url:"",title:"",folder:"链接收藏",workspace:"日常",projectID:"")
    }
    private struct GroupDraft: Codable { var existing: NativeQuickLinkGroup? }
    @Published private var groupDraft: GroupDraft?
    var editingGroup: Bool { groupDraft != nil }
    private struct Draft: Codable { let version: Int; var form: Form; var baseline: Form; var id: String?; var expectedVersion: String?; var pending: Data?; var editing: Bool; var group: GroupDraft? }
    private var baseline = Form.empty
    private var editID: String?
    private var expectedVersion: String?
    private var directory: URL?
    private var request: Request?
    private var openSource: ((String) async -> Bool)?
    private var openURL: ((URL) -> Bool)?
    private var write: (Data, URL) throws -> Void
    // Only a fresh, unassigned form can follow the unique local site folder.
    // Restored drafts and explicit folder input always keep their saved choice.
    private var acceptsSiteFolderDefault = false
    private var applyingSiteFolderDefault = false
    private var loadingDraft = false
    private var corrupted = false
    private var dirty = false
    private var epoch = 0
    // A cleared search field does not make its still-filtered result complete.
    // Ordering remains unavailable until that exact list request has returned.
    private var listedQuery: String?
    private var accessEpoch = 0
    private var debounce: Task<Void, Never>?
    private var file: URL? { directory?.appendingPathComponent("native-quick-links-draft.json") }
    private var viewStateFile: URL? { directory?.appendingPathComponent("native-quick-links-view.json") }
    private var form: Form { .init(url:url,title:title,folder:folder,workspace:workspace,projectID:projectID) }
    var editingExisting: Bool { editID != nil || groupDraft?.existing != nil }
    var hasChanges: Bool { pending != nil || editing && form != baseline }
    var hasUnsettledEditor: Bool { saving || hasChanges }
    var fetchingID: String? {
        guard saving, let pending, let value=try? Self.validatedPayload(pending), ["fetch","metadata"].contains(value["action"] as? String ?? "") else { return nil }
        return (value["items"] as? [[String:Any]])?.first?["id"] as? String
    }
    var fetchingMetadata:Bool {guard saving,let pending,let value=try? Self.validatedPayload(pending) else{return false};return value["action"] as? String=="metadata"}
    var inputLocked: Bool { saving || pending != nil || corrupted || !available }
    var canSave: Bool {
        if editingGroup { return !inputLocked && editing && !folder.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty && folder.utf16.count <= 240 && (groupDraft?.existing == nil || folder != baseline.folder) }
        return !inputLocked && editing && url.utf16.count <= 8192 && title.utf16.count <= 1000 && folder.utf16.count <= 240 && !url.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty && !folder.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty && (!editingExisting || !title.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty) }
    /// Suggestions are a projection, never a change to the user's chosen scope.
    /// A filtered/in-flight list cannot prove the complete candidate set.
    var siteGroupSuggestions: [NativeQuickLinkGroup] {
        guard available,visible,editing,!editingExisting,!editingGroup,!inputLocked,!loading,
              !showingTrash,!isSearching,listedQuery==query,refreshError==nil,
              let site=NativeQuickLinkSitePolicy.siteKey(for:url) else { return [] }
        let scoped=rows.filter { $0.workspace==workspace && ($0.projectId ?? "")==projectID }
        let matches=Set(scoped.filter { NativeQuickLinkSitePolicy.siteKey(for:$0.url)==site }.map(\.groupID))
        return groups.filter { group in
            matches.contains(group.id) && group.workspace==workspace && (group.projectId ?? "")==projectID &&
            !["folder_protected","changed"].contains(group.blockedReason) &&
            groups.filter({$0.id==group.id}).count==1 &&
            Set(group.linkIDs).isSuperset(of:scoped.filter({$0.groupID==group.id}).map(\.id))
        }
    }
    private func updateSiteFolderDefault() {
        guard acceptsSiteFolderDefault,!loadingDraft,available,visible,editing,!editingExisting,!editingGroup,
              !inputLocked,!loading,!showingTrash,!isSearching,listedQuery==query,refreshError==nil else { return }
        let candidates=siteGroupSuggestions
        let proposed=candidates.count==1 ? candidates[0].folder : Form.empty.folder
        guard folder != proposed else { return }
        applyingSiteFolderDefault=true; folder=proposed; applyingSiteFolderDefault=false
    }
    @discardableResult func useSiteGroupSuggestion(_ group:NativeQuickLinkGroup) -> Bool {
        // Re-evaluate at the explicit action, including the group's version and
        // current URL/project. A menu captured before a refresh cannot apply.
        guard siteGroupSuggestions.contains(group) else { return false }
        folder=group.folder
        return true
    }
    init(write: @escaping (Data, URL) throws -> Void = { data,file in
        try data.write(to:file,options:.atomic); try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:file.path)
    }) { self.write = write }
    func configure(directory: URL, request: @escaping Request, openSource: @escaping (String) async -> Bool, openURL: @escaping (URL) -> Bool) {
        accessEpoch += 1; automaticMetadataEpoch += 1
        guard self.directory == nil || self.directory == directory else { setAvailable(false); self.request=nil; draftError=nativeUI("输入属于原工作区。", "This input belongs to the previous workspace."); return }
        self.request=request; self.openSource=openSource; self.openURL=openURL
        guard self.directory == nil else { return }; self.directory=directory
        loadViewState()
        guard let file, FileManager.default.fileExists(atPath:file.path) else { return }
        do {
            let draft=try JSONDecoder().decode(Draft.self,from:Data(contentsOf:file))
            guard draft.version == 1, draft.form.url.utf16.count <= 8192, draft.form.title.utf16.count <= 1000, draft.form.folder.utf16.count <= 240 else { throw CocoaError(.fileReadCorruptFile) }
            if let pending=draft.pending { _ = try Self.validatedPayload(pending) }
            baseline=draft.baseline; editID=draft.id; expectedVersion=draft.expectedVersion; pending=draft.pending; editing=draft.editing; groupDraft=draft.group; load(draft.form)
        } catch { corrupted=true; draftError=nativeUI("无法读取链接草稿，原文件已保留。", "The link draft could not be read. Its original file is preserved.") }
    }
    private func loadViewState() {
        guard let file = viewStateFile, FileManager.default.fileExists(atPath: file.path) else { return }
        do {
            let data = try Data(contentsOf: file)
            guard data.count <= 1_048_576 else { throw CocoaError(.fileReadCorruptFile) }
            let saved = try JSONDecoder().decode(ViewState.self, from: data)
            guard saved.version == 1 else { throw CocoaError(.fileReadCorruptFile) }
            viewState = saved
        } catch {
            viewStateReadOnly = true
            viewStateError = nativeUI("未能恢复链接布局，原设置文件已保留。", "Link layout could not be restored. The original settings file is preserved.")
        }
    }
    private func saveViewState() {
        guard !viewStateReadOnly, let file = viewStateFile else { return }
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try write(JSONEncoder().encode(viewState), file)
            viewStateError = nil
        } catch {
            viewStateError = nativeUI("本次链接布局尚未保存，重新调整后可重试。", "This link layout is not saved yet. Change it again to retry.")
        }
    }
    func setAvailable(_ value: Bool) {
        let value=value && request != nil
        if available == value { return }; available=value; epoch += 1; accessEpoch += 1; automaticMetadataEpoch += 1
        if !value { recordFocus.cancel();focusedRecordID=nil;_ = flushDraft(); rows=[]; groups=[]; projects=[]; trash=[]; loading=false; notice=nil; refreshError=nil; listedQuery=nil }
    }
    func prepareRecordFocus(id:String) async -> Bool {
        guard available,!editing,!hasUnsettledEditor else{return false}
        query="";showingTrash=false
        await refresh()
        guard available,!editing,!hasUnsettledEditor,rows.filter({$0.id==id}).count==1 else{return false}
        focusedRecordID=id;return true
    }
    func clearRecordFocus() {recordFocus.cancel();focusedRecordID=nil}
    func focusRecord(id:String,show:()->Void,canPresent:@escaping()->Bool,isPresented:@escaping()->Bool) async -> Bool {
        guard let row=rows.first(where:{$0.id==id}) else{return false}
        let valid = { [weak self] in
            guard let self else{return false}
            return self.available && !self.editing && !self.hasUnsettledEditor && !self.showingTrash && self.focusedRecordID==id &&
                self.rows.contains(where:{$0.id==id && $0.version==row.version}) && canPresent()
        }
        return await recordFocus.present(id:id,show:show,canPresent:valid,isPresented:isPresented)
    }
    private static func validatedPayload(_ data: Data) throws -> [String: Any] {
        guard data.count <= 1_048_576, let value=try JSONSerialization.jsonObject(with:data) as? [String:Any],
              let id=value["requestId"] as? String, id.hasPrefix("quick_link_"), UUID(uuidString:String(id.dropFirst(11))) != nil,
              ["add","update","remove","restore","fetch","metadata","folder-create","folder-rename","folder-delete"].contains(value["action"] as? String ?? "") else { throw CocoaError(.fileReadCorruptFile) }
        return value
    }
    private func load(_ value: Form) { loadingDraft=true; url=value.url; title=value.title; folder=value.folder; workspace=value.workspace; projectID=value.projectID; loadingDraft=false }
    private func changed() {
        guard !loadingDraft, editing, pending == nil else { return }; dirty=true; notice=nil
        debounce?.cancel(); debounce=Task { @MainActor [weak self] in
            do { try await Task.sleep(nanoseconds:300_000_000) } catch { return }; guard !Task.isCancelled else { return }; _ = self?.flushDraft()
        }
    }
    @discardableResult func flushDraft() -> Bool {
        debounce?.cancel(); debounce=nil
        guard !corrupted else { return false }; guard dirty else { return draftError == nil }
        guard let file else { draftError=nativeUI("尚未配置草稿位置。", "The draft location is unavailable."); return false }
        do {
            try FileManager.default.createDirectory(at:file.deletingLastPathComponent(),withIntermediateDirectories:true)
            try write(JSONEncoder().encode(Draft(version:1,form:form,baseline:baseline,id:editID,expectedVersion:expectedVersion,pending:pending,editing:editing,group:groupDraft)),file)
            dirty=false; draftError=nil; return true
        } catch { draftError=nativeUI("链接输入尚未保存到本机，请重试后再退出。", "The link input is not saved locally. Retry before quitting."); return false }
    }
    func flushForQuit() -> Bool { corrupted ? !saving : flushDraft() && !saving }
    private func reply(_ payload: [String:Any]) async throws -> NativeQuickLinksReply {
        guard available, let request else { throw NativeQuickLinksError.unavailable }
        return try JSONDecoder().decode(NativeQuickLinksReply.self,from:JSONSerialization.data(withJSONObject:try await request(payload)))
    }
    func refresh(animateOrder:Bool=false) async {
        guard available else { return }; epoch += 1; let token=epoch, needle=query; loading=true
        defer { if token==epoch { loading=false; updateSiteFolderDefault() } }
        do {
            let result=try await reply(["action":"list","query":needle])
            guard available, token==epoch, needle==query else { return }
            guard result.status=="ready", let rows=result.rows, let projects=result.projects, let trash=result.trash else { throw NativeQuickLinksError.rejected(result.reason ?? "unavailable") }
            if animateOrder, self.rows.map({$0.id + "\u{1e}" + $0.groupID}) != rows.map({$0.id + "\u{1e}" + $0.groupID}) {orderRevision += 1}
            self.rows=rows; self.groups=result.groups ?? []; self.projects=projects; self.trash=trash; listedQuery=needle; refreshError=nil
        } catch { if available,token==epoch { self.refreshError=error.localizedDescription } }
    }
    func beginNew(folder: String? = nil) {
        guard available, !corrupted, !hasUnsettledEditor else { return }
        baseline = .empty; editID=nil; expectedVersion=nil; groupDraft=nil; load(.empty)
        acceptsSiteFolderDefault = folder == nil
        editing=true; if let folder { self.folder=folder }; updateSiteFolderDefault(); error=nil; notice=nil; dirty=true; _ = flushDraft()
    }
    func beginNew(in group: NativeQuickLinkRow) {
        guard available, !corrupted, !hasUnsettledEditor else { return }
        beginNew(folder:group.folder); workspace=group.workspace; projectID=group.projectId ?? ""; _ = flushDraft()
    }
    func beginNew(in group: NativeQuickLinkGroup) {
        guard available, !corrupted, !hasUnsettledEditor else { return }
        beginNew(folder:group.folder); workspace=group.workspace; projectID=group.projectId ?? ""; _ = flushDraft()
    }
    func beginGroup(_ group: NativeQuickLinkGroup? = nil) {
        guard available, !corrupted, !hasUnsettledEditor, group?.canRename != false else { return }
        baseline=Form(url:"",title:"",folder:group?.folder ?? "",workspace:group?.workspace ?? "日常",projectID:group?.projectId ?? "")
        editID=nil; expectedVersion=nil; groupDraft=GroupDraft(existing:group)
        load(baseline); editing=true; error=nil; notice=nil; dirty=true; _ = flushDraft()
    }
    func deleteGroup(_ group: NativeQuickLinkGroup) async {
        guard !hasUnsettledEditor, group.canDelete else { return }
        await perform(["action":"folder-delete","folder":group.folder,"workspace":group.workspace,"projectId":group.projectId as Any? ?? NSNull(),"folderId":group.folderId as Any? ?? NSNull(),"expectedVersion":group.version])
    }
    func beginEditing(_ row: NativeQuickLinkRow) {
        guard available, !corrupted, !hasUnsettledEditor else { return }
        baseline=Form(url:row.url,title:row.title,folder:row.folder,workspace:row.workspace,projectID:row.projectId ?? "")
        groupDraft=nil; editID=row.id; expectedVersion=row.version; load(baseline); editing=true; error=nil; notice=nil; dirty=true; _ = flushDraft()
    }
    /// Explicitly confirmed by the view. Does not undo an already committed
    /// command; dropping an uncertain retry envelope never resubmits it.
    @discardableResult func discardDraft() -> Bool {
        guard !saving, !corrupted else { return false }
        let old=Draft(version:1,form:form,baseline:baseline,id:editID,expectedVersion:expectedVersion,pending:pending,editing:editing,group:groupDraft)
        pending=nil; baseline = .empty; editID=nil; expectedVersion=nil; editing=false; groupDraft=nil; load(.empty); dirty=true
        if !flushDraft() { baseline=old.baseline; editID=old.id; expectedVersion=old.expectedVersion; pending=old.pending; editing=old.editing; groupDraft=old.group; load(old.form); dirty=true; return false }
        error=nil; return true
    }
    func saveEditor() async {
        guard canSave else { return }
        if let groupDraft {
            if let group=groupDraft.existing {
                await perform(["action":"folder-rename","folder":group.folder,"newFolder":folder,"workspace":group.workspace,"projectId":group.projectId as Any? ?? NSNull(),"folderId":group.folderId as Any? ?? NSNull(),"expectedVersion":group.version,"expectedIDs":group.linkIDs])
            } else { await perform(["action":"folder-create","folder":folder,"workspace":workspace,"projectId":projectID.isEmpty ? NSNull() : projectID as Any]) }
            return
        }
        let scope:[String:Any]=["title":title,"folder":folder,"workspace":workspace,"projectId":projectID.isEmpty ? NSNull() : projectID as Any]
        if let id=editID, let version=expectedVersion { await perform(["action":"update","items":[["id":id,"expectedVersion":version,"patch":scope]]]) }
        else {
            let owner = accessEpoch, token = automaticMetadataEpoch
            let visibility = visibilityEpoch, presentation = presentationEpoch, savedFolder = folder, savedWorkspace = workspace, savedProject = projectID
            let revealSiteFolder = siteGroupSuggestions.contains { $0.folder==folder }
            let optedIn = automaticMetadata && visible
            let result = await perform(scope.merging(["action":"add","url":url]){_,new in new})
            // Reveal the confirmed record in its existing folder without
            // changing persisted collapse preferences or moving keyboard focus.
            if revealSiteFolder,available,visible,accessEpoch==owner,visibilityEpoch==visibility,presentationEpoch==presentation,
               !editing,!isSearching,!showingTrash,refreshError==nil,
               let ids=result?.ids,ids.count==1,let id=ids.first,
               rows.contains(where:{$0.id==id && $0.folder==savedFolder && $0.workspace==savedWorkspace && ($0.projectId ?? "")==savedProject}) {
                focusedRecordID=id
            }
            if optedIn, let result, result.duplicate == false, result.ids?.count == 1,
               let id = result.ids?.first, id == result.requestId {
                await fetchAutomaticMetadata(id: id, owner: owner, token: token)
            }
        }
    }
    private func fetchAutomaticMetadata(id: String, owner: Int, token: Int) async {
        let allowed = { self.available && self.visible && self.automaticMetadata && self.accessEpoch == owner &&
            self.automaticMetadataEpoch == token && !self.editing && !self.hasUnsettledEditor && self.refreshError == nil }
        guard allowed() else { return }
        var candidates = rows.filter { $0.id == id }
        // An active search may hide the just-saved record. Resolve its current
        // version without clearing the user's search or replacing their list.
        if candidates.isEmpty {
            do {
                let snapshot = try await reply(["action":"list", "query":""])
                guard allowed(), snapshot.status == "ready" else { return }
                candidates = (snapshot.rows ?? []).filter { $0.id == id }
            } catch { return }
        }
        guard allowed(), candidates.count == 1, let row = candidates.first,
              Self.permitsAutomaticMetadata(row.url) else { return }
        // Existing metadata mutation owns title provenance, scope/version CAS,
        // public network validation and durable ACK. It never downloads body.
        await perform(["action":"metadata", "items":[["id":row.id, "expectedVersion":row.version]]])
    }
    func update(_ rows: [NativeQuickLinkRow], patch: [String:Any]) async {
        guard !hasUnsettledEditor else { return }
        await perform(["action":"update","items":rows.map{["id":$0.id,"expectedVersion":$0.version,"patch":patch] as [String:Any]}])
    }
    func reorder(_ row: NativeQuickLinkRow, before target: NativeQuickLinkRow) async {
        guard row.groupID==target.groupID, rows.contains(target) else { return }
        _ = await place(row, at:.init(groupID:target.groupID,rowID:target.id))
    }
    /// Menu actions use the complete current folder, never a site grouping or
    /// search projection. The bridge checks every version before one durable
    /// update; rows remain unchanged locally until its ACK and refreshed list.
    func canReorder(_ row: NativeQuickLinkRow, action: NativeQuickLinkOrderAction) -> Bool {
        guard let ordered = reorderableFolder(row), let index = ordered.firstIndex(where: { $0.id == row.id }) else { return false }
        return action.destination(from: index, count: ordered.count) != index
    }
    @discardableResult func reorder(_ row: NativeQuickLinkRow, action: NativeQuickLinkOrderAction) async -> Bool {
        guard var ordered = reorderableFolder(row), let index = ordered.firstIndex(where: { $0.id == row.id }) else { return false }
        let destination = action.destination(from: index, count: ordered.count)
        guard destination != index else { return false }
        ordered.insert(ordered.remove(at: index), at: destination)
        let owner = accessEpoch
        await perform(["action":"update","items":ordered.enumerated().map {
            ["id":$0.element.id,"expectedVersion":$0.element.version,"patch":["order":$0.offset]] as [String:Any]
        }],animateOrder:true)
        // Unconfirmed writes retain their immutable retry, even if a later
        // refresh exposes the proposed order. Only settled ACK + projection may
        // request keyboard restoration; never infer success from row order alone.
        return available && accessEpoch == owner && pending == nil && error == nil && refreshError == nil &&
            rows.filter { $0.groupID == row.groupID }.map(\.id) == ordered.map(\.id)
    }
    private func reorderableFolder(_ row: NativeQuickLinkRow) -> [NativeQuickLinkRow]? {
        guard available, !inputLocked, !editing, !loading, !showingTrash, !groupBySite, !isSearching,
              listedQuery == query, rows.filter({ $0.id == row.id }).count == 1, rows.contains(row) else { return nil }
        let ordered = rows.filter { $0.groupID == row.groupID }
        // This is the bridge's atomic mutation limit, not a display truncation.
        guard ordered.count > 1, ordered.count <= 500, Set(ordered.map(\.id)).count == ordered.count else { return nil }
        if let group = groups.first(where: { $0.id == row.groupID }) {
            guard !["folder_protected", "changed"].contains(group.blockedReason), Set(group.linkIDs).isSuperset(of: ordered.map(\.id)) else { return nil }
        }
        return ordered
    }
    func orderFocusValidator(for row: NativeQuickLinkRow) -> () -> Bool {
        let owner = accessEpoch, id = row.id, groupID = row.groupID
        return { [weak self] in
            guard let self else { return false }
            return self.available && self.accessEpoch == owner && !self.editing && !self.showingTrash &&
                !self.groupBySite && !self.isSearching && !self.isGroupCollapsed(groupID) &&
                self.rows.contains(where: { $0.id == id && $0.groupID == groupID })
        }
    }
    var canArrangeLinks: Bool {
        available && !inputLocked && !editing && !loading && !showingTrash && !groupBySite && !isSearching && listedQuery == query
    }
    func canDrag(_ row: NativeQuickLinkRow) -> Bool {
        canArrangeLinks && rows.contains(row) && rows.filter { $0.id == row.id }.count == 1
    }
    func dragValidator(for row: NativeQuickLinkRow) -> () -> Bool {
        let owner=accessEpoch, listEpoch=epoch, visibility=visibilityEpoch
        return { [weak self] in
            guard let self else { return false }
            return self.visible && self.visibilityEpoch==visibility && self.accessEpoch==owner && self.epoch==listEpoch && self.canDrag(row)
        }
    }
    func moveFocusValidator(for row: NativeQuickLinkRow) -> () -> Bool {
        let owner=accessEpoch, visibility=visibilityEpoch
        return { [weak self] in
            guard let self else { return false }
            return self.available && self.visible && self.visibilityEpoch==visibility && self.accessEpoch==owner && !self.editing && !self.showingTrash &&
                !self.groupBySite && !self.isSearching && self.rows.contains { $0.id==row.id }
        }
    }
    func revealOrderedLink(_ id:String) { if available,visible,rows.contains(where:{$0.id==id}) { focusedRecordID=id } }
    func canPlace(_ row:NativeQuickLinkRow, at target:NativeQuickLinkDropTarget) -> Bool { placement(row,at:target) != nil }
    private func placement(_ row:NativeQuickLinkRow, at target:NativeQuickLinkDropTarget) -> (rows:[NativeQuickLinkRow],group:NativeQuickLinkGroup?)? {
        guard canDrag(row),target.rowID != row.id else { return nil }
        let destination=groups.first { $0.id==target.groupID }
        guard target.groupID==row.groupID || destination != nil else { return nil }
        if let destination, ["folder_protected","changed"].contains(destination.blockedReason) { return nil }
        if let source=groups.first(where:{$0.id==row.groupID}), ["folder_protected","changed"].contains(source.blockedReason) { return nil }
        let original=rows.filter { $0.groupID==target.groupID }
        guard Set(original.map(\.id)).count==original.count else { return nil }
        if let destination, !Set(destination.linkIDs).isSuperset(of:original.map(\.id)) { return nil }
        var ordered=original.filter { $0.id != row.id }
        if let id=target.rowID {
            guard let index=ordered.firstIndex(where:{$0.id==id}) else { return nil }
            ordered.insert(row,at:index + (target.after ? 1 : 0))
        } else { ordered.append(row) }
        guard ordered.count<=500, ordered.map(\.id) != original.map(\.id) else { return nil }
        return (ordered,destination)
    }
    /// One existing durable update, never an optimistic mutation or a second
    /// order store. Failed/unknown ACK keeps the original request for retry.
    @discardableResult func place(_ row:NativeQuickLinkRow, at target:NativeQuickLinkDropTarget) async -> Bool {
        guard let plan=placement(row,at:target) else { return false }
        let owner=accessEpoch
        let items=plan.rows.enumerated().map { index,item -> [String:Any] in
            var patch:[String:Any]=["order":index]
            if item.id==row.id, row.groupID != target.groupID, let group=plan.group {
                patch["folder"]=group.folder;patch["workspace"]=group.workspace;patch["projectId"]=group.projectId as Any? ?? NSNull()
            }
            return ["id":item.id,"expectedVersion":item.version,"patch":patch]
        }
        var payload:[String:Any]=["action":"update","items":items]
        if row.groupID != target.groupID,let group=plan.group {
            payload["destination"]=["folder":group.folder,"workspace":group.workspace,"projectId":group.projectId as Any? ?? NSNull(),"expectedVersion":group.version]
        }
        let reply=await perform(payload,animateOrder:true)
        return reply != nil && available && accessEpoch==owner && pending==nil && error==nil && refreshError==nil &&
            rows.filter { $0.groupID==target.groupID }.map(\.id)==plan.rows.map(\.id)
    }
    func move(_ row: NativeQuickLinkRow, to group: NativeQuickLinkGroup, before target: NativeQuickLinkRow? = nil) async {
        guard groups.contains(group), target == nil || rows.contains(target!) else { return }
        _ = await place(row,at:.init(groupID:group.id,rowID:target?.id))
    }
    func remove(_ rows: [NativeQuickLinkRow]) async {
        guard !hasUnsettledEditor else { return }
        await perform(["action":"remove","items":rows.map{["id":$0.id,"expectedVersion":$0.version]}])
    }
    func restore(_ entry: NativeQuickLinkTrash) async {
        guard !hasUnsettledEditor else { return }
        await perform(["action":"restore","trashId":entry.id,"expectedVersion":entry.version])
    }
    func fetchContent(_ row: NativeQuickLinkRow) async {
        guard !hasUnsettledEditor, row.canFetch == true else { return }
        await perform(["action":"fetch","items":[["id":row.id,"expectedVersion":row.version]]])
    }
    func fetchMetadata(_ row:NativeQuickLinkRow) async {
        guard !hasUnsettledEditor,rows.contains(row) else{return}
        await perform(["action":"metadata","items":[["id":row.id,"expectedVersion":row.version]]])
    }
    @discardableResult private func perform(_ input: [String:Any],animateOrder:Bool=false) async -> NativeQuickLinksReply? {
        guard available, !saving, pending == nil, !corrupted else { return nil }
        var value=input; value["requestId"]="quick_link_" + UUID().uuidString.lowercased()
        do { pending=try JSONSerialization.data(withJSONObject:value,options:.sortedKeys); dirty=true; guard flushDraft() else { return nil }; return await settlePending(animateOrder:animateOrder) }
        catch { self.error=error.localizedDescription; return nil }
    }
    func retry() async { _ = await settlePending() }
    private func settlePending(animateOrder:Bool=false) async -> NativeQuickLinksReply? {
        guard available, !saving, let pending, !corrupted, flushDraft() else { return nil }
        let owner=accessEpoch
        saving=true; error=nil; defer { saving=false }
        do {
            let payload=try Self.validatedPayload(pending), result=try await reply(payload)
            guard available,accessEpoch==owner,self.pending==pending else{return nil}
            guard result.status=="saved" else { throw NativeQuickLinksError.rejected(result.reason ?? "unavailable") }
            let isGroup=(payload["action"] as? String ?? "").hasPrefix("folder-")
            guard result.requestId==payload["requestId"] as? String, result.action==payload["action"] as? String, let ids=result.ids, isGroup || !ids.isEmpty else { throw NativeQuickLinksError.unconfirmed }
            if isGroup {
                guard let groupID=result.groupId, !groupID.isEmpty,
                      result.folderId == (result.action=="folder-create" ? payload["requestId"] as? String : payload["folderId"] as? String),
                      Set(ids)==Set(payload["expectedIDs"] as? [String] ?? []) else { throw NativeQuickLinksError.unconfirmed }
            }
            if let items=payload["items"] as? [[String:Any]], Set(ids) != Set(items.compactMap{$0["id"] as? String}) { throw NativeQuickLinksError.unconfirmed }
            if payload["action"] as? String=="restore", result.trashId != payload["trashId"] as? String { throw NativeQuickLinksError.unconfirmed }
            if payload["action"] as? String=="fetch", !["ready","failed"].contains(result.fetchStatus ?? "") { throw NativeQuickLinksError.unconfirmed }
            if payload["action"] as? String=="metadata", !["ready","failed"].contains(result.metadataStatus ?? "") { throw NativeQuickLinksError.unconfirmed }
            // Clear disk before clearing the visible transaction; a failed
            // cleanup leaves the original exact envelope safe to retry.
            let old=Draft(version:1,form:form,baseline:baseline,id:editID,expectedVersion:expectedVersion,pending:pending,editing:editing,group:groupDraft)
            self.pending=nil; editing=false; baseline = .empty; editID=nil; expectedVersion=nil; groupDraft=nil; load(.empty); dirty=true
            if !flushDraft() { baseline=old.baseline; editID=old.id; expectedVersion=old.expectedVersion; self.pending=pending; editing=old.editing; groupDraft=old.group; load(old.form); dirty=true; return nil }
            if available {
                if isGroup {
                    query=""; showingTrash=false; groupBySite=false
                    if let previous=result.previousGroupId, let next=result.groupId, viewState.collapsedFolders.remove(previous) != nil { viewState.collapsedFolders.insert(next); saveViewState() }
                    if result.action=="folder-delete", let groupID=result.groupId { viewState.collapsedFolders.remove(groupID); saveViewState() }
                }
                if result.action=="fetch" {
                    if result.fetchStatus=="failed" {
                        notice=nil; error=result.fetchError ?? nativeUI("抓取未完成，收藏已保留，可稍后重试。", "Download incomplete. The bookmark is retained; retry later.")
                    } else {
                        notice=result.hasText == true ? nativeUI("正文已保存，可在资料库阅读与检索。", "Content saved for reading and search in the library.") : nativeUI("原件已保存，尚无可检索正文。", "Original saved; searchable text is not available yet.")
                    }
                } else if result.action=="metadata" {
                    if result.metadataStatus=="failed" {notice=nil;error=result.metadataError ?? nativeUI("网站信息尚未获取，原资料已保留。", "Website details could not be retrieved. Saved sources are unchanged.")}
                    else if result.hasMetadata==false {notice=nativeUI("网站未提供可用信息与图标，原资料已保留。", "The website provided no usable details or icon. Saved sources are unchanged.")}
                    else {notice=result.iconStatus=="ready" ? nativeUI("网站信息与图标已保存在本机。", "Website details and icon saved locally.") : nativeUI("网站信息已保存；未取得新图标，保留原图标。", "Website details saved. No new icon was available; the previous icon is retained.")}
                } else { notice=result.duplicate == true ? nativeUI("该网址已在此位置收藏。", "This URL is already saved in this destination.") : nativeUI("已保存到本机资料库", "Saved to the local library") }
                await refresh(animateOrder:animateOrder)
            }
            return result
        } catch { if available,accessEpoch==owner {self.error=error.localizedDescription}; return nil }
    }
    func open(_ row: NativeQuickLinkRow, inLibrary: Bool = false) async {
        guard available else { return }
        do {
            let result=try await reply(["action":"open","id":row.id])
            guard available, result.status=="ready", result.id==row.id else { throw NativeQuickLinksError.rejected(result.reason ?? "removed") }
            if inLibrary { guard await openSource?(row.id) == true else { throw NativeQuickLinksError.unavailable } }
            else {
                guard let value=result.url, let url=URL(string:value), ["http","https"].contains(url.scheme?.lowercased() ?? ""), url.user==nil, url.password==nil, openURL?(url)==true else { throw NativeQuickLinksError.unavailable }
            }
        } catch { self.error=error.localizedDescription }
    }
}
