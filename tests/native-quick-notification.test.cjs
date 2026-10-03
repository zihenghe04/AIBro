const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('notification FIFO, suspension, navigation, owner isolation and native window policy', {
  skip: process.platform !== 'darwin', timeout: 90000,
}, () => {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-notification-'));
  try {
    const source = path.join(temp, 'NotificationTests.swift'), binary = path.join(temp, 'notification-tests');
    fs.writeFileSync(source, String.raw`
import Foundation
import AppKit
func nativeUI(_ zh: String, _ en: String) -> String { en }
@main struct NotificationTests {
    @MainActor static func main() async {
        typealias Q = NativeQuickNotificationQueue
        typealias E = NativeQuickNotificationEvent
        var checks = 0
        func check(_ value: @autoclosure () -> Bool, _ detail: String) { checks += 1; precondition(value(), detail) }
        var time: TimeInterval = 100
        let queue = Q(ownerID: "workspace", now: { time }, schedulesTimers: false)
        func event(_ id: String, owner: String = "workspace", source: E.Source = .task) -> E {
            E(id: id, ownerID: owner, source: source, title: "A task", detail: "Updated", destination: .task(id))!
        }
        func advance(_ amount: Double) { time += amount; queue.tick() }
        check(E(id: "", ownerID: "workspace", source: .task, title: "Task", destination: .task("a")) == nil, "Empty identity rejected")
        check(E(id: "x", ownerID: "workspace", source: .externalCodex, title: "Task", destination: .task("a")) == nil, "External reports cannot impersonate internal task navigation")
        let cleaned = E(id: "x", ownerID: "workspace", source: .task, title: "Title\u{202E}  text", destination: .task("a"))!
        check(cleaned.title == "Title text", "Bidi control and repeated spaces do not spoof presentation")
        check(queue.enqueue(event("wrong", owner: "other")) == .wrongOwner && queue.history.isEmpty, "Other-owner events never enter history")
        check(queue.enqueue(event("first")) == .accepted && queue.phase == .entering, "First event starts the entry phase")
        check(queue.enqueue(event("first")) == .duplicate && queue.history.count == 1, "Repeated committed identity is not replayed")
        let firstGeneration = queue.generation
        advance(Q.entryDuration + 0.01)
        check(queue.phase == .visible, "Entry completion begins visible dwell")
        advance(2)
        check(abs(queue.remainingVisibleTime - 4) < 0.001, "Visible time decrements against the clock")
        queue.setHovering(true)
        advance(100)
        check(queue.phase == .visible && abs(queue.remainingVisibleTime - 4) < 0.001, "Hover retains the exact remaining dwell")
        queue.setAccessibilityFocused(true); queue.setHovering(false)
        advance(100)
        check(queue.phase == .visible && abs(queue.remainingVisibleTime - 4) < 0.001, "Assistive focus also pauses after pointer leaves")
        queue.setAccessibilityFocused(false)
        check(queue.enqueue(event("second")) == .accepted && queue.pendingEventCount == 1, "New events wait behind the current event")
        queue.finishTransition(generation: firstGeneration)
        check(queue.current?.id == "first", "Stale animation completion cannot dismiss a newer phase")
        queue.setPresentationAllowed(false)
        advance(100)
        check(queue.current?.id == "first" && abs(queue.remainingVisibleTime - 4) < 0.001, "Blocked presentation retains current and remaining time")
        queue.setPresentationAllowed(true)
        advance(4.01)
        check(queue.phase == .leaving && queue.current?.id == "first", "Timeout plays exit before advancing FIFO")
        advance(Q.exitDuration + 0.01)
        check(queue.phase == .entering && queue.current?.id == "second" && queue.pendingEventCount == 0, "Only the completed exit advances FIFO")
        advance(Q.entryDuration + 0.01)
        var destinations: [E.Destination] = []
        await queue.activateCurrent { destination in destinations.append(destination); return false }
        check(queue.current?.id == "second" && queue.phase == .visible && queue.activationFailed, "Navigation rejection preserves notification with actionable failure")
        await queue.activateCurrent { destination in destinations.append(destination); return true }
        check(destinations == [.task("second"), .task("second")] && queue.phase == .leaving, "Only acknowledged navigation starts dismissal")
        advance(Q.exitDuration + 0.01)
        check(queue.current == nil && queue.phase == .idle, "Empty queue becomes idle")
        queue.setReducedMotion(true)
        _ = queue.enqueue(event("reduced"))
        check(queue.phase == .visible, "Reduced motion bypasses entry without removing dwell")
        queue.dismissCurrent()
        check(queue.phase == .idle, "Reduced motion dismisses synchronously")

        queue.setPresentationAllowed(false)
        for index in 0..<25 { check(queue.enqueue(event("batch-\(index)")) == .accepted, "Burst accepted") }
        check(queue.pendingEventCount == 25 && queue.history.count == 20, "Pending total remains exact and recent history is bounded")
        queue.setPresentationAllowed(true)
        for index in 0..<4 {
            check(queue.current?.id == "batch-\(index)" && queue.current?.events.count == 1, "Initial burst entries retain FIFO")
            queue.dismissCurrent()
        }
        check(queue.current?.isSummary == true && queue.current?.events.count == 21, "Overflow is a typed group, not a fictitious completion")
        check(queue.current?.events.first?.id == "batch-4" && queue.current?.events.last?.id == "batch-24", "Overflow retains every accepted destination in order")
        let groupedIDs = (4..<25).map { "batch-\($0)" }
        check(queue.current?.destination == .history(groupedIDs), "Mixed summary routes to all original event IDs")
        check(queue.events(for: groupedIDs).count == 21, "Summary can resolve every accepted event beyond the recent-history limit")
        let staleGeneration = queue.generation
        await queue.activateCurrent { _ in queue.reset(ownerID: "replacement"); return true }
        check(queue.ownerID == "replacement" && queue.current == nil && queue.history.isEmpty, "Owner reset invalidates navigation completion and retained metadata")
        queue.finishTransition(generation: staleGeneration)
        check(queue.phase == .idle, "Old callbacks cannot publish in another workspace")
        queue.reset(ownerID: "workspace")
        queue.setPresentationAllowed(false)
        for index in 0..<Q.retainedEventLimit { _ = queue.enqueue(event("capacity-\(index)")) }
        check(queue.enqueue(event("capacity-over")) == .full && queue.pendingEventCount == Q.retainedEventLimit, "Over-capacity is explicitly rejected, not silently swallowed")

        let screen = CGRect(x: -1800, y: 900, width: 1800, height: 1169)
        let geometry = NativeQuickNotificationGeometry.resolve(screen: screen,
            visible: CGRect(x: -1800, y: 900, width: 1800, height: 1132), safeTop: 37,
            leftArea: CGRect(x: -1800, y: 2032, width: 740, height: 37),
            rightArea: CGRect(x: -740, y: 2032, width: 740, height: 37))
        check(geometry.safeTop == 37 && geometry.collapsedWidth == 320, "Physical notch width and safeTop determine collapsed shape")
        check(geometry.frame.maxY == screen.maxY && geometry.frame.midX == screen.midX, "Top origin is correct on an offset external display")
        check(geometry.contentHeight == 65 && geometry.frame.width == 400, "Content stays below the actual notch with a stable canvas")
        let narrow = NativeQuickNotificationGeometry.resolve(screen: CGRect(x: 0, y: 0, width: 280, height: 600),
            visible: CGRect(x: 0, y: 0, width: 280, height: 576), safeTop: 0)
        check(narrow.frame.width == 256 && narrow.safeTop == 24 && narrow.collapsedWidth <= narrow.frame.width, "Small displays and ordinary menu bars fit inside screen edges")
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        let priorResponder = NSApp.keyWindow?.firstResponder
        let window = NativeQuickNotificationWindow(contentRect: geometry.frame)
        check(!window.canBecomeKey && !window.canBecomeMain, "Notification surface never owns keyboard focus")
        check(window.styleMask.contains(.nonactivatingPanel) && window.collectionBehavior.contains(.fullScreenAuxiliary), "Native panel is nonactivating and available over full-screen spaces")
        check(!window.isVisible && NSApp.keyWindow?.firstResponder === priorResponder, "Construction never shows a window or replaces a draft responder")
        window.close()
        print("PASS: \(checks) notification queue, navigation and native policy assertions")
    }
}
`);
    const compiled = spawnSync('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5',
      path.join(root, 'native/Sources/AIBro/NativeQuickNotificationQueue.swift'),
      path.join(root, 'native/Sources/AIBro/NativeQuickNotificationPanel.swift'), source, '-o', binary,
    ], { encoding: 'utf8', timeout: 60000 });
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr + (compiled.error?.message ?? ''));
    const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message ?? ''));
    assert.match(result.stdout, /PASS: \d+ notification queue/);
    process.stdout.write(result.stdout);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
