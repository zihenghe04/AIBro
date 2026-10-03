import Foundation
import AppKit

func nativeUI(_ zh:String,_ en:String)->String { en }
actor SelectionGate {
    var requests:[NativeQuickWindowActivation.Target] = []
    var waiting:[Int:CheckedContinuation<NativeQuickWindowActivation.Prepared,Never>] = [:]
    func prepare(_ target:NativeQuickWindowActivation.Target) async -> NativeQuickWindowActivation.Prepared {
        requests.append(target); let id=requests.count
        return await withCheckedContinuation { waiting[id]=$0 }
    }
    func count()->Int {requests.count}
    func finish(_ index:Int, outcome:NativeQuickWindowActivation.Result = .raised, wrong:Bool = false) {
        let target=requests[index-1]
        waiting.removeValue(forKey:index)?.resume(returning:.init(target:wrong ? .init(id:"999:9",pid:999,title:"Other",applicationIdentity:"other") : target,current:nil,outcome:outcome))
    }
}
@main struct WindowSelectionChecks {
    @MainActor static var count=0
    @MainActor static func check(_ passed:Bool,_ label:String) {precondition(passed,label);count += 1;print("PASS \(label)")}
    static func wait(_ gate:SelectionGate,_ expected:Int) async {
        for _ in 0..<300 {if await gate.count() >= expected{return};try? await Task.sleep(nanoseconds:1_000_000)}
        preconditionFailure("Timed out waiting for synthetic prepare")
    }
    @MainActor static func settled(_ store:NativeQuickWindowsStore) async {
        for _ in 0..<300 {if !store.isRefreshing && store.activatingID == nil{return};try? await Task.sleep(nanoseconds:1_000_000)}
        preconditionFailure("Timed out waiting for synthetic store")
    }
    @MainActor static func main() async {
        typealias A=NativeQuickWindowActivation
        let left=CGRect(x:-900,y:50,width:800,height:600),right=CGRect(x:50,y:80,width:800,height:600)
        let selected=A.Window(pid:44,title:"Untitled",bounds:right)
        let a=A.Window(pid:44,title:"Untitled",bounds:left),b=selected
        check(A.uniqueMatch(selected,in:[a,b]) == 1,"same-title windows use selected geometry")
        check(A.uniqueMatch(selected,in:[b,a]) == 0,"AX reordering does not change selected surface")
        check(A.uniqueMatch(selected,in:[b,b]) == nil,"identical title and geometry stays ambiguous")
        check(A.uniqueMatch(selected,in:[.init(pid:45,title:"Untitled",bounds:right)]) == nil,"AX belongs to exact original PID")
        check(A.uniqueMatch(selected,in:[.init(pid:44,title:"Renamed",bounds:right)]) == nil,"changed title does not match")
        check(A.uniqueMatch(.init(pid:44,title:"Untitled",bounds:nil),in:[a,b]) == nil,"missing bounds does not guess a window")
        check(A.uniqueMatch(selected,in:[.init(pid:44,title:"Untitled",bounds:right.offsetBy(dx:0.5,dy:0.5))]) == 0,"one-point rounding tolerance")
        check(A.uniqueMatch(selected,in:[.init(pid:44,title:"Untitled",bounds:right.offsetBy(dx:2,dy:0))]) == nil,"no nearest-window heuristic")
        check(!A.valid(CGRect(x:0,y:0,width:0,height:20)) && !A.valid(CGRect(x:CGFloat.nan,y:0,width:20,height:20)),"invalid geometry rejected")
        check(A.Target(id:"44:2",pid:44,title:"Untitled",applicationIdentity:"app").number == 2,"stable CG ID parsed")
        check(A.Target(id:"45:2",pid:44,title:"Untitled",applicationIdentity:"app").number == nil && A.Target(id:"44:0",pid:44,title:"",applicationIdentity:"app").number == nil,"mismatched or zero CG ID rejected")
        check(A.canRaise(current:selected,prepared:selected,candidate:b),"commit accepts unchanged CG geometry and AX target")
        check(!A.canRaise(current:nil,prepared:selected,candidate:b),"closed CG window cannot be raised")
        check(!A.canRaise(current:a,prepared:selected,candidate:b),"moved CG window rejects prepared AX result")
        check(!A.canRaise(current:selected,prepared:selected,candidate:a),"AX geometry change rejects old result")
        check(!A.canRaise(current:selected,prepared:selected,candidate:.init(pid:99,title:"Untitled",bounds:right)),"commit rejects AX ownership change")
        check(!A.canRaise(current:.init(pid:44,title:"Renamed",bounds:right),prepared:selected,candidate:b),"commit rejects renamed CG window")
        check(A.completeMatch(selected,in:[a,b]) == 1,"complete AX enumeration can select the unique surface")
        check(A.completeMatch(selected,in:[nil,b]) == nil,"failed AX attributes cannot create false uniqueness")
        check(A.completeMatch(selected,in:[.init(pid:44,title:"Untitled",bounds:nil),b]) == nil,"missing AX geometry cannot be dropped before matching")
        check(A.uniqueSurface(selected,in:[a,b]),"CG peers distinguish same-title windows at different positions")
        check(!A.uniqueSurface(selected,in:[b,b]),"CG signature collision blocks incomplete AX exposure")
        check(!A.uniqueSurface(selected,in:[b,.init(pid:44,title:"",bounds:right)]),"unnamed overlapping CG peer keeps exact identity unproven")
        check(!A.uniqueSurface(selected,in:[b,.init(pid:44,title:"Other",bounds:nil)]),"incomplete CG geometry cannot establish uniqueness")
        let snapshot=NativeQuickWindowSnapshot(rows:[
            .init(id:"44:22",pid:44,title:"Untitled",appName:"Synthetic",applicationIdentity:"session-a",icon:nil,bounds:right),
            .init(id:"44:11",pid:44,title:"Untitled",appName:"Synthetic",applicationIdentity:"session-a",icon:nil,bounds:left)
        ],canReadTitles:true)
        var permissions=true,applied:[String]=[]
        let gate=SelectionGate()
        let store=NativeQuickWindowsStore(scan:{snapshot},permission:{permissions},observe:{_ in {}},prepareActivation:{await gate.prepare($0)},applyActivation:{applied.append($0.target.id);return $0.outcome})
        store.setAvailable(true);store.setVisible(true);store.refresh();await settled(store)
        let rows=store.items,first=rows[0],second=rows[1]
        check(first.bounds == right,"scan preserves geometry on titled rows")
        check(NativeQuickWindowListing.appLabel(first,among:rows) == "Synthetic · 2","multi-window label follows numeric CG ID")
        check(NativeQuickWindowListing.appLabel(first,among:rows.reversed()) == "Synthetic · 2","label stable across front-order changes")
        store.activate(first);await wait(gate,1);store.activate(first)
        check(applied.isEmpty && store.activatingID == first.id,"prepare is read-only until matching ACK")
        check(await gate.count() == 1,"same pending window click is coalesced")
        store.activate(second);await wait(gate,2);await gate.finish(1);await Task.yield()
        check(applied.isEmpty && store.activatingID == second.id,"older result cannot overtake newer selection")
        await gate.finish(2);await settled(store)
        check(applied == [second.id],"only latest verified selection is applied")
        store.activate(first);await wait(gate,3);store.hide(id:first.id);store.showAll();await gate.finish(3);await settled(store)
        check(applied.count == 1,"hide then restore cannot revive pending focus")
        store.activate(first);await wait(gate,4);store.setVisible(false);await gate.finish(4);await Task.yield()
        check(applied.count == 1 && store.activatingID == nil,"collapse rejects late foreground action")
        check(store.items.allSatisfy{$0.title.isEmpty && $0.bounds == nil},"collapse scrubs titles and geometry")
        store.setVisible(true);store.refresh();await settled(store)
        store.activate(store.items[0]);await wait(gate,5);store.setAvailable(false);await gate.finish(5);await Task.yield()
        check(applied.count == 1 && store.items.isEmpty,"private/unavailable removes data and rejects late result")
        store.setAvailable(true);store.refresh();await settled(store)
        store.activate(store.items[0]);await wait(gate,6);await gate.finish(6,wrong:true);await settled(store)
        check(applied.count == 1,"misbound preparation cannot activate a different process")
        store.activate(store.items[0]);await wait(gate,7);await gate.finish(7,outcome:.ambiguous);await settled(store)
        check(applied.count == 2 && store.error?.contains("uniquely") == true,"ambiguous geometry retains honest app-level fallback")
        store.activate(store.items[0]);await wait(gate,8);permissions=false;await gate.finish(8);await settled(store)
        check(applied.count == 2 && store.items.allSatisfy{$0.title.isEmpty},"permission withdrawal refuses old titled target")
        check(store.items.count == 1,"no-title projection returns one app entry")
        store.shutdown()
        print("\(count) window selection assertions passed; no OS window actions or permission prompts")
    }
}
