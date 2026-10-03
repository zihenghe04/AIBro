import AppKit
import SwiftUI
func nativeUI(_ zh: String, _ en: String) -> String { en }
@main struct ClipboardAppearanceChecks {
    @MainActor static func main() async throws {
        _ = NSApplication.shared; NSApp.setActivationPolicy(.prohibited)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
        let text = "Synthetic complete preview.\nSelectable text must be legible in both appearances."
        let host = NSHostingView(rootView: NativeQuickClipboardPreviewText(text: text).environment(\.colorScheme, .dark))
        window.contentView = host; host.frame = window.contentLayoutRect
        func findText(_ view: NSView) -> NSTextView? {
            if let value = view as? NSTextView { return value }
            for child in view.subviews { if let value = findText(child) { return value } }
            return nil
        }
        var checks = 0
        for scheme in [ColorScheme.dark, .light, .dark] {
            // Deliberately give the host the opposite appearance, reproducing
            // an island SwiftUI override inside a system-light AppKit window.
            window.appearance = NSAppearance(named: scheme == .dark ? .aqua : .darkAqua)
            host.rootView = NativeQuickClipboardPreviewText(text: text).environment(\.colorScheme, scheme)
            for _ in 0..<12 { host.layoutSubtreeIfNeeded(); try await Task.sleep(nanoseconds: 5_000_000) }
            guard let view = findText(host), let scroll = view.enclosingScrollView else { fatalError("Production text surface missing") }
            let expected: NSAppearance.Name = scheme == .dark ? .darkAqua : .aqua
            precondition(view.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == expected, "Text follows the SwiftUI scheme, not the opposite window")
            precondition(scroll.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == expected, "Scroller follows the text scheme")
            var brightness: CGFloat = -1
            view.effectiveAppearance.performAsCurrentDrawingAppearance { brightness = view.textColor!.usingColorSpace(.genericGray)!.whiteComponent }
            precondition(scheme == .dark ? brightness > 0.7 : brightness < 0.3, "Label color has the expected light/dark contrast")
            precondition(view.string == text && view.isSelectable && !view.isEditable, "Theme updates preserve the full read-only text")
            view.setSelectedRange(NSRange(location: 0, length: 9)); precondition(view.selectedRange().length == 9)
            checks += 5
        }
        print("PASS: \(checks) focused text appearance checks; actual modal sheet appearance requires native QA")
    }
}
