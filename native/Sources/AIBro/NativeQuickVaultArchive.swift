import Foundation
import CryptoKit
import Darwin

// Behavior reference: TO-DO Panel (MIT), 1deb3cac1e32599f13b1d6b30a7e52af76f67efd,
// main.js:2449–2549. License: docs/licenses/to-do-panel-MIT.txt.
// Storage follows NativeCredentials' local AES-GCM / owner-only file pattern.
// No Keychain, model bridge, workspace exporter or sync serialization is used.
struct NativeQuickVaultRow: Equatable, Identifiable, Sendable {
    let id: String
    let revision: String
    let service: String
    let account: String
    let createdAt: Date
    let updatedAt: Date
}
struct NativeQuickVaultDraft: Equatable, Sendable {
    let id: String
    let expectedRevision: String?
    var service = ""
    var account = ""
    var password = "" // Empty means retain, only when editing an existing entry.
    var operationID = UUID().uuidString
    var valid: Bool {
        let service=service.trimmingCharacters(in:.whitespacesAndNewlines),account=account.trimmingCharacters(in:.whitespacesAndNewlines)
        return !service.isEmpty && service.utf16.count<=80 && !account.isEmpty && account.utf16.count<=320 && password.utf16.count<=4096
            && !service.unicodeScalars.contains(where:CharacterSet.controlCharacters.contains)
            && !account.unicodeScalars.contains(where:CharacterSet.controlCharacters.contains)
            && (expectedRevision != nil || !password.isEmpty)
    }
}
struct NativeQuickVaultDeleteRequest: Sendable {
    let operationID = UUID().uuidString
    let rows: [NativeQuickVaultRow]
}
enum NativeQuickVaultError: Error { case unsafePath, corrupt, changed, unavailable, invalid, limit, writeFailed, uncertain }

/// Each operation locks and re-reads the authenticated envelope. No plaintext
/// password collection is retained on the observable Store or handed to its UI.
final class NativeQuickVaultArchive: @unchecked Sendable {
    static let maxItems = 1000
    static let maxBytes = 8 * 1024 * 1024
    private struct Record: Codable {
        let id:String;var revision:String;var service:String;var account:String;var password:String
        let createdAt:Date;var updatedAt:Date
        var row:NativeQuickVaultRow {.init(id:id,revision:revision,service:service,account:account,createdAt:createdAt,updatedAt:updatedAt)}
        var valid:Bool {UUID(uuidString:id) != nil && UUID(uuidString:revision) != nil && !password.isEmpty && NativeQuickVaultDraft(id:id,expectedRevision:revision,service:service,account:account,password:password).valid && createdAt.timeIntervalSince1970.isFinite && updatedAt.timeIntervalSince1970.isFinite}
    }
    private struct Envelope: Codable {var version=1;var records:[Record]=[];var lastOperation:String?}
    struct Operations: @unchecked Sendable {
        var beforeAccess: () throws -> Void = {}
        var beforeCommit: () throws -> Void = {}
        var syncDirectory: (Int32)->Bool = {fsync($0)==0}
    }
    let directory:URL
    private let identity:String
    private let operations:Operations
    init(directory:URL,identity:String,operations:Operations = .init()) {self.directory=directory;self.identity=identity;self.operations=operations}
    private var authenticatedData:Data {Data(("AI Bro local vault v1\u{0}"+identity).utf8)}
    private func withDirectory<T>(create:Bool,_ action:(Int32?)throws->T)throws->T {
        try operations.beforeAccess()
        guard directory.isFileURL,!directory.lastPathComponent.isEmpty else{throw NativeQuickVaultError.unsafePath}
        let parent=directory.deletingLastPathComponent().resolvingSymlinksInPath()
        let p=open(parent.path,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)
        guard p>=0 else{throw NativeQuickVaultError.unsafePath};defer{Darwin.close(p)}
        if create && mkdirat(p,directory.lastPathComponent,0o700) != 0 && errno != EEXIST {throw NativeQuickVaultError.writeFailed}
        let fd=openat(p,directory.lastPathComponent,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)
        if fd<0 && errno==ENOENT && !create {return try action(nil)}
        guard fd>=0 else{throw NativeQuickVaultError.unsafePath};defer{Darwin.close(fd)}
        var statValue=stat()
        guard fstat(fd,&statValue)==0,statValue.st_uid==getuid(),statValue.st_mode & 0o777 == 0o700 else{throw NativeQuickVaultError.unsafePath}
        guard flock(fd,LOCK_EX|LOCK_NB)==0 else{throw NativeQuickVaultError.unavailable}
        defer{_ = flock(fd,LOCK_UN)}
        return try action(fd)
    }
    private func read(_ name:String,at directory:Int32,limit:Int=NativeQuickVaultArchive.maxBytes)throws->Data? {
        let fd=openat(directory,name,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC)
        if fd<0 && errno==ENOENT{return nil}
        guard fd>=0 else{throw NativeQuickVaultError.unsafePath};defer{Darwin.close(fd)}
        var value=stat()
        guard fstat(fd,&value)==0,value.st_mode & S_IFMT == S_IFREG,value.st_uid==getuid(),value.st_mode & 0o777 == 0o600,value.st_nlink==1,value.st_size>=0,value.st_size<=limit else{throw NativeQuickVaultError.unsafePath}
        var data=Data(),buffer=[UInt8](repeating:0,count:8192)
        while true {
            let count=Darwin.read(fd,&buffer,buffer.count)
            if count<0 && errno==EINTR{continue};guard count>=0 else{throw NativeQuickVaultError.corrupt}
            if count==0{break};data.append(contentsOf:buffer.prefix(count));guard data.count<=limit else{throw NativeQuickVaultError.limit}
        }
        return data
    }
    private func write(_ data:Data,name:String,at directory:Int32,gate:NativeQuickVaultAccessGate)throws {
        _ = try read(name,at:directory)
        let temp=".pending-"+UUID().uuidString
        let out=openat(directory,temp,O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW|O_CLOEXEC,0o600)
        guard out>=0 else{throw NativeQuickVaultError.writeFailed}
        defer{Darwin.close(out);_ = unlinkat(directory,temp,0)}
        try data.withUnsafeBytes{bytes in
            var offset=0
            while offset<bytes.count {
                let n=Darwin.write(out,bytes.baseAddress!.advanced(by:offset),bytes.count-offset)
                if n<0 && errno==EINTR{continue};guard n>0 else{throw NativeQuickVaultError.writeFailed};offset+=n
            }
        }
        guard fsync(out)==0 else{throw NativeQuickVaultError.writeFailed}
        try operations.beforeCommit()
        try gate.commit {
            guard renameat(directory,temp,directory,name)==0 else{throw NativeQuickVaultError.writeFailed}
        }
        guard operations.syncDirectory(directory) else{throw NativeQuickVaultError.uncertain}
    }
    private func key(at directory:Int32,create:Bool,gate:NativeQuickVaultAccessGate)throws->SymmetricKey {
        if let data=try read("device-key.bin",at:directory,limit:32) {guard data.count==32 else{throw NativeQuickVaultError.corrupt};return SymmetricKey(data:data)}
        guard create,try read("vault.sealed",at:directory)==nil else{throw NativeQuickVaultError.corrupt}
        let value=SymmetricKey(size:.bits256)
        try write(value.withUnsafeBytes{Data($0)},name:"device-key.bin",at:directory,gate:gate)
        return value
    }
    private func load(at directory:Int32?)throws->Envelope {
        guard let directory,let bytes=try read("vault.sealed",at:directory) else{return .init()}
        do {
            let key=try key(at:directory,create:false,gate:NativeQuickVaultAccessGate.revoked())
            let clear=try AES.GCM.open(AES.GCM.SealedBox(combined:bytes),using:key,authenticating:authenticatedData)
            let value=try JSONDecoder().decode(Envelope.self,from:clear)
            guard value.version==1,value.records.count<=Self.maxItems,Set(value.records.map(\.id)).count==value.records.count,value.records.allSatisfy(\.valid) else{throw NativeQuickVaultError.corrupt}
            return value
        }catch{throw NativeQuickVaultError.corrupt}
    }
    private func commit(_ value:Envelope,at directory:Int32,gate:NativeQuickVaultAccessGate)throws {
        guard value.records.count<=Self.maxItems else{throw NativeQuickVaultError.limit}
        let clear=try JSONEncoder().encode(value)
        guard clear.count<=Self.maxBytes-64 else{throw NativeQuickVaultError.limit}
        let key=try key(at:directory,create:true,gate:gate)
        guard let sealed=try AES.GCM.seal(clear,using:key,authenticating:authenticatedData).combined else{throw NativeQuickVaultError.writeFailed}
        try write(sealed,name:"vault.sealed",at:directory,gate:gate)
    }
    private func confirmedRows(_ value:Envelope,at directory:Int32)throws->[NativeQuickVaultRow] {
        // Reading back a successful rename is not a durable ACK if the prior
        // directory fsync failed. Retry only that barrier, never the mutation.
        guard operations.syncDirectory(directory) else{throw NativeQuickVaultError.uncertain}
        return value.records.map(\.row)
    }
    func list()throws->[NativeQuickVaultRow] {try withDirectory(create:false){try load(at:$0).records.map(\.row)}}
    func secret(id:String,revision:String)throws->String {
        try withDirectory(create:false){fd in
            guard let record=try load(at:fd).records.first(where:{$0.id==id && $0.revision==revision}) else{throw NativeQuickVaultError.changed}
            return record.password
        }
    }
    func save(_ draft:NativeQuickVaultDraft,gate:NativeQuickVaultAccessGate)throws->[NativeQuickVaultRow] {
        guard draft.valid,UUID(uuidString:draft.id) != nil,UUID(uuidString:draft.operationID) != nil,gate.isValid else{throw NativeQuickVaultError.invalid}
        return try withDirectory(create:true){fd in
            guard let fd else{throw NativeQuickVaultError.unavailable};var value=try load(at:fd)
            if value.lastOperation==draft.operationID{return try confirmedRows(value,at:fd)}
            let old=value.records.first{$0.id==draft.id}
            guard old?.revision==draft.expectedRevision else{throw NativeQuickVaultError.changed}
            let now=Date(),record=Record(id:draft.id,revision:UUID().uuidString,service:draft.service.trimmingCharacters(in:.whitespacesAndNewlines),account:draft.account.trimmingCharacters(in:.whitespacesAndNewlines),password:draft.password.isEmpty ? old?.password ?? "":draft.password,createdAt:old?.createdAt ?? now,updatedAt:now)
            guard record.valid else{throw NativeQuickVaultError.invalid}
            if let index=value.records.firstIndex(where:{$0.id==draft.id}){value.records[index]=record}else{value.records.insert(record,at:0)}
            value.lastOperation=draft.operationID;try commit(value,at:fd,gate:gate);return value.records.map(\.row)
        }
    }
    func delete(_ request:NativeQuickVaultDeleteRequest,gate:NativeQuickVaultAccessGate)throws->[NativeQuickVaultRow] {
        guard !request.rows.isEmpty,Set(request.rows.map(\.id)).count==request.rows.count,gate.isValid else{throw NativeQuickVaultError.invalid}
        return try withDirectory(create:false){fd in
            guard let fd else{throw NativeQuickVaultError.changed};var value=try load(at:fd)
            if value.lastOperation==request.operationID{return try confirmedRows(value,at:fd)}
            guard request.rows.allSatisfy({expected in value.records.contains{$0.id==expected.id && $0.revision==expected.revision}}) else{throw NativeQuickVaultError.changed}
            let ids=Set(request.rows.map(\.id));value.records.removeAll{ids.contains($0.id)};value.lastOperation=request.operationID
            try commit(value,at:fd,gate:gate);return value.records.map(\.row)
        }
    }
}
