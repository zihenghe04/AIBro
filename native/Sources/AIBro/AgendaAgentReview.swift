import Foundation
import SwiftUI

struct AgendaAgentReview: Identifiable {
    let id = UUID()
    let requestID: String
    let receiptKey: String
    let proposalStamp: String
    let proposal: [String: Any]
    let context: AgendaAgentContext
    let owner: URL
    let before: AgendaEvent
    let after: AgendaEvent
    let verify: AgendaAgentController.Verify
    var isDelete: Bool { after.deleted }
    var isSeries: Bool { before.frequency != "none" }
}

/// Native AgendaStore is authoritative. Showing a review never writes a record;
/// only explicit confirmation commits an exact baseline plus a durable request ID.
@MainActor final class AgendaAgentController: ObservableObject {
    typealias Verify = @MainActor () async -> Bool
    @Published private(set) var review: AgendaAgentReview?
    @Published private(set) var saving = false
    @Published private(set) var error: String?
    private weak var store: AgendaStore?
    private var environment: () -> AgendaAgentEnvironment = { .init() }
    private var present: () async -> Bool = { false }
    private var generation = 0
    private var cancelled: Set<String> = []

    func configure(store: AgendaStore, environment: @escaping () -> AgendaAgentEnvironment,
                   present: @escaping () async -> Bool) {
        invalidate(); self.store = store; self.environment = environment; self.present = present
    }
    func invalidate() {
        generation += 1; review = nil; saving = false; error = nil; cancelled.removeAll()
    }
    func refreshContext() {
        guard let current = review else { return }
        guard let store = try? check(current.context), store.storageIdentity == current.owner,
              current.context.canAccess(current.before, environment()),
              (try? AgendaAgentAccess.event(current.before.id, events: store.events, context: current.context, environment: environment())) != nil else {
            invalidate(); return
        }
    }
    func related(includeCancelled: Bool = false) -> [[String: Any]] {
        let value = environment()
        guard value.ready, !value.privateMode, let store, store.storageReady else { return [] }
        return store.events.filter {
            (includeCancelled || !$0.deleted) && (!$0.documentID.isEmpty || $0.id.hasPrefix("agenda_")) && value.editingScope.canAccess($0)
        }.map { event in
            var item: [String: Any] = ["id": event.id, "title": event.title, "documentID": event.documentID, "start": event.start.timeIntervalSince1970 * 1000]
            if includeCancelled { item["deleted"] = event.deleted }
            return item
        }
    }
    private func failure(_ error: Error) -> [String: Any] {
        (error as? AgendaAgentFailure ?? AgendaAgentFailure("agenda_unavailable")).payload
    }
    private func check(_ context: AgendaAgentContext) throws -> AgendaStore {
        guard let store, store.storageReady else { throw AgendaAgentFailure("agenda_unavailable") }
        try context.validate(environment()); return store
    }
    private func authorized(_ context: AgendaAgentContext, verify: Verify) async throws -> AgendaStore {
        let initial = try check(context), owner = initial.storageIdentity, epoch = generation
        guard await verify(), epoch == generation else { throw AgendaAgentFailure("owner_unavailable") }
        let current = try check(context)
        guard current === initial, current.storageIdentity == owner else { throw AgendaAgentFailure("owner_unavailable") }
        return current
    }
    func query(_ request: [String: Any], context: AgendaAgentContext, verify: Verify) async -> [String: Any] {
        do {
            let store = try await authorized(context, verify: verify)
            return try AgendaAgentAccess.query(request, events: store.events, context: context, environment: environment())
        } catch { return failure(error) }
    }
    func read(_ request: [String: Any], context: AgendaAgentContext, verify: Verify) async -> [String: Any] {
        do {
            let store = try await authorized(context, verify: verify)
            return try AgendaAgentAccess.read(request, events: store.events, context: context, environment: environment())
        } catch { return failure(error) }
    }
    private func key(_ requestID: String, _ context: AgendaAgentContext) throws -> String {
        guard !requestID.isEmpty, requestID.utf8.count <= 256 else { throw AgendaAgentFailure("invalid_request") }
        // The same request cannot acquire a new identity by changing its scope.
        let identity = try AgendaWire.canonical([context.runID, context.conversationID, context.userMessageID, requestID])
        return "agent_agenda_" + AgendaAgentAccess.digest(identity) + "_"
    }
    private func proposalStamp(_ proposal: [String: Any], requestID: String) throws -> String {
        let fields: Set<String> = ["id", "operation", "eventId", "expectedVersion", "quote", "patch", "scope", "occurrenceStart", "sourceMessageId", "conversationId", "runId"]
        guard proposal["id"] as? String == requestID, Set(proposal.keys).isSubset(of: fields.union(["status"])),
              proposal["status"] == nil || proposal["status"] as? String == "pending" else { throw AgendaAgentFailure("invalid_proposal") }
        return try AgendaWire.canonical(proposal.filter { fields.contains($0.key) })
    }
    private func committed(_ receipt: AgendaCommitReceipt, requestID: String, context: AgendaAgentContext, store: AgendaStore) throws -> [String: Any] {
        // A cancelled event remains readable only as the user's own operation receipt.
        // Do not turn an old receipt into access to a now-hidden project/source.
        _ = try AgendaAgentAccess.event(receipt.eventID, events: store.events, context: context, environment: environment(), includeDeleted: true)
        return ["version": 1, "status": "committed", "requestId": requestID, "eventId": receipt.eventID,
                "receiptFingerprint": receipt.fingerprint, "persisted": true]
    }
    func mutation(_ proposal: [String: Any], context: AgendaAgentContext, verify: @escaping Verify) async -> [String: Any] {
        do {
            guard Set(proposal.keys).isSubset(of: ["id", "operation", "eventId", "expectedVersion", "quote", "patch", "scope", "occurrenceStart", "sourceMessageId", "conversationId", "runId", "status"]),
                  let requestID = proposal["id"] as? String, let eventID = proposal["eventId"] as? String,
                  let expected = proposal["expectedVersion"] as? String, expected.count == 64,
                  let quote = proposal["quote"] as? String, !quote.isEmpty, quote.utf8.count <= 12000,
                  proposal["status"] == nil || proposal["status"] as? String == "pending" else { throw AgendaAgentFailure("invalid_proposal") }
            for (key, value) in [("runId", context.runID), ("conversationId", context.conversationID), ("sourceMessageId", context.userMessageID)] where proposal[key] != nil {
                guard proposal[key] as? String == value else { throw AgendaAgentFailure("owner_unavailable") }
            }
            let prefix = try key(requestID, context), stamp = try proposalStamp(proposal, requestID: requestID)
            let key = prefix + AgendaAgentAccess.digest(stamp)
            let store = try await authorized(context, verify: verify)
            let receipts = store.operationReceipts.filter { $0.key.hasPrefix(prefix) }
            if !receipts.isEmpty {
                guard receipts.count == 1, let receipt = receipts[key], receipt.eventID == eventID else { throw AgendaAgentFailure("request_conflict") }
                return try committed(receipt, requestID: requestID, context: context, store: store)
            }
            let before = try AgendaAgentAccess.event(eventID, events: store.events, context: context, environment: environment())
            guard try AgendaAgentAccess.version(before) == expected else { throw AgendaAgentFailure("stale_version") }
            let after = try AgendaAgentAccess.patched(before, proposal: proposal)
            guard after != before else { throw AgendaAgentFailure("no_changes") }
            if let current = review {
                guard current.receiptKey == key, current.proposalStamp == stamp else { throw AgendaAgentFailure("review_busy") }
                return ["version": 1, "status": "pending_review", "requestId": requestID, "eventId": eventID]
            }
            let epoch = generation, owner = store.storageIdentity
            guard !saving, await present(), generation == epoch else { throw AgendaAgentFailure("navigation_deferred") }
            // Navigation may wait for another editor. Revalidate the proposal and
            // authority after that wait before exposing its private text in a sheet.
            let current = try await authorized(context, verify: verify)
            guard generation == epoch, current === store, current.storageIdentity == owner, let owner,
                  review == nil, !saving else { throw AgendaAgentFailure("owner_unavailable") }
            let fresh = try AgendaAgentAccess.event(eventID, events: current.events, context: context, environment: environment())
            guard fresh == before else { throw AgendaAgentFailure("stale_version") }
            cancelled.remove(prefix); error = nil
            review = .init(requestID: requestID, receiptKey: key, proposalStamp: stamp, proposal: proposal,
                           context: context, owner: owner, before: before, after: after, verify: verify)
            return ["version": 1, "status": "pending_review", "requestId": requestID, "eventId": eventID]
        } catch { return failure(error) }
    }
    func status(_ requestID: String, proposal: [String: Any], context: AgendaAgentContext, verify: Verify) async -> [String: Any] {
        do {
            let key = try key(requestID, context), store = try await authorized(context, verify: verify)
            let exactKey = key + AgendaAgentAccess.digest(try proposalStamp(proposal, requestID: requestID))
            let receipts = store.operationReceipts.filter { $0.key.hasPrefix(key) }
            if !receipts.isEmpty {
                guard receipts.count == 1, let receipt = receipts[exactKey], receipt.eventID == proposal["eventId"] as? String else { throw AgendaAgentFailure("request_conflict") }
                return try committed(receipt, requestID: requestID, context: context, store: store)
            }
            if let current = review, current.receiptKey.hasPrefix(key) {
                guard current.receiptKey == exactKey else { throw AgendaAgentFailure("request_conflict") }
                _ = try AgendaAgentAccess.event(current.before.id, events: store.events, context: context, environment: environment())
                return ["version": 1, "status": "pending_review", "requestId": requestID]
            }
            return ["version": 1, "status": cancelled.contains(key) ? "cancelled" : "unknown", "requestId": requestID]
        } catch { return failure(error) }
    }
    func cancelReview() {
        guard let current = review else { return }
        if cancelled.count >= 200 { cancelled.removeAll() }
        if let key = try? key(current.requestID, current.context) { cancelled.insert(key) }
        generation += 1; review = nil; saving = false; error = nil
    }
    func confirm(_ id: UUID) async {
        guard let current = review, current.id == id, !saving else { return }
        let epoch = generation; saving = true; error = nil
        defer { if epoch == generation { saving = false } }
        do {
            let store = try await authorized(current.context, verify: current.verify)
            guard epoch == generation, review?.id == id, store.storageIdentity == current.owner else { return }
            let latest = try AgendaAgentAccess.event(current.before.id, events: store.events, context: current.context, environment: environment())
            guard latest == current.before else { throw AgendaAgentFailure("stale_version") }
            guard current.context.canAccess(current.after, environment()) else { throw AgendaAgentFailure("scope_unavailable") }
            // No await between the final authority/version check and atomic commit.
            _ = try store.commit(current.after, expected: current.before, requestID: current.receiptKey)
            review = nil; error = nil
        } catch {
            guard epoch == generation, review?.id == id else { return }
            if let failure = error as? AgendaAgentFailure, ["owner_unavailable", "scope_unavailable", "event_unavailable"].contains(failure.reason) {
                invalidate(); return
            }
            self.error = (error as? AgendaAgentFailure)?.reason == "stale_version"
                ? nativeUI("日程已有更新，未覆盖。关闭此审阅后请重新读取日程。", "The event changed. Close this review and read it again; nothing was overwritten.")
                : nativeUI("未保存。日程或会话当前不可用，请关闭后重试。", "Not saved. The event or conversation is unavailable. Close this review and retry.")
        }
    }
}

/// One observed owner for the new sheet; no new permanent status surface.
struct AgendaAgentReviewHost: View {
    @ObservedObject var controller: AgendaAgentController
    var body: some View {
        Color.clear.frame(width: 0, height: 0)
            .sheet(item: Binding(get: { controller.review }, set: { if $0 == nil { controller.cancelReview() } })) { value in
                AgendaAgentReviewView(controller: controller, review: value)
            }
    }
}
private struct AgendaAgentReviewView: View {
    @ObservedObject var controller: AgendaAgentController
    let review: AgendaAgentReview
    private func date(_ value: Date, zone: String) -> String {
        let formatter = DateFormatter(); formatter.locale = .current; formatter.timeZone = TimeZone(identifier: zone)
        formatter.dateStyle = .medium; formatter.timeStyle = .short
        return formatter.string(from: value)
    }
    private func row(_ title: String, _ before: String, _ after: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            if before != after && !review.isDelete { Text(before.isEmpty ? "—" : before).foregroundStyle(.secondary).strikethrough() }
            Text(after.isEmpty ? "—" : after).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(review.isDelete ? nativeUI("确认取消日程", "Review event cancellation") : nativeUI("审阅日程修改", "Review event changes")).font(.title2.bold())
                Spacer()
                Button(nativeUI("保留原日程", "Keep original")) { controller.cancelReview() }.disabled(controller.saving)
                Button(review.isDelete ? nativeUI("确认取消", "Cancel event") : nativeUI("确认保存", "Save changes")) {
                    Task { await controller.confirm(review.id) }
                }.buttonStyle(.borderedProminent).tint(review.isDelete ? .red : StudioPalette.jade).disabled(controller.saving)
            }.padding(22)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if review.isSeries {
                        Text(nativeUI("本次操作会影响整个重复系列。", "This change applies to the entire recurring series.")).font(.callout.weight(.semibold))
                    }
                    row(nativeUI("名称", "Title"), review.before.title, review.after.title)
                    row(nativeUI("开始", "Start"), date(review.before.start, zone: review.before.timeZone), date(review.after.start, zone: review.after.timeZone))
                    row(nativeUI("结束", "End"), date(review.before.end, zone: review.before.timeZone), date(review.after.end, zone: review.after.timeZone))
                    row(nativeUI("时区", "Time zone"), review.before.timeZone, review.after.timeZone)
                    row(nativeUI("全天", "All day"), review.before.allDay ? nativeUI("是", "Yes") : nativeUI("否", "No"), review.after.allDay ? nativeUI("是", "Yes") : nativeUI("否", "No"))
                    row(nativeUI("地点", "Location"), review.before.location, review.after.location)
                    row(nativeUI("提醒（分钟）", "Reminder (minutes)"), review.before.reminderMinutes.map(String.init) ?? nativeUI("无", "None"), review.after.reminderMinutes.map(String.init) ?? nativeUI("无", "None"))
                    row(nativeUI("备注", "Notes"), review.before.details, review.after.details)
                    if let error = controller.error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
                }.padding(22)
            }
            Divider()
            Text(review.isDelete ? nativeUI("取消后可在日程的“已取消日程”中恢复。确认前不会改动。", "You can restore it from Cancelled events. Nothing changes until you confirm.") : nativeUI("请核对时间与内容。确认后保存到本机日程。", "Check the time and details. Confirmation saves to your local calendar."))
                .font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding(18)
        }.frame(width: 620, height: 620).background(StudioPalette.canvas)
            .interactiveDismissDisabled(controller.saving)
            .onExitCommand { if !controller.saving { controller.cancelReview() } }
    }
}
