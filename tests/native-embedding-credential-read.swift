import Foundation
import Security

// Same error wrapper as the host, without booting the application or devices.
enum AgendaError: LocalizedError {
    case message(String)
    var errorDescription: String? { switch self { case .message(let text): return text } }
}

@main struct EmbeddingCredentialReadTests {
    static var count = 0
    static func check(_ value: @autoclosure () throws -> Bool, _ label: String) rethrows {
        guard try value() else { fatalError(label) }
        count += 1; print("PASS \(count): \(label)")
    }
    static func main() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("aibro-embedding-read-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: root) }
        let folder = root.appendingPathComponent("formal-synthetic"), base = "https://fixture.invalid/v1/embeddings"
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let metadata = folder.appendingPathComponent("embedding.json")
        let metadataBytes = try JSONSerialization.data(withJSONObject: ["hasKey": true, "base": base, "model": "synthetic-embedding"])
        try metadataBytes.write(to: metadata); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: metadata.path)
        var interactionAllowed = true, reads = 0, interactionChanges = 0
        var operations = NativeCredentials.Operations()
        operations.interaction = { (errSecSuccess, interactionAllowed) }
        operations.setInteraction = { interactionAllowed = $0; interactionChanges += 1; return errSecSuccess }
        operations.copy = { _ in
            check(!interactionAllowed, "synthetic legacy read cannot display system authorization")
            reads += 1; return (errSecInteractionNotAllowed, nil)
        }
        func store(_ path: URL = folder, service: String = "synthetic.formal-owner") -> NativeCredentials {
            NativeCredentials(folder: path, legacy: nil, service: service, operations: operations)
        }
        let native = store(), options: [String: Any] = ["base": base]
        let initial = native.status("embedding")
        check(initial["hasKey"] as? Bool == true && initial["needsReentry"] as? Bool == true, "legacy metadata is historical presence, not readable local key")
        check(reads == 0 && interactionChanges == 0, "opening status never invokes injected Keychain")
        do { _ = try native.call("embedding", "read", options); fatalError("legacy denial must reject") }
        catch { check(error.localizedDescription.contains("CREDENTIAL_REENTRY_REQUIRED"), "legacy rejection preserves explicit reentry code") }
        check(reads == 1 && interactionAllowed, "single silent migration attempt restores prior interaction setting")
        check(!FileManager.default.fileExists(atPath: folder.appendingPathComponent("v2/embedding.sealed").path), "denied read writes no embedding ciphertext")
        do { _ = try native.call("embedding", "read", options); fatalError("blocked read must reject") }
        catch { check(reads == 1, "repeated failed legacy access is not retried automatically") }

        _ = try native.call("api", "save", ["base": "https://chat.invalid/v1", "token": "synthetic-chat-only"])
        let chatFile = folder.appendingPathComponent("v2/api.sealed"), chatBefore = try Data(contentsOf: chatFile)
        _ = try native.call("embedding", "save", ["base": base, "token": "synthetic-new-independent-key", "model": "synthetic-embedding"])
        check(reads == 1 && interactionChanges == 2, "fresh explicit key save bypasses old Keychain entirely")
        let saved = native.status("embedding")
        check(saved["hasKey"] as? Bool == true && saved["storage"] as? String == "encrypted-file" && saved["needsReentry"] as? Bool == false, "fresh save yields readable file status without claiming network health")
        check(saved["token"] == nil, "status never exposes key content")
        try check(try Data(contentsOf: metadata) == metadataBytes && Data(contentsOf: chatFile) == chatBefore, "new embedding save preserves old metadata and unrelated chat ciphertext")
        try check(try store().call("embedding", "read", options)["token"] as? String == "synthetic-new-independent-key", "same synthetic owner reads new key after restart")
        check(reads == 1, "v2 restart never consults legacy provider")

        let foreign = store(folder, service: "synthetic.demo-owner")
        check(foreign.status("embedding")["storage"] as? String == "unavailable", "same files under different owner cannot decrypt")
        let isolated = store(root.appendingPathComponent("demo-synthetic"), service: "synthetic.demo-owner")
        check(isolated.status("embedding")["hasKey"] as? Bool == false, "isolated Demo absence does not imply formal key failure")
        check(native.status("embedding")["available"] as? Bool == true, "foreign-owner check leaves original readable state intact")

        check(native.status("embedding")["hasKey"] as? Bool == true, "status before explicit removal may truthfully report presence")
        _ = try native.call("embedding", "remove", [:])
        let removed = try native.call("embedding", "read", options)
        check(removed["token"] as? String == "", "actual native removal contract returns empty token to a later read")
        try check(try Data(contentsOf: chatFile) == chatBefore, "embedding removal does not affect chat credential")
        check(reads == 1, "tombstone prevents revival of old Keychain key")
        print("\(count) synthetic NativeCredentials assertions passed; no real Security calls, user files, network, or GUI")
    }
}
