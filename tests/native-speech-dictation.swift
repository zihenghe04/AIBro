import Foundation
import Combine
func nativeUI(_ zh:String,_ en:String)->String{en}
enum AgendaError:Error{case message(String)}
@MainActor final class FakeRecorder:NativeSpeechDictationRecording {
 var elapsed:TimeInterval=0,level:Double=0.4,onFailure:(()->Void)?
 var starts=0,stops=0,url:URL?
 func start(at url:URL)throws{starts+=1;self.url=url;try Data("fictional audio only".utf8).write(to:url)}
 func stop(){stops+=1}
}
actor Gate<T:Sendable> {
 var continuation:CheckedContinuation<T,Never>?,entered=false
 func wait()async->T{entered=true;return await withCheckedContinuation{continuation=$0}}
 func release(_ value:T){continuation?.resume(returning:value);continuation=nil}
}
actor Backend {
 var calls=0,fail=false
 func run(_ url:URL)throws->String{calls+=1;if fail{throw NativeSpeechError.http(401)};return "完整虚构指令 · FINAL-END"}
 func setFailure(_ value:Bool){fail=value}
}
@main struct Checks {
 @MainActor static func main()async throws{
  var count=0
  func check(_ value:Bool,_ label:String){guard value else{fatalError("FAIL: "+label)};count+=1;print("PASS \(count): \(label)")}
  func wait(_ condition:@escaping @MainActor ()async->Bool)async{for _ in 0..<500{if await condition(){return};try? await Task.sleep(nanoseconds:1_000_000)};fatalError("fixture did not settle")}
  let root=URL(fileURLWithPath:CommandLine.arguments[1]);let config=NativeSpeechConfiguration()
  let access=NativeSpeechSecretAccess(load:{config},read:{_ in "synthetic-key"},save:{_,_ in},remove:{})
  func settings()async->NativeSpeechSettings{let s=NativeSpeechSettings();s.configure(owner:root,access:access);s.setAvailable(true);await wait{!s.busy};return s}
  func lease(_ mode:NativeSpeechDictation.Mode = .composer)->NativeSpeechDictation.Lease{.init(nonce:UUID().uuidString,conversationId:mode == .composer ? "fictional-chat":nil,revision:3,mode:mode)}
  func status(_ value:[String:Any],_ text:String)->Bool{value["status"] as? String==text}
  let malformed:[String:Any] = ["nonce":UUID().uuidString,"conversationId":"chat","revision":true]
  check(NativeSpeechDictation.Lease(composer:malformed)==nil,"RPC refuses Boolean revision")
  check(NativeSpeechDictation.Lease(composer:["nonce":UUID().uuidString,"conversationId":"chat","revision":1,"mode":"quickConversation"])==nil,"composer RPC cannot request automatic-send mode")
  check(lease(.quickConversation).valid && !NativeSpeechDictation.Lease(nonce:UUID().uuidString,conversationId:"existing-chat",revision:0,mode:.quickConversation).valid,"global mode never carries an existing conversation")
  let s=await settings(),backend=Backend();var micCalls=0;let recorder=FakeRecorder()
  let d=NativeSpeechDictation(settings:s,directory:root.appendingPathComponent("dictation"),canCapture:{_ in true},permission:{micCalls+=1;return true},makeRecorder:{recorder},transcribe:{url,_,_ in try await backend.run(url)})
  d.setAvailable(true);_ = d.status
  check(micCalls==0,"configuration/status never starts microphone authorization")
  let a=lease();let first=await d.start(a,verify:{true})
  check(status(first,"recording") && micCalls==1 && recorder.starts==1,"only explicit start authorizes and starts audio")
  check(d.status["nonce"] as? String==a.nonce && d.status["conversationId"] as? String==a.conversationId,"status includes current composer lease without secret")
  let url=recorder.url!;let done=await d.finish(a)
  check(status(done,"completed") && done["text"] as? String=="完整虚构指令 · FINAL-END","finish returns complete text without creating or sending a message")
  check(!FileManager.default.fileExists(atPath:url.path) && d.phase == .idle,"successful transcription removes only its temporary audio")
  check(status(await d.start(a,verify:{true}),"error"),"spent nonce cannot resurrect completed recording")
  let b=lease();_ = await d.start(b,verify:{true});_ = d.cancel(a)
  check(d.lease==b && d.phase == .recording,"old cancellation cannot cancel a new recording")
  _ = d.cancel(b)
  let auth=Gate<Bool>(),r2=FakeRecorder(),s2=await settings()
  let delayed=NativeSpeechDictation(settings:s2,directory:root.appendingPathComponent("delayed"),canCapture:{_ in true},permission:{await auth.wait()},makeRecorder:{r2},transcribe:{_,_,_ in "unused"});delayed.setAvailable(true)
  let c=lease();let starting=Task{await delayed.start(c,verify:{true})};await wait{await auth.entered}
  check(delayed.phase == .authorizing,"permission wait is explicitly authorizing, not recording")
  _ = delayed.cancel(c);await auth.release(true);let stale=await starting.value
  check(status(stale,"cancelled") && r2.starts==0,"late permission after cancel cannot start a microphone")
  let network=Gate<String>(),s3=await settings(),r3=FakeRecorder()
  let pending=NativeSpeechDictation(settings:s3,directory:root.appendingPathComponent("pending"),canCapture:{_ in true},permission:{true},makeRecorder:{r3},transcribe:{_,_,_ in await network.wait()});pending.setAvailable(true)
  let e=lease();_ = await pending.start(e,verify:{true});let finishing=Task{await pending.finish(e)};await wait{await network.entered}
  check(status(await pending.finish(e),"error"),"duplicate stop does not start another transcription")
  let pendingURL=r3.url!;pending.setAvailable(false);await network.release("late text");let late=await finishing.value
  check(status(late,"cancelled") && late["text"]==nil && !FileManager.default.fileExists(atPath:pendingURL.path),"private/unavailable cancels late result and cleans its temporary file")
  let f=lease();_ = await d.start(f,verify:{true});let beforeStops=recorder.stops
  _ = await s.save(config,key:"replacement-synthetic-key")
  check(d.lease==nil && recorder.stops>beforeStops,"shared settings revision immediately invalidates ongoing audio")
  let g=lease();await backend.setFailure(true);_ = await d.start(g,verify:{true});let failed=await d.finish(g)
  check(status(failed,"error") && failed["retryAvailable"] as? Bool==true && d.retryAvailable && FileManager.default.fileExists(atPath:recorder.url!.path),"service failure retains current audio for explicit retry")
  let starts=recorder.starts;await backend.setFailure(false);let retry=await d.retry(g)
  check(status(retry,"completed") && recorder.starts==starts,"retry resends stopped audio without recording again")
  let h=lease();_ = await d.start(h,verify:{true});await backend.setFailure(true);_ = await d.finish(h);let expiringURL=recorder.url!
  d.tick(now:Date().addingTimeInterval(301))
  check(d.lease==nil && !FileManager.default.fileExists(atPath:expiringURL.path),"failed audio expires without hidden retry")
  await backend.setFailure(false);let i=lease(.quickConversation);_ = await d.start(i,verify:{true});recorder.elapsed=301
  check(d.composerStatus["nonce"]==nil && d.composerStatus["status"] as? String=="busy" && !d.canOpenComposerSettings,"composer cannot inspect or open settings over global voice lease")
  let callCount=await backend.calls;d.tick()
  let afterLimit=await backend.calls
  check(d.phase == .recorded && afterLimit==callCount,"duration limit stops audio without submitting or transcribing")
  check(status(await d.finish(i),"completed"),"global mode still requires explicit finish before returning command text")
  let j=lease();_ = await d.start(j,verify:{true});let failedURL=recorder.url!;recorder.onFailure?()
  check(d.phase == .error && !d.retryAvailable && !FileManager.default.fileExists(atPath:failedURL.path),"partial recording failure is not offered as complete audio")
  let auth2=Gate<Bool>(),s4=await settings(),r4=FakeRecorder();var otherRecording=false
  let exclusive=NativeSpeechDictation(settings:s4,directory:root.appendingPathComponent("exclusive"),canCapture:{_ in !otherRecording},permission:{await auth2.wait()},makeRecorder:{r4},transcribe:{_,_,_ in "unused"});exclusive.setAvailable(true)
  let k=lease();let race=Task{await exclusive.start(k,verify:{true})};await wait{await auth2.entered};otherRecording=true;await auth2.release(true)
  check(status(await race.value,"cancelled") && r4.starts==0,"another recorder starting during permission wait wins without device overlap")
  let s5=await settings(),r5=FakeRecorder(),net2=Gate<String>();var valid=true
  let guarded=NativeSpeechDictation(settings:s5,directory:root.appendingPathComponent("guarded"),canCapture:{_ in true},permission:{true},makeRecorder:{r5},transcribe:{_,_,_ in await net2.wait()});guarded.setAvailable(true)
  let l=lease();_ = await guarded.start(l,verify:{valid});let ending=Task{await guarded.finish(l)};await wait{await net2.entered};valid=false;await net2.release("wrong owner")
  let changed=await ending.value
  check(status(changed,"cancelled") && changed["text"]==nil,"post-provider verifier rejects route/input owner change")
  d.shutdown();delayed.shutdown();pending.shutdown();exclusive.shutdown();guarded.shutdown()
  check(d.level==0,"stopped real meter has no synthetic activity")
  check(d.status["available"] as? Bool==false,"shutdown makes recording unavailable")
  print("PASS: \(count) dictation state checks; fake recorder and injected credentials/transport, no device or network")
 }
}
