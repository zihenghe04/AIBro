import Foundation
import Combine

func nativeUI(_ zh: String, _ en: String) -> String { en }
enum Failure: Error { case failed(String) }
@MainActor var checks = 0
@MainActor func check(_ condition: @autoclosure () -> Bool, _ label: String) throws {
    guard condition() else { throw Failure.failed(label) }; checks += 1
}
let recordVersion = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "sha256:" + String(repeating:"a",count:64)
func note(_ id:String = "capture-1", source:String = "content", version:Double = 10, title:String = "Study notes", text:String = "Study notes\nSynthetic samples.") -> [String:Any] {
    ["id":id,"title":title,"titleSource":source,"content":text,"excerpt":text,"tags":["fixture"],"updatedAt":version,"createdAt":1,"recordVersion":recordVersion,"attachments":[],"derived":[]]
}
func ready(_ value:[String:Any] = note()) -> [String:Any] { ["status":"ready","note":value] }
func generated(_ p:[String:Any], title:String = "Synthetic sample comparison") -> [String:Any] {
    ["status":"generated","id":p["id"]!,"requestId":p["requestId"]!,"expectedVersion":p["expectedVersion"]!,"recordVersion":p["expectedRecordVersion"]!,"title":title,"model":"fixture-model"]
}
func saved(_ p:[String:Any]) -> [String:Any] {
    ["status":"saved","id":p["id"]!,"requestId":p["requestId"]!,"version":11.0,
     "note":note(source:p["titleSource"] as? String ?? "user",version:11,title:p["title"] as? String ?? "Title",text:p["text"] as? String ?? "")]
}
@main struct TitleTests {
    @MainActor static func main() async {
        let directory = URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true)
        do {
            try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
            try await run(directory)
            print("PASS \(checks) capture title assertions")
        } catch { FileHandle.standardError.write(Data("FAIL \(error)\n".utf8)); exit(1) }
    }
    @MainActor static func run(_ directory:URL) async throws {
        var generations = 0, savedPayload:[String:Any]?
        let first = NativeQuickCaptureLibraryStore()
        first.configure(directory:directory.appendingPathComponent("adopt"),request:{ payload in
            switch payload["action"] as? String {
            case "title-generate": generations += 1; return generated(payload)
            case "update": savedPayload=payload; return saved(payload)
            default: return ready()
            }
        },open:{_,_ in true})
        await first.select("capture-1")
        try check(generations == 0 && first.canGenerateTitle,"Selection does not generate")
        await first.generateTitle()
        try check(first.suggestedTitle == "Synthetic sample comparison" && first.title == "Study notes" && first.editing,"Result is review only")
        try check(first.titleModel == "fixture-model" && !first.generatingTitle && savedPayload == nil,"Real result attribution without save")
        first.applySuggestedTitle()
        try check(first.title == "Synthetic sample comparison" && first.canSave && first.suggestedTitle == nil,"Adoption stages normal draft")
        let resumed = NativeQuickCaptureLibraryStore()
        resumed.configure(directory:directory.appendingPathComponent("adopt"),request:{ payload in
            if payload["action"] as? String == "update" { savedPayload=payload; return saved(payload) };return ready()
        },open:{_,_ in true})
        await resumed.select("capture-1")
        try check(resumed.title == first.title && resumed.editing && resumed.canSave,"Accepted generated title survives restart as editable draft")
        await resumed.save()
        try check(savedPayload?["titleSource"] as? String == "model" && savedPayload?["expectedRecordVersion"] as? String == recordVersion,"Save has model provenance and full-record CAS")
        try check(!resumed.editing && resumed.pending == nil && resumed.selected?.titleSource == "model","Exact saved ACK settles draft")

        let manual=NativeQuickCaptureLibraryStore();var manualCalls=0
        manual.configure(directory:directory.appendingPathComponent("manual"),request:{ p in if p["action"] as? String == "title-generate" {manualCalls += 1};return ready(note(source:"user")) },open:{_,_ in true})
        await manual.select("capture-1");await manual.generateTitle()
        try check(!manual.canGenerateTitle && manualCalls == 0 && !manual.editing,"Human title is not sent or overwritten")

        for mutation in ["title","body","record","private","close"] {
            let store=NativeQuickCaptureLibraryStore();var continuation:CheckedContinuation<[String:Any],Never>?,sent:[String:Any]?,cancelled=0
            store.configure(directory:directory.appendingPathComponent(mutation),request:{ p in
                if p["action"] as? String == "title-generate" {sent=p;return await withCheckedContinuation {continuation=$0}}
                if p["action"] as? String == "title-cancel" {cancelled += 1;return ["status":"cancelled"]}
                return ready(note(p["id"] as? String ?? "capture-1"))
            },open:{_,_ in true})
            await store.select("capture-1")
            let job=Task {await store.generateTitle()}
            while continuation == nil {await Task.yield()}
            try check(store.generatingTitle && store.editing,"Generation enters truthful busy state")
            switch mutation {
            case "title":store.title="Human title during request"
            case "body":store.text="Changed draft during request"
            case "record":await store.select("capture-2")
            case "private":store.setAvailable(false)
            default:store.endEditing()
            }
            continuation?.resume(returning:generated(sent!));await job.value
            for _ in 0..<5 {await Task.yield()}
            try check(store.suggestedTitle == nil && store.titleModel == nil && !store.generatingTitle && cancelled == 1,"\(mutation) invalidates and cancels exact request")
            if mutation == "title" {try check(store.title == "Human title during request" && !store.canGenerateTitle,"Manual draft wins")}
            if mutation == "body" {try check(store.text == "Changed draft during request" && store.flushDraft(),"Body draft remains durable")}
            if mutation == "record" {try check(store.selectedID == "capture-2","Late reply does not select old record")}
            if mutation == "private" {try check(store.title.isEmpty && store.text.isEmpty && store.titleError == nil,"Private mode retains no visible title/body/error")}
        }

        let mismatch=NativeQuickCaptureLibraryStore()
        mismatch.configure(directory:directory.appendingPathComponent("mismatch"),request:{ p in
            if p["action"] as? String == "title-generate" {var reply=generated(p);reply["requestId"]="wrong";return reply};return ready()
        },open:{_,_ in true})
        await mismatch.select("capture-1");await mismatch.generateTitle()
        try check(mismatch.suggestedTitle == nil && mismatch.titleError != nil && mismatch.title == "Study notes","Wrong result identity never adopted")

        let failure=NativeQuickCaptureLibraryStore()
        failure.configure(directory:directory.appendingPathComponent("failure"),request:{ p in
            if p["action"] as? String == "title-generate" {return ["status":"error","reason":"timeout"]};return ready()
        },open:{_,_ in true})
        await failure.select("capture-1");failure.beginEditing();failure.text="An unsaved exact body\n  spacing "
        await failure.generateTitle()
        try check(failure.titleError?.contains("30 seconds") == true && failure.text == "An unsaved exact body\n  spacing " && failure.hasChanges,"Failure explains timeout and retains exact draft")

        let late=NativeQuickCaptureLibraryStore()
        late.configure(directory:directory.appendingPathComponent("candidate"),request:{p in p["action"] as? String == "title-generate" ? generated(p):ready()},open:{_,_ in true})
        await late.select("capture-1");await late.generateTitle();late.title="New manual name";late.applySuggestedTitle()
        try check(late.title == "New manual name" && late.suggestedTitle == nil,"Typing after result discards stale candidate")

        let lostDirectory=directory.appendingPathComponent("lost"),lost=NativeQuickCaptureLibraryStore();var committed:[String:Any]?
        lost.configure(directory:lostDirectory,request:{ p in
            switch p["action"] as? String {
            case "title-generate": return generated(p)
            case "update": committed=p;throw Failure.failed("Lost ACK")
            default:return ready()
            }
        },open:{_,_ in true})
        await lost.select("capture-1");await lost.generateTitle();lost.applySuggestedTitle();await lost.save()
        try check(lost.pending?.titleSource == "model" && lost.editError != nil,"Failed ACK retains generated retry envelope")
        let retry=NativeQuickCaptureLibraryStore();var replay:[String:Any]?
        retry.configure(directory:lostDirectory,request:{p in if p["action"] as? String == "update" {replay=p;return saved(p)};return ready()},open:{_,_ in true})
        await retry.select("capture-1");await retry.save()
        try check(replay?["requestId"] as? String == committed?["requestId"] as? String && replay?["titleSource"] as? String == "model" && retry.pending == nil,"Restart retries exact generated-title receipt")

        for scenario in ["content-body","model-tags","adopt-body","adopt-manual"] {
            let store=NativeQuickCaptureLibraryStore();var payload:[String:Any]?
            let source=scenario == "model-tags" ? "model":"content"
            store.configure(directory:directory.appendingPathComponent(scenario),request:{ p in
                if p["action"] as? String == "title-generate" {return generated(p)}
                if p["action"] as? String == "update" {payload=p;return saved(p)}
                return ready(note(source:source))
            },open:{_,_ in true})
            await store.select("capture-1");store.beginEditing()
            if scenario.hasPrefix("adopt-") {await store.generateTitle();store.applySuggestedTitle()}
            if scenario == "model-tags" {store.tags="new-tag"}
            else if scenario == "adopt-manual" {store.title="Human final choice"}
            else {store.text="Changed first line\nA revised synthetic body."}
            await store.save()
            guard let payload else {throw Failure.failed("Missing interoperability payload")}
            if scenario == "content-body" || scenario == "model-tags" {try check(payload["title"] == nil && payload["titleSource"] == nil,"Body/tag-only edit does not seize title ownership")}
            if scenario == "adopt-body" {try check(payload["titleSource"] as? String == "model" && payload["expectedRecordVersion"] as? String == recordVersion,"Adopted model title retains origin/CAS after body edit")}
            if scenario == "adopt-manual" {try check(payload["titleSource"] == nil && payload["title"] as? String == "Human final choice","Manual title edit takes ownership")}
            let result:[String:Any]=["scenario":scenario,"source":source,"payload":payload]
            print("INTEROP " + String(data:try JSONSerialization.data(withJSONObject:result,options:.sortedKeys),encoding:.utf8)!)
        }
    }
}
