import Foundation

/// The recorder publishes elapsed time and meter level at 10 Hz. Neither is a
/// search input. Keep one exact, view-owned projection instead of rescanning
/// every saved transcript several times during each meter-driven body update.
enum NativeQuickRecordingProjection {
    struct Result {
        var items: [NativeQuickRecordingItem] = []
        var categories: [String] = []
        var activeCount = 0
    }

    @MainActor final class Cache {
        private struct Input: Equatable {
            let owner: ObjectIdentifier
            let items: [NativeQuickRecordingItem]
            let query: String
            let showingDeleted: Bool
            let category: String?
        }
        private var input: Input?
        private var result = Result()
        private(set) var rebuildCount = 0

        func clear() { input = nil; result = Result() }

        func resolve(owner: ObjectIdentifier, available: Bool, items: [NativeQuickRecordingItem],
                     query: String, showingDeleted: Bool, category: String?) -> Result {
            guard available else { clear(); return result }
            let next = Input(owner: owner, items: items,
                             query: query.trimmingCharacters(in: .whitespacesAndNewlines),
                             showingDeleted: showingDeleted, category: category)
            if input == next { return result }
            // Swift's copy-on-write arrays/strings retain exact values without
            // serializing or copying transcript bytes. Comparing all fields
            // also detects in-place changes with unchanged IDs/timestamps.
            let inCollection = items.filter { ($0.deletedAt != nil) == showingDeleted }
            let matching = inCollection.filter {
                (category == nil || ($0.category ?? "") == category) &&
                    (next.query.isEmpty || $0.title.localizedCaseInsensitiveContains(next.query)
                     || $0.transcript.localizedCaseInsensitiveContains(next.query))
            }
            result = Result(items: matching,
                categories: Array(Set(inCollection.compactMap(\.category))).sorted { $0.localizedStandardCompare($1) == .orderedAscending },
                activeCount: items.reduce(0) { $0 + ($1.deletedAt == nil ? 1 : 0) })
            input = next; rebuildCount += 1
            return result
        }
    }
}
