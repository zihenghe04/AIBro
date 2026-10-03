import AppKit
import Foundation
import Darwin
func nativeUI(_ zh:String,_ en:String)->String{en}
final class VaultIOPause:@unchecked Sendable {
    private let lock=NSLock(),semaphore=DispatchSemaphore(value:0)
    private var armed=false,waiting=false
    func arm(){lock.lock();armed=true;waiting=false;lock.unlock()}
    var entered:Bool{lock.lock();defer{lock.unlock()};return waiting}
    func pause(){lock.lock();let shouldPause=armed;armed=false;if shouldPause{waiting=true};lock.unlock();if shouldPause{_ = semaphore.wait(timeout:.now()+5)}}
    func release(){semaphore.signal()}
}
@main struct VaultChecks {
 @MainActor static func main() async throws {
    var count=0
    func check(_ value:Bool,_ message:String)throws{guard value else{throw NSError(domain:message,code:1)};count+=1;print("PASS \(message)")}
    func rejected(_ body:()throws->Void)throws{do{try body();throw NSError(domain:"Expected refusal",code:1)}catch is NativeQuickVaultError{}}
    func settle(_ store:NativeQuickVaultStore) async {for _ in 0..<1000{if !store.busy{return};try? await Task.sleep(for:.milliseconds(1))}}
    let fm=FileManager.default,root=URL(fileURLWithPath:CommandLine.arguments[1])
    try fm.createDirectory(at:root,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
    let folder=root.appendingPathComponent("vault"),archive=NativeQuickVaultArchive(directory:folder,identity:"synthetic-test")
    try check(try archive.list().isEmpty && !fm.fileExists(atPath:folder.path),"listing an unused vault creates no key or data files")
    let first=NativeQuickVaultDraft(id:UUID().uuidString,expectedRevision:nil,service:"Campus",account:"student@example.invalid",password:"synthetic-secret-A")
    let saved=try archive.save(first,gate:.init())
    try check(saved.count==1 && saved[0].service=="Campus","explicit add returns only public row metadata")
    let secret=try archive.secret(id:saved[0].id,revision:saved[0].revision)
    try check(secret==first.password,"explicit secret read verifies the stable record revision")
    let opened=NativeQuickVaultArchive(directory:folder,identity:"synthetic-test")
    try check(try opened.list()==saved,"encrypted record and stable metadata survive restart")
    let bytes=try Data(contentsOf:folder.appendingPathComponent("vault.sealed")),key=try Data(contentsOf:folder.appendingPathComponent("device-key.bin"))
    try check(bytes.range(of:Data(first.password.utf8))==nil && bytes.range(of:Data(first.account.utf8))==nil && bytes.range(of:Data(first.service.utf8))==nil,"password, account and service are all absent from plaintext disk payload")
    try check(key.count==32,"the independent local encryption key is 256 bits")
    let modes=try [folder,folder.appendingPathComponent("device-key.bin"),folder.appendingPathComponent("vault.sealed")].map{try fm.attributesOfItem(atPath:$0.path)[.posixPermissions] as! Int}
    try check(modes==[0o700,0o600,0o600],"vault directory and independent files have owner-only modes")
    var edit=NativeQuickVaultDraft(id:saved[0].id,expectedRevision:saved[0].revision,service:"University",account:"new@example.invalid")
    let updated=try opened.save(edit,gate:.init())
    try check(try opened.secret(id:updated[0].id,revision:updated[0].revision)==first.password && updated[0].createdAt==saved[0].createdAt,"editing with an empty password preserves it and the creation date")
    try rejected{_ = try archive.save(edit,gate:.init());_ = try archive.secret(id:saved[0].id,revision:saved[0].revision)}
    edit.operationID=UUID().uuidString
    try rejected{_ = try archive.save(edit,gate:.init())}
    try check(try archive.list()==updated,"stale edit from another vault instance cannot overwrite a newer record")
    let second=NativeQuickVaultDraft(id:UUID().uuidString,expectedRevision:nil,service:"Lab",account:"lab@example.invalid",password:"synthetic-secret-B")
    let both=try archive.save(second,gate:.init()),staleDelete=NativeQuickVaultDeleteRequest(rows:both)
    let latest=both.first{$0.id==first.id}!
    let changed=try archive.save(.init(id:latest.id,expectedRevision:latest.revision,service:latest.service,account:latest.account,password:"synthetic-secret-C"),gate:.init())
    try rejected{_ = try archive.delete(staleDelete,gate:.init())}
    try check(try archive.list()==changed,"a stale member rejects the entire bulk deletion")
    let commitGate=NativeQuickVaultAccessGate()
    let revoking=NativeQuickVaultArchive(directory:folder,identity:"synthetic-test",operations:.init(beforeCommit:{commitGate.revoke()}))
    let beforeRevoked=try Data(contentsOf:folder.appendingPathComponent("vault.sealed"))
    try rejected{_ = try revoking.delete(.init(rows:changed),gate:commitGate)}
    try check(try Data(contentsOf:folder.appendingPathComponent("vault.sealed"))==beforeRevoked,"revocation before atomic rename leaves all prior ciphertext intact")
    let uncertain=NativeQuickVaultArchive(directory:folder,identity:"synthetic-test",operations:.init(syncDirectory:{_ in false}))
    let deletion=NativeQuickVaultDeleteRequest(rows:[changed.first{$0.id==second.id}!])
    try rejected{_ = try uncertain.delete(deletion,gate:.init())}
    var retriedSyncs=0
    let uncertainAgain=NativeQuickVaultArchive(directory:folder,identity:"synthetic-test",operations:.init(syncDirectory:{_ in retriedSyncs+=1;return false}))
    let committedBytes=try Data(contentsOf:folder.appendingPathComponent("vault.sealed"))
    try rejected{_ = try uncertainAgain.delete(deletion,gate:.init())}
    try check(retriedSyncs==1 && (try Data(contentsOf:folder.appendingPathComponent("vault.sealed")))==committedBytes,"same-operation retry requires a new directory durability barrier and never rewrites the committed deletion")
    let recovered=try archive.delete(deletion,gate:.init())
    try check(recovered.count==1 && recovered[0].id==first.id,"retry after a post-rename uncertainty reads the committed operation instead of deleting again")
    let corrupted=root.appendingPathComponent("corrupted");try fm.copyItem(at:folder,to:corrupted)
    let original=try Data(contentsOf:corrupted.appendingPathComponent("vault.sealed"));var damaged=original;damaged[damaged.count-1]^=1;try damaged.write(to:corrupted.appendingPathComponent("vault.sealed"))
    let corruptArchive=NativeQuickVaultArchive(directory:corrupted,identity:"synthetic-test")
    try rejected{_ = try corruptArchive.list()};try rejected{_ = try corruptArchive.save(second,gate:.init())}
    try check(try Data(contentsOf:corrupted.appendingPathComponent("vault.sealed"))==damaged,"corrupt authenticated data is never silently reset or overwritten")
    let missingKey=root.appendingPathComponent("missing-key");try fm.copyItem(at:folder,to:missingKey);try fm.removeItem(at:missingKey.appendingPathComponent("device-key.bin"))
    try rejected{_ = try NativeQuickVaultArchive(directory:missingKey,identity:"synthetic-test").save(second,gate:.init())}
    try check(!fm.fileExists(atPath:missingKey.appendingPathComponent("device-key.bin").path),"a missing key with old ciphertext is never replaced")
    let link=root.appendingPathComponent("linked");try fm.createSymbolicLink(at:link,withDestinationURL:folder)
    try rejected{_ = try NativeQuickVaultArchive(directory:link,identity:"synthetic-test").list()}
    try check(true,"symlink vault directory is refused")
    let linkedFile=root.appendingPathComponent("linked-file");try fm.copyItem(at:folder,to:linkedFile);try fm.removeItem(at:linkedFile.appendingPathComponent("device-key.bin"));try fm.createSymbolicLink(at:linkedFile.appendingPathComponent("device-key.bin"),withDestinationURL:folder.appendingPathComponent("device-key.bin"))
    try rejected{_ = try NativeQuickVaultArchive(directory:linkedFile,identity:"synthetic-test").list()}
    try check(true,"symlink encryption key is refused")
    try rejected{_ = try NativeQuickVaultArchive(directory:folder,identity:"other-bundle").list()}
    try check(true,"authenticated identity prevents opening another bundle's sealed data")

    let board=NSPasteboard.withUniqueName();defer{board.releaseGlobally()}
    var now=Date(timeIntervalSince1970:1_900_000_000)
    let copies=NativeQuickVaultPasteboard(board:board,now:{now})
    try check(copies.copy("synthetic-clipboard-secret"),"explicit password copy succeeds on an injected test pasteboard")
    let types=board.types?.map(\.rawValue) ?? []
    try check(NativeQuickClipboardPolicy.excluded(types),"actual existing clipboard-history policy excludes vault-sensitive pasteboard types")
    now=now.addingTimeInterval(59);copies.expire()
    try check(board.string(forType:.string)=="synthetic-clipboard-secret","the copy remains available before sixty seconds")
    now=now.addingTimeInterval(2);copies.expire()
    try check(board.string(forType:.string)==nil,"sixty-second expiry clears only the still-owned copy")
    _ = copies.copy("synthetic-clipboard-secret");board.clearContents();board.setString("Other application data",forType:.string);now=now.addingTimeInterval(61);copies.expire()
    try check(board.string(forType:.string)=="Other application data","expiry never erases a newer clipboard value")
    _ = copies.copy("same-value");board.clearContents();board.setString("same-value",forType:.string);now=now.addingTimeInterval(61);copies.expire()
    try check(board.string(forType:.string)=="same-value","even identical text from a later writer is not treated as our copy")
    _ = copies.copy("synthetic-last");copies.clearOwned();try check(board.string(forType:.string)==nil,"privacy or shutdown can clear the exact owned receipt immediately")

    let store=NativeQuickVaultStore(pasteboard:copies);store.configure(directory:folder,identity:"synthetic-test")
    try check(store.rows.isEmpty && !store.available && !store.loaded,"configuration alone neither exposes nor automatically loads passwords")
    store.setAvailable(true);store.setVisible(true);await settle(store)
    try check(store.loaded && store.rows.count==1,"explicit visible view loads metadata only")
    let row=store.rows[0];await store.reveal(row)
    try check(store.revealedPassword=="synthetic-secret-C","explicit reveal reads the selected exact revision")
    store.reload();await settle(store);try check(store.revealedPassword==nil,"refresh conceals previously revealed text before replacing metadata")
    store.beginEdit(row);try check(store.draft?.password=="" && store.hasEditor && !store.flushForQuit(),"editing leaves password blank and participates in the real quit guard")
    store.updateDraft(password:"unsaved-synthetic-secret");store.setAvailable(false)
    let privateSave=await store.save()
    try check(store.rows.isEmpty && store.revealedPassword==nil && store.draft?.password=="unsaved-synthetic-secret" && !privateSave,"privacy hides content while retaining the unsaved draft without committing it")
    store.setAvailable(true);store.setVisible(true);await settle(store);try check(await store.save(),"the exact retained draft can be saved after returning to the vault")
    try check(store.flushForQuit() && store.draft==nil,"confirmed save clears the draft quit blocker")
    store.beginNew();store.updateDraft(service:"Pending",account:"pending@example.invalid",password:"unsaved-only");store.setVisible(false)
    try check(!(await store.save()) && store.hasEditor,"hidden vault cannot commit while its draft remains recoverable")
    store.setVisible(true);await settle(store);store.cancelDraft();store.shutdown()
    try check(!store.available && store.rows.isEmpty && store.revealedPassword==nil,"shutdown drops observable metadata and revealed plaintext")
    // The real process lock must refuse contention without waiting on UI or IO.
    let held=open(folder.path,O_RDONLY|O_DIRECTORY);guard held>=0 else{fatalError("fixture directory")}
    guard flock(held,LOCK_EX|LOCK_NB)==0 else{fatalError("fixture lock")}
    let lockStart=Date();try rejected{_ = try archive.list()}
    try check(Date().timeIntervalSince(lockStart)<0.5,"process lock contention fails promptly instead of waiting indefinitely")
    _ = flock(held,LOCK_UN);Darwin.close(held)
    let accessPause=VaultIOPause(),commitPause=VaultIOPause()
    let background=NativeQuickVaultStore(pasteboard:copies,archiveFactory:{folder,identity in
        NativeQuickVaultArchive(directory:folder,identity:identity,operations:.init(beforeAccess:{accessPause.pause()},beforeCommit:{commitPause.pause()}))
    })
    background.configure(directory:folder,identity:"synthetic-test");background.setAvailable(true);background.setVisible(true);await settle(background)
    let currentRow=background.rows[0]
    func entered(_ pause:VaultIOPause) async throws{for _ in 0..<1000{if pause.entered{return};try? await Task.sleep(for:.milliseconds(1))};throw NSError(domain:"IO fixture did not start",code:1)}
    board.clearContents();board.setString("Unrelated clipboard",forType:.string)
    accessPause.arm();let pendingCopy=Task{await background.copy(currentRow,field:.password)}
    try await entered(accessPause)
    try check(background.busy,"MainActor remains responsive while real vault worker IO is suspended")
    background.setAvailable(false);accessPause.release();let didCopy=await pendingCopy.value
    try check(!didCopy && board.string(forType:.string)=="Unrelated clipboard" && background.notice==nil,"late secret read after privacy cannot overwrite clipboard or announce success")
    background.setAvailable(true);background.setVisible(true);await settle(background)
    accessPause.arm();let supersededCopy=Task{await background.copy(background.rows[0],field:.password)}
    try await entered(accessPause);board.clearContents();board.setString("New user copy while decryption waits",forType:.string)
    accessPause.release();let didSupersede=await supersededCopy.value
    try check(!didSupersede && board.string(forType:.string)=="New user copy while decryption waits" && background.error?.contains("clipboard changed")==true,"an external copy during decryption invalidates the clipboard lease without replacing its content")
    accessPause.arm();let pendingReveal=Task{await background.reveal(background.rows[0])}
    try await entered(accessPause);background.setVisible(false);accessPause.release();await pendingReveal.value
    try check(background.revealedPassword==nil && background.rows.isEmpty,"late reveal after dismissal cannot re-expose a password")
    background.setVisible(true);await settle(background)
    let deleteRequest=background.deleteRequest(ids:[background.rows[0].id])!
    let cipherBefore=try Data(contentsOf:folder.appendingPathComponent("vault.sealed"))
    commitPause.arm();let pendingDelete=Task{await background.delete(deleteRequest)}
    try await entered(commitPause)
    background.setAvailable(false)
    try check(!background.flushForQuit(),"a revoked but still-running write keeps the quit guard until the worker settles")
    commitPause.release();let didDelete=await pendingDelete.value
    try check(!didDelete && (try Data(contentsOf:folder.appendingPathComponent("vault.sealed")))==cipherBefore,"privacy revocation before rename prevents the entire delayed deletion")
    try check(background.flushForQuit(),"completed revoked write releases its independent quit lease")
    background.setAvailable(true);background.setVisible(true);await settle(background)
    background.beginEdit(background.rows[0]);background.updateDraft(password:"later-save-not-committed")
    commitPause.arm();let pendingSave=Task{await background.save()};try await entered(commitPause)
    background.setAvailable(false);commitPause.release();let didSave=await pendingSave.value
    try check(!didSave && background.draft?.password=="later-save-not-committed","revoked save preserves the original draft without accepting a late worker result")
    background.setAvailable(true);background.setVisible(true);await settle(background)
    try check(await background.save(),"retained draft saves on a new authorized worker lease")
    background.shutdown()
    print("\(count) vault archive/store/copy checks; synthetic data and isolated pasteboard only")
 }
}
