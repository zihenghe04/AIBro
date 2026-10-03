import AppKit
import SwiftUI
func nativeUI(_ zh: String, _ en: String) -> String { en }
@MainActor final class FocusSaveGate {
    var continuation: CheckedContinuation<[String:Any], Never>?
    func wait() async -> [String:Any] { await withCheckedContinuation { continuation = $0 } }
    func release(_ reply: [String:Any]) { continuation?.resume(returning: reply); continuation = nil }
}
@main struct CompletionFocusChecks {
    @MainActor static func main() async throws {
        setbuf(stdout, nil)
        var count = 0
        func check(_ value: Bool, _ message: String) { precondition(value, message); count += 1; print("PASS " + message) }
        let a = NativeQuickTaskRowFocus(taskID: "task-a", control: .selection)
        let b = NativeQuickTaskRowFocus(taskID: "task-b", control: .selection)
        var owner = true, valid = true, received: [NativeQuickTaskRowFocus] = []
        let focus = NativeQuickTaskCompletionFocus(keyboardOwned: { owner })
        func begin(_ target: NativeQuickTaskRowFocus = a) -> UUID { focus.begin(target: target, canRestore: { valid })! }
        let initial = begin()
        check(focus.restoration == nil && focus.owns(initial), "pending write owns original task ID but does not request an early restore")
        focus.acknowledge(initial, saved: true)
        let first = focus.restoration!
        check(first.target == a, "saved completion restoration keeps task A identity regardless of canonical index")
        check(!focus.restore(first, isVisible: false, apply: { received.append($0) }) && received.isEmpty, "preloaded or clipped row cannot acknowledge a focus restore")
        check(!focus.restore(first, isVisible: true, apply: { received.append($0) }), "old on-screen row cannot restore before the new position is requested")
        focus.didRequestPosition(initial)
        let layout = focus.beginReorder(initial, order: ["task-b", "task-a"])!
        check(!focus.restore(first, isVisible: true, apply: { received.append($0) }), "visible row cannot restore in the middle of its real order animation")
        focus.endReorder(initial, layout: layout)
        check(focus.restore(first, isVisible: true, apply: { received.append($0) }) && received == [a], "visible original row receives exactly one restore after save")
        _ = focus.restore(first, isVisible: true, apply: { received.append($0) })
        check(received == [a] && focus.restoration == nil, "a repeated mount callback cannot steal focus again")
        var settled = false
        let lag = focus.begin(target: a, canRestore: { true }, isSettled: { settled })!
        focus.acknowledge(lag, saved: true); focus.didRequestPosition(lag)
        let lagRequest = focus.restoration!
        check(!focus.restore(lagRequest, isVisible: true, apply: { _ in preconditionFailure("early snapshot") }), "durable ACK before projected completion waits without claiming focus")
        settled = true
        var projectedRestore = false
        _ = focus.restore(lagRequest, isVisible: true, apply: { _ in projectedRestore = true })
        check(projectedRestore, "latest settled snapshot releases the same original identity without another save")
        let cancelledMotion = begin(); focus.acknowledge(cancelledMotion, saved: true)
        let oldLayout = focus.beginReorder(cancelledMotion, order: ["task-b", "task-a"])!
        let newLayout = focus.beginReorder(cancelledMotion, order: ["task-a", "task-b"])!
        focus.didRequestPosition(cancelledMotion); focus.endReorder(cancelledMotion, layout: oldLayout)
        check(!focus.restore(focus.restoration!, isVisible: true, apply: { _ in preconditionFailure("old motion") }), "an old animation completion cannot release a newer layout")
        focus.endReorder(cancelledMotion, layout: newLayout); focus.cancel()
        let failed = begin(); focus.acknowledge(failed, saved: false)
        check(focus.restoration == nil && !focus.owns(failed), "failed save ends the lease without changing focus")
        func key(_ chars: String, code: UInt16, repeated: Bool = false) -> NSEvent {
            NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: repeated, keyCode: code)!
        }
        for (text, code) in [("\t", UInt16(48)), ("\u{f701}", 125), ("\u{1b}", 53), ("x", 7)] {
            let token = begin(); focus.receiveUserEvent(key(text, code: code)); focus.acknowledge(token, saved: true)
            check(focus.restoration == nil && !focus.owns(token), "fresh key \(code) while saving revokes late focus and scroll")
        }
        let click = NSEvent.mouseEvent(with: .leftMouseDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, eventNumber: 1, clickCount: 1, pressure: 1)!
        let clicked = begin(); focus.receiveUserEvent(click); focus.acknowledge(clicked, saved: true)
        check(focus.restoration == nil, "a click on another control during save cannot be followed by late restore")
        let scroll = NSEvent(cgEvent: CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: 12, wheel2: 0, wheel3: 0)!)!
        let scrolling = begin(); focus.receiveUserEvent(scroll); focus.acknowledge(scrolling, saved: true)
        check(focus.restoration == nil, "user scrolling during save cancels automatic reveal")
        let repeatToken = begin(); focus.receiveUserEvent(key(" ", code: 49, repeated: true)); focus.acknowledge(repeatToken, saved: true)
        check(focus.restoration?.token == repeatToken, "held activation repeat does not invent a navigation intent")
        focus.cancel()
        let abandoned = begin(); owner = false; focus.acknowledge(abandoned, saved: true)
        check(focus.restoration == nil && focus.begin(target: a, canRestore: { true }) == nil, "lost window keyboard ownership rejects restore and new lease")
        owner = true
        let old = begin(), newer = begin(b); focus.acknowledge(old, saved: true)
        check(focus.owns(newer) && focus.restoration == nil, "old completion receipt cannot replace a newer operation")
        focus.acknowledge(newer, saved: true); valid = false
        _ = focus.restore(focus.restoration!, isVisible: true, apply: { received.append($0) })
        check(received == [a] && focus.restoration == nil, "permission/category/editor change between ACK and mount rejects callback")
        valid = true
        let removed = begin(); focus.cancel(); focus.acknowledge(removed, saved: true)
        check(focus.restoration == nil, "unmount or category cancellation cannot be revived by late ACK")

        // Real hidden NSWindow/NSScrollView geometry, no shown window, AX,
        // keyboard posting, or makeFirstResponder. This is a mount contract,
        // not a claim about actual SwiftUI keyboard acceptance.
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 180), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let scrollView = NSScrollView(frame: NSRect(x: 0, y: 0, width: 320, height: 180))
        let document = NSView(frame: NSRect(x: 0, y: 0, width: 320, height: 1000))
        let marker = NativeQuickTaskCompletionMount(frame: NSRect(x: 0, y: 800, width: 300, height: 52))
        window.contentView = scrollView; scrollView.documentView = document; document.addSubview(marker)
        scrollView.contentView.scroll(to: .zero); scrollView.reflectScrolledClipView(scrollView.contentView)
        window.contentView?.layoutSubtreeIfNeeded()
        check(!marker.hasVisibleRowGeometry, "real clipped NSScrollView row is not a visible focus target")
        let mountToken = begin(); focus.acknowledge(mountToken, saved: true)
        let mountRequest = focus.restoration!
        focus.didRequestPosition(mountToken)
        marker.acknowledge = { req, visible in focus.restore(req, isVisible: visible, apply: { received.append($0) }) }
        marker.setRequest(mountRequest)
        try await Task.sleep(nanoseconds: 45_000_000)
        check(received == [a] && focus.restoration != nil, "actual mounted probe waits while original row is offscreen")
        scrollView.contentView.scroll(to: NSPoint(x: 0, y: 780)); scrollView.reflectScrolledClipView(scrollView.contentView)
        window.contentView?.layoutSubtreeIfNeeded()
        for _ in 0..<30 { if received.count == 2 { break }; try await Task.sleep(nanoseconds: 10_000_000) }
        check(marker.hasVisibleRowGeometry && received == [a, a], "actual geometry probe restores A only after the original row is revealed")
        marker.setRequest(nil); window.close()

        let gate = FocusSaveGate(), workbench = NativeQuickWorkbenchStore()
        let directory = URL(fileURLWithPath: CommandLine.arguments[1])
        workbench.configure(directory: directory, command: { _ in await gate.wait() }, openTask: { _ in false }, openRun: { _ in false })
        defer { workbench.taskInbox.setAvailable(false); focus.cancel() }
        func item(_ id: String, _ completed: Bool = false) -> NativeQuickTaskItem {
            .init(id: id, title: "Synthetic " + id, projectTitle: "Fixture", dueLabel: "", isCompleted: completed, version: completed ? "v2" : "v1")
        }
        func snapshot(_ tasks: [NativeQuickTaskItem]) -> NativeQuickWorkbenchSnapshot { .init(version: 1, status: "ready", reason: nil, tasks: tasks, runs: [], taskCount: tasks.count, runCount: 0) }
        workbench.accept(snapshot([item("task-a"), item("task-b")]))
        let saveToken = begin()
        let saving = Task { let saved = await workbench.setTaskCompleted(id: "task-a", completed: true); focus.acknowledge(saveToken, saved: saved) }
        while gate.continuation == nil { await Task.yield() }
        workbench.accept(snapshot([item("task-b"), item("task-a", true)]))
        check(focus.restoration == nil && workbench.visibleTasks.first?.id == "task-b", "actual reordered projection before durable ACK cannot restore prematurely")
        focus.receiveUserEvent(click); gate.release(["status": "saved", "id": "task-a"]); await saving.value
        check(focus.restoration == nil && workbench.visibleTasks.last?.isCompleted == true, "real delayed Workbench success after editor click preserves save and rejects focus theft")
        print("\(count) completion-focus checks; hidden native geometry only, actual SwiftUI keyboard path remains unverified")
    }
}
