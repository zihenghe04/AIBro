import Foundation

/// The extension commits manifest.json last. Uncommitted folders may remain after
/// interruption, but must never hide later committed shares or be acknowledged.
struct SharedInbox {
    let root: URL
    private let maximumBytes = 32 * 1024 * 1024

    private func failure() -> NSError {
        NSError(domain: "AI Bro share", code: 1, userInfo: [NSLocalizedDescriptionKey: "分享资料不完整，原件仍保留"])
    }

    func nextItem() throws -> [String: Any]? {
        let manager = FileManager.default
        guard manager.fileExists(atPath: root.path) else { return nil }
        let folders = try manager.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        for folder in folders {
            guard UUID(uuidString: folder.lastPathComponent) != nil else { continue }
            let values = try folder.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard values.isDirectory == true, values.isSymbolicLink != true else { continue }
            let manifest = folder.appendingPathComponent("manifest.json")
            // A share that has not committed is not an empty inbox.
            guard manager.fileExists(atPath: manifest.path) else { continue }
            let metadata = try manifest.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
            guard metadata.isRegularFile == true, metadata.isSymbolicLink != true,
                  (metadata.fileSize ?? Int.max) <= 1024 * 1024,
                  var item = try JSONSerialization.jsonObject(with: Data(contentsOf: manifest)) as? [String: Any],
                  let descriptors = item["files"] as? [[String: Any]], descriptors.count <= 12 else { throw failure() }
            var files: [[String: Any]] = []
            var total = 0
            for descriptor in descriptors {
                guard let path = descriptor["path"] as? String, !path.isEmpty,
                      !path.contains("/"), !path.contains("\\"), !path.contains("\0"),
                      path != ".", path != "..", path != "manifest.json" else { throw failure() }
                let url = folder.appendingPathComponent(path)
                let metadata = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .isSymbolicLinkKey])
                guard metadata.isRegularFile == true, metadata.isSymbolicLink != true,
                      let size = metadata.fileSize, size <= maximumBytes - total else { throw failure() }
                let data = try Data(contentsOf: url)
                total += data.count
                guard total <= maximumBytes else { throw failure() }
                var file = descriptor
                file["data"] = data.base64EncodedString()
                files.append(file)
            }
            item["id"] = folder.lastPathComponent
            item["files"] = files
            return item
        }
        return nil
    }

    func acknowledge(_ id: String) throws {
        guard UUID(uuidString: id) != nil else { throw failure() }
        let folder = root.appendingPathComponent(id)
        // A retry after a lost bridge response must remain successful.
        guard FileManager.default.fileExists(atPath: folder.path) else { return }
        try FileManager.default.removeItem(at: folder)
    }
}
