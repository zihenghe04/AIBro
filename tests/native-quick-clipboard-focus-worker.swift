import AppKit
import Combine
func nativeUI(_ zh:String,_ en:String)->String{en}

final class ControlledFocusReads: @unchecked Sendable {
    final class Read: @unchecked Sendable {
        let pid:pid_t, semaphore=DispatchSemaphore(value:0), value=NSObject()
        let onMainThread:Bool
        init(_ pid:pid_t){self.pid=pid;onMainThread=Thread.isMainThread}
    }
    private let lock=NSLock()
    private var reads:[Read]=[]
    var count:Int{lock.lock();defer{lock.unlock()};return reads.count}
    func item(_ index:Int)->Read{lock.lock();defer{lock.unlock()};return reads[index]}
    func read(_ pid:pid_t)->NativeQuickClipboardFocusWorker.Snapshot? {
        let item=Read(pid);lock.lock();reads.append(item);lock.unlock()
        guard item.semaphore.wait(timeout:.now()+3) == .success else {fatalError("Test did not release synthetic read")}
        return .init(item.value)
    }
    func release(_ index:Int){item(index).semaphore.signal()}
}
@MainActor final class AsyncFocusEnvironment:NativeQuickClipboardPasteEnvironment {
    let ownPID:pid_t=10
    let original=NativeQuickClipboardPasteTarget(pid:20,bundleID:"fixture.editor",bundlePath:"/Synthetic/Editor.app",launchedAt:Date(timeIntervalSince1970:1),name:"Original editor")
    let own=NativeQuickClipboardPasteTarget(pid:10,bundleID:"fixture.bro",bundlePath:"/Synthetic/Bro.app",launchedAt:Date(timeIntervalSince1970:2),name:"Fixture Bro")
    let third=NativeQuickClipboardPasteTarget(pid:30,bundleID:"fixture.third",bundlePath:"/Synthetic/Third.app",launchedAt:Date(timeIntervalSince1970:3),name:"Other editor")
    var current:NativeQuickClipboardPasteTarget?, runningIdentity:NativeQuickClipboardPasteTarget?
    var trusted=true, captures=0, activations=0, posts=0, stopped=0
    var callback:((pid_t)->Void)?, expected:AnyObject?
    let reads=ControlledFocusReads()
    lazy var worker=NativeQuickClipboardFocusWorker(read:{[reads] pid in reads.read(pid)})
    init(){current=original;runningIdentity=original}
    func frontmost()->NativeQuickClipboardPasteTarget?{current}
    func isRunning(_ target:NativeQuickClipboardPasteTarget)->Bool{runningIdentity?.isSameProcess(as:target)==true}
    func captureFocus(_ target:NativeQuickClipboardPasteTarget) async -> AnyObject? {
        captures += 1
        // Intentionally returns the worker result without lifecycle guards:
        // the production controller must reject stale/changed fake replies.
        return await worker.capture(pid:target.pid)?.value
    }
    func focusMatches(_ focus:AnyObject,target:NativeQuickClipboardPasteTarget)->Bool{expected.map{$0 === focus} ?? true}
    func activate(_ target:NativeQuickClipboardPasteTarget)->Bool{activations += 1;current=target;callback?(target.pid);return true}
    func sendPaste(_ target:NativeQuickClipboardPasteTarget)->Bool{posts += 1;return true}
    func observeActivation(_ changed:@escaping(pid_t)->Void)->()->Void{callback=changed;return{[weak self]in self?.stopped += 1;self?.callback=nil}}
    func waitForActivation() async throws{await Task.yield()}
    func switchTo(_ app:NativeQuickClipboardPasteTarget){current=app;callback?(app.pid)}
}
@MainActor final class AsyncPasteHost {
    let env=AsyncFocusEnvironment()
    lazy var service=NativeQuickClipboardPasteBack(environment:env)
    var shown=true, copied=0, collapses=0, count=42, result:String?, finished=false
    init(){service.setAvailable(true);service.configure(isPresented:{[weak self]in self?.shown==true},collapse:{[weak self]in guard let self else{return false};collapses += 1;shown=false;service.endSession();return true})}
    func open(){shown=true;env.current=env.original;service.beginSession()}
    func run()->Task<Void,Never>{Task{result=await service.perform(copy:{guard $0() else{return nil};copied += 1;return 42},isCopyCurrent:{$0==self.count});finished=true}}
}
@main struct AsyncFocusChecks {
 @MainActor static func main() async throws {
    var checks=0
    func check(_ ok:Bool,_ text:String){precondition(ok,text);checks += 1;print("PASS \(checks): \(text)")}
    func wait(_ done:()->Bool) async {for _ in 0..<500{if done(){return};try?await Task.sleep(nanoseconds:1_000_000)};precondition(done(),"Fixture timed out")}
    do {
        let h=AsyncPasteHost();h.open()
        check(h.env.captures==0,"beginSession returns before starting any AX-like work")
        await wait{h.env.reads.count==1}
        var heartbeat=false;Task{@MainActor in heartbeat=true};await wait{heartbeat}
        check(!h.env.reads.item(0).onMainThread && h.env.posts==0,"Actual production worker blocks only its own queue while MainActor heartbeat proceeds")
        let request=h.run();await wait{h.copied==1}
        check(!h.finished && h.env.captures==1 && h.collapses==0,"Explicit paste waits for the same initial read without lazy recapture or early collapse")
        h.env.expected=h.env.reads.item(0).value;h.env.reads.release(0);await request.value
        check(h.env.posts==1 && h.collapses==1 && h.result?.contains("Paste sent")==true,"Stable original process and input complete one explicit paste after async capture")
    }
    do {
        let h=AsyncPasteHost();h.open();await wait{h.env.reads.count==1}
        let request=h.run();await wait{h.copied==1};h.env.switchTo(h.env.own);h.env.switchTo(h.env.original)
        await request.value
        check(h.env.posts==0 && h.collapses==0 && h.result?.contains("input target")==true,"AI Bro activation during capture permanently makes this opening copy-only, even after switching back")
        check(h.env.captures==1,"Copy-only fallback does not capture a later field to impersonate the original")
        h.env.reads.release(0);h.service.shutdown()
    }
    do {
        let h=AsyncPasteHost();h.open();await wait{h.env.reads.count==1}
        let request=h.run();await wait{h.copied==1};h.env.switchTo(h.env.third);h.env.switchTo(h.env.original)
        await request.value
        check(h.copied==1 && h.env.posts==0 && h.service.targetName==nil,"Third-app activation then return revokes pending capture and cannot revive its destination")
        h.env.reads.release(0)
    }
    do {
        let h=AsyncPasteHost();h.open();await wait{h.env.reads.count==1}
        let request=h.run();await wait{h.copied==1};h.service.setAvailable(false);await request.value
        check(h.env.posts==0 && h.result==nil && h.service.targetName==nil && h.env.callback==nil,"Private mode releases an awaiting caller without waiting for IPC and leaves no target or feedback")
        h.env.reads.release(0)
    }
    do {
        let h=AsyncPasteHost();h.open();await wait{h.env.reads.count==1};h.service.endSession();h.open()
        h.env.reads.release(0);await wait{h.env.reads.count==2}
        let request=h.run();await wait{h.copied==1}
        check(!h.finished && h.env.posts==0,"Old opening reply cannot fulfill a new opening's still-pending focus")
        h.env.expected=h.env.reads.item(1).value;h.env.reads.release(1);await request.value
        check(h.env.posts==1 && h.env.captures==2,"New opening uses only its own original-input snapshot")
    }
    do {
        let h=AsyncPasteHost();h.open();await wait{h.env.reads.count==1}
        let t=h.env.original;h.env.runningIdentity = .init(pid:t.pid,bundleID:t.bundleID,bundlePath:t.bundlePath,launchedAt:t.launchedAt.addingTimeInterval(1),name:t.name)
        h.env.reads.release(0);let request=h.run();await request.value
        check(h.env.posts==0 && h.collapses==0 && h.result?.contains("quit")==true,"Same PID with a new launch identity cannot commit an old focused element")
        h.service.shutdown()
    }
    do {
        let h=AsyncPasteHost();h.open();await wait{h.env.reads.count==1}
        let request=h.run();await wait{h.copied==1};h.env.trusted=false;h.env.reads.release(0);await request.value
        check(h.env.posts==0 && h.collapses==0 && h.result?.contains("permission")==true,"Permission loss during worker capture preserves copy-only behavior")
        h.service.shutdown()
    }
    do {
        let h=AsyncPasteHost();h.open();await wait{h.env.reads.count==1}
        let request=h.run();await wait{h.copied==1};h.count += 1;h.env.reads.release(0);await request.value
        check(h.env.posts==0 && h.collapses==0,"Clipboard ownership is checked again after the new asynchronous wait")
        h.service.shutdown()
    }
    do {
        let h=AsyncPasteHost();h.open();await wait{h.env.reads.count==1};h.service.shutdown();h.env.reads.release(0)
        await Task.yield()
        check(h.service.targetName==nil && h.env.callback==nil && h.env.posts==0,"Shutdown discards late worker results and removes activation observation")
    }
    do {
        let h=AsyncPasteHost();h.env.trusted=false;h.open();let request=h.run();await request.value
        check(h.env.reads.count==0 && h.env.captures==0 && h.copied==1,"Missing permission creates no worker request and does not block ordinary copying")
        h.service.shutdown()
    }
    // Real worker cancellation while queued: no AX is used and no fake actor
    // stands in for the production serial queue/cancellation contract.
    do {
        let reads=ControlledFocusReads(), worker=NativeQuickClipboardFocusWorker(read:{[reads] in reads.read($0)})
        let first=Task{await worker.capture(pid:1)};await wait{reads.count==1}
        first.cancel();let cancelled=await first.value
        check(cancelled==nil,"Cancellation returns promptly even when the worker's synchronous read is still held")
        let queued=Task{await worker.capture(pid:2)};await Task.yield();queued.cancel();let skipped=await queued.value
        reads.release(0);let final=Task{await worker.capture(pid:3)};await wait{reads.count==2}
        check(skipped==nil && reads.item(1).pid==3,"Cancelled queued work is skipped instead of running stale AX reads")
        reads.release(1);_ = await final.value
    }
    print("PASS: \(checks) new asynchronous focus checks; no actual AX, CGEvent, user clipboard, GUI or permission request")
 }
}
