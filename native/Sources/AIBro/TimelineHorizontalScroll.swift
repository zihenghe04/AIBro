import SwiftUI
import AppKit

/// AppKit owns wheel delivery so the enclosing vertical SwiftUI scroll view
/// cannot swallow horizontal trackpad gestures over a Charts plot.
struct TimelineHorizontalScroll<Content:View>:NSViewRepresentable {
    let width:CGFloat
    let height:CGFloat
    @ViewBuilder var content:()->Content
    func makeNSView(context:Context)->NSScrollView {
        let scroll=TimelineScrollView()
        scroll.drawsBackground=false
        scroll.hasHorizontalScroller=true
        scroll.hasVerticalScroller=false
        scroll.autohidesScrollers=false
        scroll.horizontalScrollElasticity = .allowed
        scroll.verticalScrollElasticity = .none
        scroll.documentView=TimelineHostingView(rootView:content())
        return scroll
    }
    func updateNSView(_ scroll:NSScrollView,context:Context) {
        guard let host=scroll.documentView as? NSHostingView<Content> else{return}
        host.rootView=content()
        host.frame=NSRect(x:0,y:0,width:width,height:height)
    }
}
private final class TimelineHostingView<Content:View>:NSHostingView<Content> {
    override func scrollWheel(with event:NSEvent) { enclosingScrollView?.scrollWheel(with:event) }
}
private final class TimelineScrollView:NSScrollView {
    private var wheelMonitor:Any?
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let wheelMonitor {NSEvent.removeMonitor(wheelMonitor);self.wheelMonitor=nil}
        guard window != nil else{return}
        // Swift Charts installs its own gesture recognizers inside NSHostingView.
        // Route only horizontal events inside this viewport before those consume them.
        wheelMonitor=NSEvent.addLocalMonitorForEvents(matching:.scrollWheel) {[weak self] event in
            guard let self,event.window === self.window,
                  self.visibleRect.contains(self.convert(event.locationInWindow,from:nil)),
                  abs(event.scrollingDeltaX)>0.01 else{return event}
            self.moveHorizontally(event)
            return nil
        }
    }
    deinit {if let wheelMonitor {NSEvent.removeMonitor(wheelMonitor)}}
    private func moveHorizontally(_ event:NSEvent) {
        let maximum=max(0,(documentView?.frame.width ?? 0)-contentView.bounds.width)
        let delta=event.hasPreciseScrollingDeltas ? event.scrollingDeltaX:event.scrollingDeltaX*16
        contentView.scroll(to:NSPoint(x:min(maximum,max(0,contentView.bounds.origin.x-delta)),y:0))
        reflectScrolledClipView(contentView)
    }
    override func scrollWheel(with event:NSEvent) {
        if abs(event.scrollingDeltaX)>0.01 {moveHorizontally(event)}
        else {nextResponder?.scrollWheel(with:event)}
    }
}
