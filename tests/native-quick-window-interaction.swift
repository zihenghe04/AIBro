import AppKit
import SwiftUI

func nativeUI(_ zh: String, _ en: String) -> String { en }
@main struct WindowInteractionChecks {
    @MainActor static var count = 0
    @MainActor static func check(_ value: @autoclosure () -> Bool, _ message: String) {
        precondition(value(), message); count += 1; print("PASS \(count): \(message)")
    }
    @MainActor static func wait(_ body: () -> Bool) async {
        for _ in 0..<1000 {
            if body() { return }
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
        preconditionFailure("Timed out")
    }
    @MainActor static func surface(_ view: NSView) -> NativeQuickWindowPointerView? {
        if let value = view as? NativeQuickWindowPointerView { return value }
        return view.subviews.lazy.compactMap { surface($0) }.first
    }
    @MainActor static func main() async throws {
        let bounds = CGRect(x: 0, y: 0, width: 240, height: 160)
        let frame = CGRect(x: 20, y: 30, width: 70, height: 50)
        let point = CGPoint(x: 55, y: 55), outside = CGPoint(x: 250, y: 55)
        var model = NativeQuickWindowInteraction()
        check(model.begin(id: "a", at: .init(x: 2, y: 2), now: 0, frame: frame, bounds: bounds, owner: 1) == nil, "card blank space does not arm a window")
        let first = model.begin(id: "a", at: point, now: 1, frame: frame, bounds: bounds, owner: 1)!
        check(!model.activate(token: first, now: 1.459, owner: 1), "hold stays below real 460ms boundary")
        check(model.activate(token: first, now: 1.461, owner: 1), "460ms activates the exact pointer lease")
        model.move(to: outside, now: 1.5)
        check(model.removeReady && model.translation.width == 195, "outside arms removal without hiding yet")
        model.move(to: point, now: 1.6)
        check(!model.removeReady && model.finish(at: point, now: 1.7, owner: 1) == nil, "returning inside before release cancels hiding")
        check(!model.mayActivate(now: 2.1) && model.mayActivate(now: 2.151), "450ms suppresses residual button click, then restores activation")
        let second = model.begin(id: "a", at: point, now: 3, frame: frame, bounds: bounds, owner: 1)!
        model.move(to: .init(x: 64, y: 55), now: 3.1)
        check(model.phase == .idle && !model.activate(token: second, now: 4, owner: 1), "moving more than 8pt cancels hold and stale timer")
        let third = model.begin(id: "a", at: point, now: 4, frame: frame, bounds: bounds, owner: 2)!
        _ = model.activate(token: third, now: 4.5, owner: 2)
        check(model.finish(at: outside, now: 4.6, owner: 3) == nil, "owner replacement cannot commit a stale hide")
        let fourth = model.begin(id: "a", at: point, now: 5, frame: frame, bounds: bounds, owner: 3)!
        _ = model.activate(token: fourth, now: 5.5, owner: 3)
        check(model.finish(at: outside, now: 5.6, owner: 3) == "a", "only outside release returns the exact source ID")
        let center = NativeQuickWindowProximity.transform(point: point, frame: frame, reducedMotion: false)
        let neighbor = NativeQuickWindowProximity.transform(point: point, frame: frame.offsetBy(dx: 85, dy: 0), reducedMotion: false)
        let far = NativeQuickWindowProximity.transform(point: .init(x: 999, y: 999), frame: frame, reducedMotion: false)
        check(abs(center.scale-1.12) < 0.0001 && center.lift == -5, "proximity peak uses upstream 1.12 scale and 5pt lift")
        check(neighbor.scale > 1 && neighbor.scale < center.scale && neighbor.lift > center.lift, "neighbor follows a weaker continuous proximity curve")
        check(far == .init(scale: 1, lift: 0), "distant and absent pointer do not animate")
        check(NativeQuickWindowProximity.transform(point: point, frame: frame, reducedMotion: true) == .init(scale: 1, lift: 0), "reduced motion removes decorative scale and lift")

        let controller = NativeQuickWindowInteractionController()
        var now: TimeInterval = 10
        controller.now = { now }
        controller.configure(frames: ["a": frame], bounds: bounds, owner: 11, enabled: true)
        var hidden: [(String, UInt64)] = []
        controller.onHide = { hidden.append(($0, $1)) }
        controller.press(point); let token = controller.gesture.token!
        now += 0.5; check(controller.activate(token: token), "real controller activates its timer token")
        controller.move(outside)
        check(hidden.isEmpty && controller.release(outside), "controller commits only on mouse release")
        check(hidden.count == 1 && hidden[0].0 == "a" && hidden[0].1 == 11, "controller forwards exact ID and owner once")
        check(!controller.release(outside) && hidden.count == 1, "duplicate pointer-up cannot repeat hide")
        now += 1; controller.press(point); let stale = controller.gesture.token!
        controller.configure(frames: ["a": frame], bounds: bounds, owner: 12, enabled: true)
        now += 1
        check(!controller.activate(token: stale) && controller.gesture.phase == .idle, "refresh/new generation cancels armed long press")
        controller.press(point); let geometryToken = controller.gesture.token!
        controller.configure(frames: ["a": frame.offsetBy(dx: 2, dy: 0)], bounds: bounds, owner: 12, enabled: true)
        now += 1
        check(!controller.activate(token: geometryToken), "layout movement cancels instead of using stale hit regions")
        controller.configure(frames: ["a": frame], bounds: bounds, owner: 12, enabled: true)
        controller.hover(point)
        controller.configure(frames: ["a": frame], bounds: bounds, owner: 12, enabled: false)
        try? await Task.sleep(nanoseconds: 20_000_000)
        check(controller.pointer == nil && controller.gesture.phase == .idle, "disable clears hover and late coalesced pointer")

        _ = NSApplication.shared
        let window = NSWindow(contentRect: bounds, styleMask: [.borderless], backing: .buffered, defer: false)
        let pointer = NativeQuickWindowPointerView(controller: controller)
        pointer.frame = bounds; window.contentView = pointer
        pointer.configure(frames: ["a": frame], owner: 20, enabled: true) { hidden.append(($0, $1)) }
        let event: (NSEvent.EventType, CGPoint) -> NSEvent = { type, location in
            NSEvent.mouseEvent(with: type, location: pointer.convert(location, to: nil), modifierFlags: [], timestamp: now,
                              windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 1)!
        }
        let down = event(.leftMouseDown, point)
        check(pointer.hitTest(point) == nil && pointer.handle(down) === down, "real transparent AppKit surface leaves Button mouse-down intact")
        let up = event(.leftMouseUp, point)
        check(pointer.handle(up) === up && hidden.count == 1, "short click mouse-up remains available to real Button")
        now += 1; _ = pointer.handle(event(.leftMouseDown, point)); let nativeToken = controller.gesture.token!
        now += 0.5; _ = controller.activate(token: nativeToken)
        let dragEvent = event(.leftMouseDragged, outside), endEvent = event(.leftMouseUp, outside)
        check(pointer.handle(dragEvent) === dragEvent, "activated pointer drag still reaches native Button tracking")
        check(pointer.handle(endEvent) === endEvent && hidden.count == 2 && !controller.gesture.mayActivate(now: now), "mouse-up ends Button tracking while the real action guard blocks a drag click")
        now += 1; _ = pointer.handle(event(.leftMouseDown, point)); let cancelToken = controller.gesture.token!
        now += 0.5; _ = controller.activate(token: cancelToken)
        let escape = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: now, windowNumber: window.windowNumber,
                                     context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53)!
        check(pointer.handle(escape) == nil && controller.gesture.phase == .idle && hidden.count == 2, "Esc cancels active drag without hiding or opening")
        now += 1; _ = pointer.handle(event(.leftMouseDown, point))
        NotificationCenter.default.post(name: NSWindow.didResignKeyNotification, object: window)
        check(controller.gesture.phase == .idle, "native window focus loss cancels press")
        now += 1; _ = pointer.handle(event(.leftMouseDown, point)); pointer.detach()
        check(controller.gesture.phase == .idle && !controller.enabled, "dismantling cancels timer and disables the gesture")
        window.contentView = nil

        var permission = true, activations = 0
        let snapshot = NativeQuickWindowSnapshot(rows: [
            .init(id: "44:1", pid: 44, title: "Synthetic A", appName: "Synthetic App", applicationIdentity: "fixture", icon: nil),
            .init(id: "44:2", pid: 44, title: "Synthetic B", appName: "Synthetic App", applicationIdentity: "fixture", icon: nil)], canReadTitles: true)
        let store = NativeQuickWindowsStore(scan: { snapshot }, permission: { permission }, observe: { _ in {} },
            prepareActivation: { target in .init(target: target, current: nil, outcome: .applicationOnly) }, applyActivation: { _ in activations += 1; return .applicationOnly })
        store.setAvailable(true); store.setVisible(true); store.setActivity(true)
        await wait { store.state == .ready }
        let mountedWindow = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 240, height: 180), styleMask: [.borderless], backing: .buffered, defer: false)
        let host = NSHostingView(rootView: NativeQuickWindowsCard(store: store)
            .environment(\.nativeQuickWidgetContext, NativeQuickWidgetContext(size: "large", isDetail: false))
            .frame(width: 240, height: 180))
        mountedWindow.contentView = host; host.layoutSubtreeIfNeeded()
        await wait { surface(host)?.controller.frames.count == 2 }
        let mounted = surface(host)!.controller
        check(mounted.enabled && mounted.frames.values.allSatisfy { $0.width > 20 && $0.height > 20 }, "actual mounted SwiftUI card supplies two nonempty native hit regions")
        check(mounted.frames.values.allSatisfy { mounted.bounds.contains($0) }, "native surface bounds and SwiftUI preference frames share the actual card coordinate space")
        let stableFrames = mounted.frames
        let hit = stableFrames["44:1"]!
        var mountedTime: TimeInterval = 100
        mounted.now = { mountedTime }
        mounted.hover(.init(x: hit.midX, y: hit.midY))
        try? await Task.sleep(nanoseconds: 30_000_000); host.layoutSubtreeIfNeeded()
        check(mounted.frames == stableFrames, "proximity transforms do not change their measurement geometry")
        mounted.press(.init(x: hit.midX, y: hit.midY)); let mountedToken = mounted.gesture.token!
        mountedTime += 0.5; _ = mounted.activate(token: mountedToken)
        mounted.move(CGPoint(x: 280, y: hit.midY))
        try? await Task.sleep(nanoseconds: 30_000_000); host.layoutSubtreeIfNeeded()
        check(mounted.frames == stableFrames && mounted.gesture.removeReady, "dragged Button keeps its untransformed anchor and stays armed outside")
        mounted.cancel(); mountedWindow.contentView = nil
        let item = store.items[0], generation = store.interactionGeneration
        store.hideFromGesture(item, generation: generation)
        check(store.hiddenIDs == [item.id] && activations == 0, "gesture hides one store tile without any actual application action")
        store.showAll(); store.refresh()
        store.hideFromGesture(item, generation: generation)
        check(store.hiddenIDs.isEmpty, "refresh invalidates a previous hide generation immediately")
        await wait { store.state == .ready }
        let ready = store.interactionGeneration
        permission = false; store.hideFromGesture(item, generation: ready)
        check(store.hiddenIDs.isEmpty && store.items.allSatisfy { $0.title.isEmpty }, "revoked title permission cannot turn a window drag into app-level hide")
        store.setAvailable(false); store.hideFromGesture(item, generation: store.interactionGeneration)
        check(store.items.isEmpty && store.hiddenIDs.isEmpty, "private/unavailable rejects stale hide without restoring titles")
        store.shutdown()
        print("\(count) window interaction assertions passed; synthetic data and hidden windows only; no real app activation, GUI or OS permission requests")
    }
}
