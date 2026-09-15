import AppKit
import WebKit

struct GlassRegion:Decodable {
    let id:String;let x:Double;let y:Double;let width:Double;let height:Double;let radius:Double
    var valid:Bool { [x,y,width,height,radius].allSatisfy{$0.isFinite && abs($0)<100_000} && width>0 && height>0 && radius>=0 && ["composer","reader","modal"].contains(id) }
}
@available(macOS 26.0,*) private final class PassiveGlass:NSGlassEffectView {
    override func hitTest(_ point:NSPoint)->NSView? {nil}
    override var acceptsFirstResponder:Bool {false}
}
/// An opaque application-owned backdrop prevents any other window from appearing through web cutouts.
final class WebGlassHost:NSView {
    let web:WKWebView
    private var regions:[String:NSView]=[:]
    private var transparentWeb=false
    private var dimmed=false
    override var isFlipped:Bool {true}
    override var isOpaque:Bool {true}
    init(web:WKWebView){
        self.web=web;super.init(frame:.zero);wantsLayer=true
        // WKWebView has no public macOS equivalent of WebView.drawsBackground.
        // Keep this guarded compatibility shim confined to the local migration preview.
        if web.responds(to:NSSelectorFromString("_setDrawsBackground:")){web.setValue(false,forKey:"drawsBackground");transparentWeb=true}
        web.underPageBackgroundColor = .clear;addSubview(web);web.autoresizingMask=[.width,.height]
    }
    required init?(coder:NSCoder){fatalError("init(coder:) has not been implemented")}
    override func layout(){super.layout();web.frame=bounds}
    override func viewDidChangeEffectiveAppearance(){super.viewDidChangeEffectiveAppearance();needsDisplay=true}
    override func draw(_ dirtyRect:NSRect){
        let dark=effectiveAppearance.bestMatch(from:[.aqua,.darkAqua]) == .darkAqua
        let base=dark ? NSColor(srgbRed:0.105,green:0.112,blue:0.12,alpha:1):NSColor(srgbRed:0.965,green:0.979,blue:0.973,alpha:1)
        base.setFill();bounds.fill()
        let mint=dark ? NSColor(srgbRed:0.13,green:0.16,blue:0.15,alpha:1):NSColor(srgbRed:0.89,green:0.96,blue:0.925,alpha:1)
        let sky=dark ? NSColor(srgbRed:0.14,green:0.155,blue:0.17,alpha:1):NSColor(srgbRed:0.925,green:0.957,blue:0.98,alpha:1)
        NSGradient(colors:[base,mint,sky,base])?.draw(in:bounds,angle:24)
        if dimmed {NSColor.black.withAlphaComponent(dark ? 0.16:0.09).setFill();bounds.fill()}
    }
    func apply(_ requested:[GlassRegion])->Bool {
        guard #available(macOS 26.0,*),transparentWeb,!NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency else {clear();return false}
        guard requested.count<=3,requested.allSatisfy(\.valid),Set(requested.map(\.id)).count==requested.count else {clear();return false}
        let wantsDim=requested.contains{$0.id=="modal"};if wantsDim != dimmed{dimmed=wantsDim;needsDisplay=true}
        let ids=Set(requested.map(\.id));for id in Array(regions.keys) where !ids.contains(id){regions.removeValue(forKey:id)?.removeFromSuperview()}
        CATransaction.begin();CATransaction.setDisableActions(true)
        for region in requested {
            let rect=NSRect(x:region.x,y:region.y,width:region.width,height:region.height).intersection(bounds)
            guard !rect.isNull,!rect.isEmpty else {regions.removeValue(forKey:region.id)?.removeFromSuperview();continue}
            let effect:PassiveGlass
            if let existing=regions[region.id] as? PassiveGlass {effect=existing}
            else {effect=PassiveGlass(frame:.zero);effect.contentView=NSView();effect.style = .regular;effect.tintColor=nil;addSubview(effect,positioned:.below,relativeTo:web);regions[region.id]=effect}
            effect.frame=rect;effect.cornerRadius=min(region.radius,min(rect.width,rect.height)/2)
        }
        CATransaction.commit();return true
    }
    func clear(){dimmed=false;needsDisplay=true;regions.values.forEach{$0.removeFromSuperview()};regions.removeAll()}
    var materialCount:Int {regions.count}
}
