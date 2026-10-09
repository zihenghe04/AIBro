import Foundation
import Security

enum AgendaError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case let .message(text) = self { return text }; return nil }
}

@main struct SeedSyntheticSpeech {
    static func main() throws {
        guard CommandLine.arguments.count == 2 else { throw AgendaError.message("One isolated QA workspace is required") }
        let root = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
        let temporary = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
        guard root.deletingLastPathComponent().resolvingSymlinksInPath() == temporary,
              root.lastPathComponent.hasPrefix("aibro-native-qa-"),
              UUID(uuidString: String(root.lastPathComponent.dropFirst("aibro-native-qa-".count))) != nil,
              root.resolvingSymlinksInPath() == root else { throw AgendaError.message("Refuse non-QA directory") }
        let parent = root.appendingPathComponent("qa-quick-tools", isDirectory:true)
        try FileManager.default.createDirectory(at:parent,withIntermediateDirectories:false,attributes:[.posixPermissions:0o700])
        let folder = parent.appendingPathComponent("Speech",isDirectory:true)
        guard !FileManager.default.fileExists(atPath:folder.path) else { throw AgendaError.message("Do not overwrite an existing speech store") }
        var operations = NativeCredentials.Operations()
        operations.copy = {_ in (errSecItemNotFound,nil)}
        operations.interaction = {(errSecSuccess,false)}
        operations.setInteraction = {_ in errSecSuccess}
        let store = NativeCredentials(folder:folder,legacy:nil,service:"app.ai-workstation.studio.speech",operations:operations)
        let metadata:[String:Any] = ["provider":"openAI","baseURL":"https://127.0.0.1:18448/v1","model":"synthetic-speech-model","language":""]
        let encoded = String(decoding:try JSONSerialization.data(withJSONObject:metadata,options:[.sortedKeys]),as:UTF8.self)
        _ = try store.call("api","save",["base":"https://127.0.0.1:18448/v1/audio/transcriptions","token":"synthetic-speech-key-not-a-real-secret","model":encoded])
        guard store.status("api")["available"] as? Bool == true else { throw AgendaError.message("Synthetic credential save was not acknowledged") }
        print("SYNTHETIC_SPEECH_SEEDED")
    }
}
