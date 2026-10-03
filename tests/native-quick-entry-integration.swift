import AppKit
import SwiftUI

func nativeUI(_ zh: String, _ en: String) -> String { en }

@main struct EntryIntegrationChecks {
    @MainActor static func main() {
        _ = NSApplication.shared // In-memory views only; never shows or activates a window.
        var checks = 0
        func check(_ condition: @autoclosure () -> Bool, _ label: String) {
            precondition(condition(), label); checks += 1; print("PASS \(label)")
        }
        for (width, padding): (CGFloat, CGFloat) in [(320, 12), (220, 8)] {
            let parent = NSView(frame: CGRect(x: 0, y: 0, width: width + 40, height: 150))
            let surface = NativeQuickHomeReorderSurface.View(frame: CGRect(x: 20, y: 30, width: width, height: 88))
            surface.headerTop = padding; surface.headerTrailingInset = 96; surface.enabled = true
            // Match the actual note tile's three 19pt controls and 6pt gaps.
            let buttons = (0..<3).map { index -> NSButton in
                let rect = CGRect(x: width - padding - 19 - CGFloat(index) * 25, y: padding, width: 19, height: 19)
                let button = NSButton(frame: .zero); button.title = "\(index)"
                parent.addSubview(button)
                return button
            }
            parent.addSubview(surface)
            for (index, button) in buttons.enumerated() {
                let rect = CGRect(x: width - padding - 19 - CGFloat(index) * 25, y: padding, width: 19, height: 19)
                button.frame = surface.convert(rect, to: parent)
                let samples = [rect.minX + 1, rect.midX, rect.maxX - 1]
                check(samples.allSatisfy { x in
                    let point = surface.convert(CGPoint(x: x, y: rect.midY), to: parent)
                    guard surface.hitTest(point) == nil, let hit = parent.hitTest(point) else { return false }
                    return hit === button || hit.isDescendant(of: button)
                }, "\(Int(width))pt tile header control \(index) passes through the actual overlay")
            }
            let title = surface.convert(CGPoint(x: 35, y: padding + 9), to: parent)
            check(surface.hitTest(title) === surface, "\(Int(width))pt inert title still supports reorder")
            let edge = surface.convert(CGPoint(x: 3, y: 45), to: parent)
            check(surface.hitTest(edge) === surface, "\(Int(width))pt outer edge still supports reorder")
            let body = surface.convert(CGPoint(x: 50, y: 50), to: parent)
            check(surface.hitTest(body) == nil, "\(Int(width))pt body editor remains unobstructed")
            let header = NativeQuickHomeReorderHitRegion.headerRect(in: surface.bounds.size, headerTop: padding, headerTrailingInset: 96)
            check(header.maxX == width - 96, "\(Int(width))pt cursor rectangle uses the same reserved control region")
            surface.enabled = false
            check(surface.hitTest(title) == nil, "\(Int(width))pt disabled surface never intercepts controls")
        }
        check(NativeQuickHomeReorderHitRegion.headerRect(in: CGSize(width: 320, height: 88), headerTop: 12).maxX == 256,
              "unchanged two-control modules retain the existing 64pt exclusion")

        let old = FixtureScreen(id: 1, frame: CGRect(x: 0, y: 0, width: 1440, height: 900))
        let above = FixtureScreen(id: 2, frame: CGRect(x: 0, y: 1100, width: 1440, height: 900))
        let right = FixtureScreen(id: 3, frame: CGRect(x: 1440, y: 0, width: 1920, height: 1080))
        let menu = CGRect(x: 1350, y: 878, width: 24, height: 22)
        let host = FixtureGeometryHost()
        host.statusItem = .init(button: .init(window: .init(screen: old, frame: menu)))
        host.updateGeometry(on: above)
        let expectedAbove = NativeQuickGeometry.resolve(screen: above.frame, visible: above.visibleFrame, safeTop: 0, placement: .menu)
        let oldWrong = NativeQuickGeometry.resolve(screen: above.frame, visible: above.visibleFrame, safeTop: 0, placement: .menu, menuAnchor: menu)
        check(oldWrong.expanded.minY == above.frame.minY + 10 && oldWrong != expectedAbove,
              "old cross-display menu anchor reproduces bottom-edge placement")
        check(host.geometry == expectedAbove && host.screenAnchorID == 2,
              "actual Entry updateGeometry ignores menu anchor from a different screen")
        host.updateGeometry(on: right)
        check(host.geometry == NativeQuickGeometry.resolve(screen: right.frame, visible: right.visibleFrame, safeTop: 0, placement: .menu),
              "side display also uses its own top-center fallback")
        host.updateGeometry(on: old)
        check(host.geometry == NativeQuickGeometry.resolve(screen: old.frame, visible: old.visibleFrame, safeTop: 0, placement: .menu, menuAnchor: menu),
              "same display preserves real menu-bar button anchoring")
        host.statusItem = .init(button: .init(window: .init(screen: nil, frame: menu)))
        host.updateGeometry(on: old)
        check(host.geometry == NativeQuickGeometry.resolve(screen: old.frame, visible: old.visibleFrame, safeTop: 0, placement: .menu),
              "menu window without screen cannot inject stale coordinates")
        print("\(checks) entry integration assertions passed")
    }
}
