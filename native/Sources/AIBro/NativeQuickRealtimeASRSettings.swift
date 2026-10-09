import Foundation
import Combine

/// An independent ASR credential record. Config and Key commit atomically in
/// that record; neither chat/embedding credentials nor workspace sync are used.
struct NativeQuickASRSecretAccess {
    var load: () throws -> NativeQuickASRConfiguration?
    var read: (NativeQuickASRConfiguration) throws -> String
    var save: (NativeQuickASRConfiguration,String) throws -> Void
    var remove: () throws -> Void
    var profiles: ((String, [String: Any]) throws -> [String: Any])? = nil
}

/// Unsaved settings are memory-only. A host quit/navigation guard can return
/// to the same draft; the Key is never serialized into the recording library.
struct NativeQuickASRSettingsDraft: Equatable {
    var profileID = "default"
    var name = "默认方案"
    var catalogRevision: Int? = nil
    var configuration: NativeQuickASRConfiguration
    var key: String
}

struct NativeQuickASRProfile: Identifiable, Equatable {
    let id: String
    let name: String
    let configuration: NativeQuickASRConfiguration
}

@MainActor final class NativeQuickASRSettings: ObservableObject {
    @Published private(set) var profiles: [NativeQuickASRProfile] = []
    @Published private(set) var activeProfileID = ""
    @Published private(set) var revision = 0
    @Published private(set) var testing = false
    @Published private(set) var testMessage: String?
    private var testTask: Task<Void, Never>?
    private var testSocket: (any NativeQuickASRSocket)?
    private var testGeneration = UUID()

    @Published private(set) var configuration = NativeQuickASRConfiguration()
    @Published private(set) var configured = false
    @Published private(set) var error: String?
    @Published private(set) var available = false
    private var access: NativeQuickASRSecretAccess?
    private var owner: URL?
    func configure(owner: URL, access: NativeQuickASRSecretAccess) {
        guard self.owner == nil || self.owner == owner else { self.available = false; return }
        guard self.owner == nil else { return }
        self.owner = owner; self.access = access; reload()
    }
    func setAvailable(_ value: Bool) { available = value && access != nil; if !available { cancelTest() } }
    private func reload() {
        do {
            if let profiles = access?.profiles { try apply(profiles("profile-list", [:])); return }
            let current = try access?.load()
            guard current?.valid != false else { throw NativeQuickASRError.configuration }
            configuration = current ?? .init(); configured = current != nil; error = nil
        } catch { configuration = .init(); configured = false; self.error = nativeUI("实时转写设置无法读取，原配置未改动。", "Realtime transcription settings could not be read. Existing settings are unchanged.") }
    }
    @discardableResult func save(_ value: NativeQuickASRConfiguration, key: String) -> Bool {
        guard available, value.valid, let access else { return false }
        let key = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard key.utf8.count <= 16384, !key.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { return false }
        do {
            // Empty retains a matching service Key only. Changing provider
            // origin never silently transfers a credential to the new origin.
            let actual = key.isEmpty ? try access.read(value) : key
            guard !actual.isEmpty else { throw NativeQuickASRError.configuration }
            try access.save(value,actual); configuration = value; configured = true; error = nil; return true
        } catch { self.error = nativeUI("未保存。请填写此地区与工作空间的百炼 Key；原配置保留。", "Not saved. Enter the Model Studio Key for this region and workspace; previous settings are retained."); return false }
    }
    @discardableResult func remove() -> Bool {
        guard available, let access else { return false }
        do { try access.remove(); configuration = .init(); configured = false; error = nil; return true }
        catch { self.error = nativeUI("未能删除实时转写配置，原设置保留。", "Realtime transcription settings could not be removed. Previous settings are retained."); return false }
    }
    private func apply(_ value: [String: Any]) throws {
        guard let rows = value["profiles"] as? [[String: Any]], let active = value["activeProfileID"] as? String,
              let revision = value["revision"] as? Int else { throw NativeQuickASRError.configuration }
        let decoded: [NativeQuickASRProfile] = try rows.map { row in
            guard let id = row["id"] as? String, let name = row["name"] as? String,
                  let metadata = row["model"] as? String, let data = metadata.data(using: .utf8),
                  let config = try? JSONDecoder().decode(NativeQuickASRConfiguration.self, from: data), config.valid,
                  row["base"] as? String == config.origin else { throw NativeQuickASRError.configuration }
            return .init(id: id, name: name, configuration: config)
        }
        let selected = decoded.first { $0.id == active }
        guard active.isEmpty || selected != nil else { throw NativeQuickASRError.configuration }
        profiles = decoded; activeProfileID = active; self.revision = revision
        configuration = selected?.configuration ?? .init(); configured = selected != nil; error = nil
    }
    func draft(for id: String? = nil) -> NativeQuickASRSettingsDraft {
        let id = id ?? activeProfileID
        if let profile = profiles.first(where: { $0.id == id }) {
            return .init(profileID: profile.id, name: profile.name, catalogRevision: revision, configuration: profile.configuration, key: "")
        }
        return .init(catalogRevision: revision, configuration: configuration, key: "")
    }
    @discardableResult func save(_ draft: NativeQuickASRSettingsDraft) -> Bool {
        guard available, !testing, draft.configuration.valid else { return false }
        guard let call = access?.profiles else { return save(draft.configuration, key: draft.key) }
        do {
            let metadata = String(decoding: try JSONEncoder().encode(draft.configuration), as: UTF8.self)
            try apply(call("profile-save", ["id": draft.profileID, "name": draft.name,
                "base": draft.configuration.origin, "model": metadata, "token": draft.key,
                "expectedRevision": draft.catalogRevision ?? revision]))
            cancelTest(); return true
        } catch { self.error = nativeUI("未保存。请检查方案名称及此地区、工作空间的 Key；原配置保留。", "Not saved. Check the scheme name and Key for this region/workspace; previous settings are retained."); return false }
    }
    @discardableResult func removeProfile(_ id: String) -> Bool {
        guard available, !testing, let call = access?.profiles else { return false }
        do { try apply(call("profile-remove", ["id": id, "expectedRevision": revision])); cancelTest(); return true }
        catch { self.error = nativeUI("未删除。方案可能已在另一处修改，请重新打开设置。", "Not removed. The scheme may have changed elsewhere; reopen settings."); return false }
    }
    func cancelTest() {
        testGeneration = UUID(); testTask?.cancel(); testTask = nil
        testSocket?.close(); testSocket = nil; testing = false; testMessage = nil
    }
    /// Validate the actual configured WebSocket session without acquiring a mic
    /// or sending audio. session.updated confirms authentication and options.
    func testConnection(_ draft: NativeQuickASRSettingsDraft,
                        factory: @escaping NativeQuickRealtimeASRSession.Factory = { NativeQuickASRWebSocket(request: $0) }) {
        guard available, !testing, draft.configuration.valid else { return }
        cancelTest(); let generation = testGeneration; testing = true
        testTask = Task { [weak self] in
            guard let self else { return }
            var deadline: Task<Void, Never>?
            defer { deadline?.cancel(); if self.testGeneration == generation { self.testSocket?.close(); self.testSocket = nil; self.testing = false; self.testTask = nil } }
            do {
                var key = draft.key.trimmingCharacters(in: .whitespacesAndNewlines)
                if key.isEmpty {
                    if let call = self.access?.profiles {
                        key = try call("profile-read", ["id": draft.profileID, "base": draft.configuration.origin, "expectedRevision": draft.catalogRevision ?? self.revision])["token"] as? String ?? ""
                    } else { key = try self.access?.read(draft.configuration) ?? "" }
                }
                try Task.checkCancellation()
                let socket = factory(try draft.configuration.request(key: key)); self.testSocket = socket
                deadline = Task { [weak self, weak socket] in
                    try? await Task.sleep(for: .seconds(10))
                    guard !Task.isCancelled, let self, self.testGeneration == generation else { return }
                    socket?.close()
                }
                try await socket.send(String(decoding: JSONSerialization.data(withJSONObject: draft.configuration.update), as: UTF8.self))
                for _ in 0..<16 {
                    let bytes = try await socket.receive(); try Task.checkCancellation()
                    guard self.available, self.testGeneration == generation else { return }
                    guard let event = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw NativeQuickASRError.invalidMessage }
                    if event["type"] as? String == "session.updated" {
                        self.testMessage = nativeUI("连接成功，实时转写配置已被服务接受。未录音或上传音频。", "Connected. Realtime settings were accepted. No microphone or audio upload was used."); return
                    }
                    if event["type"] as? String == "error" { throw NativeQuickASRError.configuration }
                }
                throw NativeQuickASRError.invalidMessage
            } catch {
                guard self.available, self.testGeneration == generation, !Task.isCancelled else { return }
                self.testMessage = nativeUI("连接未通过。请检查地区、工作空间、Key 及网络后重试；当前配置未改动。", "Connection failed. Check region, workspace, Key and network; saved settings are unchanged.")
            }
        }
    }
    func connection() throws -> (NativeQuickASRConfiguration,String) {
        guard available, configured, configuration.enabled, configuration.valid, let access else { throw NativeQuickASRError.unavailable }
        if let call = access.profiles {
            let result = try call("profile-read", ["id": activeProfileID, "base": configuration.origin, "expectedRevision": revision])
            guard let key = result["token"] as? String, !key.isEmpty else { throw NativeQuickASRError.configuration }
            return (configuration, key)
        }
        return (configuration,try access.read(configuration))
    }
}
