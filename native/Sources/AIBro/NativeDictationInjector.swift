import AppKit
import ApplicationServices
import Carbon

/// The app that owned keyboard focus when dictation began. Ephemeral; never persisted.
struct NativeDictationInjectTarget: Equatable, Sendable {
    let pid: pid_t
    let bundleID: String
    let launchedAt: Date?
    let name: String
    func isSameProcess(as other: Self) -> Bool {
        pid == other.pid && bundleID == other.bundleID && launchedAt == other.launchedAt
    }
}

/// What AX reports about the focused element. `value` is nil when the element
/// does not expose its text (many web and terminal views), so read-back cannot verify.
struct NativeDictationInjectField: Equatable, Sendable {
    var secure: Bool
    var value: String?
}

enum NativeDictationInjectOutcome: Equatable, Sendable {
    enum CopyReason: String, Equatable, Sendable { case secure, permission, targetChanged, noFocus, unverified, failed }
    case empty
    case typed
    case pasted
    case copied(CopyReason)
}

@MainActor protocol NativeDictationInjectEnvironment: AnyObject {
    var trusted: Bool { get }
    var secureInput: Bool { get }
    func frontmost() -> NativeDictationInjectTarget?
    func field(_ pid: pid_t) async -> NativeDictationInjectField?
    func type(_ chunks: [String], pid: pid_t) async -> Bool
    func paste(pid: pid_t) -> Bool
    var changeCount: Int { get }
    func backupPasteboard() -> [NSPasteboardItem]
    /// Writes `text` marked transient/auto-generated and returns the resulting change count.
    func writeTransient(_ text: String) -> Int
    /// Ordinary copy the user is expected to paste themselves.
    func copy(_ text: String)
    func restorePasteboard(_ items: [NSPasteboardItem])
    func sleep(_ seconds: Double) async
}

/// Delivers a finished transcript to the caret of another app.
///
/// Short single-line text is typed as Unicode keyboard events (no clipboard
/// side effects). Multi-line or long text, and typing that never shows up in
/// the field, is pasted through a transient clipboard item that is restored
/// about a second later unless someone else wrote the clipboard meanwhile.
/// Newlines are never typed: Return sends the message in most chat inputs.
@MainActor final class NativeDictationInjector {
    nonisolated static let typeLimit = 300
    nonisolated static let chunkUnits = 20
    nonisolated static let restoreDelay = 1.0

    private let environment: NativeDictationInjectEnvironment
    private var restoreTask: Task<Void, Never>?
    private var pending: (backup: [NSPasteboardItem], ours: Int)?

    init(environment: NativeDictationInjectEnvironment? = nil) {
        self.environment = environment ?? NativeDictationInjectSystemEnvironment()
    }

    var trusted: Bool { environment.trusted }
    func frontmost() -> NativeDictationInjectTarget? { environment.frontmost() }

    static func prefersTyping(_ text: String) -> Bool {
        text.count <= typeLimit && !text.contains(where: { $0 == "\n" || $0 == "\r" || $0 == "\t" || $0 == "\u{2028}" || $0 == "\u{2029}" })
    }

    /// Splits on grapheme clusters so surrogate pairs and ZWJ sequences stay whole.
    static func chunks(_ text: String, limit: Int = chunkUnits) -> [String] {
        var result: [String] = [], current = "", units = 0
        for character in text {
            let size = String(character).utf16.count
            if units > 0 && units + size > limit { result.append(current); current = ""; units = 0 }
            current.append(character); units += size
        }
        if !current.isEmpty { result.append(current) }
        return result
    }

    func inject(_ raw: String, into target: NativeDictationInjectTarget) async -> NativeDictationInjectOutcome {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return .empty }
        guard environment.trusted else { return copy(text, .permission) }
        guard let current = environment.frontmost(), current.isSameProcess(as: target) else { return copy(text, .targetChanged) }
        if environment.secureInput { return copy(text, .secure) }
        let before = await environment.field(target.pid)
        if before?.secure == true || environment.secureInput { return copy(text, .secure) }
        guard environment.frontmost()?.isSameProcess(as: target) == true else { return copy(text, .targetChanged) }
        if Self.prefersTyping(text) {
            guard await environment.type(Self.chunks(text), pid: target.pid) else { return await paste(text, target) }
            guard let old = before?.value else { return .typed }
            for _ in 0..<6 {
                await environment.sleep(0.05)
                guard let now = await environment.field(target.pid)?.value else { return .typed }
                if now.contains(text) && now != old { return .typed }
            }
            let after = await environment.field(target.pid)?.value
            // Nothing arrived: the view ignores synthetic Unicode events, so paste instead.
            // Something partial arrived: pasting again would duplicate; hand it to the user.
            if after == nil || after == old { return await paste(text, target) }
            return copy(text, .unverified)
        }
        return await paste(text, target)
    }

    private func paste(_ text: String, _ target: NativeDictationInjectTarget) async -> NativeDictationInjectOutcome {
        guard environment.frontmost()?.isSameProcess(as: target) == true else { return copy(text, .targetChanged) }
        if environment.secureInput { return copy(text, .secure) }
        restorePending()
        let backup = environment.backupPasteboard()
        let ours = environment.writeTransient(text)
        guard environment.paste(pid: target.pid) else {
            if environment.changeCount == ours { environment.restorePasteboard(backup) }
            return copy(text, .failed)
        }
        pending = (backup, ours)
        restoreTask = Task { @MainActor [weak self, environment] in
            await environment.sleep(Self.restoreDelay)
            guard !Task.isCancelled else { return }
            self?.restorePending()
        }
        return .pasted
    }

    private func copy(_ text: String, _ reason: NativeDictationInjectOutcome.CopyReason) -> NativeDictationInjectOutcome {
        environment.copy(text)
        return .copied(reason)
    }

    /// Restores a pending clipboard backup now (next paste, app quit). Skipped
    /// when anyone else wrote the clipboard after us: their content wins.
    func restorePending() {
        restoreTask?.cancel(); restoreTask = nil
        guard let pending else { return }
        self.pending = nil
        if environment.changeCount == pending.ours { environment.restorePasteboard(pending.backup) }
    }
}

@MainActor final class NativeDictationInjectSystemEnvironment: NativeDictationInjectEnvironment {
    private static let transient = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")
    private static let generated = NSPasteboard.PasteboardType("org.nspasteboard.AutoGeneratedType")
    private let pasteboard = NSPasteboard.general
    private let queue = DispatchQueue(label: "app.aibro.dictation.inject", qos: .userInitiated)

    var trusted: Bool { AXIsProcessTrusted() && CGPreflightPostEventAccess() }
    var secureInput: Bool { IsSecureEventInputEnabled() }

    func frontmost() -> NativeDictationInjectTarget? {
        guard let app = NSWorkspace.shared.frontmostApplication,
              app.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return nil }
        return .init(pid: app.processIdentifier, bundleID: app.bundleIdentifier ?? "", launchedAt: app.launchDate,
                     name: app.localizedName ?? app.bundleIdentifier ?? "")
    }

    func field(_ pid: pid_t) async -> NativeDictationInjectField? {
        await withCheckedContinuation { continuation in
            queue.async { continuation.resume(returning: Self.readField(pid)) }
        }
    }

    nonisolated private static func readField(_ pid: pid_t) -> NativeDictationInjectField? {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.15)
        var focused: AnyObject?
        guard AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
              let focused, CFGetTypeID(focused) == AXUIElementGetTypeID() else { return nil }
        let element = focused as! AXUIElement
        AXUIElementSetMessagingTimeout(element, 0.15)
        func string(_ name: String) -> String? {
            var value: AnyObject?
            return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value as? String : nil
        }
        let secure = string(kAXSubroleAttribute) == (kAXSecureTextFieldSubrole as String)
        return .init(secure: secure, value: secure ? nil : string(kAXValueAttribute))
    }

    func type(_ chunks: [String], pid: pid_t) async -> Bool {
        let source = CGEventSource(stateID: .privateState)
        for chunk in chunks {
            let units = Array(chunk.utf16)
            for down in [true, false] {
                guard let event = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_Space), keyDown: down) else { return false }
                event.flags = []
                units.withUnsafeBufferPointer { event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: $0.baseAddress) }
                event.postToPid(pid)
            }
            try? await Task.sleep(nanoseconds: 2_000_000)
        }
        return true
    }

    func paste(pid: pid_t) -> Bool {
        let source = CGEventSource(stateID: .privateState)
        let key = Self.keyCode(for: "v") ?? CGKeyCode(kVK_ANSI_V)
        for down in [true, false] {
            guard let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down) else { return false }
            event.flags = .maskCommand
            event.postToPid(pid)
        }
        return true
    }

    /// Finds the key that produces `character` in the current ASCII-capable layout (Dvorak, AZERTY...).
    static func keyCode(for character: String) -> CGKeyCode? {
        guard let source = TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue(),
              let raw = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { return nil }
        let data = Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
        return data.withUnsafeBytes { buffer -> CGKeyCode? in
            guard let layout = buffer.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return nil }
            for code in 0..<128 {
                var dead: UInt32 = 0, length = 0
                var chars = [UniChar](repeating: 0, count: 4)
                let status = UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDown), 0, UInt32(LMGetKbdType()),
                                            OptionBits(kUCKeyTranslateNoDeadKeysBit), &dead, chars.count, &length, &chars)
                if status == noErr, length > 0, String(utf16CodeUnits: chars, count: length) == character { return CGKeyCode(code) }
            }
            return nil
        }
    }

    var changeCount: Int { pasteboard.changeCount }

    func backupPasteboard() -> [NSPasteboardItem] {
        (pasteboard.pasteboardItems ?? []).map { item in
            let copy = NSPasteboardItem()
            for type in item.types { if let data = item.data(forType: type) { copy.setData(data, forType: type) } }
            return copy
        }
    }

    func writeTransient(_ text: String) -> Int {
        pasteboard.clearContents()
        let item = NSPasteboardItem()
        item.setString(text, forType: .string)
        item.setData(Data(), forType: Self.transient)
        item.setData(Data(), forType: Self.generated)
        pasteboard.writeObjects([item])
        return pasteboard.changeCount
    }

    func copy(_ text: String) {
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
    }

    func restorePasteboard(_ items: [NSPasteboardItem]) {
        pasteboard.clearContents()
        if !items.isEmpty { pasteboard.writeObjects(items) }
    }

    func sleep(_ seconds: Double) async { try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }
}
