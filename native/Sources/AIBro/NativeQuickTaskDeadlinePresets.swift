import Foundation
import Darwin

/// Local input preferences, never a new task collection or a reminder policy.
enum NativeQuickTaskDeadlineDefault: String, CaseIterable {
    case none, nextEvening, tomorrowEvening

    func deadline(now: Date, calendar: Calendar) -> NativeQuickTaskDate? {
        switch self {
        case .none: return nil
        case .nextEvening:
            let today = NativeQuickTaskDeadlinePreset.today.deadline(now: now, calendar: calendar)
            return today ?? NativeQuickTaskDeadlinePreset.tomorrow.deadline(now: now, calendar: calendar)
        case .tomorrowEvening:
            return NativeQuickTaskDeadlinePreset.tomorrow.deadline(now: now, calendar: calendar)
        }
    }
}

enum NativeQuickTaskDeadlinePreset: CaseIterable {
    case today, tomorrow, week, none

    func deadline(now: Date, calendar: Calendar) -> NativeQuickTaskDate? {
        guard now.timeIntervalSince1970.isFinite else { return nil }
        let days: Int
        switch self { case .today: days = 0; case .tomorrow: days = 1; case .week: days = 7; case .none: return nil }
        // Calendar arithmetic, not +86400: keep local 23:30 over DST/month/year boundaries.
        guard let day = calendar.date(byAdding: .day, value: days, to: calendar.startOfDay(for: now)),
              let date = calendar.date(bySettingHour: 23, minute: 30, second: 0, of: day,
                                       matchingPolicy: .nextTime, repeatedTimePolicy: .first, direction: .forward),
              date > now else { return nil }
        return .time(date)
    }
}

final class NativeQuickTaskDeadlinePreferences: @unchecked Sendable {
    private struct Envelope: Codable { let version: Int; let value: String }
    private let directory: URL?
    private let queue = DispatchQueue(label: "dev.aibro.task-deadline-preference", qos: .utility)
    private let beforeWrite: @Sendable () throws -> Void
    static var defaultDirectory: URL? {
        guard let bundle = Bundle.main.bundleIdentifier,
              let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
        return base.appendingPathComponent(bundle, isDirectory: true).appendingPathComponent("QuickTools/TaskDefaults", isDirectory: true)
    }
    init(directory: URL? = defaultDirectory, beforeWrite: @escaping @Sendable () throws -> Void = {}) {
        self.directory = directory; self.beforeWrite = beforeWrite
    }
    func load() async throws -> NativeQuickTaskDeadlineDefault {
        try await perform {
            guard let directory = self.directory else { return .none }
            let file = directory.appendingPathComponent("deadline.json")
            var info = stat()
            guard lstat(file.path, &info) == 0 else {
                if errno == ENOENT { return .none }; throw CocoaError(.fileReadUnknown)
            }
            guard info.st_mode & S_IFMT == S_IFREG, info.st_size <= 512 else { throw CocoaError(.fileReadCorruptFile) }
            let value = try JSONDecoder().decode(Envelope.self, from: Data(contentsOf: file))
            guard value.version == 1, let result = NativeQuickTaskDeadlineDefault(rawValue: value.value) else { throw CocoaError(.fileReadCorruptFile) }
            return result
        }
    }
    func save(_ value: NativeQuickTaskDeadlineDefault) async throws {
        try await perform {
            guard let directory = self.directory else { throw CocoaError(.fileNoSuchFile) }
            try self.beforeWrite()
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            let fd = Darwin.open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
            guard fd >= 0 else { throw CocoaError(.fileWriteUnknown) }
            defer { Darwin.close(fd) }
            let temporary = ".deadline-" + UUID().uuidString.lowercased()
            let output = openat(fd, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
            guard output >= 0 else { throw CocoaError(.fileWriteUnknown) }
            defer { Darwin.close(output); unlinkat(fd, temporary, 0) }
            let data = try JSONEncoder().encode(Envelope(version: 1, value: value.rawValue))
            try data.withUnsafeBytes { buffer in
                var offset = 0
                while offset < buffer.count {
                    let count = Darwin.write(output, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                    if count < 0 && errno == EINTR { continue }
                    guard count > 0 else { throw CocoaError(.fileWriteUnknown) }; offset += count
                }
            }
            guard fsync(output) == 0, renameat(fd, temporary, fd, "deadline.json") == 0, fsync(fd) == 0 else { throw CocoaError(.fileWriteUnknown) }
        }
    }
    private func perform<T>(_ body: @escaping () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            queue.async { do { continuation.resume(returning: try body()) } catch { continuation.resume(throwing: error) } }
        }
    }
}
