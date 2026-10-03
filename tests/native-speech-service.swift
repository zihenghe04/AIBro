import Foundation
import AVFoundation
func nativeUI(_ zh:String,_ en:String)->String{en}
enum AgendaError:LocalizedError{case message(String);var errorDescription:String?{if case .message(let s)=self{return s};return nil}}

final class SpeechProtocolFixture:URLProtocol,@unchecked Sendable {
    static let lock=NSLock()
    static var handler:((SpeechProtocolFixture)->Void)?
    static var starts=0,stops=0
    static func install(_ value:@escaping(SpeechProtocolFixture)->Void){lock.lock();handler=value;starts=0;stops=0;lock.unlock()}
    override class func canInit(with request:URLRequest)->Bool{true}
    override class func canonicalRequest(for request:URLRequest)->URLRequest{request}
    override func startLoading(){Self.lock.lock();Self.starts+=1;let h=Self.handler;Self.lock.unlock();h?(self)}
    override func stopLoading(){Self.lock.lock();Self.stops+=1;Self.lock.unlock()}
    func reply(_ code:Int=200,headers:[String:String]=[:],chunks:[Data]=[]) {
        client?.urlProtocol(self,didReceive:HTTPURLResponse(url:request.url!,statusCode:code,httpVersion:"HTTP/1.1",headerFields:headers)!,cacheStoragePolicy:.notAllowed)
        for chunk in chunks{client?.urlProtocol(self,didLoad:chunk)}
        client?.urlProtocolDidFinishLoading(self)
    }
    static var count:Int{lock.lock();defer{lock.unlock()};return starts}
}
actor SpeechSecretFixture {
    var config:NativeSpeechConfiguration?,key="synthetic-key",gate:CheckedContinuation<Void,Never>?,pauseRead=false,writeCount=0
    func load()->NativeSpeechConfiguration?{config}
    func read(_ value:NativeSpeechConfiguration)async throws->String{if pauseRead{await withCheckedContinuation{gate=$0}};guard value.credentialScope==config?.credentialScope else{throw NativeSpeechError.credential};return key}
    func save(_ value:NativeSpeechConfiguration,_ secret:String){config=value;key=secret;writeCount+=1}
    func remove(){config=nil}
    func pause(_ value:Bool){pauseRead=value}
    func waiting()->Bool{gate != nil}
    func release(){gate?.resume();gate=nil}
    nonisolated var access:NativeSpeechSecretAccess{.init(load:{await self.load()},read:{try await self.read($0)},save:{await self.save($0,$1)},remove:{await self.remove()})}
}

@main struct SpeechTests {
    @MainActor static var checks=0
    @MainActor static func check(_ value:Bool,_ label:String){precondition(value,label);checks+=1;print("PASS \(checks): \(label)")}
    @MainActor static func rejects(_ label:String,_ expected:NativeSpeechError?=nil,_ operation:()async throws->Void)async {
        do{try await operation();preconditionFailure(label)}catch{if let expected{check(error as? NativeSpeechError==expected,label)}else{check(true,label)}}
    }
    static func wav(seconds:Double,sampleRate:Int=16000)->Data {
        let count=Int(seconds*Double(sampleRate));var bytes=Data()
        func ascii(_ s:String){bytes.append(Data(s.utf8))};func u16(_ n:UInt16){var n=n.littleEndian;withUnsafeBytes(of:&n){bytes.append(contentsOf:$0)}};func u32(_ n:UInt32){var n=n.littleEndian;withUnsafeBytes(of:&n){bytes.append(contentsOf:$0)}}
        ascii("RIFF");u32(UInt32(count*2+36));ascii("WAVEfmt ");u32(16);u16(1);u16(1);u32(UInt32(sampleRate));u32(UInt32(sampleRate*2));u16(2);u16(16);ascii("data");u32(UInt32(count*2));bytes.append(Data(repeating:0,count:count*2));return bytes
    }
    @MainActor static func wait(_ predicate:()async->Bool)async{for _ in 0..<1000{if await predicate(){return};try? await Task.sleep(nanoseconds:1_000_000)};preconditionFailure("wait expired")}
    @MainActor static func main() async throws {
        setbuf(stdout,nil);let root=URL(fileURLWithPath:CommandLine.arguments[1]);var config=NativeSpeechConfiguration()
        check(config.valid && config.endpoint?.absoluteString=="https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation","default stays on the explicitly selected Token Plan origin and Ali HTTP protocol")
        let sameScope=config.credentialScope
        config.baseURL="https://token-plan.cn-beijing.maas.aliyuncs.com/";check(config.credentialScope==sameScope,"Ali root and compatible-mode base normalize to the same exact service")
        config.baseURL="https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";check(config.credentialScope==sameScope,"an explicit Ali endpoint stays unchanged")
        for invalid in ["http://example.invalid/v1","https://name:password@example.invalid/v1","https://example.invalid/?x=1","https://example.invalid/#fragment","https://example.invalid/other","https://example.invalid/%2e%2e/compatible-mode/v1"]{var c=config;c.baseURL=invalid;check(!c.valid,"reject unsafe or unrecognized Ali URL")}
        var open=config;open.provider = .openAI;open.baseURL="https://example.invalid/v1";open.model="whisper-1"
        check(open.endpoint?.path=="/v1/audio/transcriptions","OpenAI appends the audio endpoint to the user's selected base")
        open.baseURL="https://example.invalid/v1/audio/transcriptions";check(open.endpoint?.path=="/v1/audio/transcriptions","OpenAI complete endpoint is not appended twice")
        var unchangedProvider=config;unchangedProvider.provider = .openAI;check(unchangedProvider.credentialScope != sameScope,"credential scope includes protocol, not only network origin")
        config = .init();let short=root.appendingPathComponent("synthetic.wav");let original=wav(seconds:1,sampleRate:48000);try original.write(to:short)
        let normalized=try await Task.detached{try NativeSpeechService.normalize(fileURL:short,provider:.aliyun)}.value
        check(normalized.prefix(4)==Data("RIFF".utf8) && normalized[22]==1 && normalized[24]==128 && normalized[25]==62 && normalized[34]==16,"synthetic 48k WAV is normalized to 16k mono PCM16")
        check(abs(normalized.count-32044)<=8,"normalization retains the complete one-second recording")
        check(try Data(contentsOf:short)==original,"normalization never alters the source audio")
        let req=try NativeSpeechService.request(wav:normalized,configuration:config,key:"synthetic-key")
        let body=try JSONSerialization.jsonObject(with:req.httpBody!) as! [String:Any],params=body["parameters"] as! [String:Any],messages=(body["input"] as! [String:Any])["messages"] as! [[String:Any]],content=messages[0]["content"] as! [[String:Any]],audio=content[0]["input_audio"] as! [String:Any]
        check((audio["data"] as? String)?.hasPrefix("data:audio/wav;base64,")==true && params["format"] as? String=="wav" && params["sample_rate"] as? String=="16000" && req.value(forHTTPHeaderField:"X-DashScope-SSE")=="disable","Ali request uses DataURI and documented non-streaming format/sample rate")
        let multipart=try NativeSpeechService.request(wav:normalized,configuration:open,key:"synthetic-key")
        let string=String(decoding:multipart.httpBody!,as:UTF8.self)
        check(string.contains("name=\"file\"; filename=\"recording.wav\"") && string.contains("name=\"model\"") && string.contains("name=\"response_format\"") && multipart.httpBody!.range(of:normalized) != nil,"OpenAI multipart contains the complete WAV and selected model")
        let result=try NativeSpeechService.transcript(Data("{\"output\":{\"text\":\"Full beginning and complete ending\",\"sentence\":{\"text\":\"Only ending\"}}}".utf8),provider:.aliyun)
        check(result=="Full beginning and complete ending","Ali output.text wins over sentence-only data")
        await rejects("sentence-only response is not misrepresented as complete",.invalidResponse){_=try NativeSpeechService.transcript(Data("{\"output\":{\"sentence\":{\"text\":\"Only ending\"}}}".utf8),provider:.aliyun)}
        await rejects("empty final response is explicit no-speech",.noSpeech){_=try NativeSpeechService.transcript(Data("{\"text\":\"\"}".utf8),provider:.openAI)}
        check(try NativeSpeechService.transcript(Data("{\"text\":\"完整中文。\"}".utf8),provider:.openAI)=="完整中文。","OpenAI complete JSON text is preserved")
        let long=root.appendingPathComponent("long.wav");try wav(seconds:300.1).write(to:long)
        await rejects("Ali duration above five minutes fails before request",.tooLong){_=try NativeSpeechService.normalize(fileURL:long,provider:.aliyun)}
        await rejects("Ali encoded 10MB limit rejects complete oversized audio",.audioTooLarge){_=try NativeSpeechService.request(wav:Data(repeating:0,count:7_600_000),configuration:config,key:"synthetic-key")}
        await rejects("OpenAI 25MB WAV budget rejects complete oversized audio",.audioTooLarge){_=try NativeSpeechService.request(wav:Data(repeating:0,count:25_000_001),configuration:open,key:"synthetic-key")}
        let fakeLink=root.appendingPathComponent("link.wav");try FileManager.default.createSymbolicLink(at:fakeLink,withDestinationURL:short)
        await rejects("symlink source is rejected",.invalidAudio){_=try NativeSpeechService.normalize(fileURL:fakeLink,provider:.aliyun)}
        let integrated=try await NativeSpeechService.transcribe(fileURL:short,configuration:config,key:"synthetic-key",transport:{request in
            precondition(!Thread.isMainThread);precondition(request.httpBody != nil);return .init(status:200,body:Data("{\"output\":{\"text\":\"Full synthetic transcript END\"}}".utf8))})
        check(integrated.hasSuffix("END"),"full service pipeline uses background work and injected transport without network")
        await rejects("HTTP error excludes provider body and credentials",.http(401)){_=try await NativeSpeechService.transcribe(fileURL:short,configuration:config,key:"synthetic-key",transport:{_ in .init(status:401,body:Data("synthetic-key private-provider-body".utf8))})}
        check(!NativeSpeechError.http(401).localizedDescription.contains("synthetic-key"),"visible errors never echo secret or service response body")

        let sessionConfig=URLSessionConfiguration.ephemeral;sessionConfig.protocolClasses=[SpeechProtocolFixture.self]
        SpeechProtocolFixture.install{$0.reply(chunks:[Data("complete".utf8)])}
        let response=try await NativeSpeechHTTP.send(req,configuration:sessionConfig)
        check(response.status==200 && response.body==Data("complete".utf8),"real URLSession delegate collects the full synthetic response")
        SpeechProtocolFixture.install{$0.reply(headers:["Content-Length":"3000000"])}
        await rejects("response Content-Length exceeding limit is rejected",.responseTooLarge){_=try await NativeSpeechHTTP.send(req,configuration:sessionConfig)}
        SpeechProtocolFixture.install{$0.reply(chunks:[Data(repeating:65,count:1024*1024),Data(repeating:65,count:1024*1024),Data([65])])}
        await rejects("chunked response exceeding limit is rejected",.responseTooLarge){_=try await NativeSpeechHTTP.send(req,configuration:sessionConfig)}
        SpeechProtocolFixture.install{_ in}
        await rejects("total deadline terminates an unresponsive request",.timeout){_=try await NativeSpeechHTTP.send(req,configuration:sessionConfig,deadline:0.04)}
        SpeechProtocolFixture.install{_ in};let cancelled=Task{try await NativeSpeechHTTP.send(req,configuration:sessionConfig)};await wait{SpeechProtocolFixture.count==1};cancelled.cancel()
        do{_=try await cancelled.value;preconditionFailure("cancel must throw")}catch{check(error is CancellationError,"in-flight cancellation completes once without a response")}
        SpeechProtocolFixture.install{p in let redirect=HTTPURLResponse(url:p.request.url!,statusCode:302,httpVersion:"HTTP/1.1",headerFields:["Location":"https://other.invalid/"])!;p.client?.urlProtocol(p,wasRedirectedTo:URLRequest(url:URL(string:"https://other.invalid/")!),redirectResponse:redirect)}
        await rejects("cross-origin redirect never forwards credentials",.redirect){_=try await NativeSpeechHTTP.send(req,configuration:sessionConfig)}
        check(SpeechProtocolFixture.count==1,"redirect does not create a second request")

        let directory=root.appendingPathComponent("Speech"),access=NativeSpeechCredentialAdapter.access(directory:directory,service:"dev.aibro.synthetic.speech")
        check(try await access.load()==nil,"new dedicated speech store begins empty without keychain migration")
        try await access.save(config,"synthetic-key")
        let restoredConfig=try await access.load(),restoredKey=try await access.read(config)
        check(restoredConfig==config && restoredKey=="synthetic-key","dedicated encrypted store round-trips exact configuration and synthetic Key")
        var other=config;other.baseURL="https://other.invalid/compatible-mode/v1"
        await rejects("another origin cannot reuse the saved speech Key",.credential){_=try await access.read(other)}
        var otherProtocol=config;otherProtocol.provider = .openAI
        await rejects("same host with another protocol cannot reuse the speech Key",.credential){_=try await access.read(otherProtocol)}
        let settings=NativeSpeechSettings();settings.configure(owner:root,access:access);settings.setAvailable(true);await wait{!settings.busy}
        check(settings.configured && settings.configuration==config,"settings publish loaded configuration after asynchronous worker completion")
        var language=config;language.language="en"
        check(await settings.save(language,key:""),"empty Key retains only the same exact speech endpoint")
        check(!(await settings.save(other,key:"")) && settings.configuration==language,"changing service requires a newly supplied Key and leaves old settings intact")
        check(try await settings.connection().0==language,"connection returns the configured service with its exact credential")
        check(await settings.remove() && !settings.configured,"explicit remove clears only the dedicated speech setting")
        check(try await access.load()==nil && FileManager.default.fileExists(atPath:short.path),"removing credentials never removes audio")
        let fake=SpeechSecretFixture();await fake.save(config,"synthetic-key");let guarded=NativeSpeechSettings();guarded.configure(owner:root,access:fake.access);guarded.setAvailable(true);await wait{!guarded.busy};await fake.pause(true)
        let connection=Task{try await guarded.connection()};await wait{await fake.waiting()};guarded.setAvailable(false);await fake.release()
        do{_=try await connection.value;preconditionFailure("late connection")}catch{check(error as? NativeSpeechError == .changed,"revocation rejects a late credential read before service invocation")}
        guarded.setAvailable(true);await wait{!guarded.busy};let oldRevision=guarded.revision
        let emptySave=Task{await guarded.save(language,key:"")};await wait{await fake.waiting()};guarded.setAvailable(false);await fake.release();let saved=await emptySave.value
        check(!saved && guarded.revision>oldRevision && guarded.error==nil,"private change cancels pending empty-key save and does not republish an error")
        check(await fake.writeCount==1,"cancelled read stage never reaches the credential writer")
        print("PASS: \(checks) speech service checks; synthetic files, URLProtocol only, no network/microphone/general Key")
    }
}
