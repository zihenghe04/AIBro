import Foundation
import Combine

func nativeUI(_ zh:String,_ en:String)->String {en}

@main struct RecordingObservationChecks {
    @MainActor static func main() async throws {
        let directory=URL(fileURLWithPath:CommandLine.arguments[1]),folder=directory.appendingPathComponent("quick-recordings")
        let item=NativeQuickRecordingItem(id:UUID().uuidString.lowercased(),title:"Fictional seminar",createdAt:Date(),duration:12,transcript:"Fictional notes on observation methods.",state:"ready")
        var archive=try NativeQuickRecordingArchive(directory:folder);try archive.replace([item])
        let manifest=folder.appendingPathComponent("index.json"),before=try Data(contentsOf:manifest)
        let store=NativeQuickRecordingStore();store.configure(directory:directory)
        var modelCalls=0
        store.configureTitleRequest{_ in modelCalls+=1;return ["status":"error","reason":"unused"]}
        store.setVisible(false)
        var renderedEnabled=store.canSuggest(id:item.id),invalidations=0,failures=0,checks=0
        func check(_ value:Bool,_ text:String){checks+=1;if !value{failures+=1};print("\(value ? "PASS":"FAIL") \(text)")}
        // Model a mounted SwiftUI observer: willChange queues a render, whose
        // body reads computed state AFTER the mutation (not inside willSet).
        let subscription=store.objectWillChange.sink {
            invalidations+=1
            DispatchQueue.main.async {renderedEnabled=store.canSuggest(id:item.id)}
        }
        func drain() async {await withCheckedContinuation { continuation in DispatchQueue.main.async{continuation.resume()} }}
        check(!renderedEnabled,"initial hidden mount disables suggestions")
        DispatchQueue.main.async {store.setVisible(true)}
        await drain();await drain()
        check(store.canSuggest(id:item.id),"async host appearance updates actual suggestion eligibility")
        check(invalidations>0,"async host appearance invalidates the mounted Combine observer")
        check(renderedEnabled,"computed button state refreshes after delayed host appearance without another data change")
        DispatchQueue.main.async {store.setVisible(false)}
        await drain();await drain()
        check(!renderedEnabled && !store.canSuggest(id:item.id),"host disappearance disables suggestions again")
        store.setAvailable(false);DispatchQueue.main.async {store.setVisible(true)}
        await drain();await drain()
        check(!renderedEnabled,"appearance in private or unavailable workspace cannot enable suggestions")
        store.setAvailable(true);await drain()
        check(renderedEnabled,"restoring availability projects the currently visible host")
        check(modelCalls==0 && store.phase == .idle && store.transcribingID==nil,"visibility notifications do not request a model microphone or ASR")
        check(try Data(contentsOf:manifest)==before,"observation-only transitions do not mutate recording data")
        withExtendedLifetime(subscription){}
        print("\(checks-failures)/\(checks) observation checks passed; no GUI or devices")
        if failures>0 {exit(1)}
    }
}
