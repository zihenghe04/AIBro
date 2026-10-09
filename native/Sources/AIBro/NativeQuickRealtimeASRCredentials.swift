import Foundation

enum NativeQuickASRCredentialAdapter {
    /// `directory` must be a NEW ASR-specific folder under the host's private
    /// QuickTools directory. Never pass desktop.credentials or its directory.
    static func access(directory: URL, service: String) -> NativeQuickASRSecretAccess {
        let credentials = NativeCredentials(folder: directory, legacy: nil, service: service)
        return .init(load: {
            let status = credentials.status("api")
            guard status["error"] == nil else { throw NativeQuickASRError.unavailable }
            guard status["available"] as? Bool == true else { return nil }
            guard let encoded = status["model"] as? String, let bytes = encoded.data(using: .utf8),
                  let config = try? JSONDecoder().decode(NativeQuickASRConfiguration.self, from: bytes), config.valid,
                  status["base"] as? String == config.origin else { throw NativeQuickASRError.configuration }
            return config
        }, read: { config in
            let status = credentials.status("api")
            // No legacy migration/keychain lookup for this new capability.
            guard status["available"] as? Bool == true, status["base"] as? String == config.origin else { throw NativeQuickASRError.configuration }
            let result = try credentials.call("api","read",["base":config.origin])
            guard let key = result["token"] as? String, !key.isEmpty else { throw NativeQuickASRError.configuration }; return key
        }, save: { config,key in
            guard config.valid else { throw NativeQuickASRError.configuration }
            let metadata = String(decoding: try JSONEncoder().encode(config), as: UTF8.self)
            _ = try credentials.call("api","save",["base":config.origin,"token":key,"model":metadata])
        }, remove: { _ = try credentials.call("api","remove",[:]) }, profiles: { action, options in try credentials.call("api", action, options) })
    }
}
