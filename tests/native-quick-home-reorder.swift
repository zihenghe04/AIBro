import AppKit
import SwiftUI

func nativeUI(_ zh: String, _ en: String) -> String { en }
final class RejectingHomeDefaults: UserDefaults {
    override func set(_ value: Any?, forKey defaultName: String) {}
}

@main struct HomeReorderChecks {
    @MainActor static func main() {
        var count = 0
        func check(_ result: @autoclosure () -> Bool, _ label: String) {
            precondition(result(), label); count += 1; print("PASS \(count): \(label)")
        }
        let frames = ["a": CGRect(x: 0, y: 0, width: 100, height: 100),
                      "b": CGRect(x: 110, y: 0, width: 100, height: 100),
                      "c": CGRect(x: 0, y: 110, width: 100, height: 100)]
        let viewport = CGRect(x: 0, y: 0, width: 210, height: 180)
        var state = NativeQuickHomeReorder()
        let token = state.begin(source: "a", point: .init(x: 20, y: 20), now: 0, order: ["a", "b", "c"], frames: frames, viewport: viewport)!
        check(state.phase == .pressing && state.translation == .zero, "press waits without moving a card")
        check(!state.activate(token: token, now: 0.419), "419ms does not activate")
        state.move(to: .init(x: 28, y: 20))
        check(state.phase == .pressing, "exactly eight points remain eligible")
        check(state.activate(token: token, now: 0.420), "420ms activates the same press")
        state.move(to: .init(x: 130, y: 20))
        check(state.target == "b" && state.translation.width == 110, "drag follows pointer and highlights another card")
        check(state.finish() == .init(source: "a", target: "b") && state.phase == .idle, "release produces exactly one exchange")
        check(state.finish() == nil, "duplicate mouse up cannot commit twice")
        let cancelled = state.begin(source: "b", point: .init(x: 125, y: 20), now: 1, order: ["a", "b", "c"], frames: frames, viewport: viewport)!
        state.move(to: .init(x: 133.01, y: 20))
        check(state.phase == .idle, "movement over eight points cancels before hold")
        let current = state.begin(source: "a", point: .init(x: 20, y: 20), now: 2, order: ["a", "b", "c"], frames: frames, viewport: viewport)!
        check(!state.activate(token: cancelled, now: 5) && state.phase == .pressing, "old timer cannot activate new press")
        check(state.activate(token: current, now: 2.5), "current press still activates")
        state.move(to: .init(x: 105, y: 20))
        check(state.target == nil, "gutter is not a hidden drop target")
        state.move(to: .init(x: 20, y: 190))
        check(state.target == nil, "offscreen part of an existing card cannot receive a drop")
        check(state.finish() == nil, "outside release preserves saved order")
        let reverse = state.begin(source: "b", point: .init(x: 125, y: 20), now: 6, order: ["a", "b", "c"], frames: frames, viewport: viewport)!
        _ = state.activate(token: reverse, now: 7); state.move(to: .init(x: 20, y: 20))
        check(state.finish() == .init(source: "b", target: "a"), "reverse drag uses the same exchange semantics")
        check(state.begin(source: "a", point: .init(x: 20, y: 20), now: 8, order: ["a", "a"], frames: frames, viewport: viewport) == nil, "duplicate identities rejected")

        let suite = "test.aibro.home-reorder." + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let prefs = NativeQuickPanelPreferences(defaults: defaults)
        let available = prefs.configuration.homeOrder
        let original = prefs.configuration
        check(prefs.swapHome("music", with: "note", available: available, expected: original), "valid exchange saves")
        let changed = prefs.configuration
        check(changed.homeOrder[0] == "note" && changed.homeOrder[5] == "music", "swap changes only the two positions")
        check(changed.homeSizes == original.homeSizes && changed.hiddenHomeModules == original.hiddenHomeModules, "sizes and hidden preferences are not changed by dragging")
        check(NativeQuickPanelPreferences(defaults: defaults).configuration == changed, "a new store restores the committed order")
        check(!prefs.swapHome("note", with: "music", available: available, expected: original), "stale layout baseline cannot overwrite a newer order")
        check(!prefs.swapHome("tasks", with: "music", available: available, expected: changed), "hidden card cannot be exchanged")
        prefs.setSize(.small, for: "mirror")
        let resized = prefs.configuration
        check(!prefs.swapHome("note", with: "music", available: available, expected: changed) && prefs.configuration == resized, "size change during a gesture invalidates it")
        let rejected = NativeQuickPanelPreferences(defaults: RejectingHomeDefaults(suiteName: suite + ".reject")!)
        let beforeFailure = rejected.configuration
        check(!rejected.swapHome("music", with: "note", available: available, expected: beforeFailure), "failed preference write does not report success")
        check(rejected.configuration == beforeFailure && rejected.issue != nil, "failed write retains old layout and gives an error")

        // Hidden NSWindow only: real AppKit hit testing, no screen ordering,
        // accessibility permission, user workspace or general pasteboard.
        _ = NSApplication.shared
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 600, height: 300), styleMask: [.borderless], backing: .buffered, defer: false)
        let content = NSView(frame: .init(x: 0, y: 0, width: 600, height: 300)); window.contentView = content
        let editor = NSTextView(frame: .init(x: 12, y: 70, width: 170, height: 100))
        editor.string = "Unsent 中文 draft"; editor.setSelectedRange(NSRange(location: 7, length: 2)); content.addSubview(editor)
        let expand = NSButton(frame: .init(x: 210, y: 266, width: 20, height: 19)); content.addSubview(expand)
        let menu = NSButton(frame: .init(x: 236, y: 266, width: 20, height: 19)); content.addSubview(menu)
        let controller = NativeQuickHomeReorderController(); controller.reduceMotion = true
        func surface(_ id: String, _ rect: CGRect) -> NativeQuickHomeReorderSurface.View {
            let view = NativeQuickHomeReorderSurface.View(frame: rect)
            view.moduleID = id; view.enabled = true; view.visibleIDs = ["a", "b"]; view.controller = controller
            content.addSubview(view); controller.register(view); return view
        }
        let source = surface("a", .init(x: 0, y: 0, width: 270, height: 300))
        let target = surface("b", .init(x: 280, y: 0, width: 270, height: 300))
        check(content.hitTest(.init(x: 60, y: 280)) === source, "blank header reaches native long press surface")
        check(content.hitTest(.init(x: 3, y: 130)) === source, "outer blank edge reaches long press surface")
        check(content.hitTest(.init(x: 50, y: 100)) === editor, "body editor is not intercepted by card surface")
        check(content.hitTest(.init(x: 220, y: 274)) === expand, "expand button is not a drag surface")
        check(content.hitTest(.init(x: 245, y: 274)) === menu, "menu button is not a drag surface")
        check(!source.acceptsFirstResponder, "drag surface cannot take editor focus")
        _ = window.makeFirstResponder(editor)
        var commits: [NativeQuickHomeReorder.Commit] = []
        source.commit = { commits.append($0) }
        controller.begin(source, point: .init(x: 60, y: 280))
        check(controller.interaction.phase == .pressing, "native bridge starts pending gesture")
        controller.cancel(animated: false)
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.46))
        check(controller.interaction.phase == .idle && commits.isEmpty, "cancelled scheduled hold never revives or saves")
        controller.begin(source, point: .init(x: 60, y: 280))
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.46))
        check(controller.interaction.phase == .dragging, "native timer activates an uninterrupted 420ms hold")
        controller.move(source, point: .init(x: 350, y: 280))
        check(controller.interaction.target == "b", "native window frame resolves the visible target")
        controller.finish(source, point: .init(x: 350, y: 280))
        check(commits == [.init(source: "a", target: "b")], "native release commits one actual target")
        check(window.firstResponder === editor && editor.string == "Unsent 中文 draft" && editor.selectedRange() == NSRange(location: 7, length: 2), "drag never replaces editor, draft or selection")
        controller.begin(source, point: .init(x: 60, y: 280))
        source.removeFromSuperview()
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.46))
        check(controller.interaction.phase == .idle && commits.count == 1, "unmounted source cancels timer without delayed commit")
        target.enabled = false
        check(target.hitTest(.init(x: 350, y: 280)) == nil, "hidden/disabled surface cannot capture input")
        window.close()
        print("PASS: \(count) home reorder assertions; hidden-window checks, not native drag acceptance")
    }
}
