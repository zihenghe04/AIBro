import AppKit
import SwiftUI
import Combine

struct NativeQuickWindowFrames: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, new in new })
    }
}

@MainActor final class NativeQuickWindowInteractionController: ObservableObject {
    @Published private(set) var gesture = NativeQuickWindowInteraction()
    @Published private(set) var pointer: CGPoint?
    private(set) var frames: [String: CGRect] = [:]
    private(set) var bounds = CGRect.zero
    private(set) var owner: UInt64 = 0
    private(set) var enabled = false
    private var hold: Timer?
    private var pendingPointer: DispatchWorkItem?
    private var latestPointer: CGPoint?
    private var lastPointerTime: TimeInterval = 0
    var onHide: ((String, UInt64) -> Void)?
    var now: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }

    func configure(frames: [String: CGRect], bounds: CGRect, owner: UInt64, enabled: Bool) {
        if self.frames != frames || self.bounds != bounds || self.owner != owner || !enabled {
            cancel()
        }
        self.frames = frames; self.bounds = bounds; self.owner = owner; self.enabled = enabled
    }
    func press(_ point: CGPoint) {
        guard enabled, let id = frames.keys.sorted().first(where: { frames[$0]?.contains(point) == true }),
              let frame = frames[id], let token = gesture.begin(id: id, at: point, now: now(), frame: frame, bounds: bounds, owner: owner) else { return }
        hold?.invalidate()
        let expectedOwner = owner
        let timer = Timer(timeInterval: NativeQuickWindowInteraction.holdDuration, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.enabled, self.owner == expectedOwner else { return }
                _ = self.activate(token: token)
            }
        }
        hold = timer
        RunLoop.main.add(timer, forMode: .common)
    }
    @discardableResult func activate(token: UUID) -> Bool {
        guard enabled else { return false }
        let changed = gesture.activate(token: token, now: now(), owner: owner)
        if changed { setPointer(nil) }
        return changed
    }
    func move(_ point: CGPoint) {
        let wasPressing = gesture.phase == .pressing
        gesture.move(to: point, now: now())
        if wasPressing && gesture.phase == .idle { hold?.invalidate(); hold = nil }
        if gesture.phase == .idle { hover(bounds.contains(point) ? point : nil) }
    }
    @discardableResult func release(_ point: CGPoint) -> Bool {
        let dragged = gesture.phase == .dragging
        let expectedOwner = owner
        let result = enabled ? gesture.finish(at: point, now: now(), owner: owner) : nil
        hold?.invalidate(); hold = nil
        if !enabled { gesture.cancel(now: now()) }
        if let result { onHide?(result, expectedOwner) }
        return dragged
    }
    func cancel() {
        hold?.invalidate(); hold = nil
        if gesture.phase != .idle { gesture.cancel(now: now()) }
        setPointer(nil)
    }
    func mayActivate() -> Bool { enabled && gesture.mayActivate(now: now()) }
    func hover(_ point: CGPoint?) {
        guard enabled, gesture.phase != .dragging else { setPointer(nil); return }
        latestPointer = point
        guard point != nil else { setPointer(nil); return }
        let elapsed = now() - lastPointerTime
        if elapsed >= 1.0/60 { flushPointer() }
        else if pendingPointer == nil {
            let work = DispatchWorkItem { [weak self] in
                MainActor.assumeIsolated { self?.pendingPointer = nil; self?.flushPointer() }
            }
            pendingPointer = work
            DispatchQueue.main.asyncAfter(deadline: .now() + max(0, 1.0/60-elapsed), execute: work)
        }
    }
    private func flushPointer() {
        guard enabled, gesture.phase != .dragging else { setPointer(nil); return }
        lastPointerTime = now()
        if pointer != latestPointer { pointer = latestPointer }
    }
    private func setPointer(_ point: CGPoint?) {
        pendingPointer?.cancel(); pendingPointer = nil; latestPointer = point
        if pointer != point { pointer = point }
    }
}

/// Transparent observer, not a drag source and not a replacement for the real
/// SwiftUI Buttons. Normal clicks, right-click menus, keys and scrolling pass
/// through, including mouse-up so Button tracking always terminates. The real
/// Button action uses the controller's post-drag guard; only Esc during an active
/// drag is consumed to cancel it. No global input monitor or AX calls.
struct NativeQuickWindowPointerSurface: NSViewRepresentable {
    let controller: NativeQuickWindowInteractionController
    let frames: [String: CGRect]
    let owner: UInt64
    let enabled: Bool
    let hide: (String, UInt64) -> Void
    func makeNSView(context: Context) -> NativeQuickWindowPointerView { .init(controller: controller) }
    func updateNSView(_ view: NativeQuickWindowPointerView, context: Context) {
        view.configure(frames: frames, owner: owner, enabled: enabled, hide: hide)
    }
    static func dismantleNSView(_ view: NativeQuickWindowPointerView, coordinator: ()) { view.detach() }
}

@MainActor final class NativeQuickWindowPointerView: NSView {
    let controller: NativeQuickWindowInteractionController
    private var localMonitor: Any?
    private var notifications: [NSObjectProtocol] = []
    private var area: NSTrackingArea?
    private var frames: [String: CGRect] = [:]
    private var epoch: UInt64 = 0
    private var enabled = false
    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    init(controller: NativeQuickWindowInteractionController) { self.controller = controller; super.init(frame: .zero) }
    required init?(coder: NSCoder) { fatalError("Not supported") }
    func configure(frames: [String: CGRect], owner: UInt64, enabled: Bool, hide: @escaping (String, UInt64) -> Void) {
        self.frames = frames; self.epoch = owner; self.enabled = enabled
        controller.onHide = hide; updateConfiguration()
    }
    private func updateConfiguration() {
        controller.configure(frames: frames, bounds: bounds, owner: epoch,
                             enabled: enabled && window != nil && !isHiddenOrHasHiddenAncestor)
    }
    override func layout() { super.layout(); updateConfiguration() }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow(); detach()
        guard let window else { return }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseDragged, .leftMouseUp, .rightMouseDown, .keyDown, .scrollWheel]) { [weak self] event in
            let consumed = MainActor.assumeIsolated {
                guard let self else { return false }
                return self.handle(event) == nil
            }
            return consumed ? nil : event
        }
        let center = NotificationCenter.default
        notifications.append(center.addObserver(forName: NSWindow.didResignKeyNotification, object: window, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.controller.cancel() }
        })
        notifications.append(center.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.controller.cancel() }
        })
        updateConfiguration()
    }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area { removeTrackingArea(area) }
        let next = NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        area = next; addTrackingArea(next)
    }
    override func mouseMoved(with event: NSEvent) { controller.hover(convert(event.locationInWindow, from: nil)) }
    override func mouseEntered(with event: NSEvent) { mouseMoved(with: event) }
    override func mouseExited(with event: NSEvent) { controller.hover(nil) }
    func handle(_ event: NSEvent) -> NSEvent? {
        guard event.window === window, window != nil else {
            if controller.gesture.phase != .idle { controller.cancel() }
            return event
        }
        switch event.type {
        case .leftMouseDown:
            let point = convert(event.locationInWindow, from: nil)
            if visibleRect.contains(point) { controller.press(point) }
        case .leftMouseDragged:
            controller.move(convert(event.locationInWindow, from: nil))
        case .leftMouseUp:
            _ = controller.release(convert(event.locationInWindow, from: nil))
        case .keyDown:
            let wasDragging = controller.gesture.phase == .dragging
            controller.cancel()
            if wasDragging && event.keyCode == 53 { return nil }
        case .scrollWheel, .rightMouseDown: controller.cancel()
        default: break
        }
        return event
    }
    func detach() {
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }; localMonitor = nil
        notifications.forEach { NotificationCenter.default.removeObserver($0) }; notifications = []
        controller.cancel()
        controller.configure(frames: [:], bounds: .zero, owner: epoch, enabled: false)
    }
}
