import Foundation
import Security
import CommonCrypto
import CryptoKit
import Darwin

/// Local, authenticated encrypted storage. The random encryption key stays in the
/// same private native directory; this avoids Keychain authentication dependencies,
/// but does not protect against another process running as this macOS user.
final class NativeCredentials: @unchecked Sendable {
    private static let lock = NSRecursiveLock()
    struct Operations {
        // Legacy migration is read-only, always with system authentication UI disabled.
        var copy: ([String: Any]) -> (OSStatus, Data?) = { query in
            var item: CFTypeRef?
            let result = SecItemCopyMatching(query as CFDictionary, &item)
            return (result, item as? Data)
        }
        var interaction: () -> (OSStatus, Bool) = {
            var allowed: DarwinBoolean = false
            return (SecKeychainGetUserInteractionAllowed(&allowed), allowed.boolValue)
        }
        var setInteraction: (Bool) -> OSStatus = { SecKeychainSetUserInteractionAllowed($0) }
        // Fault injection for isolated durability tests; called before atomic rename.
        var beforeCommit: (String) throws -> Void = { _ in }
    }
    private let operations: Operations
    private var blocked = Set<String>()
    let folder: URL
    let legacy: URL?
    let service: String
    init(folder: URL, legacy: URL?, service: String, operations: Operations = Operations()) {
        self.folder = folder; self.legacy = legacy; self.service = service; self.operations = operations
    }
    private func failure(_ text: String) -> Error { AgendaError.message("[CREDENTIAL_STORAGE_ERROR] " + text) }
    private func reentry() -> Error {
        AgendaError.message("[CREDENTIAL_REENTRY_REQUIRED] 旧 Key 无法静默读取。请重新粘贴 API Key，保存到本机加密文件后即可使用，无需输入登录密码。原钥匙串记录未改动。")
    }
    private func legacyFile(_ channel: String) -> URL? {
        legacy?.appendingPathComponent(channel == "api" ? "credentials/api.json" : "embedding-credentials/api.json")
    }
    private func query(_ channel: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: channel,
         kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
    }
    static func origin(_ base: String) throws -> String {
        guard base.utf8.count <= 8192, let u = URLComponents(string: base), ["https", "http"].contains(u.scheme?.lowercased() ?? ""),
              let host = u.host, !host.isEmpty, u.user == nil, u.password == nil, u.fragment == nil else {
            throw AgendaError.message("API 地址无效。")
        }
        let scheme = u.scheme!.lowercased(), port = u.port
        return scheme + "://" + host.lowercased() + (port == nil || (scheme == "https" && port == 443) || (scheme == "http" && port == 80) ? "" : ":\(port!)")
    }

    // Open the trusted parent once, then use directory-relative, no-follow operations.
    // In particular, never resolve a symlink at the credential directory or its files.
    private func directory(create: Bool) throws -> Int32? {
        let parent = folder.deletingLastPathComponent().resolvingSymlinksInPath()
        let p = Darwin.open(parent.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard p >= 0 else { throw failure("无法打开本机凭据的父目录，已有凭据未改动。") }
        defer { Darwin.close(p) }
        func child(_ parentFD: Int32, _ name: String) throws -> Int32? {
            if create && mkdirat(parentFD, name, 0o700) != 0 && errno != EEXIST {
                throw failure("无法创建本机凭据目录，已有凭据未改动。")
            }
            let fd = openat(parentFD, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            if fd < 0 && errno == ENOENT && !create { return nil }
            guard fd >= 0 else { throw failure("本机凭据目录不可访问或为符号链接。") }
            var info = stat()
            guard fstat(fd, &info) == 0, info.st_uid == getuid(), info.st_mode & 0o777 == 0o700 else {
                Darwin.close(fd); throw failure("本机凭据目录必须由当前用户拥有，权限为 0700。")
            }
            return fd
        }
        guard let root = try child(p, folder.lastPathComponent) else { return nil }
        defer { Darwin.close(root) }
        return try child(root, "v2")
    }
    private func withStore<T>(create: Bool, _ body: (Int32?) throws -> T) throws -> T {
        guard let fd = try directory(create: create) else { return try body(nil) }
        defer { Darwin.close(fd) }
        // Lock the already verified directory inode. A separate lock file would
        // add an unnecessary creation race when two app processes start together.
        while flock(fd, LOCK_EX) != 0 {
            if errno == EINTR { continue }
            throw failure("无法锁定本机凭据目录（\(errno)）。")
        }
        defer { _ = flock(fd, LOCK_UN) }
        return try body(fd)
    }
    private func verifyFile(_ fd: Int32) throws {
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(),
              info.st_mode & 0o777 == 0o600, info.st_nlink == 1 else {
            throw failure("本机凭据文件必须是当前用户拥有的独立普通文件，权限为 0600。")
        }
    }
    private func readFile(_ name: String, at directory: Int32, limit: Int = 131072) throws -> Data? {
        let fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if fd < 0 && errno == ENOENT { return nil }
        guard fd >= 0 else { throw failure("本机凭据文件不可访问或为符号链接。") }
        defer { Darwin.close(fd) }
        try verifyFile(fd)
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_size <= limit else { throw failure("本机凭据文件格式无效。") }
        var result = Data(), buffer = [UInt8](repeating: 0, count: 8192)
        while true {
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count < 0 && errno == EINTR { continue }
            guard count >= 0 else { throw failure("本机凭据文件读取失败。") }
            if count == 0 { break }
            result.append(contentsOf: buffer.prefix(count))
            guard result.count <= limit else { throw failure("本机凭据文件格式无效。") }
        }
        return result
    }
    private func atomicWrite(_ data: Data, name: String, at directory: Int32, limit: Int = 131072) throws {
        // Reject a replaced, insecure or linked destination before writing anything.
        guard data.count <= limit else { throw failure("本机凭据超过保存上限。") }
        _ = try readFile(name, at: directory, limit: limit)
        let temporary = ".pending-" + UUID().uuidString
        let fd = openat(directory, temporary, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw failure("无法保存本机凭据，原记录已保留。") }
        defer { Darwin.close(fd); _ = unlinkat(directory, temporary, 0) }
        try data.withUnsafeBytes { bytes in
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw failure("本机凭据写入失败，原记录已保留。") }
                offset += count
            }
        }
        guard fsync(fd) == 0 else { throw failure("本机凭据未能持久保存，原记录已保留。") }
        try operations.beforeCommit(name)
        guard renameat(directory, temporary, directory, name) == 0 else { throw failure("本机凭据替换失败，原记录已保留。") }
        guard fsync(directory) == 0 else { throw failure("本机凭据已写入，但目录持久化未确认；请重试。") }
    }
    private func encryptionKey(at directory: Int32, create: Bool) throws -> SymmetricKey {
        if let bytes = try readFile("device-key.bin", at: directory) {
            guard bytes.count == 32 else { throw failure("本机加密密钥格式无效，凭据未改动。") }
            return SymmetricKey(data: bytes)
        }
        // Never replace a missing encryption key while old ciphertext still exists.
        guard create, try readFile("api.sealed", at: directory, limit: Self.profileLimit + 28) == nil, try readFile("embedding.sealed", at: directory, limit: Self.profileLimit + 28) == nil,
              try readFile("connections.sealed", at: directory, limit: Self.connectionLimit + 28) == nil else {
            throw failure("本机加密密钥缺失，已有凭据无法读取。")
        }
        let key = SymmetricKey(size: .bits256)
        try atomicWrite(key.withUnsafeBytes { Data($0) }, name: "device-key.bin", at: directory)
        return key
    }
    private func authenticatedData(_ channel: String) -> Data { Data(("AI Bro credentials v2\u{0}" + service + "\u{0}" + channel).utf8) }
    private func localRecord(_ channel: String, at directory: Int32?) throws -> [String: Any]? {
        guard let directory, let sealed = try readFile(channel + ".sealed", at: directory, limit: Self.profileLimit + 28) else { return nil }
        do {
            let key = try encryptionKey(at: directory, create: false)
            let plaintext = try AES.GCM.open(AES.GCM.SealedBox(combined: sealed), using: key, authenticating: authenticatedData(channel))
            guard let envelope = try JSONSerialization.jsonObject(with: plaintext) as? [String: Any],
                  envelope["version"] as? Int == 2, envelope["channel"] as? String == channel else { throw failure("凭据内容无效。") }
            return envelope
        } catch { throw failure("本机凭据校验或解密失败，已有文件未改动。") }
    }
    private static let profileLimit = 1024 * 1024
    private func writeEnvelope(_ channel: String, _ envelope: [String: Any], at directory: Int32) throws {
        let key = try encryptionKey(at: directory, create: true)
        let plaintext = try JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys])
        guard plaintext.count <= Self.profileLimit,
              let sealed = try AES.GCM.seal(plaintext, using: key, authenticating: authenticatedData(channel)).combined else { throw failure("本机凭据超过保存上限。") }
        try atomicWrite(sealed, name: channel + ".sealed", at: directory, limit: Self.profileLimit + 28)
    }
    private func writeRecord(_ channel: String, _ record: [String: Any]?, at directory: Int32) throws {
        let old = try localRecord(channel, at: directory)
        // Older callers still modify only the active scheme; inactive credentials survive.
        guard old?["profiles"] != nil else {
            var envelope: [String: Any] = ["version": 2, "channel": channel, "removed": record == nil, "profileRevision": (old?["profileRevision"] as? Int ?? 0) + 1]
            if let record { envelope["record"] = record }
            try writeEnvelope(channel, envelope, at: directory); return
        }
        var catalog = try profileCatalog(old)
        let id = catalog.active.isEmpty ? (catalog.rows["default"] == nil ? "default" : UUID().uuidString) : catalog.active
        if let record {
            let name = (catalog.rows[id] as? [String: Any])?["name"] as? String ?? "默认方案"
            var record = record
            if let previous = (catalog.rows[id] as? [String: Any])?["record"] as? [String: Any] { record["settings"] = previous["settings"] }
            catalog.rows[id] = ["name": name, "record": record]; catalog.active = id
        } else { if !catalog.active.isEmpty { catalog.rows.removeValue(forKey: catalog.active) }; catalog.active = "" }
        catalog.revision += 1
        try writeEnvelope(channel, profileEnvelope(channel, catalog), at: directory)
    }
    private func legacyBytes(_ url: URL) throws -> Data? {
        let fd = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if fd < 0 && errno == ENOENT { return nil }
        guard fd >= 0 else { throw reentry() }
        defer { Darwin.close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(),
              info.st_nlink == 1, info.st_size <= 131072 else { throw reentry() }
        var result = Data(), buffer = [UInt8](repeating: 0, count: 8192)
        while true {
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count < 0 && errno == EINTR { continue }
            guard count >= 0 else { throw reentry() }
            if count == 0 { break }
            result.append(contentsOf: buffer.prefix(count))
            guard result.count <= 131072 else { throw reentry() }
        }
        return result
    }
    private func legacyMetadata(_ channel: String) -> [String: Any] {
        guard let bytes = try? legacyBytes(folder.appendingPathComponent(channel + ".json")) else { return [:] }
        return (try? JSONSerialization.jsonObject(with: bytes) as? [String: Any]) ?? [:]
    }
    private func statusValue(_ channel: String) -> [String: Any] {
        do {
            if let envelope = try withStore(create: false, { try localRecord(channel, at: $0) }) {
                let record = envelope["record"] as? [String: Any], hasKey = envelope["removed"] as? Bool != true && !(record?["token"] as? String ?? "").isEmpty
                return ["available": hasKey, "hasKey": hasKey, "verified": hasKey, "requiresUnlock": false,
                        "storage": "encrypted-file", "backend": "encrypted-file", "legacyLocked": false, "needsReentry": false,
                        "base": record?["base"] as? String ?? "", "model": record?["model"] as? String ?? ""]
            }
        } catch {
            return ["available": false, "hasKey": true, "verified": false, "requiresUnlock": false,
                    "storage": "unavailable", "backend": "encrypted-file", "legacyLocked": false, "needsReentry": false,
                    "error": error.localizedDescription, "base": "", "model": ""]
        }
        let m = legacyMetadata(channel)
        let old = m["removed"] as? Bool != true && (m["hasKey"] as? Bool == true || legacyFile(channel).map { FileManager.default.fileExists(atPath: $0.path) } == true || blocked.contains(channel))
        return ["available": false, "hasKey": old, "verified": false, "requiresUnlock": false,
                "storage": old ? "legacy-keychain" : "none", "backend": "encrypted-file", "legacyLocked": old, "needsReentry": old,
                "base": m["base"] as? String ?? "", "model": m["model"] as? String ?? ""]
    }
    func status(_ channel: String) -> [String: Any] {
        Self.lock.lock(); defer { Self.lock.unlock() }
        guard ["api", "embedding"].contains(channel) else { return ["available": false, "hasKey": false] }
        return statusValue(channel)
    }
    private func validate(_ record: [String: Any], origin: String) throws -> [String: Any] {
        guard let base = record["base"] as? String, try Self.origin(base) == origin,
              record["origin"] as? String == origin, let token = record["token"] as? String, (!token.isEmpty || record["noKey"] as? Bool == true),
              token.utf8.count <= 16384, !token.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else {
            throw AgendaError.message("已保存的 Key 属于另一个服务地址或格式无效，未提供给当前地址。")
        }
        return record
    }
    private func legacyRecord(_ channel: String) throws -> [String: Any]? {
        guard legacyMetadata(channel)["removed"] as? Bool != true else { return nil }
        if blocked.contains(channel) { throw reentry() }
        let (readStatus, original) = operations.interaction()
        guard readStatus == errSecSuccess, operations.setInteraction(false) == errSecSuccess else { blocked.insert(channel); throw reentry() }
        let outcome = Result<[String: Any]?, Error> { () throws -> [String: Any]? in
            let (result, bytes) = operations.copy(query(channel))
            if result == errSecSuccess, let bytes {
                guard let record = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw reentry() }
                return record
            }
            guard result == errSecItemNotFound else { throw reentry() }
            guard let file = legacyFile(channel), let raw = try legacyBytes(file) else {
                if legacyMetadata(channel)["hasKey"] as? Bool == true { throw reentry() }
                return nil
            }
            let envelope = try JSONSerialization.jsonObject(with: raw) as? [String: Any]
            guard let value = envelope?["ciphertext"] as? String, let encrypted = Data(base64Encoded: value) else { throw reentry() }
            let old: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "ai-workstation Safe Storage", kSecAttrAccount as String: "ai-workstation", kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
            let (status, password) = operations.copy(old)
            guard status == errSecSuccess, let password else { throw reentry() }
            return try JSONSerialization.jsonObject(with: Self.decryptLegacy(encrypted, password: password)) as? [String: Any]
        }
        guard operations.setInteraction(original) == errSecSuccess else { blocked.insert(channel); throw reentry() }
        switch outcome {
        case .success(let value): return value
        case .failure: blocked.insert(channel); throw reentry()
        }
    }
    private func record(_ channel: String, origin: String, at directory: Int32) throws -> [String: Any]? {
        if let envelope = try localRecord(channel, at: directory) {
            if envelope["removed"] as? Bool == true { return nil }
            guard let record = envelope["record"] as? [String: Any] else { throw failure("本机凭据内容无效。") }
            return try validate(record, origin: origin)
        }
        guard let old = try legacyRecord(channel) else { return nil }
        let checked = try validate(old, origin: origin)
        try writeRecord(channel, checked, at: directory)
        blocked.remove(channel)
        return checked
    }
    static func decryptLegacy(_ encrypted: Data, password: Data) throws -> Data {
        guard encrypted.prefix(3) == Data("v10".utf8) else { throw AgendaError.message("不支持此旧版凭据加密格式。") }
        var key = [UInt8](repeating: 0, count: 16); let salt = Array("saltysalt".utf8)
        let derivation = password.withUnsafeBytes { p in CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), p.bindMemory(to: Int8.self).baseAddress, password.count, salt, salt.count, CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1), 1003, &key, key.count) }
        let cipher = Data(encrypted.dropFirst(3)), iv = [UInt8](repeating: 32, count: 16)
        var output = [UInt8](repeating: 0, count: cipher.count + 16), length = 0
        let result = cipher.withUnsafeBytes { p in CCCrypt(CCOperation(kCCDecrypt), CCAlgorithm(kCCAlgorithmAES), CCOptions(kCCOptionPKCS7Padding), key, key.count, iv, p.baseAddress, cipher.count, &output, output.count, &length) }
        guard derivation == kCCSuccess, result == kCCSuccess else { throw AgendaError.message("无法解密旧版凭据；旧文件未改动。") }
        return Data(output.prefix(length))
    }
    func call(_ channel: String, _ action: String, _ options: [String: Any]) throws -> [String: Any] {
        Self.lock.lock(); defer { Self.lock.unlock() }
        guard ["api", "embedding"].contains(channel) else { throw AgendaError.message("未知凭据类型") }
        if action.hasPrefix("profile-") { return try profileCall(channel, action, options) }
        guard ["status", "read", "unlock", "save", "authorizeSave", "remove", "authorizeRemove"].contains(action) else { throw AgendaError.message("未知凭据操作") }
        if action == "status" { return statusValue(channel) }
        let result: [String: Any]? = try withStore(create: true) { fd in
            guard let fd else { throw failure("本机凭据目录不可用。") }
            if action == "remove" || action == "authorizeRemove" {
                // A durable tombstone suppresses both native and old Electron records.
                // Do not modify or delete old Keychain items, even on explicit removal.
                try writeRecord(channel, nil, at: fd); blocked.remove(channel); return nil
            }
            let base = (options["base"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines), origin = try Self.origin(base)
            if action == "read" || action == "unlock" {
                let saved = try record(channel, origin: origin, at: fd)
                if action == "unlock" { return nil }
                return ["base": saved?["base"] as? String ?? base, "token": saved?["token"] as? String ?? "", "model": saved?["model"] as? String ?? ""]
            }
            var token = (options["token"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if token.isEmpty {
                guard let old = try record(channel, origin: origin, at: fd) else { throw AgendaError.message("请填写当前服务的 API Key。") }
                token = old["token"] as? String ?? ""
            }
            let model = options["model"] as? String ?? ""
            guard !token.isEmpty, token.utf8.count <= 16384, !token.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains), model.count <= 512 else { throw AgendaError.message("Key 或模型格式无效") }
            let value: [String: Any] = ["base": base, "token": token, "model": model, "origin": origin]
            try writeRecord(channel, value, at: fd); blocked.remove(channel); return nil
        }
        return result ?? statusValue(channel)
    }

    private static let connectionLimit = 4 * 1024 * 1024
    private func connectionEntries(at fd: Int32?) throws -> [String: Any] {
        guard let fd, let sealed = try readFile("connections.sealed", at: fd, limit: Self.connectionLimit + 28) else { return [:] }
        do {
            let key = try encryptionKey(at: fd, create: false)
            let plain = try AES.GCM.open(AES.GCM.SealedBox(combined: sealed), using: key, authenticating: authenticatedData("connections"))
            guard plain.count <= Self.connectionLimit, let root = try JSONSerialization.jsonObject(with: plain) as? [String: Any] else { throw NativeConnectionSession.invalid() }
            try NativeConnectionSession.fields(root, ["format", "entries"])
            guard root["format"] as? String == "aibro.connection-vault.v1", let entries = root["entries"] as? [String: Any], entries.count <= 32 else { throw NativeConnectionSession.invalid() }
            for (key, raw) in entries {
                guard let row = raw as? [String: Any], let binding = row["binding"] as? [String: Any] else { throw NativeConnectionSession.invalid() }
                try NativeConnectionSession.fields(row, ["binding", "revision", "value"])
                guard try NativeConnectionSession.bindingKey(binding) == key, try NativeConnectionSession.integer(row["revision"]) > 0 else { throw NativeConnectionSession.invalid() }
                try Self.connectionValue(row["value"], binding: binding)
            }
            return entries
        } catch { throw AgendaError.message("[CONNECTION_STORAGE_ERROR] 连接配置无法读取，原文件已保留。") }
    }
    private static func connectionValue(_ raw: Any?, binding: [String: Any]) throws {
        if raw is NSNull { return }
        guard let value = raw as? [String: Any], let actual = value["binding"] as? [String: Any] else { throw NativeConnectionSession.invalid() }
        try NativeConnectionSession.fields(value, ["format", "binding", "role", "device", "trustedOwner", "registeredSessionId", "status", "epoch", "revision", "profiles", "activeProfiles", "pending"], optional: ["trustedRecipients"])
        guard value["format"] as? String == "aibro.connection-sync-local.v1", try NativeConnectionSession.bindingKey(actual) == NativeConnectionSession.bindingKey(binding),
              ["owner", "reader"].contains(value["role"] as? String ?? ""), ["local", "owner", "pending", "approved"].contains(value["status"] as? String ?? ""),
              let device = value["device"] as? [String: Any], let profiles = value["profiles"] as? [String: Any], profiles.count <= 32,
              let active = value["activeProfiles"] as? [String: Any], active.count <= 32 else { throw NativeConnectionSession.invalid() }
        _ = try NativeConnectionSession.integer(value["epoch"]); _ = try NativeConnectionSession.integer(value["revision"])
        try NativeConnectionSession.fields(device, ["publicJwk", "privateJwk", "fingerprint", "secret"])
        _ = try NativeConnectionSession.base64(device["secret"], bytes: 32); _ = try NativeConnectionSession.base64(device["fingerprint"], bytes: 32)
        guard device["publicJwk"] is [String: Any], device["privateJwk"] is [String: Any],
              value["trustedOwner"] is NSNull || value["trustedOwner"] is [String: Any],
              value["registeredSessionId"] is NSNull || NativeConnectionSession.isID(value["registeredSessionId"]),
              value["pending"] is NSNull || value["pending"] is [String: Any] else { throw NativeConnectionSession.invalid() }
        if let pins = value["trustedRecipients"] {
            guard let map = pins as? [String: Any], map.count <= 15 else { throw NativeConnectionSession.invalid() }
            for (fingerprint, pin) in map {
                _ = try NativeConnectionSession.base64(fingerprint, bytes: 32)
                guard let pin = pin as? [String: Any], pin["fingerprint"] as? String == fingerprint, pin["publicJwk"] is [String: Any] else { throw NativeConnectionSession.invalid() }
                try NativeConnectionSession.fields(pin, ["fingerprint", "publicJwk"])
            }
        }
        for (id, row) in profiles {
            guard NativeConnectionSession.isID(id), let row = row as? [String: Any], let deleted = row["deleted"] as? NSNumber, CFGetTypeID(deleted) == CFBooleanGetTypeID(),
                  row["hash"] is String else { throw NativeConnectionSession.invalid() }
            try NativeConnectionSession.fields(row, ["epoch", "version", "deleted", "hash"], optional: ["key", "profile"])
            guard try NativeConnectionSession.integer(row["epoch"]) > 0, try NativeConnectionSession.integer(row["version"]) > 0 else { throw NativeConnectionSession.invalid() }
            if deleted.boolValue { guard row["key"] == nil, row["profile"] == nil, active[id] == nil else { throw NativeConnectionSession.invalid() } }
            else {
                _ = try NativeConnectionSession.base64(row["key"], bytes: 32)
                guard let profile = row["profile"] as? [String: Any], let enabled = active[id] as? [String: Any],
                      NSDictionary(dictionary: profile).isEqual(to: enabled) else { throw NativeConnectionSession.invalid() }
                try Self.connectionProfile(profile)
            }
        }
        guard Set(active.keys).isSubset(of: Set(profiles.keys)) else { throw NativeConnectionSession.invalid() }
        if let pending = value["pending"] as? [String: Any] {
            try NativeConnectionSession.fields(pending, ["operation", "payload", "candidate"])
            guard let operation = pending["operation"] as? String, ["commit", "approve", "rotate_and_revoke"].contains(operation),
                  let payload = pending["payload"] as? [String: Any], let candidate = pending["candidate"] as? [String: Any] else { throw NativeConnectionSession.invalid() }
            let extra = operation == "approve" ? ["deviceId", "wraps"] : operation == "commit" ? ["profiles"] : ["newEpoch", "revokeDeviceIds", "profiles"]
            try NativeConnectionSession.fields(payload, ["opId", "expectedEpoch", "expectedRevision"] + extra)
            guard NativeConnectionSession.isID(payload["opId"]), try NativeConnectionSession.integer(payload["expectedEpoch"]) > 0,
                  try NativeConnectionSession.integer(payload["expectedRevision"]) > 0,
                  Set(candidate.keys).isSubset(of: ["profiles", "activeProfiles", "trustedRecipients"]) else { throw NativeConnectionSession.invalid() }
            // The shared coordinator validates encrypted protocol details. Native
            // storage owns the typed local envelope, binding, bounds and CAS.
        }
    }
    private static func connectionProfile(_ profile: [String: Any]) throws {
        try NativeConnectionSession.fields(profile, ["format", "purpose", "provider", "authKind", "apiFormat", "baseUrl", "model", "apiKey"], optional:["language"])
        guard profile["format"] as? String == "aibro.connection-profile.v1", profile["authKind"] as? String == "api-key",
              let purpose = profile["purpose"] as? String, let provider = profile["provider"] as? String,
              let format = profile["apiFormat"] as? String, let base = profile["baseUrl"] as? String,
              let model = profile["model"] as? String, !model.isEmpty, model.utf8.count <= 256,
              let key = profile["apiKey"] as? String, !key.isEmpty, key.utf8.count <= 16384,
              key.utf8.allSatisfy({ $0 >= 33 && $0 <= 126 }), !key.contains("{"), !key.contains("}"),
              !["sk-ant-oat", "sk-ant-ort", "sk-ant-sid"].contains(where: { key.hasPrefix($0) }) else { throw NativeConnectionSession.invalid() }
        let supported = provider == "openai-compatible" && ((purpose == "chat" && ["chat-completions", "responses"].contains(format)) || (purpose == "embedding" && format == "embeddings") || (purpose == "speech" && format == "audio-transcriptions")) || (provider == "anthropic-api" && purpose == "chat" && format == "anthropic-messages") || (provider == "aliyun" && purpose == "speech" && format == "aliyun-multimodal")
        guard supported else { throw NativeConnectionSession.invalid() }
        if let raw = profile["language"] {
            guard purpose == "speech", let language = raw as? String, language.utf8.count <= 16,
                  language.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || $0 == 45 }) else { throw NativeConnectionSession.invalid() }
        }
        _ = try NativeConnectionSession.url(base, originOnly: false)
    }
    func connectionCall(_ action: String, _ options: [String: Any], session: NativeConnectionSession, access: NativeConnectionAccess? = nil) throws -> [String: Any] {
        if action == "sessionSnapshot" {
            try NativeConnectionSession.fields(options, [])
            return try session.withSession { current in try NativeConnectionAccess.perform(access) { current.snapshot } }
        }
        guard ["read", "compareAndSwap"].contains(action) else { throw NativeConnectionSession.invalid() }
        let fields = action == "read" ? ["binding", "sessionFence"] : ["binding", "sessionFence", "expectedRevision", "value"]
        try NativeConnectionSession.fields(options, fields)
        guard let binding = options["binding"] as? [String: Any], let fence = options["sessionFence"] as? [String: Any] else { throw NativeConnectionSession.invalid() }
        let slot = try NativeConnectionSession.bindingKey(binding)
        // Lock order: cloud-session directory -> credential process -> credential
        // directory -> page lease. No JS/main-thread calls under these locks.
        return try session.withSession { current in
            try current.check(binding: binding, fence: fence)
            Self.lock.lock(); defer { Self.lock.unlock() }
            return try withStore(create: action == "compareAndSwap") { fd in
                var entries = try connectionEntries(at: fd)
                let existing = entries[slot] as? [String: Any], revision = try NativeConnectionSession.integer(existing?["revision"] ?? 0)
                if action == "read" { return try NativeConnectionAccess.perform(access) { ["revision": revision, "value": existing?["value"] ?? NSNull()] } }
                let expected = try NativeConnectionSession.integer(options["expectedRevision"])
                guard expected < 9007199254740991 else { throw NativeConnectionSession.invalid() }
                try Self.connectionValue(options["value"], binding: binding)
                guard expected == revision else { return ["swapped": false] }
                guard let fd else { throw NativeConnectionSession.invalid() }
                entries[slot] = ["binding": binding, "revision": expected + 1, "value": options["value"] ?? NSNull()]
                guard entries.count <= 32 else { throw NativeConnectionSession.invalid() }
                let plain = try JSONSerialization.data(withJSONObject: ["format": "aibro.connection-vault.v1", "entries": entries], options: [.sortedKeys])
                guard plain.count <= Self.connectionLimit else { throw AgendaError.message("[CONNECTION_STORAGE_ERROR] 连接配置超过 4 MiB。") }
                return try NativeConnectionAccess.perform(access) {
                    let key = try encryptionKey(at: fd, create: true)
                    guard let sealed = try AES.GCM.seal(plain, using: key, authenticating: authenticatedData("connections")).combined else { throw NativeConnectionSession.invalid() }
                    try atomicWrite(sealed, name: "connections.sealed", at: fd, limit: Self.connectionLimit + 28)
                    return ["swapped": true]
                }
            }
        }
    }
    func exportSavedAPI(_ options: [String: Any], verify: Bool = false, access: NativeConnectionAccess? = nil) throws -> [String: Any] {
        try NativeConnectionSession.fields(options, verify ? ["apiFormat", "sourceDigest"] : ["apiFormat"])
        guard let format = options["apiFormat"] as? String, ["chat-completions", "responses"].contains(format) else { throw NativeConnectionSession.invalid() }
        return try exportSavedProfile(options, verify:verify, access:access) { record in
            guard let base=record["base"] as? String,let model=record["model"] as? String,let key=record["token"] as? String else {throw NativeConnectionSession.invalid()}
            return ["format":"aibro.connection-profile.v1","purpose":"chat","provider":"openai-compatible","authKind":"api-key","apiFormat":format,"baseUrl":base,"model":model,"apiKey":key]
        }
    }
    /// Snapshot + digest are taken under the existing ciphertext store lock.
    /// The caller supplies a strict source-specific mapping, never a fallback
    /// credential slot or a legacy Keychain read.
    func exportSavedProfile(_ options:[String:Any],verify:Bool,access:NativeConnectionAccess?,
                            transform:([String:Any]) throws -> [String:Any]) throws -> [String:Any] {
        Self.lock.lock(); defer { Self.lock.unlock() }
        return try withStore(create: false) { fd in
            guard let envelope = try localRecord("api", at: fd), envelope["removed"] as? Bool != true,
                  let record = envelope["record"] as? [String: Any], let base = record["base"] as? String else {
                throw AgendaError.message("[CONNECTION_SOURCE_UNAVAILABLE] 请先完整保存要共享的 API 连接；不会自动读取或迁移旧钥匙串。")
            }
            _ = try validate(record, origin: Self.origin(base))
            let profile = try transform(record)
            try Self.connectionProfile(profile)
            let bytes = try JSONSerialization.data(withJSONObject: ["record": record, "profile": profile], options: [.sortedKeys])
            let digest = NativeConnectionSession.digest(bytes)
            return try NativeConnectionAccess.perform(access) {
                if verify {
                    guard options["sourceDigest"] as? String == digest else { throw AgendaError.message("[CONNECTION_SOURCE_CHANGED] 已保存的 API 配置已变化，请重新预览后确认。") }
                    return ["valid": true]
                }
                return ["profile": profile, "sourceDigest": digest]
            }
        }
    }
}

/// A revocable page lease. Invalidation and the final local commit serialize;
/// waiting for another process's session lock never holds this UI-facing lock.
final class NativeConnectionAccess: @unchecked Sendable {
    final class Gate: @unchecked Sendable {
        private let lock = NSLock()
        private var generation = UUID()
        func invalidate() { lock.lock(); generation = UUID(); lock.unlock() }
        func capture() -> NativeConnectionAccess { lock.lock(); defer { lock.unlock() }; return NativeConnectionAccess(gate: self, generation: generation) }
        fileprivate func perform<T>(_ expected: UUID, _ body: () throws -> T) throws -> T {
            lock.lock(); defer { lock.unlock() }
            guard expected == generation else { throw NativeConnectionSession.changed() }
            return try body()
        }
    }
    private let gate: Gate, generation: UUID
    private init(gate: Gate, generation: UUID) { self.gate = gate; self.generation = generation }
    static func perform<T>(_ access: NativeConnectionAccess?, _ body: () throws -> T) throws -> T {
        if let access { return try access.gate.perform(access.generation, body) }; return try body()
    }
}

/// Reads Python's sole cloud session under its directory-inode flock. The token
/// is transient input to a process-salted fence; it never enters the Swift vault.
final class NativeConnectionSession: @unchecked Sendable {
    let folder: URL
    private static let salt = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
    init(dataDirectory: URL) { folder = dataDirectory.appendingPathComponent("cloud-sync") }
    static func invalid() -> Error { AgendaError.message("[CONNECTION_INVALID] 连接配置请求格式无效。") }
    static func changed() -> Error { AgendaError.message("[CONNECTION_SESSION_CHANGED] 云登录或工作区已变化，请重新连接后再同步配置。") }
    static func fields(_ value: [String: Any], _ required: [String], optional: [String] = []) throws {
        let keys = Set(value.keys)
        guard Set(required).isSubset(of: keys), keys.isSubset(of: Set(required + optional)) else { throw invalid() }
    }
    static func integer(_ value: Any?) throws -> Int64 {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
              n.doubleValue.rounded() == n.doubleValue, n.doubleValue >= 0, n.doubleValue <= 9007199254740991 else { throw invalid() }
        return n.int64Value
    }
    static func isID(_ value: Any?) -> Bool {
        guard let value = value as? String else { return false }
        return value.range(of: "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$", options: .regularExpression) != nil
    }
    static func encode(_ data: Data) -> String { data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
    static func base64(_ value: Any?, bytes: Int) throws -> Data {
        guard let value = value as? String, value.count == (bytes * 4 + 2) / 3,
              value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil,
              let data = Data(base64Encoded: value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - value.count % 4) % 4)),
              data.count == bytes, encode(data) == value else { throw invalid() }
        return data
    }
    static func digest(_ data: Data) -> String { encode(Data(SHA256.hash(data: data))) }
    static func url(_ value: String, originOnly: Bool) throws -> String {
        guard value.utf8.count <= 2048, !value.unicodeScalars.contains(where: CharacterSet.whitespacesAndNewlines.contains),
              let u = URLComponents(string: value), let host = u.host, !host.isEmpty, let scheme = u.scheme,
              u.user == nil, u.password == nil, u.query == nil, u.fragment == nil,
              scheme == "https" || (scheme == "http" && ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host)),
              u.port == nil || (1...65535).contains(u.port!), !originOnly || u.path.isEmpty || u.path == "/" else { throw invalid() }
        return try NativeCredentials.origin(value)
    }
    static func bindingKey(_ binding: [String: Any]) throws -> String {
        try fields(binding, ["serverOrigin", "accountId"])
        guard let origin = binding["serverOrigin"] as? String, try url(origin, originOnly: true) == origin, isID(binding["accountId"]) else { throw invalid() }
        return digest(try JSONSerialization.data(withJSONObject: binding, options: [.sortedKeys]))
    }
    struct Current {
        let snapshot: [String: Any]
        func check(binding: [String: Any], fence: [String: Any]) throws {
            try NativeConnectionSession.fields(fence, ["serverOrigin", "accountId", "sessionId", "generation", "nativeFence"])
            guard let session = snapshot["session"] as? [String: Any], try NativeConnectionSession.integer(fence["generation"]) > 0,
                  ["serverOrigin", "accountId", "sessionId", "nativeFence"].allSatisfy({ (session[$0] as? String) == (fence[$0] as? String) }),
                  binding["serverOrigin"] as? String == session["serverOrigin"] as? String,
                  binding["accountId"] as? String == session["accountId"] as? String else { throw NativeConnectionSession.changed() }
        }
    }
    func withSession<T>(_ body: (Current) throws -> T) throws -> T {
        let parent = Darwin.open(folder.deletingLastPathComponent().resolvingSymlinksInPath().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard parent >= 0 else { throw Self.changed() }; defer { Darwin.close(parent) }
        let directory = openat(parent, folder.lastPathComponent, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard directory >= 0 else { throw Self.changed() }; defer { Darwin.close(directory) }
        var directoryInfo = stat()
        guard fstat(directory, &directoryInfo) == 0, directoryInfo.st_uid == getuid(), directoryInfo.st_mode & 0o777 == 0o700 else { throw Self.changed() }
        while flock(directory, LOCK_EX) != 0 { if errno != EINTR { throw Self.changed() } }
        defer { _ = flock(directory, LOCK_UN) }
        let fd = openat(directory, "cloud-session.json", O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw Self.changed() }; defer { Darwin.close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(), info.st_mode & 0o777 == 0o600,
              info.st_nlink == 1, info.st_size > 0, info.st_size <= 65536 else { throw Self.changed() }
        var raw = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count < 0 && errno == EINTR { continue }; guard count >= 0 else { throw Self.changed() }
            if count == 0 { break }; raw.append(contentsOf: buffer.prefix(count)); guard raw.count <= 65536 else { throw Self.changed() }
        }
        let current: Current
        do {
            guard let value = try JSONSerialization.jsonObject(with: raw) as? [String: Any],
                  let metadata = value["connectionSession"] as? [String: Any],
                  let account = value["account"] as? [String: Any], let device = value["device"] as? [String: Any],
                  Self.isID(account["id"]), Self.isID(device["id"]), let token = value["accessToken"] as? String,
                  !token.isEmpty, token.utf8.count <= 32768, token.utf8.allSatisfy({ $0 >= 33 && $0 <= 126 }),
                  let server = value["serverUrl"] as? String, let origin = metadata["serverOrigin"] as? String,
                  let usable = metadata["usable"] as? NSNumber, CFGetTypeID(usable) == CFBooleanGetTypeID(), usable.boolValue,
                  try Self.integer(metadata["version"]) == 1 else { throw Self.changed() }
            try Self.fields(metadata, ["version", "generation", "usable", "serverOrigin"])
            _ = try Self.base64(metadata["generation"], bytes: 32); _ = try Self.url(server, originOnly: false)
            guard try Self.url(origin, originOnly: true) == origin else { throw Self.changed() }
            let fingerprint = try JSONSerialization.data(withJSONObject: ["workspace": folder.deletingLastPathComponent().standardizedFileURL.path, "generation": metadata["generation"]!, "token": token,
                "accountId": account["id"]!, "sessionId": device["id"]!, "serverUrl": server, "serverOrigin": origin], options: [.sortedKeys])
            let fence = Self.digest(Self.salt + fingerprint)
            current = Current(snapshot: ["session": ["serverOrigin": origin, "accountId": account["id"]!, "sessionId": device["id"]!, "generation": 1, "nativeFence": fence],
                "transport": ["serverUrl": server, "sessionGeneration": metadata["generation"]!]])
        } catch { throw Self.changed() }
        return try body(current)
    }
}

// Named schemes remain inside the purpose-specific encrypted envelope. The active
// record and scheme catalog change in one rename, so existing consumers/exporters
// observe the same committed configuration after a crash or concurrent window edit.
extension NativeCredentials {
    private struct ProfileCatalog {
        var rows: [String: Any]
        var active: String
        var revision: Int
    }
    private func profileCatalog(_ envelope: [String: Any]?) throws -> ProfileCatalog {
        guard let envelope else { return .init(rows: [:], active: "", revision: 0) }
        guard let raw = envelope["profiles"] else {
            if envelope["removed"] as? Bool == true { return .init(rows: [:], active: "", revision: envelope["profileRevision"] as? Int ?? 0) }
            guard let record = envelope["record"] as? [String: Any] else { throw failure("方案内容无效。") }
            return .init(rows: ["default": ["name": "默认方案", "record": record]], active: "default", revision: envelope["profileRevision"] as? Int ?? 0)
        }
        guard let rows = raw as? [String: Any], rows.count <= 32,
              let active = envelope["activeProfileID"] as? String,
              let revision = envelope["profileRevision"] as? Int, revision >= 0, revision < Int.max,
              active.isEmpty || rows[active] != nil else { throw failure("方案目录无效，原配置保留。") }
        for (id, value) in rows {
            guard Self.profileID(id), let row = value as? [String: Any],
                  let name = row["name"] as? String, !name.isEmpty, name.utf8.count <= 160,
                  let record = row["record"] as? [String: Any], let base = record["base"] as? String else { throw failure("方案内容无效。") }
            _ = try validate(record, origin: Self.origin(base))
        }
        if !active.isEmpty {
            guard let row = rows[active] as? [String: Any], let record = row["record"] as? [String: Any],
                  let current = envelope["record"] as? [String: Any],
                  NSDictionary(dictionary: record).isEqual(to: current), envelope["removed"] as? Bool == false else { throw failure("活动方案不一致。") }
        } else if envelope["record"] != nil || envelope["removed"] as? Bool != true { throw failure("活动方案不一致。") }
        return .init(rows: rows, active: active, revision: revision)
    }
    private static func profileID(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 80 && value.utf8.allSatisfy { (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }
    }
    private static func profileEndpoint(_ raw: String) throws -> String {
        _ = try origin(raw)
        guard var url = URLComponents(string: raw) else { throw AgendaError.message("API 地址无效。") }
        url.scheme = url.scheme?.lowercased(); url.host = url.host?.lowercased()
        if (url.scheme == "https" && url.port == 443) || (url.scheme == "http" && url.port == 80) { url.port = nil }
        while url.path.hasSuffix("/") { url.path.removeLast() }
        guard let value = url.string else { throw AgendaError.message("API 地址无效。") }; return value
    }
    private func profileEnvelope(_ channel: String, _ catalog: ProfileCatalog) -> [String: Any] {
        var value: [String: Any] = ["version": 2, "channel": channel, "removed": catalog.active.isEmpty,
                                  "profiles": catalog.rows, "activeProfileID": catalog.active, "profileRevision": catalog.revision]
        if let row = catalog.rows[catalog.active] as? [String: Any] { value["record"] = row["record"] }
        return value
    }
    private func profileMetadata(_ catalog: ProfileCatalog) -> [String: Any] {
        let rows: [[String: Any]] = catalog.rows.keys.sorted().compactMap { id in
            guard let row = catalog.rows[id] as? [String: Any], let record = row["record"] as? [String: Any] else { return nil }
            return ["id": id, "name": row["name"] as? String ?? "", "base": record["base"] as? String ?? "",
                    "model": record["model"] as? String ?? "", "settings": record["settings"] as? [String: Any] ?? [:]]
        }
        return ["profiles": rows, "activeProfileID": catalog.active, "revision": catalog.revision]
    }
    private func profileCall(_ channel: String, _ action: String, _ options: [String: Any]) throws -> [String: Any] {
        guard ["profile-list", "profile-read", "profile-save", "profile-select", "profile-remove"].contains(action) else { throw AgendaError.message("未知方案操作。") }
        let changing = ["profile-save", "profile-select", "profile-remove"].contains(action)
        return try withStore(create: changing) { fd in
            var catalog = try profileCatalog(localRecord(channel, at: fd))
            if changing || options["expectedRevision"] != nil {
                let revision = try NativeConnectionSession.integer(options["expectedRevision"])
                guard revision == catalog.revision else { throw AgendaError.message("[PROFILE_CHANGED] 方案已在另一处更新，请重新打开设置后再保存。") }
            }
            if action == "profile-list" { return profileMetadata(catalog) }
            guard let id = options["id"] as? String, Self.profileID(id) else { throw AgendaError.message("方案标识无效。") }
            let existing = catalog.rows[id] as? [String: Any]
            if action == "profile-read" {
                guard let record = existing?["record"] as? [String: Any], let base = options["base"] as? String,
                      let saved = record["base"] as? String, try Self.profileEndpoint(base) == Self.profileEndpoint(saved) else {
                    throw AgendaError.message("当前方案没有此服务地址的 Key，请重新填写。")
                }
                _ = try validate(record, origin: Self.origin(base))
                return ["base": saved, "model": record["model"] as? String ?? "", "token": record["token"] as? String ?? "", "settings": record["settings"] as? [String: Any] ?? [:]]
            }
            guard let fd else { throw failure("本机凭据目录不可用。") }
            if action == "profile-save" {
                let name = (options["name"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let base = (options["base"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let model = options["model"] as? String ?? ""
                let settings = options["settings"] as? [String: Any] ?? [:]
                guard !name.isEmpty, name.utf8.count <= 160, !name.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains),
                      model.utf8.count <= 8192, settings.count <= 32,
                      settings.values.allSatisfy({ $0 is String || $0 is NSNumber || $0 is NSNull }),
                      try JSONSerialization.data(withJSONObject: settings).count <= 8192,
                      existing != nil || catalog.rows.count < 32 else { throw AgendaError.message("方案名称或配置格式无效，最多保存 32 个方案。") }
                let origin = try Self.origin(base)
                var token = (options["token"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                let noKey = channel == "embedding" && settings["noKey"] as? Bool == true
                if noKey { token = "" }
                else if token.isEmpty {
                    guard let record = existing?["record"] as? [String: Any], let saved = record["base"] as? String,
                          try Self.profileEndpoint(saved) == Self.profileEndpoint(base), record["noKey"] as? Bool != true else {
                        throw AgendaError.message("请填写当前方案、当前服务地址的 API Key。")
                    }
                    token = record["token"] as? String ?? ""
                }
                guard (noKey || !token.isEmpty), token.utf8.count <= 16384,
                      !token.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { throw AgendaError.message("Key 格式无效。") }
                let record: [String: Any] = ["base": base, "origin": origin, "token": token, "model": model, "settings": settings, "noKey": noKey]
                catalog.rows[id] = ["name": name, "record": record]; catalog.active = id
            } else {
                guard existing != nil else { throw AgendaError.message("此方案已不存在，请重新打开设置。") }
                if action == "profile-select" { catalog.active = id }
                else { catalog.rows.removeValue(forKey: id); if catalog.active == id { catalog.active = "" } }
            }
            catalog.revision += 1
            try writeEnvelope(channel, profileEnvelope(channel, catalog), at: fd)
            blocked.remove(channel)
            return profileMetadata(catalog)
        }
    }
}
