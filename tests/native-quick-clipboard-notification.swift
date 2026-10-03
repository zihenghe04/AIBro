import AppKit
import Foundation

func nativeUI(_ zh: String, _ en: String) -> String { en }

@main struct ClipboardNotificationTests {
    @MainActor static func main() async {
        var checks = 0
        func check(_ condition: @autoclosure () -> Bool, _ label: String) {
            guard condition() else { fatalError(label) }
            checks += 1; print("PASS: \(label)")
        }
        typealias E = NativeQuickNotificationEvent
        let id = UUID(), owner = "synthetic-workspace"
        let queue = NativeQuickNotificationQueue(ownerID: owner, schedulesTimers: false)
        queue.setReducedMotion(true)
        let sources = NativeQuickNotificationSources(queue: queue)
        let message = "Paste sent to Fixture Editor."
        check(!sources.acceptClipboardFeedback(id: id, message: message, ownerID: owner), "Unavailable feedback never queues")
        sources.accept([])
        check(!sources.acceptClipboardFeedback(id: id, message: message, ownerID: "other"), "Another workspace cannot enqueue clipboard feedback")
        check(!sources.acceptClipboardFeedback(id: id, message: " \n", ownerID: owner), "Empty status is not a feedback receipt")
        check(sources.acceptClipboardFeedback(id: id, message: message, ownerID: owner), "Available local feedback enters the queue")
        check(queue.history.count == 1 && queue.history[0].source == .clipboard && queue.history[0].outcome == .information, "Feedback has its own informational source, not task or Agent completion")
        check(queue.history[0].title == "Paste back" && queue.history[0].detail == message && queue.history[0].destination == .clipboard(id), "Receipt carries only supplied local status and its navigation UUID")
        check(sources.acceptClipboardFeedback(id: id, message: message, ownerID: owner) && queue.history.count == 1, "Duplicate receipt is idempotent")
        check(sources.hasClipboardFeedback(id: id, ownerID: owner) && !sources.hasClipboardFeedback(id: UUID(), ownerID: owner), "Navigation requires a real retained receipt")
        check(!sources.hasClipboardFeedback(id: id, ownerID: "other"), "Receipt is bound to its workspace")
        for source in [E.Source.externalCodex, .externalClaude, .externalGPT, .agent, .task] {
            check(E(id: "fake", ownerID: owner, source: source, title: "Fake", destination: .clipboard(id)) == nil, "\(source.rawValue) cannot borrow the clipboard route")
        }
        check(E(id: "fake", ownerID: owner, source: .clipboard, title: "Fake", destination: .run("run")) == nil, "Clipboard feedback cannot borrow run identity")
        check(E(id: "fake", ownerID: owner, source: .clipboard, title: "Fake", outcome: .completed, destination: .clipboard(id)) == nil, "Feedback never claims completed business work")
        var opened: E.Destination?
        await queue.activateCurrent { destination in opened = destination; return true }
        check(opened == .clipboard(id) && queue.current == nil, "Activating the notification forwards only the clipboard receipt and dismisses on success")
        check(sources.hasClipboardFeedback(id: id, ownerID: owner), "Dismissed notification remains available in session history")
        sources.accept(nil)
        check(queue.history.isEmpty && !sources.hasClipboardFeedback(id: id, ownerID: owner), "Privacy reset clears content-free feedback and its navigation capability")
        sources.accept([])
        check(queue.history.isEmpty, "Restoring availability does not replay prior feedback")

        let lateID = UUID()
        _ = sources.acceptClipboardFeedback(id: lateID, message: message, ownerID: owner)
        await queue.activateCurrent { destination in
            check(destination == .clipboard(lateID), "Late activation starts with the current typed receipt")
            sources.accept(nil)
            await Task.yield()
            return true
        }
        check(queue.current == nil && queue.history.isEmpty && !queue.activationFailed && !queue.isActivating, "Late navigation completion cannot restore a privacy-cleared notification")
        check(NSApp == nil, "No application or real clipboard is opened by the regression")
        print("PASS: \(checks) clipboard feedback assertions")
    }
}
