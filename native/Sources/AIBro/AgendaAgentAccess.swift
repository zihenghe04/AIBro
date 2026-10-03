import Foundation
import CryptoKit
import CoreFoundation

struct AgendaAgentProject: Equatable {
    let id: String
    let title: String
    let workspace: String
}
struct AgendaAgentEnvironment {
    var ready = false
    var privateMode = true
    var projects: [AgendaAgentProject] = []
    var documents: [AgendaEditingDocument] = []
    var conversationIDs: Set<String> = []
    var documentWorkspaces: [String: String] = [:]
    var editingScope: AgendaEditingScope {
        AgendaEditingScope(projects: projects.map { .init(id: $0.id, title: $0.title) }, documents: documents)
    }
}
struct AgendaAgentContext: Equatable {
    let runID: String
    let conversationID: String
    let userMessageID: String
    let projectID: String?
    let workspace: String?
    let readProjects: [String]?
    init(_ value: [String: Any]) throws {
        guard Set(value.keys).isSubset(of: ["runId", "conversationId", "userMessageId", "scope"]),
              let run = value["runId"] as? String, let conversation = value["conversationId"] as? String,
              let message = value["userMessageId"] as? String,
              [run, conversation, message].allSatisfy({ !$0.isEmpty && $0.utf8.count <= 256 }),
              let scope = value["scope"] as? [String: Any],
              Set(scope.keys).isSubset(of: ["projectId", "workspace", "readProjects"]) else { throw AgendaAgentFailure("invalid_context") }
        func optionalString(_ key: String) throws -> String? {
            guard let raw = scope[key], !(raw is NSNull) else { return nil }
            guard let text = raw as? String, text.utf8.count <= 256 else { throw AgendaAgentFailure("invalid_context") }
            return text.isEmpty ? nil : text
        }
        projectID = try optionalString("projectId"); workspace = try optionalString("workspace") ?? "auto"
        if let raw = scope["readProjects"], !(raw is NSNull) {
            guard let ids = raw as? [String], ids.count <= 1000,
                  ids.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 256 }), Set(ids).count == ids.count else { throw AgendaAgentFailure("invalid_context") }
            readProjects = ids.sorted()
        } else { readProjects = [] }
        runID = run; conversationID = conversation; userMessageID = message
    }
    var payload: [String: Any] {
        let scope: [String: Any] = ["projectId": projectID ?? "", "workspace": workspace ?? "auto", "readProjects": readProjects ?? []]
        return ["runId": runID, "conversationId": conversationID, "userMessageId": userMessageID, "scope": scope]
    }
    func validate(_ environment: AgendaAgentEnvironment) throws {
        guard environment.ready, !environment.privateMode,
              environment.conversationIDs.contains(conversationID) else { throw AgendaAgentFailure("owner_unavailable") }
        if let workspace, !["auto", "日常", "课程", "科研"].contains(workspace) { throw AgendaAgentFailure("invalid_scope") }
        for id in Set((readProjects ?? []) + (projectID.map { [$0] } ?? [])) {
            guard environment.projects.filter({ $0.id == id }).count == 1 else { throw AgendaAgentFailure("scope_unavailable") }
        }
    }
    func canAccess(_ event: AgendaEvent, _ environment: AgendaAgentEnvironment) -> Bool {
        guard environment.editingScope.canAccess(event) else { return false }
        func inScope(project: String, workspace actual: String?) -> Bool {
            if let projectID, project != projectID && !(readProjects?.contains(project) ?? false) { return false }
            if let workspace, workspace != "auto", actual != workspace && !(readProjects?.contains(project) ?? false) { return false }
            return true
        }
        let actual = event.projectID.isEmpty ? "日常" : environment.projects.first { $0.id == event.projectID }?.workspace
        guard inScope(project: event.projectID, workspace: actual) else { return false }
        if !event.documentID.isEmpty, let source = environment.documents.first(where: { $0.id == event.documentID }) {
            let sourceWorkspace = source.projectID.isEmpty ? environment.documentWorkspaces[source.id] : environment.projects.first { $0.id == source.projectID }?.workspace
            guard inScope(project: source.projectID, workspace: sourceWorkspace) else { return false }
        }
        return true
    }
}
struct AgendaAgentFailure: Error, LocalizedError {
    let reason: String
    init(_ reason: String) { self.reason = reason }
    var errorDescription: String? { reason }
    var payload: [String: Any] { ["version": 1, "status": reason == "occurrence_unsupported" ? "unsupported" : "error", "reason": reason] }
}

enum AgendaAgentAccess {
    static func digest(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    static func version(_ event: AgendaEvent) throws -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return SHA256.hash(data: try encoder.encode(AgendaWire.normalized(event))).map { String(format: "%02x", $0) }.joined()
    }
    static func payload(_ event: AgendaEvent) throws -> [String: Any] {
        ["eventId": event.id, "title": event.title, "kind": event.kind,
         "start": event.start.timeIntervalSince1970 * 1000, "end": event.end.timeIntervalSince1970 * 1000,
         "allDay": event.allDay, "timeZone": event.timeZone, "location": event.location, "details": event.details,
         "projectId": event.projectID, "documentId": event.documentID, "documentKind": event.documentKind,
         "recurrence": ["frequency": event.frequency, "interval": event.interval, "weekdays": event.weekdays,
                        "count": event.count as Any? ?? NSNull(), "until": event.until.map { $0.timeIntervalSince1970 * 1000 } as Any? ?? NSNull()],
         "excluded": event.excluded.map { $0.timeIntervalSince1970 * 1000 },
         "completed": event.completed.map { $0.timeIntervalSince1970 * 1000 },
         "reminderMinutes": event.reminderMinutes as Any? ?? NSNull(), "deleted": event.deleted, "version": try version(event)]
    }
    static func number(_ value: Any?) throws -> Double {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite else { throw AgendaAgentFailure("invalid_number") }
        return n.doubleValue
    }
    static func date(_ value: Any?) throws -> Date {
        let n = try number(value)
        guard abs(n) < 8.64e15 else { throw AgendaAgentFailure("invalid_date") }
        return Date(timeIntervalSince1970: n / 1000)
    }
    static func integer(_ value: Any?, fallback: Int, range: ClosedRange<Int>) throws -> Int {
        guard let value else { return fallback }
        let n = try number(value)
        guard n >= Double(range.lowerBound), n <= Double(range.upperBound), n.rounded() == n else { throw AgendaAgentFailure("invalid_number") }
        return Int(n)
    }
    static func event(_ id: String, events: [AgendaEvent], context: AgendaAgentContext, environment: AgendaAgentEnvironment, includeDeleted: Bool = false) throws -> AgendaEvent {
        try context.validate(environment)
        let found = events.filter { $0.id == id }
        guard found.count == 1, let event = found.first, includeDeleted || !event.deleted,
              context.canAccess(event, environment) else { throw AgendaAgentFailure("event_unavailable") }
        try event.validate()
        return event
    }
    static func read(_ request: [String: Any], events: [AgendaEvent], context: AgendaAgentContext, environment: AgendaAgentEnvironment) throws -> [String: Any] {
        guard Set(request.keys).isSubset(of: ["eventId", "expectedVersion"]), let id = request["eventId"] as? String else { throw AgendaAgentFailure("invalid_request") }
        let item = try event(id, events: events, context: context, environment: environment)
        if let expected = request["expectedVersion"] {
            guard let text = expected as? String, text == (try version(item)) else { throw AgendaAgentFailure("stale_version") }
        }
        return ["version": 1, "status": "ready", "authority": "native-agenda", "event": try payload(item)]
    }
    static func query(_ request: [String: Any], events: [AgendaEvent], context: AgendaAgentContext, environment: AgendaAgentEnvironment) throws -> [String: Any] {
        try context.validate(environment)
        guard Set(request.keys).isSubset(of: ["query", "from", "to", "limit", "offset"]),
              request["query"] == nil || request["query"] is String else { throw AgendaAgentFailure("invalid_request") }
        let query = (request["query"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard query.utf8.count <= 1000 else { throw AgendaAgentFailure("invalid_request") }
        let limit = try integer(request["limit"], fallback: 20, range: 1...50)
        let offset = try integer(request["offset"], fallback: 0, range: 0...10000)
        var window: (Date, Date)?
        if request["from"] != nil || request["to"] != nil {
            let from = try date(request["from"]), to = try date(request["to"])
            guard to > from, to.timeIntervalSince(from) <= 366 * 86400 else { throw AgendaAgentFailure("invalid_window") }
            window = (from, to)
        }
        let duplicates = Dictionary(grouping: events, by: \.id)
        let selected = events.filter { event in
            !event.deleted && duplicates[event.id]?.count == 1 && context.canAccess(event, environment) &&
            (query.isEmpty || [event.title, event.location, event.details, environment.projects.first { $0.id == event.projectID }?.title ?? ""].contains { $0.localizedCaseInsensitiveContains(query) })
        }
        var rows: [(AgendaEvent, AgendaOccurrence?)] = []
        var work = 0
        for event in selected {
            try event.validate()
            if let (from, to) = window {
                // The existing calendar engine preserves count/exclusions/DST.
                // Refuse excessive historical recurrence work instead of dropping rows.
                if event.frequency != "none" {
                    let days = event.calendar().dateComponents([.day], from: event.start, to: min(to, event.until ?? to)).day ?? 0
                    guard days < 250000 else { throw AgendaAgentFailure("query_too_broad") }
                    work += max(0, days)
                    guard work <= 250000 else { throw AgendaAgentFailure("query_too_broad") }
                }
                rows += AgendaEngine.occurrences(event, from: from, to: to).map { (event, $0) }
            } else { rows.append((event, nil)) }
        }
        rows.sort { a, b in
            let first = a.1?.start ?? a.0.start, second = b.1?.start ?? b.0.start
            return first == second ? a.0.id < b.0.id : first < second
        }
        let page = try rows.dropFirst(offset).prefix(limit).map { row -> [String: Any] in
            var value = try payload(row.0)
            if let occurrence = row.1 {
                value["occurrenceStart"] = occurrence.start.timeIntervalSince1970 * 1000
                value["occurrenceEnd"] = occurrence.end.timeIntervalSince1970 * 1000
                value["isDone"] = occurrence.isDone
            }
            return value
        }
        return ["version": 1, "status": "ready", "authority": "native-agenda", "items": page,
                "total": rows.count, "offset": offset, "limit": limit, "hasMore": offset + page.count < rows.count]
    }
    static func patched(_ before: AgendaEvent, proposal: [String: Any]) throws -> AgendaEvent {
        guard let operation = proposal["operation"] as? String, ["update", "delete"].contains(operation),
              let scope = proposal["scope"] as? String else { throw AgendaAgentFailure("invalid_proposal") }
        if scope == "occurrence" { throw AgendaAgentFailure("occurrence_unsupported") }
        guard scope == "series" || scope == "single" && before.frequency == "none",
              proposal["occurrenceStart"] == nil else { throw AgendaAgentFailure("series_scope_required") }
        var after = before
        if operation == "delete" {
            guard proposal["patch"] == nil || (proposal["patch"] as? [String: Any])?.isEmpty == true else { throw AgendaAgentFailure("invalid_patch") }
            after.deleted = true
        } else {
            guard let patch = proposal["patch"] as? [String: Any], !patch.isEmpty,
                  Set(patch.keys).isSubset(of: ["title", "start", "end", "timeZone", "allDay", "location", "details", "reminderMinutes"]) else { throw AgendaAgentFailure("invalid_patch") }
            for key in ["title", "timeZone", "location", "details"] where patch[key] != nil {
                guard let text = patch[key] as? String, text.utf8.count <= (key == "details" ? 20000 : key == "location" ? 4000 : 800) else { throw AgendaAgentFailure("invalid_patch") }
                switch key { case "title": after.title = text; case "timeZone": after.timeZone = text; case "location": after.location = text; default: after.details = text }
            }
            if let raw = patch["start"] { after.start = try date(raw) }
            if let raw = patch["end"] { after.end = try date(raw) }
            if let raw = patch["allDay"] {
                guard let n = raw as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { throw AgendaAgentFailure("invalid_patch") }
                after.allDay = n.boolValue
            }
            if let raw = patch["reminderMinutes"] { after.reminderMinutes = raw is NSNull ? nil : try integer(raw, fallback: 15, range: 0...10080) }
        }
        try after.validate()
        return after
    }
}
