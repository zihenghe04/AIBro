import AppKit
import Combine
import Carbon.HIToolbox

/// Accept only paired physical transitions. A repeated press or unpaired
/// release never starts or finishes a speech operation.
struct NativeSpeechShortcutPressGate {
    private(set) var held = false
    private var awaitingRelease = false
    mutating func receive(pressed: Bool) -> Bool {
        if !pressed {
            if awaitingRelease { awaitingRelease = false; return false }
            guard held else { return false }; held = false; return true
        }
        guard !held, !awaitingRelease else { return false }
        held = true
        return true
    }
    mutating func reset(suppressUntilRelease: Bool = false) {
        awaitingRelease = suppressUntilRelease && (held || awaitingRelease)
        held = false
    }
}

@MainActor protocol NativeSpeechShortcutRegistration: NativeQuickShortcutRegistration {
    func resetPress()
}
@MainActor protocol NativeSpeechShortcutService {
    func register(_ shortcut: NativeQuickShortcut, action: @escaping () -> Void, release: @escaping () -> Void) throws -> NativeSpeechShortcutRegistration
}

/// Uses a separate Carbon identity from the existing quick-entry shortcut.
/// IDs are unique across instances of this service, not just registrations in
/// one Store. Registering this service never requests input-monitoring access.
@MainActor final class NativeSpeechCarbonShortcut: NativeSpeechShortcutService {
    static let signature: UInt32 = 0x41494256 // AIBV
    private static var nextID: UInt32 = 1
    func register(_ shortcut: NativeQuickShortcut, action: @escaping () -> Void, release: @escaping () -> Void) throws -> NativeSpeechShortcutRegistration {
        let id = Self.nextID
        guard id != UInt32.max else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(paramErr)) }
        Self.nextID += 1
        return try Registration(shortcut, id: id, action: action, release: release)
    }
    private final class Registration: NativeSpeechShortcutRegistration {
        private var hotkey: EventHotKeyRef?
        private var handler: EventHandlerRef?
        private let id: UInt32
        private let action: () -> Void
        private let release: () -> Void
        private var press = NativeSpeechShortcutPressGate()
        init(_ shortcut: NativeQuickShortcut, id: UInt32, action: @escaping () -> Void, release: @escaping () -> Void) throws {
            self.id = id; self.action = action; self.release = release
            var specs = [
                EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
                EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased))
            ]
            let installed = InstallEventHandler(GetApplicationEventTarget(), { _, event, context in
                guard let event, let context else { return OSStatus(eventNotHandledErr) }
                var identifier = EventHotKeyID()
                guard GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                                        MemoryLayout<EventHotKeyID>.size, nil, &identifier) == noErr,
                      identifier.signature == NativeSpeechCarbonShortcut.signature else { return OSStatus(eventNotHandledErr) }
                let kind = GetEventKind(event)
                guard kind == UInt32(kEventHotKeyPressed) || kind == UInt32(kEventHotKeyReleased) else { return OSStatus(eventNotHandledErr) }
                let registration = Unmanaged<Registration>.fromOpaque(context).takeUnretainedValue()
                return MainActor.assumeIsolated {
                    guard registration.id == identifier.id, registration.hotkey != nil else { return OSStatus(eventNotHandledErr) }
                    let pressed = kind == UInt32(kEventHotKeyPressed)
                    if registration.press.receive(pressed: pressed) {
                        if pressed { registration.action() } else { registration.release() }
                    }
                    return noErr
                }
            }, specs.count, &specs, Unmanaged.passUnretained(self).toOpaque(), &handler)
            guard installed == noErr else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(installed)) }
            let result = RegisterEventHotKey(shortcut.keyCode, shortcut.modifiers,
                                            .init(signature: NativeSpeechCarbonShortcut.signature, id: id),
                                            GetApplicationEventTarget(), 0, &hotkey)
            if result != noErr { cancel(); throw NSError(domain: NSOSStatusErrorDomain, code: Int(result)) }
        }
        // Changing mode or entering shortcut capture while physically held
        // must not turn the next autorepeat into a fresh command.
        func resetPress() { press.reset(suppressUntilRelease: true) }
        func cancel() {
            press.reset()
            if let hotkey { UnregisterEventHotKey(hotkey) }
            if let handler { RemoveEventHandler(handler) }
            hotkey = nil; handler = nil
        }
        deinit {
            if let hotkey { UnregisterEventHotKey(hotkey) }
            if let handler { RemoveEventHandler(handler) }
        }
    }
}

/// Matches the existing shortcut value/label/validation API but owns its saved
/// binding. Registration failure keeps both the previous binding and preference.
@MainActor final class NativeSpeechShortcutStore: ObservableObject {
    enum Mode: String, CaseIterable { case hold, toggle }
    static let preferenceKey = "ai-bro-native-speech-shortcut-v1"
    static let modePreferenceKey = "ai-bro-native-speech-shortcut-mode-v1"
    static let autoSubmitPreferenceKey = "ai-bro-native-speech-shortcut-auto-submit-v1"
    static let standard = NativeQuickShortcut(keyCode: UInt32(kVK_ANSI_V), modifiers: UInt32(controlKey | optionKey))
    @Published private(set) var shortcut: NativeQuickShortcut
    @Published private(set) var mode: Mode
    @Published private(set) var autoSubmit: Bool
    @Published private(set) var issue: String?
    @Published private(set) var active = false
    @Published private(set) var recording = false
    private let preferences: UserDefaults
    private let service: NativeSpeechShortcutService
    private var registration: NativeSpeechShortcutRegistration?
    private var registrationToken: UUID?
    private var pressedRegistration: UUID?
    /// Both modes receive physical down/up. The coordinator decides whether
    /// release finishes a hold session; no UI setting synthesizes a key-up.
    var onInvoke: (() -> Void)?
    var onRelease: (() -> Void)?
    var registered: Bool { registration != nil }
    var isHeld: Bool { pressedRegistration != nil }

    init(preferences: UserDefaults = .standard, service: NativeSpeechShortcutService? = nil) {
        self.preferences = preferences; self.service = service ?? NativeSpeechCarbonShortcut()
        let saved = preferences.data(forKey: Self.preferenceKey).flatMap { try? JSONDecoder().decode(NativeQuickShortcut.self, from: $0) }
        shortcut = saved?.valid == true ? saved! : Self.standard
        mode = preferences.string(forKey: Self.modePreferenceKey).flatMap(Mode.init(rawValue:)) ?? .hold
        autoSubmit = preferences.object(forKey: Self.autoSubmitPreferenceKey) as? Bool ?? false
    }
    /// This is a sending preference, not a physical shortcut transition. The
    /// coordinator captures it for a new command; changing it never sends one.
    func setAutoSubmit(_ value: Bool) {
        guard autoSubmit != value else { return }
        preferences.set(value, forKey: Self.autoSubmitPreferenceKey)
        autoSubmit = value
    }
    func setMode(_ value: Mode) {
        guard mode != value else { return }
        pressedRegistration = nil; registration?.resetPress()
        preferences.set(value.rawValue, forKey: Self.modePreferenceKey)
        mode = value
    }
    func setActive(_ value: Bool) {
        if !value {
            pressedRegistration = nil; registrationToken = nil; registration?.cancel(); registration = nil
            active = false; recording = false; issue = nil
            return
        }
        active = true
        guard registration == nil else { return }
        _ = apply(shortcut)
    }
    func setRecording(_ value: Bool) {
        if value { pressedRegistration = nil; registration?.resetPress() }
        recording = value
    }
    @discardableResult func apply(_ candidate: NativeQuickShortcut) -> Bool {
        guard candidate.valid else {
            issue = nativeUI("请使用带 ⌃、⌥ 或 ⌘ 的组合键，避开系统切换与常用编辑快捷键。", "Use a shortcut with ⌃, ⌥ or ⌘, avoiding system switching and standard editing shortcuts.")
            return false
        }
        if candidate == shortcut, registration != nil { issue = nil; return true }
        if active {
            let token = UUID()
            do {
                let replacement = try service.register(candidate, action: { [weak self] in
                    guard let self, self.active, self.registrationToken == token else { return }
                    if self.recording { self.recording = false; self.issue = nil; return }
                    guard self.pressedRegistration == nil else { return }
                    self.pressedRegistration = token
                    self.onInvoke?()
                }, release: { [weak self] in
                    guard let self, self.active, self.registrationToken == token,
                          self.pressedRegistration == token else { return }
                    self.pressedRegistration = nil
                    self.onRelease?()
                })
                pressedRegistration = nil
                registrationToken = token
                registration?.cancel(); registration = replacement
            } catch {
                issue = nativeUI("该组合键暂不可用。原语音快捷键保留，也可点击语音入口。", "That shortcut is unavailable. Your previous voice shortcut is retained; you can also use the voice button.")
                return false
            }
        }
        shortcut = candidate
        preferences.set(try? JSONEncoder().encode(candidate), forKey: Self.preferenceKey)
        issue = nil
        return true
    }
}
