import Foundation
import AppKit
import SwiftUI
func nativeUI(_ zh:String,_ en:String)->String { en }
@MainActor final class OrderGate {
    var continuation: CheckedContinuation<Void,Never>?
    func wait() async { await withCheckedContinuation { continuation=$0 } }
    func release() { continuation?.resume();continuation=nil }
}
@MainActor final class OrderFixture {
    let store=NativeQuickLinksStore()
    let directory:URL
    var data:[[String:Any]]
    var calls:[[String:Any]]=[]
    var gate:OrderGate?
    var failure=false,wrongACK=false
    var protected=false
    init(_ name:String,_ root:URL,extraRows:[[String:Any]] = []) throws {
        directory=root.appendingPathComponent(name)
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
        data=[Self.row("a",0),Self.row("b",1),Self.row("c",2),Self.row("d",3),Self.row("other",0,folder:"Other")]+extraRows
        store.configure(directory:directory,request:{[unowned self] in try await self.request($0)},openSource:{_ in true},openURL:{_ in true})
        store.setAvailable(true)
    }
    static func row(_ id:String,_ order:Int,folder:String="Reading")->[String:Any] {
        ["id":id,"title":id,"url":"https://example.org/"+id,"site":"example.org","folder":folder,"workspace":"科研","projectId":"p","projectTitle":"Project","version":"v1","createdAt":1,"hasContent":true,"order":order]
    }
    func request(_ payload:[String:Any]) async throws -> [String:Any] {
        if payload["action"] as? String == "list" {
            let needle=(payload["query"] as? String ?? "").trimmingCharacters(in:.whitespacesAndNewlines)
            let rows=data.filter{needle.isEmpty || ($0["title"] as! String).contains(needle)}.sorted { ($0["order"] as! Int) < ($1["order"] as! Int) }
            let group:[String:Any]=["id":"科研\u{1f}p\u{1f}Reading","folder":"Reading","workspace":"科研","projectId":"p","projectTitle":"Project","version":"group-v1","linkIDs":data.filter{($0["folder"] as! String).hasPrefix("Reading")}.map{$0["id"]!},"canRename":false,"canDelete":false,"blockedReason":protected ? "folder_protected":"folder_children"]
            return ["status":"ready","rows":rows,"groups":[group],"projects":[],"trash":[]]
        }
        calls.append(payload)
        if let gate { await gate.wait() }
        if failure { throw CocoaError(.fileWriteUnknown) }
        let items=payload["items"] as! [[String:Any]]
        if wrongACK { return ["status":"saved","requestId":payload["requestId"]!,"action":"update","ids":["wrong"]] }
        for item in items {
            let index=data.firstIndex{$0["id"] as? String==item["id"] as? String}!
            data[index]["order"]=(item["patch"] as! [String:Any])["order"]
            data[index]["version"]="v2"
        }
        return ["status":"saved","requestId":payload["requestId"]!,"action":"update","ids":items.map{$0["id"]!}]
    }
    var folderIDs:[String] { store.rows.filter{$0.folder=="Reading"}.map(\.id) }
    func row(_ id:String)->NativeQuickLinkRow { store.rows.first{$0.id==id}! }
}
@main struct LinkOrderingChecks {
    @MainActor static func main() async throws {
        setbuf(stdout,nil)
        let root=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true)
        var count=0
        func check(_ condition:Bool,_ message:String) { precondition(condition,message);count+=1;print("PASS "+message) }
        func pending(_ f:OrderFixture)throws->Data? {
            let draft=try JSONSerialization.jsonObject(with:Data(contentsOf:f.directory.appendingPathComponent("native-quick-links-draft.json"))) as! [String:Any]
            return (draft["pending"] as? String).flatMap { Data(base64Encoded:$0) }
        }
        for (name,action,expected) in [("up",NativeQuickLinkOrderAction.up,["b","a","c","d"]),("down",.down,["a","c","b","d"]),("first",.first,["b","a","c","d"]),("last",.last,["a","c","d","b"])] {
            let f=try OrderFixture(name,root,extraRows:[OrderFixture.row("child",0,folder:"Reading/Subfolder")]);await f.store.refresh()
            let original=f.row("b")
            check(f.store.canReorder(original,action:action),name+" is available in an unfiltered real folder with descendants")
            let confirmed=await f.store.reorder(original,action:action)
            let items=f.calls.last!["items"] as! [[String:Any]]
            check(confirmed && f.folderIDs==expected && items.map{$0["id"] as! String}==expected,name+" applies the exact folder sequence after ACK")
            check(items.allSatisfy{($0["expectedVersion"] as? String)=="v1" && Set(($0["patch"] as! [String:Any]).keys)==["order"]} && f.row("other").version=="v1" && f.row("child").version=="v1",name+" preserves other folders, descendants, fields and all version guards")
            check(try f.store.pending==nil && pending(f)==nil,name+" clears the exact durable retry journal after save")
            if name=="last" { try JSONSerialization.data(withJSONObject:f.calls.last!,options:[.sortedKeys]).write(to:root.appendingPathComponent("swift-order-payload.json")) }
        }
        let boundary=try OrderFixture("boundary",root);await boundary.store.refresh()
        for (id,action) in [("a",NativeQuickLinkOrderAction.up),("a",.first),("d",.down),("d",.last)] {
            check(!boundary.store.canReorder(boundary.row(id),action:action),"boundary disables \(id) \(action)")
            await boundary.store.reorder(boundary.row(id),action:action)
        }
        check(boundary.calls.isEmpty && boundary.store.pending==nil,"boundary actions never create a write or retry journal")
        let stale=boundary.row("b");boundary.data[1]["version"]="v3";await boundary.store.refresh()
        check(!boundary.store.canReorder(stale,action:.last),"stale row captured by an open menu cannot reorder a new version")
        boundary.store.groupBySite=true
        check(!boundary.store.canReorder(boundary.row("b"),action:.last),"site groups cannot reorder mixed real folders")
        boundary.store.groupBySite=false;boundary.store.query="b";await boundary.store.refresh()
        check(!boundary.store.canReorder(boundary.row("b"),action:.last),"search results cannot reorder a partial folder")
        boundary.store.query=""
        check(!boundary.store.canReorder(boundary.row("b"),action:.last),"clearing the search waits for a complete list response")
        await boundary.store.refresh();check(boundary.store.canReorder(boundary.row("b"),action:.last),"completed clear-search refresh makes ordering available")
        boundary.store.beginEditing(boundary.row("b"))
        check(!boundary.store.canReorder(boundary.row("b"),action:.last),"even an unchanged editor blocks order actions")
        _=boundary.store.discardDraft();boundary.protected=true;await boundary.store.refresh()
        check(!boundary.store.canReorder(boundary.row("b"),action:.last),"hidden folder members are not silently reordered")
        boundary.protected=false;await boundary.store.refresh();boundary.store.showingTrash=true
        check(!boundary.store.canReorder(boundary.row("b"),action:.last),"trash mode cannot reorder saved links")
        boundary.store.showingTrash=false
        let focusValid=boundary.store.orderFocusValidator(for:boundary.row("b"))
        boundary.store.setAvailable(false);boundary.store.setAvailable(true);await boundary.store.refresh()
        check(!focusValid(),"private and reavailable invalidates old focus ownership even for the same row")

        let delayed=try OrderFixture("delayed",root),gate=OrderGate();await delayed.store.refresh();delayed.gate=gate
        let moving=delayed.row("b"),before=delayed.store.rows
        let write=Task { await delayed.store.reorder(moving,action:.last) }
        while gate.continuation==nil { await Task.yield() }
        check(delayed.store.rows==before && delayed.store.saving && delayed.store.pending != nil,"pending order keeps the original projection until durable ACK")
        check(try pending(delayed)==delayed.store.pending,"exact order command is written to disk before dispatch")
        check(!delayed.store.canReorder(moving,action:.up),"a second ordering action is disabled during the first save")
        delayed.failure=true;gate.release();let unconfirmed=await write.value
        check(!unconfirmed && delayed.store.rows==before && delayed.store.error != nil && delayed.store.pending != nil,"failed save keeps original order and visible retry state")
        let frozen=delayed.store.pending;delayed.gate=nil;delayed.failure=false;await delayed.store.retry()
        check(delayed.folderIDs==["a","c","d","b"] && delayed.calls.count==2 && delayed.calls[0]["requestId"] as? String==delayed.calls[1]["requestId"] as? String && frozen != nil,"retry persists exactly the same order and request identity")
        let wrong=try OrderFixture("wrong",root);await wrong.store.refresh();wrong.wrongACK=true
        await wrong.store.reorder(wrong.row("b"),action:.last)
        check(wrong.folderIDs==["a","b","c","d"] && wrong.store.pending != nil && wrong.store.error != nil,"wrong record ACK cannot move the local list or clear the retry")
        let large=try OrderFixture("large",root,extraRows:(0..<497).map{OrderFixture.row("extra-\($0)",$0+4)})
        await large.store.refresh();check(!large.store.canReorder(large.row("b"),action:.last),"bridge 500-item atomic limit is not bypassed or partially applied")

        let bridge=try OrderFixture("bridge",root)
        let nativeRows=try JSONSerialization.jsonObject(with:Data(contentsOf:root.appendingPathComponent("bridge-list.json"))) as! [[String:Any]]
        bridge.data=nativeRows;await bridge.store.refresh()
        await bridge.store.reorder(bridge.row("b"),action:.last)
        try JSONSerialization.data(withJSONObject:bridge.calls.last!,options:.sortedKeys).write(to:root.appendingPathComponent("swift-order-payload.json"))

        // Exercise the production focus lease and existing visible ACK broker,
        // with no displayed window, event posting, system AX or permission use.
        var owned=true,valid=true,applied=0
        let focus=NativeQuickLinkOrderFocus(keyboardOwned:{owned})
        let token=focus.begin(canRestore:{valid})!
        check(focus.position.target==nil,"menu activation does not scroll before the save finishes")
        let restore=Task{await focus.restore(token,id:"b"){applied+=1}}
        while focus.position.target==nil {await Task.yield()}
        let request=focus.position.target!
        check(!focus.position.acknowledge(request,isVisible:{false}) && applied==0,"offscreen row cannot acknowledge restoration")
        _=focus.position.acknowledge(request,isVisible:{true});await restore.value
        check(applied==1 && !focus.owns(token),"matching visible record restores once and releases the lease")
        await focus.restore(token,id:"b"){applied+=1};check(applied==1,"repeated old ACK cannot refocus the row")
        func key(_ code:UInt16)->NSEvent {NSEvent.keyEvent(with:.keyDown,location:.zero,modifierFlags:[],timestamp:0,windowNumber:0,context:nil,characters:"",charactersIgnoringModifiers:"",isARepeat:false,keyCode:code)!}
        for code:UInt16 in [48,53,125] {
            let pending=focus.begin(canRestore:{valid})!;focus.receiveUserEvent(key(code));await focus.restore(pending,id:"b"){applied+=1}
            check(applied==1 && focus.position.target==nil,"fresh key \(code) while saving rejects late focus and scroll")
        }
        let mouse=NSEvent.mouseEvent(with:.leftMouseDown,location:.zero,modifierFlags:[],timestamp:0,windowNumber:0,context:nil,eventNumber:1,clickCount:1,pressure:1)!
        let clicked=focus.begin(canRestore:{valid})!;focus.receiveUserEvent(mouse);await focus.restore(clicked,id:"b"){applied+=1}
        check(applied==1,"clicking a different control during save does not get stolen back")
        let old=focus.begin(canRestore:{valid})!,new=focus.begin(canRestore:{valid})!
        await focus.restore(old,id:"b"){applied+=1}
        check(focus.owns(new),"old reply cannot cancel a newer ordering lease")
        focus.cancel();let hidden=focus.begin(canRestore:{valid})!;focus.cancel();await focus.restore(hidden,id:"b"){applied+=1}
        check(applied==1,"view disappearance revokes pending restoration")
        let changed=focus.begin(canRestore:{valid})!;valid=false;await focus.restore(changed,id:"b"){applied+=1}
        check(applied==1,"scope, editor or collapsed folder change blocks restoration")
        valid=true;let windowLost=focus.begin(canRestore:{valid})!;owned=false;await focus.restore(windowLost,id:"b"){applied+=1}
        check(applied==1 && focus.begin(canRestore:{true})==nil,"lost keyboard ownership never reactivates a window")
        owned=true
        let late=focus.begin(canRestore:{valid})!;let awaiting=Task{await focus.restore(late,id:"b"){applied+=1}}
        while focus.position.target==nil {await Task.yield()}
        _=focus.position.acknowledge(focus.position.target!,isVisible:{true});focus.receiveUserEvent(key(48));await awaiting.value
        check(applied==1,"input between mounted ACK and async continuation still wins")
        print("PASS: \(count) link ordering and focus checks")
    }
}
