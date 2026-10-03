import AppKit

/// The compact home adds an outer scrolling canvas that upstream's fixed grid
/// does not have. Choose one owner at gesture start, including its momentum;
/// never send the same wheel event to both the editor and its parent canvas.
struct NativeQuickCaptureScrollOwnership {
    enum Owner { case editor, canvas }
    struct Sample {
        var precise: Bool
        var phase: NSEvent.Phase
        var momentum: NSEvent.Phase
        var timestamp: TimeInterval
        var moves: Bool
    }
    private(set) var owner: Owner?
    private var lastTime: TimeInterval = 0
    mutating func reset() { owner = nil; lastTime = 0 }

    mutating func route(_ sample: Sample, editorCanStart: Bool) -> Owner {
        let candidate: Owner = editorCanStart ? .editor : .canvas
        // Traditional wheels have no continuing gesture/momentum contract.
        guard sample.precise else { reset(); return candidate }
        if sample.phase.contains(.began) || sample.phase.contains(.mayBegin) {
            owner = nil
        } else if sample.phase.isEmpty, sample.momentum.isEmpty,
                  sample.timestamp - lastTime > 0.25 {
            // Some third-party precision mice provide deltas but no phases.
            owner = nil
        }
        lastTime = sample.timestamp
        let selected = owner ?? candidate
        if sample.moves { owner = selected }
        // An ordinary phase.ended precedes momentum.began: retain its owner.
        if sample.phase.contains(.cancelled) || sample.momentum.contains(.ended)
            || sample.momentum.contains(.cancelled) { reset() }
        return selected
    }
}

final class NativeQuickCaptureScrollView: NSScrollView {
    var routesHomeWheel = false {
        didSet { if oldValue != routesHomeWheel { ownership.reset(); userEditing = false } }
    }
    private var ownership = NativeQuickCaptureScrollOwnership()
    private var userEditing = false

    // A nonactivating panel may choose the note as its initial first responder.
    // That platform default is not evidence that the user entered the editor.
    func beginUserEditing() { if routesHomeWheel { userEditing = true } }
    func endUserEditing() { userEditing = false }

    override func viewWillMove(toWindow newWindow: NSWindow?) {
        ownership.reset(); userEditing = false
        super.viewWillMove(toWindow: newWindow)
    }

    override func scrollWheel(with event: NSEvent) {
        guard routesHomeWheel, let canvas = enclosingCanvas else {
            ownership.reset(); super.scrollWheel(with: event); return
        }
        let focused = userEditing && window?.firstResponder === documentView
            && (documentView as? NSTextView)?.isEditable != false
        let route = ownership.route(.init(precise: event.hasPreciseScrollingDeltas,
            phase: event.phase, momentum: event.momentumPhase, timestamp: event.timestamp,
            moves: event.scrollingDeltaX != 0 || event.scrollingDeltaY != 0),
            editorCanStart: focused && canScrollVertically(delta: event.scrollingDeltaY))
        if route == .canvas {
            canvas.scrollWheel(with: event)
        } else if focused {
            super.scrollWheel(with: event)
        }
        // If a click moved focus during editor momentum, consume the remainder
        // rather than moving an unrelated canvas or scrolling an inactive editor.
    }

    private var enclosingCanvas: NSScrollView? {
        var ancestor = superview
        while let view = ancestor {
            if let scroll = view as? NSScrollView, scroll.window === window { return scroll }
            ancestor = view.superview
        }
        return nil
    }

    private func canScrollVertically(delta: CGFloat) -> Bool {
        guard let documentView, delta != 0 else { return false }
        let visible = contentView.bounds
        let low = documentView.bounds.minY
        let high = max(low, documentView.bounds.maxY - visible.height)
        guard high - low > 0.5 else { return false }
        let towardStart = documentView.isFlipped ? delta > 0 : delta < 0
        return towardStart ? visible.minY > low + 0.5 : visible.minY < high - 0.5
    }
}
