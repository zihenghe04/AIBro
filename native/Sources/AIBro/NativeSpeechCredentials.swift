import Foundation
import Combine
import Security

/// Public metadata only. Secrets never enter the picker or a persisted draft.
struct NativeSpeechScheme: Equatable, Sendable, Identifiable {
    var id:String
    var name:String
    var configuration:NativeSpeechConfiguration
    static let legacyID="default"
    static func validName(_ value:String)->Bool {
        let value=value.trimmingCharacters(in:.whitespacesAndNewlines)
        return !value.isEmpty && value.utf8.count<=160 && !value.unicodeScalars.contains(where:CharacterSet.controlCharacters.contains)
    }
}
struct NativeSpeechSchemeList: Equatable, Sendable {
    var revision:Int
    var selectedID:String?
    var schemes:[NativeSpeechScheme]
    var selected:NativeSpeechScheme? {schemes.first{$0.id==selectedID}}
}
struct NativeSpeechSchemeAccess: Sendable {
    var list:@Sendable () async throws -> NativeSpeechSchemeList
    var read:@Sendable (String,NativeSpeechConfiguration,Int) async throws -> String
    var save:@Sendable (String,String,NativeSpeechConfiguration,String,Int) async throws -> NativeSpeechSchemeList
    var select:@Sendable (String,Int) async throws -> NativeSpeechSchemeList
    var remove:@Sendable (String,Int) async throws -> NativeSpeechSchemeList
}

struct NativeSpeechSecretAccess: Sendable {
    var load: @Sendable () async throws -> NativeSpeechConfiguration?
    var read: @Sendable (NativeSpeechConfiguration) async throws -> String
    var save: @Sendable (NativeSpeechConfiguration,String) async throws -> Void
    var remove: @Sendable () async throws -> Void
    var schemes: NativeSpeechSchemeAccess? = nil
}

extension NativeCredentials {
    func exportSavedSpeech(_ options:[String:Any],verify:Bool=false,access:NativeConnectionAccess?=nil)throws->[String:Any] {
        try NativeConnectionSession.fields(options,verify ? ["sourceDigest"] : [])
        return try exportSavedProfile(options,verify:verify,access:access) { record in
            guard let metadata=record["model"] as? String,let data=metadata.data(using:.utf8),
                  let config=try? JSONDecoder().decode(NativeSpeechConfiguration.self,from:data),config.valid,
                  let endpoint=config.endpoint,record["base"] as? String == endpoint.absoluteString,
                  let key=record["token"] as? String,NativeSpeechService.validKey(key) else {throw NativeSpeechError.credential}
            let aliyun=config.provider == .aliyun
            var profile:[String:Any]=["format":"aibro.connection-profile.v1","purpose":"speech","provider":aliyun ? "aliyun":"openai-compatible", "authKind":"api-key","apiFormat":aliyun ? "aliyun-multimodal":"audio-transcriptions","baseUrl":endpoint.absoluteString,"model":config.model,"apiKey":key]
            if !config.language.isEmpty {profile["language"]=config.language}
            return profile
        }
    }
}

enum NativeSpeechCredentialAdapter {
    /// A new QuickTools/Speech directory and bundle-specific service only.
    /// No legacy path, keychain migration, or chat/ASR credential fallback.
    static func access(directory:URL,service:String,beforeCommit:@escaping @Sendable(String)throws->Void = {_ in})->NativeSpeechSecretAccess {
        let worker=NativeSpeechCredentialWorker(directory:directory,service:service,beforeCommit:beforeCommit)
        return .init(load:{try await worker.load()},read:{try await worker.read($0)},save:{try await worker.save($0,key:$1)},remove:{try await worker.remove()},schemes:.init(
            list:{try await worker.list()},read:{try await worker.readScheme($0,configuration:$1,revision:$2)},
            save:{try await worker.saveScheme($0,name:$1,configuration:$2,key:$3,revision:$4)},
            select:{try await worker.selectScheme($0,revision:$1)},remove:{try await worker.removeScheme($0,revision:$1)}))
    }
}
private actor NativeSpeechCredentialWorker {
    private let credentials:NativeCredentials
    init(directory:URL,service:String,beforeCommit:@escaping @Sendable(String)throws->Void) {
        var operations=NativeCredentials.Operations()
        operations.copy={_ in (errSecItemNotFound,nil)}
        operations.interaction={(errSecSuccess,false)}
        operations.setInteraction={_ in errSecSuccess}
        operations.beforeCommit={name in try Task.checkCancellation();try beforeCommit(name);try Task.checkCancellation()}
        credentials=NativeCredentials(folder:directory,legacy:nil,service:service,operations:operations)
    }
    private func decodeList(_ value:[String:Any])throws->NativeSpeechSchemeList {
        guard let rows=value["profiles"] as? [[String:Any]],let revision=value["revision"] as? Int,
              let selected=value["activeProfileID"] as? String,rows.count<=32,revision>=0 else{throw NativeSpeechError.credential}
        let schemes=try rows.map { row -> NativeSpeechScheme in
            guard let id=row["id"] as? String,!id.isEmpty,let name=row["name"] as? String,NativeSpeechScheme.validName(name),
                  let metadata=row["model"] as? String,let bytes=metadata.data(using:.utf8),
                  let config=try? JSONDecoder().decode(NativeSpeechConfiguration.self,from:bytes),config.valid,
                  row["base"] as? String==config.endpoint?.absoluteString else{throw NativeSpeechError.credential}
            return .init(id:id,name:name,configuration:config)
        }
        guard Set(schemes.map(\.id)).count==schemes.count,selected.isEmpty || schemes.contains(where:{$0.id==selected}) else{throw NativeSpeechError.credential}
        return .init(revision:revision,selectedID:selected.isEmpty ? nil:selected,schemes:schemes)
    }
    func list()throws->NativeSpeechSchemeList {
        try Task.checkCancellation();return try decodeList(credentials.call("api","profile-list",[:]))
    }
    func readScheme(_ id:String,configuration:NativeSpeechConfiguration,revision:Int)throws->String {
        try Task.checkCancellation()
        let snapshot=try list()
        guard snapshot.revision==revision,let saved=snapshot.schemes.first(where:{$0.id==id}),
              saved.configuration.credentialScope==configuration.credentialScope,let endpoint=configuration.endpoint else{throw NativeSpeechError.changed}
        let result=try credentials.call("api","profile-read",["id":id,"base":endpoint.absoluteString,"expectedRevision":revision])
        try Task.checkCancellation()
        guard try list().revision==revision,let key=result["token"] as? String,NativeSpeechService.validKey(key) else{throw NativeSpeechError.changed}
        return key
    }
    func saveScheme(_ id:String,name:String,configuration:NativeSpeechConfiguration,key:String,revision:Int)throws->NativeSpeechSchemeList {
        try Task.checkCancellation()
        guard configuration.valid,NativeSpeechScheme.validName(name),let endpoint=configuration.endpoint else{throw NativeSpeechError.configuration}
        let actual=key.isEmpty ? try readScheme(id,configuration:configuration,revision:revision):key
        guard NativeSpeechService.validKey(actual) else{throw NativeSpeechError.credential}
        let metadata=String(decoding:try JSONEncoder().encode(configuration),as:UTF8.self)
        return try decodeList(credentials.call("api","profile-save",["id":id,"name":name.trimmingCharacters(in:.whitespacesAndNewlines),"base":endpoint.absoluteString,"model":metadata,"token":actual,"expectedRevision":revision]))
    }
    func selectScheme(_ id:String,revision:Int)throws->NativeSpeechSchemeList {
        try Task.checkCancellation();return try decodeList(credentials.call("api","profile-select",["id":id,"expectedRevision":revision]))
    }
    func removeScheme(_ id:String,revision:Int)throws->NativeSpeechSchemeList {
        try Task.checkCancellation();return try decodeList(credentials.call("api","profile-remove",["id":id,"expectedRevision":revision]))
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
    @Published private(set) var schemes:[NativeSpeechScheme]=[]
    @Published private(set) var selectedID:String?
    @Published private(set) var catalogRevision=0
    @Published private(set) var testing=false
    @Published private(set) var testResult:String?
    @Published private(set) var configuration=NativeSpeechConfiguration()
    @Published private(set) var configured=false
    @Published private(set) var available=false
    @Published private(set) var error:String?
    @Published private(set) var busy=false
    @Published private(set) var revision=0
    private var owner:URL?,access:NativeSpeechSecretAccess?,operation:UUID?
    private var cancelWork:(()->Void)?
    var didSave:(()->Void)?
    func configure(owner:URL,access:NativeSpeechSecretAccess) {
        guard self.owner==nil || self.owner==owner else{setAvailable(false);return}
        guard self.owner==nil else{return}
        self.owner=owner;self.access=access;revision+=1;reload()
    }
    func setAvailable(_ value:Bool) {
        let value=value && access != nil
        guard available != value else{return}
        available=value;revision+=1;cancelWork?();cancelWork=nil;operation=nil;busy=false;testing=false;testResult=nil;error=nil
        if value{reload()}
    }
    private func reload() {
        guard let access else{return}
        let id=UUID(),version=revision;operation=id;busy=true
        let work=Task.detached {
            if let schemes=access.schemes{return try await schemes.list()}
            let config=try await access.load()
            return NativeSpeechSchemeList(revision:0,selectedID:config == nil ? nil:NativeSpeechScheme.legacyID,
                schemes:config.map{[NativeSpeechScheme(id:NativeSpeechScheme.legacyID,name:nativeUI("默认方案","Default"),configuration:$0)]} ?? [])
        };cancelWork={work.cancel()}
        Task { [weak self] in
            do {
                let value=try await work.value
                guard let self,self.operation==id,self.revision==version else{return}
                guard value.schemes.allSatisfy({$0.configuration.valid}) else{throw NativeSpeechError.configuration}
                self.publish(value);self.error=nil;self.finish(id)
            } catch {
                guard let self,self.operation==id,self.revision==version else{return}
                self.configured=false;self.error=NativeSpeechError.credential.localizedDescription;self.finish(id)
            }
        }
    }
    private func publish(_ value:NativeSpeechSchemeList) {
        schemes=value.schemes;selectedID=value.selectedID;catalogRevision=value.revision
        configuration=value.selected?.configuration ?? .init();configured=value.selected != nil
    }
    private func finish(_ id:UUID){guard operation==id else{return};operation=nil;cancelWork=nil;busy=false;testing=false}
    func canRetainKey(schemeID:String,configuration:NativeSpeechConfiguration)->Bool {
        schemes.contains{$0.id==schemeID && $0.configuration.credentialScope==configuration.credentialScope}
    }
    @discardableResult private func mutateSchemes(_ change:@escaping @Sendable(NativeSpeechSchemeAccess,Int) async throws -> NativeSpeechSchemeList)async->Bool {
        guard available,!busy,let access=access?.schemes else{return false}
        let id=UUID();revision+=1;let version=revision,expected=catalogRevision;operation=id;busy=true;error=nil;testResult=nil
        let work=Task.detached {try Task.checkCancellation();return try await change(access,expected)};cancelWork={work.cancel()}
        defer{finish(id)}
        do {
            let next=try await withTaskCancellationHandler(operation:{try await work.value},onCancel:{work.cancel()})
            guard available,revision==version,operation==id,!Task.isCancelled else{return false}
            publish(next);didSave?();return true
        } catch {
            guard available,revision==version,operation==id,!Task.isCancelled else{return false}
            self.error=error.localizedDescription.hasPrefix("[PROFILE_CHANGED]") ? NativeSpeechError.schemeChanged.localizedDescription:((error as? NativeSpeechError)?.localizedDescription ?? NativeSpeechError.credential.localizedDescription);return false
        }
    }
    @discardableResult func saveScheme(id:String,name:String,configuration:NativeSpeechConfiguration,key:String,expectedRevision:Int?=nil)async->Bool {
        guard expectedRevision==nil || expectedRevision==catalogRevision else{error=NativeSpeechError.schemeChanged.localizedDescription;return false}
        let key=key.trimmingCharacters(in:.whitespacesAndNewlines)
        guard configuration.valid,NativeSpeechScheme.validName(name),key.isEmpty || NativeSpeechService.validKey(key),
              !key.isEmpty || canRetainKey(schemeID:id,configuration:configuration) else{error=NativeSpeechError.credential.localizedDescription;return false}
        if access?.schemes == nil {
            guard id==selectedID || !configured else{return false}
            let saved=await save(configuration,key:key)
            if saved {schemes=[.init(id:id,name:name,configuration:configuration)];selectedID=id}
            return saved
        }
        return await mutateSchemes {try await $0.save(id,name,configuration,key,$1)}
    }
    @discardableResult func selectScheme(_ id:String)async->Bool {
        guard schemes.contains(where:{$0.id==id}) else{return false}
        return await mutateSchemes {try await $0.select(id,$1)}
    }
    @discardableResult func removeScheme(_ id:String,expectedRevision:Int?=nil)async->Bool {
        guard expectedRevision==nil || expectedRevision==catalogRevision else{error=NativeSpeechError.schemeChanged.localizedDescription;return false}
        guard schemes.contains(where:{$0.id==id}) else{return false}
        if access?.schemes == nil {
            guard id==selectedID else{return false}
            let removed=await remove();if removed{schemes=[];selectedID=nil};return removed
        }
        return await mutateSchemes {try await $0.remove(id,$1)}
    }
    func clearTestResult() {
        testResult=nil
        if testing {cancelWork?();cancelWork=nil;operation=nil;testing=false;busy=false}
    }
    @discardableResult func testConnection(schemeID:String,configuration:NativeSpeechConfiguration,key:String,expectedRevision:Int?=nil,
                 transport:@escaping NativeSpeechService.Transport = {try await NativeSpeechHTTP.send($0,deadline:30)})async->Bool {
        guard available,!busy,configuration.valid,let access else{return false}
        guard expectedRevision==nil || expectedRevision==catalogRevision else{error=NativeSpeechError.schemeChanged.localizedDescription;return false}
        let key=key.trimmingCharacters(in:.whitespacesAndNewlines)
        guard !key.isEmpty || canRetainKey(schemeID:schemeID,configuration:configuration) else{error=NativeSpeechError.credential.localizedDescription;return false}
        let id=UUID(),version=revision,expected=catalogRevision;operation=id;busy=true;testing=true;testResult=nil;error=nil
        let work=Task.detached {
            try Task.checkCancellation()
            let actual:String
            if !key.isEmpty {actual=key}
            else if let schemes=access.schemes{actual=try await schemes.read(schemeID,configuration,expected)}
            else {actual=try await access.read(configuration)}
            try Task.checkCancellation()
            try await NativeSpeechService.testConnection(configuration:configuration,key:actual,transport:transport)
        };cancelWork={work.cancel()}
        defer{finish(id)}
        do {
            try await withTaskCancellationHandler(operation:{try await work.value},onCancel:{work.cancel()})
            guard available,revision==version,operation==id,!Task.isCancelled else{return false}
            testResult=nativeUI("接口已接受合成静音并返回有效响应。未测试真人语音识别；本次测试不会保存设置。","The API accepted generated silence and returned a valid response. Real speech accuracy was not tested; this does not save settings.");return true
        } catch {
            guard available,revision==version,operation==id,!Task.isCancelled else{return false}
            self.error=(error as? NativeSpeechError)?.localizedDescription ?? NativeSpeechError.network.localizedDescription;return false
        }
    }
    @discardableResult func save(_ config:NativeSpeechConfiguration,key:String) async->Bool {
        if access?.schemes != nil {
            let selected=schemes.first{$0.id==selectedID}
            return await saveScheme(id:selected?.id ?? UUID().uuidString,name:selected?.name ?? nativeUI("默认方案","Default"),configuration:config,key:key)
        }
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
            configuration=config;configured=true;didSave?();return true
        } catch {
            guard available,revision==version,operation==id,!Task.isCancelled else{return false}
            self.error=NativeSpeechError.credential.localizedDescription;return false
        }
    }
    @discardableResult func remove() async->Bool {
        if access?.schemes != nil {guard let selectedID else{return false};return await removeScheme(selectedID)}
        guard available,!busy,let access else{return false}
        let id=UUID();revision+=1;let version=revision;operation=id;busy=true;error=nil
        let work=Task.detached {try Task.checkCancellation();try await access.remove();try Task.checkCancellation()};cancelWork={work.cancel()}
        defer{finish(id)}
        do {
            try await withTaskCancellationHandler(operation:{try await work.value},onCancel:{work.cancel()})
            guard available,revision==version,operation==id,!Task.isCancelled else{return false}
            configuration = .init();configured=false;didSave?();return true
        }catch{
            guard available,revision==version,operation==id,!Task.isCancelled else{return false}
            self.error=NativeSpeechError.credential.localizedDescription;return false
        }
    }
    func connection() async throws->(NativeSpeechConfiguration,String) {
        guard available,!busy,configured,configuration.valid,let access else{throw NativeSpeechError.unavailable}
        let config=configuration,version=revision,selected=selectedID,expected=catalogRevision
        let work=Task.detached {
            try Task.checkCancellation()
            if let schemes=access.schemes,let selected{return try await schemes.read(selected,config,expected)}
            return try await access.read(config)
        }
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
