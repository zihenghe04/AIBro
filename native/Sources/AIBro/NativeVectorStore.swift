import Foundation
import SQLite3

// Used on NativeDesktop's serial queue; lock also protects callers outside that queue.
// Independent of the WebView's ephemeral origin.
// Vectors are binary rows (Float32 when every value is exactly representable, else Float64),
// so status reads only id/hash and search returns scores instead of shipping vectors to the page.
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
            try execute("CREATE TABLE IF NOT EXISTS vector_rows (profile TEXT NOT NULL, id TEXT NOT NULL, hash TEXT NOT NULL, updated_at REAL NOT NULL, dimensions INTEGER NOT NULL, vector BLOB NOT NULL, PRIMARY KEY (profile, id))", on: handle)
            try execute("CREATE TABLE IF NOT EXISTS vector_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)", on: handle)
            try migrateLegacy(handle)
            return handle
        } catch { sqlite3_close(handle); database = nil; throw error }
    }
    // 0.9.6 and earlier stored each row as JSON text in `vectors`. That table is left untouched so an
    // older build opening the same folder keeps working; its fingerprint (row count, last rowid —
    // INSERT OR REPLACE always takes a new rowid) tells whether an older build changed it since.
    // On a change: copy the file aside, then convert in one transaction. Hash checks on every read
    // make the merge safe; unreadable rows are skipped and simply become pending again.
    private func legacyFingerprint(_ db: OpaquePointer) throws -> String? {
        let exists = try statement("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vectors'", on: db)
        let legacy = sqlite3_step(exists) == SQLITE_ROW; sqlite3_finalize(exists)
        guard legacy else { return nil }
        let stmt = try statement("SELECT count(*), coalesce(max(rowid), 0) FROM vectors", on: db)
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_ROW else { throw Failure.database("无法读取本机向量索引") }
        return "\(sqlite3_column_int64(stmt, 0)):\(sqlite3_column_int64(stmt, 1))"
    }
    private func migratedFingerprint(_ db: OpaquePointer) throws -> String? {
        let stmt = try statement("SELECT value FROM vector_meta WHERE key = 'legacy-fingerprint'", on: db)
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_ROW, let value = sqlite3_column_text(stmt, 0) else { return nil }
        return String(cString: value)
    }
    private func migrateLegacy(_ db: OpaquePointer) throws {
        guard let fingerprint = try legacyFingerprint(db), try fingerprint != migratedFingerprint(db) else { return }
        if fingerprint != "0:0" { try backup() }
        try execute("BEGIN IMMEDIATE", on: db)
        do {
            let rows = try statement("SELECT profile, record FROM vectors", on: db)
            defer { sqlite3_finalize(rows) }
            let insertion = try statement("INSERT OR REPLACE INTO vector_rows (profile, id, hash, updated_at, dimensions, vector) VALUES (?, ?, ?, ?, ?, ?)", on: db)
            defer { sqlite3_finalize(insertion) }
            while true {
                let status = sqlite3_step(rows)
                if status == SQLITE_DONE { break }
                guard status == SQLITE_ROW else { throw Failure.database("本机向量索引迁移失败") }
                try autoreleasepool {
                    guard let rawProfile = sqlite3_column_text(rows, 0), let bytes = sqlite3_column_text(rows, 1) else { return }
                    let profile = String(cString: rawProfile)
                    guard validHash(profile), let record = try? JSONSerialization.jsonObject(with: Data(String(cString: bytes).utf8)) as? [String: Any],
                          let row = try? parse(record) else { return }
                    try insert(row, profile: profile, with: insertion)
                }
            }
            let mark = try statement("INSERT OR REPLACE INTO vector_meta (key, value) VALUES ('legacy-fingerprint', ?)", on: db)
            defer { sqlite3_finalize(mark) }
            try bind(fingerprint, to: mark, at: 1)
            guard sqlite3_step(mark) == SQLITE_DONE else { throw Failure.database("本机向量索引迁移失败") }
            try execute("COMMIT", on: db)
        } catch { try? execute("ROLLBACK", on: db); throw error }
    }
    private func backup() throws {
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.dateFormat = "yyyyMMdd"
        let base = file.path + ".bak-" + formatter.string(from: Date())
        var target = base, suffix = 1
        while FileManager.default.fileExists(atPath: target) { target = "\(base)-\(suffix)"; suffix += 1 }
        try FileManager.default.copyItem(atPath: file.path, toPath: target)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target)
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
    private func validVector(_ value: [Double]) -> Bool { !value.isEmpty && value.allSatisfy({ $0.isFinite }) && value.contains(where: { $0 != 0 }) }

    private struct Row { let id: String, hash: String, vector: [Double], updatedAt: Double }
    private func parse(_ row: [String: Any]) throws -> Row {
        guard let id = row["id"] as? String, validID(id), let hash = row["hash"] as? String, validHash(hash),
              let vector = row["vector"] as? [Double], validVector(vector),
              let updated = row["updatedAt"] as? Double, updated.isFinite, updated >= 0 else { throw Failure.invalidRecord }
        return Row(id: id, hash: hash, vector: vector, updatedAt: updated)
    }
    // Lossless: narrow to Float32 only when every value round-trips exactly; the blob size tells which.
    private static func encode(_ vector: [Double]) -> Data {
        if vector.allSatisfy({ Double(Float($0)) == $0 }) { return vector.map { Float($0) }.withUnsafeBufferPointer { Data(buffer: $0) } }
        return vector.withUnsafeBufferPointer { Data(buffer: $0) }
    }
    private static func decode(_ stmt: OpaquePointer, column: Int32, dimensions: Int) -> [Double]? {
        let size = Int(sqlite3_column_bytes(stmt, column))
        guard dimensions > 0, let raw = sqlite3_column_blob(stmt, column) else { return nil }
        if size == dimensions * 4 { return UnsafeBufferPointer(start: raw.assumingMemoryBound(to: Float.self), count: dimensions).map(Double.init) }
        if size == dimensions * 8 { return Array(UnsafeBufferPointer(start: raw.assumingMemoryBound(to: Double.self), count: dimensions)) }
        return nil
    }
    private func insert(_ row: Row, profile: String, with stmt: OpaquePointer) throws {
        sqlite3_reset(stmt); sqlite3_clear_bindings(stmt)
        try bind(profile, to: stmt, at: 1); try bind(row.id, to: stmt, at: 2); try bind(row.hash, to: stmt, at: 3)
        sqlite3_bind_double(stmt, 4, row.updatedAt); sqlite3_bind_int64(stmt, 5, Int64(row.vector.count))
        let blob = Self.encode(row.vector)
        let bound = blob.withUnsafeBytes { sqlite3_bind_blob(stmt, 6, $0.baseAddress, Int32($0.count), transient) }
        guard bound == SQLITE_OK, sqlite3_step(stmt) == SQLITE_DONE else { throw Failure.database("保存向量索引失败") }
    }

    /// Index metadata only: what status and update need to decide what is stale.
    func summary(_ profile: String) throws -> [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        guard validHash(profile) else { throw Failure.invalidRecord }
        let db = try open(), stmt = try statement("SELECT id, hash, updated_at, dimensions FROM vector_rows WHERE profile = ? ORDER BY id", on: db)
        defer { sqlite3_finalize(stmt) }; try bind(profile, to: stmt, at: 1)
        var result = [[String: Any]]()
        while true {
            let status = sqlite3_step(stmt)
            if status == SQLITE_DONE { return result }
            guard status == SQLITE_ROW, let id = sqlite3_column_text(stmt, 0), let hash = sqlite3_column_text(stmt, 1) else { throw Failure.database("本机向量索引内容损坏") }
            result.append(["id": String(cString: id), "hash": String(cString: hash), "updatedAt": sqlite3_column_double(stmt, 2), "dimensions": Int(sqlite3_column_int64(stmt, 3))])
        }
    }
    /// Cosine similarity for rows whose stored hash still matches `entries` (id -> hash).
    /// Vectors never leave this process; the page receives one score per row.
    func search(_ profile: String, query: [Double], entries: [String: String]) throws -> [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        guard validHash(profile), validVector(query) else { throw Failure.invalidRecord }
        let db = try open(), stmt = try statement("SELECT id, hash, dimensions, vector FROM vector_rows WHERE profile = ?", on: db)
        defer { sqlite3_finalize(stmt) }; try bind(profile, to: stmt, at: 1)
        var result = [[String: Any]]()
        while true {
            let status = sqlite3_step(stmt)
            if status == SQLITE_DONE { return result }
            guard status == SQLITE_ROW, let rawID = sqlite3_column_text(stmt, 0), let rawHash = sqlite3_column_text(stmt, 1) else { throw Failure.database("本机向量索引内容损坏") }
            let id = String(cString: rawID)
            guard let wanted = entries[id], wanted == String(cString: rawHash) else { continue }
            let dimensions = Int(sqlite3_column_int64(stmt, 2))
            guard dimensions == query.count else { result.append(["id": id, "dimensions": dimensions]); continue }
            guard let vector = Self.decode(stmt, column: 3, dimensions: dimensions) else { throw Failure.database("本机向量索引内容损坏") }
            // Same arithmetic order as VectorIndex.cosine(query, stored) in app/vector-index.js.
            var dot = 0.0, x = 0.0, y = 0.0
            for i in 0..<dimensions { dot += query[i] * vector[i]; x += query[i] * query[i]; y += vector[i] * vector[i] }
            result.append(["id": id, "dimensions": dimensions, "similarity": x != 0 && y != 0 ? dot / (x * y).squareRoot() : NSNull()])
        }
    }
    /// Full records; kept for QA and diagnostics, not used on the page's hot path.
    func load(_ profile: String) throws -> [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        guard validHash(profile) else { throw Failure.invalidRecord }
        let db = try open(), stmt = try statement("SELECT id, hash, updated_at, dimensions, vector FROM vector_rows WHERE profile = ? ORDER BY id", on: db)
        defer { sqlite3_finalize(stmt) }; try bind(profile, to: stmt, at: 1)
        var result = [[String: Any]]()
        while true {
            let status = sqlite3_step(stmt)
            if status == SQLITE_DONE { return result }
            guard status == SQLITE_ROW, let id = sqlite3_column_text(stmt, 0), let hash = sqlite3_column_text(stmt, 1),
                  let vector = Self.decode(stmt, column: 4, dimensions: Int(sqlite3_column_int64(stmt, 3))) else { throw Failure.database("本机向量索引内容损坏") }
            result.append(["id": String(cString: id), "hash": String(cString: hash), "updatedAt": sqlite3_column_double(stmt, 2), "vector": vector, "profile": profile])
        }
    }
    func write(_ profile: String, puts: [[String: Any]], removes: [String]) throws {
        lock.lock(); defer { lock.unlock() }
        guard validHash(profile), removes.allSatisfy(validID) else { throw Failure.invalidRecord }
        // Validate the entire batch before opening a write transaction; persist only index fields.
        let records = try puts.map(parse)
        let db = try open()
        try execute("BEGIN IMMEDIATE", on: db)
        do {
            let deletion = try statement("DELETE FROM vector_rows WHERE profile = ? AND id = ?", on: db)
            defer { sqlite3_finalize(deletion) }
            for id in removes {
                sqlite3_reset(deletion); sqlite3_clear_bindings(deletion)
                try bind(profile, to: deletion, at: 1); try bind(id, to: deletion, at: 2)
                guard sqlite3_step(deletion) == SQLITE_DONE else { throw Failure.database("移除旧向量失败") }
            }
            let insertion = try statement("INSERT OR REPLACE INTO vector_rows (profile, id, hash, updated_at, dimensions, vector) VALUES (?, ?, ?, ?, ?, ?)", on: db)
            defer { sqlite3_finalize(insertion) }
            for row in records { try insert(row, profile: profile, with: insertion) }
            try execute("COMMIT", on: db)
        } catch { try? execute("ROLLBACK", on: db); throw error }
    }
}
