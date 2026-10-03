import Foundation

/// Revocation and the final rename share a short lock. Encryption/fsync occur
/// on the worker, outside this lock; privacy never waits for those operations.
final class NativeQuickVaultAccessGate:@unchecked Sendable {
    private let lock=NSLock()
    private var valid=true
    var isValid:Bool{lock.lock();defer{lock.unlock()};return valid}
    func revoke(){lock.lock();valid=false;lock.unlock()}
    func commit<T>(_ action:()throws->T)throws->T {
        lock.lock();defer{lock.unlock()}
        guard valid else{throw NativeQuickVaultError.unavailable}
        return try action()
    }
    static func revoked()->NativeQuickVaultAccessGate{let gate=NativeQuickVaultAccessGate();gate.revoke();return gate}
}

/// Exclusive, off-MainActor IO lane. The archive also uses a nonblocking process
/// lock, so another process cannot indefinitely stall this lane on flock.
actor NativeQuickVaultWorker {
    private let archive:NativeQuickVaultArchive
    init(archive:NativeQuickVaultArchive){self.archive=archive}
    private func check(_ gate:NativeQuickVaultAccessGate)throws {try Task.checkCancellation();guard gate.isValid else{throw NativeQuickVaultError.unavailable}}
    func list(_ gate:NativeQuickVaultAccessGate)throws->[NativeQuickVaultRow]{try check(gate);let result=try archive.list();try check(gate);return result}
    func save(_ draft:NativeQuickVaultDraft,gate:NativeQuickVaultAccessGate)throws->[NativeQuickVaultRow]{try check(gate);return try archive.save(draft,gate:gate)}
    func delete(_ request:NativeQuickVaultDeleteRequest,gate:NativeQuickVaultAccessGate)throws->[NativeQuickVaultRow]{try check(gate);return try archive.delete(request,gate:gate)}
    func secret(_ row:NativeQuickVaultRow,gate:NativeQuickVaultAccessGate)throws->String{try check(gate);let result=try archive.secret(id:row.id,revision:row.revision);try check(gate);return result}
}
