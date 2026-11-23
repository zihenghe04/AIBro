import Foundation

/// Plain-text trace of the dictate-at-cursor chain (permission, key events,
/// recording, transcription, insertion). It lives in the data folder so a
/// tester can send it back. It records states and counts, never dictated text.
final class NativeDictateLog: @unchecked Sendable {
    static let shared = NativeDictateLog()
    private let queue = DispatchQueue(label: "ai-bro.dictate-log")
    private var url: URL?
    private let limit = 256 * 1024

    func configure(folder: URL) {
        queue.sync {
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let file = folder.appendingPathComponent("dictate-debug.log")
            if let size = (try? FileManager.default.attributesOfItem(atPath: file.path)[.size] as? Int), size > limit {
                try? FileManager.default.removeItem(at: file)
            }
            url = file
        }
    }

    var path: String? { queue.sync { url?.path } }

    func write(_ event: String) {
        let stamp = Self.formatter.string(from: Date())
        queue.async { [self] in
            guard let url, let data = "\(stamp) \(event)\n".data(using: .utf8) else { return }
            if let handle = try? FileHandle(forWritingTo: url) {
                defer { try? handle.close() }
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: data)
            } else {
                try? data.write(to: url)
            }
        }
    }

    private static let formatter: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"; return f
    }()
}

func dictateLog(_ event: @autoclosure () -> String) { NativeDictateLog.shared.write(event()) }
