import AppKit
import SwiftUI
func nativeUI(_ zh:String,_ en:String)->String{en}
@MainActor final class DragGate {
    var next:CheckedContinuation<Void,Never>?
    func wait() async{await withCheckedContinuation{next=$0}}
    func release(){next?.resume();next=nil}
}
@MainActor final class DragFixture {
    let store=NativeQuickLinksStore()
    var data:[[String:Any]],groups:[[String:Any]],calls:[[String:Any]]=[]
    var gate:DragGate?,fail=false,wrong=false
    init(_ name:String,root:URL,source:[String:Any]?=nil)throws {
        data=source?["rows"] as? [[String:Any]] ?? [Self.row("a",0),Self.row("b",1),Self.row("c",2),Self.row("d",3),Self.row("other",0,folder:"Other")]
        groups=source?["groups"] as? [[String:Any]] ?? [Self.group("Reading",ids:["a","b","c","d"]),Self.group("Other",ids:["other"]),Self.group("Empty",ids:[])]
        let directory=root.appendingPathComponent(name);try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
        store.configure(directory:directory,request:{[unowned self] in try await self.request($0)},openSource:{_ in true},openURL:{_ in true});store.setAvailable(true);store.setVisible(true)
    }
    static func row(_ id:String,_ order:Int,folder:String="Reading")->[String:Any]{["id":id,"title":"Human "+id,"url":"https://example.org/"+id,"site":"example.org","folder":folder,"workspace":"科研","projectId":"p","projectTitle":"Project","version":"v1","createdAt":1,"hasContent":true,"order":order]}
    static func group(_ folder:String,ids:[String])->[String:Any]{["id":"科研\u{1f}p\u{1f}"+folder,"folder":folder,"workspace":"科研","projectId":"p","projectTitle":"Project","version":"g1","linkIDs":ids,"canRename":true,"canDelete":ids.isEmpty,"blockedReason":""]}
    func request(_ payload:[String:Any]) async throws->[String:Any] {
        if payload["action"] as? String=="list" {
            let q=(payload["query"] as? String ?? "").trimmingCharacters(in:.whitespacesAndNewlines)
            return ["status":"ready","rows":data.filter{q.isEmpty || ($0["title"] as! String).contains(q)}.sorted{($0["order"] as! Int)<($1["order"] as! Int)},"groups":groups,"projects":[],"trash":[]]
        }
        calls.append(payload);if let gate{await gate.wait()};if fail{throw CocoaError(.fileWriteUnknown)}
        let items=payload["items"] as! [[String:Any]]
        if wrong{return ["status":"saved","requestId":payload["requestId"]!,"action":"update","ids":["wrong"]]}
        for item in items {let i=data.firstIndex{$0["id"] as? String==item["id"] as? String}!;for(k,v)in item["patch"] as! [String:Any]{data[i][k]=v};data[i]["version"]="v2"}
        for i in groups.indices {let folder=groups[i]["folder"] as! String;groups[i]["linkIDs"]=data.filter{$0["folder"] as? String==folder}.map{$0["id"]!}}
        return ["status":"saved","requestId":payload["requestId"]!,"action":"update","ids":items.map{$0["id"]!}]
    }
    func row(_ id:String)->NativeQuickLinkRow {store.rows.first{$0.id==id}!}
    func target(_ folder:String,_ id:String?=nil,after:Bool=false)->NativeQuickLinkDropTarget{.init(groupID:"科研\u{1f}p\u{1f}"+folder,rowID:id,after:after)}
    func ids(_ folder:String)->[String]{store.rows.filter{$0.folder==folder}.map(\.id)}
}
@MainActor final class EventGrip:NativeQuickLinkDragHandle.Handle {
    var requests:[NSEvent?]=[]
    override func requestDragStart(using event:NSEvent?){requests.append(event);cancelPress()}
}
@MainActor final class TestWindow:NSWindow {
    var owned=true
    override var isVisible:Bool{true}
    override var isKeyWindow:Bool{owned}
}
@main struct DragChecks {
    @MainActor static func main()async throws {
        setbuf(stdout,nil);let root=URL(fileURLWithPath:CommandLine.arguments[1]);var checks=0
        func check(_ b:Bool,_ text:String){precondition(b,text);checks+=1;print("PASS \(checks): "+text)}
        func wait(_ condition:()->Bool)async{for _ in 0..<500 {if condition(){return};try? await Task.sleep(nanoseconds:1_000_000)};preconditionFailure("timeout")}
        for (name,moving,target,after,expected) in [("down-before","a","d",false,["b","c","a","d"]),("down-after","a","d",true,["b","c","d","a"]),("up-before","d","a",false,["d","a","b","c"]),("up-after","d","a",true,["a","d","b","c"])] {
            let f=try DragFixture(name,root:root);await f.store.refresh();let saved=await f.store.place(f.row(moving),at:f.target("Reading",target,after:after))
            check(saved && f.store.orderRevision==1 && f.ids("Reading")==expected,name+" removes the source before computing insertion")
            let items=f.calls[0]["items"] as! [[String:Any]]
            check(items.allSatisfy{Set(($0["patch"] as! [String:Any]).keys)==["order"] && $0["expectedVersion"] as? String=="v1"},name+" writes only ordered IDs/versions/order")
        }
        let f=try DragFixture("boundaries",root:root);await f.store.refresh();check(f.store.orderRevision==0,"initial and ordinary list loads do not start sorting animation")
        for t in [f.target("Reading","b"),f.target("Reading","a",after:true),f.target("Reading","c")] {check(!f.store.canPlace(f.row("b"),at:t),"self or unchanged adjacent insertion is not a mutation")}
        check(!f.store.canPlace(f.row("d"),at:f.target("Reading")),"current tail dropped on own group is a no-op")
        let saved=await f.store.place(f.row("b"),at:f.target("Empty"));check(saved && f.ids("Empty")==["b"] && f.ids("Reading")==["a","c","d"],"empty folder accepts a real cross-group move")
        let command=f.calls.last!;check((command["destination"] as? [String:Any])?["expectedVersion"] as? String=="g1","cross-group move keeps the target folder version guard")
        check(f.row("b").title=="Human b" && f.row("b").url=="https://example.org/b","move retains manual title and URL")
        let snapshot=f.row("a"),valid=f.store.dragValidator(for:f.row("a"));await f.store.refresh();check(!valid(),"a new list projection invalidates the captured drag lease")
        f.store.query="Human a";await f.store.refresh();check(!f.store.canDrag(f.row("a")),"filtered folder cannot be reordered")
        f.store.query="";check(!f.store.canDrag(f.row("a")),"clearing search waits for complete results")
        await f.store.refresh();f.store.groupBySite=true;check(!f.store.canDrag(f.row("a")),"site projection cannot reorder real folders")
        f.store.groupBySite=false;f.store.beginEditing(f.row("a"));check(!f.store.canDrag(f.row("a")),"existing editor and draft keep ownership")
        _=f.store.discardDraft();let permission=f.store.dragValidator(for:snapshot),focusPermission=f.store.moveFocusValidator(for:snapshot);f.store.setVisible(false);check(!permission(),"collapse invalidates a pending drag before provider dispatch")
        f.store.setVisible(true);check(!permission() && !focusPermission(),"hide then reopen without refresh cannot revive drag or focus leases")
        check(f.store.dragValidator(for:snapshot)() && f.store.moveFocusValidator(for:snapshot)(),"a new visible session can acquire fresh drag and focus leases")
        f.store.setAvailable(false);f.store.setAvailable(true);await f.store.refresh();check(!permission(),"private/reavailable cannot revive a previous drag owner")
        let delayed=try DragFixture("delayed",root:root);await delayed.store.refresh();let gate=DragGate();delayed.gate=gate
        let before=delayed.store.rows,drag=NativeQuickLinkDrag();drag.beginSaving("a")
        let operation=Task {await delayed.store.place(delayed.row("a"),at:delayed.target("Other","other",after:true))};await wait{gate.next != nil}
        check(delayed.store.orderRevision==0 && delayed.store.rows==before && delayed.store.pending != nil && !delayed.store.canDrag(delayed.row("b")),"pending move preserves projection, freezes duplicate ordering and retains exact retry")
        delayed.fail=true;gate.release();let result=await operation.value;drag.finishSaving("a",confirmed:result)
        check(!result && drag.settledID==nil && delayed.store.pending != nil,"unknown save cannot show successful movement or settlement")
        let originalRequest=delayed.calls[0]["requestId"] as! String;delayed.fail=false;delayed.gate=nil;await delayed.store.retry()
        check(delayed.ids("Other")==["other","a"] && delayed.calls[1]["requestId"] as? String==originalRequest,"retry confirms the original immutable move instead of writing a new one")
        let wrong=try DragFixture("wrong",root:root);await wrong.store.refresh();wrong.wrong=true
        check(!(await wrong.store.place(wrong.row("a"),at:wrong.target("Reading","d",after:true))) && wrong.store.pending != nil,"mismatched ACK keeps the move unconfirmed")

        // Real NSItemProvider callbacks, no global pasteboard or drag session.
        let d=NativeQuickLinkDrag(),row=delayed.row("b"),target=delayed.target("Reading","d",after:true)
        var commits=0,allowed=true,completion:((Data?,Error?)->Void)?
        func provider(_ bytes:Data?,deferred:Bool=false)->NSItemProvider {
            let p=NSItemProvider();p.registerDataRepresentation(forTypeIdentifier:NativeQuickLinkDrag.pasteboardType.rawValue,visibility:.ownProcess) {cb in
                if deferred {completion=cb}else{cb(bytes,nil)};return Progress(totalUnitCount:1)
            };return p
        }
        let old=d.begin(row,valid:{allowed})!;d.cancel();let current=d.begin(row,valid:{allowed})!
        check(old != current && d.receive(provider(old),target:target){_,_ in commits+=1},"old native provider may decode but must prove the current nonce")
        await wait{d.nonce==nil};check(commits==0,"a previous session nonce cannot move a link")
        let bytes=d.begin(row,valid:{allowed})!;check(d.receive(provider(bytes,deferred:true),target:target){_,_ in commits+=1},"current session accepts exactly one deferred provider")
        await wait{completion != nil};d.cancel();completion?(bytes,nil);try? await Task.sleep(nanoseconds:10_000_000)
        check(commits==0 && d.source==nil && d.target==nil,"cancel or hidden page clears marks and discards a late provider")
        completion=nil;let canceled=d.begin(row,valid:{allowed})!,canceledToken=d.nonce!
        check(d.receive(provider(canceled,deferred:true),target:target){_,_ in commits+=1},"a provider may be pending when the native drag is canceled")
        await wait{completion != nil};d.ended(canceledToken,operation:[]);completion?(canceled,nil);try? await Task.sleep(nanoseconds:10_000_000)
        check(commits==0 && d.nonce==nil && d.source==nil && d.target==nil,"native canceled end revokes pending provider and never commits its late bytes")
        let accepted=d.begin(row,valid:{allowed})!,token=d.nonce!;check(d.receive(provider(accepted),target:target){_,_ in commits+=1;d.beginSaving(row.id)},"matching provider accepts a committed drop")
        d.ended(token,operation:.move);await wait{commits==1};check(d.savingID==row.id,"native drag end does not cancel an already accepted provider handoff")
        d.cancel();d.finishSaving(row.id,confirmed:true);check(d.settledID==nil,"closing during save prevents a late success flash")
        _=d.begin(row,valid:{allowed});let token2=d.nonce!;d.mark(target);d.ended(token2,operation:[]);check(d.source==nil && d.target==nil,"outside/Escape native end clears the source and insertion marks")
        _=d.begin(row,valid:{allowed});allowed=false;check(!d.acceptsSession,"permission or stale source invalidates a drop synchronously");d.cancel()

        // Production grip entry methods with the system drag start isolated.
        let grip=EventGrip(frame:NSRect(x:0,y:0,width:16,height:30));grip.valid={true}
        func mouse(_ type:NSEvent.EventType,_ x:CGFloat)->NSEvent {NSEvent.mouseEvent(with:type,location:.init(x:x,y:10),modifierFlags:[],timestamp:0,windowNumber:0,context:nil,eventNumber:1,clickCount:1,pressure:1)!}
        grip.mouseDown(with:mouse(.leftMouseDown,0));grip.mouseDragged(with:mouse(.leftMouseDragged,3));check(grip.requests.isEmpty,"grip keeps tiny pointer jitter below 4pt")
        grip.mouseDragged(with:mouse(.leftMouseDragged,5));check(grip.requests.count==1 && grip.requests[0]?.type == .leftMouseDragged,"ordinary immediate grip drag starts with the actual drag event")
        grip.mouseDown(with:mouse(.leftMouseDown,0));grip.mouseUp(with:mouse(.leftMouseUp,0));try? await Task.sleep(nanoseconds:360_000_000);check(grip.requests.count==1,"released click cannot start a delayed native drag")
        grip.mouseDown(with:mouse(.leftMouseDown,0));await wait{grip.requests.count==2};check(grip.requests[1]==nil,"stationary hold remains an alternate 340ms entry")
        var moved:[NativeQuickLinkOrderAction]=[];grip.canMove={_ in true};grip.move={moved.append($0)}
        func key(_ code:UInt16,repeatKey:Bool=false)->NSEvent {NSEvent.keyEvent(with:.keyDown,location:.zero,modifierFlags:.option,timestamp:0,windowNumber:0,context:nil,characters:"",charactersIgnoringModifiers:"",isARepeat:repeatKey,keyCode:code)!}
        grip.keyDown(with:key(126));grip.keyDown(with:key(125));grip.keyDown(with:key(125,repeatKey:true));check(moved==[.up,.down],"focused grip routes Option arrows once; held key does not queue mutations")
        grip.canMove={_ in false};grip.keyDown(with:key(126));check(moved.count==2,"boundary or pending state refuses keyboard mutation")
        let window=TestWindow(contentRect:NSRect(x:0,y:0,width:240,height:100),styleMask:[.titled],backing:.buffered,defer:false);let content=NSView(frame:NSRect(x:0,y:0,width:240,height:100));window.contentView=content;content.addSubview(grip)
        d.register(grip,id:row.id);check(d.focus(row.id) && window.firstResponder === grip,"real native handle becomes first responder by record ID without SwiftUI Menu focus")
        let editor=NSTextView(frame:NSRect(x:20,y:0,width:120,height:40));content.addSubview(editor);window.makeFirstResponder(editor)
        check(!d.focus(row.id) && window.firstResponder === editor,"a late move cannot take focus from an editor")
        window.makeFirstResponder(grip);window.owned=false;check(!d.focus(row.id),"restoration cannot activate a different window")
        d.unregister(grip,id:row.id);window.owned=true;check(!d.focus(row.id),"unmounted row cannot report successful keyboard restoration")
        window.contentView=nil

        let source=try JSONSerialization.jsonObject(with:Data(contentsOf:root.appendingPathComponent("bridge.json"))) as! [String:Any]
        let bridge=try DragFixture("bridge",root:root,source:source);await bridge.store.refresh()
        _=await bridge.store.place(bridge.row("b"),at:bridge.target("Other","other",after:true))
        try JSONSerialization.data(withJSONObject:bridge.calls.last!,options:.sortedKeys).write(to:root.appendingPathComponent("cross-folder.json"))
        print("PASS: \(checks) E47 drag interaction checks")
    }
}
