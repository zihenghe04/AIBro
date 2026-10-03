import Foundation
import Darwin

/// Only local notification preferences and one-shot hashes are persisted here.
/// Task bodies, titles, status and dates remain owned by the main workspace.
struct NativeQuickTaskReminderReceipt: Codable, Equatable {
    let fingerprint: String
    let cutoff: Date
    let claimedAt: Date
}
struct NativeQuickTaskReminderArchiveState: Codable {
    var version = 1
    var enabled = false
    var receipts: [NativeQuickTaskReminderReceipt] = []
}
enum NativeQuickTaskReminderError: Error { case invalid, unsafePath, writeFailed, capacity }
final class NativeQuickTaskReminderGate: @unchecked Sendable {
    private let lock = NSLock()
    private var valid = true
    func revoke() { lock.lock(); valid = false; lock.unlock() }
    func commit<T>(_ operation: () throws -> T) throws -> T {
        lock.lock(); defer { lock.unlock() }
        guard valid else { throw CancellationError() }
        return try operation()
    }
}

actor NativeQuickTaskReminderArchive {
    private let directory: URL
    private var cached: NativeQuickTaskReminderArchiveState?
    private let encoder = JSONEncoder(), decoder = JSONDecoder()
    private static let limit = 4096
    private static let byteLimit = 1024 * 1024
    init(directory: URL) {
        self.directory = directory.deletingLastPathComponent().resolvingSymlinksInPath()
            .appendingPathComponent(directory.lastPathComponent, isDirectory: true)
    }
    func load() throws -> NativeQuickTaskReminderArchiveState {
        if let cached { return cached }
        let directoryFD = try openDirectory(); defer { close(directoryFD) }
        let fd = openat(directoryFD, "reminders.json", O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        if fd < 0 {
            guard errno == ENOENT else { throw NativeQuickTaskReminderError.unsafePath }
            let empty = NativeQuickTaskReminderArchiveState(); cached = empty; return empty
        }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_nlink == 1,
              info.st_size >= 0, info.st_size <= Self.byteLimit else { throw NativeQuickTaskReminderError.unsafePath }
        var bytes = Data(count: Int(info.st_size))
        try bytes.withUnsafeMutableBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let count = Darwin.read(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                guard count > 0 else { throw NativeQuickTaskReminderError.invalid }; offset += count
            }
        }
        let state = try decoder.decode(NativeQuickTaskReminderArchiveState.self, from: bytes)
        guard state.version == 1, state.receipts.count <= Self.limit,
              Set(state.receipts.map(\.fingerprint)).count == state.receipts.count,
              state.receipts.allSatisfy(Self.valid) else { throw NativeQuickTaskReminderError.invalid }
        cached = state; return state
    }
    func setEnabled(_ enabled: Bool, gate: NativeQuickTaskReminderGate) throws -> NativeQuickTaskReminderArchiveState {
        var next = try load(); next.enabled = enabled; return try save(next, gate: gate)
    }
    /// Commit before enqueue: a crash after this acknowledgement cannot replay
    /// the reminder on restart. This is an attempt receipt, never proof of sight.
    func claim(_ receipt: NativeQuickTaskReminderReceipt, gate: NativeQuickTaskReminderGate) throws -> (state: NativeQuickTaskReminderArchiveState, inserted: Bool) {
        guard Self.valid(receipt) else { throw NativeQuickTaskReminderError.invalid }
        var next = try load()
        guard next.enabled else { throw NativeQuickTaskReminderError.invalid }
        if next.receipts.contains(where: { $0.fingerprint == receipt.fingerprint }) { return (next, false) }
        // Keep two days beyond cutoff so ordinary clock/time-zone changes do
        // not replay a recent all-day reminder. Never evict a live deadline.
        next.receipts.removeAll { $0.cutoff.addingTimeInterval(2 * 86400) < receipt.claimedAt }
        guard next.receipts.count < Self.limit else { throw NativeQuickTaskReminderError.capacity }
        next.receipts.append(receipt)
        return (try save(next, gate: gate), true)
    }
    /// Only a known rejected enqueue may release its own receipt. Other writes
    /// and older attempts with the same fingerprint are not rolled back.
    func release(_ receipt: NativeQuickTaskReminderReceipt, gate: NativeQuickTaskReminderGate) throws -> NativeQuickTaskReminderArchiveState {
        var next = try load(); next.receipts.removeAll { $0 == receipt }
        return try save(next, gate: gate)
    }
    private static func valid(_ receipt: NativeQuickTaskReminderReceipt) -> Bool {
        receipt.fingerprint.count == 64 && receipt.fingerprint.allSatisfy { $0.isASCII && "0123456789abcdef".contains($0) }
            && receipt.cutoff.timeIntervalSince1970.isFinite && receipt.claimedAt.timeIntervalSince1970.isFinite
    }
    private func openDirectory() throws -> Int32 {
        if !FileManager.default.fileExists(atPath: directory.path) {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
        let fd = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw NativeQuickTaskReminderError.unsafePath }
        guard fchmod(fd, 0o700) == 0 else { close(fd); throw NativeQuickTaskReminderError.writeFailed }
        return fd
    }
    private func save(_ state: NativeQuickTaskReminderArchiveState, gate: NativeQuickTaskReminderGate) throws -> NativeQuickTaskReminderArchiveState {
        let bytes = try encoder.encode(state)
        guard bytes.count <= Self.byteLimit else { throw NativeQuickTaskReminderError.capacity }
        let directoryFD = try openDirectory(); defer { close(directoryFD) }
        let temporary = ".pending-" + UUID().uuidString
        let fd = openat(directoryFD, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw NativeQuickTaskReminderError.writeFailed }
        defer { close(fd); unlinkat(directoryFD, temporary, 0) }
        try bytes.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let count = Darwin.write(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                guard count > 0 else { throw NativeQuickTaskReminderError.writeFailed }; offset += count
            }
        }
        guard fsync(fd) == 0 else { throw NativeQuickTaskReminderError.writeFailed }
        try gate.commit {
            guard renameat(directoryFD, temporary, directoryFD, "reminders.json") == 0 else { throw NativeQuickTaskReminderError.writeFailed }
        }
        cached = state; return state
    }
}
