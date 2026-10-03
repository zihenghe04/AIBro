import Foundation
import Combine
func nativeUI(_ zh:String,_ en:String)->String {en}
enum Failure:Error {case failed(String)}
@MainActor func check(_ condition:Bool,_ message:String) throws {if !condition {throw Failure.failed(message)};print("PASS: "+message)}
func note(_ id:String)->[String:Any] {["id":id,"title":"Synthetic "+id,"excerpt":"Synthetic content","content":"Synthetic content","tags":[],"createdAt":1.0,"updatedAt":2.0,"attachments":[],"derived":[],"recordVersion":"v1"]}
@main struct RaceChecks {
 @MainActor static func main() async {
  do {
   let directory=URL(fileURLWithPath:CommandLine.arguments[1]);try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
   let store=NativeQuickCaptureLibraryStore();var release:CheckedContinuation<[String:Any],Never>?
   store.configure(directory:directory,request:{value in
    let id=value["id"] as! String
    if id=="new-note" {return await withCheckedContinuation{release=$0}}
    return ["status":"ready","note":note(id)]
   },open:{_,_ in true})
   await store.select("old-note")
   let preparation=Task {await store.prepareRecordFocus(id:"new-note")}
   while release==nil {await Task.yield()}
   store.beginEditing();store.title="Unsent title";store.text="User typed while get was pending"
   release?.resume(returning:["status":"ready","note":note("new-note")]);release=nil
   try check(await preparation.value == false,"pending Agent get rejects new native editing before applying reply")
   try check(store.selectedID=="old-note" && store.editing && store.title=="Unsent title" && store.text=="User typed while get was pending" && store.focusedRecordID==nil,"current editor and selected original remain untouched")
   try check(store.flushDraft(),"interleaved human draft remains durably saveable")
   let restored=NativeQuickCaptureLibraryStore();restored.configure(directory:directory,request:{value in ["status":"ready","note":note(value["id"] as! String)]},open:{_,_ in true});await restored.select("old-note")
   try check(restored.editing && restored.text==store.text && restored.title==store.title,"draft survives a fresh store after rejected focus")

   // Exercise the production final async-confirmation helper. The host lease
   // succeeds; native presentation changes while that await is outstanding.
   for change in ["page","editor","selection","geometry"] {
    let focus=NativeQuickRecordFocus();var page=true,editor=false,selected="target",visible=true
    let focusTask=Task {await focus.present(id:"target",show:{},canPresent:{!editor && selected=="target"},isPresented:{page})}
    while focus.target==nil {await Task.yield()}
    focus.acknowledge(focus.target!,isVisible:{visible})
    try check(await focusTask.value,"target initially has a valid ACK for "+change)
    var finishVerify:CheckedContinuation<Bool,Never>?
    let final=Task {await NativeQuickPanelOpenResult.positioned(section:.capture,recordType:"note",recordID:"target").confirmed(verify:{await withCheckedContinuation{finishVerify=$0}},isPresented:{focus.isStillPresented(id:"target")})}
    while finishVerify==nil {await Task.yield()}
    switch change {case "page":page=false;case "editor":editor=true;case "selection":selected="another";default:visible=false}
    finishVerify?.resume(returning:true)
    let result=await final.value
    try check(result.payload["status"] as? String=="deferred" && result.payload["reason"] as? String=="presentation_changed","last native guard follows final JS await: "+change)
   }
   print("PASS: both production async race regressions")
  }catch{FileHandle.standardError.write(Data("FAIL: \(error)\n".utf8));exit(1)}
 }
}
