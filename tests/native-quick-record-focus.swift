import Foundation
import Combine
import AppKit
import SwiftUI

func nativeUI(_ zh:String,_ en:String)->String {en}
struct ContentRecord {let id:String;let title:String;let workspace:String;let projectId:String;let kind:String;let status:String;let start:Double?;let due:Double?;let completed:Double?;var dueDay:String?=nil;var updated:Double?=nil;var reminderMinutes:Int?=nil;var reminderDisabled:Bool?=nil}
enum Failure:Error {case failed(String)}
@MainActor func check(_ condition:Bool,_ message:String) throws {if !condition {throw Failure.failed(message)}; print("PASS: "+message)}
@MainActor func pending(_ focus:NativeQuickRecordFocus) async throws -> NativeQuickRecordFocusRequest {
    for _ in 0..<50 {if let request=focus.target {return request};try await Task.sleep(nanoseconds:2_000_000)}
    throw Failure.failed("request not staged")
}
@MainActor func snapshot(_ version:String="v1",ready:Bool=true) -> NativeQuickWorkbenchSnapshot {
    .init(version:1,status:ready ? "ready":"deferred",reason:ready ? nil:"private",tasks:ready ? [.init(id:"task-focus",title:"Synthetic assignment",projectTitle:"",dueLabel:"",isCompleted:false,version:version)]:[],runs:[],taskCount:ready ? 1:0,runCount:0)
}
func note() -> [String:Any] {["id":"note-focus","title":"Synthetic note","excerpt":"Synthetic content","content":"Synthetic content","tags":[],"createdAt":1.0,"updatedAt":2.0,"attachments":[],"derived":[],"recordVersion":"v1"]}
func link() -> [String:Any] {["id":"link-focus","title":"Synthetic link","url":"https://example.org/synthetic","site":"example.org","folder":"Research","workspace":"科研","projectId":"p","projectTitle":"Synthetic project","version":"v1","createdAt":1,"hasContent":true,"order":0]}

@main struct FocusChecks {
 @MainActor static func main() async {
  do {
   let root=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true)
   try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
   func folder(_ name:String)throws->URL {let value=root.appendingPathComponent(name);try FileManager.default.createDirectory(at:value,withIntermediateDirectories:true);return value}
   // A setter, stale token, or panel still expanding is not a successful open.
   let broker=NativeQuickRecordFocus();var visible=false,allowed=true,shows=0,finished=false
   let first=Task {let value=await broker.present(id:"a",show:{shows+=1},canPresent:{allowed},isPresented:{visible});finished=true;return value}
   let request=try await pending(broker)
   try check(shows==1 && !finished,"setter waits for mounted acknowledgement")
   broker.acknowledge(.init(token:UUID(),id:"a"));try check(!finished && broker.target==request,"stale marker cannot acknowledge another request")
   try check(!broker.acknowledge(request) && broker.target==request,"hidden or expanding panel cannot ACK")
   allowed=false;broker.acknowledge(request)
   try check(await first.value == false,"permission revoked before mounted ACK rejects navigation")
   allowed=true;visible=true
   let second=Task {await broker.present(id:"a",show:{},canPresent:{allowed},isPresented:{visible})};let next=try await pending(broker);broker.acknowledge(next)
   try check(await second.value && broker.highlightedID=="a","fresh mounted ACK succeeds with a transient highlight")
   let cancelled=Task {await broker.present(id:"b",show:{},canPresent:{true},isPresented:{true})};_ = try await pending(broker);cancelled.cancel()
   try check(await cancelled.value == false,"task cancellation ends its pending focus")
   let absent=Task {await broker.present(id:"not-mounted",show:{},canPresent:{true},isPresented:{true})}
   try check(await absent.value == false,"unmounted target times out without an opened receipt")

   // Native marker runs in a never-shown fixture window; no real App UI or user
   // data is accessed. This exercises SwiftUI mounting, not a direct broker ACK.
   _ = NSApplication.shared;NSApp.setActivationPolicy(.prohibited)
   let mounted=NativeQuickRecordFocus(),window=NSWindow(contentRect:NSRect(x:0,y:0,width:340,height:120),styleMask:[.borderless],backing:.buffered,defer:false)
   window.isReleasedWhenClosed=false
   let host=NSHostingView(rootView:Text("Synthetic target").frame(width:300,height:60).background(NativeQuickRecordFocusMarker(focus:mounted,id:"mounted")))
   window.contentView=host;host.layoutSubtreeIfNeeded()
   let rendered=Task {await mounted.present(id:"mounted",show:{host.layoutSubtreeIfNeeded()},canPresent:{true},isPresented:{true})}
   try check(await rendered.value,"actual mounted NSView marker acknowledges visible target geometry")
   try check(!window.isVisible,"fixture never opens or activates a user window")
   let offscreen=NativeQuickRecordFocus()
   window.contentView=NSHostingView(rootView:ScrollView {VStack {ForEach(0..<80) {index in
    Text("Synthetic row \(index)").frame(width:300,height:40).id(String(index)).background(NativeQuickRecordFocusMarker(focus:offscreen,id:String(index)))
   }}})
   window.contentView?.layoutSubtreeIfNeeded()
   let unseen=Task {await offscreen.present(id:"79",show:{window.contentView?.layoutSubtreeIfNeeded()},canPresent:{true},isPresented:{true})}
   try check(await unseen.value == false,"mounted but clipped offscreen row is not a visible ACK")
   let scroll=NativeQuickRecordFocus()
   window.contentView=NSHostingView(rootView:NativeQuickFocusScroll(focus:scroll) {
    ScrollView {LazyVStack {ForEach(0..<80) {index in
     Text("Synthetic row \(index)").frame(width:300,height:40).id(String(index)).background(NativeQuickRecordFocusMarker(focus:scroll,id:String(index)))
    }}}
   })
   window.contentView?.layoutSubtreeIfNeeded()
   let scrolled=Task {await scroll.present(id:"79",show:{window.contentView?.layoutSubtreeIfNeeded()},canPresent:{true},isPresented:{true})}
   try check(await scrolled.value,"actual ScrollViewReader reveals and acknowledges a distant lazy row")
   window.close()

   let tasks=NativeQuickWorkbenchStore();tasks.configure(directory:try folder("tasks"),command:{_ in [:]},openTask:{_ in false},openRun:{_ in false});tasks.accept(snapshot())
   let taskOpen=Task {await tasks.focusTask(id:"task-focus",show:{},canPresent:{true},isPresented:{true})};let tr=try await pending(tasks.recordFocus)
   tasks.accept(snapshot("v2"));tasks.recordFocus.acknowledge(tr)
   try check(await taskOpen.value == false,"task version changed during presentation rejects old row")
   let taskFresh=Task {await tasks.focusTask(id:"task-focus",show:{},canPresent:{true},isPresented:{true})};let tf=try await pending(tasks.recordFocus);tasks.recordFocus.acknowledge(tf)
   try check(await taskFresh.value && tasks.taskSelection.ids.isEmpty,"task navigation succeeds without toggling completion or multi-selection")
   let hiddenTask=Task {await tasks.focusTask(id:"task-focus",show:{},canPresent:{true},isPresented:{true})};_ = try await pending(tasks.recordFocus);tasks.accept(snapshot(ready:false))
   try check(await hiddenTask.value == false,"private workspace invalidates a pending task focus")

   let capture=NativeQuickCaptureLibraryStore();var captureWrites=0
   capture.configure(directory:try folder("capture"),request:{payload in
    if payload["action"] as? String != "get" {captureWrites+=1};return ["status":"ready","note":note()]
   },open:{_,_ in true})
   try check(await capture.prepareRecordFocus(id:"note-focus") && capture.selectedID=="note-focus" && !capture.editing,"capture preparation selects the original note read-only")
   let captureOpen=Task {await capture.focusRecord(id:"note-focus",show:{},canPresent:{true},isPresented:{true})};let cr=try await pending(capture.recordFocus);capture.recordFocus.acknowledge(cr)
   try check(await captureOpen.value && captureWrites==0,"capture ACK does not create a draft or mutate content")
   let editedCapture=Task {await capture.focusRecord(id:"note-focus",show:{},canPresent:{true},isPresented:{true})};let ce=try await pending(capture.recordFocus);capture.beginEditing();capture.text="Retained human draft";capture.recordFocus.acknowledge(ce)
   try check(await editedCapture.value == false && capture.text=="Retained human draft","new capture draft vetoes the pending focus and remains intact")
   try check(await capture.prepareRecordFocus(id:"note-focus") == false,"existing capture draft is not auto-discarded for navigation")

   let links=NativeQuickLinksStore();var linkWrites=0
   links.configure(directory:try folder("links"),request:{payload in
    if payload["action"] as? String != "list" {linkWrites+=1};return ["status":"ready","rows":[link()],"projects":[["id":"p","title":"Synthetic project","workspace":"科研"]],"trash":[]]
   },openSource:{_ in true},openURL:{_ in true});links.setAvailable(true);await links.refresh()
   let group=links.rows[0].groupID;links.toggleGroup(group)
   try check(links.isGroupCollapsed(group),"fixture starts with collapsed link group")
   links.query="unrelated filter"
   try check(await links.prepareRecordFocus(id:"link-focus") && links.query.isEmpty && !links.isGroupCollapsed(group),"link navigation reveals exact existing row through filter and collapsed group")
   let linkOpen=Task {await links.focusRecord(id:"link-focus",show:{},canPresent:{true},isPresented:{true})};let lr=try await pending(links.recordFocus);links.recordFocus.acknowledge(lr)
   try check(await linkOpen.value && linkWrites==0,"link position ACK never opens URL or fetches source")
   links.clearRecordFocus();try check(links.isGroupCollapsed(group),"temporary target expansion preserves original layout preference")
   _ = await links.prepareRecordFocus(id:"link-focus")
   let linkHidden=Task {await links.focusRecord(id:"link-focus",show:{},canPresent:{true},isPresented:{true})};_ = try await pending(links.recordFocus);links.setAvailable(false)
   try check(await linkHidden.value == false && links.rows.isEmpty,"private transition clears link focus and rows")

   let agenda=AgendaStore();agenda.load(folder:try folder("agenda"),qa:true)
   var event=AgendaEvent();event.id="event-focus";event.title="Synthetic event";event.projectID="p";event.start=Date().addingTimeInterval(86400*3);event.end=event.start.addingTimeInterval(1200);event.reminderMinutes=nil
   try agenda.save(event,expected:nil)
   var context=NativeQuickAgendaContext(ready:true,privateMode:false,projects:[.init(id:"p",title:"Synthetic project")],documents:[],taskIDs:[],projectID:"p")
   let quick=NativeQuickAgendaStore();quick.configure(agenda:agenda,context:{context},openTask:{_ in false},openAgenda:{_ in})
   let calendarOpen=Task {await quick.focusEvent(id:"event-focus",show:{},canPresent:{true},isPresented:{true})};let er=try await pending(quick.recordFocus)
   try check(er.id != event.id && quick.occurrences.contains{$0.id==er.id && $0.event.id==event.id},"calendar locates the original occurrence on the original event date")
   quick.recordFocus.acknowledge(er);try check(await calendarOpen.value && !quick.hasEditor && agenda.events.count==1,"calendar ACK opens no editor and creates no duplicate event")
   let revoked=Task {await quick.focusEvent(id:"event-focus",show:{},canPresent:{true},isPresented:{true})};let pr=try await pending(quick.recordFocus);context.projects=[];quick.recordFocus.acknowledge(pr)
   try check(await revoked.value == false && quick.occurrences.isEmpty,"removed calendar project invalidates pending occurrence ACK")
   context.projects=[.init(id:"p",title:"Synthetic project")]
   let newEditor=Task {await quick.focusEvent(id:"event-focus",show:{},canPresent:{true},isPresented:{true})};let dr=try await pending(quick.recordFocus);_ = quick.beginNew();quick.updateDraft{$0.title="Retained event draft"};quick.recordFocus.acknowledge(dr)
   try check(await newEditor.value == false && quick.editing?.event.title=="Retained event draft","new calendar draft vetoes record focus without losing input")
   print("PASS: all record focus gates")
  } catch {FileHandle.standardError.write(Data("FAIL: \(error)\n".utf8));exit(1)}
 }
}
