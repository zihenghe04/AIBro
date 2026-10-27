import Foundation
import Network
func nativeUI(_ zh:String,_ en:String)->String{en}

/// A real loopback websocket server (Network.framework) that speaks the self-hosted stream protocol with placeholder content.
final class StreamServer:@unchecked Sendable {
    let listener:NWListener,queue=DispatchQueue(label:"stream-server")
    let lock=NSLock();var binaryBytes=0,stops=0
    init(){
        let parameters=NWParameters.tcp;parameters.defaultProtocolStack.applicationProtocols.insert(NWProtocolWebSocket.Options(),at:0)
        listener=try! NWListener(using:parameters,on:.any)
    }
    var port:UInt16{listener.port?.rawValue ?? 0}
    func start()async{
        listener.newConnectionHandler={[unowned self] c in self.serve(c)}
        await withCheckedContinuation{(k:CheckedContinuation<Void,Never>) in var done=false;listener.stateUpdateHandler={if case .ready=$0,!done{done=true;k.resume()}};listener.start(queue:queue)}
    }
    func reply(_ c:NWConnection,_ object:[String:Any]){
        let data=try! JSONSerialization.data(withJSONObject:object)
        c.send(content:data,contentContext:.init(identifier:"t",metadata:[NWProtocolWebSocket.Metadata(opcode:.text)]),isComplete:true,completion:.idempotent)
    }
    func serve(_ c:NWConnection){
        c.start(queue:queue);reply(c,["type":"ready","sample_rate":16000])
        func next(){c.receiveMessage{[unowned self] data,context,_,error in
            guard error==nil else{return}
            let meta=context?.protocolMetadata(definition:NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
            if meta?.opcode == .binary,let data{self.lock.lock();self.binaryBytes+=data.count;let total=self.binaryBytes;self.lock.unlock();self.reply(c,["type":"partial","text":"partial \(total)"])}
            if meta?.opcode == .text,let data,(try? JSONSerialization.jsonObject(with:data) as? [String:Any])?["type"] as? String=="stop"{self.lock.lock();self.stops+=1;self.lock.unlock();self.reply(c,["type":"final","text":"loopback final"])}
            next()
        }}
        next()
    }
}

@main struct PlainWebSocketChecks {
    @MainActor static func main() async throws {
        var checks=0,failures=0
        func check(_ value:Bool,_ text:String){checks+=1;if !value{failures+=1};print("\(value ? "PASS":"FAIL") \(text)")}
        let server=StreamServer();await server.start()
        var config=NativeQuickASRConfiguration();config.provider = .selfHosted;config.enabled=true;config.language="zh";config.serverURL="ws://127.0.0.1:\(server.port)"
        let request=try config.request(key:"synthetic-token")
        check(request.url?.scheme=="ws" && type(of:NativeQuickASRWebSocket.make(request)) == NativeQuickASRPlainWebSocket.self,"a ws:// request uses the Network.framework socket (URLSession's ATS cannot open a plain ws to an IP address)")
        check(type(of:NativeQuickASRWebSocket.make(URLRequest(url:URL(string:"wss://asr.example.com/stream")!))) == NativeQuickASRWebSocket.self,"wss:// stays on URLSession")
        let socket=NativeQuickASRWebSocket.make(request)
        func json(_ data:Data)->[String:Any]{(try? JSONSerialization.jsonObject(with:data) as? [String:Any]) ?? [:]}
        check(json(try await socket.receive())["type"] as? String=="ready","the server's ready frame arrives")
        try await socket.sendBinary(Data(repeating:1,count:3200))
        check(json(try await socket.receive())["text"] as? String=="partial 3200","a binary PCM frame is received by the server and answered with a partial")
        try await socket.ping()
        try await socket.send("{\"type\":\"stop\"}")
        let final=json(try await socket.receive())
        check(final["type"] as? String=="final" && final["text"] as? String=="loopback final","the stop text frame yields the final transcript")
        socket.close()
        // Whole session on real sockets.
        let session=NativeQuickRealtimeASRSession()
        try session.start(configuration:config,key:"synthetic-token")
        session.append(Data(repeating:2,count:6400))
        for _ in 0..<200{if session.snapshot.phase == .connected{break};try await Task.sleep(nanoseconds:20_000_000)}
        check(session.snapshot.phase == .connected,"the session connects over a plain ws://")
        let result=await session.finish()
        check(result.phase == .completed && result.finalized=="loopback final","the session finishes with the server's final text")
        server.lock.lock();let bytes=server.binaryBytes,stops=server.stops;server.lock.unlock()
        check(bytes>=9600 && stops>=1,"the server received all PCM and the stop frame")
        // Test-connection path.
        let probe=NativeQuickASRSettings();var saved:(NativeQuickASRConfiguration,String)?
        probe.configure(owner:URL(fileURLWithPath:"/synthetic-plain-ws"),access:NativeQuickASRSecretAccess(load:{saved?.0},read:{_ in saved?.1 ?? ""},save:{saved=($0,$1)},remove:{saved=nil}));probe.setAvailable(true)
        probe.testConnection(.init(configuration:config,key:"synthetic-token"))
        for _ in 0..<200{if !probe.testing{break};try await Task.sleep(nanoseconds:20_000_000)}
        check(probe.testMessage?.contains("Connected") == true,"the settings test connects to the plain ws:// service and sees ready")
        print("\(checks-failures)/\(checks) plain websocket checks; loopback only")
        if failures>0{exit(1)}
    }
}
