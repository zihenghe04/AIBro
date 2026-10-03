import Foundation
import Combine
import Darwin

/// Local files are requests, not a second task database. An immutable journal
/// precedes every call into the existing durable task bridge. Only its ACK can
/// advance a row or archive the original bytes.
@MainActor final class NativeTaskInbox: ObservableObject {
    @Published private(set) var directoryURL: URL?
    @Published private(set) var error: String?
    @Published private(set) var lastReport: Report?
    private var command: (([String: Any]) async throws -> [String: Any])?
    private var available = false
    private var scanning = false
    private var polling: Task<Void, Never>?
    private var emptyDirectoryStamp: String?
    private let automaticallyPoll: Bool
    private let now: () -> Date
    private let timeZone: () -> TimeZone

    struct Report: Codable {
        let version: Int
        let file: String
        let hash: String
        let processedAt: Date
        let status: String
        let imported: [NativeTaskInboxParser.Entry]
        let skipped: [NativeTaskInboxParser.Issue]
        let warnings: [NativeTaskInboxParser.Issue]
        let error: String?
        var summary: [String: Int] { ["imported": imported.count, "skipped": skipped.count, "warnings": warnings.count] }
    }
    private struct Journal: Codable {
        let version: Int
        let file: String
        let original: Data
        let parsed: NativeTaskInboxParser.Parsed
        let archiveID: String
        var next: Int
        var imported: [NativeTaskInboxParser.Entry]
        var skipped: [NativeTaskInboxParser.Issue]
        let createdAt: Date
    }
    init(automaticallyPoll: Bool = true, now: @escaping () -> Date = Date.init, timeZone: @escaping () -> TimeZone = { .current }) {
        self.automaticallyPoll = automaticallyPoll; self.now = now; self.timeZone = timeZone
    }
    deinit { polling?.cancel() }

    func configure(directory: URL, command: @escaping ([String: Any]) async throws -> [String: Any]) {
        let next = directory.resolvingSymlinksInPath().appendingPathComponent("todo-inbox", isDirectory: true)
        guard directoryURL == nil || directoryURL == next else {
            setAvailable(false); self.command = nil
            error = "任务收件箱属于另一个工作区；未切换导入目录。"; return
        }
        directoryURL = next; self.command = command
    }
    func setAvailable(_ value: Bool) {
        guard available != value else { return }
        available = value
        if !value { polling?.cancel(); polling = nil; return }
        guard automaticallyPoll, polling == nil else { return }
        polling = Task { [weak self] in
            while !Task.isCancelled {
                await self?.scan()
                do { try await Task.sleep(nanoseconds: 2_000_000_000) } catch { break }
            }
        }
    }
    /// A discoverable menu action can reveal this one fixed directory. It never
    /// accepts a caller-supplied filename or reads another folder.
    @discardableResult func ensureDirectory() -> URL? {
        guard available, command != nil, let directoryURL else {
            error = "当前工作区尚未就绪或处于私密模式，任务收件箱暂停。"; return nil
        }
        do { let disk = try NativeTaskInboxDisk(directoryURL); try disk.prepare(); try disk.writeGuideIfMissing(); error = nil; return directoryURL }
        catch { self.error = "无法打开任务收件箱。请检查工作区目录权限；原文件未改动。"; return nil }
    }

    func scan() async {
        guard available, !scanning, let directoryURL, let command else { return }
        scanning = true; defer { scanning = false }
        do {
            let disk = try NativeTaskInboxDisk(directoryURL); try disk.prepare()
            let stamp = try disk.stamp()
            if emptyDirectoryStamp == stamp { return }
            let names = try disk.candidates()
            emptyDirectoryStamp = names.isEmpty ? stamp : nil
            var budget = 20
            for name in names {
                guard available, !Task.isCancelled, budget > 0 else { break }
                do {
                    guard let original = try disk.readCandidate(name, settledBefore: now().addingTimeInterval(-1)) else { continue }
                    let digest = NativeTaskInboxParser.hash(original)
                    let journalName = NativeTaskInboxParser.hash(Data(name.utf8)) + ".json"
                    var journal: Journal
                    if let saved = try disk.readState(journalName) {
                        guard let decoded = try? JSONDecoder().decode(Journal.self, from: saved), decoded.version == 1,
                              UUID(uuidString: decoded.archiveID) != nil,
                              decoded.file == name, decoded.parsed.hash == NativeTaskInboxParser.hash(decoded.original),
                              (0...decoded.parsed.entries.count).contains(decoded.next) else {
                            error = "任务收件箱恢复记录损坏；原文件和恢复记录均已保留。"; continue
                        }
                        if decoded.parsed.hash != digest {
                            // A producer replaced a file while a previous request
                            // was in flight. Preserve its snapshot and progress;
                            // do not quietly import the rest of the old request.
                            try disk.writeRecovery(journalName, saved)
                            try disk.removeState(journalName)
                            journal = makeJournal(name, original)
                        } else { journal = decoded }
                    } else { journal = makeJournal(name, original) }
                    try disk.writeState(journalName, JSONEncoder().encode(journal))
                    if journal.parsed.error == nil {
                        while journal.next < journal.parsed.entries.count && budget > 0 && available && !Task.isCancelled {
                            let entry = journal.parsed.entries[journal.next]
                            // Catch replacement before each side effect, including
                            // when scanning resumes after another application's edit.
                            guard try disk.matches(name, digest) else { break }
                            let receipt = try await command(entry.payload)
                            budget -= 1
                            if receipt["status"] as? String == "saved", receipt["id"] as? String == entry.id {
                                if receipt["alreadyExists"] as? Bool == true {
                                    journal.skipped.append(.init(index: entry.index, id: entry.sourceID, reason: "id 已存在，原任务未修改"))
                                } else { journal.imported.append(entry) }
                            } else if receipt["status"] as? String == "error", let reason = receipt["reason"] as? String,
                                      ["invalid", "removed", "collision", "changed"].contains(reason) {
                                journal.skipped.append(.init(index: entry.index, id: entry.sourceID, reason: reason == "invalid" ? "工作区、项目归属或日期无效；未导入" : "id 已存在、已删除或发生冲突；原任务未修改"))
                            } else {
                                error = "任务导入尚未确认保存，原文件已保留，工作区恢复后会重试同一条任务。"
                                break
                            }
                            journal.next += 1
                            try disk.writeState(journalName, JSONEncoder().encode(journal))
                            await Task.yield()
                        }
                    }
                    guard journal.next == journal.parsed.entries.count || journal.parsed.error != nil else { continue }
                    let skipped = journal.parsed.skipped + journal.skipped
                    let report = Report(version: 1, file: name, hash: digest, processedAt: now(),
                                        status: journal.parsed.error != nil ? "rejected" : journal.imported.isEmpty ? "none" : skipped.isEmpty ? "imported" : "partial",
                                        imported: journal.imported, skipped: skipped, warnings: journal.parsed.warnings, error: journal.parsed.error)
                    let encoder = JSONEncoder(); encoder.dateEncodingStrategy = .iso8601
                    var object = try JSONSerialization.jsonObject(with: encoder.encode(report)) as! [String: Any]
                    object["summary"] = report.summary
                    let reportData = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
                    try disk.archive(name, data: journal.original, hash: digest, stem: journal.archiveID, report: reportData)
                    try disk.removeState(journalName)
                    lastReport = report; error = nil
                } catch NativeTaskInboxDisk.Failure.tooLarge {
                    // Never read an oversized file just to hash it. The sidecar
                    // is ignored by the scanner and leaves all original bytes.
                    let message = "文件超过 1 MiB 上限，原文件未导入。"
                    try? disk.writeSidecar(name, message: message)
                    error = message
                } catch NativeTaskInboxDisk.Failure.unsafeFile {
                    error = "任务收件箱只读取当前用户拥有的普通文件；链接、目录和特殊文件已忽略。"
                } catch {
                    self.error = "任务收件箱暂未完成；原文件和恢复记录已保留，下次会继续核对同一请求。"
                }
            }
        } catch { self.error = "任务收件箱不可用；未读取工作区之外的文件。" }
    }
    private func makeJournal(_ name: String, _ data: Data) -> Journal {
        Journal(version: 1, file: name, original: data, parsed: NativeTaskInboxParser.parse(data, now: now(), timeZone: timeZone()), archiveID: UUID().uuidString.lowercased(), next: 0, imported: [], skipped: [], createdAt: now())
    }
}

/// All I/O below the trusted workspace is relative to a held directory fd.
/// O_NOFOLLOW, ownership and link-count checks prevent inbox symlinks/hardlinks
/// from turning an append-only integration into an arbitrary file reader.
private final class NativeTaskInboxDisk {
    enum Failure: Error { case io, unsafeFile, tooLarge, changed }
    let root: Int32
    private var state: Int32 = -1
    private var processed: Int32 = -1
    init(_ directory: URL) throws {
        let parent = Darwin.open(directory.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard parent >= 0 else { throw Failure.io }; defer { Darwin.close(parent) }
        if mkdirat(parent, "todo-inbox", 0o700) != 0 && errno != EEXIST { throw Failure.io }
        root = openat(parent, "todo-inbox", O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard root >= 0 else { throw Failure.unsafeFile }
        var info = stat()
        guard fstat(root, &info) == 0, info.st_uid == geteuid() else { Darwin.close(root); throw Failure.unsafeFile }
    }
    deinit { Darwin.close(root); if state >= 0 { Darwin.close(state) }; if processed >= 0 { Darwin.close(processed) } }
    func prepare() throws { state = try subdirectory(".state"); processed = try subdirectory("processed") }
    private func subdirectory(_ name: String) throws -> Int32 {
        if mkdirat(root, name, 0o700) != 0 && errno != EEXIST { throw Failure.io }
        let fd = openat(root, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard fd >= 0 else { throw Failure.unsafeFile }
        var info = stat(); guard fstat(fd, &info) == 0, info.st_uid == geteuid() else { Darwin.close(fd); throw Failure.unsafeFile }
        return fd
    }
    func stamp() throws -> String {
        var value = stat(); guard fstat(root, &value) == 0 else { throw Failure.io }
        return "\(value.st_ino):\(value.st_mtimespec.tv_sec):\(value.st_mtimespec.tv_nsec)"
    }
    func candidates() throws -> [String] {
        guard let directory = fdopendir(dup(root)) else { throw Failure.io }; defer { closedir(directory) }
        var names: [String] = []
        while let row = readdir(directory) {
            let name = withUnsafePointer(to: &row.pointee.d_name) { $0.withMemoryRebound(to: CChar.self, capacity: Int(row.pointee.d_namlen) + 1) { String(cString: $0) } }
            if !name.hasPrefix("."), name.lowercased().hasSuffix(".json"), !name.lowercased().hasSuffix(".report.json") { names.append(name) }
        }
        return names.sorted()
    }
    func readCandidate(_ name: String, settledBefore: Date) throws -> Data? { try read(root, name, limit: NativeTaskInboxParser.maximumBytes, settledBefore: settledBefore) }
    func readState(_ name: String) throws -> Data? { try read(state, name, limit: 4 * NativeTaskInboxParser.maximumBytes) }
    private func read(_ directory: Int32, _ name: String, limit: Int, settledBefore: Date? = nil) throws -> Data? {
        let fd = openat(directory, name, O_RDONLY | O_NONBLOCK | O_NOFOLLOW)
        if fd < 0 { if errno == ENOENT { return nil }; throw Failure.unsafeFile }; defer { Darwin.close(fd) }
        var before = stat(); guard fstat(fd, &before) == 0 else { throw Failure.io }
        guard before.st_mode & S_IFMT == S_IFREG, before.st_uid == geteuid(), before.st_nlink == 1 else { throw Failure.unsafeFile }
        if let settledBefore, Double(before.st_mtimespec.tv_sec) + Double(before.st_mtimespec.tv_nsec) / 1e9 > settledBefore.timeIntervalSince1970 { return nil }
        guard before.st_size <= limit else { throw Failure.tooLarge }
        var result = Data(), buffer = [UInt8](repeating: 0, count: 16_384)
        while true {
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count < 0 { if errno == EINTR { continue }; throw Failure.io }
            if count == 0 { break }
            guard result.count + count <= limit else { throw Failure.tooLarge }
            result.append(contentsOf: buffer.prefix(count))
        }
        var after = stat(), path = stat()
        guard fstat(fd, &after) == 0, fstatat(directory, name, &path, AT_SYMLINK_NOFOLLOW) == 0,
              before.st_ino == path.st_ino, before.st_dev == path.st_dev, before.st_size == after.st_size,
              before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec, before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
              before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec, before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec,
              result.count == after.st_size else { throw Failure.changed }
        return result
    }
    func matches(_ name: String, _ hash: String) throws -> Bool { try read(root, name, limit: NativeTaskInboxParser.maximumBytes).map { NativeTaskInboxParser.hash($0) == hash } ?? false }
    func writeState(_ name: String, _ data: Data) throws { try write(state, name, data) }
    func writeRecovery(_ name: String, _ data: Data) throws { try write(state, "recovery-\(UUID().uuidString)-\(name)", data) }
    func removeState(_ name: String) throws { guard unlinkat(state, name, 0) == 0 || errno == ENOENT, fsync(state) == 0 else { throw Failure.io } }
    func writeSidecar(_ name: String, message: String) throws {
        let bytes = try JSONSerialization.data(withJSONObject: ["version": 1, "file": name, "status": "rejected", "error": message, "originalRetained": true], options: [.sortedKeys])
        let reportName = name.utf8.count + 12 <= 255 ? name + ".report.json" : "error-" + NativeTaskInboxParser.hash(Data(name.utf8)) + ".report.json"
        if let prior = try read(root, reportName, limit: 4096), prior == bytes { return }
        try write(root, reportName, bytes)
    }
    func writeGuideIfMissing() throws {
        var existing = stat()
        if fstatat(root, "README.txt", &existing, AT_SYMLINK_NOFOLLOW) == 0 { return }
        guard errno == ENOENT else { throw Failure.io }
        let guide = """
        AI Bro · 任务收件箱 / Task inbox

        本机脚本或 Agent 将 UTF-8 JSON 放进此文件夹即可追加待办，不会执行任务文字，也不会修改或删除已有任务。
        Write UTF-8 JSON here to append tasks. Text is never executed; existing tasks are never updated or deleted.
        先写 .tmp，再改名为 .json；App 就绪时每 2 秒检查，文件需静置 1 秒。不要在 processed/ 或 .state/ 中写入请求。
        Write a temporary file, then rename it to .json. The ready app polls every 2 seconds, after a 1-second settling period.

        {"todos":[{"id":"example-reading-1","text":"整理合成课件的三个要点","category":"P2","deadline":"2030-10-15T18:00:00+08:00","workspace":"课程"}]}

        顶层也可直接使用数组。单文件最多 1 MiB / 200 条；text 最多 80 个 UTF-16 字符。
        category 使用 P0–P3：P0/P1→高，P2→中，P3→低，原分类随任务保留。
        可在顶层 categoryNames 提供显示名映射，例如 {"P0":"紧急","P1":"重要","P2":"常规","P3":"稍后"}。
        deadline 接受 ISO 时间、毫秒时间戳、仅日期；仅日期或省略时按本地当天/指定日期 23:30。
        workspace 为 日常 / 课程 / 科研，默认日常；可选 projectId 必须是该空间现有公开项目的准确 ID，不会猜当前项目。
        id 可省略，由文件内容与序号生成稳定 ID；显式 id 推荐保留，重复文件/ID 不会更新或复活已删除任务。

        Arrays are also supported. Limit: 1 MiB / 200 rows, 80 UTF-16 units per text.
        P0/P1 map to high priority, P2 to medium, P3 to low; the original category is retained.
        Dates accept ISO strings or milliseconds. Date-only/missing deadlines use local 23:30.
        workspace defaults to 日常. Optional projectId must belong to that exact workspace; no current-project guessing.
        Explicit IDs are recommended for stable deduplication. No task is executed by this import.

        保存确认后，原文件完整归档到 processed/，同时生成 .report.json（imported/partial/none/rejected）。
        日期/分类等坏条目单独跳过；超大文件留在原处并写 .report.json。保存未确认时原文件不移动，稍后重试同一 ID。
        .state/ 保存断点；recovery-* 保留在文件被外部替换时的原请求，不会静默丢弃。请勿在导入中删除 .state/。
        After durable acknowledgement, processed/ contains exact original bytes and the report. Bad rows are skipped individually.
        Oversized inputs stay in place with a report. Unconfirmed saves retain the input and retry the same identity.
        .state/ holds restart checkpoints and recovery snapshots; do not remove it during an import.
        """
        let temporary = ".guide-" + UUID().uuidString
        defer { unlinkat(root, temporary, 0) }
        try write(root, temporary, Data(guide.utf8))
        guard linkat(root, temporary, root, "README.txt", 0) == 0 || errno == EEXIST else { throw Failure.io }
        guard fsync(root) == 0 else { throw Failure.io }
    }
    private func write(_ directory: Int32, _ name: String, _ data: Data) throws {
        let temporary = ".write-" + UUID().uuidString
        let fd = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw Failure.io }
        defer { Darwin.close(fd); unlinkat(directory, temporary, 0) }
        try data.withUnsafeBytes { bytes in
            var count = 0
            while count < bytes.count {
                let written = Darwin.write(fd, bytes.baseAddress!.advanced(by: count), bytes.count - count)
                if written < 0 && errno == EINTR { continue }
                guard written > 0 else { throw Failure.io }; count += written
            }
        }
        guard fsync(fd) == 0, renameat(directory, temporary, directory, name) == 0, fsync(directory) == 0 else { throw Failure.io }
    }
    func archive(_ name: String, data: Data, hash: String, stem: String, report: Data) throws {
        // Keep the exact acknowledged input even if its producer rewrites the
        // source during the final rename. No user data is deleted on mismatch.
        try write(processed, stem + ".json", data)
        try write(processed, stem + ".report.json", report)
        guard try matches(name, hash) else { return }
        let claim = "recovery-" + UUID().uuidString + ".json"
        guard renameat(root, name, processed, claim) == 0 else { throw Failure.io }
        let moved = try? read(processed, claim, limit: NativeTaskInboxParser.maximumBytes)
        if moved == data {
            guard unlinkat(processed, claim, 0) == 0 else { throw Failure.io }
        } else {
            // linkat never overwrites a newly arrived source. If occupied, the
            // raced bytes remain visibly recoverable under processed/recovery-.
            if linkat(processed, claim, root, name, 0) == 0 { _ = unlinkat(processed, claim, 0) }
            throw Failure.changed
        }
        guard fsync(root) == 0, fsync(processed) == 0 else { throw Failure.io }
    }
}
