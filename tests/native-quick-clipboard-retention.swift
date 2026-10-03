import AppKit
import SwiftUI
import ImageIO
import UniformTypeIdentifiers
func nativeUI(_ zh: String, _ en: String) -> String { en }
@MainActor final class RetentionBoard: NativeQuickClipboardPasteboard {
    var changeCount = 0; var types: [String] = []; var reads = 0; var writes = 0
    func data(forType type: String) -> Data? { reads += 1; return nil }
    func write(_ payload: NativeQuickClipboardPayload) -> Bool { writes += 1; changeCount += 1; return true }
}
@main struct ClipboardRetentionChecks {
    @MainActor static func main() async throws {
        _ = NSApplication.shared; NSApp.setActivationPolicy(.prohibited)
        let root = URL(fileURLWithPath: CommandLine.arguments[1]), now = Date()
        var checks = 0
        func check(_ pass: Bool, _ label: String) { precondition(pass, label); checks += 1 }
        func wait(_ predicate: () -> Bool) async {
            for _ in 0..<300 { if predicate() { return }; try? await Task.sleep(nanoseconds: 5_000_000) }
            precondition(predicate(), "Timed out")
        }
        func payload(_ text: String) -> NativeQuickClipboardPayload { .init(kind: .text, data: Data(text.utf8)) }
        func item(_ index: Int, favorite: Bool = false) -> NativeQuickClipboardItem {
            let data=payload("Fictional retention item \(index)")
            return .init(id: NativeQuickClipboardPolicy.fingerprint(data),kind: .text,text: String(data: data.data,encoding: .utf8),bytes: data.data.count,
                         createdAt: now.addingTimeInterval(-Double(index)*86400),deletedAt:nil,favorite:favorite ? true : nil)
        }
        func seed(_ name: String, items: [NativeQuickClipboardItem], policy: NativeQuickClipboardRetention? = nil) throws -> URL {
            let folder=root.appendingPathComponent(name);try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true)
            var state=NativeQuickClipboardState();state.items=items;state.retention=policy
            try JSONEncoder().encode(state).write(to:folder.appendingPathComponent("history.json"));return folder
        }
        let rows=(0..<12).map{item($0)}+[item(99,favorite:true)],folder=try seed("archive",items:rows)
        let archive=NativeQuickClipboardArchive(directory:folder),original=try await archive.load(),before=try Data(contentsOf:folder.appendingPathComponent("history.json"))
        check(original.retention == nil && original.retentionPolicy == .legacy && original.mode == .off,"Legacy archive remains unlimited-age, off, total hard budget unchanged")
        let age=NativeQuickClipboardRetention(days:7,itemLimit:10),plan=try await archive.previewRetention(age,now:now)
        check(plan.ids == Set(rows[8..<12].map(\.id)),"Age and count form one deduplicated candidate set; cutoff boundary retained")
        check(plan.favoriteCount==1 && !plan.ids.contains(rows.last!.id),"Old favorite is protected and excluded from ordinary count")
        check(plan.bytes==rows[8..<12].reduce(0){$0+$1.bytes} && plan.totalBytes==rows.reduce(0){$0+$1.bytes},"Preview reports exact content byte counts")
        check(try Data(contentsOf:folder.appendingPathComponent("history.json"))==before,"Preview does not mutate policy or items")
        let applied=try await archive.applyRetention(plan,now:now,gate:.init())
        check(applied.state.mode == .off && applied.state.retention == age,"Explicit policy apply never enables capture")
        check(applied.state.items.filter{$0.deletedAt != nil}.count==4 && applied.state.items.count==rows.count,"Policy only soft-deletes the reviewed subset")
        check(applied.state.items.last!.isFavorite && applied.state.items.last!.deletedAt==nil,"Favorite retained through actual commit")
        let reopened=try await NativeQuickClipboardArchive(directory:folder).load()
        check(reopened.retention==age && reopened.items==applied.state.items,"Policy and soft deletions survive reload")
        let undone=try await archive.undoRetention(applied.receipt,now:now.addingTimeInterval(1),gate:.init())
        check(try undone.retentionStamp()==original.retentionStamp(),"Undo restores exact prior policy and items together")
        let stale=try await archive.previewRetention(age,now:now)
        _=try await archive.setFavorite(id:rows[11].id,favorite:true)
        do{_=try await archive.applyRetention(stale,gate:.init());fatalError("Stale plan must fail")}catch NativeQuickClipboardError.retentionChanged{checks+=1}
        check(try await archive.load().retention==nil,"Changed preview never partially updates policy")
        let current=try await archive.previewRetention(age,now:now),gate=NativeQuickClipboardCaptureGate();gate.revoke()
        let revokedBefore=try Data(contentsOf:folder.appendingPathComponent("history.json"))
        do{_=try await archive.applyRetention(current,gate:gate);fatalError("Revoked policy must fail")}catch is CancellationError{checks+=1}
        check(try Data(contentsOf:folder.appendingPathComponent("history.json"))==revokedBefore,"Revoked gate preserves exact disk bytes")
        let again=try await archive.applyRetention(current,now:now,gate:.init())
        _=try await archive.setFavorite(id:rows[0].id,favorite:true)
        do{_=try await archive.undoRetention(again.receipt,now:now.addingTimeInterval(1),gate:.init());fatalError("Undo must not overwrite later edit")}catch NativeQuickClipboardError.retentionChanged{checks+=1}
        check(try await archive.load().items.first!.isFavorite,"Rejected undo retains later favorite")
        let restoredID=rows[10].id;_=try await archive.restore(ids:[restoredID])
        check(try await archive.payload(id:restoredID).data==payload(rows[10].text!).data,"Manual restore remains readable under restrictive policy")
        check(try await NativeQuickClipboardArchive(directory:folder).load().items.first{$0.id==restoredID}!.deletedAt==nil,"Reload does not immediately re-delete restored record")
        _=try await archive.setMode(.recording)
        check(try await archive.load().items.first{$0.id==restoredID}!.deletedAt==nil,"Mode change is not a policy sweep")
        let captured=try await archive.capture(payload("New synthetic item"),gate:.init())
        check(captured.items.first{$0.id==restoredID}!.deletedAt != nil && captured.items.contains{$0.text=="New synthetic item" && $0.deletedAt==nil},"Next new capture enforces saved policy; new item remains active")
        check(captured.items.filter{$0.deletedAt==nil && !$0.isFavorite}.count<=10,"Nonfavorite active count obeys soft limit")
        let fullFolder=try seed("full",items:(0..<100).map{item($0,favorite:$0 != 99)})
        let full=NativeQuickClipboardArchive(directory:fullFolder),fullPlan=try await full.previewRetention(.init(days:1,itemLimit:10),now:now)
        let fullApplied=try await full.applyRetention(fullPlan,now:Date(),gate:.init())
        check(fullApplied.state.items.count==100 && fullApplied.state.items.filter(\.isFavorite).count==99,"Favorites and Trash still share the original 100 total budget")
        _=try await full.setMode(.recording)
        do{_=try await full.capture(payload("Cannot evict protected cleanup"),gate:.init());fatalError("Must not hard-delete just organized item")}catch NativeQuickClipboardError.protectedCapacity{checks+=1}
        check(try await full.load().items.count==100,"Capacity rejection keeps all records")
        var hundred=(0..<100).map{item($0)}
        for index in hundred.indices { hundred[index].createdAt=now.addingTimeInterval(-Double(index)*60) }
        let pressureFolder=try seed("automatic-pressure",items:hundred,policy:.init(days:30,itemLimit:100))
        let pressure=NativeQuickClipboardArchive(directory:pressureFolder);_=try await pressure.setMode(.recording)
        let advanced=try await pressure.capture(payload("Synthetic number 101"),gate:.init())
        check(!advanced.items.contains{$0.id==hundred[99].id} && advanced.items.contains{$0.id==hundred[98].id && $0.deletedAt==nil},"At hard cap automatic cleanup evicts oldest Trash before newer live item, without fake Undo protection")
        check(advanced.items.count==100 && advanced.items.allSatisfy{$0.deletedAt==nil},"New capture keeps original total hard count semantics")
        let longPayload=payload(String(repeating:"Synthetic ",count:150))
        let longItem=NativeQuickClipboardItem(id:NativeQuickClipboardPolicy.fingerprint(longPayload),kind:.text,text:String(data:longPayload.data,encoding:.utf8),bytes:longPayload.data.count,createdAt:now,deletedAt:nil)
        let tightFolder=try seed("settings-quota",items:[longItem]),tightBefore=try Data(contentsOf:tightFolder.appendingPathComponent("history.json"))
        let tight=NativeQuickClipboardArchive(directory:tightFolder,diskLimit:tightBefore.count+5)
        let tightPreview=try await tight.previewRetention(.init(days:30,itemLimit:100))
        do{_=try await tight.applyRetention(tightPreview,gate:.init());fatalError("Settings cannot evict unseen records just to fit metadata")}catch NativeQuickClipboardError.protectedCapacity{checks+=1}
        check(try Data(contentsOf:tightFolder.appendingPathComponent("history.json"))==tightBefore,"Policy metadata capacity failure is atomic and retains every byte")
        let failingFolder=try seed("write-failure",items:rows),failing=NativeQuickClipboardArchive(directory:failingFolder)
        let failingPlan=try await failing.previewRetention(age,now:now),failingStamp=try await failing.load().retentionStamp()
        try FileManager.default.moveItem(at:failingFolder.appendingPathComponent("history.json"),to:failingFolder.appendingPathComponent("original.json"))
        try FileManager.default.createDirectory(at:failingFolder.appendingPathComponent("history.json"),withIntermediateDirectories:false)
        do{_=try await failing.applyRetention(failingPlan,gate:.init());fatalError("Real rename failure")}catch NativeQuickClipboardError.writeFailed{checks+=1}
        check(try await failing.load().retentionStamp()==failingStamp,"Failed disk commit retains old in-memory policy/items")
        check(try FileManager.default.contentsOfDirectory(atPath:failingFolder.path).allSatisfy{!$0.hasPrefix(".pending-")},"Failed apply cleans only its temporary file")
        for invalid in [NativeQuickClipboardRetention(days:0,itemLimit:10),.init(days:7,itemLimit:101),.init(days:3,itemLimit:25)] {
            do{_=try await archive.previewRetention(invalid);fatalError("Invalid policy")}catch NativeQuickClipboardError.corrupt{checks+=1}
        }
        // Synthetic original image remains on disk across cleanup and restore.
        let imageFolder=root.appendingPathComponent("image"),images=NativeQuickClipboardArchive(directory:imageFolder)
        _=try await images.setMode(.recording)
        let cg=CGContext(data:nil,width:40,height:30,bitsPerComponent:8,bytesPerRow:0,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
        cg.setFillColor(NSColor.systemTeal.cgColor);cg.fill(CGRect(x:0,y:0,width:40,height:30))
        let png=NSMutableData(),target=CGImageDestinationCreateWithData(png,UTType.png.identifier as CFString,1,nil)!
        CGImageDestinationAddImage(target,cg.makeImage()!,nil);precondition(CGImageDestinationFinalize(target))
        let image=try await images.capture(.init(kind:.image,data:png as Data),gate:.init()).items.first!
        let imagePlan=try await images.previewRetention(.init(days:1,itemLimit:10),now:Date().addingTimeInterval(2*86400))
        let imageResult=try await images.applyRetention(imagePlan,gate:.init())
        check(FileManager.default.fileExists(atPath:imageFolder.appendingPathComponent(image.id+".png").path),"Policy keeps soft-deleted image payload")
        _=try await images.undoRetention(imageResult.receipt,gate:.init())
        check(try await images.payload(id:image.id).data.count==image.bytes,"Exact undo keeps original verified image usable")
        let imageAgain=try await images.applyRetention(images.previewRetention(.init(days:1,itemLimit:10),now:Date().addingTimeInterval(2*86400)),gate:.init())
        try FileManager.default.removeItem(at:imageFolder.appendingPathComponent(image.id+".png"))
        do{_=try await images.undoRetention(imageAgain.receipt,gate:.init());fatalError("Cannot report restoring missing original image")}catch NativeQuickClipboardError.corrupt{checks+=1}
        check(try await images.load().items.first!.deletedAt != nil,"Missing payload does not revive a broken preview")
        // Advance the same real archive before its UI projection, modelling a
        // capture that committed just before its callback was superseded.
        let staleFolder=try seed("store-stale",items:rows),staleBoard=RetentionBoard()
        let staleStore=NativeQuickClipboardStore(directory:staleFolder,pasteboard:staleBoard,schedulesPolling:false,now:{now})
        staleStore.setAvailable(true);await wait{staleStore.loaded && staleStore.items.count==rows.count}
        staleStore.openRetentionSettings();await staleStore.prepareRetention(age)
        let sharedArchive=Mirror(reflecting:staleStore).children.first{$0.label=="archive"}!.value as! NativeQuickClipboardArchive
        _=try await sharedArchive.setFavorite(id:rows[11].id,favorite:true)
        check(staleStore.items.first{$0.id==rows[11].id}!.isFavorite==false,"Fixture leaves durable archive ahead of displayed projection")
        await staleStore.applyRetention()
        check(staleStore.items.first{$0.id==rows[11].id}!.isFavorite && staleStore.retentionPolicy == .legacy,"Stale apply refreshes durable history without applying old preview")
        check(staleStore.retentionPreview?.ids.count==3 && staleStore.retentionError != nil && staleStore.retentionSettingsOpen,"Recalculated impact requires another explicit confirmation")
        staleStore.closeRetentionSettings();check(staleStore.items.first{$0.id==rows[11].id}!.isFavorite,"Cancelling refreshed settings leaves the actual latest history visible")
        staleStore.shutdown();check(staleBoard.reads==0,"Stale reconciliation never reads the system pasteboard")
        for privacy in [false,true] {
            let delayedFolder=try seed(privacy ? "late-private" : "late-hidden",items:rows),delayedBoard=RetentionBoard()
            var shared:NativeQuickClipboardArchive!,readCount=0
            var pending:CheckedContinuation<NativeQuickClipboardRetentionPreview,Error>?
            let delayed=NativeQuickClipboardStore(directory:delayedFolder,pasteboard:delayedBoard,schedulesPolling:false,
                retentionPreviewRead:{policy,date in
                    readCount += 1
                    if readCount==1 { return try await shared.previewRetention(policy,now:date) }
                    return try await withCheckedThrowingContinuation{pending=$0}
                },now:{now})
            shared=Mirror(reflecting:delayed).children.first{$0.label=="archive"}!.value as? NativeQuickClipboardArchive
            delayed.setAvailable(true);delayed.setVisible(true);await wait{delayed.loaded && delayed.items.count==rows.count}
            delayed.openRetentionSettings();await delayed.prepareRetention(age)
            _=try await shared.setFavorite(id:rows[11].id,favorite:true)
            let applying=Task{@MainActor in await delayed.applyRetention()};await wait{pending != nil}
            check(delayed.items.first{$0.id==rows[11].id}!.isFavorite,"Reload publishes current archive before delayed recalculation")
            if privacy { delayed.setAvailable(false) } else { delayed.setVisible(false) }
            pending?.resume(returning:try await shared.previewRetention(age,now:now));await applying.value
            check(delayed.retentionError==nil && delayed.retentionPreview==nil && !delayed.retentionSettingsOpen,"Late outer catch cannot write errors/candidates after hidden or private close")
            check(delayed.retentionPolicy == .legacy && delayed.mode == .off,"Stale late reconciliation does not apply policy or change capture")
            check(!privacy || delayed.items.isEmpty,"Late reload leaves private history empty")
            delayed.shutdown()
        }
        // Store lifecycle uses fake pasteboard only; copy and preview reads are controlled.
        let storeFolder=try seed("store",items:rows),board=RetentionBoard()
        var copyContinuation:CheckedContinuation<NativeQuickClipboardPayload,Error>?
        var previewContinuation:CheckedContinuation<NativeQuickClipboardPreviewPayload,Error>?
        let store=NativeQuickClipboardStore(directory:storeFolder,pasteboard:board,schedulesPolling:false,
            previewRead:{_ in try await withCheckedThrowingContinuation{previewContinuation=$0}},
            payloadRead:{_ in try await withCheckedThrowingContinuation{copyContinuation=$0}},now:{now})
        store.setAvailable(true);store.setVisible(true);await wait{store.loaded && store.items.count==rows.count}
        store.showPreview(rows[10]);await wait{previewContinuation != nil}
        store.openRetentionSettings();check(store.previewID==nil,"Settings closes an existing preview before cleanup")
        previewContinuation?.resume(returning:.init(text:"Late preview",image:nil));await Task.yield()
        check(store.previewText==nil && store.previewID==nil,"Late preview cannot revive after close")
        await store.prepareRetention(age);check(store.retentionPreview?.ids==plan.ids,"Store displays archive-derived reviewed IDs")
        let copyTask=Task{@MainActor in await store.copy(rows[0])};await wait{copyContinuation != nil}
        await store.applyRetention();check(store.retentionPolicy == .legacy && store.retentionSettingsOpen,"Applying policy cannot race an in-flight copy")
        copyContinuation?.resume(returning:payload(rows[0].text!));await copyTask.value
        check(board.writes==1 && board.reads==0,"Copy uses injected original, no system monitoring")
        await store.applyRetention();check(store.retentionPolicy==age && store.deletionUndo?.retention != nil && !store.retentionSettingsOpen,"Store publishes policy only after actual commit and offers combined undo")
        await store.undoDeletion();check(store.retentionPolicy == .legacy && store.items==rows,"Store combined undo restores prior policy and exact history")
        store.openRetentionSettings();await store.prepareRetention(age);await store.toggleFavorite(rows[11])
        check(store.retentionPreview==nil && store.retentionError != nil,"Intervening history change invalidates impact preview")
        await store.prepareRetention(age);let count=store.retentionPreview?.ids.count
        store.setAvailable(false);await store.applyRetention()
        check(store.retentionPreview==nil && !store.retentionSettingsOpen && store.items.isEmpty && count==3,"Private transition clears reviewed IDs and cancels policy UI")
        store.setAvailable(true);await wait{store.items.count==rows.count}
        check(store.retentionPolicy == .legacy && store.mode == .off && board.reads==0,"Unlock does not apply dismissed policy or enable capture")
        store.openRetentionSettings();await store.prepareRetention(age);store.closeRetentionSettings()
        check(store.retentionPolicy == .legacy,"Cancel discards settings without writes")
        // Compile and mount the real form in an offscreen, never ordered window.
        store.openRetentionSettings();await store.prepareRetention(.legacy)
        let view=NSHostingView(rootView:NativeQuickClipboardRetentionView(store:store)),window=NSWindow(contentRect:NSRect(x:-10000,y:-10000,width:540,height:470),styleMask:[.borderless],backing:.buffered,defer:false)
        window.contentView=view;view.layoutSubtreeIfNeeded();check(view.fittingSize.width>0 && view.fittingSize.height<=470,"Real retention impact form lays out inside compact island height")
        store.shutdown();window.contentView=nil
        print("PASS: \(checks) retention checks")
    }
}
