import AppKit
import Combine
func nativeUI(_ zh:String,_ en:String)->String { en }
@MainActor final class OwnershipBoard: NativeQuickClipboardPasteboard {
 var changeCount=10; var types:[String]=[]; var writes=0; var reads=0
 func data(forType type:String)->Data? { reads += 1; return nil }
 func write(_ payload:NativeQuickClipboardPayload)->Bool { writes += 1; changeCount += 1; return true }
}
@MainActor final class OwnershipRead {
 var gate:CheckedContinuation<NativeQuickClipboardPayload,Error>?
 func read() async throws -> NativeQuickClipboardPayload { try await withCheckedThrowingContinuation { gate=$0 } }
 func finish(_ failure:Bool=false) { let current=gate; gate=nil; if failure {current?.resume(throwing:NativeQuickClipboardError.writeFailed)} else {current?.resume(returning:.init(kind:.text,data:Data("Fictional saved text".utf8)))} }
}
@main struct OwnershipChecks {
 @MainActor static func main() async throws {
  let base=URL(fileURLWithPath:CommandLine.arguments[1]); var checks=0
  func check(_ value:Bool,_ label:String) { precondition(value,label);checks += 1 }
  func wait(_ predicate:()->Bool) async {for _ in 0..<400 {if predicate(){return};try? await Task.sleep(nanoseconds:2_000_000)};precondition(predicate(),"timed out")}
  let archive=NativeQuickClipboardArchive(directory:base.appendingPathComponent("history"))
  _ = try await archive.setMode(.recording)
  _ = try await archive.capture(.init(kind:.text,data:Data("Fictional saved text".utf8)),gate:.init())
  _ = try await archive.setMode(.off)
  let board=OwnershipBoard(), reader=OwnershipRead()
  let store=NativeQuickClipboardStore(directory:base.appendingPathComponent("history"),pasteboard:board,schedulesPolling:false,payloadRead:{_ in try await reader.read()})
  store.setAvailable(true);store.setVisible(true);await wait{store.loaded && !store.items.isEmpty}
  let item=store.items[0]
  let first=Task{@MainActor in await store.copy(item)};await wait{reader.gate != nil};reader.finish();await first.value
  check(board.writes==1,"Explicit unchanged ownership copies once")
  let changed=Task{@MainActor in await store.copy(item)};await wait{reader.gate != nil};board.changeCount += 1;let newer=board.changeCount;reader.finish();await changed.value
  check(board.writes==1 && board.changeCount==newer,"A newer user clipboard must not be overwritten by a delayed read")
  check(store.notice?.contains("changed") == true && !store.busy,"Ownership loss is explained and action unlocks")
  let failed=Task{@MainActor in await store.copy(item)};await wait{reader.gate != nil};reader.finish(true);await failed.value
  check(store.error?.contains("Copy failed")==true,"Current failure remains actionable")
  let revoked=Task{@MainActor in await store.copy(item)};await wait{reader.gate != nil};store.setAvailable(false);reader.finish(true);await revoked.value
  check(store.error==nil && store.notice==nil && store.items.isEmpty,"A revoked delayed error must not reappear")
  store.setAvailable(true);await wait{!store.items.isEmpty}
  let retry=Task{@MainActor in await store.copy(store.items[0])};await wait{reader.gate != nil};reader.finish();await retry.value
  check(board.writes==2,"A fresh explicit copy after restoration works")
  check(board.reads==0 && store.mode == .off,"No clipboard payload is read and capture stays off")
  store.shutdown();print("PASS: \(checks) copy ownership checks")
 }
}
