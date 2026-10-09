// Executed by scripts/test-native-connection-vault.py against the exact production helper.
// In-memory storage makes forced failures/races deterministic; Keychain has a separate native fixture.
import Foundation
import CryptoKit

final class FixtureCredentialStorage: MobileCredentialStorage {
    var values: [String: Data] = [:]
    var rejectWrites = false
    func read(_ key: String) throws -> Data? { values[key] }
    func write(_ key: String, data: Data) throws {
        if rejectWrites { throw MobileCredentialError.write }
        values[key] = data
    }
    func remove(_ key: String) throws { values.removeValue(forKey: key) }
}
let binding: [String: Any] = ["serverOrigin": "https://sync.example.test", "accountId": "account_fixture"]
func rawSession(account: String = "account_fixture", session: String = "session_fixture", base: String = "https://sync.example.test/prefix") throws -> String {
    String(data: try JSONSerialization.data(withJSONObject: ["base": base, "token": "synthetic-sync-token", "accountId": account, "sessionId": session], options: [.sortedKeys, .withoutEscapingSlashes]), encoding: .utf8)!
}
func hash(_ text: String) -> String { SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined() }
func capture(_ vault: MobileCredentialVault, raw: String, account: String = "account_fixture", session: String = "session_fixture") throws -> [String: Any] {
    ["serverOrigin": "https://sync.example.test", "accountId": account, "sessionId": session, "generation": 1,
     "nativeFence": try vault.connectionSessionFence(expectedSyncSha256: hash(raw))]
}
func profile(_ text: String = "synthetic-api-key") -> [String: Any] {
    ["format": "aibro.connection-sync-local.v1", "binding": binding, "activeProfiles": ["chat": ["apiKey": text, "baseUrl": "https://api.example.test/v1", "model": "synthetic-model"]]]
}
func require(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !condition() { throw NSError(domain: "fixture", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
}
func rejects(_ work: () throws -> Void) throws {
    do { try work() } catch { return }; throw NSError(domain: "fixture", code: 2, userInfo: [NSLocalizedDescriptionKey: "expected rejection"])
}
var passed = 0
func test(_ name: String, _ work: () throws -> Void) throws { try work(); passed += 1; print("PASS \(name)") }
func fixture() throws -> (FixtureCredentialStorage, MobileCredentialVault, String, [String: Any]) {
    let storage = FixtureCredentialStorage()
    let target = MobileCredentialVault(storage: storage), raw = try rawSession()
    try target.set("sync", value: raw)
    return (storage, target, raw, try capture(target, raw: raw))
}
try test("whole bundle CAS, reopen, stale revision and tombstone do not restore old keys") {
    let (storage, vault, _, fence) = try fixture()
    let first = try vault.connectionVaultRead(binding: binding, sessionFence: fence)
    try require(first["revision"] as? Int == 0 && first["value"] is NSNull, "initial")
    try require(vault.connectionVaultCompareAndSwap(binding: binding, expectedRevision: 0, value: profile(), sessionFence: fence), "write")
    let reopened = MobileCredentialVault(storage: storage)
    try require(reopened.connectionVaultRead(binding: binding, sessionFence: fence)["revision"] as? Int64 == 1, "reopen")
    try require(!reopened.connectionVaultCompareAndSwap(binding: binding, expectedRevision: 0, value: profile("stale-key"), sessionFence: fence), "stale CAS")
    try require(reopened.connectionVaultCompareAndSwap(binding: binding, expectedRevision: 1, value: NSNull(), sessionFence: fence), "clear")
    let tombstone = try reopened.connectionVaultRead(binding: binding, sessionFence: fence)
    try require(tombstone["revision"] as? Int64 == 2 && tombstone["value"] is NSNull, "tombstone")
    try require(!reopened.connectionVaultCompareAndSwap(binding: binding, expectedRevision: 0, value: profile(), sessionFence: fence), "ABA revision")
}
try test("old credential cannot capture a new fence; identical-token set/remove ABA rejected") {
    let (_, vault, raw, fence) = try fixture()
    try rejects { _ = try vault.connectionSessionFence(expectedSyncSha256: String(repeating: "0", count: 64)) }
    try vault.set("sync", value: raw)
    try require(!vault.connectionVaultCompareAndSwap(binding: binding, expectedRevision: 0, value: profile(), sessionFence: fence), "identical write invalidates")
    try rejects { _ = try vault.connectionVaultRead(binding: binding, sessionFence: fence) }
    let newFence = try capture(vault, raw: raw)
    try vault.remove("sync"); try vault.set("sync", value: raw)
    try require(!vault.connectionVaultCompareAndSwap(binding: binding, expectedRevision: 0, value: profile(), sessionFence: newFence), "logout restore invalidates")
}
try test("account, origin and cloud session metadata cannot be substituted") {
    let (_, vault, _, fence) = try fixture()
    for (key, replacement) in [("accountId", "another_account"), ("serverOrigin", "https://another.example.test"), ("sessionId", "another_session")] {
        var forged = fence; forged[key] = replacement
        try rejects { _ = try vault.connectionVaultRead(binding: binding, sessionFence: forged) }
    }
    let raw = try rawSession(account: "other_account")
    try vault.set("sync", value: raw)
    let newFence = try capture(vault, raw: raw, account: "other_account")
    let other: [String: Any] = ["serverOrigin": "https://sync.example.test", "accountId": "other_account"]
    try require(vault.connectionVaultRead(binding: other, sessionFence: newFence)["value"] is NSNull, "isolated slot")
    try rejects { _ = try vault.connectionVaultRead(binding: binding, sessionFence: newFence) }
}
try test("legacy credentials still readable but cannot authorize configuration sync") {
    let vault = MobileCredentialVault(storage: FixtureCredentialStorage())
    let raw = "{\"base\":\"https://sync.example.test\",\"token\":\"synthetic-legacy\"}"
    try vault.set("sync", value: raw)
    try require(vault.get("sync") == raw, "legacy kept")
    do { _ = try vault.connectionSessionFence(expectedSyncSha256: hash(raw)); throw NSError(domain:"unexpected",code:1) }
    catch MobileCredentialError.reconnect {} // Fixed error, no credential or parser payload.
}
try test("generic secret API cannot overwrite a connection slot; model writes preserve fence") {
    let (storage, vault, _, fence) = try fixture()
    try require(vault.connectionVaultCompareAndSwap(binding: binding, expectedRevision: 0, value: profile(), sessionFence: fence), "initial")
    let key = storage.values.keys.first { $0.hasPrefix("connections.v1.") }!
    try rejects { try vault.set(key, value: "attack") }; try rejects { try vault.remove(key) }; try rejects { _ = try vault.get(key) }
    try vault.set("model", value: "synthetic-old-model-key")
    try require(vault.connectionVaultRead(binding: binding, sessionFence: fence)["revision"] as? Int64 == 1, "model does not invalidate cloud fence")
}
try test("invalid revisions, shape, binding, oversized value and bad fingerprint preserve record") {
    let (_, vault, _, fence) = try fixture()
    for revision: Any in [-1, 0.5, true, "0", 9_007_199_254_740_992 as Int64] {
        try rejects { _ = try vault.connectionVaultCompareAndSwap(binding: binding, expectedRevision: revision, value: profile(), sessionFence: fence) }
    }
    try rejects { _ = try vault.connectionVaultCompareAndSwap(binding: binding, expectedRevision: 0, value: profile(String(repeating: "x", count: 4 * 1024 * 1024)), sessionFence: fence) }
    try rejects { _ = try vault.connectionVaultCompareAndSwap(binding: binding, expectedRevision: 0, value: ["format":"wrong"], sessionFence: fence) }
    var malformed = fence; malformed["nativeFence"] = String(repeating: "A", count: 42) + "B"
    try rejects { _ = try vault.connectionVaultRead(binding: binding, sessionFence: malformed) }
    var wrong = binding; wrong["accountId"] = "account_fixture\n"
    try rejects { _ = try vault.connectionVaultRead(binding: wrong, sessionFence: fence) }
    try require(vault.connectionVaultRead(binding: binding, sessionFence: fence)["revision"] as? Int == 0, "unchanged")
}
try test("failure leaves previous bundle/revision and session fence intact") {
    let (storage, vault, raw, fence) = try fixture()
    try require(vault.connectionVaultCompareAndSwap(binding: binding, expectedRevision: 0, value: profile(), sessionFence: fence), "initial")
    storage.rejectWrites = true
    try rejects { _ = try vault.connectionVaultCompareAndSwap(binding: binding, expectedRevision: 1, value: profile("replacement"), sessionFence: fence) }
    try rejects { try vault.set("sync", value: raw) }
    storage.rejectWrites = false
    try require(vault.connectionVaultRead(binding: binding, sessionFence: fence)["revision"] as? Int64 == 1, "unchanged revision and generation")
    try require(vault.connectionVaultCompareAndSwap(binding: binding, expectedRevision: 1, value: profile("replacement"), sessionFence: fence), "retry succeeds")
}
try test("multiple instances racing one revision have exactly one winner") {
    let (storage, vault, _, fence) = try fixture()
    let resultLock = NSLock(); var successes = 0; var failures = 0
    DispatchQueue.concurrentPerform(iterations: 16) { index in
        do {
            let another = MobileCredentialVault(storage: storage)
            let won = try another.connectionVaultCompareAndSwap(binding: binding, expectedRevision: 0, value: profile("synthetic-\(index)"), sessionFence: fence)
            resultLock.lock(); if won { successes += 1 }; resultLock.unlock()
        } catch { resultLock.lock(); failures += 1; resultLock.unlock() }
    }
    try require(successes == 1 && failures == 0, "single winner")
    try require(vault.connectionVaultRead(binding: binding, sessionFence: fence)["revision"] as? Int64 == 1, "one revision")
}
try test("corrupt stored bundle fails closed without resetting revision") {
    let (storage, vault, _, fence) = try fixture()
    try require(vault.connectionVaultCompareAndSwap(binding: binding, expectedRevision: 0, value: profile(), sessionFence: fence), "initial")
    let key = storage.values.keys.first { $0.hasPrefix("connections.v1.") }!
    storage.values[key] = Data("invalid-json-synthetic".utf8)
    try rejects { _ = try vault.connectionVaultRead(binding: binding, sessionFence: fence) }
    try rejects { _ = try vault.connectionVaultCompareAndSwap(binding: binding, expectedRevision: 0, value: profile(), sessionFence: fence) }
    try require(storage.values[key] == Data("invalid-json-synthetic".utf8), "no repair overwrite")
}
print("Native connection vault core: \(passed)/\(passed) passed; in-memory adapter, no native storage acceptance claimed")
