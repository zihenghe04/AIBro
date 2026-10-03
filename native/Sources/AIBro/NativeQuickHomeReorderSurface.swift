import AppKit
import SwiftUI

@MainActor final class NativeQuickHomeReorderController: ObservableObject {
    @Published private(set) var interaction = NativeQuickHomeReorder()
    private final class WeakSurface {
        weak var value: NativeQuickHomeReorderSurface.View?
        init(_ value: NativeQuickHomeReorderSurface.View) { self.value = value }
    }
    private var surfaces: [String: WeakSurface] = [:]
    private weak var sourceView: NativeQuickHomeReorderSurface.View?
    private var hold: DispatchWorkItem?
    private var monitor: Any?
    private var observers: [NSObjectProtocol] = []
    private var cursorPushed = false
    private var completion: ((NativeQuickHomeReorder.Commit) -> Void)?
    var reduceMotion = false

    func register(_ view: NativeQuickHomeReorderSurface.View) { surfaces[view.moduleID] = WeakSurface(view) }
    func remove(_ view: NativeQuickHomeReorderSurface.View) {
        if sourceView === view { cancel(animated: false) }
        if surfaces[view.moduleID]?.value === view { surfaces.removeValue(forKey: view.moduleID) }
    }
    func begin(_ view: NativeQuickHomeReorderSurface.View, point: CGPoint) {
        guard view.enabled, let window = view.window, interaction.phase == .idle else { return }
        let frames = surfaces.compactMapValues { entry -> CGRect? in
            guard let item = entry.value, item.enabled, item.window === window else { return nil }
            return item.convert(item.bounds, to: nil)
        }
        // The source can be partially clipped by its ScrollView. The target may
        // be offscreen in the same canvas but must not accept an invisible drop.
        var viewport = window.contentView.map { $0.convert($0.bounds, to: nil) } ?? .zero
        var ancestor = view.superview
        while let current = ancestor {
            if current is NSClipView { viewport = viewport.intersection(current.convert(current.bounds, to: nil)) }
            ancestor = current.superview
        }
        guard let token = interaction.begin(source: view.moduleID, point: point,
            now: ProcessInfo.processInfo.systemUptime, order: view.visibleIDs, frames: frames, viewport: viewport) else { return }
        sourceView = view; completion = view.commit
        let work = DispatchWorkItem { [weak self, weak view] in
            guard let self, let view, view.enabled, view.window === window, self.sourceView === view else { return }
            if self.interaction.activate(token: token, now: ProcessInfo.processInfo.systemUptime) {
                NSCursor.closedHand.push(); self.cursorPushed = true
            }
        }
        hold = work
        DispatchQueue.main.asyncAfter(deadline: .now() + NativeQuickHomeReorder.holdDuration, execute: work)
        // This monitor exists only for the one press. It never observes events
        // from other apps, never changes firstResponder, and passes scroll on.
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .scrollWheel, .rightMouseDown, .otherMouseDown]) { [weak self, weak window] event in
            let consume = MainActor.assumeIsolated {
                guard let self, event.window === window else { return false }
                if event.type == .keyDown {
                    if event.keyCode == 53 { self.cancel(); return true }
                    // Typing in an existing editor cancels a pending gesture;
                    // the event still reaches that editor, including IME input.
                    self.cancel()
                } else { self.cancel() }
                return false
            }
            return consume ? nil : event
        }
        for name in [NSWindow.didResignKeyNotification, NSWindow.willCloseNotification, NSWindow.didResizeNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.cancel(animated: false) }
            })
        }
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.cancel(animated: false) }
        })
    }
    func move(_ view: NativeQuickHomeReorderSurface.View, point: CGPoint) {
        guard sourceView === view else { return }
        interaction.move(to: point)
        if interaction.phase == .idle { cleanup() }
    }
    func finish(_ view: NativeQuickHomeReorderSurface.View, point: CGPoint) {
        guard sourceView === view else { return }
        interaction.move(to: point)
        let callback = completion
        withAnimation(reduceMotion ? nil : .timingCurve(0.22, 1, 0.36, 1, duration: 0.56)) {
            let commit = interaction.finish()
            cleanup()
            if let commit { callback?(commit) }
        }
    }
    func cancel(animated: Bool = true) {
        guard interaction.phase != .idle || sourceView != nil else { return }
        withAnimation(animated && !reduceMotion ? .easeOut(duration: 0.18) : nil) { interaction.cancel() }
        cleanup()
    }
    private func cleanup() {
        hold?.cancel(); hold = nil
        if let monitor { NSEvent.removeMonitor(monitor) }; monitor = nil
        observers.forEach { NotificationCenter.default.removeObserver($0) }; observers.removeAll()
        if cursorPushed { NSCursor.pop(); cursorPushed = false }
        sourceView = nil; completion = nil
    }
    deinit {
        hold?.cancel()
        if let monitor { NSEvent.removeMonitor(monitor) }
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        if cursorPushed { NSCursor.pop() }
    }
}

struct NativeQuickHomeReorderSurface: NSViewRepresentable {
    let id: String
    let title: String
    let controller: NativeQuickHomeReorderController
    let visibleIDs: [String]
    let headerTop: CGFloat
    var headerTrailingInset: CGFloat = 64
    let enabled: Bool
    let commit: (NativeQuickHomeReorder.Commit) -> Void
    func makeNSView(context: Context) -> View { View() }
    func updateNSView(_ view: View, context: Context) {
        view.moduleID = id; view.controller = controller; view.visibleIDs = visibleIDs
        view.headerTop = headerTop; view.headerTrailingInset = headerTrailingInset
        view.enabled = enabled; view.commit = commit
        view.toolTip = nativeUI("长按标题或卡片边缘后拖动，松手交换位置；Esc 取消。", "Hold the title or card edge, then drag to swap. Esc cancels.")
        view.setAccessibilityElement(false)
        controller.register(view)
    }
    static func dismantleNSView(_ view: View, coordinator: ()) { view.controller?.remove(view); view.commit = nil }
    final class View: NSView {
        var moduleID = ""
        weak var controller: NativeQuickHomeReorderController?
        var visibleIDs: [String] = []
        var headerTop: CGFloat = 12
        var headerTrailingInset: CGFloat = 64
        var enabled = false {
            didSet { if !enabled && oldValue { controller?.remove(self) } }
        }
        var commit: ((NativeQuickHomeReorder.Commit) -> Void)?
        override var isFlipped: Bool { true }
        override var acceptsFirstResponder: Bool { false }
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
        override func hitTest(_ point: NSPoint) -> NSView? {
            let local = convert(point, from: superview)
            return enabled && NativeQuickHomeReorderHitRegion.contains(local, in: bounds.size, headerTop: headerTop,
                headerTrailingInset: headerTrailingInset) ? self : nil
        }
        override func mouseDown(with event: NSEvent) {
            guard event.buttonNumber == 0, event.clickCount == 1 else { return }
            controller?.begin(self, point: event.locationInWindow)
        }
        override func mouseDragged(with event: NSEvent) { controller?.move(self, point: event.locationInWindow) }
        override func mouseUp(with event: NSEvent) { controller?.finish(self, point: event.locationInWindow) }
        override func viewWillMove(toWindow newWindow: NSWindow?) {
            if window !== newWindow { controller?.remove(self) }
            super.viewWillMove(toWindow: newWindow)
        }
        override func resetCursorRects() {
            super.resetCursorRects()
            guard enabled else { return }
            let header = NativeQuickHomeReorderHitRegion.headerRect(in: bounds.size, headerTop: headerTop,
                headerTrailingInset: headerTrailingInset)
            if header.width > 0 { addCursorRect(header, cursor: .openHand) }
        }
    }
}
