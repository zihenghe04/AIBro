import Foundation
import AVFoundation
import Network

struct NativeSpeechConfiguration: Codable, Equatable, Sendable {
    enum Provider: String, Codable, CaseIterable, Sendable { case aliyun, openAI, elevenLabs, selfHosted }
    var provider: Provider = .aliyun
    var baseURL = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
    var model = "qwen-audio-3.0-asr-flash"
    var language = ""
    /// Self-hosted services only: how long one request may take (long recordings). Absent in older saved schemes.
    var timeoutSeconds: Int?
    private static let aliPath = "/api/v1/services/aigc/multimodal-generation/generation"
    /// Official contract (https://elevenlabs.io/docs/api-reference/speech-to-text/convert, checked 2026-10-26):
    /// POST https://api.elevenlabs.io/v1/speech-to-text, header xi-api-key, multipart model_id + file (+ language_code), JSON { text }.
    static let elevenLabsBase = "https://api.elevenlabs.io", elevenLabsModel = "scribe_v2"
    static func defaults(for provider: Provider) -> (baseURL: String, model: String) {
        switch provider {
        case .aliyun: return ("https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", "qwen-audio-3.0-asr-flash")
        case .openAI: return ("https://api.openai.com/v1", "whisper-1")
        case .elevenLabs: return (elevenLabsBase, elevenLabsModel)
        case .selfHosted: return ("", "Qwen3-ASR-1.7B")
        }
    }
    var endpoint: URL? {
        let raw=baseURL.trimmingCharacters(in:.whitespacesAndNewlines)
        guard raw.utf8.count<=2048,var parts=URLComponents(string:raw),let scheme=parts.scheme?.lowercased(),
              scheme=="https" || (provider == .selfHosted && scheme=="http"),
              let host=parts.host,!host.isEmpty,parts.user==nil,parts.password==nil,parts.query==nil,parts.fragment==nil,
              !raw.unicodeScalars.contains(where:CharacterSet.controlCharacters.contains),
              parts.percentEncodedPath==parts.path, !parts.path.split(separator:"/").contains(where:{$0=="." || $0==".."}) else{return nil}
        parts.scheme=scheme;parts.host=host.lowercased();if parts.port==(scheme=="https" ? 443:80){parts.port=nil}
        let path=parts.path.trimmingCharacters(in:CharacterSet(charactersIn:"/"))
        if provider == .aliyun {
            guard ["","compatible-mode/v1",String(Self.aliPath.dropFirst())].contains(path) else{return nil}
            parts.path=Self.aliPath
        } else if provider == .elevenLabs {
            guard ["","v1","v1/speech-to-text"].contains(path) else{return nil}
            parts.path="/v1/speech-to-text"
        } else {
            parts.path="/" + (path.hasSuffix("audio/transcriptions") ? path : (path.isEmpty ? "v1/audio/transcriptions" : path + "/audio/transcriptions"))
        }
        return parts.url
    }
    var deadline:TimeInterval { provider == .selfHosted ? TimeInterval(min(max(timeoutSeconds ?? 180,30),1800)) : NativeSpeechService.deadline }
    /// Self-hosted `language` is zh / en / auto; auto (or blank) sends nothing.
    var sentLanguage:String { provider == .selfHosted && language.lowercased()=="auto" ? "":language }
    var credentialScope: String? { endpoint.map{provider.rawValue + "|" + $0.absoluteString} }
    var valid: Bool {
        endpoint != nil && !model.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty && model.utf8.count<=160 &&
        !model.unicodeScalars.contains(where:CharacterSet.controlCharacters.contains) && language.utf8.count<=16 &&
        language.utf8.allSatisfy{(65...90).contains($0)||(97...122).contains($0)||$0==45} &&
        ((try? JSONEncoder().encode(self).count) ?? 513)<=512
    }
}

enum NativeSpeechError: LocalizedError, Equatable {
    case configuration, configurationTooLong, unavailable, credential, changed, schemeChanged, invalidAudio, tooLong, audioTooLarge, responseTooLarge, invalidResponse, noSpeech, redirect, timeout, network, modelLoading, detail(String), http(Int)
    var errorDescription: String? {
        switch self {
        case .configuration:return nativeUI("语音服务地址或模型配置无效，请检查协议、HTTPS 地址和模型；自部署服务可以用 http。", "Invalid speech service settings. Check the protocol, HTTPS URL and model; a self-hosted service may use plain http.")
        case .configurationTooLong:return nativeUI("语音服务设置过长，请缩短 API 地址或模型名称；原配置保留。", "Speech settings are too long. Shorten the API URL or model name; previous settings are retained.")
        case .unavailable:return nativeUI("语音服务暂不可用。", "Speech service is unavailable.")
        case .credential:return nativeUI("独立语音 Key 无法读取或保存。请为当前服务重新填写，原配置保留。", "The independent speech Key could not be read or saved. Enter a Key for this service; previous settings are retained.")
        case .changed:return nativeUI("语音配置或当前页面已变化，本次操作已停止。", "Speech settings or the current page changed. This operation was stopped.")
        case .schemeChanged:return nativeUI("方案已在另一处更新，草稿未覆盖。请关闭后重新打开设置，再核对并保存。", "The scheme changed elsewhere; the draft did not overwrite it. Reopen settings, review and save again.")
        case .invalidAudio:return nativeUI("无法读取完整录音。原文件未改动。", "The complete recording could not be read. The original file is unchanged.")
        case .tooLong:return nativeUI("此阿里语音接口单次最多处理 5 分钟，请使用较短录音。未截断或发送音频。", "This Alibaba speech API accepts up to 5 minutes. Use a shorter recording; no truncated audio was sent.")
        case .audioTooLarge:return nativeUI("录音超出请求大小限制（阿里编码后 10MB，OpenAI WAV 25MB，ElevenLabs 约 50 分钟），未截断或发送。", "The recording exceeds the request limit (Alibaba: 10MB encoded; OpenAI: 25MB WAV; ElevenLabs: about 50 minutes). No truncated audio was sent.")
        case .responseTooLarge:return nativeUI("语音服务返回的内容超出读取限制，原录音保留。", "The speech response exceeded the read limit. The recording is retained.")
        case .invalidResponse:return nativeUI("语音服务未返回有效的完整转写，原录音保留。", "The service did not return a valid complete transcript. The recording is retained.")
        case .noSpeech:return nativeUI("未识别到文字，原录音保留。", "No speech was recognized. The recording is retained.")
        case .redirect:return nativeUI("语音服务要求跳转地址，已停止以保护 Key。请直接填写服务地址。", "The speech service requested a redirect. The request was stopped to protect your Key; enter the service URL directly.")
        case .timeout:return nativeUI("语音转写等待超时，原录音保留，可手动重试。", "Speech transcription timed out. The recording is retained; you can retry manually.")
        case .network:return nativeUI("无法连接语音服务，原录音保留。", "Could not connect to the speech service. The recording is retained.")
        case .detail(let message):return message
        case .modelLoading:return nativeUI("模型加载中，请稍后重试。", "The model is still loading. Try again shortly.")
        case .http(let status):return nativeUI("语音服务请求失败（HTTP \(status)），请检查独立 Key、模型和服务权限。", "Speech request failed (HTTP \(status)). Check its independent Key, model and service access.")
        }
    }
}

enum NativeSpeechService {
    struct Response: Sendable { let status: Int; let body: Data }
    typealias Transport = @Sendable (URLRequest) async throws -> Response
    static let responseLimit=2*1024*1024
    /// ElevenLabs takes long files; this cap only bounds the in-memory WAV (about 50 minutes of 16 kHz mono).
    static let elevenLabsAudioLimit=100_000_000
    static let deadline:TimeInterval=120
    /// This is an explicit, billable protocol check, not an ASR quality test.
    /// It uses one second of generated silence; no file or microphone is read.
    /// Official contracts checked 2026-10-09:
    /// https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create
    /// https://help.aliyun.com/en/model-studio/fun-asr-flash-recorded-speech-recognition-http-api
    static func testConnection(configuration:NativeSpeechConfiguration,key:String,
                               transport:@escaping Transport = {try await NativeSpeechHTTP.send($0,deadline:30)}) async throws {
        try Task.checkCancellation()
        if configuration.provider == .selfHosted {try await checkSelfHosted(configuration:configuration,key:key,transport:transport);return}
        var request=try Self.request(wav:connectionTestAudio(),configuration:configuration,key:key)
        request.timeoutInterval=30
        do {
            let response=try await transport(request)
            try Task.checkCancellation()
            guard response.body.count<=responseLimit else{throw NativeSpeechError.responseTooLarge}
            try requireSuccess(response.status,configuration.provider)
            // Empty text is valid for silence. HTML, generic 200 JSON, errors,
            // and another provider's response shape are not a successful check.
            _ = try responseText(response.body,provider:configuration.provider)
        } catch is CancellationError {throw CancellationError()}
        catch let error as NativeSpeechError {throw error}
        catch {if Task.isCancelled{throw CancellationError()};throw NativeSpeechError.network}
    }
    static func requireSuccess(_ status:Int,_ provider:NativeSpeechConfiguration.Provider)throws {
        guard (200..<300).contains(status) else{throw provider == .selfHosted && status==503 ? NativeSpeechError.modelLoading:NativeSpeechError.http(status)}
    }
    /// Self-hosted pre-checks: GET /health (no credentials sent) then GET /v1/models with the Key.
    /// A server without /health (404) is fine; the models call is then the check.
    /// Failures name what was requested (method and path, never the Key) and what went wrong.
    static func checkSelfHosted(configuration:NativeSpeechConfiguration,key:String,transport:Transport) async throws {
        guard configuration.valid,let endpoint=configuration.endpoint,var parts=URLComponents(url:endpoint,resolvingAgainstBaseURL:false) else{throw NativeSpeechError.configuration}
        guard validKey(key) else{throw NativeSpeechError.credential}
        var root=parts.path;if root.hasSuffix("/audio/transcriptions"){root.removeLast("/audio/transcriptions".count)}
        if root.hasSuffix("/v1"){root.removeLast(3)}
        func get(_ path:String,auth:Bool)throws->URLRequest {
            parts.path=root+path
            guard let url=parts.url else{throw NativeSpeechError.configuration}
            var r=URLRequest(url:url,cachePolicy:.reloadIgnoringLocalCacheData,timeoutInterval:30)
            r.httpMethod="GET";r.httpShouldHandleCookies=false;r.setValue("AI-Bro-Speech/1",forHTTPHeaderField:"User-Agent")
            if auth{r.setValue("Bearer " + key,forHTTPHeaderField:"Authorization")}
            return r
        }
        func call(_ request:URLRequest)async throws->Response {
            let label="GET "+(request.url?.path ?? "")
            do{let response=try await transport(request);try Task.checkCancellation()
                guard response.body.count<=responseLimit else{throw NativeSpeechError.responseTooLarge}
                return response
            }catch is CancellationError{throw CancellationError()}
            catch let error as NativeSpeechError {
                switch error {
                case .timeout:throw NativeSpeechError.detail(nativeUI("连接超时（\(label)）：服务器没有在 30 秒内响应。","Timed out (\(label)): the server did not answer within 30 seconds."))
                case .network:throw NativeSpeechError.detail(nativeUI("无法连接服务（\(label)）。请检查地址、端口和网络。","Could not reach the service (\(label)). Check the address, port and network."))
                case .detail(let message):throw NativeSpeechError.detail(message+" ["+label+"]")
                default:throw error
                }
            }
            catch{if Task.isCancelled{throw CancellationError()};throw NativeSpeechError.detail(nativeUI("无法连接服务（\(label)）。","Could not reach the service (\(label))."))}
        }
        let health=try await call(get("/health",auth:false))
        if (200..<300).contains(health.status),let body=(try? JSONSerialization.jsonObject(with:health.body)) as? [String:Any] {
            if body["loading"] as? Bool==true || body["ready"] as? Bool==false{throw NativeSpeechError.modelLoading}
        } else if health.status==503{throw NativeSpeechError.modelLoading}
        let models=try await call(get("/v1/models",auth:true))
        switch models.status {
        case 200..<300:return
        case 401,403:throw NativeSpeechError.detail(nativeUI("Key 无效或没有权限（HTTP \(models.status)，GET /v1/models）。","The Key is invalid or not allowed (HTTP \(models.status), GET /v1/models)."))
        case 404:throw NativeSpeechError.detail(nativeUI("服务上没有这个路径（HTTP 404，GET /v1/models）。请检查服务地址是否多写或少写了 /v1。","Path not found on the service (HTTP 404, GET /v1/models). Check whether the base URL has an extra or missing /v1."))
        case 503:throw NativeSpeechError.modelLoading
        default:throw NativeSpeechError.detail(nativeUI("服务返回 HTTP \(models.status)（GET /v1/models）。","The service answered HTTP \(models.status) (GET /v1/models)."))
        }
    }
    static func connectionTestAudio()->Data {
        let sampleCount=16000
        var wav=Data()
        func ascii(_ value:String){wav.append(contentsOf:value.utf8)}
        func u16(_ value:UInt16){var value=value.littleEndian;withUnsafeBytes(of:&value){wav.append(contentsOf:$0)}}
        func u32(_ value:UInt32){var value=value.littleEndian;withUnsafeBytes(of:&value){wav.append(contentsOf:$0)}}
        ascii("RIFF");u32(UInt32(sampleCount*2+36));ascii("WAVEfmt ");u32(16)
        u16(1);u16(1);u32(16000);u32(32000);u16(2);u16(16);ascii("data");u32(UInt32(sampleCount*2))
        wav.append(Data(repeating:0,count:sampleCount*2));return wav
    }
    /// Full recording only. Neither this service nor its failure path edits the
    /// source, starts a microphone, falls back to another provider, or retries.
    static func transcribe(fileURL:URL,configuration:NativeSpeechConfiguration,key:String,
                           transport customTransport:Transport? = nil) async throws -> String {
        let transport:Transport=customTransport ?? {[deadline=configuration.deadline] in try await NativeSpeechHTTP.send($0,deadline:deadline)}
        guard configuration.valid else{throw NativeSpeechError.configuration}
        guard validKey(key) else{throw NativeSpeechError.credential}
        try Task.checkCancellation()
        let work=Task.detached(priority:.userInitiated) {
            let wav=try normalize(fileURL: fileURL, provider: configuration.provider)
            try Task.checkCancellation()
            return try Self.request(wav:wav,configuration:configuration,key:key)
        }
        let request=try await withTaskCancellationHandler(operation:{try await work.value},onCancel:{work.cancel()})
        try Task.checkCancellation()
        do {
            let response=try await transport(request)
            try Task.checkCancellation()
            guard response.body.count<=responseLimit else{throw NativeSpeechError.responseTooLarge}
            try requireSuccess(response.status,configuration.provider)
            return try transcript(response.body,provider:configuration.provider)
        } catch is CancellationError {throw CancellationError()}
        catch let error as NativeSpeechError {throw error}
        catch {if Task.isCancelled{throw CancellationError()};throw NativeSpeechError.network}
    }
    static func validKey(_ key:String)->Bool {
        !key.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty && key.utf8.count<=16384 && !key.unicodeScalars.contains(where:CharacterSet.controlCharacters.contains)
    }
    static func request(wav:Data,configuration:NativeSpeechConfiguration,key:String)throws->URLRequest {
        guard configuration.valid,let endpoint=configuration.endpoint else{throw NativeSpeechError.configuration}
        guard validKey(key) else{throw NativeSpeechError.credential}
        var r=URLRequest(url:endpoint,cachePolicy:.reloadIgnoringLocalCacheData,timeoutInterval:configuration.deadline)
        r.httpMethod="POST";r.httpShouldHandleCookies=false;r.timeoutInterval=configuration.deadline
        if configuration.provider == .elevenLabs {r.setValue(key.trimmingCharacters(in:.whitespacesAndNewlines),forHTTPHeaderField:"xi-api-key")} else {r.setValue("Bearer " + key,forHTTPHeaderField:"Authorization")}
        r.setValue("AI-Bro-Speech/1",forHTTPHeaderField:"User-Agent")
        if configuration.provider == .aliyun {
            var parameters:[String:Any]=["format":"wav","sample_rate":"16000"]
            if !configuration.language.isEmpty{parameters["language_hints"]=[configuration.language]}
            guard ((wav.count+2)/3)*4+22<=10_000_000 else{throw NativeSpeechError.audioTooLarge}
            let payload:[String:Any]=["model":configuration.model,"input":["messages":[["role":"user","content":[["type":"input_audio","input_audio":["data":"data:audio/wav;base64,"+wav.base64EncodedString()]]]]]],"parameters":parameters]
            r.httpBody=try JSONSerialization.data(withJSONObject:payload,options:.sortedKeys)
            guard r.httpBody!.count<=10_000_000 else{throw NativeSpeechError.audioTooLarge}
            r.setValue("application/json",forHTTPHeaderField:"Content-Type");r.setValue("disable",forHTTPHeaderField:"X-DashScope-SSE")
        } else {
            guard wav.count<=(configuration.provider == .elevenLabs || configuration.provider == .selfHosted ? NativeSpeechService.elevenLabsAudioLimit:25_000_000) else{throw NativeSpeechError.audioTooLarge}
            let boundary="AIBroSpeech"+UUID().uuidString.replacingOccurrences(of:"-",with:"")
            var body=Data()
            func field(_ name:String,_ value:String){body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))}
            if configuration.provider == .elevenLabs {
                field("model_id",configuration.model)
                if !configuration.language.isEmpty{field("language_code",configuration.language)}
            } else {
                field("model",configuration.model);field("response_format","json")
                if !configuration.sentLanguage.isEmpty{field("language",configuration.sentLanguage)}
            }
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"recording.wav\"\r\nContent-Type: audio/wav\r\n\r\n".utf8));body.append(wav)
            body.append(Data("\r\n--\(boundary)--\r\n".utf8));r.httpBody=body
            r.setValue("multipart/form-data; boundary=\(boundary)",forHTTPHeaderField:"Content-Type")
        }
        return r
    }
    private static func responseText(_ data:Data,provider:NativeSpeechConfiguration.Provider)throws->String {
        guard data.count<=responseLimit,let body=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],body["error"]==nil,body["code"]==nil,body["detail"]==nil else{throw NativeSpeechError.invalidResponse}
        let text:String?
        if provider == .aliyun {text=(body["output"] as? [String:Any])?["text"] as? String}
        else {text=body["text"] as? String}
        guard let text else{throw NativeSpeechError.invalidResponse}
        return text
    }
    static func transcript(_ data:Data,provider:NativeSpeechConfiguration.Provider)throws->String {
        let text=try responseText(data,provider:provider)
        guard !text.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else{throw NativeSpeechError.noSpeech}
        return text
    }
    /// AVFoundation decoding, channel mixdown and resampling run in a detached
    /// worker. A bounded PCM loop checks cancellation; it never truncates input.
    static func normalize(fileURL:URL,provider:NativeSpeechConfiguration.Provider)throws->Data {
        try Task.checkCancellation()
        guard fileURL.isFileURL else{throw NativeSpeechError.invalidAudio}
        let values=try? fileURL.resourceValues(forKeys:[.isRegularFileKey,.isSymbolicLinkKey,.fileSizeKey])
        guard values?.isRegularFile==true,values?.isSymbolicLink != true,let bytes=values?.fileSize,bytes>0 else{throw NativeSpeechError.invalidAudio}
        guard bytes<=256*1024*1024 else{throw NativeSpeechError.audioTooLarge}
        let file:AVAudioFile
        do{file=try AVAudioFile(forReading:fileURL)}catch{throw NativeSpeechError.invalidAudio}
        let input=file.processingFormat,seconds=Double(file.length)/input.sampleRate
        guard input.sampleRate.isFinite,(8000...192000).contains(input.sampleRate),(1...8).contains(input.channelCount),file.length>0,seconds.isFinite else{throw NativeSpeechError.invalidAudio}
        if provider == .aliyun && seconds>300{throw NativeSpeechError.tooLong}
        let maxPCM=provider == .aliyun ? 9_600_000:(provider == .elevenLabs || provider == .selfHosted ? elevenLabsAudioLimit-44:24_999_956)
        guard seconds*32000<=Double(maxPCM) else{throw NativeSpeechError.audioTooLarge}
        guard let output=AVAudioFormat(commonFormat:.pcmFormatInt16,sampleRate:16000,channels:1,interleaved:true),let converter=AVAudioConverter(from:input,to:output),
              let source=AVAudioPCMBuffer(pcmFormat:input,frameCapacity:4096),let target=AVAudioPCMBuffer(pcmFormat:output,frameCapacity:4096) else{throw NativeSpeechError.invalidAudio}
        var pcm=Data(),ended=false,readFailure=false;let started=ProcessInfo.processInfo.systemUptime
        while !ended {
            try Task.checkCancellation();guard ProcessInfo.processInfo.systemUptime-started<60 else{throw NativeSpeechError.timeout}
            var conversionError:NSError?
            let status=converter.convert(to:target,error:&conversionError){requested,state in
                if Task.isCancelled{state.pointee = .endOfStream;return nil}
                if file.framePosition>=file.length{state.pointee = .endOfStream;return nil}
                do{try file.read(into:source,frameCount:min(requested,4096));state.pointee = .haveData;return source}
                catch{readFailure=true;state.pointee = .endOfStream;return nil}
            }
            guard !readFailure,conversionError==nil,status != .error else{throw NativeSpeechError.invalidAudio}
            if target.frameLength>0 {
                guard let samples=target.int16ChannelData?[0],pcm.count+Int(target.frameLength)*2<=maxPCM else{throw NativeSpeechError.audioTooLarge}
                pcm.append(UnsafeRawPointer(samples).assumingMemoryBound(to:UInt8.self),count:Int(target.frameLength)*2)
            }
            ended=status == .endOfStream
        }
        try Task.checkCancellation();guard !pcm.isEmpty,file.framePosition>=file.length else{throw NativeSpeechError.invalidAudio}
        var wav=Data()
        func ascii(_ s:String){wav.append(Data(s.utf8))}
        func u16(_ n:UInt16){var n=n.littleEndian;withUnsafeBytes(of:&n){wav.append(contentsOf:$0)}}
        func u32(_ n:UInt32){var n=n.littleEndian;withUnsafeBytes(of:&n){wav.append(contentsOf:$0)}}
        ascii("RIFF");u32(UInt32(pcm.count+36));ascii("WAVEfmt ");u32(16);u16(1);u16(1);u32(16000);u32(32000);u16(2);u16(16);ascii("data");u32(UInt32(pcm.count));wav.append(pcm);return wav
    }
}

/// A single ephemeral request; accumulation is capped before accepting each
/// chunk. Redirects, cookie storage and automatic credential use are disabled.
final class NativeSpeechHTTP: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock=NSLock()
    private var continuation:CheckedContinuation<NativeSpeechService.Response,Error>?
    private var session:URLSession?,task:URLSessionDataTask?,timer:DispatchWorkItem?
    private var bytes=Data(),status=0,finished=false
    static func send(_ request:URLRequest,configuration:URLSessionConfiguration?=nil,deadline:TimeInterval=NativeSpeechService.deadline) async throws->NativeSpeechService.Response {
        // App Transport Security refuses plain http to a public or LAN IP address (-1022), and the exemption table has no way to name one.
        // Plain http is only ever used by the self-hosted protocol, so it goes through Network.framework, which ATS does not govern; https keeps URLSession.
        if request.url?.scheme?.lowercased()=="http" {return try await NativePlainHTTP.send(request,deadline:deadline)}
        let owner=NativeSpeechHTTP()
        return try await withTaskCancellationHandler(operation:{
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation{owner.start(request,$0,configuration:configuration,deadline:deadline)}
        },onCancel:{owner.finish(.failure(CancellationError()))})
    }
    private func start(_ request:URLRequest,_ continuation:CheckedContinuation<NativeSpeechService.Response,Error>,configuration:URLSessionConfiguration?,deadline:TimeInterval) {
        lock.lock();guard !finished else{lock.unlock();continuation.resume(throwing:CancellationError());return}
        self.continuation=continuation
        let config=configuration ?? URLSessionConfiguration.ephemeral;config.httpCookieStorage=nil;config.httpShouldSetCookies=false;config.urlCredentialStorage=nil;config.urlCache=nil;config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest=deadline;config.timeoutIntervalForResource=deadline
        let queue=OperationQueue();queue.maxConcurrentOperationCount=1
        let session=URLSession(configuration:config,delegate:self,delegateQueue:queue);self.session=session
        let task=session.dataTask(with:request);self.task=task
        let timer=DispatchWorkItem{[weak self] in self?.finish(.failure(NativeSpeechError.timeout))};self.timer=timer
        lock.unlock();DispatchQueue.global().asyncAfter(deadline:.now()+deadline,execute:timer);task.resume()
    }
    private func finish(_ result:Result<NativeSpeechService.Response,Error>) {
        lock.lock();guard !finished else{lock.unlock();return};finished=true
        let continuation=self.continuation,session=self.session,timer=self.timer;self.continuation=nil;self.session=nil;self.task=nil;self.timer=nil;bytes.removeAll(keepingCapacity:false);lock.unlock()
        timer?.cancel();session?.invalidateAndCancel();continuation?.resume(with:result)
    }
    func urlSession(_ session:URLSession,task:URLSessionTask,willPerformHTTPRedirection response:HTTPURLResponse,newRequest request:URLRequest,completionHandler:@escaping(URLRequest?)->Void){completionHandler(nil);finish(.failure(NativeSpeechError.redirect))}
    func urlSession(_ session:URLSession,dataTask:URLSessionDataTask,didReceive response:URLResponse,completionHandler:@escaping(URLSession.ResponseDisposition)->Void){
        guard let response=response as? HTTPURLResponse else{completionHandler(.cancel);finish(.failure(NativeSpeechError.invalidResponse));return}
        guard response.expectedContentLength<=NativeSpeechService.responseLimit else{completionHandler(.cancel);finish(.failure(NativeSpeechError.responseTooLarge));return}
        lock.lock();status=response.statusCode;let active = !finished;lock.unlock();completionHandler(active ? .allow:.cancel)
    }
    func urlSession(_ session:URLSession,dataTask:URLSessionDataTask,didReceive data:Data){
        lock.lock();guard !finished else{lock.unlock();return};guard bytes.count+data.count<=NativeSpeechService.responseLimit else{lock.unlock();finish(.failure(NativeSpeechError.responseTooLarge));return};bytes.append(data);lock.unlock()
    }
    func urlSession(_ session:URLSession,task:URLSessionTask,didCompleteWithError error:Error?){
        if let error {finish(.failure((error as? URLError)?.code == .timedOut ? NativeSpeechError.timeout:NativeSpeechError.network));return}
        lock.lock();let response=NativeSpeechService.Response(status:status,body:bytes);lock.unlock();finish(.success(response))
    }
}

/// Plain-http client over Network.framework for the self-hosted protocol. One request per connection (Connection: close),
/// no redirects, no cookies, no ambient credentials, response size capped. It talks to the entered address directly (no system proxy),
/// which is what a service on an IP address or a local network needs.
final class NativePlainHTTP: @unchecked Sendable {
    private let lock=NSLock()
    private var connection:NWConnection?,continuation:CheckedContinuation<NativeSpeechService.Response,Error>?,timer:DispatchWorkItem?
    private var buffer=Data(),finished=false
    static func send(_ request:URLRequest,deadline:TimeInterval) async throws->NativeSpeechService.Response {
        let owner=NativePlainHTTP()
        return try await withTaskCancellationHandler(operation:{
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation{owner.start(request,$0,deadline)}
        },onCancel:{owner.finish(.failure(CancellationError()))})
    }
    static func serialize(_ request:URLRequest)throws->Data {
        guard let url=request.url,url.scheme?.lowercased()=="http",let host=url.host,!host.isEmpty else{throw NativeSpeechError.configuration}
        var path=url.path.isEmpty ? "/":url.path;if let query=url.query{path+="?"+query}
        let hostHeader=(host.contains(":") ? "["+host+"]":host)+(url.port.map{":\($0)"} ?? "")
        var head="\(request.httpMethod ?? "GET") \(path) HTTP/1.1\r\nHost: \(hostHeader)\r\nAccept: */*\r\nConnection: close\r\n"
        for (name,value) in request.allHTTPHeaderFields ?? [:] where !["host","content-length","connection"].contains(name.lowercased()) {
            guard !name.contains(where:{$0=="\r"||$0=="\n"||$0==":"}),!value.contains(where:{$0=="\r"||$0=="\n"}) else{throw NativeSpeechError.configuration}
            head+="\(name): \(value)\r\n"
        }
        let body=request.httpBody ?? Data()
        if !body.isEmpty || request.httpMethod=="POST"{head+="Content-Length: \(body.count)\r\n"}
        return Data((head+"\r\n").utf8)+body
    }
    /// nil while the response is incomplete; otherwise status and body. `closed` means the server has closed the connection.
    static func parse(_ data:Data,closed:Bool)throws->NativeSpeechService.Response? {
        guard let split=data.range(of:Data("\r\n\r\n".utf8)) else{if closed{throw NativeSpeechError.invalidResponse};return nil}
        let head=String(decoding:data[..<split.lowerBound],as:UTF8.self),lines=head.components(separatedBy:"\r\n")
        let first=lines[0].split(separator:" ")
        guard first.count>=2,first[0].hasPrefix("HTTP/"),let status=Int(first[1]) else{throw NativeSpeechError.invalidResponse}
        if (300..<400).contains(status){throw NativeSpeechError.redirect}
        var headers=[String:String]()
        for line in lines.dropFirst(){if let colon=line.firstIndex(of:":"){headers[line[..<colon].lowercased()]=line[line.index(after:colon)...].trimmingCharacters(in:.whitespaces)}}
        let rest=data[split.upperBound...]
        if (headers["transfer-encoding"] ?? "").lowercased().contains("chunked") {
            var out=Data(),cursor=rest.startIndex
            while true {
                guard let eol=rest.range(of:Data("\r\n".utf8),in:cursor..<rest.endIndex) else{if closed{throw NativeSpeechError.invalidResponse};return nil}
                let sizeText=String(decoding:rest[cursor..<eol.lowerBound],as:UTF8.self).split(separator:";").first.map(String.init) ?? ""
                guard let size=Int(sizeText.trimmingCharacters(in:.whitespaces),radix:16),size>=0 else{throw NativeSpeechError.invalidResponse}
                if size==0{return .init(status:status,body:out)}
                let start=eol.upperBound
                guard rest.distance(from:start,to:rest.endIndex)>=size+2 else{if closed{throw NativeSpeechError.invalidResponse};return nil}
                out.append(rest[start..<rest.index(start,offsetBy:size)]);cursor=rest.index(start,offsetBy:size+2)
                guard out.count<=NativeSpeechService.responseLimit else{throw NativeSpeechError.responseTooLarge}
            }
        }
        if let length=headers["content-length"].flatMap({Int($0)}) {
            guard length>=0,length<=NativeSpeechService.responseLimit else{throw NativeSpeechError.responseTooLarge}
            if rest.count>=length{return .init(status:status,body:Data(rest.prefix(length)))}
            if closed{throw NativeSpeechError.invalidResponse};return nil
        }
        guard closed else{return nil}
        guard rest.count<=NativeSpeechService.responseLimit else{throw NativeSpeechError.responseTooLarge}
        return .init(status:status,body:Data(rest))
    }
    private func start(_ request:URLRequest,_ continuation:CheckedContinuation<NativeSpeechService.Response,Error>,_ deadline:TimeInterval) {
        lock.lock()
        guard !finished else{lock.unlock();continuation.resume(throwing:CancellationError());return}
        self.continuation=continuation
        let payload:Data
        do{payload=try Self.serialize(request)}catch{lock.unlock();finish(.failure(error));return}
        let url=request.url!,port=NWEndpoint.Port(rawValue:UInt16(url.port ?? 80)) ?? 80
        let parameters=NWParameters.tcp;parameters.preferNoProxies=true
        let connection=NWConnection(host:NWEndpoint.Host(url.host!),port:port,using:parameters);self.connection=connection
        let timer=DispatchWorkItem{[weak self] in self?.finish(.failure(NativeSpeechError.timeout))};self.timer=timer
        lock.unlock()
        DispatchQueue.global().asyncAfter(deadline:.now()+deadline,execute:timer)
        connection.stateUpdateHandler={[weak self] state in
            switch state {
            case .ready:connection.send(content:payload,completion:.contentProcessed{[weak self] error in if let error{self?.finish(.failure(Self.describe(error)))}else{self?.receive()}})
            case .failed(let error),.waiting(let error):self?.finish(.failure(Self.describe(error)))
            default:break
            }
        }
        connection.start(queue:DispatchQueue(label:"aibro.plain-http"))
    }
    private func receive() {
        lock.lock();let connection=self.connection;lock.unlock()
        connection?.receive(minimumIncompleteLength:1,maximumLength:65536){[weak self] data,_,complete,error in
            guard let self else{return}
            self.lock.lock()
            if let data{self.buffer.append(data)}
            let snapshot=self.buffer;self.lock.unlock()
            if snapshot.count>NativeSpeechService.responseLimit+16384{self.finish(.failure(NativeSpeechError.responseTooLarge));return}
            do{
                if let response=try Self.parse(snapshot,closed:complete || error != nil){self.finish(.success(response));return}
            }catch{self.finish(.failure(error));return}
            if let error{self.finish(.failure(Self.describe(error)));return}
            if complete{self.finish(.failure(NativeSpeechError.invalidResponse));return}
            self.receive()
        }
    }
    static func describe(_ error:NWError)->NativeSpeechError {
        switch error {
        case .dns:return .detail(nativeUI("无法解析主机名。请检查服务地址。","The host name could not be resolved. Check the service address."))
        case .posix(let code):
            switch code {
            case .ECONNREFUSED:return .detail(nativeUI("连接被拒绝：该地址和端口上没有服务在监听。","Connection refused: nothing is listening on that address and port."))
            case .ETIMEDOUT:return .timeout
            case .EHOSTUNREACH,.ENETUNREACH,.ENETDOWN,.EHOSTDOWN:return .detail(nativeUI("找不到到该主机的网络路径（也可能是系统「本地网络」权限被拒绝）。","No network route to the host (or the system Local Network permission was denied)."))
            default:return .detail(nativeUI("网络错误（\(code)）。","Network error (\(code))."))
            }
        default:return .detail(nativeUI("网络错误。","Network error."))
        }
    }
    private func finish(_ result:Result<NativeSpeechService.Response,Error>) {
        lock.lock();guard !finished else{lock.unlock();return};finished=true
        let continuation=self.continuation,connection=self.connection,timer=self.timer;self.continuation=nil;self.connection=nil;self.timer=nil;buffer.removeAll(keepingCapacity:false);lock.unlock()
        timer?.cancel();connection?.stateUpdateHandler=nil;connection?.cancel();continuation?.resume(with:result)
    }
}
