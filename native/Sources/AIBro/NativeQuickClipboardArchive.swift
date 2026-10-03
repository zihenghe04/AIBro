import Foundation
import ImageIO
import UniformTypeIdentifiers
import Darwin

/// This folder is a local, unsynced native feature store. It never creates
/// workspace records, resolves arbitrary file URLs, or uploads clipboard data.
actor NativeQuickClipboardArchive {
    private let directory: URL
    private var state: NativeQuickClipboardState?
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private let maxManifestBytes = 8 * 1024 * 1024
    private let diskLimit: Int
    init(directory: URL, diskLimit: Int = NativeQuickClipboardPolicy.maxDiskBytes) {
        self.diskLimit = min(NativeQuickClipboardPolicy.maxDiskBytes, max(1024, diskLimit))
        self.directory = directory.deletingLastPathComponent().resolvingSymlinksInPath()
            .appendingPathComponent(directory.lastPathComponent, isDirectory: true)
    }
    func load() throws -> NativeQuickClipboardState {
        if let state { return state }
        let fd = try openDirectory(); defer { close(fd) }
        guard let data = try read("history.json", max: maxManifestBytes, at: fd) else {
            let empty = NativeQuickClipboardState(); state = empty; return empty
        }
        let loaded = try decoder.decode(NativeQuickClipboardState.self, from: data)
        guard loaded.version == 1, loaded.retentionPolicy.valid, loaded.items.count <= NativeQuickClipboardPolicy.maxItems,
              Set(loaded.items.map(\.id)).count == loaded.items.count else { throw NativeQuickClipboardError.corrupt }
        for item in loaded.items {
            guard validID(item.id), item.bytes >= 0, item.createdAt.timeIntervalSince1970.isFinite else { throw NativeQuickClipboardError.corrupt }
            if let deletedAt = item.deletedAt, !deletedAt.timeIntervalSince1970.isFinite { throw NativeQuickClipboardError.corrupt }
            if let deletionID = item.deletionID, UUID(uuidString: deletionID) == nil { throw NativeQuickClipboardError.corrupt }
            if item.kind == .text {
                guard let text = item.text, text.utf8.count == item.bytes, item.bytes <= NativeQuickClipboardPolicy.maxTextBytes,
                      NativeQuickClipboardPolicy.fingerprint(.init(kind: .text, data: Data(text.utf8))) == item.id else { throw NativeQuickClipboardError.corrupt }
            } else {
                guard item.text == nil, item.bytes <= NativeQuickClipboardPolicy.maxImageBytes,
                      let width = item.width, let height = item.height, width > 0, height > 0,
                      width <= 20000, height <= 20000, width * height <= 20_000_000 else { throw NativeQuickClipboardError.corrupt }
            }
        }
        guard estimatedDisk(loaded, manifest: data) <= diskLimit else { throw NativeQuickClipboardError.corrupt }
        state = loaded
        let pruned = try bounded(loaded)
        if pruned.items != loaded.items { return try commit(pruned, fd: fd) }
        cleanup(keeping: loaded, at: fd)
        return loaded
    }
    func setMode(_ mode: NativeQuickClipboardMode) throws -> NativeQuickClipboardState {
        var next = try load(); next.mode = mode; return try commit(next)
    }
    func capture(_ payload: NativeQuickClipboardPayload, gate: NativeQuickClipboardCaptureGate) throws -> NativeQuickClipboardState {
        var next = try load()
        guard next.mode == .recording else { return next }
        let canonical: NativeQuickClipboardPayload
        var thumbnail: Data?, width: Int?, height: Int?
        if payload.kind == .text {
            guard payload.data.count <= NativeQuickClipboardPolicy.maxTextBytes,
                  let text = String(data: payload.data, encoding: .utf8), !text.isEmpty,
                  !NativeQuickClipboardPolicy.sensitiveText(text) else { throw NativeQuickClipboardError.unsupported }
            canonical = payload
        } else {
            let image = try Self.normalizeImage(payload.data)
            canonical = .init(kind: .image, data: image.png); thumbnail = image.thumbnail; width = image.width; height = image.height
        }
        let id = NativeQuickClipboardPolicy.fingerprint(canonical)
        let favorite = next.items.first(where: { $0.id == id })?.favorite
        next.items.removeAll { $0.id == id }
        next.items.insert(.init(id: id, kind: canonical.kind,
            text: canonical.kind == .text ? String(data: canonical.data, encoding: .utf8) : nil,
            bytes: canonical.data.count, width: width, height: height, createdAt: Date(), deletedAt: nil, favorite: favorite), at: 0)
        // Only a successful NEW capture enforces an explicitly applied policy.
        // Loading, copying, restoring and changing a favorite never immediately
        // remove a restored item. Existing hard storage limits still apply.
        if next.retention != nil {
            next = softRetained(next, policy: next.retentionPolicy, at: Date())
        }
        next = try bounded(next, protecting: [id])
        let fd = try openDirectory(); defer { close(fd) }
        do {
            return try gate.commit {
            if canonical.kind == .image {
                try write(canonical.data, name: id + ".png", at: fd)
                if let thumbnail { try write(thumbnail, name: id + ".jpg", at: fd) }
            }
            return try commit(next, fd: fd)
            }
        } catch {
            cleanup(keeping: try load(), at: fd)
            throw error
        }
    }
    func remove(ids: Set<String>, permanently: Bool, deletionID: String = UUID().uuidString, now: Date = Date(), gate: NativeQuickClipboardCaptureGate? = nil) throws -> NativeQuickClipboardState {
        var next = try load()
        guard UUID(uuidString: deletionID) != nil, now.timeIntervalSince1970.isFinite else { throw NativeQuickClipboardError.corrupt }
        if permanently { next.items.removeAll { ids.contains($0.id) && $0.deletedAt != nil } }
        else {
            for index in next.items.indices where ids.contains(next.items[index].id) && next.items[index].deletedAt == nil {
                next.items[index].deletedAt = now; next.items[index].deletionID = deletionID
            }
        }
        return try commit(next, gate: gate)
    }
    func setFavorite(id: String, favorite: Bool, gate: NativeQuickClipboardCaptureGate? = nil) throws -> NativeQuickClipboardState {
        var next = try load()
        guard let index = next.items.firstIndex(where: { $0.id == id && $0.deletedAt == nil }) else { throw NativeQuickClipboardError.corrupt }
        next.items[index].favorite = favorite ? true : nil
        return try commit(next, gate: gate)
    }
    func previewRetention(_ policy: NativeQuickClipboardRetention, now: Date = Date()) throws -> NativeQuickClipboardRetentionPreview {
        guard policy.valid, now.timeIntervalSince1970.isFinite else { throw NativeQuickClipboardError.corrupt }
        let current = try load(), candidates = policy.candidates(in: current.items, at: now)
        return .init(policy: policy, stamp: try current.retentionStamp(), at: now, ids: Set(candidates.map(\.id)),
                     bytes: candidates.reduce(0) { $0 + $1.bytes }, totalBytes: current.items.reduce(0) { $0 + $1.bytes },
                     favoriteCount: current.items.filter { $0.deletedAt == nil && $0.isFavorite }.count)
    }
    func applyRetention(_ preview: NativeQuickClipboardRetentionPreview, now: Date = Date(), gate: NativeQuickClipboardCaptureGate) throws -> NativeQuickClipboardRetentionResult {
        let current = try load()
        guard preview.policy.valid, preview.at.timeIntervalSince1970.isFinite, now.timeIntervalSince1970.isFinite,
              try current.retentionStamp() == preview.stamp,
              Set(preview.policy.candidates(in: current.items, at: preview.at).map(\.id)) == preview.ids else { throw NativeQuickClipboardError.retentionChanged }
        let deletionID = UUID().uuidString
        // The frozen preview's cutoff wins: a long-open dialog never sweeps in
        // a newly expired item that the user did not review.
        var next = current; next.retention = preview.policy == .legacy ? nil : preview.policy
        for index in next.items.indices where preview.ids.contains(next.items[index].id) {
            next.items[index].deletedAt = now; next.items[index].deletionID = deletionID
        }
        // No implicit quota eviction during explicit policy changes. If the
        // added metadata cannot fit, keep the old policy and every item intact.
        next = try commit(next, gate: gate, protecting: Set(current.items.map(\.id)))
        return .init(state: next, receipt: .init(previousPolicy: current.retention,
            previousItems: current.items.filter { preview.ids.contains($0.id) }, afterStamp: try next.retentionStamp(), deletionID: deletionID, at: now))
    }
    func undoRetention(_ receipt: NativeQuickClipboardRetentionReceipt, now: Date = Date(), gate: NativeQuickClipboardCaptureGate) throws -> NativeQuickClipboardState {
        var next = try load()
        guard now < receipt.at.addingTimeInterval(NativeQuickClipboardPolicy.undoLifetime),
              try next.retentionStamp() == receipt.afterStamp else { throw NativeQuickClipboardError.retentionChanged }
        let fd = try openDirectory(); defer { close(fd) }
        for item in receipt.previousItems where item.kind == .image { try verifyImage(item, at: fd) }
        let previous = Dictionary(uniqueKeysWithValues: receipt.previousItems.map { ($0.id, $0) })
        next.items = next.items.map { previous[$0.id] ?? $0 }; next.retention = receipt.previousPolicy
        return try commit(next, fd: fd, gate: gate, protecting: Set(next.items.map(\.id)))
    }
    private func softRetained(_ source: NativeQuickClipboardState, policy: NativeQuickClipboardRetention, at now: Date) -> NativeQuickClipboardState {
        var next = source; let ids = Set(policy.candidates(in: next.items, at: now).map(\.id))
        for index in next.items.indices where ids.contains(next.items[index].id) {
            // Automatic maintenance has no five-second user undo receipt. Do
            // not protect old Trash ahead of newer live history at the hard cap.
            next.items[index].deletedAt = now; next.items[index].deletionID = nil
        }
        return next
    }
    func undoDeletion(ids: Set<String>, deletionID: String, now: Date = Date(), gate: NativeQuickClipboardCaptureGate? = nil) throws -> NativeQuickClipboardUndoResult {
        var next = try load()
        let indices = next.items.indices.filter { index in
            let item = next.items[index]
            guard ids.contains(item.id), item.deletionID == deletionID, let deletedAt = item.deletedAt else { return false }
            return now < deletedAt.addingTimeInterval(NativeQuickClipboardPolicy.undoLifetime)
        }
        guard !indices.isEmpty else { throw NativeQuickClipboardError.undoUnavailable }
        // Restoring a reference to a missing/changed original would falsely
        // promise undo. Validate every selected image before committing any.
        let fd = try openDirectory(); defer { close(fd) }
        for index in indices where next.items[index].kind == .image { try verifyImage(next.items[index], at: fd) }
        let restoredIDs = Set(indices.map { next.items[$0].id })
        for index in indices { next.items[index].deletedAt = nil; next.items[index].deletionID = nil }
        return .init(state: try commit(next, fd: fd, gate: gate), restoredIDs: restoredIDs)
    }
    func restore(ids: Set<String>, gate: NativeQuickClipboardCaptureGate? = nil) throws -> NativeQuickClipboardState {
        var next = try load()
        for index in next.items.indices where ids.contains(next.items[index].id) { next.items[index].deletedAt = nil; next.items[index].deletionID = nil }
        return try commit(next, gate: gate)
    }
    func payload(id: String) throws -> NativeQuickClipboardPayload {
        guard let item = try load().items.first(where: { $0.id == id && $0.deletedAt == nil }), validID(id) else { throw NativeQuickClipboardError.corrupt }
        if item.kind == .text, let text = item.text { return .init(kind: .text, data: Data(text.utf8)) }
        let fd = try openDirectory(); defer { close(fd) }
        guard let data = try read(id + ".png", max: NativeQuickClipboardPolicy.maxImageBytes, at: fd), data.count == item.bytes,
              NativeQuickClipboardPolicy.fingerprint(.init(kind: .image, data: data)) == id else { throw NativeQuickClipboardError.corrupt }
        return .init(kind: .image, data: data)
    }
    func thumbnail(id: String) throws -> Data? {
        guard validID(id), try load().items.contains(where: { $0.id == id && $0.kind == .image }) else { return nil }
        let fd = try openDirectory(); defer { close(fd) }
        return try read(id + ".jpg", max: 64 * 1024, at: fd)
    }
    /// Reads the same verified original as Copy, not the 240px history thumbnail.
    /// Only one fitted image is decoded; it never becomes an archive-wide cache.
    func preview(id: String) throws -> NativeQuickClipboardPreviewPayload {
        try Task.checkCancellation()
        let original = try payload(id: id)
        if original.kind == .text {
            guard original.data.count <= NativeQuickClipboardPolicy.maxTextBytes,
                  let text = String(data: original.data, encoding: .utf8) else { throw NativeQuickClipboardError.corrupt }
            return .init(text: text, image: nil)
        }
        guard original.data.count <= NativeQuickClipboardPolicy.maxImageBytes,
              let source = CGImageSourceCreateWithData(original.data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              CGImageSourceGetCount(source) == 1,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 20000, height <= 20000, width * height <= 20_000_000,
              let item = try load().items.first(where: { $0.id == id }), item.width == width, item.height == height,
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: NativeQuickClipboardPreviewPayload.maximumImageEdge,
                kCGImageSourceShouldCacheImmediately: true] as CFDictionary) else { throw NativeQuickClipboardError.corrupt }
        try Task.checkCancellation()
        return .init(text: nil, image: image)
    }
    private func bounded(_ source: NativeQuickClipboardState, protecting protectedIDs: Set<String> = []) throws -> NativeQuickClipboardState {
        var result = source
        let now = Date(), expiry = now.addingTimeInterval(-7 * 24 * 60 * 60)
        result.items.removeAll { !protectedIDs.contains($0.id) && ($0.deletedAt.map { $0 < expiry } ?? false) }
        while !result.items.isEmpty {
            let data = try encoder.encode(result)
            if result.items.count <= NativeQuickClipboardPolicy.maxItems,
               data.count <= maxManifestBytes, estimatedDisk(result, manifest: data) <= diskLimit { break }
            // Active favorites and the five-second undo window are protected.
            // Outside that window, Trash is evicted first, then the oldest live
            // nonfavorite. Never evict the incoming item and report it saved.
            let index = result.items.lastIndex(where: { item in
                guard !protectedIDs.contains(item.id), let deletedAt = item.deletedAt else { return false }
                return item.deletionID == nil || now >= deletedAt.addingTimeInterval(NativeQuickClipboardPolicy.undoLifetime)
            }) ?? result.items.lastIndex(where: { !protectedIDs.contains($0.id) && $0.deletedAt == nil && !$0.isFavorite })
            guard let index else { throw NativeQuickClipboardError.protectedCapacity }
            result.items.remove(at: index)
        }
        return result
    }
    private func estimatedDisk(_ state: NativeQuickClipboardState, manifest: Data) -> Int {
        manifest.count + state.items.filter { $0.kind == .image }.reduce(0) { $0 + $1.bytes + 64 * 1024 }
    }
    private func commit(_ source: NativeQuickClipboardState, fd existing: Int32? = nil, gate: NativeQuickClipboardCaptureGate? = nil, protecting protectedIDs: Set<String> = []) throws -> NativeQuickClipboardState {
        let next = try bounded(source, protecting: protectedIDs), data = try encoder.encode(next)
        let fd = try existing ?? openDirectory(); defer { if existing == nil { close(fd) } }
        try write(data, name: "history.json", at: fd, gate: gate)
        state = next; cleanup(keeping: next, at: fd)
        return next
    }
    private func openDirectory() throws -> Int32 {
        let manager = FileManager.default
        if !manager.fileExists(atPath: directory.path) {
            try manager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
        let fd = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw NativeQuickClipboardError.unsafePath }
        guard fchmod(fd, 0o700) == 0 else { close(fd); throw NativeQuickClipboardError.writeFailed }
        return fd
    }
    private func read(_ name: String, max limit: Int, at directoryFD: Int32) throws -> Data? {
        let fd = openat(directoryFD, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        if fd < 0 { if errno == ENOENT { return nil }; throw NativeQuickClipboardError.unsafePath }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_nlink == 1,
              info.st_size >= 0, info.st_size <= limit else { throw NativeQuickClipboardError.unsafePath }
        var data = Data(count: Int(info.st_size)), offset = 0
        try data.withUnsafeMutableBytes { buffer in
            while offset < buffer.count {
                let count = Darwin.read(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                guard count > 0 else { throw NativeQuickClipboardError.corrupt }; offset += count
            }
        }
        return data
    }
    private func write(_ data: Data, name: String, at directoryFD: Int32, gate: NativeQuickClipboardCaptureGate? = nil) throws {
        let temp = ".pending-" + UUID().uuidString
        let fd = openat(directoryFD, temp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw NativeQuickClipboardError.writeFailed }
        defer { close(fd); unlinkat(directoryFD, temp, 0) }
        try data.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let count = Darwin.write(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                guard count > 0 else { throw NativeQuickClipboardError.writeFailed }; offset += count
            }
        }
        guard fsync(fd) == 0 else { throw NativeQuickClipboardError.writeFailed }
        let rename = { guard renameat(directoryFD, temp, directoryFD, name) == 0 else { throw NativeQuickClipboardError.writeFailed } }
        if let gate { try gate.commit(rename) } else { try rename() }
    }
    private func verifyImage(_ item: NativeQuickClipboardItem, at fd: Int32) throws {
        guard validID(item.id), let data = try read(item.id + ".png", max: NativeQuickClipboardPolicy.maxImageBytes, at: fd),
              data.count == item.bytes, NativeQuickClipboardPolicy.fingerprint(.init(kind: .image, data: data)) == item.id else { throw NativeQuickClipboardError.corrupt }
    }
    private func cleanup(keeping state: NativeQuickClipboardState, at fd: Int32) {
        let keep = Set(state.items.filter { $0.kind == .image }.flatMap { [$0.id + ".png", $0.id + ".jpg"] })
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path) else { return }
        for name in names {
            let ext = (name as NSString).pathExtension, id = (name as NSString).deletingPathExtension
            if ((ext == "png" || ext == "jpg") && validID(id) && !keep.contains(name)) || name.hasPrefix(".pending-") {
                unlinkat(fd, name, 0)
            }
        }
    }
    private func validID(_ value: String) -> Bool { value.count == 64 && value.allSatisfy { $0.isASCII && ("0123456789abcdef".contains($0)) } }
    private static func normalizeImage(_ bytes: Data) throws -> (png: Data, thumbnail: Data, width: Int, height: Int) {
        guard bytes.count <= NativeQuickClipboardPolicy.maxInputImageBytes,
              let source = CGImageSourceCreateWithData(bytes as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              CGImageSourceGetCount(source) >= 1, CGImageSourceGetCount(source) <= 16,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 20000, height <= 20000, width * height <= 20_000_000,
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: max(width, height)] as CFDictionary) else { throw NativeQuickClipboardError.unsupported }
        let png = NSMutableData()
        guard let target = CGImageDestinationCreateWithData(png, UTType.png.identifier as CFString, 1, nil) else { throw NativeQuickClipboardError.unsupported }
        CGImageDestinationAddImage(target, image, nil)
        guard CGImageDestinationFinalize(target), png.length <= NativeQuickClipboardPolicy.maxImageBytes else { throw NativeQuickClipboardError.tooLarge }
        guard let thumb = CGImageSourceCreateThumbnailAtIndex(source, 0, [
            kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 240] as CFDictionary) else { throw NativeQuickClipboardError.unsupported }
        let thumbnail = NSMutableData()
        guard let thumbTarget = CGImageDestinationCreateWithData(thumbnail, UTType.jpeg.identifier as CFString, 1, nil) else { throw NativeQuickClipboardError.unsupported }
        CGImageDestinationAddImage(thumbTarget, thumb, [kCGImageDestinationLossyCompressionQuality: 0.75] as CFDictionary)
        guard CGImageDestinationFinalize(thumbTarget), thumbnail.length <= 64 * 1024 else { throw NativeQuickClipboardError.tooLarge }
        return (png as Data, thumbnail as Data, image.width, image.height)
    }
}
