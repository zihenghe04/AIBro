import AppKit
import Combine
import Carbon.HIToolbox

struct NativeQuickShortcut: Codable, Equatable {
    let keyCode: UInt32
    let modifiers: UInt32
    static let standard = NativeQuickShortcut(keyCode: UInt32(kVK_Space), modifiers: UInt32(controlKey | optionKey))
    static let modifierMask = UInt32(cmdKey | controlKey | optionKey | shiftKey)
    static let names: [UInt32: String] = [0:"A",1:"S",2:"D",3:"F",4:"H",5:"G",6:"Z",7:"X",8:"C",9:"V",11:"B",12:"Q",13:"W",14:"E",15:"R",16:"Y",17:"T",18:"1",19:"2",20:"3",21:"4",22:"6",23:"5",24:"=",25:"9",26:"7",27:"−",28:"8",29:"0",30:"]",31:"O",32:"U",33:"[",34:"I",35:"P",36:"↩",37:"L",38:"J",39:"′",40:"K",41:";",42:"\\",43:",",44:"/",45:"N",46:"M",47:".",48:"⇥",49:"Space",50:"`",51:"⌫",53:"⎋",65:".",67:"*",69:"+",75:"/",76:"⌤",78:"−",81:"=",82:"0",83:"1",84:"2",85:"3",86:"4",87:"5",88:"6",89:"7",91:"8",92:"9",96:"F5",97:"F6",98:"F7",99:"F3",100:"F8",101:"F9",103:"F11",105:"F13",106:"F16",107:"F14",109:"F10",111:"F12",113:"F15",114:"Help",115:"↖",116:"⇞",117:"⌦",118:"F4",119:"↘",120:"F2",121:"⇟",122:"F1",123:"←",124:"→",125:"↓",126:"↑"]
    var label: String {
        [(UInt32(controlKey),"⌃"),(UInt32(optionKey),"⌥"),(UInt32(shiftKey),"⇧"),(UInt32(cmdKey),"⌘")]
            .filter { modifiers & $0.0 != 0 }.map(\.1).joined() + (Self.names[keyCode] ?? "?")
    }
    var valid: Bool {
        guard Self.names[keyCode] != nil, modifiers & ~Self.modifierMask == 0,
              modifiers & UInt32(cmdKey | controlKey | optionKey) != 0 else { return false }
        // Do not take the standard global switcher or ordinary edit/quit keys.
        if modifiers == UInt32(cmdKey), [0,6,7,8,9,4,12,13,46,48,49].contains(keyCode) { return false }
        return true
    }
    init(keyCode: UInt32, modifiers: UInt32) { self.keyCode = keyCode; self.modifiers = modifiers }
    init(event: NSEvent) {
        keyCode = UInt32(event.keyCode)
        let flags = event.modifierFlags
        modifiers = (flags.contains(.command) ? UInt32(cmdKey) : 0)
            | (flags.contains(.control) ? UInt32(controlKey) : 0)
            | (flags.contains(.option) ? UInt32(optionKey) : 0)
            | (flags.contains(.shift) ? UInt32(shiftKey) : 0)
    }
}

@MainActor protocol NativeQuickShortcutRegistration: AnyObject { func cancel() }
@MainActor protocol NativeQuickShortcutService {
    func register(_ shortcut: NativeQuickShortcut, action: @escaping () -> Void) throws -> NativeQuickShortcutRegistration
}

@MainActor final class NativeQuickCarbonShortcut: NativeQuickShortcutService {
    private var nextID: UInt32 = 1
    func register(_ shortcut: NativeQuickShortcut, action: @escaping () -> Void) throws -> NativeQuickShortcutRegistration {
        let id = nextID; nextID &+= 1
        return try Registration(shortcut, id: id, action: action)
    }
    private final class Registration: NativeQuickShortcutRegistration {
        private var hotkey: EventHotKeyRef?
        private var handler: EventHandlerRef?
        private let id: UInt32
        private let action: () -> Void
        init(_ shortcut: NativeQuickShortcut, id: UInt32, action: @escaping () -> Void) throws {
            self.id = id; self.action = action
            var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            let installed = InstallEventHandler(GetApplicationEventTarget(), { _, event, context in
                guard let event, let context else { return OSStatus(eventNotHandledErr) }
                var identifier = EventHotKeyID()
                guard GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &identifier) == noErr,
                      identifier.signature == 0x41494252 else { return OSStatus(eventNotHandledErr) }
                let registration = Unmanaged<Registration>.fromOpaque(context).takeUnretainedValue()
                return MainActor.assumeIsolated {
                    guard registration.id == identifier.id, registration.hotkey != nil else { return OSStatus(eventNotHandledErr) }
                    registration.action(); return noErr
                }
            }, 1, &spec, Unmanaged.passUnretained(self).toOpaque(), &handler)
            guard installed == noErr else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(installed)) }
            let result = RegisterEventHotKey(shortcut.keyCode, shortcut.modifiers, .init(signature: 0x41494252, id: id), GetApplicationEventTarget(), 0, &hotkey)
            if result != noErr { cancel(); throw NSError(domain: NSOSStatusErrorDomain, code: Int(result)) }
        }
        func cancel() {
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

/// Register the replacement before releasing the old shortcut. Conflicts cannot
/// silently erase a working user binding or persist an unusable replacement.
@MainActor final class NativeQuickShortcutStore: ObservableObject {
    static let preferenceKey = "ai-bro-native-quick-shortcut-v1"
    @Published private(set) var shortcut: NativeQuickShortcut
    @Published private(set) var issue: String?
    @Published private(set) var active = false
    @Published private(set) var recording = false
    private let preferences: UserDefaults
    private let service: NativeQuickShortcutService
    private var registration: NativeQuickShortcutRegistration?
    var onInvoke: (() -> Void)?
    init(preferences: UserDefaults = .standard, service: NativeQuickShortcutService? = nil) {
        self.preferences = preferences; self.service = service ?? NativeQuickCarbonShortcut()
        let saved = preferences.data(forKey: Self.preferenceKey).flatMap { try? JSONDecoder().decode(NativeQuickShortcut.self, from: $0) }
        shortcut = saved?.valid == true ? saved! : .standard
    }
    func setActive(_ value: Bool) {
        if !value { registration?.cancel(); registration = nil; active = false; recording = false; issue = nil; return }
        active = true
        guard registration == nil else { return }
        _ = apply(shortcut)
    }
    func setRecording(_ value: Bool) { recording = value }
    @discardableResult func apply(_ candidate: NativeQuickShortcut) -> Bool {
        guard candidate.valid else {
            issue = nativeUI("请使用带 ⌃、⌥ 或 ⌘ 的组合键，避开系统切换与常用编辑快捷键。", "Use a shortcut with ⌃, ⌥ or ⌘, avoiding system switching and standard editing shortcuts.")
            return false
        }
        if candidate == shortcut, registration != nil { issue = nil; return true }
        if active {
            do {
                let replacement = try service.register(candidate) { [weak self] in
                    guard let self, self.active else { return }
                    if self.recording { self.recording = false; self.issue = nil; return }
                    self.onInvoke?()
                }
                registration?.cancel(); registration = replacement
            } catch {
                issue = nativeUI("该组合键暂不可用。原快捷键保留，也可点击入口打开。", "That shortcut is unavailable. Your previous shortcut is retained; you can also click the entry.")
                return false
            }
        }
        shortcut = candidate
        preferences.set(try? JSONEncoder().encode(candidate), forKey: Self.preferenceKey)
        issue = nil
        return true
    }
}
