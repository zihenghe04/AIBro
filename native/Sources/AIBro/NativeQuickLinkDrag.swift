import AppKit
import SwiftUI

/// TO-DO Panel 1deb3cac, renderer/workspace.js:543–689 provides whole-row
/// 340ms/8pt hold, midpoint insertion, group-tail and cancel marks. Our explicit
/// grip additionally starts at 4pt movement, leaving title clicks untouched.
/// AppKit supplies session end/cancel and a native drag image; no global monitor.
@MainActor final class NativeQuickLinkDrag: ObservableObject {
    static let pasteboardType = NSPasteboard.PasteboardType("app.aibro.quick-link-order")
    static let holdDuration: TimeInterval = 0.340
    static let immediateDragThreshold: CGFloat = 4
    @Published private(set) var source: NativeQuickLinkRow?
    @Published private(set) var target: NativeQuickLinkDropTarget?
    @Published private(set) var savingID: String?
    @Published private(set) var settledID: String?
    private(set) var nonce: UUID?
    private var valid: (() -> Bool)?
    private var loadingDrop = false
    private var dropRead: Progress?
    private var settlement: Task<Void,Never>?
    private var inputMonitor:Any?
    private var handles: [String:WeakHandle] = [:]
    private struct WeakHandle { weak var value: NativeQuickLinkDragHandle.Handle? }
    var isDragging: Bool { source != nil && !loadingDrop && savingID == nil }
    var acceptsSession: Bool { nonce != nil && source != nil && !loadingDrop && savingID == nil && valid?() == true }
    func begin(_ row:NativeQuickLinkRow, window:NSWindow?=nil, valid:@escaping ()->Bool) -> Data? {
        guard savingID==nil,valid() else { return nil }
        cancel(); let token=UUID();nonce=token;source=row;self.valid=valid
        if let window {
            inputMonitor=NSEvent.addLocalMonitorForEvents(matching:[.keyDown,.leftMouseDown,.rightMouseDown]) { [weak self,weak window] event in
                MainActor.assumeIsolated {if event.window === window || (event.window==nil && NSApp.keyWindow === window) {self?.cancel()}}
                return event
            }
        }
        return Data(token.uuidString.utf8)
    }
    func mark(_ value:NativeQuickLinkDropTarget?) { target=acceptsSession ? value:nil }
    func clear(_ value:NativeQuickLinkDropTarget) { if target==value { target=nil } }
    func ended(_ token:UUID, operation:NSDragOperation) {
        guard nonce==token else {return}
        // Only an accepted move may finish its provider read after session end.
        // Escape/outside cancellation must revoke even a pending data callback.
        guard operation.contains(.move) else { cancel();return }
        if !loadingDrop && savingID==nil { cancel() }
    }
    func receive(_ provider:NSItemProvider, target:NativeQuickLinkDropTarget,
                 commit:@escaping (NativeQuickLinkRow,NativeQuickLinkDropTarget)->Void) -> Bool {
        guard acceptsSession,let token=nonce,let row=source,
              provider.hasItemConformingToTypeIdentifier(Self.pasteboardType.rawValue) else {return false}
        loadingDrop=true;self.target=target
        dropRead=provider.loadDataRepresentation(forTypeIdentifier:Self.pasteboardType.rawValue) { [weak self] data,_ in
            Task { @MainActor in
                guard let self,self.nonce==token,self.loadingDrop else{return}
                self.dropRead=nil;self.loadingDrop=false
                guard data==Data(token.uuidString.utf8),self.valid?()==true else {self.cancel();return}
                // Hand off synchronously on MainActor before any command await.
                self.source=nil;self.target=nil;self.nonce=nil;self.valid=nil;self.removeInputMonitor()
                commit(row,target)
            }
        }
        return true
    }
    func beginSaving(_ id:String) { cancel();savingID=id }
    func finishSaving(_ id:String,confirmed:Bool) {
        guard savingID==id else{return};savingID=nil
        guard confirmed else{return};settledID=id
        settlement=Task { @MainActor [weak self] in
            do {try await Task.sleep(nanoseconds:400_000_000)}catch{return}
            guard self?.settledID==id else{return};self?.settledID=nil
        }
    }
    func cancel() {
        removeInputMonitor()
        dropRead?.cancel();dropRead=nil;nonce=nil;source=nil;target=nil;valid=nil;loadingDrop=false
        settlement?.cancel();settlement=nil;settledID=nil;savingID=nil
    }
    private func removeInputMonitor(){if let inputMonitor {NSEvent.removeMonitor(inputMonitor)};inputMonitor=nil}
    func register(_ view:NativeQuickLinkDragHandle.Handle,id:String) {handles[id]=WeakHandle(value:view)}
    func unregister(_ view:NativeQuickLinkDragHandle.Handle,id:String) {if handles[id]?.value === view {handles.removeValue(forKey:id)}}
    @discardableResult func focus(_ id:String) -> Bool {
        guard let view=handles[id]?.value,let window=view.window,window.isKeyWindow,window.isVisible,
              !view.isHiddenOrHasHiddenAncestor,view.visibleRect.height>=12,view.enabled,
              !(window.firstResponder is NSTextView) else{return false}
        return window.makeFirstResponder(view)
    }
    deinit { settlement?.cancel();dropRead?.cancel();if let inputMonitor {NSEvent.removeMonitor(inputMonitor)} }
}

struct NativeQuickLinkDrop: DropDelegate {
    let drag: NativeQuickLinkDrag
    let groupID: String
    var rowID: String? = nil
    var height: CGFloat = 0
    let canPlace: (NativeQuickLinkRow,NativeQuickLinkDropTarget)->Bool
    let commit: (NativeQuickLinkRow,NativeQuickLinkDropTarget)->Void
    private func destination(_ info:DropInfo)->NativeQuickLinkDropTarget {
        .init(groupID:groupID,rowID:rowID,after:rowID != nil && info.location.y > height/2)
    }
    func validateDrop(info:DropInfo)->Bool {
        (rowID==nil || height>0) && drag.acceptsSession && info.hasItemsConforming(to:[NativeQuickLinkDrag.pasteboardType.rawValue])
    }
    func dropEntered(info:DropInfo) {update(info)}
    func dropUpdated(info:DropInfo)->DropProposal? {update(info);return DropProposal(operation:drag.target == nil ? .forbidden:.move)}
    private func update(_ info:DropInfo) {
        let value=destination(info)
        guard validateDrop(info:info),let row=drag.source,canPlace(row,value) else{drag.mark(nil);return}
        drag.mark(value)
    }
    func dropExited(info:DropInfo) {
        if drag.target?.groupID==groupID && drag.target?.rowID==rowID {drag.mark(nil)}
    }
    func performDrop(info:DropInfo)->Bool {
        let value=destination(info),providers=info.itemProviders(for:[NativeQuickLinkDrag.pasteboardType.rawValue])
        guard validateDrop(info:info),providers.count==1,let row=drag.source,canPlace(row,value) else{drag.mark(nil);return false}
        return drag.receive(providers[0],target:value,commit:commit)
    }
}

/// A small explicit native grip is also the durable keyboard-focus anchor.
/// Title/link buttons remain their original SwiftUI controls and are never
/// covered by a drag recognizer. No web URLs are offered to other applications.
struct NativeQuickLinkDragHandle: NSViewRepresentable {
    let row: NativeQuickLinkRow
    let drag: NativeQuickLinkDrag
    let enabled: Bool
    let highlighted: Bool
    let onFocus: ()->Void
    let valid: ()->Bool
    let canMove: (NativeQuickLinkOrderAction)->Bool
    let move: (NativeQuickLinkOrderAction)->Void
    func makeNSView(context:Context)->Handle {let view=Handle();configure(view);return view}
    func updateNSView(_ view:Handle,context:Context) {configure(view)}
    private func configure(_ view:Handle) {
        if view.id != row.id {if let id=view.id {view.drag?.unregister(view,id:id)};view.cancelPress();view.id=row.id}
        view.row=row;view.drag=drag;view.enabled=enabled;view.highlighted=highlighted;view.onFocus=onFocus
        view.valid=valid;view.canMove=canMove;view.move=move
        view.toolTip=nativeUI("按住拖动；⌥↑ / ⌥↓ 排序", "Hold to drag; ⌥↑ / ⌥↓ to reorder")
        view.setAccessibilityLabel(nativeUI("移动链接：", "Move link: ")+row.title)
        view.setAccessibilityHelp(view.toolTip);view.setAccessibilityEnabled(enabled)
        drag.register(view,id:row.id);view.needsDisplay=true
    }
    static func dismantleNSView(_ view:Handle,coordinator:()) {
        if let id=view.id {view.drag?.unregister(view,id:id)};view.cancelPress();view.drag=nil
    }
    class Handle: NSView,NSDraggingSource {
        var id:String?,row:NativeQuickLinkRow?
        weak var drag:NativeQuickLinkDrag?
        var enabled=true {didSet{if !enabled {cancelPress()}}}
        var highlighted=false,hovered=false
        var onFocus:(()->Void)?,valid:(()->Bool)?,canMove:((NativeQuickLinkOrderAction)->Bool)?,move:((NativeQuickLinkOrderAction)->Void)?
        private var hold:Task<Void,Never>?
        private var down:NSEvent?
        private var start=NSPoint.zero
        private var sessionNonce:UUID?
        private var tracking:NSTrackingArea?
        override init(frame:NSRect){super.init(frame:frame);setAccessibilityElement(true);setAccessibilityRole(.button)}
        required init?(coder:NSCoder){fatalError("init(coder:) is not used")}
        override var acceptsFirstResponder:Bool {enabled}
        override func becomeFirstResponder()->Bool {needsDisplay=true;return true}
        override func resignFirstResponder()->Bool {cancelPress();needsDisplay=true;return true}
        override func viewDidMoveToWindow() {super.viewDidMoveToWindow();if window==nil {cancelPress()}}
        override func updateTrackingAreas() {
            super.updateTrackingAreas();if let tracking {removeTrackingArea(tracking)}
            let area=NSTrackingArea(rect:.zero,options:[.mouseEnteredAndExited,.activeInKeyWindow,.inVisibleRect],owner:self);addTrackingArea(area);tracking=area
        }
        override func mouseEntered(with event:NSEvent){hovered=true;needsDisplay=true}
        override func mouseExited(with event:NSEvent){hovered=false;needsDisplay=true}
        override func draw(_ dirtyRect:NSRect) {
            let focused=window?.firstResponder === self
            if focused {NSColor.keyboardFocusIndicatorColor.withAlphaComponent(0.7).setStroke();let path=NSBezierPath(roundedRect:bounds.insetBy(dx:1,dy:1),xRadius:4,yRadius:4);path.lineWidth=1.5;path.stroke()}
            NSColor.secondaryLabelColor.withAlphaComponent(enabled && (hovered || highlighted || focused) ? 0.9:0.16).setFill()
            for x:CGFloat in [-2.5,2.5] {for y:CGFloat in [-5,0,5] {NSBezierPath(ovalIn:NSRect(x:bounds.midX+x-1,y:bounds.midY+y-1,width:2,height:2)).fill()}}
        }
        override func mouseDown(with event:NSEvent) {
            cancelPress();guard enabled,valid?()==true else{return};onFocus?();window?.makeFirstResponder(self)
            down=event;start=event.locationInWindow
            hold=Task { @MainActor [weak self] in
                do {try await Task.sleep(nanoseconds:340_000_000)}catch{return}
                self?.requestDragStart(using:nil)
            }
        }
        override func mouseDragged(with event:NSEvent) {
            // The explicit grip has no click-to-open action to protect. A normal
            // 4pt drag starts immediately; stationary hold is an alternative.
            if down != nil && hypot(event.locationInWindow.x-start.x,event.locationInWindow.y-start.y)>=NativeQuickLinkDrag.immediateDragThreshold {requestDragStart(using:event)}
        }
        override func mouseUp(with event:NSEvent){cancelPress()}
        override func scrollWheel(with event:NSEvent){cancelPress();super.scrollWheel(with:event)}
        func cancelPress(){hold?.cancel();hold=nil;down=nil}
        // Kept as the native-session boundary so headless event checks can
        // observe real mouseDown/Dragged/Up without opening a system drag.
        func requestDragStart(using dragged:NSEvent?) {
            guard let event=dragged ?? down,down != nil,enabled,let window,window.isVisible,window.isKeyWindow,
                  !isHiddenOrHasHiddenAncestor,let row,let validation=valid,validation(),let drag,
                  let data=drag.begin(row,window:window,valid:validation) else{cancelPress();return}
            let item=NSPasteboardItem();item.setData(data,forType:NativeQuickLinkDrag.pasteboardType)
            let dragging=NSDraggingItem(pasteboardWriter:item)
            let size=NSSize(width:210,height:42)
            let image=NSImage(size:size,flipped:false) { rect in
                NSColor.controlBackgroundColor.setFill();NSBezierPath(roundedRect:rect,xRadius:9,yRadius:9).fill()
                let style=NSMutableParagraphStyle();style.lineBreakMode = .byTruncatingTail
                (row.title as NSString).draw(in:rect.insetBy(dx:12,dy:12),withAttributes:[.font:NSFont.systemFont(ofSize:12,weight:.medium),.foregroundColor:NSColor.labelColor,.paragraphStyle:style]);return true
            }
            dragging.setDraggingFrame(NSRect(origin:NSPoint(x:bounds.midX-12,y:bounds.midY-21),size:size),contents:image)
            sessionNonce=drag.nonce;cancelPress()
            let session=beginDraggingSession(with:[dragging],event:event,source:self)
            session.animatesToStartingPositionsOnCancelOrFail=true
        }
        func draggingSession(_ session:NSDraggingSession,sourceOperationMaskFor context:NSDraggingContext)->NSDragOperation {context == .withinApplication ? .move:[]}
        func ignoreModifierKeys(for session:NSDraggingSession)->Bool {true}
        func draggingSession(_ session:NSDraggingSession,endedAt screenPoint:NSPoint,operation:NSDragOperation) {
            if let token=sessionNonce {drag?.ended(token,operation:operation)};sessionNonce=nil;cancelPress()
        }
        override func keyDown(with event:NSEvent) {
            guard enabled else {super.keyDown(with:event);return}
            let flags=event.modifierFlags.intersection([.command,.control,.option,.shift])
            let action:NativeQuickLinkOrderAction?
            if flags == .option {switch event.keyCode {case 126:action = .up;case 125:action = .down;case 115:action = .first;case 119:action = .last;default:action=nil}}else{action=nil}
            if let action {if !event.isARepeat,canMove?(action)==true {move?(action)};return}
            if flags.isEmpty && [36,49,76].contains(event.keyCode) {if !event.isARepeat {showMenu()};return}
            if event.keyCode==48 {if flags == .shift {window?.selectPreviousKeyView(self)}else{window?.selectNextKeyView(self)};return}
            super.keyDown(with:event)
        }
        override func accessibilityPerformPress()->Bool {guard enabled else{return false};showMenu();return true}
        private func showMenu() {
            onFocus?();window?.makeFirstResponder(self)
            let menu=NSMenu();menu.autoenablesItems=false
            for (index,action) in NativeQuickLinkOrderAction.allCases.enumerated() {
                let item=NSMenuItem(title:action.title,action:#selector(chooseOrder(_:)),keyEquivalent:"");item.target=self;item.tag=index;item.isEnabled=canMove?(action)==true;menu.addItem(item)
            }
            menu.popUp(positioning:nil,at:NSPoint(x:bounds.maxX,y:bounds.midY),in:self)
        }
        @objc private func chooseOrder(_ sender:NSMenuItem) {
            guard NativeQuickLinkOrderAction.allCases.indices.contains(sender.tag) else{return}
            let action=NativeQuickLinkOrderAction.allCases[sender.tag];if canMove?(action)==true {move?(action)}
        }
        deinit{hold?.cancel()}
    }
}

struct NativeQuickLinkDropRegion<Content:View>: View {
    @ObservedObject var drag:NativeQuickLinkDrag
    let groupID:String
    var rowID:String?=nil
    let canPlace:(NativeQuickLinkRow,NativeQuickLinkDropTarget)->Bool
    let commit:(NativeQuickLinkRow,NativeQuickLinkDropTarget)->Void
    @ViewBuilder var content:()->Content
    @State private var height:CGFloat=0
    private var targeted:Bool {drag.target?.groupID==groupID && drag.target?.rowID==rowID}
    var body:some View {
        content()
            .background(GeometryReader {proxy in Color.clear.onAppear{height=proxy.size.height}.onChange(of:proxy.size.height){_,value in height=value}})
            .background(targeted && rowID==nil ? Color.accentColor.opacity(0.10):.clear,in:RoundedRectangle(cornerRadius:7))
            .overlay(alignment:drag.target?.after == true ? .bottom:.top) {
                if targeted,rowID != nil {
                    HStack(spacing:0) {Circle().fill(Color.accentColor).frame(width:5,height:5);Rectangle().fill(Color.accentColor).frame(height:2)}
                        .padding(.horizontal,5).allowsHitTesting(false)
                }
            }
            .onDrop(of:[NativeQuickLinkDrag.pasteboardType.rawValue],delegate:NativeQuickLinkDrop(drag:drag,groupID:groupID,rowID:rowID,height:height,canPlace:canPlace,commit:commit))
    }
}
