import AppKit
import AVFoundation
import SwiftUI
import ImageIO
import UniformTypeIdentifiers
func nativeUI(_ zh:String,_ en:String)->String {en}
final class FakeMirrorCamera: NativeQuickMirrorCameraDriving {
    var session: AVCaptureSession? {nil}
    var list:[NativeQuickMirrorDevice]=[]
    var attempts:[String]=[]
    var stopped=0
    var replies:[(@Sendable(NativeQuickMirrorFrameResult)->Void)]=[]
    var interruption:(@Sendable()->Void)?
    func devices() async -> [NativeQuickMirrorDevice] {list}
    func start(deviceID:String,completion:@escaping @Sendable(NativeQuickMirrorFrameResult)->Void,interrupted:@escaping @Sendable()->Void) {attempts.append(deviceID);replies.append(completion);interruption=interrupted}
    func stop(){stopped += 1}
}
final class TestReplies: @unchecked Sendable {var values:[NativeQuickMirrorFrameResult]=[]}
actor CoverGate {
    var replies:[CheckedContinuation<Data,Error>]=[]
    func decode() async throws -> Data { try await withCheckedThrowingContinuation { replies.append($0) } }
    var count:Int {replies.count}
    func resolve(_ i:Int,data:Data?) {if let data{replies[i].resume(returning:data)}else{replies[i].resume(throwing:CocoaError(.fileReadCorruptFile))}}
}
@main struct MirrorChecks {
    @MainActor static var count=0
    @MainActor static func check(_ value:@autoclosure()->Bool,_ message:String){precondition(value(),message);count += 1;print("PASS \(count): \(message)");fflush(stdout)}
    @MainActor static func wait(line:Int = #line,_ predicate:()->Bool) async {for _ in 0..<1000{if predicate(){return};try? await Task.sleep(nanoseconds:1_000_000)};preconditionFailure("wait timeout at \(line)")}
    @MainActor static func main() async throws {
        let dir=URL(fileURLWithPath:CommandLine.arguments[1]).appendingPathComponent("mirror",isDirectory:true)
        let built=NativeQuickMirrorDevice(id:"built",name:"Synthetic built-in",kind:.builtIn)
        let ext=NativeQuickMirrorDevice(id:"external",name:"Synthetic external",kind:.external)
        let virtual=NativeQuickMirrorDevice(id:"virtual",name:"Synthetic virtual",kind:.virtual)
        let ranked=NativeQuickMirrorDevice.rank([virtual,ext,built,built],preferred:nil)
        check(ranked.map(\.id)==["built","external","virtual"],"real-device ranking deduplicates and leaves virtual last")
        check(NativeQuickMirrorDevice.rank(ranked,preferred:"external").first?.id=="external","explicit preferred camera wins without changing fallback order")
        let gate=NativeQuickMirrorFrameGate(),id=UUID(),other=UUID(),replies=TestReplies()
        gate.begin(id){replies.values.append($0)};check(gate.finish(id,.timedOut),"3s driver timeout completes only its pending attempt")
        check(!gate.finish(id,.frame)&&replies.values == [.timedOut],"late first frame cannot turn timeout into a success")
        gate.begin(other){replies.values.append($0)};check(!gate.finish(id,.frame),"old output delegate cannot acknowledge newer device")
        gate.cancel();check(replies.values == [.timedOut,.cancelled] && !gate.current(other),"stop revokes attempt and resolves pending continuation")
        let fake=FakeMirrorCamera();fake.list=[virtual,ext,built]
        var asks=0,changes:(@MainActor()->Void)?
        let store=NativeQuickMirrorStore(engine:fake,permission:{.authorized},requestPermission:{asks+=1;return true},hasUsageDescription:{true},observe:{changes=$0;return {changes=nil}})
        store.configure(directory:dir);store.setVisible(true)
        check(!store.ready && fake.attempts.isEmpty && asks==0,"configuration and initial visibility never ask permission/start camera")
        store.setAvailable(true);await wait{store.ready && store.devices.count==3}
        check(fake.attempts.isEmpty && asks==0,"ready visible page only loads local settings/list")
        let start=Task{await store.toggle()};await wait{fake.attempts.count==1}
        check(store.starting && !store.active && fake.attempts==["built"],"isRunning is not active; store waits for first real frame")
        fake.replies[0](.timedOut);await wait{fake.attempts.count==2}
        check(fake.attempts==["built","external"] && !store.active,"no-frame attempt is released before ranked fallback")
        fake.replies[1](.frame);await start.value
        check(store.active && !store.starting && store.cameraID=="external","first frame transitions exact candidate live")
        store.stop();fake.list=[ext];changes?();try? await Task.sleep(nanoseconds:5_000_000)
        check(!store.active && fake.attempts.count==2,"hotplug after explicit stop never restarts capture")
        await store.chooseCamera("external")
        let saved=try await NativeQuickMirrorArchive(directory:dir).load()
        check(saved.cameraID=="external" && fake.attempts.count==2,"camera choice persists while idle without opening it")
        let again=Task{await store.toggle()};await wait{fake.attempts.count==3};store.setVisible(false);fake.replies[2](.frame);await again.value
        check(!store.active && !store.starting,"leaving during startup rejects late frame without reactivation")
        store.setVisible(true);try? await Task.sleep(nanoseconds:5_000_000)
        check(fake.attempts.count==3,"returning to page displays cover and never resumes capture")
        let privateStart=Task{await store.toggle()};await wait{fake.attempts.count==4};store.setAvailable(false);fake.replies[3](.frame);await privateStart.value
        check(!store.active && !store.ready && store.devices.isEmpty && store.cover==nil && store.preferredCameraID==nil,"private availability revokes session and hides preference projection")
        store.setAvailable(true);await wait{store.ready}
        check(store.preferredCameraID=="external" && fake.attempts.count==4,"restore reloads preference but stays stopped")
        let unplug=Task{await store.toggle()};await wait{fake.attempts.count==5};fake.replies[4](.frame);await unplug.value
        fake.list=[built];await store.refreshDevices();await wait{fake.attempts.count==6};fake.replies[5](.frame);await wait{store.active}
        check(store.cameraID=="built" && store.preferredCameraID=="external","active disconnected device falls back, preserving user's preferred ID")
        fake.interruption?();await wait{!store.active};check(store.error != nil,"runtime failure releases capture and asks explicit retry")
        let deniedFake=FakeMirrorCamera();var authorization=AVAuthorizationStatus.notDetermined
        let denied=NativeQuickMirrorStore(engine:deniedFake,permission:{authorization},requestPermission:{asks+=1;return false},hasUsageDescription:{true},observe:{_ in {}})
        denied.configure(directory:dir);denied.setAvailable(true);denied.setVisible(true);await wait{denied.ready}
        let beforeAsks=asks;check(asks==beforeAsks,"passive page does not prompt undecided permission")
        await denied.toggle();check(asks==beforeAsks+1 && denied.error != nil && deniedFake.attempts.isEmpty,"only explicit start asks permission; denial never starts engine")
        authorization = .denied;await denied.toggle();check(asks==beforeAsks+1,"known denied permission does not prompt repeatedly")
        let source=dir.deletingLastPathComponent().appendingPathComponent("synthetic.png")
        let image=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:100,pixelsHigh:60,bitsPerSample:8,samplesPerPixel:3,hasAlpha:false,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0)!
        try image.representation(using:.png,properties:[:])!.write(to:source)
        await store.importCover(source)
        let coverSaved=try await NativeQuickMirrorArchive(directory:dir).load()
        check(coverSaved.coverJPEG != nil && store.cover != nil && coverSaved.cameraID=="external","explicit cover decodes/reencodes locally without altering camera preference")
        check((try? FileManager.default.attributesOfItem(atPath:dir.appendingPathComponent("preferences.json").path)[.posixPermissions] as? NSNumber)?.intValue==0o600,"saved preferences/cover are owner-only")
        let sourceProps=CGImageSourceCreateWithData(coverSaved.coverJPEG! as CFData,nil)!
        check(CGImageSourceGetType(sourceProps)==UTType.jpeg.identifier as CFString,"cover copy is normalized JPEG with source metadata discarded")
        let original=try Data(contentsOf:dir.appendingPathComponent("preferences.json"))
        let revoked=NativeQuickMirrorWriteLease();revoked.revoke()
        do {try await NativeQuickMirrorArchive(directory:dir).save(.init(cameraID:"must-not-save"),lease:revoked);preconditionFailure("revoked write accepted")}catch{}
        let unchanged=try Data(contentsOf:dir.appendingPathComponent("preferences.json"))
        check(unchanged==original,"revoked commit gate keeps saved cover and camera bytes unchanged")
        let bad=dir.deletingLastPathComponent().appendingPathComponent("invalid.png");try Data("not an image".utf8).write(to:bad);await store.importCover(bad)
        check(store.error != nil && store.cover != nil,"invalid replacement reports failure and retains original cover")
        await store.resetCover();let reset=try await NativeQuickMirrorArchive(directory:dir).load()
        check(reset.coverJPEG==nil && reset.cameraID=="external","reset cover does not clear preferred device")
        let coverGate=CoverGate(),raceDir=dir.deletingLastPathComponent().appendingPathComponent("cover-race")
        let raceStore=NativeQuickMirrorStore(engine:FakeMirrorCamera(),permission:{.authorized},requestPermission:{false},hasUsageDescription:{true},observe:{_ in {}},decodeCover:{_ in try await coverGate.decode()})
        raceStore.configure(directory:raceDir);raceStore.setAvailable(true);raceStore.setVisible(true);await wait{raceStore.ready}
        let oldCover=Task{await raceStore.importCover(source)}
        while await coverGate.count<1 {try? await Task.sleep(nanoseconds:1_000_000)}
        raceStore.setVisible(false);raceStore.setVisible(true)
        check(!raceStore.saving,"closing cancels pending cover decode and makes new selection available")
        await coverGate.resolve(0,data:coverSaved.coverJPEG);await oldCover.value
        check(raceStore.cover==nil && !FileManager.default.fileExists(atPath:raceDir.appendingPathComponent("preferences.json").path),"close/reopen rejects late decoded cover instead of saving it")
        let failedOld=Task{await raceStore.importCover(source)}
        while await coverGate.count<2 {try? await Task.sleep(nanoseconds:1_000_000)}
        raceStore.setVisible(false);raceStore.setVisible(true)
        let newCover=Task{await raceStore.importCover(source)}
        while await coverGate.count<3 {try? await Task.sleep(nanoseconds:1_000_000)}
        await coverGate.resolve(1,data:nil);await failedOld.value
        check(raceStore.saving && raceStore.error==nil,"old decoder failure neither clears newer busy state nor publishes stale error")
        await coverGate.resolve(2,data:coverSaved.coverJPEG);await newCover.value
        check(!raceStore.saving && raceStore.cover != nil,"newest explicit cover commits normally after earlier decode cancellation")
        check(NativeQuickMirrorDevice.rank((0..<20).map{.init(id:String($0),name:"Synthetic",kind:.external)},preferred:nil).count==20,"camera selection has no arbitrary device-count truncation")
        check(NativeQuickMirrorMotion.zoom(8)==2.6 && NativeQuickMirrorMotion.zoom(.nan)==1 && NativeQuickMirrorMotion.zoom(0)==1,"zoom honors full 1–2.6 range and finite bounds")
        check(NativeQuickMirrorMotion.pixelOpacity(index:79,elapsed:0)==1 && NativeQuickMirrorMotion.pixelOpacity(index:79,elapsed:1.12)==0,"80-pixel reveal is bounded and finishes, with no idle animation timer")
        print("\(count) mirror assertions passed; no device, real permissions, capture, GUI, network or user-data access")
    }
}
