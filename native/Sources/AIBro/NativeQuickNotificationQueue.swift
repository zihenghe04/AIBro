import Foundation
import Combine

/// Notifications describe already-established facts. Enqueuing never writes a
/// task, run, calendar event or a persistence receipt.
struct NativeQuickNotificationEvent: Identifiable, Equatable {
    enum Source: String, Equatable {
        case task, agenda, pomodoro, agent, clipboard, externalCodex, externalClaude, externalGPT
        var isExternal: Bool { [.externalCodex, .externalClaude, .externalGPT].contains(self) }
    }
    enum Destination: Equatable {
        case task(String), run(String), agenda(String), pomodoro(String), external(String)
        case clipboard(UUID) // Local feedback identity, never a clipboard payload or item ID.
        case history([String])
    }
    enum Outcome: Equatable { case completed, failed, stopped, interrupted, rejected, information }
    let outcome: Outcome
    let id: String
    let ownerID: String
    let source: Source
    let title: String
    let detail: String
    let occurredAt: Date
    let destination: Destination

    init?(id: String, ownerID: String, source: Source, title: String, detail: String = "",
          occurredAt: Date = Date(), outcome: Outcome = .information, destination: Destination) {
        guard !id.isEmpty, id.utf16.count <= 256, !ownerID.isEmpty,
              !id.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              occurredAt.timeIntervalSince1970.isFinite else { return nil }
        let targetID: String
        switch destination {
        case .task(let value), .run(let value), .agenda(let value), .pomodoro(let value), .external(let value): targetID = value
        case .clipboard(let value): targetID = value.uuidString
        case .history: return nil // Queue summaries create this destination.
        }
        guard !targetID.isEmpty, targetID.utf16.count <= 256,
              !targetID.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
        // An external sender cannot borrow an internal navigation identity.
        if source.isExternal {
            guard case .external = destination else { return nil }
        } else if case .external = destination { return nil }
        // Clipboard feedback cannot impersonate a task/Agent result, nor can
        // another source acquire the clipboard navigation route.
        if source == .clipboard {
            guard case .clipboard = destination, outcome == .information else { return nil }
        } else if case .clipboard = destination { return nil }
        let cleanedTitle = Self.displayText(title, limit: 160)
        guard !cleanedTitle.isEmpty else { return nil }
        self.id = id; self.ownerID = ownerID; self.source = source; self.outcome = outcome
        self.title = cleanedTitle; self.detail = Self.displayText(detail, limit: 240)
        self.occurredAt = occurredAt; self.destination = destination
    }

    private static func displayText(_ text: String, limit: Int) -> String {
        let visible = text.unicodeScalars.filter { scalar in
            !CharacterSet.controlCharacters.contains(scalar) &&
            !(0x202A...0x202E).contains(scalar.value) && !(0x2066...0x2069).contains(scalar.value)
        }
        return String(String.UnicodeScalarView(visible)).split(whereSeparator: \.isWhitespace)
            .joined(separator: " ").prefix(limit).description
    }
}

struct NativeQuickNotificationItem: Identifiable, Equatable {
    let id: String
    var events: [NativeQuickNotificationEvent]
    var isSummary: Bool { events.count > 1 }
    var destination: NativeQuickNotificationEvent.Destination {
        isSummary ? .history(events.map(\.id)) : events[0].destination
    }
}

/// TO-DO Panel's FIFO/hover semantics adapted to a monotonic native clock.
/// Reference: main.js:572–868 at 1deb3cac1e32599f13b1d6b30a7e52af76f67efd
/// (MIT; attribution in docs/licenses/to-do-panel-MIT.txt).
/// Owners supply committed events and revalidate navigation independently.
@MainActor final class NativeQuickNotificationQueue: ObservableObject {
    enum Phase: Equatable { case idle, entering, visible, leaving }
    enum EnqueueResult: Equatable { case accepted, duplicate, wrongOwner, full }
    static let entryDuration: TimeInterval = 0.26
    static let visibleDuration: TimeInterval = 6
    static let exitDuration: TimeInterval = 0.32
    static let contentDelay: TimeInterval = 0.09
    static let waitingSlotLimit = 5
    static let retainedEventLimit = 200
    static let historyLimit = 20

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var current: NativeQuickNotificationItem?
    @Published private(set) var pendingEventCount = 0
    @Published private(set) var history: [NativeQuickNotificationEvent] = []
    @Published private(set) var isActivating = false
    @Published private(set) var activationFailed = false
    @Published private(set) var reducedMotion = false
    private(set) var ownerID: String
    private(set) var generation: UInt64 = 0
    private(set) var presentationAllowed = true
    private var waiting: [NativeQuickNotificationItem] = []
    private var seen: [String: TimeInterval] = [:]
    private var hovering = false
    private var accessibilityFocused = false
    private var remaining: TimeInterval = 0
    private var countdownStartedAt: TimeInterval?
    private var wake: Task<Void, Never>?
    private let now: () -> TimeInterval
    private let schedulesTimers: Bool
    var isPaused: Bool { !presentationAllowed || (phase == .visible && (hovering || accessibilityFocused || isActivating)) }
    var remainingVisibleTime: TimeInterval {
        guard phase == .visible else { return Self.visibleDuration }
        return max(0, remaining - (countdownStartedAt.map { max(0, now() - $0) } ?? 0))
    }

    init(ownerID: String, now: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }, schedulesTimers: Bool = true) {
        self.ownerID = ownerID; self.now = now; self.schedulesTimers = schedulesTimers
    }
    deinit { wake?.cancel() }

    @discardableResult func enqueue(_ event: NativeQuickNotificationEvent) -> EnqueueResult {
        guard event.ownerID == ownerID else { return .wrongOwner }
        let instant = now()
        seen = seen.filter { instant - $0.value < 86_400 }
        guard seen[event.id] == nil,
              current?.events.contains(where: { $0.id == event.id }) != true,
              !waiting.contains(where: { $0.events.contains(where: { $0.id == event.id }) }) else { return .duplicate }
        guard pendingEventCount + (current?.events.count ?? 0) < Self.retainedEventLimit else { return .full }
        seen[event.id] = instant
        if seen.count > 1024, let oldest = seen.min(by: { $0.value < $1.value })?.key { seen.removeValue(forKey: oldest) }
        history.insert(event, at: 0)
        if history.count > Self.historyLimit { history.removeLast(history.count - Self.historyLimit) }
        if waiting.count < Self.waitingSlotLimit {
            waiting.append(.init(id: event.id, events: [event]))
        } else {
            // Retain each accepted event's destination; don't replace mixed
            // deadline/Agent/timer updates with a fictitious "tasks completed".
            waiting[waiting.count - 1].events.append(event)
        }
        publishCount()
        if current == nil { showNext() }
        return .accepted
    }

    func setHovering(_ value: Bool) {
        guard hovering != value else { return }
        freezeCountdown(); hovering = value; schedule()
    }
    func setAccessibilityFocused(_ value: Bool) {
        guard accessibilityFocused != value else { return }
        freezeCountdown(); accessibilityFocused = value; schedule()
    }
    func setPresentationAllowed(_ value: Bool) {
        guard presentationAllowed != value else { return }
        freezeCountdown(); presentationAllowed = value
        if value, current == nil { showNext() } else { schedule() }
    }
    func setReducedMotion(_ value: Bool) {
        guard reducedMotion != value else { return }
        reducedMotion = value
        if value, phase == .entering || phase == .leaving { finishTransition(generation: generation) }
    }

    /// Resolve summary IDs before acknowledging navigation; the receiver can
    /// retain this small event list while the toast moves to the next item.
    func events(for identifiers: [String]) -> [NativeQuickNotificationEvent] {
        let candidates = (current?.events ?? []) + waiting.flatMap(\.events) + history
        var byID: [String: NativeQuickNotificationEvent] = [:]
        for event in candidates where byID[event.id] == nil { byID[event.id] = event }
        return identifiers.compactMap { byID[$0] }
    }

    /// Access can be withdrawn while a public notification is queued (for
    /// example, moving its conversation into a private project). Drop those
    /// copied titles and destinations immediately, not just on a global lock.
    func removeEvents(where shouldRemove: (NativeQuickNotificationEvent) -> Bool) {
        guard history.contains(where: shouldRemove) || current?.events.contains(where: shouldRemove) == true ||
              waiting.contains(where: { $0.events.contains(where: shouldRemove) }) else { return }
        history.removeAll(where: shouldRemove)
        waiting = waiting.compactMap { item in
            let retained = item.events.filter { !shouldRemove($0) }
            return retained.isEmpty ? nil : .init(id: item.id, events: retained)
        }
        publishCount()
        guard let item = current else { return }
        let retained = item.events.filter { !shouldRemove($0) }
        guard retained.count != item.events.count else { return }
        if !retained.isEmpty { current = .init(id: item.id, events: retained); return }
        wake?.cancel(); wake = nil; generation &+= 1
        current = nil; phase = .idle; countdownStartedAt = nil; remaining = 0
        hovering = false; accessibilityFocused = false; isActivating = false; activationFailed = false
        showNext()
    }

    /// Used by the timer and by an animation completion, both scoped to the
    /// same generation. Late callbacks cannot close a newer notification.
    func finishTransition(generation expected: UInt64) {
        guard expected == generation, presentationAllowed else { return }
        switch phase {
        case .entering: transition(to: .visible, duration: Self.visibleDuration)
        case .leaving:
            wake?.cancel(); wake = nil; countdownStartedAt = nil
            current = nil; phase = .idle; remaining = 0
            showNext()
        case .idle, .visible: break
        }
    }
    func tick() {
        guard !isPaused, countdownStartedAt != nil else { return }
        freezeCountdown()
        guard remaining <= 0 else { schedule(); return }
        if phase == .visible { dismissCurrent() }
        else { finishTransition(generation: generation) }
    }
    func dismissCurrent() {
        guard current != nil, phase != .leaving else { return }
        transition(to: .leaving, duration: reducedMotion ? 0 : Self.exitDuration)
        if reducedMotion { finishTransition(generation: generation) }
    }

    func activateCurrent(using operation: @MainActor (NativeQuickNotificationEvent.Destination) async -> Bool) async {
        guard let item = current, phase == .visible, !isActivating, presentationAllowed else { return }
        freezeCountdown(); isActivating = true; activationFailed = false; schedule()
        let expected = generation, owner = ownerID
        let opened = await operation(item.destination)
        guard ownerID == owner, current?.id == item.id, generation == expected else { return }
        isActivating = false
        if opened { dismissCurrent() }
        else { activationFailed = true; schedule() }
    }

    /// Call on workspace switch, privacy lock or shutdown; not on each snapshot.
    /// Keeps no copied business records or cross-owner navigation capabilities.
    func reset(ownerID: String) {
        wake?.cancel(); wake = nil; generation &+= 1
        self.ownerID = ownerID; current = nil; waiting = []; history = []; seen = [:]
        pendingEventCount = 0; phase = .idle; remaining = 0; countdownStartedAt = nil
        hovering = false; accessibilityFocused = false; isActivating = false; activationFailed = false
    }
    private func showNext() {
        guard presentationAllowed, current == nil, !waiting.isEmpty else { return }
        current = waiting.removeFirst(); publishCount()
        hovering = false; accessibilityFocused = false; isActivating = false; activationFailed = false
        transition(to: reducedMotion ? .visible : .entering,
                   duration: reducedMotion ? Self.visibleDuration : Self.entryDuration)
    }
    private func publishCount() { pendingEventCount = waiting.reduce(0) { $0 + $1.events.count } }
    private func transition(to phase: Phase, duration: TimeInterval) {
        wake?.cancel(); wake = nil; generation &+= 1
        self.phase = phase; remaining = duration; countdownStartedAt = nil; schedule()
    }
    private func freezeCountdown() {
        if let start = countdownStartedAt { remaining = max(0, remaining - max(0, now() - start)) }
        countdownStartedAt = nil; wake?.cancel(); wake = nil
    }
    private func schedule() {
        wake?.cancel(); wake = nil
        guard phase != .idle, !isPaused else { countdownStartedAt = nil; return }
        countdownStartedAt = now()
        guard schedulesTimers else { return }
        let token = generation, delay = max(0.001, remaining)
        wake = Task { @MainActor [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) } catch { return }
            guard let self, !Task.isCancelled, self.generation == token else { return }
            self.tick()
        }
    }
}
