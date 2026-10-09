import Foundation
import AVFoundation

struct NativeSpeechConfiguration: Codable, Equatable, Sendable {
    enum Provider: String, Codable, CaseIterable, Sendable { case aliyun, openAI }
    var provider: Provider = .aliyun
    var baseURL = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"
    var model = "qwen-audio-3.0-asr-flash"
    var language = ""
    private static let aliPath = "/api/v1/services/aigc/multimodal-generation/generation"
    var endpoint: URL? {
        let raw=baseURL.trimmingCharacters(in:.whitespacesAndNewlines)
        guard raw.utf8.count<=2048,var parts=URLComponents(string:raw),parts.scheme?.lowercased()=="https",
              let host=parts.host,!host.isEmpty,parts.user==nil,parts.password==nil,parts.query==nil,parts.fragment==nil,
              !raw.unicodeScalars.contains(where:CharacterSet.controlCharacters.contains),
              parts.percentEncodedPath==parts.path, !parts.path.split(separator:"/").contains(where:{$0=="." || $0==".."}) else{return nil}
        parts.scheme="https";parts.host=host.lowercased();if parts.port==443{parts.port=nil}
        let path=parts.path.trimmingCharacters(in:CharacterSet(charactersIn:"/"))
        if provider == .aliyun {
            guard ["","compatible-mode/v1",String(Self.aliPath.dropFirst())].contains(path) else{return nil}
            parts.path=Self.aliPath
        } else {
            parts.path="/" + (path.hasSuffix("audio/transcriptions") ? path : (path.isEmpty ? "v1/audio/transcriptions" : path + "/audio/transcriptions"))
        }
        return parts.url
    }
    var credentialScope: String? { endpoint.map{provider.rawValue + "|" + $0.absoluteString} }
    var valid: Bool {
        endpoint != nil && !model.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty && model.utf8.count<=160 &&
        !model.unicodeScalars.contains(where:CharacterSet.controlCharacters.contains) && language.utf8.count<=16 &&
        language.utf8.allSatisfy{(65...90).contains($0)||(97...122).contains($0)||$0==45} &&
        ((try? JSONEncoder().encode(self).count) ?? 513)<=512
    }
}

enum NativeSpeechError: LocalizedError, Equatable {
    case configuration, configurationTooLong, unavailable, credential, changed, schemeChanged, invalidAudio, tooLong, audioTooLarge, responseTooLarge, invalidResponse, noSpeech, redirect, timeout, network, http(Int)
    var errorDescription: String? {
        switch self {
        case .configuration:return nativeUI("语音服务地址或模型配置无效，请检查协议、HTTPS 地址和模型。", "Invalid speech service settings. Check the protocol, HTTPS URL and model.")
        case .configurationTooLong:return nativeUI("语音服务设置过长，请缩短 API 地址或模型名称；原配置保留。", "Speech settings are too long. Shorten the API URL or model name; previous settings are retained.")
        case .unavailable:return nativeUI("语音服务暂不可用。", "Speech service is unavailable.")
        case .credential:return nativeUI("独立语音 Key 无法读取或保存。请为当前服务重新填写，原配置保留。", "The independent speech Key could not be read or saved. Enter a Key for this service; previous settings are retained.")
        case .changed:return nativeUI("语音配置或当前页面已变化，本次操作已停止。", "Speech settings or the current page changed. This operation was stopped.")
        case .schemeChanged:return nativeUI("方案已在另一处更新，草稿未覆盖。请关闭后重新打开设置，再核对并保存。", "The scheme changed elsewhere; the draft did not overwrite it. Reopen settings, review and save again.")
        case .invalidAudio:return nativeUI("无法读取完整录音。原文件未改动。", "The complete recording could not be read. The original file is unchanged.")
        case .tooLong:return nativeUI("此阿里语音接口单次最多处理 5 分钟，请使用较短录音。未截断或发送音频。", "This Alibaba speech API accepts up to 5 minutes. Use a shorter recording; no truncated audio was sent.")
        case .audioTooLarge:return nativeUI("录音超出请求大小限制（阿里编码后 10MB，OpenAI WAV 25MB），未截断或发送。", "The recording exceeds the request limit (Alibaba: 10MB encoded; OpenAI: 25MB WAV). No truncated audio was sent.")
        case .responseTooLarge:return nativeUI("语音服务返回的内容超出读取限制，原录音保留。", "The speech response exceeded the read limit. The recording is retained.")
        case .invalidResponse:return nativeUI("语音服务未返回有效的完整转写，原录音保留。", "The service did not return a valid complete transcript. The recording is retained.")
        case .noSpeech:return nativeUI("未识别到文字，原录音保留。", "No speech was recognized. The recording is retained.")
        case .redirect:return nativeUI("语音服务要求跳转地址，已停止以保护 Key。请直接填写服务地址。", "The speech service requested a redirect. The request was stopped to protect your Key; enter the service URL directly.")
        case .timeout:return nativeUI("语音转写等待超时，原录音保留，可手动重试。", "Speech transcription timed out. The recording is retained; you can retry manually.")
        case .network:return nativeUI("无法连接语音服务，原录音保留。", "Could not connect to the speech service. The recording is retained.")
        case .http(let status):return nativeUI("语音服务请求失败（HTTP \(status)），请检查独立 Key、模型和服务权限。", "Speech request failed (HTTP \(status)). Check its independent Key, model and service access.")
        }
    }
}

enum NativeSpeechService {
    struct Response: Sendable { let status: Int; let body: Data }
    typealias Transport = @Sendable (URLRequest) async throws -> Response
    static let responseLimit=2*1024*1024
    static let deadline:TimeInterval=120
    /// This is an explicit, billable protocol check, not an ASR quality test.
    /// It uses one second of generated silence; no file or microphone is read.
    /// Official contracts checked 2026-10-09:
    /// https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create
    /// https://help.aliyun.com/en/model-studio/fun-asr-flash-recorded-speech-recognition-http-api
    static func testConnection(configuration:NativeSpeechConfiguration,key:String,
                               transport:@escaping Transport = {try await NativeSpeechHTTP.send($0,deadline:30)}) async throws {
        try Task.checkCancellation()
        var request=try Self.request(wav:connectionTestAudio(),configuration:configuration,key:key)
        request.timeoutInterval=30
        do {
            let response=try await transport(request)
            try Task.checkCancellation()
            guard response.body.count<=responseLimit else{throw NativeSpeechError.responseTooLarge}
            guard (200..<300).contains(response.status) else{throw NativeSpeechError.http(response.status)}
            // Empty text is valid for silence. HTML, generic 200 JSON, errors,
            // and another provider's response shape are not a successful check.
            _ = try responseText(response.body,provider:configuration.provider)
        } catch is CancellationError {throw CancellationError()}
        catch let error as NativeSpeechError {throw error}
        catch {if Task.isCancelled{throw CancellationError()};throw NativeSpeechError.network}
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
                           transport:@escaping Transport = {try await NativeSpeechHTTP.send($0)}) async throws -> String {
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
            guard (200..<300).contains(response.status) else{throw NativeSpeechError.http(response.status)}
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
        var r=URLRequest(url:endpoint,cachePolicy:.reloadIgnoringLocalCacheData,timeoutInterval:deadline)
        r.httpMethod="POST";r.httpShouldHandleCookies=false;r.setValue("Bearer " + key,forHTTPHeaderField:"Authorization")
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
            guard wav.count<=25_000_000 else{throw NativeSpeechError.audioTooLarge}
            let boundary="AIBroSpeech"+UUID().uuidString.replacingOccurrences(of:"-",with:"")
            var body=Data()
            func field(_ name:String,_ value:String){body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))}
            field("model",configuration.model);field("response_format","json")
            if !configuration.language.isEmpty{field("language",configuration.language)}
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"recording.wav\"\r\nContent-Type: audio/wav\r\n\r\n".utf8));body.append(wav)
            body.append(Data("\r\n--\(boundary)--\r\n".utf8));r.httpBody=body
            r.setValue("multipart/form-data; boundary=\(boundary)",forHTTPHeaderField:"Content-Type")
        }
        return r
    }
    private static func responseText(_ data:Data,provider:NativeSpeechConfiguration.Provider)throws->String {
        guard data.count<=responseLimit,let body=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],body["error"]==nil,body["code"]==nil else{throw NativeSpeechError.invalidResponse}
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
        let maxPCM=provider == .aliyun ? 9_600_000:24_999_956
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
