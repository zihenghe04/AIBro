import Foundation
import SQLite3

// Used on NativeDesktop's serial queue; lock also protects callers outside that queue.
// Independent of the WebView's ephemeral origin.
final class NativeVectorStore: @unchecked Sendable {
    enum Failure: Error { case invalidRecord, database(String) }
    private let file: URL
    private let lock = NSLock()
    private var database: OpaquePointer?
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    init(folder: URL) { file = folder.appendingPathComponent("vector-index.sqlite3") }
    deinit { if let database { sqlite3_close(database) } }

    private func open() throws -> OpaquePointer {
        if let database { return database }
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        var handle: OpaquePointer?
        guard sqlite3_open_v2(file.path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK, let handle else {
            if let handle { sqlite3_close(handle) }; throw Failure.database("无法打开本机向量索引")
        }
        database = handle
        do {
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
            sqlite3_busy_timeout(handle, 5000)
            try execute("CREATE TABLE IF NOT EXISTS vectors (profile TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY (profile, id))", on: handle)
            return handle
        } catch { sqlite3_close(handle); database = nil; throw error }
    }
    private func execute(_ sql: String, on db: OpaquePointer) throws {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw Failure.database("本机向量索引事务失败") }
    }
    private func statement(_ sql: String, on db: OpaquePointer) throws -> OpaquePointer {
        var value: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &value, nil) == SQLITE_OK, let value else { throw Failure.database("无法读取本机向量索引") }
        return value
    }
    private func bind(_ value: String, to stmt: OpaquePointer, at index: Int32) throws {
        guard sqlite3_bind_text(stmt, index, value, -1, transient) == SQLITE_OK else { throw Failure.invalidRecord }
    }
    private func validHash(_ value: String) -> Bool { value.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) } }
    private func validID(_ value: String) -> Bool { !value.isEmpty && value.utf8.count <= 4096 && !value.contains("\0") }

    func load(_ profile: String) throws -> [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        guard validHash(profile) else { throw Failure.invalidRecord }
        let db = try open(), stmt = try statement("SELECT record FROM vectors WHERE profile = ? ORDER BY id", on: db)
        defer { sqlite3_finalize(stmt) }; try bind(profile, to: stmt, at: 1)
        var result = [[String: Any]]()
        while true {
            let status = sqlite3_step(stmt)
            if status == SQLITE_DONE { return result }
            guard status == SQLITE_ROW, let bytes = sqlite3_column_text(stmt, 0), let record = try JSONSerialization.jsonObject(with: Data(String(cString: bytes).utf8)) as? [String: Any] else {
                throw Failure.database("本机向量索引内容损坏")
            }
            result.append(record)
        }
    }
    func write(_ profile: String, puts: [[String: Any]], removes: [String]) throws {
        lock.lock(); defer { lock.unlock() }
        guard validHash(profile), removes.allSatisfy(validID) else { throw Failure.invalidRecord }
        // Validate the entire batch before opening a write transaction; persist only index fields.
        let records: [(String, String)] = try puts.map { row in
            guard let id = row["id"] as? String, validID(id), let hash = row["hash"] as? String, validHash(hash),
                  let vector = row["vector"] as? [Double], !vector.isEmpty, vector.allSatisfy({ $0.isFinite }), vector.contains(where: { $0 != 0 }),
                  let updated = row["updatedAt"] as? Double, updated.isFinite, updated >= 0 else { throw Failure.invalidRecord }
            let bytes = try JSONSerialization.data(withJSONObject: ["id": id, "hash": hash, "vector": vector, "updatedAt": updated, "profile": profile])
            return (id, String(decoding: bytes, as: UTF8.self))
        }
        let db = try open()
        try execute("BEGIN IMMEDIATE", on: db)
        do {
            let deletion = try statement("DELETE FROM vectors WHERE profile = ? AND id = ?", on: db)
            defer { sqlite3_finalize(deletion) }
            for id in removes {
                sqlite3_reset(deletion); sqlite3_clear_bindings(deletion)
                try bind(profile, to: deletion, at: 1); try bind(id, to: deletion, at: 2)
                guard sqlite3_step(deletion) == SQLITE_DONE else { throw Failure.database("移除旧向量失败") }
            }
            let insertion = try statement("INSERT OR REPLACE INTO vectors (profile, id, record) VALUES (?, ?, ?)", on: db)
            defer { sqlite3_finalize(insertion) }
            for (id, record) in records {
                sqlite3_reset(insertion); sqlite3_clear_bindings(insertion)
                try bind(profile, to: insertion, at: 1); try bind(id, to: insertion, at: 2); try bind(record, to: insertion, at: 3)
                guard sqlite3_step(insertion) == SQLITE_DONE else { throw Failure.database("保存向量索引失败") }
            }
            try execute("COMMIT", on: db)
        } catch { try? execute("ROLLBACK", on: db); throw error }
    }
}
