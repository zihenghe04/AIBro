import Foundation
import Combine

/// An independent ASR credential record. Config and Key commit atomically in
/// that record; neither chat/embedding credentials nor workspace sync are used.
struct NativeQuickASRSecretAccess {
    var load: () throws -> NativeQuickASRConfiguration?
    var read: (NativeQuickASRConfiguration) throws -> String
    var save: (NativeQuickASRConfiguration,String) throws -> Void
    var remove: () throws -> Void
}

/// Unsaved settings are memory-only. A host quit/navigation guard can return
/// to the same draft; the Key is never serialized into the recording library.
struct NativeQuickASRSettingsDraft {
    var configuration: NativeQuickASRConfiguration
    var key: String
}

@MainActor final class NativeQuickASRSettings: ObservableObject {
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
    func setAvailable(_ value: Bool) { available = value && access != nil }
    private func reload() {
        do {
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
    func connection() throws -> (NativeQuickASRConfiguration,String) {
        guard available, configured, configuration.enabled, configuration.valid, let access else { throw NativeQuickASRError.unavailable }
        return (configuration,try access.read(configuration))
    }
}
