import Foundation
@main struct StorageTest {
    static func main() throws {
        let folder=FileManager.default.temporaryDirectory.appendingPathComponent("aibro-native-storage-test-"+UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: folder) }
        let store=WorkspaceDatabase(directory: folder)
        let initial=try store.load();precondition(initial==nil)
        let original="{\"schema\":1,\"cursor\":7,\"records\":{\"notes:n1\":{\"title\":\"研究'笔记\",\"flight\":{\"opId\":\"retry-exactly\"}}}}"
        try store.save(original)
        let restarted=WorkspaceDatabase(directory:folder)
        let saved=try restarted.load();precondition(saved==original)
        do { try restarted.save("broken JSON"); fatalError("must reject invalid replacement") } catch {}
        let stillSaved=try restarted.load();precondition(stillSaved==original)
        try restarted.save("{\"schema\":1,\"cursor\":8}")
        let next=try store.load();precondition(next=="{\"schema\":1,\"cursor\":8}")
        print("PASS native SQLite: reopen, exact flight and cursor persistence, rejected replacement, subsequent commit")
    }
}
