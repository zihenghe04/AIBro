import ApplicationServices
import AppKit
import Combine
import Carbon.HIToolbox

/// Which physical key starts dictate-to-cursor. The modifier choices are used
/// alone (no other key), so they never collide with ⌃⌥V or any combo.
enum NativeDictateTriggerKind: String, CaseIterable, Codable, Sendable {
    case rightOption, rightCommand, combo
    var keyCode: UInt16? {
        switch self { case .rightOption: return UInt16(kVK_RightOption); case .rightCommand: return UInt16(kVK_RightCommand); case .combo: return nil }
    }
    /// Device-dependent bits of NSEvent.modifierFlags (NX_DEVICERALTKEYMASK, NX_DEVICERCMDKEYMASK).
    var deviceMask: UInt { switch self { case .rightOption: return 0x40; case .rightCommand: return 0x10; case .combo: return 0 } }
    var label: String {
        switch self {
        case .rightOption: return nativeUI("右侧 ⌥", "Right ⌥")
        case .rightCommand: return nativeUI("右侧 ⌘", "Right ⌘")
        case .combo: return nativeUI("组合键", "Shortcut")
        }
    }
}

/// Turns raw modifier and key events into press / release / abort for a lone
/// modifier trigger. Pure value type so the edge cases are testable.
struct NativeDictateModifierTracker {
    enum Input: Equatable { case flags(keyCode: UInt16, raw: UInt), key, pointer }
    enum Output: Equatable { case press, release, abort }
    let kind: NativeDictateTriggerKind
    private var down = false
    private var aborted = false
    private static let others: NSEvent.ModifierFlags = [.command, .control, .option, .shift, .function]

    init(kind: NativeDictateTriggerKind) { self.kind = kind }

    mutating func receive(_ input: Input) -> Output? {
        guard let trigger = kind.keyCode else { return nil }
        switch input {
        case .key, .pointer:
            guard down, !aborted else { return nil }
            aborted = true; return .abort
        case let .flags(keyCode, raw):
            let flags = NSEvent.ModifierFlags(rawValue: raw)
            if keyCode == trigger {
                let pressed = raw & kind.deviceMask != 0
                if pressed && !down {
                    // Already holding another modifier: this is a chord, not dictation.
                    var rest = flags.intersection(Self.others)
                    rest.remove(kind == .rightOption ? .option : .command)
                    let sameSideOther = raw & (kind == .rightOption ? 0x20 : 0x08) != 0
                    down = true; aborted = !rest.isEmpty || sameSideOther
                    return aborted ? nil : .press
                }
                if !pressed && down {
                    down = false
                    if aborted { aborted = false; return nil }
                    return .release
                }
                return nil
            }
            guard down, !aborted else { return nil }
            aborted = true; return .abort
        }
    }

    mutating func reset() { down = false; aborted = false }
}

@MainActor protocol NativeDictateMonitorService {
    /// Observes trigger-key events system-wide. Returns a token that stops observing on cancel.
    func observe(_ handler: @escaping @MainActor (NativeDictateModifierTracker.Input) -> Void) -> NativeQuickShortcutRegistration?
}

/// Maps one raw event to tracker input; shared by the event tap and the
/// NSEvent fallback so both report the same thing.
enum NativeDictateEventInput {
    static func input(type: CGEventType, keyCode: UInt16, flags: UInt64) -> NativeDictateModifierTracker.Input? {
        switch type {
        case .flagsChanged: return .flags(keyCode: keyCode, raw: UInt(flags))
        case .keyDown: return .key
        case .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel: return .pointer
        default: return nil
        }
    }
    /// Every event type the trigger watches.
    static let mask: CGEventMask = [CGEventType.flagsChanged, .keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel]
        .reduce(0) { $0 | (CGEventMask(1) << $1.rawValue) }
}

/// Session-level, listen-only event tap on the main run loop. Unlike a global
/// NSEvent monitor it also hears keys while AI Bro itself is frontmost, and
/// it is re-enabled when macOS disables it for timeout or user input. Falls
/// back to global + local NSEvent monitors when the tap cannot be created
/// (Input Monitoring not granted yet).
@MainActor final class NativeDictateEventMonitor: NativeDictateMonitorService {
    private(set) var lastMechanism = "none"

    func observe(_ handler: @escaping @MainActor (NativeDictateModifierTracker.Input) -> Void) -> NativeQuickShortcutRegistration? {
        let diagnostics = Diagnostics()
        let deliver: @MainActor (CGEventType, UInt16, UInt64, String) -> Void = { type, keyCode, flags, source in
            if type == .flagsChanged { diagnostics.flags(keyCode: keyCode, raw: flags, source: source) }
            guard let input = NativeDictateEventInput.input(type: type, keyCode: keyCode, flags: flags) else { return }
            handler(input)
        }
        if let tap = TapToken(deliver: deliver) {
            lastMechanism = "eventTap"
            dictateLog("eventTap created listenEvent=\(CGPreflightListenEventAccess()) ax=\(AXIsProcessTrusted())")
            return tap
        }
        dictateLog("eventTap create failed listenEvent=\(CGPreflightListenEventAccess()) ax=\(AXIsProcessTrusted()); using NSEvent monitors")
        lastMechanism = "nsevent"
        let matching: NSEvent.EventTypeMask = [.flagsChanged, .keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel]
        let forward: (NSEvent, String) -> Void = { event, source in
            guard let type = CGEventType(rawValue: UInt32(event.type.rawValue)) else { return }
            let keyCode = event.type == .flagsChanged || event.type == .keyDown ? event.keyCode : 0
            MainActor.assumeIsolated { deliver(type, keyCode, UInt64(event.modifierFlags.rawValue), source) }
        }
        let global = NSEvent.addGlobalMonitorForEvents(matching: matching) { forward($0, "global") }
        let local = NSEvent.addLocalMonitorForEvents(matching: matching) { forward($0, "local"); return $0 }
        dictateLog("nsevent monitors global=\(global != nil) local=\(local != nil)")
        guard global != nil || local != nil else { return nil }
        return MonitorToken([global, local].compactMap { $0 })
    }

    /// Counts modifier events and logs the trigger keys with the frontmost
    /// app, so a silent log tells "no events at all" from "wrong key".
    @MainActor private final class Diagnostics {
        private var count = 0
        func flags(keyCode: UInt16, raw: UInt64, source: String) {
            count += 1
            let trigger = keyCode == UInt16(kVK_RightOption) || keyCode == UInt16(kVK_RightCommand)
            guard trigger || count <= 3 || count % 50 == 0 else { return }
            let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "?"
            dictateLog("flagsChanged #\(count) via=\(source) key=\(keyCode) raw=0x\(String(raw, radix: 16)) front=\(front)")
        }
    }

    private final class TapToken: NativeQuickShortcutRegistration {
        private var tap: CFMachPort?
        private var source: CFRunLoopSource?
        private let deliver: @MainActor (CGEventType, UInt16, UInt64, String) -> Void

        @MainActor init?(deliver: @escaping @MainActor (CGEventType, UInt16, UInt64, String) -> Void) {
            self.deliver = deliver
            let callback: CGEventTapCallBack = { _, type, event, info in
                guard let info else { return Unmanaged.passUnretained(event) }
                let token = Unmanaged<TapToken>.fromOpaque(info).takeUnretainedValue()
                token.handle(type, event)
                return Unmanaged.passUnretained(event)
            }
            guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                                              eventsOfInterest: NativeDictateEventInput.mask, callback: callback,
                                              userInfo: Unmanaged.passUnretained(self).toOpaque()) else { return nil }
            self.tap = tap
            let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
            self.source = source
            CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
            CGEvent.tapEnable(tap: tap, enable: true)
        }

        /// The tap lives on the main run loop, so callbacks arrive on the main thread.
        nonisolated private func handle(_ type: CGEventType, _ event: CGEvent) {
            MainActor.assumeIsolated {
                if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                    dictateLog("eventTap disabled (\(type == .tapDisabledByTimeout ? "timeout" : "userInput")); re-enabling")
                    if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
                    return
                }
                let keyCode = UInt16(truncatingIfNeeded: event.getIntegerValueField(.keyboardEventKeycode))
                deliver(type, type == .flagsChanged || type == .keyDown ? keyCode : 0, event.flags.rawValue, "tap")
            }
        }

        func cancel() {
            if let tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }
            if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
            tap = nil; source = nil
        }
    }

    private final class MonitorToken: NativeQuickShortcutRegistration {
        private var monitors: [Any]
        init(_ monitors: [Any]) { self.monitors = monitors }
        func cancel() { monitors.forEach(NSEvent.removeMonitor); monitors = [] }
    }
}

/// Owns the dictate-to-cursor preferences and the live trigger. Off by
/// default: it needs Accessibility access and listens to a bare modifier.
@MainActor final class NativeDictateTriggerStore: ObservableObject {
    static let enabledPreferenceKey = "ai-bro-native-dictate-enabled-v1"
    static let kindPreferenceKey = "ai-bro-native-dictate-trigger-v1"
    static let comboPreferenceKey = "ai-bro-native-dictate-combo-v1"
    static let standardCombo = NativeQuickShortcut(keyCode: UInt32(kVK_ANSI_D), modifiers: UInt32(controlKey | optionKey))
    @Published private(set) var enabled: Bool
    @Published private(set) var kind: NativeDictateTriggerKind
    @Published private(set) var combo: NativeQuickShortcut
    @Published private(set) var issue: String?
    @Published private(set) var active = false
    @Published private(set) var recording = false
    /// The feature is on but macOS has not granted Accessibility, so the
    /// trigger cannot hear keys and nothing can be typed. Surfaced, never silent.
    @Published private(set) var needsAccess = false
    /// Called once each time access goes from fine to missing.
    var onNeedsAccess: (() -> Void)?
    var onPress: (() -> Void)?
    var onRelease: (() -> Void)?
    var onAbort: (() -> Void)?
    /// Shortcuts already taken by other AI Bro entries (quick entry, voice).
    var reserved: () -> [NativeQuickShortcut] = { [] }
    private let preferences: UserDefaults
    private let trusted: () -> Bool
    private let monitor: NativeDictateMonitorService
    private let carbon: NativeSpeechShortcutService
    private var registration: NativeQuickShortcutRegistration?
    private var tracker: NativeDictateModifierTracker
    private var token: UUID?

    init(preferences: UserDefaults = .standard, monitor: NativeDictateMonitorService? = nil, carbon: NativeSpeechShortcutService? = nil,
         trusted: @escaping () -> Bool = { AXIsProcessTrusted() }) {
        self.trusted = trusted
        self.preferences = preferences
        self.monitor = monitor ?? NativeDictateEventMonitor()
        self.carbon = carbon ?? NativeSpeechCarbonShortcut()
        enabled = preferences.object(forKey: Self.enabledPreferenceKey) as? Bool ?? true
        let savedKind = preferences.string(forKey: Self.kindPreferenceKey).flatMap(NativeDictateTriggerKind.init(rawValue:)) ?? .rightOption
        let saved = preferences.data(forKey: Self.comboPreferenceKey).flatMap { try? JSONDecoder().decode(NativeQuickShortcut.self, from: $0) }
        combo = saved?.valid == true ? saved! : Self.standardCombo
        kind = savedKind
        tracker = .init(kind: savedKind)
    }

    var registered: Bool { registration != nil }
    var label: String { kind == .combo ? combo.label : kind.label }

    func setEnabled(_ value: Bool) {
        guard enabled != value else { return }
        preferences.set(value, forKey: Self.enabledPreferenceKey)
        enabled = value
        refresh()
        recheckAccess()
    }

    func setKind(_ value: NativeDictateTriggerKind) {
        guard kind != value else { return }
        if value == .combo, let problem = conflict(combo) { issue = problem; return }
        preferences.set(value.rawValue, forKey: Self.kindPreferenceKey)
        kind = value
        refresh(force: true)
    }

    /// The app-wide switch (settings loaded, not quitting). Independent of the user's enabled preference.
    func setActive(_ value: Bool) {
        active = value
        refresh()
        recheckAccess()
    }

    /// Reinstalls the live trigger, e.g. after Accessibility access was granted.
    func reinstall() { refresh(force: true) }

    /// Re-reads Accessibility trust. A global monitor installed before the
    /// grant can stay deaf, so a missing-to-granted flip reinstalls it.
    func recheckAccess() {
        let missing = enabled && active && !trusted()
        dictateLog("recheckAccess enabled=\(enabled) active=\(active) trusted=\(!missing || !(enabled && active)) needsAccess=\(missing)")
        if missing == needsAccess { return }
        needsAccess = missing
        if missing { onNeedsAccess?() } else if enabled && active { reinstall() }
    }

    func setRecording(_ value: Bool) {
        recording = value
        refresh()
    }

    @discardableResult func apply(_ candidate: NativeQuickShortcut) -> Bool {
        if let problem = conflict(candidate) { issue = problem; return false }
        let previous = combo
        combo = candidate
        if kind == .combo { refresh(force: true) }
        if kind == .combo && enabled && active && registration == nil {
            combo = previous; refresh(force: true)
            issue = nativeUI("该组合键暂不可用，已保留原设置。", "That shortcut is unavailable; the previous one is kept.")
            return false
        }
        preferences.set(try? JSONEncoder().encode(candidate), forKey: Self.comboPreferenceKey)
        issue = nil
        return true
    }

    private func conflict(_ candidate: NativeQuickShortcut) -> String? {
        guard candidate.valid else {
            return nativeUI("请使用带 ⌃、⌥ 或 ⌘ 的组合键，避开系统切换与常用编辑快捷键。", "Use a shortcut with ⌃, ⌥ or ⌘, avoiding system switching and standard editing shortcuts.")
        }
        if reserved().contains(candidate) {
            return nativeUI("这个组合键已被 AI Bro 的其他入口使用。", "Another AI Bro entry already uses that shortcut.")
        }
        return nil
    }

    private func refresh(force: Bool = false) {
        let wanted = enabled && active && !recording
        dictateLog("refresh wanted=\(wanted) enabled=\(enabled) active=\(active) recording=\(recording) force=\(force)")
        if !wanted || force {
            registration?.cancel(); registration = nil; token = nil
            tracker.reset()
        }
        guard wanted, registration == nil else { return }
        let current = UUID()
        token = current
        tracker = .init(kind: kind)
        if kind == .combo {
            registration = try? carbon.register(combo, action: { [weak self] in
                guard let self, self.token == current else { return }
                self.onPress?()
            }, release: { [weak self] in
                guard let self, self.token == current else { return }
                self.onRelease?()
            })
            if registration == nil { issue = nativeUI("该组合键暂不可用。", "That shortcut is unavailable.") }
        } else {
            registration = monitor.observe { [weak self] input in
                guard let self, self.token == current else { return }
                switch self.tracker.receive(input) {
                case .press: dictateLog("trigger press"); self.onPress?()
                case .release: dictateLog("trigger release"); self.onRelease?()
                case .abort: dictateLog("trigger abort"); self.onAbort?()
                case nil: break
                }
            }
            dictateLog("monitor installed=\(registration != nil) kind=\(kind.rawValue)")
        }
    }
}
