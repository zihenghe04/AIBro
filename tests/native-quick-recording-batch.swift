import Foundation
func nativeUI(_ zh:String,_ en:String)->String {en}
struct Failure:Error {let message:String}
var passed=0
func check(_ value:@autoclosure () throws->Bool,_ message:String) throws {
    if try !value(){throw Failure(message:message)};passed+=1;print("PASS \(message)")
}
func rejected(_ operation:() throws->Void) throws {do{try operation();throw Failure(message:"Unexpected success")}catch is NativeQuickRecordingBatchError{}catch is CocoaError{}}
func fixture(_ category:String?=nil)->NativeQuickRecordingItem {
    .init(id:UUID().uuidString.lowercased(),title:"Synthetic lecture",createdAt:Date(timeIntervalSince1970:1_900_000_000),duration:42,transcript:"Synthetic transcript retained in full.",state:"ready",category:category)
}
@main struct Main {
 @MainActor static func main() throws {
    let root=URL(fileURLWithPath:CommandLine.arguments[1]),fm=FileManager.default
    var serial=0
    func directory()->URL{serial+=1;return root.appendingPathComponent("case-\(serial)")}
    // Old v1 manifests have neither category nor lastBatch. Opening one must
    // retain its existing audio/transcript and not require migration in place.
    do {
        let dir=directory();try fm.createDirectory(at:dir,withIntermediateDirectories:true)
        let item=fixture();let encoded=try JSONSerialization.jsonObject(with:JSONEncoder().encode(item))
        let old=try JSONSerialization.data(withJSONObject:["version":1,"items":[encoded]])
        try old.write(to:dir.appendingPathComponent("index.json"))
        let loaded=try NativeQuickRecordingArchive(directory:dir)
        try check(loaded.items==[item] && loaded.lastBatch==nil,"legacy archive remains readable")
    }
    do {
        let dir=directory();var archive=try NativeQuickRecordingArchive(directory:dir)
        let a=fixture("Course"),b=fixture("Research"),c=fixture();let items=[a,b,c]
        try archive.replace(items)
        for item in items{try Data(("audio-"+item.id).utf8).write(to:archive.audioURL(for:item.id,mustExist:false))}
        let request=NativeQuickRecordingBatchRequest(targets:[a.batchTarget,b.batchTarget],action:.trash)
        try archive.apply(request,now:Date(timeIntervalSince1970:1_900_001_000))
        try check(archive.items.filter{$0.deletedAt != nil}.count==2 && archive.items[2]==c,"one batch tombstones only selected identities")
        archive=try NativeQuickRecordingArchive(directory:dir)
        try check(archive.canUndoBatch,"exact batch undo survives process restart")
        try archive.undoBatch()
        try check(archive.items==items && archive.lastBatch==nil,"undo restores original categories dates and identities")
        try check(try items.allSatisfy{try Data(contentsOf:archive.audioURL(for:$0.id))==Data(("audio-"+$0.id).utf8)},"batch and undo retain exact audio bytes")
        try archive.apply(.init(targets:archive.items.prefix(2).map(\.batchTarget),action:.categorize("  Seminar  ")))
        try check(archive.items[0].category=="Seminar" && archive.items[1].category=="Seminar" && archive.items[2].category==nil,"batch category normalizes label without affecting others")
        try archive.undoBatch();try check(archive.items==items,"category undo restores distinct former categories")
        try archive.apply(.init(targets:[archive.items[0].batchTarget],action:.categorize("")))
        try check(archive.items[0].category==nil,"empty category removes classification")
        let before=try Data(contentsOf:dir.appendingPathComponent("index.json"))
        try rejected{try archive.apply(.init(targets:[archive.items[1].batchTarget],action:.categorize("bad\ncategory")))}
        try check(try Data(contentsOf:dir.appendingPathComponent("index.json"))==before,"invalid category makes no partial changes")
        try archive.apply(.init(targets:[archive.items[0].batchTarget,archive.items[1].batchTarget],action:.trash))
        try archive.apply(.init(targets:archive.items.prefix(2).map(\.batchTarget),action:.restore))
        try check(archive.items.allSatisfy{$0.deletedAt==nil},"batch restore operates on same records")
        try archive.undoBatch();try check(archive.items.prefix(2).allSatisfy{$0.deletedAt != nil},"undo restore puts exact batch back in Deleted")
        try archive.apply(.init(targets:archive.items.prefix(2).map(\.batchTarget),action:.restore))
        try archive.update(id:c.id){$0.title="Unrelated later edit"}
        try check(archive.canUndoBatch,"unrelated record edits do not invalidate undo")
        try archive.update(id:a.id){$0.transcript="Later user change"}
        try check(!archive.canUndoBatch,"changed target prevents stale undo from overwriting later work")
    }
    do {
        let dir=directory();var archive=try NativeQuickRecordingArchive(directory:dir);let a=fixture(),b=fixture();try archive.replace([a,b])
        let stale=NativeQuickRecordingBatchRequest(targets:[a.batchTarget,b.batchTarget],action:.trash)
        try archive.update(id:b.id){$0.title="Edited while confirmation open"}
        let before=try Data(contentsOf:dir.appendingPathComponent("index.json"))
        try rejected{try archive.apply(stale)}
        try check(try Data(contentsOf:dir.appendingPathComponent("index.json"))==before && archive.items.allSatisfy{$0.deletedAt==nil},"stale selection rejects whole batch")
        var failed=try NativeQuickRecordingArchive(directory:dir,write:{data,url in try NativeQuickRecordingArchive.durableWrite(data,url);throw CocoaError(.fileWriteOutOfSpace)})
        try rejected{try failed.apply(.init(targets:failed.items.map(\.batchTarget),action:.trash))}
        try check(try Data(contentsOf:dir.appendingPathComponent("index.json"))==before,"failure after staged write preserves committed manifest")
        try check(try fm.contentsOfDirectory(atPath:dir.path).filter{$0.hasPrefix(".recording-index-")}.isEmpty,"failed transaction removes temporary manifest")
        var authorized=true
        var revoked=try NativeQuickRecordingArchive(directory:dir,write:{data,url in try NativeQuickRecordingArchive.durableWrite(data,url);authorized=false})
        try rejected{try revoked.apply(.init(targets:revoked.items.map(\.batchTarget),action:.trash),authorize:{authorized})}
        try check(try Data(contentsOf:dir.appendingPathComponent("index.json"))==before,"permission invalidation immediately before commit preserves whole archive")
    }
    do {
        let dir=directory(),folder=dir.appendingPathComponent("quick-recordings");var archive=try NativeQuickRecordingArchive(directory:folder)
        let a=fixture(),b=fixture();try archive.replace([a,b])
        var fail=false;var onWrite:(()->Void)?
        let store=NativeQuickRecordingStore(write:{data,url in try NativeQuickRecordingArchive.durableWrite(data,url);onWrite?();if fail{throw CocoaError(.fileWriteOutOfSpace)}})
        store.configure(directory:dir)
        let editor=UUID();store.setEditor(editor,id:a.id,active:true)
        try check(!store.canBatch(ids:[a.id]) && store.canBatch(ids:[b.id]),"active editor blocks target changes without blocking unrelated record")
        store.setEditor(editor,id:a.id,active:false)
        fail=true;store.saveTranscript(id:a.id,text:"Unsaved synthetic revision")
        try check(store.hasUnsavedTranscriptDrafts && store.transcriptText(id:a.id)=="Unsaved synthetic revision","failed transcript save retains editable input")
        try check(!store.canBatch(ids:[a.id]) && !store.flushForQuit(),"pending draft blocks batch and unsuccessful quit flush")
        store.setAvailable(false)
        try check(store.items.isEmpty && store.fileURL(id:a.id)==nil && store.transcriptText(id:a.id)==nil,"private state hides recording content and audio access")
        try check(store.hasUnsavedTranscriptDrafts && !store.flushForQuit(),"private state keeps pending text without committing it")
        store.setAvailable(true);fail=false
        try check(store.transcriptText(id:a.id)=="Unsaved synthetic revision" && store.flushForQuit(),"restored workspace can save same retained draft")
        try check(try NativeQuickRecordingArchive(directory:folder).items.first{$0.id==a.id}?.transcript=="Unsaved synthetic revision","quit flush actually persists pending transcript")
        let request=store.makeBatch(ids:[a.id,b.id],action:.trash)!
        let before=try Data(contentsOf:folder.appendingPathComponent("index.json"))
        onWrite={store.setAvailable(false)}
        try check(!store.applyBatch(request),"privacy change during staged batch rejects commit")
        try check(try Data(contentsOf:folder.appendingPathComponent("index.json"))==before,"rejected late batch cannot touch persisted records")
        onWrite=nil;store.setAvailable(true)
        store.configure(directory:directory())
        store.setAvailable(true)
        try check(store.error != nil && store.items.isEmpty && !store.ready,"different owner cannot re-enable previous library")
        store.configure(directory:dir);store.setAvailable(true)
        try check(store.items.count==2 && store.ready,"returning to original owner recovers same recordings")
        let ownerRequest=store.makeBatch(ids:[a.id,b.id],action:.trash)!
        let other=directory();onWrite={store.configure(directory:other);store.setAvailable(true)}
        try check(!store.applyBatch(ownerRequest),"owner change during staged batch rejects commit")
        try check(try Data(contentsOf:folder.appendingPathComponent("index.json"))==before,"late old-owner batch leaves manifest unchanged")
        onWrite=nil;store.configure(directory:dir);store.setAvailable(true)
        let refresh=store.makeBatch(ids:[a.id,b.id],action:.trash)!
        try check(store.applyBatch(refresh) && store.canUndoBatch,"store reports only committed batch and undo availability")
        store.setAvailable(false);store.setAvailable(true)
        try check(store.canUndoBatch && store.undoBatch() && store.items.allSatisfy{$0.deletedAt==nil},"privacy pause and resume retain recoverable batch")
        store.shutdown()
    }
    do {
        let dir=directory(),folder=dir.appendingPathComponent("quick-recordings");var archive=try NativeQuickRecordingArchive(directory:folder)
        let item=fixture();try archive.replace([item]);let store=NativeQuickRecordingStore();store.configure(directory:dir)
        store.beginCategory(ids:[item.id]);store.editCategory("Seminar draft")
        try check(store.hasEditor && !store.flushForQuit() && !store.canBatch(ids:[item.id]),"pending category protects navigation quit and competing batch")
        store.setAvailable(false);store.setAvailable(true)
        try check(store.categoryDraft?.text=="Seminar draft","privacy hide/show retains unsubmitted category input")
        try check(store.commitCategory() && store.items[0].category=="Seminar draft" && store.flushForQuit(),"resumed category commits original selection and releases quit guard")
        store.beginTitle(id:item.id);store.editTitle("Renamed synthetic recording")
        try check(store.hasEditor && !store.flushForQuit(),"pending title survives dismissal through store and blocks quit")
        store.setAvailable(false);store.setAvailable(true);store.resumeTitle()
        try check(store.titleDraft?.text=="Renamed synthetic recording" && store.editorResumeID>0,"resuming title retains exact text")
        try check(store.commitTitle() && store.items[0].title=="Renamed synthetic recording" && store.flushForQuit(),"title save commits before removing draft")
        store.beginCategory(ids:[item.id]);store.editCategory("Cancel me");store.cancelCategory()
        try check(store.items[0].category=="Seminar draft" && !store.hasEditor,"explicit category cancel leaves saved metadata unchanged")
        store.beginTitle(id:item.id);store.editTitle("Cancel title");store.cancelTitle()
        try check(store.items[0].title=="Renamed synthetic recording" && store.flushForQuit(),"explicit title cancel leaves saved metadata unchanged")
    }
    do {
        var selection=NativeQuickRecordingSelection();let order=["a","b","c","d","e"]
        selection.anchor("b");selection.select("d",order:order,extending:true)
        try check(selection.ids==["b","c","d"],"Shift selection uses stable identity range")
        selection.select("c",order:order,toggling:true)
        try check(selection.ids==["b","d"],"Command/Space toggles single row")
        selection.all(order);selection.reconcile(["a","c"])
        try check(selection.ids==["a","c"],"filtering prunes hidden selection before any bulk action")
        selection.clear();try check(selection.ids.isEmpty && selection.anchor==nil,"Escape clears selection and anchor")
    }
    print("PASS \(passed) recording batch checks; synthetic files only, no audio devices")
 }
}
