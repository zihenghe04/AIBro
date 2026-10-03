import AppKit
import SwiftUI

func nativeUI(_ zh: String, _ en: String) -> String { en }

@MainActor private final class Canvas: NSScrollView {
    var received = 0
    override func scrollWheel(with event: NSEvent) { received += 1 }
}

@main struct Checks {
    @MainActor static func main() {
        var count = 0
        func check(_ value: @autoclosure () -> Bool, _ label: String) {
            precondition(value(), label); count += 1; print("PASS \(count): \(label)")
        }
        typealias G = NativeQuickBentoGeometry
        let original = ["medium", "mini", "large", "small", "medium", "medium", "mini"].map { G.Dimension(size: $0) }
        for width: CGFloat in [372, 728] {
            let columns = width < 600 ? 2 : 4
            for n in 1...6 {
                let result = G.resolve(dimensions: Array(original.prefix(n)), width: width,
                    viewportHeight: 310, minimumRowHeight: 88, automatic: true)
                let rows = result.slots.map { $0.row + $0.rows }.max()!
                var cells = Array(repeating: 0, count: columns * rows)
                for slot in result.slots {
                    for y in slot.row..<(slot.row + slot.rows) {
                        for x in slot.column..<(slot.column + slot.columns) { cells[y * columns + x] += 1 }
                    }
                }
                check(result.slots.count == n && cells.allSatisfy { $0 == 1 }, "\(columns) columns / \(n) cards: complete compact template without holes/overlap")
                check(result.frames.allSatisfy { $0.minX >= 0 && $0.maxX <= width + 0.01 && $0.height >= 186 }, "\(columns) columns / \(n) cards: readable controls within horizontal canvas")
                if n == 1 { check(result.frames[0] == CGRect(x: 0, y: 0, width: width, height: 310), "Single remaining card fills real viewport") }
            }
        }
        let before = G.resolve(dimensions: original, width: 728, viewportHeight: 310,
            minimumRowHeight: 88, automatic: false, compactWindowIndex: 2)
        _ = G.resolve(dimensions: Array(original.prefix(2)), width: 728, viewportHeight: 310,
            minimumRowHeight: 88, automatic: true)
        check(before == G.resolve(dimensions: original, width: 728, viewportHeight: 310,
            minimumRowHeight: 88, automatic: false, compactWindowIndex: 2), "Restoring all cards preserves original order, size and compact window preference")

        typealias O = NativeQuickCaptureScrollOwnership
        var owner = O()
        var time: TimeInterval = 0
        func sample(_ phase: NSEvent.Phase = [], momentum: NSEvent.Phase = [], precise: Bool = true, moves: Bool = true) -> O.Sample {
            time += 0.02; return .init(precise: precise, phase: phase, momentum: momentum, timestamp: time, moves: moves)
        }
        check(owner.route(sample(.mayBegin, moves: false), editorCanStart: false) == .canvas && owner.owner == nil, "Zero-delta preflight does not reserve an owner")
        check(owner.route(sample(.began), editorCanStart: true) == .editor, "Focused scrollable text claims new gesture")
        check(owner.route(sample(.changed), editorCanStart: false) == .editor, "Reaching boundary cannot transfer an active editor gesture")
        check(owner.route(sample(.ended), editorCanStart: false) == .editor, "Touch end keeps owner for following momentum")
        check(owner.route(sample(momentum: .began), editorCanStart: false) == .editor, "Momentum belongs to original editor")
        check(owner.route(sample(momentum: .ended), editorCanStart: false) == .editor && owner.owner == nil, "Momentum completion releases ownership")
        check(owner.route(sample(.began), editorCanStart: false) == .canvas, "New outward gesture at editor boundary passes to canvas")
        check(owner.route(sample(.changed), editorCanStart: true) == .canvas, "Focus change cannot steal a gesture already scrolling canvas")
        check(owner.route(sample(.cancelled), editorCanStart: true) == .canvas && owner.owner == nil, "Cancellation releases original owner")
        _ = owner.route(sample(.began), editorCanStart: true)
        check(owner.route(sample(precise: false), editorCanStart: false) == .canvas && owner.owner == nil, "Traditional wheel uses current event, not stale momentum lease")

        // Hidden AppKit hierarchy only. No screen event posting or ordered window.
        _ = NSApplication.shared
        let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 500, height: 400),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let canvas = Canvas(frame: CGRect(x: 0, y: 0, width: 500, height: 400))
        let document = NSView(frame: CGRect(x: 0, y: 0, width: 500, height: 900))
        canvas.documentView = document; window.contentView = canvas
        let inner = NativeQuickCaptureScrollView(frame: CGRect(x: 20, y: 500, width: 300, height: 100))
        let text = NativeQuickCaptureTextView(frame: CGRect(x: 0, y: 0, width: 280, height: 600))
        text.string = (0..<50).map { "Synthetic line \($0)" }.joined(separator: "\n")
        text.isVerticallyResizable = false
        inner.documentView = text; document.addSubview(inner)
        inner.routesHomeWheel = true
        window.contentView?.layoutSubtreeIfNeeded()
        func wheel(_ dy: Int32) -> NSEvent {
            let raw = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1,
                wheel1: dy, wheel2: 0, wheel3: 0)!
            return NSEvent(cgEvent: raw)!
        }
        _ = window.makeFirstResponder(nil)
        inner.scrollWheel(with: wheel(-3))
        check(canvas.received == 1, "Actual embedded NSScrollView forwards unfocused event once to real enclosing canvas")
        check(window.makeFirstResponder(text), "Hidden window accepts real NSTextView as first responder")
        inner.contentView.scroll(to: CGPoint(x: 0, y: 100)); inner.reflectScrolledClipView(inner.contentView)
        inner.scrollWheel(with: wheel(-3))
        check(canvas.received == 2, "Platform default focus on a long draft is not explicit editing and still scrolls canvas")
        let key = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 1,
            windowNumber: window.windowNumber, context: nil, characters: "x", charactersIgnoringModifiers: "x", isARepeat: false, keyCode: 7)!
        text.keyDown(with: key)
        inner.contentView.scroll(to: CGPoint(x: 0, y: 100)); inner.reflectScrolledClipView(inner.contentView)
        inner.scrollWheel(with: wheel(-3))
        check(canvas.received == 2, "Real text keyDown activates inner scrolling without also moving canvas")
        inner.contentView.scroll(to: .zero); inner.reflectScrolledClipView(inner.contentView)
        inner.scrollWheel(with: wheel(3))
        check(canvas.received == 3, "New outward event at top reaches enclosing canvas")
        text.isEditable = false
        inner.scrollWheel(with: wheel(-3))
        check(canvas.received == 4, "Locked editor cannot capture home scrolling")
        text.isEditable = true
        _ = window.makeFirstResponder(nil); _ = window.makeFirstResponder(text)
        inner.contentView.scroll(to: CGPoint(x: 0, y: 100)); inner.reflectScrolledClipView(inner.contentView)
        inner.scrollWheel(with: wheel(-3))
        check(canvas.received == 5, "Resigning and default refocusing cannot retain a previous editing gesture lease")
        text.isEditable = true; inner.routesHomeWheel = false
        inner.contentView.scroll(to: CGPoint(x: 0, y: 100)); inner.reflectScrolledClipView(inner.contentView)
        inner.scrollWheel(with: wheel(-3))
        check(canvas.received == 5, "Independent editor keeps standard scroll behavior")
        window.close()
        print("PASS: \(count) compact geometry, gesture ownership and real AppKit routing checks")
    }
}
