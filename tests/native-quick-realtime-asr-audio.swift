import AppKit
import AVFoundation

final class AudioEvidence: @unchecked Sendable {
    private let lock=NSLock()
    private var payload=Data(), localFailures=0, streamFailures=0, writeCount=0, active=false
    let gate=DispatchSemaphore(value:0)
    func append(_ value:Data){lock.lock();payload.append(value);lock.unlock()}
    var data:Data{lock.lock();defer{lock.unlock()};return payload}
    func localFailed(){lock.lock();localFailures += 1;lock.unlock()}
    func streamFailed(){lock.lock();streamFailures += 1;lock.unlock()}
    var failures:(Int,Int){lock.lock();defer{lock.unlock()};return(localFailures,streamFailures)}
    func written()->Int{lock.lock();defer{lock.unlock()};writeCount += 1;return writeCount}
    func entered(){lock.lock();active=true;lock.unlock()}
    var isActive:Bool{lock.lock();defer{lock.unlock()};return active}
}
@main struct RealtimeAudioChecks {
 @MainActor static func main() async throws {
    let root=URL(fileURLWithPath:CommandLine.arguments[1]);var checks=0
    func check(_ ok:Bool,_ text:String){precondition(ok,text);checks += 1;print("PASS \(checks): \(text)")}
    func wait(_ test:()->Bool) async {for _ in 0..<2000{if test(){return};try?await Task.sleep(nanoseconds:1_000_000)};precondition(test(),"Audio fixture timeout")}
    func format(_ rate:Double=48000,_ channels:AVAudioChannelCount=2,_ interleaved:Bool=false)->AVAudioFormat{AVAudioFormat(commonFormat:.pcmFormatFloat32,sampleRate:rate,channels:channels,interleaved:interleaved)!}
    func wave(_ f:AVAudioFormat,_ start:Int,_ frames:Int)->AVAudioPCMBuffer{
        let b=AVAudioPCMBuffer(pcmFormat:f,frameCapacity:AVAudioFrameCount(frames))!;b.frameLength=AVAudioFrameCount(frames)
        for frame in 0..<frames {let v=Float(sin(2*Double.pi*440*Double(start+frame)/f.sampleRate)*0.35)
            for channel in 0..<Int(f.channelCount) {if f.isInterleaved{b.floatChannelData![0][frame*Int(f.channelCount)+channel]=v}else{b.floatChannelData![channel][frame]=v}}
        };return b
    }
    func decode(_ url:URL)throws->(Double,Double){
        let f=try AVAudioFile(forReading:url), b=AVAudioPCMBuffer(pcmFormat:f.processingFormat,frameCapacity:AVAudioFrameCount(f.length))!;try f.read(into:b)
        let samples=b.floatChannelData![0];var sum=0.0
        for i in 0..<Int(b.frameLength){sum+=Double(samples[i]*samples[i])}
        return(Double(f.length)/f.processingFormat.sampleRate,sqrt(sum/Double(max(1,b.frameLength))))
    }
    do {
        let f=format(), e=AudioEvidence(), url=root.appendingPathComponent("synthetic-pause.m4a")
        let p=try NativeQuickRealtimeASRAudioPipeline(url:url,inputFormat:f,onPCM:{e.append($0)},onFailure:{e.localFailed()},onStreamFailure:{e.streamFailed()})
        for i in 0..<10{p.enqueue(wave(f,i*4800,4800))};await wait{p.snapshot.duration>0.98}
        check(p.snapshot.level>0.1 && p.snapshot.level<0.5,"Meter reports energy from actual synthesized samples")
        p.setPaused(true);for i in 0..<10{p.enqueue(wave(f,i*4800,4800))}
        check(p.snapshot.level==0,"Paused state immediately publishes zero meter")
        p.setPaused(false);for i in 10..<20{p.enqueue(wave(f,i*4800,4800))}
        let receipt=await p.finish(), decoded=try decode(url)
        check(!receipt.interrupted && !receipt.streamInterrupted && e.failures == (0,0),"Continuous conversion, pause and resume finish without recording or stream failure")
        check(abs(receipt.duration-2)<0.003 && abs(decoded.0-2)<0.03,"M4A includes both active seconds, excludes paused input, and is readable after stop")
        check(receipt.bytes>1000 && decoded.1>0.1,"Finalized AAC contains audible synthesized content, not a header-only placeholder")
        let mode=(try FileManager.default.attributesOfItem(atPath:url.path)[.posixPermissions] as! NSNumber).intValue
        check(mode==0o600,"Local audio uses owner-only file permissions")
        let data=e.data
        check(abs(Double(data.count)/32000-2)<0.01 && data.count%2==0,"Streaming output has 16 kHz mono PCM16 byte duration across chunk boundaries")
        let ints=stride(from:0,to:data.count,by:2).map{Int16(bitPattern:UInt16(data[$0]) | UInt16(data[$0+1])<<8)}
        let peak=ints.map{abs(Int($0))}.max() ?? 0
        let crossings=zip(ints,ints.dropFirst()).filter{$0.0<0 && $0.1>=0}.count
        check(peak>5000 && peak<18000 && (860...900).contains(crossings),"PCM16 little-endian waveform preserves plausible amplitude and 440 Hz frequency")
        let again=await p.finish()
        check(again.duration==receipt.duration && again.bytes==receipt.bytes,"Repeated stop is idempotent and never rewrites or appends audio")
    }
    do {
        let f=format(44100,2,true),e=AudioEvidence(),url=root.appendingPathComponent("synthetic-interleaved.m4a")
        let p=try NativeQuickRealtimeASRAudioPipeline(url:url,inputFormat:f,onPCM:{e.append($0)},onFailure:{e.localFailed()})
        for i in 0..<10{p.enqueue(wave(f,i*4410,4410))}
        let r=await p.finish(), decoded=try decode(url)
        check(!r.interrupted && abs(decoded.0-1)<0.03 && decoded.1>0.1,"Interleaved 44.1 kHz stereo also copies and downmixes into valid local mono AAC")
        check(abs(Double(e.data.count)/32000-1)<0.01,"44.1 kHz input is resampled rather than mislabeled as 16 kHz")
    }
    do {
        let f=format(),e=AudioEvidence(),url=root.appendingPathComponent("slow-stream.m4a")
        let p=try NativeQuickRealtimeASRAudioPipeline(url:url,inputFormat:f,onPCM:{data in e.entered();_ = e.gate.wait(timeout:.now()+3);e.append(data)},onFailure:{e.localFailed()},onStreamFailure:{e.streamFailed()})
        for i in 0..<10{p.enqueue(wave(f,i*4800,4800))};await wait{e.isActive && p.snapshot.duration>0.98}
        check(e.data.isEmpty && p.snapshot.duration>0.98,"Blocked PCM consumer cannot stop local file worker from writing the full second")
        let start=Date(),r=await p.finish(),decoded=try decode(url)
        check(Date().timeIntervalSince(start)<1.2 && r.streamInterrupted && !r.interrupted && abs(decoded.0-1)<0.03,"Stop closes complete local audio and bounds waiting for a stalled stream consumer")
        await wait{e.failures.1==1};check(e.failures.0==0,"Stream backlog reports a transcript gap without claiming local recording failure")
        e.gate.signal()
    }
    do {
        let f=format(),e=AudioEvidence(),url=root.appendingPathComponent("retained-write-failure.m4a")
        let p=try NativeQuickRealtimeASRAudioPipeline(url:url,inputFormat:f,onPCM:{e.append($0)},onFailure:{e.localFailed()},write:{file,buffer in
            if e.written()==2{throw CocoaError(.fileWriteOutOfSpace)};try file.write(from:buffer)
        })
        for i in 0..<5{p.enqueue(wave(f,i*4800,4800))};let r=await p.finish();await wait{e.failures.0==1}
        let decoded=try decode(url)
        check(r.interrupted && r.bytes>0 && decoded.0>0 && decoded.0<0.3,"Injected disk failure preserves a readable written prefix and marks interruption")
        check(e.failures.0==1,"Local write failure is reported once instead of silently dropping later audio")
    }
    do {
        let f=format(),e=AudioEvidence(),url=root.appendingPathComponent("retained-overflow.m4a")
        let p=try NativeQuickRealtimeASRAudioPipeline(url:url,inputFormat:f,bufferCount:2,onPCM:{e.append($0)},onFailure:{e.localFailed()},write:{file,buffer in
            if e.written()==1{e.entered();_ = e.gate.wait(timeout:.now()+3)};try file.write(from:buffer)
        })
        p.enqueue(wave(f,0,4800));await wait{e.isActive}
        let recycled=wave(f,4800,4800);p.enqueue(recycled)
        for channel in 0..<2 {recycled.floatChannelData![channel].initialize(repeating:0,count:4800)}
        p.enqueue(wave(f,9600,4800))
        await wait{e.failures.0==1};check(p.snapshot.interrupted,"Exhausted fixed tap pool explicitly interrupts rather than silently losing a local buffer")
        e.gate.signal();let r=await p.finish(),decoded=try decode(url)
        check(r.interrupted && decoded.0>0.15 && decoded.0<0.25,"Already accepted buffers drain into the retained file after pool overload")
        check(decoded.1>0.22,"Tap-owned copies survive hardware-style reuse and mutation of the source buffer")
    }
    do {
        let f=format(),e=AudioEvidence(),url=root.appendingPathComponent("protected-existing.m4a"),before=Data("Existing synthetic original".utf8)
        try before.write(to:url)
        do {_ = try NativeQuickRealtimeASRAudioPipeline(url:url,inputFormat:f,onPCM:{e.append($0)},onFailure:{e.localFailed()});preconditionFailure("Must not overwrite")}
        catch{check(try Data(contentsOf:url)==before,"Starting at an existing URL never overwrites its original bytes")}
    }
    print("PASS: \(checks) synthetic audio checks; no AVAudioEngine initialization, microphone, permission, network, or actual playback")
 }
}
