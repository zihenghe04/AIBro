import Foundation
import Combine
import Security

struct NativeSpeechSecretAccess: Sendable {
    var load: @Sendable () async throws -> NativeSpeechConfiguration?
    var read: @Sendable (NativeSpeechConfiguration) async throws -> String
    var save: @Sendable (NativeSpeechConfiguration,String) async throws -> Void
    var remove: @Sendable () async throws -> Void
}

enum NativeSpeechCredentialAdapter {
    /// A new QuickTools/Speech directory and bundle-specific service only.
    /// No legacy path, keychain migration, or chat/ASR credential fallback.
    static func access(directory:URL,service:String)->NativeSpeechSecretAccess {
        let worker=NativeSpeechCredentialWorker(directory:directory,service:service)
        return .init(load:{try await worker.load()},read:{try await worker.read($0)},save:{try await worker.save($0,key:$1)},remove:{try await worker.remove()})
    }
}
private actor NativeSpeechCredentialWorker {
    private let credentials:NativeCredentials
    init(directory:URL,service:String) {
        var operations=NativeCredentials.Operations()
        operations.copy={_ in (errSecItemNotFound,nil)}
        operations.interaction={(errSecSuccess,false)}
        operations.setInteraction={_ in errSecSuccess}
        operations.beforeCommit={_ in try Task.checkCancellation()}
        credentials=NativeCredentials(folder:directory,legacy:nil,service:service,operations:operations)
    }
    func load() throws->NativeSpeechConfiguration? {
        try Task.checkCancellation()
        let status=credentials.status("api")
        guard status["error"]==nil else{throw NativeSpeechError.credential}
        guard status["available"] as? Bool==true else{return nil}
        guard let encoded=status["model"] as? String,let data=encoded.data(using:.utf8),
              let config=try? JSONDecoder().decode(NativeSpeechConfiguration.self,from:data),config.valid,
              status["base"] as? String==config.endpoint?.absoluteString else{throw NativeSpeechError.credential}
        try Task.checkCancellation();return config
    }
    func read(_ config:NativeSpeechConfiguration)throws->String {
        try Task.checkCancellation()
        guard config.valid,let saved=try load(),saved.credentialScope==config.credentialScope,let endpoint=config.endpoint else{throw NativeSpeechError.credential}
        let result=try credentials.call("api","read",["base":endpoint.absoluteString])
        try Task.checkCancellation()
        guard let token=result["token"] as? String,NativeSpeechService.validKey(token) else{throw NativeSpeechError.credential};return token
    }
    func save(_ config:NativeSpeechConfiguration,key:String)throws {
        try Task.checkCancellation()
        guard config.valid,let endpoint=config.endpoint,NativeSpeechService.validKey(key) else{throw NativeSpeechError.configuration}
        let metadata=String(decoding:try JSONEncoder().encode(config),as:UTF8.self)
        _ = try credentials.call("api","save",["base":endpoint.absoluteString,"token":key,"model":metadata])
        try Task.checkCancellation()
    }
    func remove()throws {try Task.checkCancellation();_ = try credentials.call("api","remove",[:]);try Task.checkCancellation()}
}

/// Availability and revision invalidate late reads/publication. Explicit writes
/// already atomically committed are not rolled back; a later load reads the true
/// saved state. Worker cancellation is checked before the credential commit.
@MainActor final class NativeSpeechSettings: ObservableObject {
    @Published private(set) var configuration=NativeSpeechConfiguration()
    @Published private(set) var configured=false
    @Published private(set) var available=false
    @Published private(set) var error:String?
    @Published private(set) var busy=false
    @Published private(set) var revision=0
    private var owner:URL?,access:NativeSpeechSecretAccess?,operation:UUID?
    private var cancelWork:(()->Void)?
    func configure(owner:URL,access:NativeSpeechSecretAccess) {
        guard self.owner==nil || self.owner==owner else{setAvailable(false);return}
        guard self.owner==nil else{return}
        self.owner=owner;self.access=access;revision+=1;reload()
    }
    func setAvailable(_ value:Bool) {
        let value=value && access != nil
        guard available != value else{return}
        available=value;revision+=1;cancelWork?();cancelWork=nil;operation=nil;busy=false;error=nil
        if value{reload()}
    }
    private func reload() {
        guard let access else{return}
        let id=UUID(),version=revision;operation=id;busy=true
        let work=Task.detached {try await access.load()};cancelWork={work.cancel()}
        Task { [weak self] in
            do {
                let value=try await work.value
                guard let self,self.operation==id,self.revision==version else{return}
                if let value,!value.valid{throw NativeSpeechError.configuration}
                self.configuration=value ?? .init();self.configured=value != nil;self.error=nil;self.finish(id)
            } catch {
                guard let self,self.operation==id,self.revision==version else{return}
                self.configured=false;self.error=NativeSpeechError.credential.localizedDescription;self.finish(id)
            }
        }
    }
    private func finish(_ id:UUID){guard operation==id else{return};operation=nil;cancelWork=nil;busy=false}
    @discardableResult func save(_ config:NativeSpeechConfiguration,key:String) async->Bool {
        guard available,!busy,config.valid,let access else{return false}
        let key=key.trimmingCharacters(in:.whitespacesAndNewlines)
        guard key.isEmpty || NativeSpeechService.validKey(key) else{error=NativeSpeechError.credential.localizedDescription;return false}
        let id=UUID();revision+=1;let version=revision;operation=id;busy=true;error=nil
        let work=Task.detached {
            try Task.checkCancellation()
            let actual=key.isEmpty ? try await access.read(config):key
            try Task.checkCancellation();guard NativeSpeechService.validKey(actual) else{throw NativeSpeechError.credential}
            try await access.save(config,actual);try Task.checkCancellation()
        };cancelWork={work.cancel()}
        defer{finish(id)}
        do {
            try await withTaskCancellationHandler(operation:{try await work.value},onCancel:{work.cancel()})
            guard available,revision==version,operation==id,!Task.isCancelled else{return false}
            configuration=config;configured=true;return true
        } catch {
            guard available,revision==version,operation==id,!Task.isCancelled else{return false}
            self.error=NativeSpeechError.credential.localizedDescription;return false
        }
    }
    @discardableResult func remove() async->Bool {
        guard available,!busy,let access else{return false}
        let id=UUID();revision+=1;let version=revision;operation=id;busy=true;error=nil
        let work=Task.detached {try Task.checkCancellation();try await access.remove();try Task.checkCancellation()};cancelWork={work.cancel()}
        defer{finish(id)}
        do {
            try await withTaskCancellationHandler(operation:{try await work.value},onCancel:{work.cancel()})
            guard available,revision==version,operation==id,!Task.isCancelled else{return false}
            configuration = .init();configured=false;return true
        }catch{
            guard available,revision==version,operation==id,!Task.isCancelled else{return false}
            self.error=NativeSpeechError.credential.localizedDescription;return false
        }
    }
    func connection() async throws->(NativeSpeechConfiguration,String) {
        guard available,!busy,configured,configuration.valid,let access else{throw NativeSpeechError.unavailable}
        let config=configuration,version=revision
        let work=Task.detached {try Task.checkCancellation();return try await access.read(config)}
        do {
            let key=try await withTaskCancellationHandler(operation:{try await work.value},onCancel:{work.cancel()})
            try Task.checkCancellation()
            guard available,!busy,configured,revision==version,configuration==config else{throw NativeSpeechError.changed}
            guard NativeSpeechService.validKey(key) else{throw NativeSpeechError.credential};return(config,key)
        } catch is CancellationError{throw CancellationError()}
        catch let error as NativeSpeechError{throw error}
        catch{throw NativeSpeechError.credential}
    }
}
