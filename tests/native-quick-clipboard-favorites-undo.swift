import AppKit
import SwiftUI
import ImageIO
import UniformTypeIdentifiers
func nativeUI(_ zh: String, _ en: String) -> String { en }
@MainActor final class FavoritesBoard: NativeQuickClipboardPasteboard {
    var changeCount = 0; var types: [String] = []; var reads = 0
    func data(forType type: String) -> Data? { reads += 1; return nil }
    func write(_ payload: NativeQuickClipboardPayload) -> Bool { false }
}
@main struct ClipboardFavoritesUndoChecks {
    @MainActor static func main() async throws {
        _ = NSApplication.shared; NSApp.setActivationPolicy(.prohibited)
        let root = URL(fileURLWithPath: CommandLine.arguments[1])
        var checks = 0
        func check(_ pass: Bool, _ label: String) { precondition(pass, label); checks += 1 }
        func wait(_ predicate: () -> Bool) async {
            for _ in 0..<300 { if predicate() { return }; try? await Task.sleep(nanoseconds: 5_000_000) }
            precondition(predicate(), "Timed out")
        }
        func payload(_ text: String) -> NativeQuickClipboardPayload { .init(kind: .text, data: Data(text.utf8)) }
        func captured(_ archive: NativeQuickClipboardArchive, _ text: String) async throws -> NativeQuickClipboardItem {
            try await archive.capture(payload(text), gate: .init()).items.first { $0.text == text }!
        }
        let folder = root.appendingPathComponent("history"), archive = NativeQuickClipboardArchive(directory: folder)
        _ = try await archive.setMode(.recording)
        let a = try await captured(archive, "Synthetic course A"), b = try await captured(archive, "Synthetic favorite B"), c = try await captured(archive, "Earlier trash C")
        check(!a.isFavorite, "Existing/new records default to unstarred")
        _ = try await archive.setFavorite(id: b.id, favorite: true)
        check(try await NativeQuickClipboardArchive(directory: folder).load().items.first { $0.id == b.id }!.isFavorite, "Favorite survives real reload")
        check(try await captured(archive, "Synthetic favorite B").isFavorite, "Deduplicated recopy retains favorite")
        check(try await archive.load().items.count == 3, "Recopy retains one identity and total budget")
        let now = Date(), oldID = UUID().uuidString, deletionID = UUID().uuidString
        _ = try await archive.remove(ids: [c.id], permanently: false, deletionID: oldID, now: now.addingTimeInterval(-10))
        let deleted = try await archive.remove(ids: [a.id, b.id, c.id], permanently: false, deletionID: deletionID, now: now)
        check(deleted.items.first { $0.id == c.id }!.deletionID == oldID, "Clear does not re-tag older trash")
        let undone = try await archive.undoDeletion(ids: [a.id, b.id, c.id], deletionID: deletionID, now: now.addingTimeInterval(1)).state
        check(undone.items.filter { $0.deletedAt == nil }.count == 2 && undone.items.first { $0.id == c.id }!.deletedAt != nil, "Undo restores only the exact latest deletion")
        check(undone.items.first { $0.id == b.id }!.isFavorite && undone.items.map(\.id) == deleted.items.map(\.id), "Undo preserves favorite and original ordering")
        let nextID = UUID().uuidString
        _ = try await archive.remove(ids: [a.id, b.id], permanently: false, deletionID: nextID)
        _ = try await archive.remove(ids: [a.id], permanently: true)
        let partialResult = try await archive.undoDeletion(ids: [a.id, b.id], deletionID: nextID), partial = partialResult.state
        check(!partial.items.contains { $0.id == a.id } && partial.items.first { $0.id == b.id }!.deletedAt == nil, "Undo never resurrects a permanently deleted entry")
        check(partialResult.restoredIDs == [b.id], "Undo ACK names only the exact restored subset")
        let recopyID = UUID().uuidString
        _ = try await archive.restore(ids: [c.id])
        _ = try await archive.remove(ids: [b.id, c.id], permanently: false, deletionID: recopyID)
        _ = try await captured(archive, "Synthetic favorite B")
        let afterRecopy = try await archive.undoDeletion(ids: [b.id, c.id], deletionID: recopyID)
        check(afterRecopy.restoredIDs == [c.id] && afterRecopy.state.items.first { $0.id == b.id }!.isFavorite, "Recopied active item is not falsely counted as restored or overwritten by undo")
        let newestID = UUID().uuidString
        _ = try await archive.remove(ids: [b.id], permanently: false, deletionID: newestID)
        do { _ = try await archive.undoDeletion(ids: [b.id], deletionID: nextID); fatalError("Stale deletion must not restore a later delete") }
        catch NativeQuickClipboardError.undoUnavailable { checks += 1 }
        let oldBytes = try Data(contentsOf: folder.appendingPathComponent("history.json")), revoked = NativeQuickClipboardCaptureGate(); revoked.revoke()
        do { _ = try await archive.undoDeletion(ids: [b.id], deletionID: newestID, gate: revoked); fatalError("Revoked undo must fail") }
        catch is CancellationError { checks += 1 }
        check(try Data(contentsOf: folder.appendingPathComponent("history.json")) == oldBytes, "Revoked commit leaves durable deletion unchanged")
        _ = try await archive.restore(ids: [b.id])
        do { _ = try await archive.setFavorite(id: b.id, favorite: false, gate: revoked); fatalError("Revoked favorite must fail") }
        catch is CancellationError { checks += 1 }
        check(try await archive.load().items.first { $0.id == b.id }!.isFavorite, "Failed favorite commit retains memory and disk state")

        let quotaFolder = root.appendingPathComponent("quota"), quota = NativeQuickClipboardArchive(directory: quotaFolder)
        _ = try await quota.setMode(.recording)
        var protected = Set<String>()
        for index in 0..<100 {
            let entry = try await captured(quota, "Entry \(index)")
            if index > 0 { _ = try await quota.setFavorite(id: entry.id, favorite: true); protected.insert(entry.id) }
        }
        let incoming = try await captured(quota, "Newest ordinary entry")
        let full = try await quota.load()
        check(full.items.count == 100 && full.items.filter(\.isFavorite).count == 99 && protected.isSubset(of: Set(full.items.map(\.id))), "100-entry eviction preserves every active favorite")
        check(!full.items.contains { $0.text == "Entry 0" }, "Oldest nonfavorite is evicted before any favorite")
        _ = try await quota.setFavorite(id: incoming.id, favorite: true)
        let fullBytes = try Data(contentsOf: quotaFolder.appendingPathComponent("history.json"))
        do { _ = try await captured(quota, "Cannot fit without losing a favorite"); fatalError("Protected full archive must reject new content") }
        catch NativeQuickClipboardError.protectedCapacity { checks += 1 }
        check(try Data(contentsOf: quotaFolder.appendingPathComponent("history.json")) == fullBytes, "Quota rejection is atomic and not a fake saved result")
        let recentID = UUID().uuidString
        _ = try await quota.remove(ids: [incoming.id], permanently: false, deletionID: recentID)
        do { _ = try await captured(quota, "Cannot evict the visible undo"); fatalError("Five-second undo must remain available") }
        catch NativeQuickClipboardError.protectedCapacity { checks += 1 }
        _ = try await quota.undoDeletion(ids: [incoming.id], deletionID: recentID)
        check(try await quota.load().items.first { $0.id == incoming.id }!.isFavorite, "Protected undo restores a favorite at full capacity")
        let diskFolder = root.appendingPathComponent("disk-quota"), small = NativeQuickClipboardArchive(directory: diskFolder, diskLimit: 2048)
        _ = try await small.setMode(.recording)
        let large = try await captured(small, String(repeating: "a", count: 900)); _ = try await small.setFavorite(id: large.id, favorite: true)
        do { _ = try await captured(small, String(repeating: "b", count: 900)); fatalError("Byte budget must include favorites") }
        catch NativeQuickClipboardError.protectedCapacity { checks += 1 }
        check(try await small.load().items.map(\.id) == [large.id], "Byte-limit rejection retains the favorite")

        // An actual synthetic PNG stays present through soft delete and undo;
        // losing its original before undo must fail rather than restore a stub.
        let context = CGContext(data: nil, width: 80, height: 60, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(NSColor.systemTeal.cgColor); context.fill(CGRect(x: 0, y: 0, width: 80, height: 60))
        let bytes = NSMutableData(), target = CGImageDestinationCreateWithData(bytes, UTType.png.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(target, context.makeImage()!, nil); precondition(CGImageDestinationFinalize(target))
        let image = try await archive.capture(.init(kind: .image, data: bytes as Data), gate: .init()).items.first { $0.kind == .image }!
        let imageID = UUID().uuidString, imagePath = folder.appendingPathComponent(image.id + ".png")
        _ = try await archive.remove(ids: [image.id], permanently: false, deletionID: imageID)
        check(FileManager.default.fileExists(atPath: imagePath.path), "Soft delete retains original image for undo and Trash")
        _ = try await archive.undoDeletion(ids: [image.id], deletionID: imageID)
        check(try await archive.payload(id: image.id).data.count == image.bytes, "Restored image returns its original verified payload")
        let lostImageID = UUID().uuidString
        _ = try await archive.remove(ids: [image.id], permanently: false, deletionID: lostImageID)
        try FileManager.default.removeItem(at: imagePath)
        do { _ = try await archive.undoDeletion(ids: [image.id], deletionID: lostImageID); fatalError("Missing original must not become restored") }
        catch NativeQuickClipboardError.corrupt { checks += 1 }
        check(try await archive.load().items.first { $0.id == image.id }!.deletedAt != nil, "Unavailable image remains in trash without a false success")

        let storeFolder = root.appendingPathComponent("store"), seed = NativeQuickClipboardArchive(directory: storeFolder)
        _ = try await seed.setMode(.recording)
        let first = try await captured(seed, "Synthetic first note"), second = try await captured(seed, "Synthetic second note")
        _ = try await seed.setMode(.off)
        let board = FavoritesBoard(); var clock = Date()
        let store = NativeQuickClipboardStore(directory: storeFolder, pasteboard: board, schedulesPolling: false, now: { clock })
        store.setAvailable(true); store.setVisible(true); await wait { store.loaded && store.items.count == 2 }
        await store.toggleFavorite(first)
        store.filter = .favorites
        check(store.filteredItems.map(\.id) == [first.id], "Only-favorites uses the same stored items")
        store.query = "FIRST"; check(store.filteredItems.count == 1, "Search and favorites compose")
        store.query = "second"; check(store.filteredItems.isEmpty, "Favorites filter never leaks ordinary matches")
        store.query = ""; store.filter = .all
        await store.remove([first.id])
        check(store.deletionUndo?.ids == [first.id] && store.items.first { $0.id == first.id }!.deletedAt != nil, "Single-delete toast appears only after real save")
        await store.undoDeletion()
        check(store.deletionUndo == nil && store.items.first { $0.id == first.id }!.deletedAt == nil && store.items.first { $0.id == first.id }!.isFavorite, "Store undo completes against durable deletion receipt")
        await store.remove([first.id, second.id])
        check(store.deletionUndo?.ids.count == 2, "Clear exposes one exact batch undo")
        clock = clock.addingTimeInterval(6); await store.undoDeletion()
        check(store.deletionUndo == nil && store.items.allSatisfy { $0.deletedAt != nil }, "Expired quick undo cannot revive records; Trash remains")
        await store.restore([first.id, second.id]); clock = Date()
        await store.remove([first.id]); store.setAvailable(false)
        check(store.deletionUndo == nil && store.items.isEmpty, "Private transition immediately clears undo identity and content")
        store.setAvailable(true); await wait { store.items.count == 2 }
        check(store.deletionUndo == nil, "Unlock does not revive an expired/private undo bar")
        await store.restore([first.id])
        let manifest = storeFolder.appendingPathComponent("history.json")
        try FileManager.default.removeItem(at: manifest); try FileManager.default.createDirectory(at: manifest, withIntermediateDirectories: false)
        await store.toggleFavorite(first)
        check(store.items.first { $0.id == first.id }!.isFavorite && store.error != nil, "Failed favorite write does not optimistically report success")
        await store.remove([first.id])
        check(store.deletionUndo == nil && store.items.first { $0.id == first.id }!.deletedAt == nil && store.error != nil, "Failed deletion publishes no undo receipt")
        check(board.reads == 0 && store.mode == .off, "Favorites and undo never opt in or read the system clipboard")
        let host = NSHostingView(rootView: NativeQuickClipboardView(store: store))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 700, height: 400), styleMask: [.titled], backing: .buffered, defer: false)
        window.contentView = host; host.frame = window.contentLayoutRect; host.layoutSubtreeIfNeeded()
        check(host.fittingSize.width > 0 && host.fittingSize.height > 0, "Production favorites/undo view compiles and mounts in hidden window")
        store.shutdown()
        print("PASS: \(checks) new favorites/undo checks; native keyboard and visual animation remain unverified")
    }
}
