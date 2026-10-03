import Foundation
func nativeUI(_ zh:String,_ en:String)->String {en}
@MainActor final class TestClock {
    struct Wait {let at:Double;let continuation:CheckedContinuation<Void,Error>}
    var now=0.0;var waits:[UUID:Wait]=[:]
    func sleep(_ seconds:Double) async throws {
        let id=UUID()
        try await withTaskCancellationHandler(operation:{try await withCheckedThrowingContinuation{(continuation:CheckedContinuation<Void,Error>) in
            if Task.isCancelled{continuation.resume(throwing:CancellationError())}else{waits[id] = .init(at:now+seconds,continuation:continuation)}
        }},onCancel:{Task{@MainActor in self.waits.removeValue(forKey:id)?.continuation.resume(throwing:CancellationError())}})
    }
    func advance(_ seconds:Double){now+=seconds;let ready=waits.filter{$0.value.at<=now};for (id,value) in ready{waits.removeValue(forKey:id);value.continuation.resume()}}
}
@MainActor final class TestSocket:NativeQuickASRSocket {
    var sent:[[String:Any]]=[];var pending:[Data]=[];var waiter:CheckedContinuation<Data,Error>?;var closed=false
    var failAudio=false;var authenticationRejected=false
    func send(_ text:String) async throws {let object=try JSONSerialization.jsonObject(with:Data(text.utf8)) as! [String:Any];if object["type"] as? String == "input_audio_buffer.append",failAudio{throw NativeQuickASRError.unavailable};sent.append(object)}
    func receive() async throws->Data {if !pending.isEmpty{return pending.removeFirst()};if closed{throw CancellationError()};return try await withCheckedThrowingContinuation{waiter=$0}}
    func ping() async throws {}
    func close(){closed=true;let old=waiter;waiter=nil;old?.resume(throwing:CancellationError())}
    func event(_ type:String,_ extra:[String:Any]=[:]){var object=extra;object["type"]=type;let data=try! JSONSerialization.data(withJSONObject:object);if let old=waiter{waiter=nil;old.resume(returning:data)}else{pending.append(data)}}
    var audio:[[String:Any]]{sent.filter{$0["type"] as? String == "input_audio_buffer.append"}}
}
@main struct RealtimeASRChecks {
    @MainActor static func main() async throws {
        var checks=0,failures=0
        func check(_ value:Bool,_ text:String){checks+=1;if !value{failures+=1};print("\(value ? "PASS":"FAIL") \(text)")}
        func settle() async{for _ in 0..<30{await Task.yield()}}
        var config=NativeQuickASRConfiguration();config.enabled=true
        check(config.endpoint?.host=="dashscope.aliyuncs.com","default Beijing endpoint is fixed, not caller controlled")
        config.workspaceID="work_123";config.region = .singapore
        check(config.endpoint?.host=="work_123.ap-southeast-1.maas.aliyuncs.com","workspace and region route use provider endpoint")
        config.workspaceID="evil/path";check(config.endpoint==nil,"invalid workspace cannot alter URL path or host")
        config.workspaceID="";config.region = .beijing
        var buffer=NativeQuickASRBuffer();buffer.append(Data(repeating:1,count:640000));buffer.append(Data(repeating:2,count:400000))
        check(buffer.bytes==400000 && buffer.lostBytes==640000,"30 second PCM cap removes whole oldest unsent chunks and reports loss")
        var sockets:[TestSocket]=[],requests:[URLRequest]=[]
        let clock=TestClock(),session=NativeQuickRealtimeASRSession(factory:{request in requests.append(request);let socket=TestSocket();sockets.append(socket);return socket},sleep:{try await clock.sleep($0)})
        check(sockets.isEmpty,"construction does not create a cloud connection")
        try session.start(configuration:config,key:"fictional-asr-only")
        session.append(Data([1,0,2,0]));await settle()
        check(sockets[0].sent.first?["type"] as? String == "session.update" && sockets[0].audio.isEmpty,"configuration is sent first; audio waits for provider ACK")
        check(requests[0].value(forHTTPHeaderField:"Authorization")=="Bearer fictional-asr-only","only the explicitly supplied ASR credential enters the request")
        sockets[0].event("session.updated");await settle()
        check(session.snapshot.phase == .connected && sockets[0].audio.count==1,"provider ACK opens audio drain")
        let textType="conversation.item.input_audio_transcription.text",finalType="conversation.item.input_audio_transcription.completed"
        sockets[0].event(textType,["item_id":"one","text":"Research ","stash":"meth"]);await settle()
        sockets[0].event(textType,["item_id":"one","text":"Research ","stash":"methods"]);await settle()
        check(session.snapshot.interim=="Research methods","interim replaces the same utterance instead of appending duplicate prefixes")
        sockets[0].event(finalType,["item_id":"one","transcript":"Research methods."]);await settle()
        sockets[0].event(finalType,["item_id":"one","transcript":"Research methods."]);sockets[0].event(finalType,["item_id":"two","transcript":"Research methods."]);await settle()
        check(session.snapshot.finalized=="Research methods.\nResearch methods.","duplicate item is suppressed while real repeated words in a distinct item remain")
        let builds=session.transcriptContentBuilds
        for _ in 0..<100 {session.append(Data(repeating:0,count:3200));await settle()}
        check(session.transcriptContentBuilds==builds && session.snapshot.finalized=="Research methods.\nResearch methods.","100 PCM chunks never rebuild or concatenate the transcript")
        sockets[0].event(textType,["item_id":"three","text":"Incomplete","stash":" idea"]);await settle()
        sockets[0].close();await settle()
        check(session.snapshot.phase == .reconnecting && session.snapshot.hasGap && session.snapshot.interruptedSegments==["Incomplete idea"],"disconnect preserves partial fragment with an explicit incomplete indication")
        session.append(Data([3,0,4,0]));clock.advance(1);await settle()
        check(sockets.count==2,"first recovery uses one-second backoff")
        sockets[1].event("session.updated");await settle()
        check(sockets[1].audio.count==1 && sockets[1].audio[0]["audio"] as? String == Data([3,0,4,0]).base64EncodedString(),"only disconnected unsent PCM is replayed once")
        sockets[0].event(finalType,["item_id":"late","transcript":"STALE"]);await settle()
        check(!session.snapshot.text.contains("STALE"),"old socket cannot publish late text")
        let finish=Task{await session.finish()};await settle()
        check(sockets[1].sent.last?["type"] as? String == "session.finish","stop sends finish after queued audio")
        sockets[1].event(finalType,["item_id":"four","transcript":"New sentence."]);sockets[1].event("session.finished");await settle()
        let result=await finish.value
        check(result.phase == .completed && result.text.hasSuffix("New sentence.") && result.hasGap,"finish ACK preserves final text without hiding earlier uncertainty")
        clock.advance(1000);await settle();check(sockets.count==2,"completed session never reconnects later")
        try session.start(configuration:config,key:"fictional-asr-only");await settle();sockets.last!.event("session.updated");await settle()
        sockets.last!.failAudio=true;session.append(Data([5,0]));await settle();clock.advance(1);await settle();sockets.last!.event("session.updated");await settle()
        check(session.snapshot.hasGap && sockets.last!.audio.isEmpty,"failed in-flight send is not ambiguously replayed into a new session")
        let timed=Task{await session.finish()};await settle();clock.advance(7);await settle();let timedResult=await timed.value
        check(timedResult.phase == .failed && timedResult.reason=="finish_timeout","stop has a seven-second total finalization limit")
        try session.start(configuration:config,key:"fictional-asr-only");await settle()
        for delay in [1.0,2,4,8,15] {sockets.last!.close();await settle();clock.advance(delay);await settle()}
        sockets.last!.close();await settle()
        check(session.snapshot.phase == .failed && session.snapshot.retry==5,"five consecutive reconnect attempts are bounded")
        let count=sockets.count;clock.advance(1000);await settle();check(sockets.count==count,"retry exhaustion creates no future sockets")
        try session.start(configuration:config,key:"fictional-asr-only");await settle();session.append(Data([8,0]));session.cancel();clock.advance(1000);await settle()
        check(session.snapshot.phase == .cancelled && session.snapshot.queuedBytes==0,"revocation cancels socket timers and queued audio")
        try session.start(configuration:config,key:"fictional-asr-only");await settle()
        session.onChange={state in if state.phase == .finishing {session.cancel()}}
        let revokedFinish=await session.finish()
        check(revokedFinish.phase == .cancelled,"synchronous revocation during finish publish returns without a stranded continuation")
        session.onChange=nil
        var saved:(NativeQuickASRConfiguration,String)?;var writes=0
        let access=NativeQuickASRSecretAccess(load:{saved?.0},read:{config in guard let saved,saved.0.origin==config.origin else{throw NativeQuickASRError.configuration};return saved.1},save:{value,key in saved=(value,key);writes+=1},remove:{saved=nil})
        let settings=NativeQuickASRSettings();settings.configure(owner:URL(fileURLWithPath:"/synthetic-asr"),access:access);settings.setAvailable(true)
        check(!settings.configuration.enabled && !settings.configured && writes==0,"settings load is disabled until explicit dedicated-key save")
        check(settings.save(config,key:"fictional-config-key") && writes==1,"explicit config and credential save share one transaction")
        var disabled=config;disabled.enabled=false
        check(settings.save(disabled,key:"") && saved?.0.enabled==false,"disabling retains existing matching key without an external request")
        var other=disabled;other.region = .singapore
        check(!settings.save(other,key:"") && saved?.0.region == .beijing,"region change cannot silently reuse the previous origin credential")
        settings.setAvailable(false)
        check(!settings.save(config,key:"must-not-write") && writes==2,"private or unavailable settings cannot mutate credentials")
        do {_ = try settings.connection();check(false,"private connection must fail")}catch{check(true,"private connection is refused")}
        print("\(checks-failures)/\(checks) realtime protocol/session/settings checks; no microphone or network")
        if failures>0{exit(1)}
    }
}
