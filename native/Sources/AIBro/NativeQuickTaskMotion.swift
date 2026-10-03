import SwiftUI

// Task motion mechanisms adapted from TO-DO Panel 1deb3cac:
// renderer/app.js:286–327,375–424; renderer/styles.css:1467–1514.
// Copyright (c) 2026 TO-DO Panel contributors, MIT (docs/licenses/to-do-panel-MIT.txt).
// Presentation identities only: the workbench remains the sole task data source.
struct NativeQuickTaskMotionInput: Equatable {
    struct Item: Equatable {
        let id: String
        let completed: Bool
        let pending: Bool
    }
    let ready: Bool
    let filter: String?
    let items: [Item]
    let visibleIDs: [String]
    @MainActor init(workbench: NativeQuickWorkbenchStore) {
        ready = workbench.ready; filter = workbench.workflowFilter
        items = workbench.tasks.map { .init(id: $0.id, completed: $0.isCompleted,
            pending: $0.isSaving == true || workbench.busyTaskIDs.contains($0.id)) }
        visibleIDs = workbench.visibleTasks.map(\.id)
    }
    init(ready: Bool = true, filter: String? = nil, items: [Item], visibleIDs: [String]? = nil) {
        self.ready = ready; self.filter = filter; self.items = items
        self.visibleIDs = visibleIDs ?? items.map(\.id)
    }
}

struct NativeQuickTaskMotionState {
    struct Change {
        let state: NativeQuickTaskMotionState
        let moves: Bool
        let arrivals: Set<String>
        let pendingArrivals: Set<String>
        let categoryAnchorID: String?
    }
    private(set) var order: [String] = []
    private(set) var completed: [String: Bool] = [:]
    private(set) var checkRevision: [String: Int] = [:]
    private(set) var arrivalRevision: [String: Int] = [:]
    private var known = Set<String>()
    private var initialized = false
    private var filter: String?

    // A pure next projection lets SwiftUI see the new order and its transaction
    // together; onChange commits this small identity state, never task contents.
    func next(_ input: NativeQuickTaskMotionInput) -> Change {
        guard input.ready else { return .init(state: .init(), moves: false, arrivals: [], pendingArrivals: [], categoryAnchorID: nil) }
        var next = self
        let current = Dictionary(input.items.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let visible = input.visibleIDs.filter { current[$0] != nil }
        let baseline = !initialized || filter != input.filter
        if baseline {
            next.initialized = true; next.filter = input.filter
            next.known = Set(current.keys); next.order = visible
            next.completed = current.mapValues { $0.pending ? (completed[$0.id] ?? $0.completed) : $0.completed }; next.checkRevision = [:]; next.arrivalRevision = [:]
            return .init(state: next, moves: false, arrivals: [], pendingArrivals: [],
                         categoryAnchorID: initialized && filter != input.filter ? visible.first : nil)
        }
        next.completed = completed.filter { current[$0.key] != nil }
        next.checkRevision = checkRevision.filter { current[$0.key] != nil }
        next.arrivalRevision = arrivalRevision.filter { current[$0.key] != nil }
        var arrivals = Set<String>()
        for item in input.items where !item.pending {
            if !known.contains(item.id) { arrivals.insert(item.id); next.arrivalRevision[item.id, default: 0] += 1 }
            if let old = completed[item.id], old != item.completed {
                // Both directions advance the trigger: reopening cancels an
                // unfinished check pulse instead of replaying its last frames.
                next.checkRevision[item.id, default: 0] += 1
            }
            next.completed[item.id] = item.completed
        }
        // The JS projection already keeps pendingStatuses.before until durable
        // completion. Do not create a second order: keyboard ranges and row
        // positions must use exactly the same canonical sequence.
        let pendingArrivals = Set(visible.filter { current[$0]?.pending == true && !known.contains($0) })
        next.known = known.intersection(current.keys).union(input.items.filter { !$0.pending }.map(\.id))
        next.order = visible
        return .init(state: next, moves: visible != self.order && pendingArrivals.isEmpty,
                     arrivals: arrivals.intersection(visible), pendingArrivals: pendingArrivals, categoryAnchorID: nil)

    }
}

struct NativeQuickTaskCompletionGlyph: View {
    let completed: Bool
    let selecting: Bool
    let selected: Bool
    let busy: Bool
    let revision: Int
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        ZStack {
            Image(systemName: selecting ? (selected ? "checkmark.square.fill" : "square") : (completed ? "checkmark.circle.fill" : "circle"))
                .font(.system(size: selecting ? 16 : 17, weight: .light))
                .foregroundStyle((selecting ? selected : completed) ? Color.accentColor : Color.secondary)
                .opacity(busy ? 0 : 1)
                .keyframeAnimator(initialValue: CGFloat(1), trigger: revision) { content, scale in
                    content.scaleEffect(reduceMotion || selecting || !completed ? 1 : scale)
                } keyframes: { _ in
                    if completed && !reduceMotion && !selecting {
                        CubicKeyframe(CGFloat(1.20), duration: 0.14)
                        CubicKeyframe(CGFloat(1), duration: 0.24)
                    } else { MoveKeyframe(CGFloat(1)) }
                }
            if busy { ProgressView().controlSize(.mini) }
        }.frame(width: 22, height: 22)
    }
}

/// A pending new row stays visibly unconfirmed. The durable receipt animates
/// that same row from muted to full weight, without mounting a second editor.
struct NativeQuickTaskArrivalEffect: ViewModifier {
    struct Values { var opacity = 1.0; var scale = 1.0 }
    let revision: Int
    let pending: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        content.keyframeAnimator(initialValue: Values(), trigger: revision) { content, value in
            content.opacity(pending ? 0.58 : (reduceMotion ? 1 : value.opacity))
                .scaleEffect(reduceMotion ? 1 : value.scale, anchor: .topLeading)
        } keyframes: { _ in
            KeyframeTrack(\.opacity) {
                MoveKeyframe(reduceMotion ? 1.0 : 0.58)
                LinearKeyframe(1.0, duration: reduceMotion ? 0 : 0.24)
            }
            KeyframeTrack(\.scale) {
                MoveKeyframe(reduceMotion ? 1.0 : 0.98)
                CubicKeyframe(1.0, duration: reduceMotion ? 0 : 0.24)
            }
        }
    }
}
