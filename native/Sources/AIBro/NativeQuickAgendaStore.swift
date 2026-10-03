import Foundation
import Combine

struct NativeQuickAgendaContext {
    var ready: Bool
    var privateMode: Bool
    var projects: [AgendaEditingProject]
    var documents: [AgendaEditingDocument]
    var taskIDs: Set<String>
    var projectID: String?
    var scope: AgendaEditingScope { AgendaEditingScope(projects: projects, documents: documents) }
    static var unavailable: Self { .init(ready: false, privateMode: false, projects: [], documents: [], taskIDs: [], projectID: nil) }
}

struct NativeQuickAgendaDraft {
    var event: AgendaEvent
    let initial: AgendaEvent
    let baseline: AgendaEvent?
    let requestID: String
    let session: UUID
    let owner: URL
    var dirty: Bool { event != initial }
}

/// This controller owns only a retained editing session and view preferences.
/// All calendar rows and commits belong to the App's original AgendaStore.
@MainActor final class NativeQuickAgendaStore: ObservableObject {
    let recordFocus = NativeQuickRecordFocus()
    @Published var date = Date()
    @Published var upcoming = false
    @Published private(set) var editing: NativeQuickAgendaDraft?
    @Published private(set) var saving = false
    @Published private(set) var error: String?
    @Published private(set) var savedEventID: String?
    private weak var agenda: AgendaStore?
    private var context: () -> NativeQuickAgendaContext = { .unavailable }
    private var agendaChanges: AnyCancellable?
    private var openTaskOperation: ((String) async -> Bool)?
    private var openAgendaOperation: ((Date) -> Void)?
    var hasEditor: Bool { editing != nil }
    var hasUnsavedEditorDraft: Bool { editing?.dirty == true }
    var ready: Bool { let value = context(); return value.ready && !value.privateMode && agenda?.storageReady == true }
    var projects: [AgendaEditingProject] { ready ? context().scope.projectChoices : [] }
    var canDisplayEditor: Bool {
        guard ready, let draft = editing, draft.owner == agenda?.storageIdentity else { return false }
        let scope = context().scope
        guard scope.canAccess(draft.event) else { return false }
        if let baseline = draft.baseline {
            guard let current = agenda?.events.first(where: { $0.id == baseline.id }), !current.deleted else { return false }
            return scope.canAccess(baseline) && scope.canAccess(current)
        }
        return true
    }
    var occurrences: [AgendaOccurrence] {
        guard ready, let agenda else { return [] }
        let calendar = Calendar.current, start = calendar.startOfDay(for: date)
        guard let end = calendar.date(byAdding: .day, value: upcoming ? 7 : 1, to: start) else { return [] }
        let value = context(), scope = value.scope
        return agenda.occurrences(from: start, to: end).filter { item in
            scope.canAccess(item.event) && (item.taskID.map { value.taskIDs.contains($0) } ?? true)
        }
    }
    func configure(agenda: AgendaStore, context: @escaping () -> NativeQuickAgendaContext,
                   openTask: @escaping (String) async -> Bool, openAgenda: @escaping (Date) -> Void) {
        if let previous = self.agenda, previous !== agenda, editing != nil {
            error = nativeUI("日程输入属于原工作区，请先返回处理。", "The event draft belongs to the previous workspace. Return to it first.")
            return
        }
        self.agenda = agenda; self.context = context; openTaskOperation = openTask; openAgendaOperation = openAgenda
        agendaChanges = agenda.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
        refreshContext()
    }
    func refreshContext() { objectWillChange.send() }
    func documents(projectID: String) -> [AgendaEditingDocument] { ready ? context().scope.documentChoices(projectID: projectID) : [] }
    func changeDay(_ offset: Int) { date = Calendar.current.date(byAdding: .day, value: offset, to: date) ?? date }
    func today() { date = Date() }

    func eventForFocus(id:String) -> AgendaEvent? {
        guard ready,let agenda else{return nil}
        let found=agenda.events.filter{$0.id==id && !$0.deleted && context().scope.canAccess($0)}
        return found.count==1 ? found[0]:nil
    }
    func focusEvent(id:String,show:()->Void,canPresent:@escaping()->Bool,isPresented:@escaping()->Bool) async -> Bool {
        guard ready,!hasEditor,!saving,canPresent(),let event=eventForFocus(id:id) else{return false}
        date=event.start;upcoming=false
        guard let occurrence=occurrences.first(where:{$0.event.id==id && $0.taskID==nil}) else{return false}
        let valid = { [weak self] in
            guard let self else{return false}
            return self.ready && !self.hasEditor && !self.saving && self.eventForFocus(id:id)==event &&
                self.occurrences.contains(where:{$0.id==occurrence.id}) && canPresent()
        }
        return await recordFocus.present(id:occurrence.id,show:show,canPresent:valid,isPresented:isPresented)
    }

    @discardableResult func beginNew() -> Bool {
        guard ready, editing == nil, let agenda, let owner = agenda.storageIdentity else { return false }
        let calendar = Calendar.current
        var event = AgendaEvent()
        event.start = calendar.date(bySettingHour: 9, minute: 0, second: 0, of: date) ?? date
        event.end = event.start.addingTimeInterval(3600)
        if let id = context().projectID, context().scope.projectChoices.contains(where: { $0.id == id }) { event.projectID = id }
        editing = NativeQuickAgendaDraft(event: event, initial: event, baseline: nil, requestID: "quick_event_" + UUID().uuidString.lowercased(), session: UUID(), owner: owner)
        error = nil; savedEventID = nil; registerDraft(); return true
    }
    @discardableResult func beginEditing(_ occurrence: AgendaOccurrence) -> Bool {
        guard ready, editing == nil, occurrence.taskID == nil, let agenda, let owner = agenda.storageIdentity,
              context().scope.canAccess(occurrence.event), !occurrence.event.deleted,
              let current = agenda.events.first(where: { $0.id == occurrence.event.id }), !current.deleted, context().scope.canAccess(current) else { return false }
        // Preserve the actual displayed baseline, even if it is already stale.
        editing = NativeQuickAgendaDraft(event: occurrence.event, initial: occurrence.event, baseline: occurrence.event,
            requestID: "quick_event_" + UUID().uuidString.lowercased(), session: UUID(), owner: owner)
        error = nil; savedEventID = nil; registerDraft(); return true
    }
    func updateDraft(_ change: (inout AgendaEvent) -> Void) {
        guard !saving, var draft = editing else { return }
        change(&draft.event); editing = draft; savedEventID = nil; registerDraft()
    }
    private func registerDraft() { if let draft = editing { agenda?.setEditorDraft(draft.session, dirty: draft.dirty) } }
    @discardableResult func discardEditor() -> Bool {
        guard !saving else { return false }
        if let draft = editing { agenda?.endEditorDraft(draft.session) }
        editing = nil; error = nil; return true
    }
    @discardableResult func reloadEditor() -> Bool {
        guard !saving, ready, let draft = editing, let agenda, let baseline = draft.baseline,
              let latest = agenda.events.first(where: { $0.id == baseline.id && !$0.deleted }), context().scope.canAccess(latest), draft.owner == agenda.storageIdentity else { return false }
        agenda.endEditorDraft(draft.session)
        editing = NativeQuickAgendaDraft(event: latest, initial: latest, baseline: latest, requestID: "quick_event_" + UUID().uuidString.lowercased(), session: UUID(), owner: draft.owner)
        error = nil; registerDraft(); return true
    }
    @discardableResult func saveEditor() -> Bool {
        guard !saving, ready, let draft = editing, let agenda else { return false }
        saving = true; error = nil; savedEventID = nil
        defer { saving = false }
        do {
            guard draft.owner == agenda.storageIdentity else { throw AgendaError.message(nativeUI("日程输入属于原工作区，未写入其他工作区。", "The draft belongs to its original workspace. No other workspace was written.")) }
            try context().scope.validate(draft.event, expected: draft.baseline)
            let receipt = try agenda.commit(draft.event, expected: draft.baseline, requestID: draft.requestID)
            guard receipt.eventID == draft.event.id else { throw AgendaError.message("未收到日程保存确认。") }
            savedEventID = receipt.eventID; date = draft.event.start
            agenda.endEditorDraft(draft.session); editing = nil; return true
        } catch { self.error = error.localizedDescription; return false }
    }
    @discardableResult func openTask(_ occurrence: AgendaOccurrence) async -> Bool {
        guard ready, let id = occurrence.taskID, context().taskIDs.contains(id), context().scope.canAccess(occurrence.event), let openTaskOperation else { return false }
        return await openTaskOperation(id)
    }
    func openAgenda() { guard ready else { return }; openAgendaOperation?(date) }
}
