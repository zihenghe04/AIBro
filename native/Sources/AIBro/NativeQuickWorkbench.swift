import Foundation
import Combine
import Darwin

enum NativeQuickTaskDate: Codable, Equatable {
    case text(String), milliseconds(Double)
    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if let text = try? value.decode(String.self) { self = .text(text) }
        else { self = .milliseconds(try value.decode(Double.self)) }
    }
    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self { case .text(let text): try value.encode(text); case .milliseconds(let number): try value.encode(number) }
    }
    var jsonValue: Any { switch self { case .text(let text): return text; case .milliseconds(let number): return number } }
    var date: Date? {
        switch self {
        case .milliseconds(let value): return value.isFinite ? Date(timeIntervalSince1970: value / 1000) : nil
        case .text(let text):
            if text.count == 10 {
                let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.calendar = Calendar(identifier: .gregorian)
                formatter.dateFormat = "yyyy-MM-dd"; formatter.isLenient = false
                guard let date = formatter.date(from: text), formatter.string(from: date) == text else { return nil }; return date
            }
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            return formatter.date(from: text) ?? ISO8601DateFormatter().date(from: text)
        }
    }
    var isDay: Bool { if case .text(let value) = self { return value.count == 10 }; return false }
    static func day(_ date: Date) -> Self {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.calendar = Calendar(identifier: .gregorian); formatter.dateFormat = "yyyy-MM-dd"
        return .text(formatter.string(from: date))
    }
    static func time(_ date: Date) -> Self { .text(ISO8601DateFormatter().string(from: date)) }
}

struct NativeQuickTaskFields: Codable, Equatable {
    var workspace = "日常"
    var projectId: String? = nil
    var dueAt: NativeQuickTaskDate? = nil
    var workflowCategory: String? = nil
    var valid: Bool { ["日常", "课程", "科研"].contains(workspace) && (projectId == nil || !(projectId?.isEmpty ?? true)) && (dueAt == nil || dueAt?.date != nil) && (workflowCategory == nil || NativeQuickTaskWorkflow.keys.contains(workflowCategory!)) }
    var payload: [String: Any] {
        var value: [String: Any] = ["workspace": workspace, "projectId": projectId as Any? ?? NSNull(), "dueAt": dueAt?.jsonValue ?? NSNull()]
        // Missing remains the v2 create fingerprint for legacy pending retries.
        // An edit supplies explicit null separately to clear imported membership.
        if let workflowCategory { value["workflowCategory"] = workflowCategory }
        return value
    }
}

struct NativeQuickProjectItem: Identifiable, Decodable, Equatable {
    let id: String
    let title: String
    let workspace: String
}

struct NativeQuickTaskItem: Identifiable, Decodable, Equatable {
    let id: String
    let title: String
    let projectTitle: String
    let dueLabel: String
    let isCompleted: Bool
    let version: String
    var isSaving: Bool? = nil
    var workspace: String? = nil
    var projectId: String? = nil
    var dueAt: NativeQuickTaskDate? = nil
    var createdAt: Double? = nil
    var workflowCategory: String? = nil
    var fields: NativeQuickTaskFields { NativeQuickTaskFields(workspace: workspace ?? "日常", projectId: projectId, dueAt: dueAt, workflowCategory: workflowCategory) }
}

struct NativeQuickTaskEditDraft: Equatable {
    let original: NativeQuickTaskItem
    var title: String
    var fields: NativeQuickTaskFields
    var dirty: Bool { title != original.title || fields != original.fields }
}

enum NativeQuickTaskWorkflow {
    static let keys = ["P0", "P1", "P2", "P3"]
    static let defaults = ["P0": "课程", "P1": "科研", "P2": "创作", "P3": "日常"]
    static func validName(_ value: String) -> Bool {
        let name = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return !name.isEmpty && name.utf16.count <= 32 && !value.unicodeScalars.contains { $0.value < 32 || $0.value == 127 }
    }
}
struct NativeQuickTaskWorkflowDraft: Equatable {
    let category: String
    let original: String
    let expectedVersion: String
    var name: String
    var dirty: Bool { name != original }
}

struct NativeQuickRunItem: Identifiable, Decodable, Equatable {
    let id: String
    let title: String
    let statusLabel: String
    let detail: String
    let isActive: Bool
    let canCancel: Bool
    var status: String? = nil
    var finishedAt: Double? = nil
    var notificationReady: Bool? = nil
    var conversationId: String? = nil
    var userMessageId: String? = nil
    var voiceRequestId: String? = nil
    var voiceTranscript: String? = nil
    var resultSummary: String? = nil
}

struct NativeQuickWorkbenchSnapshot: Decodable, Equatable {
    let version: Int
    let status: String
    let reason: String?
    let tasks: [NativeQuickTaskItem]
    let runs: [NativeQuickRunItem]
    let taskCount: Int
    let runCount: Int
    var projects: [NativeQuickProjectItem]? = nil
    var workflowNames: [String: String]? = nil
    var workflowVersion: String? = nil
}

/// Published rows are projections, never a second task database. Only an
/// immutable, unacknowledged create request is kept locally for crash-safe retry.
@MainActor final class NativeQuickWorkbenchStore: ObservableObject {
    let recordFocus = NativeQuickRecordFocus()
    let taskInbox = NativeTaskInbox()
    @Published private(set) var tasks: [NativeQuickTaskItem] = []
    @Published private(set) var runs: [NativeQuickRunItem] = []
    @Published private(set) var projects: [NativeQuickProjectItem] = []
    @Published private(set) var ready = false
    @Published private(set) var loading = true
    @Published private(set) var error: String?
    @Published private(set) var busyTaskIDs: Set<String> = []
    @Published private(set) var cancellingRunIDs: Set<String> = []
    @Published private(set) var creating = false
    @Published private(set) var pendingTaskTitle: String?
    @Published private(set) var recoveryURL: URL?
    @Published var creationFields = NativeQuickTaskFields() {
        didSet {
            guard !applyingCreationDefault else { return }
            creationFieldsRevision &+= 1
            if creationFields.dueAt != oldValue.dueAt { creationDeadlineIsAutomatic = false }
        }
    }
    @Published private(set) var creationDeadlineDefault: NativeQuickTaskDeadlineDefault = .none
    @Published private(set) var deadlinePreferenceBusy = false
    @Published private(set) var deadlinePreferenceError: String?
    @Published var editingTask: NativeQuickTaskEditDraft?
    @Published private(set) var workflowNames = NativeQuickTaskWorkflow.defaults
    @Published private(set) var workflowVersion: String?
    @Published var workflowNameDraft: NativeQuickTaskWorkflowDraft?
    @Published private(set) var savingWorkflowName = false
    @Published private(set) var workflowFilter: String?
    var visibleTasks: [NativeQuickTaskItem] {
        guard let workflowFilter else { return tasks }
        return tasks.filter { ($0.workflowCategory ?? "") == workflowFilter }
    }
    func workflowCount(_ key: String?) -> Int {
        tasks.filter { !$0.isCompleted && (key == nil || ($0.workflowCategory ?? "") == key) }.count
    }
    var hasTaskEditor: Bool { editingTask != nil || workflowNameDraft != nil }
    @Published private(set) var taskEditorConflict = false
    @Published private(set) var pendingTaskLifecycle: NativeQuickTaskLifecycleRequest?
    @Published private(set) var taskDeletionNotice: NativeQuickTaskDeletionNotice?
    @Published private(set) var lifecycleBusy = false
    @Published private(set) var taskSelection = NativeQuickTaskSelection()
    @Published var selectingTasks = false
    private var workflowGeneration = 0
    private var lifecycleFile: URL?
    private var lifecycleCorrupt = false
    var hasUnsavedTaskEditorDraft: Bool { editingTask?.dirty == true || workflowNameDraft?.dirty == true || savingWorkflowName }
    var hasUnsavedTaskCreationFields: Bool {
        var baseline = NativeQuickTaskFields()
        if creationDeadlineIsAutomatic { baseline.dueAt = creationFields.dueAt }
        return creationFields != baseline
    }
    var pendingTaskFields: NativeQuickTaskFields? { pending == nil ? nil : pending?.fields ?? NativeQuickTaskFields() }

    private struct PendingTask: Codable {
        let id: String
        let title: String
        var fields: NativeQuickTaskFields? = nil
    }
    private struct Envelope: Codable {
        let version: Int
        let pending: PendingTask?
    }
    private var pending: PendingTask?
    private var corrupt = false
    private var file: URL?
    private var lastSnapshot: NativeQuickWorkbenchSnapshot?
    private var execute: (([String: Any]) async throws -> [String: Any])?
    private var openTaskOperation: ((String) async -> Bool)?
    private var openRunOperation: ((String) async -> Bool)?
    private var navigationError: String?
    private var navigationRequest: UUID?
    private let write: (Data, URL) throws -> Void
    private let deadlinePreferences: NativeQuickTaskDeadlinePreferences
    private let deadlineNow: () -> Date
    private let deadlineCalendar: () -> Calendar
    private var applyingCreationDefault = false
    private var creationDeadlineIsAutomatic = true
    private var creationFieldsRevision: UInt64 = 0
    private var acknowledgedCreation: (fields: NativeQuickTaskFields, revision: UInt64)?
    private var deadlinePreferenceLoaded = false

    init(deadlinePreferences: NativeQuickTaskDeadlinePreferences = NativeQuickTaskDeadlinePreferences(),
         now: @escaping () -> Date = Date.init,
         calendar: @escaping () -> Calendar = { .autoupdatingCurrent },
         write: @escaping (Data, URL) throws -> Void = { data, url in
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.synchronize()
        let directory = Darwin.open(url.deletingLastPathComponent().path, O_RDONLY)
        guard directory >= 0 else { throw CocoaError(.fileWriteUnknown) }
        defer { Darwin.close(directory) }
        guard Darwin.fsync(directory) == 0 else { throw CocoaError(.fileWriteUnknown) }
    }) {
        self.write = write; self.deadlinePreferences = deadlinePreferences
        self.deadlineNow = now; self.deadlineCalendar = calendar
    }

    /// A manual choice remains fixed even when equal to the current automatic value.
    func markCreationDeadlineManual() {
        guard ready, !creating, pending == nil else { return }
        creationDeadlineIsAutomatic = false; creationFieldsRevision &+= 1
    }
    func loadCreationDeadlinePreference(forceReload: Bool = false) async {
        guard (!deadlinePreferenceLoaded || forceReload), !deadlinePreferenceBusy else { return }
        deadlinePreferenceBusy = true
        defer { deadlinePreferenceBusy = false }
        do {
            creationDeadlineDefault = try await deadlinePreferences.load()
            deadlinePreferenceLoaded = true; deadlinePreferenceError = nil
            refreshCreationDeadline()
        } catch {
            deadlinePreferenceError = nativeUI("默认截止设置暂时无法读取；当前输入未更改。", "The deadline default could not be loaded. This input is unchanged.")
        }
    }
    func setCreationDeadlineDefault(_ value: NativeQuickTaskDeadlineDefault) async {
        guard ready, !creating, pending == nil, !corrupt, !deadlinePreferenceBusy else { return }
        deadlinePreferenceBusy = true
        defer { deadlinePreferenceBusy = false }
        do {
            try await deadlinePreferences.save(value)
            creationDeadlineDefault = value; deadlinePreferenceLoaded = true; deadlinePreferenceError = nil
            refreshCreationDeadline()
        } catch {
            deadlinePreferenceError = nativeUI("默认截止设置保存未确认；当前输入未更改，可重试。", "Saving the deadline default is unconfirmed. This input is unchanged; you can retry.")
        }
    }
    /// Called on mount/wake/day or clock changes and before taking the submit snapshot.
    /// Pending retries are immutable; an automatic preference never modifies a saved task.
    func refreshCreationDeadline() {
        guard ready, !creating, pending == nil, !corrupt, creationDeadlineIsAutomatic else { return }
        let value = creationDeadlineDefault.deadline(now: deadlineNow(), calendar: deadlineCalendar())
        guard creationFields.dueAt != value else { return }
        applyingCreationDefault = true
        creationFields.dueAt = value
        applyingCreationDefault = false
    }
    /// Only the exact successful create ACK may reset the submitted form. In-flight edits
    /// (including edit-and-revert) retain their ownership rather than inheriting a late reset.
    @discardableResult func resetCreationFields(after submitted: NativeQuickTaskFields) -> Bool {
        guard ready, !creating, pending == nil, let acknowledgedCreation,
              acknowledgedCreation.fields == submitted, acknowledgedCreation.revision == creationFieldsRevision,
              creationFields == submitted else { return false }
        self.acknowledgedCreation = nil
        return startNewTaskFields()
    }
    /// Explicitly starting another input after preserving an uncertain request is separate
    /// from retrying that request, and may use the user's current local default.
    @discardableResult func startNewTaskFields() -> Bool {
        guard !creating, pending == nil, !corrupt else { return false }
        acknowledgedCreation = nil; creationFieldsRevision &+= 1
        applyingCreationDefault = true
        creationFields = NativeQuickTaskFields()
        applyingCreationDefault = false
        creationDeadlineIsAutomatic = true
        refreshCreationDeadline()
        return true
    }

    var canRecoverPendingTask: Bool { file != nil && !creating && (pending != nil || corrupt) }

    func configure(directory: URL,
                   command: @escaping ([String: Any]) async throws -> [String: Any],
                   openTask: @escaping (String) async -> Bool,
                   openRun: @escaping (String) async -> Bool) {
        let next = directory.appendingPathComponent("native-quick-task-pending.json")
        guard file == nil || file == next else {
            execute = nil
            taskInbox.setAvailable(false)
            taskDeletionNotice = nil
            error = nativeUI("待办输入属于另一个工作区，请返回原工作区。", "The pending task belongs to another workspace. Return to that workspace.")
            return
        }
        execute = command; openTaskOperation = openTask; openRunOperation = openRun
        taskInbox.configure(directory: directory, command: command)
        taskInbox.setAvailable(ready)
        guard file == nil else { return }
        file = next
        configureTaskLifecycle(directory: directory)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            guard FileManager.default.fileExists(atPath: next.path) else { return }
            let envelope = try JSONDecoder().decode(Envelope.self, from: Data(contentsOf: next))
            guard [1, 2].contains(envelope.version) else { throw CocoaError(.fileReadCorruptFile) }
            if let saved = envelope.pending {
                guard saved.id.hasPrefix("quick_task_"), UUID(uuidString: String(saved.id.dropFirst(11))) != nil,
                      saved.id == saved.id.lowercased(), !saved.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      saved.title.utf16.count <= 500, (envelope.version == 1 || saved.fields != nil), saved.fields?.valid != false else { throw CocoaError(.fileReadCorruptFile) }
                pending = saved; pendingTaskTitle = saved.title
                creationFields = saved.fields ?? NativeQuickTaskFields()
            }
        } catch {
            corrupt = true
            self.error = nativeUI("待办输入暂时无法读取。原文件已保留，可以保留恢复副本后新建。", "The pending task could not be read. Its file is retained; keep a recovery copy before starting another task.")
        }
    }

    func accept(_ value: NativeQuickWorkbenchSnapshot?) {
        guard value != lastSnapshot || value == nil else { return }
        lastSnapshot = value
        let nextReady = value?.version == 1 && value?.status == "ready"
        if nextReady != ready { workflowGeneration += 1 }
        ready = nextReady
        if !ready { recordFocus.cancel() }
        taskInbox.setAvailable(ready)
        loading = value == nil || value?.reason == "hydrating"
        tasks = ready ? value?.tasks ?? [] : []
        taskSelection.reconcile(visibleTasks.map(\.id))
        if !ready { selectingTasks = false }
        runs = ready ? value?.runs ?? [] : []
        projects = ready ? value?.projects ?? [] : []
        workflowNames = ready ? value?.workflowNames ?? NativeQuickTaskWorkflow.defaults : NativeQuickTaskWorkflow.defaults
        workflowVersion = ready ? value?.workflowVersion : nil
        cancellingRunIDs = cancellingRunIDs.intersection(Set(runs.filter(\.canCancel).map(\.id)))
        if !ready, let reason = value?.reason, reason != "hydrating", error == nil { error = message(reason) }
    }

    func focusTask(id: String, show: () -> Void, canPresent: @escaping () -> Bool, isPresented: @escaping () -> Bool) async -> Bool {
        guard let item=tasks.first(where:{$0.id==id}),tasks.filter({$0.id==id}).count==1 else{return false}
        let valid = { [weak self] in
            guard let self else{return false}
            return self.ready && !self.hasTaskEditor && !self.hasUnsavedTaskCreationFields && !self.creating &&
                self.pendingTaskTitle == nil && !self.lifecycleBusy && !self.canRecoverTaskLifecycle &&
                !self.busyTaskIDs.contains(id) && self.tasks.contains(where:{$0.id==id && $0.version==item.version && $0.isSaving != true}) && canPresent()
        }
        guard valid() else { return false }
        setWorkflowFilter(nil)
        return await recordFocus.present(id:id,show:show,canPresent: {
            valid() && self.visibleTasks.contains(where: { $0.id == id })
        },isPresented:isPresented)
    }

    @discardableResult func createTask(title: String, fields: NativeQuickTaskFields = NativeQuickTaskFields()) async -> Bool {
        guard ready, !creating, !corrupt, let execute, let file else { return false }
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, title.utf16.count <= 500, fields.valid else { error = message("invalid"); return false }
        if let pending, pending.title != title || (pending.fields ?? NativeQuickTaskFields()) != fields {
            error = nativeUI("上次新增尚未确认，请先重试原任务，或保留恢复副本后新建。", "The previous task is unconfirmed. Retry that task, or keep a recovery copy before starting another.")
            return false
        }
        let request = pending ?? PendingTask(id: "quick_task_" + UUID().uuidString.lowercased(), title: title, fields: fields)
        let submittedRevision = creationFieldsRevision
        acknowledgedCreation = nil
        creating = true; error = nil
        defer { creating = false }
        do {
            // Record the exact identity before calling the workspace. Never
            // turn an uncertain reply into a fresh create request.
            try write(JSONEncoder().encode(Envelope(version: request.fields == nil ? 1 : 2, pending: request)), file)
            pending = request; pendingTaskTitle = request.title
            var payload: [String: Any] = ["action": "create-task", "id": request.id, "title": request.title]
            if let fields = request.fields { payload.merge(fields.payload) { _, new in new } }
            let receipt = try await execute(payload)
            guard receipt["status"] as? String == "saved", receipt["id"] as? String == request.id else {
                error = message(receipt["reason"] as? String ?? "unconfirmed"); return false
            }
            try write(JSONEncoder().encode(Envelope(version: 2, pending: nil)), file)
            pending = nil; pendingTaskTitle = nil
            acknowledgedCreation = (fields, submittedRevision)
            if workflowFilter != nil { setWorkflowFilter(fields.workflowCategory ?? "") }
            return true
        } catch {
            self.error = nativeUI("新增尚未确认，输入已保留。重试会核对同一条任务，不会重复创建。", "Creation is unconfirmed; the input is retained. Retry checks the same task without creating a duplicate.")
            return false
        }
    }

    @discardableResult func beginEditingTask(id: String) -> Bool {
        guard ready, !busyTaskIDs.contains(id), let item = tasks.first(where: { $0.id == id }), item.isSaving != true else { return false }
        guard workflowNameDraft == nil else { return false }
        if let current = editingTask { return current.original.id == id }
        editingTask = NativeQuickTaskEditDraft(original: item, title: item.title, fields: item.fields); error = nil; taskEditorConflict = false
        return true
    }
    @discardableResult func reloadEditingTask() -> Bool {
        guard let draft = editingTask, ready, !busyTaskIDs.contains(draft.original.id), let item = tasks.first(where: { $0.id == draft.original.id }), item.isSaving != true else { return false }
        editingTask = NativeQuickTaskEditDraft(original: item, title: item.title, fields: item.fields); taskEditorConflict = false; error = nil
        return true
    }
    @discardableResult func saveEditingTask() async -> Bool {
        guard let draft = editingTask, !busyTaskIDs.contains(draft.original.id) else { return false }
        let saved = await updateTask(id: draft.original.id, expectedVersion: draft.original.version, title: draft.title, fields: draft.fields)
        // The form may have changed while saving; never dismiss a newer input.
        if saved && editingTask == draft { editingTask = nil }
        return saved
    }
    @discardableResult func updateTask(id: String, expectedVersion: String, title: String, fields: NativeQuickTaskFields) async -> Bool {
        guard ready, !busyTaskIDs.contains(id), let execute, tasks.contains(where: { $0.id == id && $0.isSaving != true }) else { return false }
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, title.utf16.count <= 500, fields.valid, !expectedVersion.isEmpty else { error = message("invalid"); return false }
        busyTaskIDs.insert(id); error = nil
        defer { busyTaskIDs.remove(id) }
        do {
            var patch = fields.payload; patch["title"] = title; patch["workflowCategory"] = fields.workflowCategory as Any? ?? NSNull()
            let receipt = try await execute(["action": "update-task", "id": id, "expectedVersion": expectedVersion, "patch": patch])
            guard receipt["status"] as? String == "saved", receipt["id"] as? String == id else {
                taskEditorConflict = receipt["reason"] as? String == "changed"
                error = message(receipt["reason"] as? String ?? "unconfirmed"); return false
            }
            return true
        } catch { self.error = message("unconfirmed"); return false }
    }

    @discardableResult func setTaskCompleted(id: String, completed: Bool) async -> Bool {
        guard ready, !busyTaskIDs.contains(id), let item = tasks.first(where: { $0.id == id }), item.isSaving != true, let execute else { return false }
        busyTaskIDs.insert(id); error = nil
        defer { busyTaskIDs.remove(id) }
        do {
            let receipt = try await execute(["action": "set-task-completed", "id": id, "completed": completed, "expectedVersion": item.version])
            guard receipt["status"] as? String == "saved", receipt["id"] as? String == id else {
                error = message(receipt["reason"] as? String ?? "unconfirmed"); return false
            }
            return true
        } catch { self.error = message("unconfirmed"); return false }
    }

    @discardableResult func cancelRun(id: String) async -> Bool {
        guard ready, !cancellingRunIDs.contains(id), runs.contains(where: { $0.id == id && $0.canCancel }), let execute else { return false }
        cancellingRunIDs.insert(id); error = nil
        do {
            let receipt = try await execute(["action": "cancel-run", "id": id])
            guard receipt["status"] as? String == "cancel_requested", receipt["id"] as? String == id else {
                cancellingRunIDs.remove(id); error = message(receipt["reason"] as? String ?? "unconfirmed"); return false
            }
            // Only the next real run projection may claim that execution ended.
            return true
        } catch { cancellingRunIDs.remove(id); self.error = message("unconfirmed"); return false }
    }

    @discardableResult func openTask(id: String) async -> Bool {
        guard ready, tasks.contains(where: { $0.id == id }), let openTaskOperation else { return false }
        let request=UUID();navigationRequest=request
        let accepted = await openTaskOperation(id)
        finishNavigation(accepted,request:request)
        return accepted
    }
    @discardableResult func openRun(id: String) async -> Bool {
        guard ready, runs.contains(where: { $0.id == id }), let openRunOperation else { return false }
        let request=UUID();navigationRequest=request
        let accepted = await openRunOperation(id)
        finishNavigation(accepted,request:request)
        return accepted
    }
    private func finishNavigation(_ accepted:Bool,request:UUID) {
        guard navigationRequest==request else{return}
        if accepted {
            // Opening content must not erase an unrelated persistence error.
            if error==navigationError {error=nil}
            navigationError=nil
        } else {let value=message("navigation_deferred");navigationError=value;error=value}
    }

    @discardableResult func preservePendingTaskAndStartNew() -> Bool {
        guard canRecoverPendingTask, let file else { return false }
        let recovery = file.deletingLastPathComponent().appendingPathComponent("native-quick-task-recovery-" + UUID().uuidString.lowercased() + ".json")
        let replacement = file.deletingLastPathComponent().appendingPathComponent(".native-quick-task-reset-" + UUID().uuidString.lowercased())
        defer { try? FileManager.default.removeItem(at: replacement) }
        do {
            // Preserve exact unreadable bytes as well as ordinary pending input.
            let bytes = try Data(contentsOf: file)
            try write(bytes, recovery)
            // Prepare a separate replacement. A failing writer, including one
            // that writes before throwing, cannot consume the original envelope.
            try write(JSONEncoder().encode(Envelope(version: 2, pending: nil)), replacement)
            guard Darwin.rename(replacement.path, file.path) == 0 else { throw CocoaError(.fileWriteUnknown) }
            pending = nil; pendingTaskTitle = nil; corrupt = false; recoveryURL = recovery; error = nil
            return true
        } catch { self.error = nativeUI("恢复副本尚未保存，原输入仍保留。请重试。", "The recovery copy was not saved. The original input is retained. Retry."); return false }
    }

    private func configureTaskLifecycle(directory: URL) {
        let next = directory.appendingPathComponent("native-quick-task-lifecycle.json")
        lifecycleFile = next
        guard FileManager.default.fileExists(atPath: next.path) else { return }
        do {
            let envelope = try JSONDecoder().decode(NativeQuickTaskLifecycleEnvelope.self, from: Data(contentsOf: next))
            guard [1, 2].contains(envelope.version), envelope.pending?.valid != false else { throw CocoaError(.fileReadCorruptFile) }
            pendingTaskLifecycle = envelope.pending
        } catch { lifecycleCorrupt = true; self.error = message("lifecycle_recovery") }
    }
    var canRecoverTaskLifecycle: Bool { lifecycleFile != nil && !lifecycleBusy && (pendingTaskLifecycle != nil || lifecycleCorrupt) }
    func selectTask(id: String, extending: Bool = false, toggling: Bool = false) {
        guard !lifecycleBusy else { return }
        taskSelection.select(id, ordered: visibleTasks.map(\.id), extending: extending, toggling: toggling)
    }
    func selectAllTasks() { guard !lifecycleBusy else { return }; taskSelection.selectAll(visibleTasks.map(\.id)) }
    func setWorkflowFilter(_ category: String?) {
        guard category == nil || category == "" || NativeQuickTaskWorkflow.keys.contains(category!), !lifecycleBusy else { return }
        guard workflowFilter != category else { return }
        workflowFilter = category; taskSelection.clear(); selectingTasks = false; recordFocus.cancel()
    }
    @discardableResult func beginWorkflowRename(_ category: String) -> Bool {
        guard ready, !hasTaskEditor, !savingWorkflowName, NativeQuickTaskWorkflow.keys.contains(category),
              let name = workflowNames[category], let workflowVersion else { return false }
        workflowNameDraft = NativeQuickTaskWorkflowDraft(category: category, original: name, expectedVersion: workflowVersion, name: name)
        error = nil; return true
    }
    @discardableResult func saveWorkflowRename() async -> Bool {
        guard ready, !savingWorkflowName, let draft = workflowNameDraft, let execute, let file,
              NativeQuickTaskWorkflow.validName(draft.name) else { return false }
        let requestedName = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let generation = workflowGeneration
        savingWorkflowName = true; error = nil
        defer { savingWorkflowName = false }
        do {
            let receipt = try await execute(["action": "rename-task-workflow", "id": "quick_task_workflow_names",
                "category": draft.category, "name": requestedName, "expectedVersion": draft.expectedVersion])
            guard self.file == file, workflowGeneration == generation, ready else { return false }
            guard receipt["status"] as? String == "saved", receipt["id"] as? String == "quick_task_workflow_names",
                  let names = receipt["workflowNames"] as? [String: String], names[draft.category] == requestedName,
                  let version = receipt["workflowVersion"] as? String else {
                error = message(receipt["reason"] as? String ?? "unconfirmed"); return false
            }
            // A later canonical projection may arrive before this callback.
            // Do not overwrite it: identical snapshots are intentionally deduped.
            guard workflowVersion == draft.expectedVersion || workflowVersion == version else {
                error = message("changed"); return false
            }
            workflowNames = names; workflowVersion = version
            if workflowNameDraft == draft { workflowNameDraft = nil }
            else if let current = workflowNameDraft, current.category == draft.category,
                    current.expectedVersion == draft.expectedVersion, current.original == draft.original {
                // Preserve newer text, but anchor its next save to the exact
                // acknowledged edit rather than a stale pre-save baseline.
                workflowNameDraft = NativeQuickTaskWorkflowDraft(category: current.category,
                    original: requestedName, expectedVersion: version, name: current.name)
            }
            return true
        } catch {
            guard self.file == file, workflowGeneration == generation, ready else { return false }
            self.error = message("unconfirmed"); return false
        }
    }
    func clearTaskSelection() { taskSelection.clear() }
    @discardableResult func endTaskSelection() -> Bool {
        let handled = selectingTasks || !taskSelection.ids.isEmpty
        selectingTasks = false; taskSelection.clear(); return handled
    }
    var canDeleteSelectedTasks: Bool {
        ready && !taskSelection.ids.isEmpty && pendingTaskLifecycle == nil && !lifecycleCorrupt && !lifecycleBusy &&
        tasks.filter { taskSelection.ids.contains($0.id) }.allSatisfy { !busyTaskIDs.contains($0.id) && $0.isSaving != true && editingTask?.original.id != $0.id }
    }
    @discardableResult func deleteSelectedTasks() async -> Bool {
        guard canDeleteSelectedTasks else { return false }
        // Freeze membership, display order and versions before awaiting. Later
        // projections can neither add a replacement row nor retarget a retry.
        let items = tasks.filter { taskSelection.ids.contains($0.id) }
        guard items.count == taskSelection.ids.count else { return false }
        let request = NativeQuickTaskLifecycleRequest(action: "delete-tasks", id: "quick_task_batch_" + UUID().uuidString.lowercased(),
            trashId: "quick_task_delete_" + UUID().uuidString.lowercased(), expectedVersion: nil,
            title: nativeUI("\(items.count) 个待办", "\(items.count) tasks"), items: items.map { NativeQuickTaskLifecycleTarget(id: $0.id, expectedVersion: $0.version) })
        return await performTaskLifecycle(request)
    }
    @discardableResult func deleteTask(id: String) async -> Bool {
        guard ready, pendingTaskLifecycle == nil, !lifecycleCorrupt, !lifecycleBusy,
              editingTask?.original.id != id, !busyTaskIDs.contains(id),
              let item = tasks.first(where: { $0.id == id }), item.isSaving != true else { return false }
        let request = NativeQuickTaskLifecycleRequest(action: "delete-task", id: id,
            trashId: "quick_task_delete_" + UUID().uuidString.lowercased(), expectedVersion: item.version, title: item.title)
        return await performTaskLifecycle(request)
    }
    @discardableResult func undoTaskDeletion() async -> Bool {
        guard ready, pendingTaskLifecycle == nil, let notice = taskDeletionNotice, Date() < notice.expiresAt,
              !(notice.taskIDs ?? [notice.id]).contains(editingTask?.original.id ?? "") else { return false }
        if let ids = notice.taskIDs, let requestID = notice.requestID {
            return await performTaskLifecycle(NativeQuickTaskLifecycleRequest(action: "restore-tasks", id: requestID, trashId: notice.trashId,
                expectedVersion: nil, title: notice.title, items: ids.map { NativeQuickTaskLifecycleTarget(id: $0, expectedVersion: nil) }))
        }
        return await performTaskLifecycle(NativeQuickTaskLifecycleRequest(action: "restore-task", id: notice.id, trashId: notice.trashId, expectedVersion: nil, title: notice.title))
    }
    @discardableResult func retryTaskLifecycle() async -> Bool {
        guard let request = pendingTaskLifecycle else { return false }
        return await performTaskLifecycle(request)
    }
    private func performTaskLifecycle(_ request: NativeQuickTaskLifecycleRequest) async -> Bool {
        let identities = Set(request.taskIDs)
        guard ready, request.valid, !lifecycleBusy, !lifecycleCorrupt, busyTaskIDs.isDisjoint(with: identities),
              !identities.contains(editingTask?.original.id ?? ""), let execute, let lifecycleFile else { return false }
        lifecycleBusy = true; busyTaskIDs.formUnion(identities); error = nil
        defer { lifecycleBusy = false; busyTaskIDs.subtract(identities) }
        do {
            try write(JSONEncoder().encode(NativeQuickTaskLifecycleEnvelope(version: request.isBatch ? 2 : 1, pending: request)), lifecycleFile)
            pendingTaskLifecycle = request
            let reply = try await execute(request.payload)
            let expected = request.isDeletion ? "deleted" : "restored"
            guard reply["status"] as? String == expected, reply["id"] as? String == request.id,
                  reply["trashId"] as? String == request.trashId,
                  !request.isBatch || reply["ids"] as? [String] == request.taskIDs else {
                error = message(reply["reason"] as? String ?? "unconfirmed"); return false
            }
            // Prepare the cleared receipt separately. A writer that writes and
            // then throws must not consume the only durable retry identity.
            let cleared = lifecycleFile.deletingLastPathComponent().appendingPathComponent(".native-quick-task-lifecycle-ack-" + UUID().uuidString.lowercased())
            defer { try? FileManager.default.removeItem(at: cleared) }
            try write(JSONEncoder().encode(NativeQuickTaskLifecycleEnvelope(version: 1, pending: nil)), cleared)
            guard Darwin.rename(cleared.path, lifecycleFile.path) == 0 else { throw CocoaError(.fileWriteUnknown) }
            pendingTaskLifecycle = nil
            // Delete + Undo can both finish between 500 ms projections. Even
            // an identical next snapshot must restore the canonical rows after
            // the acknowledged local removal below.
            lastSnapshot = nil
            if request.isDeletion {
                taskDeletionNotice = NativeQuickTaskDeletionNotice(id: request.taskIDs[0], trashId: request.trashId, title: request.title,
                    expiresAt: Date().addingTimeInterval(5), requestID: request.isBatch ? request.id : nil, taskIDs: request.isBatch ? request.taskIDs : nil)
                tasks.removeAll { identities.contains($0.id) }
                taskSelection.reconcile(visibleTasks.map(\.id))
            } else { taskDeletionNotice = nil }
            return true
        } catch { self.error = message("unconfirmed"); return false }
    }
    @discardableResult func preserveTaskLifecycleRecovery() -> Bool {
        guard canRecoverTaskLifecycle, let lifecycleFile else { return false }
        let recovery = lifecycleFile.deletingLastPathComponent().appendingPathComponent("native-quick-task-lifecycle-recovery-" + UUID().uuidString.lowercased() + ".json")
        let replacement = lifecycleFile.deletingLastPathComponent().appendingPathComponent(".native-quick-task-lifecycle-reset-" + UUID().uuidString.lowercased())
        defer { try? FileManager.default.removeItem(at: replacement) }
        do {
            try write(Data(contentsOf: lifecycleFile), recovery)
            try write(JSONEncoder().encode(NativeQuickTaskLifecycleEnvelope(version: 1, pending: nil)), replacement)
            guard Darwin.rename(replacement.path, lifecycleFile.path) == 0 else { throw CocoaError(.fileWriteUnknown) }
            pendingTaskLifecycle = nil; lifecycleCorrupt = false; recoveryURL = recovery; error = nil; return true
        } catch { self.error = message("lifecycle_recovery"); return false }
    }

    private func message(_ reason: String) -> String {
        switch reason {
        case "editor_busy": return nativeUI("请先完成当前任务编辑，再删除或恢复。", "Finish the current task edit before deleting or restoring.")
        case "lifecycle_recovery": return nativeUI("待确认操作已保留。请保留恢复记录后继续，已删除任务仍可在回收站恢复。", "The pending operation is preserved. Keep a recovery record to continue; deleted tasks remain recoverable from Trash.")
        case "invalid": return nativeUI("请核对任务名称、所属项目和截止日期。", "Check the task title, project and deadline.")
        case "private": return nativeUI("私密内容不会显示在常驻入口中。", "Private content is hidden from the floating entry.")
        case "conflict": return nativeUI("请先在主窗口处理同步冲突。", "Resolve the synchronization conflict in the main window first.")
        case "changed": return nativeUI("内容已在其他位置更新，请按最新状态重试。", "The item changed elsewhere. Retry from its latest state.")
        case "removed": return nativeUI("该内容已删除或归档，未重新创建。", "This item was removed or archived. It was not recreated.")
        case "collision": return nativeUI("请求编号冲突，原内容未改动。", "The request ID conflicts with another record. Existing content was retained.")
        case "duplicate_name": return nativeUI("已有同名分类，请使用不同的名称。", "Another category has this name. Choose a different name.")
        case "unmet_deliverable": return nativeUI("任务要求的产出尚未满足，请打开任务核对。", "The required task output is not ready. Open the task to review it.")
        case "storage_failed": return nativeUI("更改尚未确认保存，请重试。", "The change was not confirmed saved. Retry.")
        case "busy": return nativeUI("工作区正在保存，请稍后重试。", "The workspace is saving. Retry shortly.")
        case "navigation_deferred": return nativeUI("请先处理主窗口中的编辑或对话框，再打开内容。", "Finish the current edit or dialog in the main window before opening this item.")
        case "unconfirmed": return nativeUI("未收到操作确认，请核对最新状态后重试。", "No operation confirmation was received. Check the latest state before retrying.")
        default: return nativeUI("工作区尚未就绪，请稍后重试。", "The workspace is not ready. Retry shortly.")
        }
    }
}
