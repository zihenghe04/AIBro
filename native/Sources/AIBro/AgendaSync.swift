import Foundation
import CryptoKit

/// A durable three-way baseline; no cloud credentials or notification settings.
struct AgendaSyncReceipt: Codable {
    var event: AgendaEvent
    var note: String?
}
struct AgendaSyncConflict: Identifiable {
    let id: String
    let local: AgendaEvent
    let remote: AgendaEvent
    let remoteNote: String?
    let receipt: AgendaSyncReceipt
}
struct AgendaSyncChange {
    let noteID: String
    let before: AgendaEvent?
    let after: AgendaEvent
    let expectedNote: String?
    let writeNote: String?
    let receipt: AgendaSyncReceipt
}
struct AgendaSyncPlan {
    var changes: [AgendaSyncChange] = []
    var conflicts: [AgendaSyncConflict] = []
    var warnings: [String] = []
}
enum AgendaWire {
    static func canonical(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed]), as: UTF8.self)
    }
    static func object(_ text: String) throws -> [String: Any] {
        guard let value = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else {throw AgendaError.message("日程记录格式无效")}
        return value
    }
    static func normalized(_ value: AgendaEvent) -> AgendaEvent {
        var e=value
        func date(_ d:Date)->Date {Date(timeIntervalSince1970:(d.timeIntervalSince1970*1000).rounded()/1000)}
        e.start=date(e.start);e.end=date(e.end);e.until=e.until.map(date);e.excluded=e.excluded.map(date);e.completed=e.completed.map(date)
        return e
    }
    static func same(_ a:AgendaEvent?,_ b:AgendaEvent?)->Bool {a.map(normalized)==b.map(normalized)}
    static func noteID(_ event: AgendaEvent) -> String {
        if event.id.hasPrefix("mobile:") {return String(event.id.dropFirst(7))}
        return "agenda_" + SHA256.hash(data: Data(event.id.utf8)).map {String(format: "%02x", $0)}.joined()
    }
    static func stamp(_ note: String?) throws -> String? {try note.map {try canonical(object($0))}}
    static func decode(_ note: String, id: String) throws -> AgendaEvent {
        let n = try object(note)
        guard let content = n["content"] as? String else {throw AgendaError.message("日程缺少正文")}
        let v = try object(content)
        guard v["format"] as? String == "aibro.agenda.v1", let start = v["start"] as? Double, let end = v["end"] as? Double,
              start.isFinite, end.isFinite, abs(start) < 8.64e15, abs(end) < 8.64e15 else {throw AgendaError.message("不兼容的日程格式")}
        var e = AgendaEvent()
        if let ics = v["ics"] as? String, !ics.isEmpty {
            let parsed = AgendaImport.ics(ics, fallbackZone: v["timeZone"] as? String ?? "UTC")
            guard parsed.events.count == 1, parsed.warnings.isEmpty else {throw AgendaError.message("此重复课表需要在手机或原日历中编辑：" + parsed.warnings.joined(separator: "；"))}
            e = parsed.events[0]
            // Stored wall-clock fields must agree; do not silently shift an imported timetable.
            guard abs(e.start.timeIntervalSince1970 * 1000 - start) < 1, abs(e.end.timeIntervalSince1970 * 1000 - end) < 1 else {throw AgendaError.message("课表时间与原件不一致")}
        } else {
            e.timeZone = v["timeZone"] as? String ?? "UTC"
            if v["recurrence"] != nil && !(v["recurrence"] is [String:Any]) {throw AgendaError.message("日程重复规则无效")}
            if let r = v["recurrence"] as? [String: Any] {
                e.frequency = r["frequency"] as? String ?? "none"
                e.interval = r["interval"] as? Int ?? 1
                e.weekdays = r["weekdays"] as? [Int] ?? []
                e.count = r["count"] as? Int
                e.until = (r["until"] as? Double).map {Date(timeIntervalSince1970: $0 / 1000)}
            }
        }
        e.id = id; e.start = Date(timeIntervalSince1970: start / 1000); e.end = Date(timeIntervalSince1970: end / 1000)
        e.title = v["title"] as? String ?? n["title"] as? String ?? ""
        e.allDay = v["allDay"] as? Bool ?? false
        e.location = v["location"] as? String ?? ""; e.details = v["details"] as? String ?? ""
        e.projectID = v["projectId"] as? String ?? n["projectId"] as? String ?? ""
        e.kind = v["eventKind"] as? String ?? "event"; e.source = v["source"] as? String ?? ""
        e.documentID = v["documentID"] as? String ?? (v["sourceNoteIds"] as? [String])?.first ?? ""
        e.documentKind = v["documentKind"] as? String ?? "note"
        for key in ["excluded", "completed"] {
            if let value=v[key], !(value is NSNull) {
                guard let dates=value as? [Double],dates.allSatisfy({$0.isFinite && abs($0)<8.64e15}) else {throw AgendaError.message("日程例外日期无效")}
            }
        }
        if let excluded = v["excluded"] as? [Double] {e.excluded = excluded.map {Date(timeIntervalSince1970: $0/1000)}}
        e.completed = (v["completed"] as? [Double] ?? []).map {Date(timeIntervalSince1970: $0/1000)}
        e.reminderMinutes = v["reminderMinutes"] as? Int
        e.deleted = v["deleted"] as? Bool == true || n["deleted"] as? Bool == true || (n["deletedAt"] as? Double ?? 0) > 0 || n["archived"] as? Bool == true || (n["archivedAt"] as? Double ?? 0) > 0
        try e.validate(); return normalized(e)
    }
    static func encode(_ e: AgendaEvent, noteID: String, previous: String?, now: Double = Date().timeIntervalSince1970 * 1000) throws -> String {
        try e.validate()
        var n = try previous.map(object) ?? [:]
        var v = try (n["content"] as? String).map(object) ?? [:]
        v.removeValue(forKey: "ics") // Native recurrence is explicitly serialized, never flattened.
        v.merge(["format":"aibro.agenda.v1", "title":e.title, "start":e.start.timeIntervalSince1970*1000, "end":e.end.timeIntervalSince1970*1000,
                 "allDay":e.allDay, "timeZone":e.timeZone, "location":e.location, "details":e.details, "projectId":e.projectID,
                 "eventKind":e.kind, "source":e.source, "documentID":e.documentID, "documentKind":e.documentKind,
                 "excluded":e.excluded.map {$0.timeIntervalSince1970*1000}, "completed":e.completed.map {$0.timeIntervalSince1970*1000},
                 "deleted":e.deleted, "reminderMinutes":e.reminderMinutes as Any? ?? NSNull(),
                 "recurrence":["frequency":e.frequency,"interval":e.interval,"weekdays":e.weekdays,"count":e.count as Any? ?? NSNull(),"until":e.until.map {$0.timeIntervalSince1970*1000} as Any? ?? NSNull()]]) {_,new in new}
        n.merge(["id":noteID,"kind":"日程","title":e.title,"workspace":n["workspace"] as? String ?? "日常","projectId":e.projectID,
                 "createdAt":n["createdAt"] ?? now,"updatedAt":now,"content":try canonical(v)]) {_,new in new}
        // Restoring a cancelled event also restores the corresponding note.
        for key in ["deleted", "deletedAt", "archived", "archivedAt"] {n.removeValue(forKey:key)}
        return try canonical(n)
    }
    static func plan(events: [AgendaEvent], receipts: [String: AgendaSyncReceipt], notes: [String: String]) -> AgendaSyncPlan {
        var result = AgendaSyncPlan()
        var mapped:[String:AgendaEvent]=[:]
        for event in events {
            let id=noteID(event)
            guard mapped[id]==nil else {result.warnings.append("日程标识冲突，未同步："+event.title);return result}
            mapped[id]=event
        }
        for id in Set(mapped.keys).union(notes.keys).union(receipts.keys).sorted() {
            let local = mapped[id].map(normalized), raw = notes[id]
            let base = receipts[id].map {AgendaSyncReceipt(event:normalized($0.event),note:$0.note)}
            do {
                let nativeID = local?.id ?? base?.event.id ?? "mobile:"+id
                let remote: AgendaEvent
                if let raw {remote = try decode(raw, id:nativeID)}
                else if let base {var deleted = base.event; deleted.deleted = true; remote = deleted}
                else if let local {
                    let encoded = try encode(local,noteID:id,previous:nil)
                    result.changes.append(.init(noteID:id,before:local,after:local,expectedNote:nil,writeNote:encoded,receipt:.init(event:local,note:encoded))); continue
                } else {continue}
                let remoteStamp = try stamp(raw)
                guard let local else {
                    result.changes.append(.init(noteID:id,before:nil,after:remote,expectedNote:remoteStamp,writeNote:nil,receipt:.init(event:remote,note:remoteStamp))); continue
                }
                if local == remote {
                    if base?.event != local || base?.note != remoteStamp {result.changes.append(.init(noteID:id,before:local,after:local,expectedNote:remoteStamp,writeNote:nil,receipt:.init(event:local,note:remoteStamp)))}
                } else if let base, local == base.event {
                    result.changes.append(.init(noteID:id,before:local,after:remote,expectedNote:remoteStamp,writeNote:nil,receipt:.init(event:remote,note:remoteStamp)))
                } else if let base, remoteStamp == base.note {
                    let encoded = try encode(local,noteID:id,previous:raw)
                    result.changes.append(.init(noteID:id,before:local,after:local,expectedNote:remoteStamp,writeNote:encoded,receipt:.init(event:local,note:encoded)))
                } else {
                    result.conflicts.append(.init(id:id,local:local,remote:remote,remoteNote:remoteStamp,receipt:base ?? .init(event:remote,note:nil)))
                }
            } catch {result.warnings.append((local?.title ?? id)+"："+error.localizedDescription)}
        }
        return result
    }
}
