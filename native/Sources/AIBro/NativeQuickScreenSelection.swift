import Foundation
import CoreGraphics

/// Pure display selection in AppKit screen coordinates. The caller commits the
/// returned ID only after applying geometry; asking where to show a notification
/// must not change the entry's anchor. No pointer polling or window side effects.
enum NativeQuickScreenSelection {
    struct Display: Equatable {
        let id: UInt32
        let frame: CGRect
    }

    enum Intent { case anchored, pointerSummon }

    static func select(displays: [Display], intent: Intent = .anchored,
                       pointer: CGPoint?, anchorID: UInt32?, panelFrame: CGRect?,
                       mainID: UInt32?, isExpandedOrTransitioning: Bool = false) -> UInt32? {
        let usable = displays.filter { valid($0.frame) }.sorted { $0.id < $1.id }
        guard !usable.isEmpty else { return nil }
        let anchor = usable.first { $0.id == anchorID }
        let main = usable.first { $0.id == mainID }

        // Mirrored frames and exact distance ties must not depend on the order
        // of NSScreen.screens or cause a committed panel to bounce between IDs.
        func preferred(_ candidates: [Display]) -> Display? {
            candidates.first { $0.id == anchorID }
                ?? candidates.first { $0.id == mainID }
                ?? candidates.first
        }

        func atPointer() -> Display? {
            guard let pointer, pointer.x.isFinite, pointer.y.isFinite else { return nil }
            // Half-open bounds assign an adjoining edge to one display.
            let containing = usable.filter {
                pointer.x >= $0.frame.minX && pointer.x < $0.frame.maxX
                    && pointer.y >= $0.frame.minY && pointer.y < $0.frame.maxY
            }
            if !containing.isEmpty { return preferred(containing) }
            let distances = usable.map { display -> (Display, Double) in
                let rect = display.frame
                let dx = max(rect.minX - pointer.x, 0, pointer.x - rect.maxX)
                let dy = max(rect.minY - pointer.y, 0, pointer.y - rect.maxY)
                return (display, hypot(Double(dx), Double(dy)))
            }
            guard let nearest = distances.map(\.1).min() else { return nil }
            return preferred(distances.filter { $0.1 == nearest }.map(\.0))
        }

        func atPanel() -> Display? {
            guard let panelFrame, valid(panelFrame) else { return nil }
            let overlaps = usable.map { display -> (Display, CGFloat) in
                let intersection = display.frame.intersection(panelFrame)
                return (display, intersection.isNull ? 0 : intersection.width * intersection.height)
            }
            guard let largest = overlaps.map(\.1).max(), largest > 0 else { return nil }
            return preferred(overlaps.filter { $0.1 == largest }.map(\.0))
        }

        // Only an explicit, collapsed-to-expanded invocation can follow the
        // pointer. Agent opens, entry hits, notifications, Space changes and
        // layout updates retain the live anchor through opening and closing.
        if intent == .pointerSummon, !isExpandedOrTransitioning, let target = atPointer() {
            return target.id
        }
        return (anchor ?? atPanel() ?? atPointer() ?? main ?? usable.first)?.id
    }

    private static func valid(_ rect: CGRect) -> Bool {
        rect.origin.x.isFinite && rect.origin.y.isFinite
            && rect.width.isFinite && rect.height.isFinite
            && rect.width > 0 && rect.height > 0
            && rect.maxX.isFinite && rect.maxY.isFinite
    }
}
