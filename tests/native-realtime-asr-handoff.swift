import Foundation
import AVFoundation
func nativeUI(_ zh:String,_ en:String)->String{en}
final class HeldDispatch:@unchecked Sendable {
    let lock=NSLock();var operations:[@MainActor @Sendable ()->Void]=[];var failures=0
    func enqueue(_ operation:@escaping @MainActor @Sendable ()->Void){lock.lock();operations.append(operation);lock.unlock()}
    func fail(){lock.lock();failures+=1;lock.unlock()}
    var count:Int {lock.lock();defer{lock.unlock()};return operations.count}
    @MainActor func release(){lock.lock();let saved=operations;operations=[];lock.unlock();for operation in saved{operation()}}
}
@MainActor final class HandoffSocket:NativeQuickASRSocket {
    var events:[[String:Any]]=[];var pending:[Data]=[];var waiter:CheckedContinuation<Data,Error>?
    var authenticationRejected=false
    func send(_ text:String) async throws {events.append(try JSONSerialization.jsonObject(with:Data(text.utf8)) as! [String:Any])}
    func receive() async throws -> Data {if !pending.isEmpty{return pending.removeFirst()};return try await withCheckedThrowingContinuation{waiter=$0}}
    func ping() async throws {}
    func close(){let old=waiter;waiter=nil;old?.resume(throwing:CancellationError())}
    func emit(_ type:String){let value=try! JSONSerialization.data(withJSONObject:["type":type]);if let old=waiter{waiter=nil;old.resume(returning:value)}else{pending.append(value)}}
}
@main struct HandoffChecks {
 @MainActor static func main() async throws {
    var passed=0
    func check(_ value:Bool,_ message:String) throws{if !value{throw NSError(domain:message,code:1)};passed+=1;print("PASS \(message)")}
    func settle() async{for _ in 0..<30{await Task.yield()}}
    let root=URL(fileURLWithPath:CommandLine.arguments[1]);try FileManager.default.createDirectory(at:root,withIntermediateDirectories:true)
    let socket=HandoffSocket(),session=NativeQuickRealtimeASRSession(factory:{_ in socket});var config=NativeQuickASRConfiguration();config.enabled=true
    try session.start(configuration:config,key:"fictional-only");socket.emit("session.updated");await settle()
    var receivedBytes=0
    let handoff=NativeQuickASRPCMHandoff(receive:{bytes in receivedBytes+=bytes.count;session.append(bytes);return true},onFailure:{})
    let format=AVAudioFormat(standardFormatWithSampleRate:48000,channels:1)!
    let writer=try NativeQuickRealtimeASRAudioPipeline(url:root.appendingPathComponent("synthetic.m4a"),inputFormat:format,onPCM:{bytes in handoff.send(bytes)},onFailure:{})
    let buffer=AVAudioPCMBuffer(pcmFormat:format,frameCapacity:4800)!;buffer.frameLength=4800
    for i in 0..<4800 {buffer.floatChannelData![0][i]=Float(sin(Double(i)*2*Double.pi*440/48000)*0.1)}
    for _ in 0..<3 {writer.enqueue(buffer)}
    let receipt=await writer.finish();handoff.close()
    try check(!receipt.interrupted && !receipt.streamInterrupted && receipt.bytes>0,"local M4A closes before the acknowledged PCM drain returns")
    try check(receivedBytes>0 && !handoff.failed,"driver completion means PCM was actually accepted on MainActor, not just dispatched")
    let finishing=Task{await session.finish()};await settle()
    let types=socket.events.compactMap{$0["type"] as? String}
    try check(types.last=="session.finish" && types.contains("input_audio_buffer.append"),"audio append events precede finish across real synthetic pipeline and handoff")
    let sentBytes=socket.events.compactMap{$0["audio"] as? String}.compactMap{Data(base64Encoded:$0)}.reduce(0){$0+$1.count}
    try check(sentBytes==receivedBytes,"all accepted final PCM reaches the session send queue without tail loss")
    socket.emit("session.finished");let final=await finishing.value
    try check(final.phase == .completed && !final.hasGap,"complete fake-provider ACK succeeds after the acknowledged audio tail")
    let held=HeldDispatch();var late=0
    let timeout=NativeQuickASRPCMHandoff(timeout:0.03,dispatch:{held.enqueue($0)},receive:{_ in late+=1;return true},onFailure:{held.fail()})
    let timed=await Task.detached{timeout.send(Data([1,0]))}.value
    for _ in 0..<100 {_ = await Task.detached{timeout.send(Data([1,0]))}.value}
    try check(!timed && timeout.failed && held.count==1 && held.failures==1,"blocked MainActor gets one bounded ticket; timeout stops further Tasks with explicit failure")
    held.release();try check(late==0,"timed-out queued PCM cannot arrive late after finalization")
    let queued=HeldDispatch();let revoked=NativeQuickASRPCMHandoff(dispatch:{queued.enqueue($0)},receive:{_ in late+=1;return true},onFailure:{})
    let pending=Task.detached{revoked.send(Data([2,0]))}
    for _ in 0..<1000 {if queued.count>0{break};await Task.yield()}
    revoked.close();let accepted=await pending.value;queued.release()
    try check(!accepted && late==0,"privacy close releases the waiting worker and rejects queued MainActor payload")
    print("\(passed) acknowledged PCM handoff checks; synthetic audio and fake WebSocket only")
 }
}
