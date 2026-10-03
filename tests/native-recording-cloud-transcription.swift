import Foundation
import AppKit
import Combine
func nativeUI(_ zh:String,_ en:String)->String {en}
struct CheckFailure:Error {let message:String}
actor Gate<Value:Sendable> {
    var continuation:CheckedContinuation<Value,Error>?
    var calls=0
    func wait() async throws->Value {calls+=1;return try await withCheckedThrowingContinuation{continuation?.resume(throwing:CancellationError());continuation=$0}}
    func resolve(_ value:Value){continuation?.resume(returning:value);continuation=nil}
    func reject(){continuation?.resume(throwing:NativeSpeechError.network);continuation=nil}
}
actor SequenceService {
    let old:Gate<String>,new:Gate<String>;var calls=0
    init(old:Gate<String>,new:Gate<String>){self.old=old;self.new=new}
    func call()async throws->String{calls+=1;return try await (calls==1 ? old:new).wait()}
}
actor FakeSecret {
    var config:NativeSpeechConfiguration? = .init()
    var writes=0
    func load()->NativeSpeechConfiguration?{config}
    func save(_ c:NativeSpeechConfiguration){config=c;writes+=1}
    func remove(){config=nil;writes+=1}
    nonisolated var access:NativeSpeechSecretAccess {.init(load:{await self.load()},read:{_ in "SYNTHETIC-KEY"},save:{c,_ in await self.save(c)},remove:{await self.remove()})}
}
final class WriteControl {var fail=false}
@MainActor final class Fixture {
    let root:URL,id=UUID().uuidString.lowercased(),secret=FakeSecret(),gate=Gate<String>(),writes=WriteControl()
    let store:NativeQuickRecordingStore
    let original:NativeQuickRecordingItem
    init(text:String="",state:String?=nil)throws {
        root=FileManager.default.temporaryDirectory.appendingPathComponent("aibro-cloud-"+UUID().uuidString,isDirectory:true)
        let folder=root.appendingPathComponent("quick-recordings",isDirectory:true)
        var archive=try NativeQuickRecordingArchive(directory:folder)
        original = .init(id:id,title:"Synthetic class recording",createdAt:Date(timeIntervalSince1970:1234),duration:3,transcript:text,state:"ready",category:"Course",transcriptionState:state)
        try archive.replace([original]);try Data("synthetic audio; service injection only".utf8).write(to:archive.audioURL(for:id,mustExist:false))
        let gate=self.gate,writes=self.writes
        store=NativeQuickRecordingStore(write:{data,url in if writes.fail{throw CocoaError(.fileWriteOutOfSpace)};try NativeQuickRecordingArchive.durableWrite(data,url)},cloudTranscribe:{_,_,_ in try await gate.wait()})
        store.configure(directory:root);store.configureSpeech(owner:root,access:secret.access);store.setVisible(true)
    }
    func waitReady() async {for _ in 0..<200 {if !store.speechSettings.busy{return};try? await Task.sleep(for:.milliseconds(2))}}
    func waitService() async {for _ in 0..<200 {if await gate.calls>0{return};try? await Task.sleep(for:.milliseconds(2))}}
    func cleanup(){store.shutdown();try? FileManager.default.removeItem(at:root)}
    func persisted()throws->NativeQuickRecordingItem {try NativeQuickRecordingArchive(directory:root.appendingPathComponent("quick-recordings")).items[0]}
}
@main struct Checks {
 @MainActor static func main() async throws {
  var count=0
  func check(_ value:Bool,_ message:String)throws{guard value else{throw CheckFailure(message:message)};count+=1;print("PASS \(message)")}
  do {
   let f=try Fixture();defer{f.cleanup()};await f.waitReady()
   try check(f.store.speechSettings.configured && f.store.speechSettings.configuration.baseURL.contains("token-plan.cn-beijing.maas.aliyuncs.com"),"independent default TokenPlan configuration loads")
   f.store.beginSpeechSettings();try check(f.store.hasEditor && !f.store.flushForQuit(),"settings draft participates in host navigation and quit protection")
   try check(await f.gate.calls==0,"opening settings never uploads audio")
   f.store.cancelSpeechSettings();let t=Task{await f.store.transcribeCloud(id:f.id)};await f.waitService()
   try check(f.store.isCloudTranscribing && f.store.transcribingID==f.id && f.store.items[0]==f.original,"explicit action waits without changing durable recording")
   await f.gate.resolve("Synthetic recognized text");await t.value
   let saved=try f.persisted()
   try check(saved.id==f.id && saved.title==f.original.title && saved.category==f.original.category && saved.transcript=="Synthetic recognized text" && saved.transcriptionState=="cloud","success updates same recording atomically and persists transcript")
   try check(try Data(contentsOf:f.store.fileURL(id:f.id)!)==Data("synthetic audio; service injection only".utf8),"original audio bytes remain unchanged")
   try check(!f.store.isCloudTranscribing && f.store.transcribingID==nil && f.store.receipt != nil,"successful cloud request clears in-flight state and reports saving")
  }
  for action in ["cancel","hide","private","owner","edit","settings"] {
   let f=try Fixture(text:"Old partial",state:"partial");await f.waitReady();let t=Task{await f.store.transcribeCloud(id:f.id)};await f.waitService()
   switch action {
    case "cancel":f.store.cancelTranscription()
    case "hide":f.store.setVisible(false);f.store.setVisible(true)
    case "private":f.store.setAvailable(false);f.store.setAvailable(true)
    case "owner":f.store.configure(directory:f.root.appendingPathComponent("other"))
    case "edit":f.store.saveTranscript(id:f.id,text:"User edited text")
    default:var config=f.store.speechSettings.configuration;config.model="new-model";_ = await f.store.speechSettings.save(config,key:"SYNTHETIC-NEW-KEY")
   }
   await f.gate.resolve("LATE MUST NOT REPLACE");await t.value
   try check(try f.persisted().transcript == (action=="edit" ? "User edited text":"Old partial"),"\(action) rejects late cloud result without replacing stored text")
   if action=="private" || action=="hide" {try check(f.store.receipt==nil && f.store.error==nil,"\(action) late callback does not publish success or error")}
   f.cleanup()
  }
  do {
   let f=try Fixture(text:"",state:"edited");defer{f.cleanup()};await f.waitReady();await f.store.transcribeCloud(id:f.id)
   try check(await f.gate.calls==0,"manually cleared transcript remains protected from cloud replacement")
  }
  do {
   let f=try Fixture(text:"Old partial",state:"partial");defer{f.cleanup()};await f.waitReady();let t=Task{await f.store.transcribeCloud(id:f.id)};await f.waitService();await f.gate.reject();await t.value
   try check(try f.persisted()==f.original && f.store.error==NativeSpeechError.network.localizedDescription,"service failure retains audio and existing transcript with safe error")
  }
  do {
   let f=try Fixture(text:"Old partial",state:"partial");defer{f.cleanup()};await f.waitReady();let t=Task{await f.store.transcribeCloud(id:f.id)};await f.waitService();f.writes.fail=true;await f.gate.resolve("Recovered cloud result");await t.value
   try check(try f.persisted().transcript=="Old partial" && f.store.transcriptDrafts[f.id]=="Recovered cloud result" && !f.store.flushForQuit(),"failed commit preserves durable text and recoverable generated draft")
   f.writes.fail=false;f.store.retryTranscript(id:f.id)
   try check(try f.persisted().transcript=="Recovered cloud result" && f.store.transcriptDrafts[f.id]==nil,"retry saves retained result without repeating cloud request")
  }
  do {
   let f=try Fixture();defer{f.cleanup()};await f.waitReady();f.store.beginSpeechSettings();var draft=f.store.speechSettingsDraft!;draft.key="MEMORY-ONLY-DRAFT";f.store.updateSpeechSettings(draft)
   f.store.setAvailable(false);try check(f.store.speechSettingsDraft==draft && !f.store.flushForQuit(),"privacy hides settings but preserves unsaved in-memory key draft")
   f.store.setAvailable(true);await f.waitReady();f.store.setVisible(true)
   try check(await f.store.saveSpeechSettings() && f.store.speechSettingsDraft==nil,"explicit settings save completes and clears only matching draft")
   try check(await f.gate.calls==0,"saving service settings does not transcribe")
  }
  do {
   let f=try Fixture();defer{f.cleanup()};await f.waitReady()
   let readGate=Gate<String>()
   // A fresh Store uses a credential read that ignores cancellation to exercise
   // actual connection-await cancellation before the network service is called.
   let service=Gate<String>();let store=NativeQuickRecordingStore(cloudTranscribe:{_,_,_ in try await service.wait()})
   store.configure(directory:f.root);store.configureSpeech(owner:f.root,access:.init(load:{.init()},read:{_ in try await readGate.wait()},save:{_,_ in},remove:{}));store.setVisible(true)
   for _ in 0..<100 {if !store.speechSettings.busy{break};try? await Task.sleep(for:.milliseconds(2))}
   let t=Task{await store.transcribeCloud(id:f.id)}
   for _ in 0..<100 {if await readGate.calls>0{break};try? await Task.sleep(for:.milliseconds(2))}
   store.cancelTranscription();await readGate.resolve("LATE-KEY");await t.value
   try check(await service.calls==0 && store.transcribingID==nil,"cancelled credential read cannot dispatch an audio request")
  }
  do {
   let f=try Fixture();defer{f.cleanup()};let loadGate=Gate<NativeSpeechConfiguration?>()
   let store=NativeQuickRecordingStore(cloudTranscribe:{_,_,_ in "unused"})
   var notifications=0;let observer=store.objectWillChange.sink{notifications+=1}
   store.configure(directory:f.root)
   store.configureSpeech(owner:f.root,access:.init(load:{try await loadGate.wait()},read:{_ in "SYNTHETIC"},save:{_,_ in},remove:{}));store.setVisible(true)
   // configure starts a load, availability restarts it; resolve only after both
   // scheduling turns so this fixture does not hide a checked continuation.
   try? await Task.sleep(for:.milliseconds(10))
   store.beginSpeechSettings()
   try check(store.speechSettings.busy && store.speechSettingsDraft==nil,"slow settings load cannot initialize a default draft over saved configuration")
   var loaded=NativeSpeechConfiguration();loaded.model="saved-custom-model"
   let before=notifications;await loadGate.resolve(loaded)
   for _ in 0..<100 {if !store.speechSettings.busy{break};try? await Task.sleep(for:.milliseconds(2))}
   store.beginSpeechSettings()
   try check(store.speechSettingsDraft?.configuration.model=="saved-custom-model","opening after load uses the saved model instead of defaults")
   try check(notifications>before,"nested asynchronous settings publish invalidates actual Store observers")
   observer.cancel()
  }
  do {
   let f=try Fixture();defer{f.cleanup()};let oldGate=Gate<String>(),newGate=Gate<String>()
   let sequence=SequenceService(old:oldGate,new:newGate)
   let store=NativeQuickRecordingStore(cloudTranscribe:{_,_,_ in try await sequence.call()})
   store.configure(directory:f.root);store.configureSpeech(owner:f.root,access:f.secret.access);store.setVisible(true)
   for _ in 0..<100 {if !store.speechSettings.busy{break};try? await Task.sleep(for:.milliseconds(2))}
   let old=Task{await store.transcribeCloud(id:f.id)}
   for _ in 0..<100 {if await oldGate.calls>0{break};try? await Task.sleep(for:.milliseconds(2))}
   store.cancelTranscription();let next=Task{await store.transcribeCloud(id:f.id)}
   for _ in 0..<100 {if await newGate.calls>0{break};try? await Task.sleep(for:.milliseconds(2))}
   await oldGate.resolve("Old result");await old.value
   try check(store.isCloudTranscribing && store.transcribingID==f.id && store.items[0].transcript.isEmpty,"cancelled old request cannot clear newer request state or write old result")
   await newGate.resolve("New result");await next.value
   try check(try f.persisted().transcript=="New result" && !store.isCloudTranscribing,"newer request keeps its own successful receipt")
  }
  print("\(count) recording-cloud integration checks passed; synthetic audio/services only")
 }
}
