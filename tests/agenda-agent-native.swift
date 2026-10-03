import Foundation
import SwiftUI

func nativeUI(_ zh: String, _ en: String) -> String { en }
enum StudioPalette { static let jade = Color.green; static let canvas = Color.white }
struct ContentRecord { let id:String;let title:String;let workspace:String;let projectId:String;let kind:String;let status:String;let start:Double?;let due:Double?;let completed:Double?;var dueDay:String?=nil;var updated:Double?=nil;var reminderMinutes:Int?=nil;var reminderDisabled:Bool?=nil }

@main struct AgendaAgentTests {
    @MainActor static func main() async throws {
        var checks = 0
        func check(_ value: Bool, _ label: String) { precondition(value, label); checks += 1; print("PASS", label) }
        func rejects(_ reason: String, _ operation: () throws -> Void) {
            do { try operation(); preconditionFailure("Expected \(reason)") }
            catch { check((error as? AgendaAgentFailure)?.reason == reason, reason) }
        }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("aibro-agent-agenda-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = AgendaStore(); store.load(folder: directory, qa: true)
        var environment = AgendaAgentEnvironment(ready: true, privateMode: false,
            projects: [.init(id: "p", title: "Synthetic course", workspace: "课程"), .init(id: "q", title: "Synthetic research", workspace: "科研")],
            documents: [.init(id: "n", title: "Synthetic source", projectID: "p", kind: "note")], conversationIDs: ["c"])
        let rawContext: [String: Any] = ["runId": "r", "conversationId": "c", "userMessageId": "u", "scope": [:]]
        let context = try AgendaAgentContext(rawContext)
        func sample(_ id: String, _ project: String = "p") -> AgendaEvent {
            var value = AgendaEvent(); value.id = id; value.title = "Fictional campus observation"; value.projectID = project
            value.start = Date(timeIntervalSince1970: 1791072000); value.end = value.start.addingTimeInterval(1200)
            value.reminderMinutes = nil; value.timeZone = "Asia/Shanghai"; return value
        }
        var event = sample("event"); event.details = "Record the walking route."; event.start = event.start.addingTimeInterval(0.0001); try store.save(event)
        let initialVersion = try AgendaAgentAccess.version(event)
        var changed = event; changed.excluded = [event.start]
        check(try AgendaAgentAccess.version(changed) != initialVersion, "version includes excluded occurrences")
        changed = event; changed.source = "manual"
        check(try AgendaAgentAccess.version(changed) != initialVersion, "version includes normalized full event provenance")
        var fractional = event; fractional.start = event.start.addingTimeInterval(0.0001)
        check(try AgendaAgentAccess.version(fractional) == initialVersion, "version uses established millisecond normalization")

        var hidden = sample("hidden", "not-public"); hidden.title = "Hidden title"; try store.save(hidden)
        var linked = sample("linked"); linked.documentID = "missing"; try store.save(linked)
        var deleted = sample("cancelled"); deleted.deleted = true; try store.save(deleted)
        let query = try AgendaAgentAccess.query([:], events: store.events, context: context, environment: environment)
        if CommandLine.arguments.count > 1 {
            let read = try AgendaAgentAccess.read(["eventId":"event"],events:store.events,context:context,environment:environment)
            let fixture: [String:Any] = ["context":context.payload,"query":query,"read":read,"event":try AgendaAgentAccess.payload(event)]
            try JSONSerialization.data(withJSONObject:fixture,options:[.prettyPrinted,.sortedKeys]).write(to:URL(fileURLWithPath:CommandLine.arguments[1]))
        }
        check(query["total"] as? Int == 1 && (query["items"] as? [[String: Any]])?.first?["eventId"] as? String == "event", "native query excludes cancelled and inaccessible project/source without a mirror")
        let courseContext = try AgendaAgentContext(["runId":"r", "conversationId":"c", "userMessageId":"u", "scope":["workspace":"课程","projectId":"p"]])
        check(try AgendaAgentAccess.query(["query":"campus"], events:store.events, context:courseContext, environment:environment)["total"] as? Int == 1, "course event scope derives project workspace rather than mirror daily default")
        var fractionalEvent = event; fractionalEvent.start = fractionalEvent.start.addingTimeInterval(0.125)
        check((try AgendaAgentAccess.payload(fractionalEvent))["start"] as? Double == fractionalEvent.start.timeIntervalSince1970*1000, "native timestamp payload retains actual millisecond values")
        let research = sample("research", "q"), standalone = sample("standalone", "")
        let candidates = [event, research, standalone]
        for (workspace, extras, expected) in [("auto", [String](), 3), ("日常", [], 1), ("科研", [], 1), ("科研", ["p"], 2)] {
            let scoped = try AgendaAgentContext(["runId":"r","conversationId":"c","userMessageId":"u","scope":["workspace":workspace,"projectId":"","readProjects":extras]])
            check(try AgendaAgentAccess.query([:],events:candidates,context:scoped,environment:environment)["total"] as? Int == expected, "scope \(workspace) extras \(extras) does not treat additional projects as an all-project allowlist")
            check(try AgendaAgentContext(scoped.payload) == scoped, "native context roundtrip \(workspace)")
        }
        let dailyContext = try AgendaAgentContext(["runId":"r","conversationId":"c","userMessageId":"u","scope":["workspace":"日常","projectId":"","readProjects":[]]])
        var crossLinked = standalone; crossLinked.documentID = "n"
        check(try AgendaAgentAccess.query([:],events:[crossLinked],context:dailyContext,environment:environment)["total"] as? Int == 0, "standalone event cannot reveal linked source outside requested workspace")
        rejects("event_unavailable") { _ = try AgendaAgentAccess.read(["eventId":"hidden"], events:store.events, context:context, environment:environment) }
        rejects("stale_version") { _ = try AgendaAgentAccess.read(["eventId":"event", "expectedVersion":"old"], events:store.events, context:context, environment:environment) }
        var privateEnvironment = environment; privateEnvironment.privateMode = true
        rejects("owner_unavailable") { _ = try AgendaAgentAccess.query([:], events:store.events, context:context, environment:privateEnvironment) }
        rejects("invalid_number") { _ = try AgendaAgentAccess.query(["limit":true], events:store.events, context:context, environment:environment) }
        rejects("invalid_window") { _ = try AgendaAgentAccess.query(["from":0,"to":400*86400000.0], events:store.events, context:context, environment:environment) }
        rejects("invalid_patch") { _ = try AgendaAgentAccess.patched(event, proposal:["operation":"update","scope":"single","patch":["projectId":"q"]]) }
        rejects("occurrence_unsupported") { _ = try AgendaAgentAccess.patched(event, proposal:["operation":"delete","scope":"occurrence"]) }

        var recurring = sample("series"); recurring.timeZone = "America/Los_Angeles"
        recurring.start = ISO8601DateFormatter().date(from:"2026-03-07T17:00:00Z")!; recurring.end = recurring.start.addingTimeInterval(3600)
        recurring.frequency = "daily"; recurring.count = 3
        recurring.excluded = [ISO8601DateFormatter().date(from:"2026-03-08T16:00:00Z")!]
        recurring.completed = [ISO8601DateFormatter().date(from:"2026-03-09T16:00:00Z")!]
        let from = recurring.start.addingTimeInterval(-1).timeIntervalSince1970*1000, to = recurring.end.addingTimeInterval(4*86400).timeIntervalSince1970*1000
        let page = try AgendaAgentAccess.query(["from":from,"to":to,"limit":1], events:[recurring], context:context, environment:environment)
        let page2 = try AgendaAgentAccess.query(["from":from,"to":to,"limit":1,"offset":1], events:[recurring], context:context, environment:environment)
        check(page["total"] as? Int == 2 && page["hasMore"] as? Bool == true && page2["hasMore"] as? Bool == false, "recurrence count/exclusion and pagination share exact total")
        check((page2["items"] as? [[String:Any]])?.first?["occurrenceStart"] as? Double == recurring.completed[0].timeIntervalSince1970*1000, "recurrence keeps local clock through DST")
        check((page2["items"] as? [[String:Any]])?.first?["isDone"] as? Bool == true, "completed occurrence status is real")
        rejects("series_scope_required") { _ = try AgendaAgentAccess.patched(recurring, proposal:["operation":"delete","scope":"single"]) }
        check(try AgendaAgentAccess.patched(recurring, proposal:["operation":"delete","scope":"series"]).deleted, "explicit series cancellation supported")

        let controller = AgendaAgentController(); var presentations = 0
        controller.configure(store:store,environment:{environment},present:{presentations += 1;return true})
        var proposal: [String:Any] = ["id":"proposal-1","eventId":"event","operation":"update","expectedVersion":initialVersion,"quote":"Move the observation to Room A.","scope":"single","patch":["location":"Room A"]]
        let result = await controller.mutation(proposal,context:context,verify:{true})
        check(result["status"] as? String == "pending_review" && store.events.first{$0.id=="event"}?.location == "", "opening review is not a write or completion")
        check(await controller.status("proposal-1",proposal:proposal,context:context,verify:{true})["status"] as? String == "pending_review", "status distinguishes unconfirmed review")
        let reviewID = controller.review!.id
        check(await controller.mutation(proposal,context:context,verify:{true})["status"] as? String == "pending_review" && presentations == 1, "same request reuses existing review")
        await controller.confirm(reviewID)
        check(store.events.first{$0.id=="event"}?.location == "Room A" && store.operationReceipts.count == 1 && controller.review == nil, "explicit confirmation atomically updates same event and receipt")
        let restored = AgendaStore(); restored.load(folder:directory,qa:true)
        let reopened = AgendaAgentController(); reopened.configure(store:restored,environment:{environment},present:{true})
        check(await reopened.status("proposal-1",proposal:proposal,context:context,verify:{true})["status"] as? String == "committed" && restored.events.first{$0.id=="event"}?.location == "Room A", "receipt and changed event survive restart independently")
        check(await reopened.mutation(proposal,context:context,verify:{true})["status"] as? String == "committed" && reopened.review == nil && restored.operationReceipts.count == 1, "replay of completed request never opens or writes another mutation")
        var conflictingReplay = proposal; conflictingReplay["patch"] = ["location":"Different patch"]
        check(await reopened.mutation(conflictingReplay,context:context,verify:{true})["reason"] as? String == "request_conflict" && restored.operationReceipts.count == 1, "same durable request ID with different proposal is not reported committed")
        check(await reopened.status("proposal-1",proposal:conflictingReplay,context:context,verify:{true})["reason"] as? String == "request_conflict", "status also binds the exact persisted proposal rather than only request ID")
        let otherContext = try AgendaAgentContext(["runId":"other", "conversationId":"c", "userMessageId":"u", "scope":[:]])
        check(await reopened.status("proposal-1",proposal:proposal,context:otherContext,verify:{true})["status"] as? String == "unknown", "receipt cannot be borrowed by another run")

        event = store.events.first{$0.id=="event"}!
        proposal["id"] = "stale"; proposal["expectedVersion"] = try AgendaAgentAccess.version(event); proposal["patch"] = ["location":"Room B"]
        _ = await controller.mutation(proposal,context:context,verify:{true})
        var newer = event; newer.details = "Human edit after review opened"; try store.save(newer,expected:event)
        await controller.confirm(controller.review!.id)
        check(controller.review != nil && controller.error != nil && store.events.first{$0.id=="event"} == newer, "new human edit rejects old review while preserving proposal and source")
        controller.cancelReview()
        check(await controller.status("stale",proposal:proposal,context:context,verify:{true})["status"] as? String == "cancelled", "cancelled review does not claim persistent success")

        proposal["id"] = "revoked"; proposal["expectedVersion"] = try AgendaAgentAccess.version(newer)
        _ = await controller.mutation(proposal,context:context,verify:{true})
        environment.documents = []; environment.projects = []; controller.refreshContext()
        check(controller.review == nil && store.events.first{$0.id=="event"} == newer, "scope revoke hides open review without a write")
        environment.projects = [.init(id:"p",title:"Synthetic course",workspace:"课程")]

        var release: CheckedContinuation<Bool,Never>?
        let pending = Task { @MainActor in await controller.query([:],context:context,verify:{await withCheckedContinuation{release=$0}}) }
        for _ in 0..<100 where release == nil { await Task.yield() }
        precondition(release != nil); controller.invalidate(); release!.resume(returning:true)
        check(await pending.value["reason"] as? String == "owner_unavailable", "late authorization cannot publish after owner invalidation")

        var allow = true
        proposal["id"] = "deny-confirm"
        _ = await controller.mutation(proposal,context:context,verify:{allow})
        allow = false; await controller.confirm(controller.review!.id)
        check(controller.review == nil && store.events.first{$0.id=="event"} == newer, "confirmation verifies current JS authority again and hides revoked proposal")
        controller.cancelReview()

        proposal["id"] = "write-failure"
        _ = await controller.mutation(proposal,context:context,verify:{true})
        let archive = directory.appendingPathComponent("agenda.json"), archiveBytes = try Data(contentsOf:archive)
        try FileManager.default.removeItem(at:archive);try FileManager.default.createDirectory(at:archive,withIntermediateDirectories:false)
        await controller.confirm(controller.review!.id)
        check(controller.error != nil && controller.review != nil && store.events.first{$0.id=="event"} == newer && store.operationReceipts.count == 1, "atomic save failure retains review and original event without a receipt")
        try FileManager.default.removeItem(at:archive);try archiveBytes.write(to:archive)
        controller.cancelReview()

        proposal = ["id":"delete-1","eventId":"event","operation":"delete","expectedVersion":try AgendaAgentAccess.version(newer),"quote":"Cancel this event.","scope":"single"]
        _ = await controller.mutation(proposal,context:context,verify:{true})
        await controller.confirm(controller.review!.id)
        let deleteStatus = await controller.status("delete-1",proposal:proposal,context:context,verify:{true})
        check(store.events.first{$0.id=="event"}?.deleted == true && deleteStatus["status"] as? String == "committed", "cancel event has real durable receipt and recoverable soft deletion")
        check(await controller.query([:],context:context,verify:{true})["total"] as? Int == 0, "cancelled native event disappears immediately without waiting for note sync")
        var priorCreation = sample("agenda_prior_creation"); priorCreation.deleted = true; try store.save(priorCreation)
        var privateCreation = sample("agenda_hidden_creation", "hidden"); try store.save(privateCreation)
        check(controller.related().isEmpty && controller.related(includeCancelled:true).map{$0["id"] as? String} == ["agenda_prior_creation"], "creation receipt history retains cancelled IDs without leaking hidden project metadata")
        check(controller.related(includeCancelled:true).first?["deleted"] as? Bool == true, "cancelled creation is explicitly identified rather than offered as pending again")
        environment.privateMode = true
        check(controller.related(includeCancelled:true).isEmpty, "creation receipt history is unavailable in private mode")
        print("\(checks) agenda agent checks passed; temporary store only, no GUI/network/device")
    }
}
