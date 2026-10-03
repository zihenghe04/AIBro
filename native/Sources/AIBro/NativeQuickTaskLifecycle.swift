import Foundation

struct NativeQuickTaskRowFocus: Hashable {
    enum Control: Hashable { case selection, title }
    let taskID: String
    let control: Control
}

struct NativeQuickTaskKeyModifiers: OptionSet {
    let rawValue: UInt8
    static let command = Self(rawValue: 1)
    static let shift = Self(rawValue: 2)
    static let option = Self(rawValue: 4)
    static let control = Self(rawValue: 8)
}

enum NativeQuickTaskCommand: Equatable {
    case selectAll, undo
    static func match(_ characters: String, modifiers: NativeQuickTaskKeyModifiers) -> Self? {
        // Redo and modified system shortcuts must never restore a task batch.
        guard modifiers == .command else { return nil }
        switch characters.lowercased() { case "a": return .selectAll; case "z": return .undo; default: return nil }
    }
}

/// Selection belongs to record identities. A projection may reorder rows while
/// the pointer is down; indexes are used only to resolve a new range gesture.
struct NativeQuickTaskSelection: Equatable {
    private(set) var ids: Set<String> = []
    private(set) var anchor: String?
    mutating func reconcile(_ ordered: [String]) {
        let visible = Set(ordered); ids.formIntersection(visible)
        if let anchor, !visible.contains(anchor) { self.anchor = nil }
    }
    mutating func clear() { ids.removeAll(); anchor = nil }
    mutating func selectAll(_ ordered: [String]) { ids = Set(ordered); anchor = ordered.first }
    mutating func select(_ id: String, ordered: [String], extending: Bool = false, toggling: Bool = false) {
        reconcile(ordered)
        guard let end = ordered.firstIndex(of: id) else { return }
        if extending, let anchor, let start = ordered.firstIndex(of: anchor) {
            ids.formUnion(ordered[min(start, end)...max(start, end)])
        } else {
            if toggling { if !ids.insert(id).inserted { ids.remove(id) } }
            else { ids = [id] }
            anchor = id
        }
    }
}

struct NativeQuickTaskLifecycleTarget: Codable, Equatable {
    let id: String
    let expectedVersion: String?
}

/// A retry identity, not a saved copy of the task. Canonical content lives only
/// in workspace tasks / ContentLifecycle trash and is never restored from here.
struct NativeQuickTaskLifecycleRequest: Codable, Equatable {
    let action: String
    let id: String
    let trashId: String
    let expectedVersion: String?
    let title: String
    var items: [NativeQuickTaskLifecycleTarget]? = nil
    var isBatch: Bool { ["delete-tasks", "restore-tasks"].contains(action) }
    var isDeletion: Bool { ["delete-task", "delete-tasks"].contains(action) }
    var taskIDs: [String] { isBatch ? (items ?? []).map(\.id) : [id] }
    var valid: Bool {
        guard ["delete-task", "restore-task", "delete-tasks", "restore-tasks"].contains(action), !id.isEmpty, id.utf16.count <= 200,
              trashId.hasPrefix("quick_task_delete_"), trashId == trashId.lowercased(),
              UUID(uuidString: String(trashId.dropFirst("quick_task_delete_".count))) != nil else { return false }
        if !isBatch { return items == nil && (!isDeletion || expectedVersion?.isEmpty == false) }
        guard id.hasPrefix("quick_task_batch_"), id == id.lowercased(), UUID(uuidString: String(id.dropFirst("quick_task_batch_".count))) != nil,
              expectedVersion == nil, let items, !items.isEmpty, Set(taskIDs).count == items.count else { return false }
        return items.allSatisfy { !$0.id.isEmpty && $0.id.utf16.count <= 200 && (!isDeletion || $0.expectedVersion?.isEmpty == false) }
    }
    var payload: [String: Any] {
        var value: [String: Any] = ["action": action, "id": id, "trashId": trashId]
        if action == "delete-task", let expectedVersion { value["expectedVersion"] = expectedVersion }
        if isBatch {
            if isDeletion { value["items"] = (items ?? []).map { ["id": $0.id, "expectedVersion": $0.expectedVersion ?? ""] } }
            else { value["ids"] = taskIDs }
        }
        return value
    }
}
struct NativeQuickTaskLifecycleEnvelope: Codable { let version: Int; let pending: NativeQuickTaskLifecycleRequest? }
struct NativeQuickTaskDeletionNotice: Equatable {
    let id: String
    let trashId: String
    let title: String
    let expiresAt: Date
    var requestID: String? = nil
    var taskIDs: [String]? = nil
}
