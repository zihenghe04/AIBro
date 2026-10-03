import Foundation

struct AgendaEditingProject: Identifiable, Equatable {
    let id: String
    let title: String
}
struct AgendaEditingDocument: Identifiable, Equatable {
    let id: String
    let title: String
    let projectID: String
    let kind: String
}

/// Native snapshots contain only public records. Recheck unique ownership at
/// every entry point; a removed/private original cannot be relabelled public.
struct AgendaEditingScope {
    let projects: [AgendaEditingProject]
    let documents: [AgendaEditingDocument]
    private let projectIndex: [String: [AgendaEditingProject]]
    private let documentIndex: [String: [AgendaEditingDocument]]
    init(projects: [AgendaEditingProject] = [], documents: [AgendaEditingDocument] = []) {
        self.projects = projects; self.documents = documents
        projectIndex = Dictionary(grouping: projects, by: \.id); documentIndex = Dictionary(grouping: documents, by: \.id)
    }
    var projectChoices: [AgendaEditingProject] { projects.filter { projectIndex[$0.id]?.count == 1 } }
    func documentChoices(projectID: String) -> [AgendaEditingDocument] {
        documents.filter { item in documentIndex[item.id]?.count == 1 && (projectID.isEmpty || item.projectID == projectID)
            && (item.projectID.isEmpty || projectIndex[item.projectID]?.count == 1) }
    }
    func canAccess(_ event: AgendaEvent) -> Bool {
        if !event.projectID.isEmpty && projectIndex[event.projectID]?.count != 1 { return false }
        if !event.documentID.isEmpty {
            guard let matches = documentIndex[event.documentID], matches.count == 1 else { return false }
            let source = matches[0]
            if source.kind != event.documentKind || !event.projectID.isEmpty && source.projectID != event.projectID
                || !source.projectID.isEmpty && projectIndex[source.projectID]?.count != 1 { return false }
        }
        return true
    }
    func validate(_ event: AgendaEvent, expected: AgendaEvent?) throws {
        try event.validate()
        guard !event.id.isEmpty, !event.deleted, ["event", "course", "meeting"].contains(event.kind) else { throw AgendaError.message("请检查日程类型。任务截止日期需要在任务中编辑。") }
        guard canAccess(event), expected.map(canAccess) ?? true else { throw AgendaError.message("日程所属项目或关联资料已不可用，当前输入已保留。") }
    }
}

enum AgendaEditorFields {
    static func allDay(_ event: inout AgendaEvent, enabled: Bool) {
        event.allDay = enabled
        if enabled {
            let calendar = event.calendar(); event.start = calendar.startOfDay(for: event.start)
            event.end = calendar.date(byAdding: .day, value: 1, to: event.start) ?? event.start.addingTimeInterval(86400)
        }
    }
    static func repeatUntil(_ event: inout AgendaEvent, date: Date?) {
        event.until = date.map { event.calendar().date(byAdding: .day, value: 1, to: event.calendar().startOfDay(for: $0))!.addingTimeInterval(-1) }
        event.count = nil
    }
}
