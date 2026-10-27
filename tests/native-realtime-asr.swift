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
    var binary:[Data]=[]
    func sendBinary(_ data:Data) async throws {binary.append(data)}
    func ping() async throws {}
    func close(){closed=true;let old=waiter;waiter=nil;old?.resume(throwing:CancellationError())}
    func event(_ type:String,_ extra:[String:Any]=[:]){var object=extra;object["type"]=type;let data=try! JSONSerialization.data(withJSONObject:object);if let old=waiter{waiter=nil;old.resume(returning:data)}else{pending.append(data)}}
    var audio:[[String:Any]]{sent.filter{$0["type"] as? String == "input_audio_buffer.append"}}
    func message(_ type:String,_ extra:[String:Any]=[:]){var object=extra;object["message_type"]=type;let data=try! JSONSerialization.data(withJSONObject:object);if let old=waiter{waiter=nil;old.resume(returning:data)}else{pending.append(data)}}
    var chunks:[[String:Any]]{sent.filter{$0["message_type"] as? String == "input_audio_chunk"}}
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
        let probe = TestSocket()
        var probeRequests = 0
        let probeDraft = NativeQuickASRSettingsDraft(configuration: config, key: "synthetic-probe")
        settings.testConnection(probeDraft, factory: { _ in probeRequests += 1; return probe })
        await settle()
        check(settings.testing && probe.sent.first?["type"] as? String == "session.update", "explicit test sends only session settings")
        check(probe.audio.isEmpty && writes == 2, "connection test uploads no audio and does not save")
        probe.event("session.created"); await settle()
        check(settings.testing, "socket creation alone is not connection-test success")
        probe.event("session.updated"); await settle()
        check(!settings.testing && settings.testMessage?.contains("Connected") == true && probe.closed, "provider configuration acknowledgement succeeds and closes socket")
        let cancelledProbe = TestSocket()
        settings.testConnection(probeDraft, factory: { _ in probeRequests += 1; return cancelledProbe }); await settle()
        settings.cancelTest(); cancelledProbe.event("session.updated"); await settle()
        check(!settings.testing && settings.testMessage == nil && cancelledProbe.closed, "cancelled test cannot publish late success")
        let rejectedProbe = TestSocket()
        settings.testConnection(probeDraft, factory: { _ in rejectedProbe }); await settle()
        rejectedProbe.event("error", ["error": ["message": "synthetic-secret-server-echo"]]); await settle()
        check(settings.testMessage?.contains("failed") == true && settings.testMessage?.contains("synthetic-secret") == false, "provider rejection is reported without echoing body or credentials")
        settings.setAvailable(false)
        check(!settings.save(config,key:"must-not-write") && writes==2,"private or unavailable settings cannot mutate credentials")
        do {_ = try settings.connection();check(false,"private connection must fail")}catch{check(true,"private connection is refused")}

        // ---- ElevenLabs Scribe realtime (mock WebSocket only) ----
        var eleven=NativeQuickASRConfiguration();eleven.provider = .elevenLabs;eleven.enabled=true;eleven.language="en"
        let elevenURL=eleven.endpoint?.absoluteString ?? ""
        check(elevenURL.hasPrefix("wss://api.elevenlabs.io/v1/speech-to-text/realtime?") && elevenURL.contains("model_id=scribe_v2_realtime") && elevenURL.contains("audio_format=pcm_16000") && elevenURL.contains("commit_strategy=vad") && elevenURL.contains("language_code=en"),"ElevenLabs endpoint, model, audio format and language are fixed by the official contract")
        check(eleven.origin=="https://api.elevenlabs.io" && eleven.modelName=="scribe_v2_realtime" && eleven.update==nil,"ElevenLabs uses its own origin and model, and sends no session.update")
        let legacy=try JSONDecoder().decode(NativeQuickASRConfiguration.self,from:Data("{\"enabled\":true,\"region\":\"singapore\",\"workspaceID\":\"\",\"language\":\"zh\"}".utf8))
        check(legacy.provider == .bailian && legacy.region == .singapore && legacy.enabled,"configurations saved before ElevenLabs stay Model Studio")
        let roundTrip=try JSONDecoder().decode(NativeQuickASRConfiguration.self,from:JSONEncoder().encode(eleven))
        check(roundTrip==eleven,"provider survives a save/load round trip")
        var esockets:[TestSocket]=[],erequests:[URLRequest]=[]
        let eclock=TestClock(),esession=NativeQuickRealtimeASRSession(factory:{request in erequests.append(request);let socket=TestSocket();esockets.append(socket);return socket},sleep:{try await eclock.sleep($0)})
        try esession.start(configuration:eleven,key:"synthetic-eleven-key")
        esession.append(Data([1,0,2,0]));await settle()
        check(erequests[0].value(forHTTPHeaderField:"xi-api-key")=="synthetic-eleven-key" && erequests[0].value(forHTTPHeaderField:"Authorization")==nil,"ElevenLabs realtime authenticates with xi-api-key only")
        check(esockets[0].sent.isEmpty,"no configuration message is sent; audio waits for session_started")
        esockets[0].message("session_started",["session_id":"s1"]);await settle()
        check(esession.snapshot.phase == .connected && esockets[0].chunks.count==1,"session_started opens the audio drain")
        let chunk=esockets[0].chunks[0]
        check(chunk["sample_rate"] as? Int==16000 && chunk["commit"] as? Bool==false && chunk["audio_base_64"] as? String==Data([1,0,2,0]).base64EncodedString(),"audio goes out as input_audio_chunk with base64 PCM and sample_rate")
        esockets[0].message("partial_transcript",["text":"hel"]);esockets[0].message("partial_transcript",["text":"hello wor"]);await settle()
        check(esession.snapshot.interim=="hello wor" && esession.snapshot.finalized=="","a partial replaces the open segment")
        esockets[0].message("committed_transcript",["text":"hello world."]);await settle()
        esockets[0].message("partial_transcript",["text":"second"]);await settle()
        check(esession.snapshot.finalized=="hello world." && esession.snapshot.interim=="second","a commit closes the segment and the next partial opens a new one")
        esockets[0].message("committed_transcript",["text":"second thought."]);await settle()
        esession.append(Data([9,0]))
        async let finished=esession.finish();await settle()
        let lastChunk=esockets[0].chunks.last!
        check(lastChunk["commit"] as? Bool==true && esession.snapshot.phase == .finishing,"the last queued chunk carries the commit")
        esockets[0].message("committed_transcript",["text":"last words."]);await settle()
        let eelevenResult=await finished
        check(eelevenResult.phase == .completed && eelevenResult.finalized=="hello world.\nsecond thought.\nlast words.","final commit completes the recording without losing earlier segments")
        try esession.start(configuration:eleven,key:"synthetic-eleven-key");await settle()
        esockets.last!.message("session_started");await settle()
        async let silent=esession.finish();await settle()
        check(esockets.last!.chunks.last?["commit"] as? Bool==true && esockets.last!.chunks.last?["audio_base_64"] as? String=="","finishing with an empty queue sends an empty committing chunk, as the official SDKs do")
        esockets.last!.message("insufficient_audio_activity");await settle()
        check(await silent.phase == .completed,"nothing to commit after silence still completes")
        try esession.start(configuration:eleven,key:"synthetic-eleven-key");await settle()
        esockets.last!.message("session_started");await settle()
        esockets.last!.message("auth_error",["error":"synthetic-secret-server-echo"]);await settle()
        check(esession.snapshot.phase == .failed && esession.snapshot.reason=="configuration_rejected" && esockets.count==3,"an auth error is terminal and is not retried")
        let eleProbe=TestSocket()
        let eleSettings=NativeQuickASRSettings();var eleSaved:(NativeQuickASRConfiguration,String)?
        eleSettings.configure(owner:URL(fileURLWithPath:"/synthetic-eleven"),access:NativeQuickASRSecretAccess(load:{eleSaved?.0},read:{_ in eleSaved?.1 ?? ""},save:{eleSaved=($0,$1)},remove:{eleSaved=nil}));eleSettings.setAvailable(true)
        eleSettings.testConnection(.init(configuration:eleven,key:"synthetic-eleven-key"),factory:{request in check(request.value(forHTTPHeaderField:"xi-api-key")=="synthetic-eleven-key","test request uses xi-api-key");return eleProbe});await settle()
        check(eleProbe.sent.isEmpty,"ElevenLabs test connection sends no audio and no settings message")
        eleProbe.message("session_started");await settle()
        check(!eleSettings.testing && eleSettings.testMessage?.contains("Connected") == true,"session_started confirms the ElevenLabs test")
        // ---- Self-hosted stream service (mock WebSocket only; placeholder address) ----
        var own=NativeQuickASRConfiguration();own.provider = .selfHosted;own.enabled=true;own.language="zh";own.serverURL="ws://192.0.2.10:8000"
        check(own.valid && own.endpoint?.absoluteString=="ws://192.0.2.10:8000/stream?language=Chinese","self-hosted endpoint adds /stream and maps zh to the full language name")
        check(own.origin=="http://192.0.2.10:8000" && own.update==nil && own.host=="192.0.2.10","self-hosted credential scope uses the http form of the address and sends no session.update")
        own.language="en";check(own.endpoint?.absoluteString.hasSuffix("language=English")==true,"en maps to English");own.language="";check(own.valid && own.endpoint?.absoluteString.hasSuffix("language=auto")==true,"blank means auto");own.language="auto";check(own.valid,"auto is accepted");own.language="ja";check(!own.valid,"only zh / en / auto are offered for the self-hosted service");own.language="zh"
        for good in ["ws://asr-box:8000","wss://asr.example.com/stream","ws://nas.local:8000/stream","ws://192.0.2.10:8000/","ws://asr.example.com:8000"]{var c=own;c.serverURL=good;check(c.valid,"self-hosted accepts \(good)")}
        for bad in ["ftp://192.0.2.10:8000","ws://192.0.2.10:8000/stream?x=1","ws://u:p@192.0.2.10:8000",""]{var c=own;c.serverURL=bad;check(!c.valid,"self-hosted rejects \(bad.isEmpty ? "blank" : bad)")}
        for (typed,expected) in [("http://192.0.2.10:8000","ws://192.0.2.10:8000/stream"),("192.0.2.10:8000/v1","ws://192.0.2.10:8000/stream"),("https://asr.example.com/v1/audio/transcriptions","wss://asr.example.com/stream"),("ws://h:1/stream","ws://h:1/stream"),("http://h:8000/base/v1","ws://h:8000/base/stream"),("  http://h:8000/  ","ws://h:8000/stream")]{
            check(NativeQuickASRConfiguration.streamAddress(typed)==expected,"a typed address \(typed) becomes \(expected)")
        }
        check(NativeQuickASRConfiguration.streamAddress("")==nil && NativeQuickASRConfiguration.streamAddress("ftp://x")==nil,"nothing usable is derived from blank or non-web input")
        var typedOwn=own;typedOwn.serverURL="http://192.0.2.10:8000/v1";check(typedOwn.valid && typedOwn.endpoint?.absoluteString=="ws://192.0.2.10:8000/stream?language=Chinese","a base typed with http and /v1 connects to ws://…/stream")
        typedOwn.serverURL="";check(typedOwn.serverURLProblem != nil && !typedOwn.valid,"a blank address has a problem text and is not valid")
        let tokenRequest=try own.request(key:"a&b+c=d e")
        check(tokenRequest.url?.query=="token=a%26b%2Bc%3Dd%20e&language=Chinese" && tokenRequest.value(forHTTPHeaderField:"Authorization")==nil,"the token is percent-encoded in the query, so it cannot add parameters, and no auth header is sent")
        check(try JSONDecoder().decode(NativeQuickASRConfiguration.self,from:JSONEncoder().encode(own))==own,"self-hosted settings survive a save/load round trip")
        var osockets:[TestSocket]=[],orequests:[URLRequest]=[]
        let oclock=TestClock(),osession=NativeQuickRealtimeASRSession(factory:{request in orequests.append(request);let socket=TestSocket();osockets.append(socket);return socket},sleep:{try await oclock.sleep($0)})
        try osession.start(configuration:own,key:"synthetic-own-token")
        osession.append(Data([1,0,2,0]));await settle()
        check(osockets[0].sent.isEmpty && osockets[0].binary.isEmpty,"nothing is sent before the server's ready message")
        osockets[0].event("ready",["sample_rate":16000]);await settle()
        check(osession.snapshot.phase == .connected && osockets[0].binary.count==1 && osockets[0].binary[0]==Data([1,0,2,0]) && osockets[0].audio.isEmpty && osockets[0].chunks.isEmpty,"after ready, PCM goes out as a raw binary frame")
        osockets[0].event("partial",["text":"你"]);osockets[0].event("partial",["text":"你好世"]);await settle()
        check(osession.snapshot.interim=="你好世" && osession.snapshot.finalized=="","a partial replaces the open text")
        osession.append(Data([3,0]))
        async let ownFinished=osession.finish();await settle()
        check(osockets[0].sent.last?["type"] as? String=="stop" && osession.snapshot.phase == .finishing,"finishing sends the text frame {type:stop} after the audio")
        osockets[0].event("final",["text":"你好世界。","language":"Chinese"]);await settle()
        let ownResult=await ownFinished
        check(ownResult.phase == .completed && ownResult.finalized=="你好世界。" && ownResult.interim=="","final completes the recording with the server's text")
        try osession.start(configuration:own,key:"synthetic-own-token");await settle()
        osockets.last!.event("ready");await settle()
        osockets.last!.event("error",["message":"synthetic-server-detail"]);await settle()
        check(osession.snapshot.phase == .reconnecting,"a server error reconnects instead of dropping the recording")
        let ownProbe=TestSocket()
        let ownSettings=NativeQuickASRSettings();var ownSaved:(NativeQuickASRConfiguration,String)?
        ownSettings.configure(owner:URL(fileURLWithPath:"/synthetic-own"),access:NativeQuickASRSecretAccess(load:{ownSaved?.0},read:{_ in ownSaved?.1 ?? ""},save:{ownSaved=($0,$1)},remove:{ownSaved=nil}));ownSettings.setAvailable(true)
        ownSettings.testConnection(.init(configuration:own,key:"synthetic-own-token"),factory:{request in check(request.url?.query?.hasPrefix("token=synthetic-own-token") == true,"test request carries the token in the query");return ownProbe});await settle()
        check(ownProbe.sent.isEmpty && ownProbe.binary.isEmpty,"self-hosted test connection sends nothing but waits for ready")
        ownProbe.event("ready");await settle()
        check(!ownSettings.testing && ownSettings.testMessage?.contains("Connected") == true,"ready confirms the self-hosted test")
        print("\(checks-failures)/\(checks) realtime protocol/session/settings checks; no microphone or network")
        if failures>0{exit(1)}
    }
}
