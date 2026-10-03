import AppKit
import SwiftUI
import ImageIO
import UniformTypeIdentifiers
func nativeUI(_ zh:String,_ en:String)->String { en }
@MainActor final class PreviewBoard: NativeQuickClipboardPasteboard {
    var changeCount=0; var types:[String]=[]; var last:NativeQuickClipboardPayload?
    func data(forType type:String)->Data? { nil }
    func write(_ payload:NativeQuickClipboardPayload)->Bool { last=payload; changeCount += 1; return true }
}
@MainActor final class PreviewLatch {
    var entered=false
    private var continuation:CheckedContinuation<Void,Never>?
    func wait() async { entered=true; await withCheckedContinuation { continuation=$0 } }
    func release() { continuation?.resume(); continuation=nil }
}
@main struct PreviewChecks {
    @MainActor static func main() async throws {
        _ = NSApplication.shared; NSApp.setActivationPolicy(.prohibited)
        let root=URL(fileURLWithPath:CommandLine.arguments[1]), directory=root.appendingPathComponent("Clipboard")
        var checks=0
        func check(_ pass:Bool,_ label:String) { precondition(pass,label); checks += 1 }
        func wait(_ predicate:()->Bool) async {
            for _ in 0..<300 { if predicate() { return }; try? await Task.sleep(nanoseconds:5_000_000) }
            precondition(predicate(),"Timed out")
        }
        let archive=NativeQuickClipboardArchive(directory:directory)
        _ = try await archive.setMode(.recording)
        let text=String(repeating:"完整文字：课件讨论与日程。每一行都必须保留，允许选择摘录。\n",count:1800)
        _ = try await archive.capture(.init(kind:.text,data:Data(text.utf8)),gate:.init())
        let context=CGContext(data:nil,width:3000,height:2000,bitsPerComponent:8,bytesPerRow:0,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(NSColor.systemTeal.cgColor); context.fill(CGRect(x:0,y:0,width:3000,height:2000))
        let bytes=NSMutableData(), destination=CGImageDestinationCreateWithData(bytes,UTType.png.identifier as CFString,1,nil)!
        CGImageDestinationAddImage(destination,context.makeImage()!,nil); check(CGImageDestinationFinalize(destination),"Synthetic large source image created")
        let state=try await archive.capture(.init(kind:.image,data:bytes as Data),gate:.init())
        let picture=state.items.first{$0.kind == .image}!, note=state.items.first{$0.kind == .text}!
        let original=try await archive.preview(id:picture.id)
        check(original.image != nil && original.text == nil,"Preview reads verified original image")
        check(max(original.image!.width,original.image!.height)==1600 && original.image!.width*original.image!.height<=1600*1600,"Decoded display buffer stays within 1600-edge budget, not 3000px original or 240px thumbnail")
        check(try await archive.preview(id:note.id).text == text,"Long text preview is complete with no line truncation")
        do { _ = try await archive.preview(id:String(repeating:"0",count:64)); fatalError("Expected missing record") } catch { checks += 1 }
        let board=PreviewBoard(), store=NativeQuickClipboardStore(directory:directory,pasteboard:board,schedulesPolling:false)
        store.setAvailable(true); store.setVisible(true); await wait { store.loaded && store.items.count==2 }
        store.showPreview(note); await wait { !store.previewLoading }
        check(store.previewText==text && store.previewImage==nil,"Current text is the only published preview payload")
        let window=NSWindow(contentRect:NSRect(x:0,y:0,width:620,height:430),styleMask:[.titled],backing:.buffered,defer:false)
        let host=NSHostingView(rootView:NativeQuickClipboardPreviewView(store:store)); window.contentView=host
        host.frame=window.contentLayoutRect; host.layoutSubtreeIfNeeded()
        for _ in 0..<12 { try await Task.sleep(nanoseconds:5_000_000); host.layoutSubtreeIfNeeded() }
        func findText(_ view:NSView)->NSTextView? { if let t=view as? NSTextView{return t}; for child in view.subviews {if let t=findText(child){return t}};return nil }
        guard let view=findText(host) else {fatalError("Production preview text did not mount")}
        check(view.string==text && !view.isEditable && view.isSelectable && view.bounds.width>0,"Actual hidden-window preview is complete, read-only, selectable and laid out")
        view.setSelectedRange(NSRange(location:0,length:10)); check(view.selectedRange().length==10,"Long text supports a partial native selection")
        await store.copy(note); check(board.last?.data==Data(text.utf8),"Preview Copy uses guarded original payload through injected pasteboard")
        store.showPreview(picture); await wait { !store.previewLoading }
        check(store.previewText==nil && store.previewImage != nil,"Switching preview clears old text and keeps only one fitted image")
        store.closePreview(); check(store.previewID==nil && store.previewImage==nil && store.previewText==nil,"Close releases both payload types")
        store.showPreview(picture); await wait { !store.previewLoading }; store.setVisible(false)
        check(store.previewID==nil && store.previewImage==nil,"Hiding module immediately clears image and presentation")
        store.setVisible(true); store.showPreview(note); await wait { !store.previewLoading }
        await store.remove([note.id]); check(store.previewID==nil && store.previewText==nil,"Deleting the open item closes and clears its preview")
        store.showPreview(note); check(store.previewID==nil,"Stale deleted record cannot be reopened from a stale row")
        let latch=PreviewLatch()
        let delayed=NativeQuickClipboardStore(directory:directory,pasteboard:PreviewBoard(),schedulesPolling:false,previewRead:{ id in
            let payload=try await archive.preview(id:id); await latch.wait(); return payload
        })
        delayed.setAvailable(true); delayed.setVisible(true); await wait { delayed.loaded && !delayed.items.isEmpty }
        delayed.showPreview(picture); await wait { latch.entered }
        delayed.setAvailable(false)
        check(delayed.previewID==nil && delayed.previewText==nil && delayed.previewImage==nil && !delayed.previewLoading,"Private transition clears pending preview immediately")
        latch.release(); try await Task.sleep(nanoseconds:30_000_000)
        check(delayed.previewID==nil && delayed.previewImage==nil && delayed.previewError==nil,"A decoded late original cannot revive after privacy revocation")
        let staleLatch=PreviewLatch()
        let stale=NativeQuickClipboardStore(directory:directory,pasteboard:PreviewBoard(),schedulesPolling:false,previewRead:{ id in
            let payload=try await archive.preview(id:id); await staleLatch.wait(); return payload
        })
        stale.setAvailable(true); stale.setVisible(true); await wait { stale.loaded && !stale.items.isEmpty }
        stale.showPreview(picture); await wait { staleLatch.entered }; await stale.remove([picture.id]); staleLatch.release()
        try await Task.sleep(nanoseconds:30_000_000)
        check(stale.previewID==nil && stale.previewImage==nil,"Record invalidation also rejects an already-decoded late result")
        // Corrupt/oversized original must still go through the archive's file
        // descriptor, size and fingerprint checks; no direct image-path loading.
        let imageFile=directory.appendingPathComponent(picture.id+".png")
        try Data(repeating:0,count:NativeQuickClipboardPolicy.maxImageBytes+1).write(to:imageFile)
        do { _ = try await archive.preview(id:picture.id); fatalError("Expected original-size guard") } catch { checks += 1 }
        check(store.previewImage==nil,"Oversized original never becomes an image in the store")
        print("PASS: \(checks) preview checks")
    }
}
