import Foundation
func nativeUI(_ zh:String,_ en:String)->String {en}
struct Failure:Error {let message:String}
var passed=0
func check(_ value:@autoclosure () throws->Bool,_ message:String) throws {if try !value(){throw Failure(message:message)};passed+=1;print("PASS \(message)")}
func rejected(_ action:() throws->Void) throws {do{try action();throw Failure(message:"Unexpected success")}catch is NativeQuickRecordingBatchError{}catch is CocoaError{}}
func item(_ text:String="Fictional class: compare observation notes and draw a route.")->NativeQuickRecordingItem {
    .init(id:UUID().uuidString.lowercased(),title:"My manually named seminar",createdAt:Date(timeIntervalSince1970:1_900_000_000),duration:12,transcript:text,state:"ready",category:"My classification")
}
func reply(_ p:[String:Any])->[String:Any] {["status":"generated","id":p["id"]!,"requestId":p["requestId"]!,"fingerprint":p["fingerprint"]!,"title":"Observation methods","category":"Course","model":"deepseek-v4.1-flash"]}
@MainActor final class Gate {
    var continuation:CheckedContinuation<[String:Any],Error>?
    var payload:[String:Any]?
    var cancelled=false
    func request(_ value:[String:Any]) async throws->[String:Any] {
        if value["action"] as? String == "cancel" {cancelled=true;return ["status":"cancelled"]}
        payload=value;return try await withCheckedThrowingContinuation{continuation=$0}
    }
    func finish(){if let payload{continuation?.resume(returning:reply(payload));continuation=nil}}
}
@main struct Main {
 @MainActor static func main() async throws {
    let root=URL(fileURLWithPath:CommandLine.arguments[1]),fm=FileManager.default
    var serial=0
    func directory()->URL {serial+=1;return root.appendingPathComponent("case-\(serial)")}
    func fixture(_ value:NativeQuickRecordingItem=item(),write:@escaping(Data,URL)throws->Void=NativeQuickRecordingArchive.durableWrite) throws->(NativeQuickRecordingStore,URL,NativeQuickRecordingItem) {
        let root=directory(),folder=root.appendingPathComponent("quick-recordings")
        var archive=try NativeQuickRecordingArchive(directory:folder);try archive.replace([value]);try Data("fictional audio bytes".utf8).write(to:archive.audioURL(for:value.id,mustExist:false))
        let store=NativeQuickRecordingStore(write:write);store.configure(directory:root);store.setVisible(true)
        store.configureTitleRequest{payload in if payload["action"] as? String == "cancel"{return ["status":"cancelled"]};return reply(payload)}
        return (store,root,value)
    }
    do {
        let (store,root,value)=try fixture(),index=root.appendingPathComponent("quick-recordings/index.json"),before=try Data(contentsOf:index)
        try check(store.canSuggest(id:value.id),"saved transcript enables explicit suggestion")
        await store.generateSuggestion(id:value.id)
        try check(store.suggestion?.title=="Observation methods" && store.suggestingID==nil,"valid exact reply becomes preview only")
        try check(try Data(contentsOf:index)==before && store.items==[value],"model generation does not write metadata transcript or audio")
        try check(!store.adoptSuggestion(title:false,category:false),"no checked fields cannot replace manual metadata")
        try check(store.adoptSuggestion(title:false,category:true),"explicit category-only selection creates recoverable draft")
        try check(store.items==[value] && store.suggestionDraft?.title==nil,"adoption does not rename or change current category")
        try check(!store.canBatch(ids:[value.id]) && !store.rename(id:value.id,title:"Conflicting edit"),"pending draft protects against conflicting metadata edits")
        store.saveTranscript(id:value.id,text:"Must not replace transcript while review draft pending")
        try check(store.items.first?.transcript==value.transcript,"pending draft retains full original transcript")
        let resumed=NativeQuickRecordingStore();resumed.configure(directory:root);resumed.setVisible(true)
        try check(resumed.suggestionDraft==store.suggestionDraft && resumed.items==[value],"accepted proposal survives process restart without applying itself")
        try check(resumed.saveSuggestion(),"explicit save commits selected metadata")
        let saved=try NativeQuickRecordingArchive(directory:root.appendingPathComponent("quick-recordings"))
        try check(saved.items.first?.title==value.title && saved.items.first?.category=="Course" && saved.suggestionDraft==nil,"unchecked human title survives atomic category save")
        try check(saved.items.first?.id==value.id && saved.items.first?.transcript==value.transcript && saved.items.first?.duration==value.duration && saved.items.first?.createdAt==value.createdAt,"identity transcript duration and timestamp remain unchanged")
        try check(try Data(contentsOf:saved.audioURL(for:value.id))==Data("fictional audio bytes".utf8),"audio content unchanged through generate adopt restart save")
        try check(!resumed.saveSuggestion(),"repeated save after ACK cannot replay mutation")
    }
    do {
        let (store,root,value)=try fixture();await store.generateSuggestion(id:value.id)
        try check(store.adoptSuggestion(title:true,category:false) && store.saveSuggestion(),"explicit title replacement is accepted only after review and save")
        try check(store.items.first?.title=="Observation methods" && store.items.first?.category==value.category,"unchecked manual category remains exact")
        let loaded=try NativeQuickRecordingArchive(directory:root.appendingPathComponent("quick-recordings"))
        try check(loaded.items==store.items,"saved metadata reloads from real manifest")
    }
    do {
        let root=directory();var archive=try NativeQuickRecordingArchive(directory:root);let value=item();try archive.replace([value])
        let draft=NativeQuickRecordingSuggestionDraft(id:value.id,fingerprint:value.batchFingerprint,model:"deepseek-v4.1-flash",title:"Proposed",category:nil)
        try archive.keepSuggestion(draft);try archive.update(id:value.id){$0.transcript="Changed after adoption"}
        let before=try Data(contentsOf:root.appendingPathComponent("index.json"));try rejected{try archive.saveSuggestion()}
        try check(try Data(contentsOf:root.appendingPathComponent("index.json"))==before && archive.suggestionDraft==draft,"full-record CAS refuses stale accepted draft without deleting it")
        try archive.discardSuggestion();try check(archive.suggestionDraft==nil && archive.items.first?.transcript=="Changed after adoption","discard removes only draft and retains later human content")
    }
    do {
        var fail=false
        let (store,root,value)=try fixture(write:{data,url in try NativeQuickRecordingArchive.durableWrite(data,url);if fail{throw CocoaError(.fileWriteOutOfSpace)}})
        await store.generateSuggestion(id:value.id);let before=try Data(contentsOf:root.appendingPathComponent("quick-recordings/index.json"));fail=true
        try check(!store.adoptSuggestion(title:true,category:true) && store.suggestion != nil,"failed proposal persistence retains preview for retry")
        try check(try Data(contentsOf:root.appendingPathComponent("quick-recordings/index.json"))==before,"staged write failure leaves committed recording unchanged")
        fail=false;try check(store.adoptSuggestion(title:true,category:true),"proposal persistence retries exact selection")
        fail=true;let draft=store.suggestionDraft
        try check(!store.saveSuggestion() && store.suggestionDraft==draft && store.items==[value],"failed final save retains draft and original metadata")
        fail=false;try check(store.saveSuggestion() && store.suggestionDraft==nil,"retry final save succeeds without another model call")
        try check(try fm.contentsOfDirectory(atPath:root.appendingPathComponent("quick-recordings").path).filter{$0.hasPrefix(".recording-index-")}.isEmpty,"failed writes leave no staging files")
    }
    for operation in ["adopt","save","discard"] {
        var revoke=false;var target:NativeQuickRecordingStore?
        let (store,root,value)=try fixture(write:{data,url in try NativeQuickRecordingArchive.durableWrite(data,url);if revoke {target?.setAvailable(false)}});target=store
        await store.generateSuggestion(id:value.id)
        if operation != "adopt" {_ = store.adoptSuggestion(title:true,category:true)}
        let before=try Data(contentsOf:root.appendingPathComponent("quick-recordings/index.json"));revoke=true
        let success=operation=="adopt" ? store.adoptSuggestion(title:true,category:true) : operation=="save" ? store.saveSuggestion() : store.discardSuggestion()
        try check(!success && store.suggestionError==nil && store.suggestion==nil && store.suggestionDraft==nil,"\(operation) revoked before atomic rename neither commits nor publishes a private error")
        try check(try Data(contentsOf:root.appendingPathComponent("quick-recordings/index.json"))==before,"\(operation) revoked transaction preserves exact manifest")
    }
    for effect in ["transcript","rename","category","hide","private","stop","different-detail"] {
        let (store,root,value)=try fixture(),gate=Gate();store.configureTitleRequest{try await gate.request($0)}
        let task=Task{await store.generateSuggestion(id:value.id)}
        while gate.payload==nil {await Task.yield()}
        switch effect {
        case "transcript":store.saveTranscript(id:value.id,text:"New human transcript")
        case "rename":store.beginTitle(id:value.id);store.editTitle("Human draft")
        case "category":store.beginCategory(ids:[value.id]);store.editCategory("Human category draft")
        case "hide":store.setVisible(false)
        case "private":store.setAvailable(false)
        default:store.cancelSuggestion(id:value.id)
        }
        gate.finish();await task.value
        try check(store.suggestion==nil && store.suggestingID==nil,"\(effect) rejects late model output")
        let saved=try NativeQuickRecordingArchive(directory:root.appendingPathComponent("quick-recordings"))
        try check(saved.items.first?.title==value.title && saved.items.first?.category==value.category,"\(effect) retains manual metadata")
        if effect=="rename" {try check(store.titleDraft?.text=="Human draft","late output retains active human title draft")}
        if effect=="category" {try check(store.categoryDraft?.text=="Human category draft","late output retains active category draft")}
        if effect=="transcript" {try check(saved.items.first?.transcript=="New human transcript","late output retains newer transcript")}
    }
    do {
        let (store,_,value)=try fixture();var calls=0
        store.configureTitleRequest{p in if p["action"] as? String == "cancel"{return [:]};calls+=1;var result=reply(p);result["fingerprint"]="b".repeating(64);return result}
        await store.generateSuggestion(id:value.id);try check(store.suggestion==nil && store.suggestionError != nil,"mismatched response identity cannot become candidate")
        store.configureTitleRequest{p in if p["action"] as? String == "cancel"{return [:]};calls+=1;return ["status":"error","reason":"timeout"]}
        await store.generateSuggestion(id:value.id);try check(store.suggestionError?.contains("timed out")==true && store.items==[value],"model timeout reports failure without changing audio or text")
        let (empty,_,missing)=try fixture(item(""));empty.configureTitleRequest{_ in calls+=1;return [:]};await empty.generateSuggestion(id:missing.id)
        try check(!empty.canSuggest(id:missing.id) && calls==2,"empty transcript never starts naming microphone or ASR")
        let (large,_,long)=try fixture(item(String(repeating:"x",count:200001)));large.configureTitleRequest{_ in calls+=1;return [:]};await large.generateSuggestion(id:long.id)
        try check(!large.canSuggest(id:long.id) && calls==2,"oversized transcript is not silently truncated")
    }
    do {
        let (store,root,value)=try fixture();await store.generateSuggestion(id:value.id);try check(store.adoptSuggestion(title:true,category:true),"draft prepared before private transition")
        store.setAvailable(false);try check(store.suggestion==nil && store.suggestionDraft==nil && store.items.isEmpty && !store.saveSuggestion(),"private mode hides proposal and blocks save")
        store.setAvailable(true);try check(store.suggestionDraft != nil && store.items==[value],"return to public state restores exact durable draft")
        try check(store.discardSuggestion() && store.items==[value],"explicit discard preserves manual metadata")
        let archive=try NativeQuickRecordingArchive(directory:root.appendingPathComponent("quick-recordings"));try check(archive.suggestionDraft==nil && archive.items==[value],"discard is durable without deleting the recording")
    }
    print("PASS \(passed) R06 checks; synthetic data, no microphone, ASR, playback or real model")
 }
}
extension String {func repeating(_ n:Int)->String {String(repeating:self,count:n)}}
