import Foundation

func nativeUI(_ zh: String, _ en: String) -> String { en }
enum NativeQuickScreenSelection { enum Intent { case pointerSummon, anchored } }
final class NSTextView { var marked = false; func hasMarkedText() -> Bool { marked } }
class NSWindow {
    struct Level { let rawValue: Int; static let statusBar = Self(rawValue: 25), floating = Self(rawValue: 3) }
}
final class Panel: NSWindow {
    var firstResponder: AnyObject?; var isVisible = false; var ignoresMouseEvents = false
    var isMiniaturized = false; var canBecomeKey = true; var allowsKey = false; var keyCount = 0
    var level = Level.floating; var frame = CGRect.zero
    func makeFirstResponder(_ value: AnyObject?) { firstResponder = value }
    func makeKey() { keyCount += 1 }
    func makeKeyAndOrderFront(_ sender: Any?) { isVisible = true; keyCount += 1 }
    func setFrame(_ frame: CGRect, display: Bool) { self.frame = frame }
    func orderOut(_ sender: Any?) { isVisible = false }
    func orderFrontRegardless() { isVisible = true }
}
final class Application {
    let processIdentifier: Int32 = -1; var isTerminated = false; var keyWindow: Panel?
    func activate(options: [Int]) {}; func activate(ignoringOtherApps: Bool) {}
}
let NSApp = Application()
final class NSWorkspace { static let shared = NSWorkspace(); var frontmostApplication: Application? }
struct FixtureScreen {
    let id: UInt32 = 8
    let frame = CGRect(x: -1512, y: 500, width: 1512, height: 982)
    var visibleFrame: CGRect { CGRect(x: -1512, y: 564, width: 1512, height: 881) }
    var safeAreaInsets: Insets { .init(top: 37) }
    var auxiliaryTopLeftArea: CGRect? { CGRect(x: -1512, y: 1445, width: 664, height: 37) }
    var auxiliaryTopRightArea: CGRect? { CGRect(x: -664, y: 1445, width: 664, height: 37) }
}
struct Insets { let top: CGFloat }
struct MenuWindow { let screen: FixtureScreen?; let frame: CGRect }
struct MenuButton { let window: MenuWindow? }
struct MenuItem { let button: MenuButton? }
final class Capture { var flushes = 0; var text = "fixture unsaved draft"; func flushDraft() -> Bool { flushes += 1; return true } }
final class Workbench { var hasSelection = false; func endTaskSelection() -> Bool { let old = hasSelection; hasSelection = false; return old } }

@MainActor final class Host {
    enum Mode { case off, menuBar, edge, island }; var mode: Mode = .off
    typealias Section = NativeQuickPanelSection
    var section: Section = .capture; var sectionBeforeVoice: Section = .home
    var configured = true; var voiceContent: (() -> Void)? = {}; var voicePresented = false; var voiceStatus: String?
    var panel: Panel? = Panel(); var presentation = NativeQuickPresentation()
    var geometry = NativeQuickGeometry.resolve(screen: FixtureScreen().frame, visible: FixtureScreen().visibleFrame, safeTop: 37, placement: .menu)
    var voiceOnEscape: (() -> Void)?; var voiceOnHide: (() -> Void)?
    var previousApp: Application?; var previousKeyWindow: Panel?; var statusItem: MenuItem?; var screenAnchorID: UInt32?
    var motionTask: Task<Void, Never>?; var reduceMotion = false; var navigationOwnsFocus = false; var showingCapture = true
    var extensionModules: [Section: Int] = [.links: 0, .recordings: 0]
    let panelPreferences: NativeQuickPanelPreferences
    let capture = Capture(), captureLibrary = Capture(), links = Capture(), workbench = Workbench()
    var onClipboardPasteSessionEnded: (() -> Void)?; var onClipboardPasteSessionBegan: (() -> Void)?
    init(defaults: UserDefaults) { panelPreferences = NativeQuickPanelPreferences(defaults: defaults) }
    func screenForEntry(intent: NativeQuickScreenSelection.Intent = .anchored) -> FixtureScreen? { .init() }
    func screenID(_ screen: FixtureScreen) -> UInt32? { screen.id }
    func ensurePanel() {}; func focusCaptureInput() {}; func updateStatusItem() {}
    func installOutsideClickMonitors() {}; func finishHomeModuleNavigation(_ value: Bool) {}; func removeOutsideClickMonitors() {}
    func transition(expanded: Bool) { _ = presentation.request(expanded: expanded, reducedMotion: false) }
    func settle() { finishTransition(presentation.generation) }
    // PRODUCTION_MEMBERS
}

@main struct VoiceWorkbenchChecks {
    @MainActor static func main() {
        var checks = 0
        func check(_ result: @autoclosure () -> Bool, _ label: String) { precondition(result(), label); checks += 1; print("PASS " + label) }
        let domain = "dev.aibro.voice-workbench-fixture." + UUID().uuidString
        let defaults = UserDefaults(suiteName: domain)!
        defer { defaults.removePersistentDomain(forName: domain) }
        let host = Host(defaults: defaults)
        check(NativeQuickPanelSection.allCases.firstIndex(of: .voice) == NativeQuickPanelSection.allCases.firstIndex(of: .recordings)! + 1, "voice has an ordinary tab beside recordings")
        check(host.visibleSections.contains(.voice), "configured voice is discoverable without a prior recording")
        var hides = 0, escapes = 0
        host.voiceOnHide = { check(!host.voicePresented, "hide releases voice ownership before host callback"); hides += 1; host.dismissVoice(returnFocus: false) }
        host.voiceOnEscape = { check(!host.voicePresented, "Escape releases ownership before host callback"); escapes += 1; host.dismissVoice(returnFocus: false) }
        let editor = NSTextView(); editor.marked = true; host.panel?.firstResponder = editor
        check(!host.showVoice() && host.section == .capture && !host.presentation.temporaryTopEntry, "shortcut cannot consume existing IME composition or change placement")
        host.select(.voice)
        check(host.section == .capture, "tab selection also preserves marked text")
        editor.marked = false
        let before = defaults.persistentDomain(forName: domain)
        check(host.showVoice() && host.section == .voice && host.voicePresented, "shortcut selects the actual voice tab in the existing panel")
        check(host.mode == .off && host.presentation.temporaryTopEntry && defaults.persistentDomain(forName: domain) as NSDictionary? == before as NSDictionary?, "off preference is unchanged by temporary top entry")
        check(host.geometry.expanded.size == CGSize(width: 760, height: 520) && host.geometry.placement == .island, "voice uses ordinary full workbench dimensions")
        check(host.geometry.expanded.maxY == FixtureScreen().frame.maxY && host.geometry.safeTop == 37, "top entry clears actual notch on a negative-coordinate display")
        host.settle()
        check(host.presentation.contentVisible && host.visibleSections.contains(.tasks) && host.visibleSections.contains(.voice), "voice keeps ordinary content visibility and tab navigation")
        check(hides == 0 && escapes == 0, "mounting and settling voice do not self-cancel permission preparation")
        host.select(.tasks, focusContent: false)
        check(hides == 1 && host.section == .tasks && host.presentation.wantsExpanded && host.navigationOwnsFocus, "switching tab cancels unsubmitted voice without closing or stealing navigation focus")
        check(host.presentation.temporaryTopEntry && host.geometry.placement == .island, "other tabs retain this open-session top placement")
        host.select(.voice)
        check(hides == 1 && host.voicePresented, "ordinary voice tab selection never invokes a start or hide callback")
        host.showWorkspaceFromVoice()
        check(host.section == .tasks && hides == 2 && host.presentation.wantsExpanded, "return helper selects the actual previous tab")
        check(host.capture.text == "fixture unsaved draft" && host.captureLibrary.text == "fixture unsaved draft" && host.links.text == "fixture unsaved draft", "section transitions preserve original store drafts")
        host.dismiss(returnFocus: false); host.settle()
        check(!host.presentation.temporaryTopEntry && host.mode == .off && host.panel?.isVisible == false, "off mode removes temporary top entry after complete close")
        host.mode = .edge; host.showPanel(section: .voice); host.settle()
        check(!host.presentation.temporaryTopEntry && host.geometry.placement == .edge, "ordinary explicit tab navigation honors the selected edge placement")
        check(host.showVoice() && host.geometry.placement == .island, "voice shortcut relocates an open edge workbench to the top")
        host.dismissVoice(returnFocus: false)
        let staleClose = host.presentation.generation
        check(host.showVoice(), "voice can reopen while closing")
        host.finishTransition(staleClose)
        check(host.presentation.temporaryTopEntry && host.presentation.wantsExpanded, "late close receipt cannot restore side placement over a reopened voice")
        host.settle(); host.escape(); host.settle()
        check(escapes == 1 && !host.presentation.temporaryTopEntry && host.geometry.placement == .edge && host.panel?.isVisible == true, "Escape closes voice and restores the user's existing edge entry")
        host.mode = .menuBar; _ = host.showVoice(); host.settle(); host.dismissVoice(returnFocus: false)
        host.reduceMotion = true; host.repositionWindows()
        check(!host.presentation.temporaryTopEntry && host.geometry.placement == .menu && host.panel?.isVisible == false, "reduced motion changed during close also restores menu placement")
        host.reduceMotion = false
        host.panelPreferences.setSection(.voice, visible: false)
        host.select(.tasks)
        check(!host.visibleSections.contains(.voice), "hidden voice preference is respected away from its page")
        _ = host.showVoice(); host.settle()
        check(host.visibleSections.contains(.voice) && host.panelPreferences.configuration.hiddenSections.contains(.voice), "explicit shortcut temporarily exposes its selected tab without rewriting preferences")
        host.select(.tasks)
        check(!host.visibleSections.contains(.voice), "temporary selected tab disappears after leaving a hidden page")
        host.voiceStatus = "retained accepted request"; host.dismiss(returnFocus: false); host.settle(); host.showPanel()
        check(host.section == .voice && host.isShowing(.voice), "compact reopen selects the recent accepted voice result")
        host.configured = false
        check(!host.showVoice(), "unconfigured entry cannot begin presentation")
        print("\(checks) voice workbench assertions passed")
    }
}
