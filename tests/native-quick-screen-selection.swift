import Foundation
import CoreGraphics

@main struct ScreenSelectionChecks {
    static func main() {
        typealias S = NativeQuickScreenSelection
        var checks = 0
        func check(_ condition: @autoclosure () -> Bool, _ label: String) {
            precondition(condition(), label); checks += 1; print("PASS \(label)")
        }
        let laptop = S.Display(id: 1, frame: CGRect(x: 0, y: 0, width: 1440, height: 900))
        let right = S.Display(id: 2, frame: CGRect(x: 1440, y: 0, width: 1920, height: 1080))
        let left = S.Display(id: 3, frame: CGRect(x: -1920, y: 200, width: 1920, height: 1080))
        let above = S.Display(id: 4, frame: CGRect(x: 0, y: 1100, width: 1440, height: 900))
        let below = S.Display(id: 5, frame: CGRect(x: 0, y: -1000, width: 1440, height: 900))
        let all = [laptop, right, left, above, below]
        let oldPanel = CGRect(x: 630, y: 864, width: 180, height: 36)
        func choose(_ screens: [S.Display] = all, intent: S.Intent = .anchored,
                    pointer: CGPoint? = CGPoint(x: 1800, y: 400), anchor: UInt32? = 1,
                    panel: CGRect? = oldPanel, main: UInt32? = 1, expanded: Bool = false) -> UInt32? {
            S.select(displays: screens, intent: intent, pointer: pointer, anchorID: anchor,
                     panelFrame: panel, mainID: main, isExpandedOrTransitioning: expanded)
        }
        check(choose(intent: .pointerSummon) == 2, "explicit summon leaves a visible collapsed panel's old screen")
        check(choose() == 1, "default Agent or notification open retains the existing screen")
        check(choose(intent: .pointerSummon, expanded: true) == 1, "opening expanded or closing panel cannot chase the pointer")
        check(choose(pointer: CGPoint(x: -1000, y: 500)) == 1, "entry hover or click retains the hit entry's committed screen")
        check(choose(intent: .pointerSummon, pointer: CGPoint(x: -1000, y: 500)) == 3, "explicit summon supports negative-x displays")
        check(choose(intent: .pointerSummon, pointer: CGPoint(x: 400, y: 1500)) == 4, "explicit summon supports displays above main")
        check(choose(intent: .pointerSummon, pointer: CGPoint(x: 400, y: -500)) == 5, "explicit summon supports negative-y displays")
        check(choose(intent: .pointerSummon, pointer: CGPoint(x: 1440, y: 300)) == 2, "shared edge belongs to the display starting at that edge")
        check(choose(intent: .pointerSummon, pointer: CGPoint(x: 400, y: 1050)) == 4, "pointer in arrangement gap chooses the nearest display")
        check(choose(intent: .pointerSummon, pointer: CGPoint(x: 8000, y: 500)) == 2, "off-display pointer chooses nearest available display")
        check(choose(intent: .pointerSummon, pointer: CGPoint(x: 400, y: 1000)) == 1, "equidistant gap preserves current anchor")

        let mirror = S.Display(id: 9, frame: laptop.frame)
        check(choose([mirror, laptop], intent: .pointerSummon, pointer: CGPoint(x: 20, y: 20), anchor: 9) == 9, "mirrored display tie preserves the committed ID")
        check(choose([mirror, laptop], intent: .pointerSummon, pointer: CGPoint(x: 20, y: 20), anchor: nil) == 1, "mirror without anchor prefers known main")
        check(choose([mirror, laptop], intent: .pointerSummon, pointer: CGPoint(x: 20, y: 20), anchor: nil, main: nil) == 1, "mirror without main has deterministic stable-ID fallback")
        check(choose([right, laptop], anchor: nil, panel: CGRect(x: 1350, y: 600, width: 400, height: 200)) == 2, "missing anchor uses greatest panel overlap")
        check(choose([right, laptop], pointer: nil, anchor: nil, panel: CGRect(x: 1340, y: 600, width: 200, height: 200)) == 1, "equal panel overlap prefers main")
        check(choose([right, above], pointer: CGPoint(x: 400, y: 1500), anchor: 1, panel: CGRect(x: 1600, y: 700, width: 760, height: 380)) == 2, "unplugged anchor falls back to relocated panel before pointer")
        check(choose([right, above], pointer: CGPoint(x: 400, y: 1500)) == 4, "unplugged anchor with no overlap falls back to pointer")
        check(choose([right, above], pointer: nil, panel: nil, main: 4) == 4, "no pointer or surviving panel uses valid main")
        check(choose([right, above], pointer: nil, panel: nil, main: 999) == 2, "stale main safely falls back to connected stable ID")
        check(choose([]) == nil, "empty screen set safely returns nil")
        let invalid = S.Display(id: 7, frame: CGRect(x: 0, y: 0, width: 0, height: 900))
        let nonfinite = S.Display(id: 8, frame: CGRect(x: CGFloat.infinity, y: 0, width: 100, height: 100))
        check(choose([invalid, nonfinite]) == nil, "invalid screen geometry is never selected")
        check(choose([invalid, right], intent: .pointerSummon) == 2, "invalid display cannot hide valid fallback")
        check(choose(intent: .pointerSummon, pointer: CGPoint(x: CGFloat.nan, y: 1)) == 1, "invalid pointer preserves valid anchor")
        check(choose(pointer: nil, anchor: nil, panel: .null) == 1, "invalid panel is ignored safely")
        check(choose([above, left, right, laptop, below], intent: .pointerSummon) == choose(intent: .pointerSummon), "screen enumeration order cannot change selection")
        let resized = S.Display(id: 1, frame: CGRect(x: -200, y: 100, width: 1024, height: 768))
        check(choose([right, resized]) == 1, "resolution or arrangement change preserves connected display ID")

        // Drive a real sequence through selection + existing production geometry.
        // A query (notification context) does not commit the selected display.
        var anchor: UInt32? = 1
        let summoned = choose(intent: .pointerSummon, anchor: anchor)!
        let target = all.first { $0.id == summoned }!
        let geometry = NativeQuickGeometry.resolve(screen: target.frame, visible: target.frame, safeTop: 0, placement: .island)
        anchor = summoned // Host commits only when it applies this geometry.
        check(geometry.expanded.midX == right.frame.midX && geometry.expanded.maxY == right.frame.maxY, "chosen secondary screen feeds existing top-anchored island geometry")
        check(choose(pointer: CGPoint(x: -1000, y: 500), anchor: anchor, panel: geometry.expanded, expanded: true) == 2, "pointer movement after summon cannot move expanded content")
        _ = choose([laptop], pointer: CGPoint(x: 100, y: 500), anchor: anchor)
        check(anchor == 2, "read-only notification selection cannot mutate host anchor")
        check(choose(pointer: CGPoint(x: -1000, y: 500), anchor: anchor, panel: geometry.collapsed) == 2, "Space change and collapse retain current physical display")
        check(choose([laptop], pointer: CGPoint(x: 100, y: 500), anchor: anchor, panel: geometry.expanded, expanded: true) == 1, "disconnect still recovers while presentation is expanded")
        print("\(checks) screen selection assertions passed")
    }
}
