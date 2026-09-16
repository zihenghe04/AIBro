import Foundation
import SQLite3

/// Single durable document: content, cursor and immutable pending operations commit together.
struct WorkspaceDatabase {
    let directory: URL
    private func failure(_ message: String) -> NSError { NSError(domain: "AI Bro storage", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    private func database<T>(_ block: (OpaquePointer) throws -> T) throws -> T {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent("workspace.sqlite")
        var handle: OpaquePointer?
        let result = sqlite3_open_v2(file.path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil)
        guard result == SQLITE_OK, let db = handle else { if let handle { sqlite3_close(handle) }; throw failure("无法打开手机工作区") }
        defer { sqlite3_close(db) }
        sqlite3_busy_timeout(db, 5000)
        guard sqlite3_exec(db, "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);", nil, nil, nil) == SQLITE_OK else { throw failure("无法初始化手机工作区") }
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: file.path)
        #endif
        return try block(db)
    }
    func load() throws -> String? {
        try database { db in
            var statement: OpaquePointer?
            guard sqlite3_prepare_v2(db, "SELECT value FROM workspace WHERE id=1", -1, &statement, nil) == SQLITE_OK else { throw failure("读取工作区失败") }
            defer { sqlite3_finalize(statement) }
            let step = sqlite3_step(statement)
            if step == SQLITE_DONE { return nil }
            guard step == SQLITE_ROW, let text = sqlite3_column_text(statement, 0) else { throw failure("读取工作区失败") }
            return String(cString: text)
        }
    }
    func save(_ value: String) throws {
        guard let bytes = value.data(using: .utf8), bytes.count <= 128 * 1024 * 1024,
              let object = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any], object["schema"] as? Int == 1 else { throw failure("工作区格式无效，未覆盖原数据") }
        try database { db in
            var statement: OpaquePointer?
            guard sqlite3_prepare_v2(db, "INSERT INTO workspace(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value", -1, &statement, nil) == SQLITE_OK else { throw failure("保存工作区失败") }
            defer { sqlite3_finalize(statement) }
            let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
            guard sqlite3_bind_text(statement, 1, value, -1, transient) == SQLITE_OK, sqlite3_step(statement) == SQLITE_DONE else { throw failure("工作区未保存，请检查可用空间") }
        }
    }
}
