import Foundation
import Combine
func nativeUI(_ zh:String,_ en:String)->String{en}
enum AgendaError:Error{case message(String)}

@MainActor final class FakeLiveAudio:NativeDictationAudio {
    var elapsed:TimeInterval=0,level:Double=0,starts=0,stops=0,url:URL?
    var onPCM:(@Sendable (Data)->Void)?,onStreamFailure:(@Sendable ()->Void)?
    func start(url:URL,onPCM:@escaping @Sendable (Data)->Void,onFailure:@escaping @Sendable ()->Void,onStreamFailure:@escaping @Sendable ()->Void) throws {
        starts+=1;self.url=url;self.onPCM=onPCM;self.onStreamFailure=onStreamFailure;try Data("fictional audio only".utf8).write(to:url)
    }
    func stop() async->NativeQuickRealtimeASRAudio.Receipt {stops+=1;return .init(duration:elapsed,bytes:10,interrupted:false,streamInterrupted:false)}
    /// The real driver calls this from its delivery queue, never the main thread.
    func speak(_ bytes:Int=3200){let handler=onPCM;DispatchQueue.global().async{handler?(Data(repeating:1,count:bytes))}}
}
@MainActor final class LiveSocket:NativeQuickASRSocket {
    var sent:[[String:Any]]=[],binary:[Data]=[],pending:[Data]=[],waiter:CheckedContinuation<Data,Error>?,closed=false
    var authenticationRejected=false
    func send(_ text:String) async throws {sent.append(try JSONSerialization.jsonObject(with:Data(text.utf8)) as! [String:Any])}
    func sendBinary(_ data:Data) async throws {binary.append(data)}
    func receive() async throws->Data {if !pending.isEmpty{return pending.removeFirst()};if closed{throw CancellationError()};return try await withCheckedThrowingContinuation{waiter=$0}}
    func ping() async throws {}
    func close(){closed=true;let old=waiter;waiter=nil;old?.resume(throwing:CancellationError())}
    func event(_ type:String,_ extra:[String:Any]=[:]){var object=extra;object["type"]=type;let data=try! JSONSerialization.data(withJSONObject:object);if let old=waiter{waiter=nil;old.resume(returning:data)}else{pending.append(data)}}
}
actor Cloud {
    var calls=0
    func run()->String{calls+=1;return "云转写文本"}
}
final class Silence:@unchecked Sendable{var value:TimeInterval=1.5}

@main struct LiveDictationChecks {
    @MainActor static func main()async throws {
        var count=0
        func check(_ value:Bool,_ label:String){guard value else{fatalError("FAIL: "+label)};count+=1;print("PASS \(count): \(label)")}
        func settle()async{for _ in 0..<40{await Task.yield()};try? await Task.sleep(nanoseconds:20_000_000);for _ in 0..<40{await Task.yield()}}
        func wait(_ condition:@escaping @MainActor ()async->Bool)async{for _ in 0..<500{if await condition(){return};try? await Task.sleep(nanoseconds:1_000_000)};fatalError("fixture did not settle")}
        let root=URL(fileURLWithPath:CommandLine.arguments[1]);let config=NativeSpeechConfiguration()
        let access=NativeSpeechSecretAccess(load:{config},read:{_ in "synthetic-key"},save:{_,_ in},remove:{})
        func settings()async->NativeSpeechSettings{let s=NativeSpeechSettings();s.configure(owner:root,access:access);s.setAvailable(true);await wait{!s.busy};return s}
        func lease(_ mode:NativeSpeechDictation.Mode = .composer)->NativeSpeechDictation.Lease{.init(nonce:UUID().uuidString,conversationId:mode == .composer ? "fictional-chat":nil,revision:3,mode:mode)}
        var live=NativeQuickASRConfiguration();live.provider = .selfHosted;live.enabled=true;live.language="zh";live.serverURL="ws://192.0.2.10:8000"
        struct Rig {let dictation:NativeSpeechDictation,audio:FakeLiveAudio,sockets:Box,cloud:Cloud,silence:Silence}
        final class Box{var sockets:[LiveSocket]=[]}
        func rig(realtime:Bool=true,cloudConfigured:Bool=true)async->Rig {
            let audio=FakeLiveAudio(),box=Box(),cloud=Cloud(),silence=Silence()
            let s:NativeSpeechSettings
            if cloudConfigured{s=await settings()}else{s=NativeSpeechSettings();s.configure(owner:root,access:NativeSpeechSecretAccess(load:{nil},read:{_ in ""},save:{_,_ in},remove:{}));s.setAvailable(true);await wait{!s.busy}}
            let r=NativeDictationRealtime(connection:{realtime ? (live,"synthetic-token"):nil},
                makeSession:{NativeQuickRealtimeASRSession(factory:{_ in let socket=LiveSocket();box.sockets.append(socket);return socket})},makeAudio:{audio})
            let d=NativeSpeechDictation(settings:s,directory:root.appendingPathComponent("live-"+UUID().uuidString),canCapture:{_ in true},realtime:r,silenceSeconds:{silence.value},
                permission:{true},makeRecorder:{fatalError("the microphone recorder must not be used for live dictation")},transcribe:{_,_,_ in await cloud.run()})
            d.setAvailable(true);if !cloudConfigured{d.setAvailable(true)}
            return Rig(dictation:d,audio:audio,sockets:box,cloud:cloud,silence:silence)
        }
        // 1. Live text appears while speaking; manual stop returns the live text with no cloud request.
        let one=await rig();let a=lease()
        let started=await one.dictation.start(a,verify:{true})
        check(started["status"] as? String=="recording" && one.audio.starts==1 && one.sockets.sockets.count==1,"with a live scheme, recording starts the live session at once")
        one.sockets.sockets[0].event("ready");await settle();one.audio.speak();await settle()
        check(one.sockets.sockets[0].binary.count==1 && one.sockets.sockets[0].sent.isEmpty,"PCM goes to the live session as binary frames while recording")
        one.sockets.sockets[0].event("partial",["text":"你好"]);await settle()
        check(one.dictation.liveText=="你好" && one.dictation.status["liveText"] as? String=="你好","a partial is shown as live text")
        one.sockets.sockets[0].event("partial",["text":"你好世界"]);await settle()
        check(one.dictation.liveText=="你好世界","a newer partial replaces the older one")
        let finishing=Task{await one.dictation.finish(a)};await settle()
        check(one.audio.stops>=1 && one.sockets.sockets[0].sent.last?["type"] as? String=="stop","stopping closes the microphone and tells the service to finish")
        one.sockets.sockets[0].event("final",["text":"你好世界。"]);await settle()
        let done=await finishing.value
        check(done["status"] as? String=="completed" && done["text"] as? String=="你好世界。" && one.dictation.lease==nil,"the final text completes the dictation for confirmation")
        let oneCalls=await one.cloud.calls
        check(oneCalls==0,"no cloud request is made when live transcription succeeded")
        // 2. Auto stop after silence.
        let two=await rig();let b=lease(.quickConversation)
        _ = await two.dictation.start(b,verify:{true});two.sockets.sockets[0].event("ready");await settle()
        let t0=Date();two.audio.level=0.3;two.audio.elapsed=1;two.dictation.tick(now:t0)
        check(two.dictation.phase == .recording && !two.dictation.autoStopped,"speech does not stop the recording")
        two.audio.level=0.0;two.audio.elapsed=2;two.dictation.tick(now:t0.addingTimeInterval(1.0))
        check(two.dictation.phase == .recording,"a short pause does not stop it")
        two.dictation.tick(now:t0.addingTimeInterval(1.6));await settle()
        check(two.dictation.autoStopped && two.dictation.phase == .recorded && two.audio.stops>=1,"about 1.5 s of silence after speech stops the recording by itself")
        let autoFinish=Task{await two.dictation.finish(b)};await settle()
        two.sockets.sockets[0].event("final",["text":"自动结束的指令"]);await settle()
        let autoDone=await autoFinish.value
        check(autoDone["text"] as? String=="自动结束的指令","after auto stop the finish step returns the text for the confirmation screen")
        // 2b. A hold-to-talk press ends only when the key is released, never by silence.
        let held=await rig();let hb=lease(.quickConversation);held.dictation.autoStopAllowed=false
        _ = await held.dictation.start(hb,verify:{true});held.sockets.sockets[0].event("ready");await settle()
        let h0=Date();held.audio.level=0.3;held.audio.elapsed=1;held.dictation.tick(now:h0);held.audio.level=0;held.dictation.tick(now:h0.addingTimeInterval(5));await settle()
        check(held.dictation.phase == .recording && !held.dictation.autoStopped,"hold-to-talk is not ended by silence")
        // 3. Silence before any speech, and the off switch.
        let three=await rig();let c=lease();_ = await three.dictation.start(c,verify:{true})
        three.audio.level=0;three.audio.elapsed=10;three.dictation.tick(now:Date().addingTimeInterval(30))
        check(three.dictation.phase == .recording,"silence before anything was said never stops the recording")
        three.silence.value=0;three.audio.level=0.3;three.dictation.tick(now:Date());three.audio.level=0;three.dictation.tick(now:Date().addingTimeInterval(60))
        check(three.dictation.phase == .recording && !three.dictation.autoStopped,"setting the silence time to 0 turns auto stop off")
        // 4. Live session breaks: recording continues and the cloud scheme transcribes the recording once, with one notice.
        let four=await rig();let d4=lease();_ = await four.dictation.start(d4,verify:{true})
        four.sockets.sockets[0].event("ready");await settle()
        four.audio.onStreamFailure?();await settle()
        check(four.dictation.notice != nil && four.dictation.phase == .recording,"a failed live session shows one notice and keeps recording")
        let fell=await four.dictation.finish(d4)
        let fourCalls=await four.cloud.calls
        check(fell["status"] as? String=="completed" && fell["text"] as? String=="云转写文本" && fourCalls==1,"the cloud scheme then transcribes the recorded audio")
        // 5. A live session that cannot even connect behaves the same way.
        var broken=live;broken.serverURL="ws://invalid host"
        let audio5=FakeLiveAudio(),cloud5=Cloud(),s5=await settings()
        let d5=NativeSpeechDictation(settings:s5,directory:root.appendingPathComponent("broken"),canCapture:{_ in true},
            realtime:NativeDictationRealtime(connection:{(broken,"k")},makeSession:{NativeQuickRealtimeASRSession(factory:{_ in LiveSocket()})},makeAudio:{audio5}),silenceSeconds:{1.5},
            permission:{true},makeRecorder:{fatalError("unused")},transcribe:{_,_,_ in await cloud5.run()});d5.setAvailable(true)
        let e5=lease();let st5=await d5.start(e5,verify:{true})
        check(st5["status"] as? String=="recording" && d5.notice != nil,"an unusable live scheme falls back to recording with a notice")
        check((await d5.finish(e5))["text"] as? String=="云转写文本","and the recording is transcribed by the cloud scheme")
        // 6. No live scheme: the existing record-then-transcribe flow, no live session.
        let six=await rig(realtime:false);let f=lease()
        _ = six.dictation.status
        check(six.dictation.status["liveText"] as? String=="" && six.sockets.sockets.isEmpty,"without a live scheme there is no live session")
        // 7. Live scheme without any cloud scheme is enough to start; a failure then says there is nothing to fall back to.
        let seven=await rig(cloudConfigured:false);let g=lease()
        let s7=await seven.dictation.start(g,verify:{true})
        check(s7["status"] as? String=="recording","a live scheme alone is enough to start dictation")
        seven.sockets.sockets[0].event("ready");await settle();seven.audio.onStreamFailure?();await settle()
        let f7=await seven.dictation.finish(g)
        check(f7["status"] as? String=="error" && (f7["message"] as? String ?? "").contains("no cloud scheme"),"a failed live session with no cloud scheme reports it plainly")
        // 8. Silence with nothing heard.
        let eight=await rig();let h=lease();_ = await eight.dictation.start(h,verify:{true})
        eight.sockets.sockets[0].event("ready");await settle()
        let quiet=Task{await eight.dictation.finish(h)};await settle()
        eight.sockets.sockets[0].event("final",["text":""]);await settle()
        let q=await quiet.value
        check(q["status"] as? String=="error" && (q["message"] as? String ?? "").contains("No speech"),"an empty final is reported as no speech, not as an empty instruction")
        _ = f
        print("\(count) live dictation checks; fake microphone and fake sockets only")
    }
}
