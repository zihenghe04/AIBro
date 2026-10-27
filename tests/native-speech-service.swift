import Foundation
import AVFoundation
import Network
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


/// Real loopback HTTP server (Network.framework) so the self-hosted client runs the same code path as the app, with no external network.
final class LoopbackServer:@unchecked Sendable {
    let listener=try! NWListener(using:.tcp,on:.any);let queue=DispatchQueue(label:"loopback")
    let lock=NSLock();var seen:[String]=[],bodies:[Data]=[]
    var handler:(String,String)->Data={_,_ in Data("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8)}
    var port:UInt16{listener.port?.rawValue ?? 0}
    func start()async{
        listener.newConnectionHandler={[unowned self] c in self.serve(c)}
        await withCheckedContinuation{(k:CheckedContinuation<Void,Never>) in var done=false;listener.stateUpdateHandler={if case .ready=$0,!done{done=true;k.resume()}};listener.start(queue:queue)}
    }
    func serve(_ c:NWConnection){
        c.start(queue:queue);var data=Data()
        func more(){c.receive(minimumIncompleteLength:1,maximumLength:65536){[unowned self] d,_,_,e in
            if let d{data.append(d)}
            if let r=data.range(of:Data("\r\n\r\n".utf8)){
                let head=String(decoding:data[..<r.lowerBound],as:UTF8.self),length=head.lowercased().components(separatedBy:"content-length: ").dropFirst().first.flatMap{Int($0.prefix{$0.isNumber})} ?? 0
                if data.count-r.upperBound>=length{
                    let line=head.components(separatedBy:"\r\n")[0].split(separator:" ");self.lock.lock();self.seen.append(line[0]+" "+line[1]+(head.lowercased().contains("authorization: bearer") ? " auth":""));self.bodies.append(Data(data[r.upperBound...]));self.lock.unlock()
                    c.send(content:self.handler(String(line[0]),String(line[1])),completion:.contentProcessed{_ in c.cancel()});return
                }
            }
            if e==nil{more()}else{c.cancel()}
        }}
        more()
    }
}
func http(_ status:Int,_ body:String,chunked:Bool=false)->Data {
    if chunked{let a=String(body.prefix(5)),b=String(body.dropFirst(5));return Data("HTTP/1.1 \(status) X\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n\(String(a.utf8.count,radix:16))\r\n\(a)\r\n\(String(b.utf8.count,radix:16))\r\n\(b)\r\n0\r\n\r\n".utf8)}
    return Data("HTTP/1.1 \(status) X\r\nContent-Type: application/json\r\nContent-Length: \(body.utf8.count)\r\nConnection: close\r\n\r\n\(body)".utf8)
}

final class KeyBox:@unchecked Sendable{var value=""}
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
        var eleven=NativeSpeechConfiguration();eleven.provider = .elevenLabs;eleven.baseURL=NativeSpeechConfiguration.elevenLabsBase;eleven.model=NativeSpeechConfiguration.elevenLabsModel
        check(eleven.valid && eleven.endpoint?.absoluteString=="https://api.elevenlabs.io/v1/speech-to-text","ElevenLabs default resolves to the official speech-to-text endpoint")
        eleven.baseURL="https://api.elevenlabs.io/v1";check(eleven.endpoint?.absoluteString=="https://api.elevenlabs.io/v1/speech-to-text","ElevenLabs /v1 base resolves to the same endpoint")
        eleven.baseURL="https://api.elevenlabs.io/v1/text-to-speech/abc";check(eleven.endpoint==nil && !eleven.valid,"a text-to-speech path is rejected for speech-to-text")
        eleven.baseURL=NativeSpeechConfiguration.elevenLabsBase;eleven.language="en"
        let elevenRequest=try NativeSpeechService.request(wav:SpeechTests.wav(seconds:0.2),configuration:eleven,key:"synthetic-eleven-key")
        let elevenBody=String(decoding:elevenRequest.httpBody ?? Data(),as:UTF8.self)
        check(elevenRequest.value(forHTTPHeaderField:"xi-api-key")=="synthetic-eleven-key" && elevenRequest.value(forHTTPHeaderField:"Authorization")==nil,"ElevenLabs authenticates with xi-api-key, not a bearer token")
        check(elevenBody.contains("name=\"model_id\"\r\n\r\nscribe_v2") && elevenBody.contains("name=\"language_code\"\r\n\r\nen") && elevenBody.contains("name=\"file\"") && !elevenBody.contains("response_format"),"ElevenLabs multipart carries model_id, language_code and file only")
        check(try NativeSpeechService.transcript(Data("{\"language_code\":\"en\",\"text\":\"hello there\",\"words\":[]}".utf8),provider:.elevenLabs)=="hello there","ElevenLabs top-level text is the transcript")
        await rejects("ElevenLabs error detail is not a transcript",.invalidResponse){_=try NativeSpeechService.transcript(Data("{\"detail\":{\"status\":\"invalid_api_key\"},\"text\":\"x\"}".utf8),provider:.elevenLabs)}
        let seen=KeyBox()
        try await NativeSpeechService.testConnection(configuration:eleven,key:"synthetic-eleven-key",transport:{request in seen.value=request.value(forHTTPHeaderField:"xi-api-key") ?? "";return .init(status:200,body:Data("{\"text\":\"\"}".utf8))})
        check(seen.value=="synthetic-eleven-key","ElevenLabs connection test uses the mocked transport only")
        var elevenExportConfig=eleven;elevenExportConfig.language=""
        check(elevenExportConfig.credentialScope != config.credentialScope && elevenExportConfig.credentialScope?.hasPrefix("elevenLabs|") == true,"ElevenLabs credential scope is its own")
        // Self-hosted OpenAI-compatible service (placeholder addresses only).
        var own=NativeSpeechConfiguration();own.provider = .selfHosted;own.baseURL="http://192.0.2.10:8000/v1";own.model="Qwen3-ASR-1.7B";own.language="auto"
        check(own.valid && own.endpoint?.absoluteString=="http://192.0.2.10:8000/v1/audio/transcriptions","self-hosted accepts plain http for an IP address and appends the audio endpoint")
        for ok in ["http://asr-box:8000/v1","http://nas.local:8000/v1","https://asr.example.com/v1","http://[::1]:8000/v1","http://asr.example.com:8000/v1"]{var c=own;c.baseURL=ok;check(c.valid,"self-hosted accepts \(ok)")}
        for bad in ["http://192.0.2.10:8000/v1?x=1","ftp://192.0.2.10/v1","http://user:pw@192.0.2.10/v1"]{var c=own;c.baseURL=bad;check(!c.valid,"self-hosted rejects \(bad)")}
        var plainOpenAI=own;plainOpenAI.provider = .openAI;check(!plainOpenAI.valid,"the OpenAI-compatible protocol stays https only")
        var plainAli=own;plainAli.provider = .aliyun;check(!plainAli.valid,"Alibaba stays https only")
        let ownRequest=try NativeSpeechService.request(wav:SpeechTests.wav(seconds:0.2),configuration:own,key:"synthetic-own-key")
        let ownBody=String(decoding:ownRequest.httpBody ?? Data(),as:UTF8.self)
        check(ownRequest.value(forHTTPHeaderField:"Authorization")=="Bearer synthetic-own-key" && ownBody.contains("name=\"model\"\r\n\r\nQwen3-ASR-1.7B") && !ownBody.contains("name=\"language\""),"self-hosted sends bearer + model and omits language for auto")
        check(ownRequest.timeoutInterval==180,"self-hosted default timeout covers long recordings")
        own.language="zh";own.timeoutSeconds=600
        let ownZh=try NativeSpeechService.request(wav:SpeechTests.wav(seconds:0.2),configuration:own,key:"synthetic-own-key")
        check(String(decoding:ownZh.httpBody ?? Data(),as:UTF8.self).contains("name=\"language\"\r\n\r\nzh") && ownZh.timeoutInterval==600,"self-hosted sends zh and honors the configured timeout")
        own.timeoutSeconds=5;check(own.deadline==30,"timeout is clamped to a sane minimum");own.timeoutSeconds=nil
        check((try JSONDecoder().decode(NativeSpeechConfiguration.self,from:Data("{\"provider\":\"openAI\",\"baseURL\":\"https://example.invalid/v1\",\"model\":\"m\",\"language\":\"\"}".utf8))).timeoutSeconds==nil,"older saved schemes without a timeout still decode")
        let calls=KeyBox()
        try await NativeSpeechService.testConnection(configuration:own,key:"synthetic-own-key",transport:{request in
            calls.value+=(request.httpMethod ?? "")+" "+(request.url?.path ?? "")+" auth="+(request.value(forHTTPHeaderField:"Authorization") == nil ? "no":"yes")+";"
            return request.url?.path=="/health" ? .init(status:200,body:Data("{\"ready\":true,\"loading\":false}".utf8)):.init(status:200,body:Data("{\"data\":[]}".utf8))})
        check(calls.value=="GET /health auth=no;GET /v1/models auth=yes;","self-hosted test checks /health without credentials, then /v1/models with the Key, and sends no audio")
        await rejects("a loading model reported by /health is shown as loading",.modelLoading){try await NativeSpeechService.testConnection(configuration:own,key:"k",transport:{_ in .init(status:200,body:Data("{\"ready\":false,\"loading\":true}".utf8))})}
        await rejects("503 from the transcription endpoint means the model is loading",.modelLoading){try await NativeSpeechService.testConnection(configuration:own,key:"k",transport:{request in request.url?.path=="/health" ? .init(status:404,body:Data()):.init(status:503,body:Data("{\"error\":{\"message\":\"loading\"}}".utf8))})}
        do{try await NativeSpeechService.testConnection(configuration:own,key:"synthetic-secret-key",transport:{request in request.url?.path=="/health" ? .init(status:200,body:Data("{\"ready\":true}".utf8)):.init(status:401,body:Data())});preconditionFailure("401")}
        catch{let text=error.localizedDescription;check(text.contains("401") && text.contains("/v1/models") && !text.contains("synthetic-secret-key") && !text.contains("recording"),"a wrong token names the status and path, never the Key, and does not talk about a recording")}
        do{try await NativeSpeechService.testConnection(configuration:own,key:"k",transport:{request in request.url?.path=="/health" ? .init(status:200,body:Data("{\"ready\":true}".utf8)):.init(status:404,body:Data())});preconditionFailure("404")}
        catch{check(error.localizedDescription.contains("404") && error.localizedDescription.contains("/v1"),"a 404 on /v1/models points at the base URL path")}
        do{try await NativeSpeechService.testConnection(configuration:own,key:"k",transport:{_ in throw NativeSpeechError.network});preconditionFailure("net")}
        catch{check(error.localizedDescription.contains("/health") && !error.localizedDescription.contains("recording"),"a connection failure names the first request and not the recording")}
        // Real sockets: the self-hosted client over Network.framework against a loopback server.
        let server=LoopbackServer();await server.start()
        var local=NativeSpeechConfiguration();local.provider = .selfHosted;local.baseURL="http://127.0.0.1:\(server.port)/v1";local.model="Qwen3-ASR-1.7B";local.language="auto"
        server.handler={method,path in path=="/health" ? http(200,"{\"ready\":true,\"loading\":false}"):path=="/v1/models" ? http(200,"{\"data\":[]}"):path=="/v1/audio/transcriptions" ? http(200,"{\"text\":\"本地回环\"}",chunked:true):http(404,"{}")}
        try await NativeSpeechService.testConnection(configuration:local,key:"synthetic-key")
        check(server.seen==["GET /health","GET /v1/models auth"],"real sockets: /health goes out without credentials, /v1/models with the Key, and base /v1 is not doubled")
        let localFile=root.appendingPathComponent("local.wav");try wav(seconds:0.3).write(to:localFile)
        check(try await NativeSpeechService.transcribe(fileURL:localFile,configuration:local,key:"synthetic-key")=="本地回环","real sockets: multipart POST goes out and a chunked JSON response is decoded")
        check(server.bodies.last.map{$0.count>9000 && String(decoding:$0.prefix(60),as:UTF8.self).contains("--AIBroSpeech")} == true,"the multipart body arrives complete")
        server.handler={_,_ in http(503,"{\"error\":{\"message\":\"loading\"}}")}
        await rejects("real sockets: 503 reads as loading",.modelLoading){try await NativeSpeechService.testConnection(configuration:local,key:"k")}
        let closedPort=server.port;server.listener.cancel();try? await Task.sleep(nanoseconds:200_000_000)
        var refused=local;refused.baseURL="http://127.0.0.1:\(closedPort)/v1"
        do{try await NativeSpeechService.testConnection(configuration:refused,key:"k");preconditionFailure("refused")}
        catch{check(error.localizedDescription.contains("refused") && error.localizedDescription.contains("/health"),"real sockets: a closed port reads as connection refused and names /health")}
        let ownFile=root.appendingPathComponent("own.wav");try wav(seconds:0.3).write(to:ownFile)
        await rejects("transcription 503 is the loading message",.modelLoading){_=try await NativeSpeechService.transcribe(fileURL:ownFile,configuration:own,key:"k",transport:{_ in .init(status:503,body:Data())})}
        check(try await NativeSpeechService.transcribe(fileURL:ownFile,configuration:own,key:"k",transport:{_ in .init(status:200,body:Data("{\"text\":\"你好\"}".utf8))})=="你好","self-hosted {text} response is the transcript")
        check(own.credentialScope?.hasPrefix("selfHosted|http://") == true,"self-hosted credential scope is its own")
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
        let exporter=NativeCredentials(folder:directory,legacy:nil,service:"dev.aibro.synthetic.speech")
        let exported=try exporter.exportSavedSpeech([:]),profile=exported["profile"] as! [String:Any]
        check(profile["provider"] as? String=="aliyun" && profile["apiFormat"] as? String=="aliyun-multimodal" && profile["purpose"] as? String=="speech","speech export maps independent Aliyun protocol without chat fallback")
        check(profile["baseUrl"] as? String==config.endpoint?.absoluteString && profile["apiKey"] as? String=="synthetic-key","speech export retains normalized endpoint and its own secret")
        check(try exporter.exportSavedSpeech(["sourceDigest":exported["sourceDigest"]!],verify:true)["valid"] as? Bool==true,"speech unchanged snapshot verifies")
        var updated=config;updated.language="zh";try await access.save(updated,"synthetic-key")
        await rejects("language change invalidates reviewed snapshot"){_=try exporter.exportSavedSpeech(["sourceDigest":exported["sourceDigest"]!],verify:true)}
        check((try exporter.exportSavedSpeech([:])["profile"] as? [String:Any])?["language"] as? String=="zh","speech profile retains explicit language")
        let gate=NativeConnectionAccess.Gate(),lease=gate.capture();gate.invalidate()
        await rejects("revoked page cannot export speech"){_=try exporter.exportSavedSpeech([:],access:lease)}
        try await access.save(open,"synthetic-openai-speech")
        let openProfile=try exporter.exportSavedSpeech([:])["profile"] as! [String:Any]
        check(openProfile["apiFormat"] as? String=="audio-transcriptions" && openProfile["baseUrl"] as? String==open.endpoint?.absoluteString,"OpenAI speech uses full endpoint without duplicate suffix")
        try await access.remove()
        await rejects("removed source cannot export an old speech Key"){_=try exporter.exportSavedSpeech([:])}
        try await access.save(config,"synthetic-key")
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
