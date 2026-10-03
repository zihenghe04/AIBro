import SwiftUI
import AppKit

/// A source editor shared by the island's home, new capture and saved capture.
/// The binding remains owned by the existing durable draft/ACK stores.
struct NativeQuickCaptureTextEditor: NSViewRepresentable {
    @Binding var text: String
    // This is AppKit responder intent, not a SwiftUI FocusState. An unregistered
    // FocusState can reset to false after NSTextView takes focus, which would
    // otherwise make an ordinary parent refresh clear the real first responder.
    @Binding var focused: Bool
    var locked = false
    var fontSize: CGFloat = 13
    var lineSpacing: CGFloat = 4
    var routesHomeWheel = false
    var label: String
    var onFocus: () -> Void = {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NativeQuickCaptureScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = false
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        let editor = NativeQuickCaptureTextView(frame: .zero)
        editor.isRichText = false
        editor.allowsUndo = true
        editor.drawsBackground = false
        editor.isVerticallyResizable = true
        editor.isHorizontallyResizable = false
        editor.autoresizingMask = [.width]
        editor.minSize = .zero
        editor.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        editor.textContainer?.widthTracksTextView = true
        editor.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        editor.textContainerInset = NSSize(width: 4, height: 6)
        editor.textContainer?.lineFragmentPadding = 0
        editor.isAutomaticQuoteSubstitutionEnabled = false
        editor.isAutomaticDashSubstitutionEnabled = false
        editor.isAutomaticTextReplacementEnabled = false
        editor.isAutomaticSpellingCorrectionEnabled = false
        editor.isContinuousSpellCheckingEnabled = false
        editor.isAutomaticLinkDetectionEnabled = false
        editor.isAutomaticDataDetectionEnabled = false
        editor.delegate = context.coordinator
        editor.prepareInput = { [weak coordinator = context.coordinator] in coordinator?.parent.onFocus() }
        editor.focusChanged = { [weak coordinator = context.coordinator] value in coordinator?.focusChanged(value) }
        scroll.documentView = editor
        context.coordinator.editor = editor
        NativeQuickCaptureFocusDebug.register(editor)
        updateNSView(scroll, context: context)
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        (scroll as? NativeQuickCaptureScrollView)?.routesHomeWheel = routesHomeWheel
        guard let editor = scroll.documentView as? NativeQuickCaptureTextView else { return }
        editor.isEditable = !locked
        editor.font = .systemFont(ofSize: fontSize)
        editor.textColor = .labelColor
        editor.insertionPointColor = .labelColor
        editor.setAccessibilityLabel(label)
        editor.boldPlaceholder = nativeUI("加粗文字", "Bold text")
        editor.italicPlaceholder = nativeUI("斜体文字", "Italic text")
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = lineSpacing
        editor.defaultParagraphStyle = paragraph
        // A SwiftUI refresh must never replace an IME marked range or reset the
        // selection/undo on each keystroke. External reloads are not undoable.
        if editor.string != text, !editor.hasMarkedText() {
            let old = editor.selectedRange()
            editor.string = text
            editor.undoManager?.removeAllActions()
            let location = min(old.location, text.utf16.count)
            editor.setSelectedRange(NSRange(location: location, length: min(old.length, text.utf16.count - location)))
        }
        coordinator.requestFocus(focused && !locked)
        NativeQuickCaptureFocusDebug.record("update wanted=\(focused) locked=\(locked)", editor)
    }

    static func dismantleNSView(_ scroll: NSScrollView, coordinator: Coordinator) {
        coordinator.focusGeneration += 1
        if let editor = scroll.documentView as? NativeQuickCaptureTextView {
            NativeQuickCaptureFocusDebug.record("dismantle", editor)
            editor.focusChanged = nil
            editor.prepareInput = nil
            editor.delegate = nil
        }
        coordinator.editor = nil
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: NativeQuickCaptureTextEditor
        weak var editor: NativeQuickCaptureTextView?
        var focusGeneration = 0
        init(_ parent: NativeQuickCaptureTextEditor) { self.parent = parent }
        func textDidChange(_ notification: Notification) {
            guard let editor = notification.object as? NativeQuickCaptureTextView else { return }
            if editor.window?.firstResponder === editor {
                (editor.enclosingScrollView as? NativeQuickCaptureScrollView)?.beginUserEditing()
            }
            NativeQuickCaptureFocusDebug.record("textDidChange", editor)
            if parent.text != editor.string { parent.text = editor.string }
        }
        func focusChanged(_ focused: Bool) {
            // A click/Tab to another control outranks an update queued earlier
            // in this run loop. Do not let that stale request steal focus back.
            focusGeneration += 1
            if let editor { NativeQuickCaptureFocusDebug.record("focusChanged=\(focused) generation=\(focusGeneration)", editor) }
            if parent.focused != focused { parent.focused = focused }
        }
        func requestFocus(_ wanted: Bool) {
            focusGeneration += 1
            let generation = focusGeneration
            if let editor { NativeQuickCaptureFocusDebug.record("queue wanted=\(wanted) generation=\(generation)", editor) }
            DispatchQueue.main.async { [weak self] in
                guard let self, let editor = self.editor else { return }
                guard generation == self.focusGeneration, let window = editor.window else {
                    NativeQuickCaptureFocusDebug.record("skipStale requested=\(generation) latest=\(self.focusGeneration)", editor); return
                }
                guard wanted == (self.parent.focused && !self.parent.locked) else {
                    NativeQuickCaptureFocusDebug.record("skipBinding wanted=\(wanted)", editor); return
                }
                if wanted, editor.isEditable, window.firstResponder !== editor {
                    let accepted = window.makeFirstResponder(editor)
                    NativeQuickCaptureFocusDebug.record("commitFocus accepted=\(accepted)", editor)
                } else if !wanted, window.firstResponder === editor {
                    let accepted = window.makeFirstResponder(nil)
                    NativeQuickCaptureFocusDebug.record("clearFocus accepted=\(accepted)", editor)
                }
            }
        }
    }
}

final class NativeQuickCaptureTextView: NSTextView {
    var focusChanged: ((Bool) -> Void)?
    var prepareInput: (() -> Void)?
    var boldPlaceholder = "Bold text"
    var italicPlaceholder = "Italic text"
    private let captureUndoManager = UndoManager()
    private var preparingInput = false
    override var undoManager: UndoManager? { captureUndoManager }

    override func becomeFirstResponder() -> Bool {
        NativeQuickCaptureFocusDebug.record("willBecome", self)
        prepareInputIfNeeded()
        let accepted = super.becomeFirstResponder()
        if accepted, let event = NSApp.currentEvent, event.type == .keyDown, event.keyCode == 48 {
            (enclosingScrollView as? NativeQuickCaptureScrollView)?.beginUserEditing()
        }
        if accepted { focusChanged?(true) }
        NativeQuickCaptureFocusDebug.record("didBecome accepted=\(accepted)", self)
        return accepted
    }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { isEditable || super.acceptsFirstMouse(for: event) }
    override func mouseDown(with event: NSEvent) {
        NativeQuickCaptureFocusDebug.record("mouseDown", self)
        // A nonactivating island panel must acquire input before NSTextView
        // starts selection/tracking; waiting for did-begin-focus is too late.
        prepareInputIfNeeded()
        (enclosingScrollView as? NativeQuickCaptureScrollView)?.beginUserEditing()
        super.mouseDown(with: event)
    }
    private func prepareInputIfNeeded() {
        guard isEditable, !preparingInput else { return }
        preparingInput = true
        defer { preparingInput = false }
        prepareInput?()
    }
    override func resignFirstResponder() -> Bool {
        NativeQuickCaptureFocusDebug.record("willResign", self)
        let accepted = super.resignFirstResponder()
        if accepted { (enclosingScrollView as? NativeQuickCaptureScrollView)?.endUserEditing() }
        if accepted { focusChanged?(false) }
        NativeQuickCaptureFocusDebug.record("didResign accepted=\(accepted)", self)
        return accepted
    }
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if (flags.contains(.command) || flags.contains(.control)), !flags.contains(.option),
           let key = event.charactersIgnoringModifiers?.lowercased(), key == "b" || key == "i",
           window?.firstResponder === self {
            (enclosingScrollView as? NativeQuickCaptureScrollView)?.beginUserEditing()
            return format(key == "b" ? .bold : .italic)
        }
        return super.performKeyEquivalent(with: event)
    }
    override func keyDown(with event: NSEvent) {
        if isEditable, window?.firstResponder === self {
            (enclosingScrollView as? NativeQuickCaptureScrollView)?.beginUserEditing()
        }
        super.keyDown(with: event)
    }
    @objc func toggleBoldface(_ sender: Any?) { _ = format(.bold) }
    @objc func toggleItalics(_ sender: Any?) { _ = format(.italic) }

    // NSTextView records edits in our per-record manager, but the stock Edit
    // menu otherwise finds NSWindow's undo:/redo: and its unrelated manager.
    // Keep these actions in the first-responder chain so both menu validation
    // and standard Cmd-Z / Shift-Cmd-Z use the same isolated history.
    @objc func undo(_ sender: Any?) {
        guard canUndoCapture else { return }
        breakUndoCoalescing()
        captureUndoManager.undo()
    }
    @objc func redo(_ sender: Any?) {
        guard canRedoCapture else { return }
        breakUndoCoalescing()
        captureUndoManager.redo()
    }
    private var canUndoCapture: Bool { isEditable && !hasMarkedText() && captureUndoManager.canUndo }
    private var canRedoCapture: Bool { isEditable && !hasMarkedText() && captureUndoManager.canRedo }
    override func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem.action == #selector(undo(_:)) { return canUndoCapture }
        if menuItem.action == #selector(redo(_:)) { return canRedoCapture }
        return super.validateMenuItem(menuItem)
    }
    override func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        if item.action == #selector(undo(_:)) { return canUndoCapture }
        if item.action == #selector(redo(_:)) { return canRedoCapture }
        return super.validateUserInterfaceItem(item)
    }

    override func insertNewline(_ sender: Any?) {
        let flags = NSApp?.currentEvent?.modifierFlags.intersection([.command, .control, .option, .shift]) ?? []
        if flags.isEmpty, isEditable, !hasMarkedText(), selectedRanges.count == 1,
           let edit = NativeQuickCaptureMarkup.continueList(text: string, selection: selectedRange()) {
            apply(edit)
        } else { super.insertNewline(sender) }
    }

    @discardableResult func format(_ style: NativeQuickCaptureMarkup.Inline) -> Bool {
        guard isEditable, !hasMarkedText(), selectedRanges.count == 1,
              let edit = NativeQuickCaptureMarkup.inline(style, text: string, selection: selectedRange(),
                  placeholder: style == .bold ? boldPlaceholder : italicPlaceholder) else { return false }
        apply(edit)
        return true
    }
    private func apply(_ edit: NativeQuickCaptureMarkup.Edit) {
        // NSTextInputClient's normal insertion path retains native undo,
        // selection and delegate notifications. Do not assign string here.
        breakUndoCoalescing()
        insertText(edit.replacement, replacementRange: edit.range)
        setSelectedRange(edit.selection)
        scrollRangeToVisible(edit.selection)
        breakUndoCoalescing()
    }
}

/// Opt-in, local DEBUG diagnostics. Never logs text, selection offsets, key
/// codes, characters, clipboard data or window titles. Production is a no-op.
private enum NativeQuickCaptureFocusDebug {
#if DEBUG
    private static let enabled = ProcessInfo.processInfo.environment["AIBRO_CAPTURE_FOCUS_DEBUG"] == "1" ||
        UserDefaults.standard.bool(forKey: "AIBroCaptureFocusDebug")
    private static var editors = NSHashTable<NativeQuickCaptureTextView>.weakObjects()
    private static var monitor: Any?
    private static var lines = 0
    private static let file = FileManager.default.temporaryDirectory.appendingPathComponent("aibro-capture-focus-\(ProcessInfo.processInfo.processIdentifier).log")
    static func register(_ editor: NativeQuickCaptureTextView) {
        guard enabled else { return }
        editors.add(editor)
        if monitor == nil {
            monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .keyDown]) { event in
                guard let window = event.window ?? NSApp.keyWindow else { return event }
                let candidates = editors.allObjects.filter { $0.window === window }
                guard !candidates.isEmpty else { return event }
                let hit: NSView?
                if event.type == .leftMouseDown, let root = window.contentView {
                    let point = root.superview?.convert(event.locationInWindow, from: nil) ?? event.locationInWindow
                    hit = root.hitTest(point)
                } else { hit = nil }
                for editor in candidates {
                    record("event=\(event.type == .leftMouseDown ? "mouse" : "key") hit=\(kind(hit))", editor)
                }
                return event
            }
        }
        record("register", editor)
    }
    private static func kind(_ value: AnyObject?) -> String {
        guard let value else { return "nil" }
        return String(reflecting: type(of: value))
    }
    static func record(_ event: String, _ editor: NativeQuickCaptureTextView) {
        guard enabled, lines < 1500 else { return }
        lines += 1
        let window = editor.window
        let line = "\(Date().timeIntervalSince1970) \(event) editor=\(ObjectIdentifier(editor)) frame=\(editor.frame) inWindow=\(editor.convert(editor.bounds,to:nil)) clip=\(editor.enclosingScrollView?.contentView.bounds ?? .zero) editable=\(editor.isEditable) hidden=\(editor.isHiddenOrHasHiddenAncestor) marked=\(editor.hasMarkedText()) first=\(kind(window?.firstResponder)) isSelf=\(window?.firstResponder === editor) key=\(window?.isKeyWindow ?? false) canKey=\(window?.canBecomeKey ?? false) ignoresMouse=\(window?.ignoresMouseEvents ?? false) appActive=\(NSApp?.isActive ?? false)\n"
        guard let data = line.data(using: .utf8) else { return }
        if !FileManager.default.fileExists(atPath: file.path) {
            FileManager.default.createFile(atPath: file.path, contents: Data(), attributes: [.posixPermissions: 0o600])
        }
        guard let handle = try? FileHandle(forWritingTo: file) else { return }
        defer { try? handle.close() }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: data)
    }
#else
    static func register(_ editor: NativeQuickCaptureTextView) {}
    static func record(_ event: String, _ editor: NativeQuickCaptureTextView) {}
#endif
}
