import AppKit
import Carbon.HIToolbox

func nativeUI(_ zh: String, _ en: String) -> String { en }
@MainActor final class SpeechShortcutTicket: NativeSpeechShortcutRegistration {
    let id: Int
    let action: () -> Void
    let release: () -> Void
    let log: (String) -> Void
    init(_ id: Int, _ action: @escaping () -> Void, _ release: @escaping () -> Void, _ log: @escaping (String) -> Void) {
        self.id = id; self.action = action; self.release = release; self.log = log
    }
    func resetPress() { log("reset-\(id)") }
    func cancel() { log("cancel-\(id)") }
}
@MainActor final class SpeechShortcutDriver: NativeSpeechShortcutService {
    var tickets: [SpeechShortcutTicket] = []
    var events: [String] = []
    var fail = false
    func register(_ shortcut: NativeQuickShortcut, action: @escaping () -> Void, release: @escaping () -> Void) throws -> NativeSpeechShortcutRegistration {
        events.append("attempt")
        if fail { throw NSError(domain: "synthetic.shortcut.conflict", code: 1) }
        let ticket = SpeechShortcutTicket(tickets.count, action, release, { [weak self] in self?.events.append($0) })
        tickets.append(ticket); events.append("registered-\(ticket.id)")
        return ticket
    }
}

@main struct SpeechShortcutChecks {
    @MainActor static func main() throws {
        var count = 0
        func check(_ value: Bool, _ name: String) { precondition(value, name); count += 1; print("PASS \(name)") }
        var gate = NativeSpeechShortcutPressGate()
        check(gate.receive(pressed: true), "first physical press invokes")
        check(!gate.receive(pressed: true) && !gate.receive(pressed: true), "held-key repeats cannot finish a just-started recording")
        check(gate.receive(pressed: false) && !gate.held, "paired release is delivered once")
        check(!gate.receive(pressed: false), "unpaired release is ignored")
        check(gate.receive(pressed: true), "next physical press invokes once")
        gate.reset(); check(!gate.held && gate.receive(pressed: true), "unregister reset releases held state")
        gate.reset(suppressUntilRelease:true)
        check(!gate.held && !gate.receive(pressed:true),"mode reset cannot turn a held-key repeat into a fresh press")
        check(!gate.receive(pressed:false) && gate.receive(pressed:true),"reset consumes old key-up then allows next physical press")
        check(NativeSpeechCarbonShortcut.signature == 0x41494256 && NativeSpeechCarbonShortcut.signature != 0x41494252, "voice uses AIBV instead of quick-entry AIBR identity")

        let suite = "test.aibro.speech-shortcut." + UUID().uuidString
        let preferences = UserDefaults(suiteName: suite)!
        defer { preferences.removePersistentDomain(forName: suite) }
        let existing = try JSONEncoder().encode(NativeQuickShortcut.standard)
        preferences.set(existing, forKey: NativeQuickShortcutStore.preferenceKey)
        let driver = SpeechShortcutDriver(), store = NativeSpeechShortcutStore(preferences: preferences, service: driver)
        check(store.shortcut.label == "⌃⌥V" && !store.active && !store.registered, "voice default is separate and initially inactive")
        check(driver.events.isEmpty, "constructing preferences never registers an OS shortcut")
        check(NativeSpeechShortcutStore.preferenceKey != NativeQuickShortcutStore.preferenceKey, "voice preferences cannot replace island preference")
        let alternative = NativeQuickShortcut(keyCode: UInt32(kVK_ANSI_K), modifiers: UInt32(controlKey | optionKey | shiftKey))
        check(store.apply(alternative) && driver.tickets.isEmpty, "inactive choice persists without registering")
        check(NativeSpeechShortcutStore(preferences: preferences, service: driver).shortcut == alternative, "chosen shortcut survives Store recreation")
        check(preferences.data(forKey: NativeQuickShortcutStore.preferenceKey) == existing, "quick-entry preference remains byte-identical")
        check(!store.apply(.init(keyCode: UInt32(kVK_ANSI_Q), modifiers: UInt32(cmdKey))), "reserved edit and quit shortcuts keep validation")
        store.setActive(true)
        check(store.registered && driver.tickets.count == 1, "activation registers one callback")
        var invoked = 0; store.onInvoke = { invoked += 1 }
        driver.tickets[0].action(); check(invoked == 1, "current registration invokes owner")
        var released=0;store.onRelease={released+=1}
        driver.tickets[0].action();check(invoked==1 && store.isHeld,"repeat press cannot invoke twice")
        driver.tickets[0].release();driver.tickets[0].release();check(released==1 && !store.isHeld,"only one release pairs with current press")
        store.setRecording(true); driver.tickets[0].action()
        check(invoked == 1 && !store.recording, "capturing a shortcut does not also start voice recording")
        driver.tickets[0].release();check(released==1,"shortcut-capture release cannot finish a voice command")
        store.setActive(true); check(driver.tickets.count == 1, "repeated activation is idempotent")
        driver.fail = true
        check(!store.apply(NativeSpeechShortcutStore.standard), "conflicting new binding fails")
        check(store.shortcut == alternative && store.issue != nil && store.registered, "conflict retains working binding and displays failure")
        check(!driver.events.contains("cancel-0"), "conflict never unregisters old binding")
        check(NativeSpeechShortcutStore(preferences: preferences, service: driver).shortcut == alternative, "conflict cannot persist failed candidate")
        driver.tickets[0].action(); check(invoked == 2, "old shortcut still works after conflict")
        driver.fail = false
        check(store.apply(NativeSpeechShortcutStore.standard), "successful replacement installs default")
        check(driver.events.firstIndex(of: "registered-1")! < driver.events.firstIndex(of: "cancel-0")!, "replacement registration precedes old release")
        check(!store.isHeld,"changing binding clears held state without synthetic release")
        driver.tickets[0].release();check(released==1,"old binding release cannot finish replacement session")
        driver.tickets[0].action(); check(invoked == 2, "stale replaced callback cannot invoke")
        driver.tickets[1].action(); check(invoked == 3, "replacement callback invokes")
        check(store.apply(store.shortcut) && driver.tickets.count == 2, "same binding is not registered twice")
        store.setRecording(true); store.setActive(false)
        check(!store.active && !store.registered && !store.recording && store.issue == nil, "disable cancels registration and recorder state")
        driver.tickets[1].action(); check(invoked == 3, "late disabled callback cannot invoke")
        driver.fail = true; store.setActive(true)
        check(!store.registered && store.issue != nil && store.shortcut == NativeSpeechShortcutStore.standard, "startup conflict preserves saved shortcut for retry")
        driver.fail = false; check(store.apply(store.shortcut) && store.registered, "explicit retry recovers registration")
        driver.tickets[1].action(); check(invoked == 3, "callback from prior active session remains revoked")
        driver.tickets[2].action(); check(invoked == 4, "current active session is the only owner")
        check(store.mode == .hold,"unset interaction defaults to hold")
        let oldKey=preferences.data(forKey:NativeSpeechShortcutStore.preferenceKey)
        store.setMode(.toggle)
        check(store.mode == .toggle && !store.isHeld && driver.events.contains("reset-2"),"mode change clears physical and store held state")
        check(released==1,"mode change never fabricates release and submission")
        driver.tickets[2].release();check(released==1,"release of old mode is ignored")
        check(NativeSpeechShortcutStore(preferences:preferences,service:driver).mode == .toggle,"toggle mode persists independently")
        check(preferences.data(forKey:NativeSpeechShortcutStore.preferenceKey)==oldKey && preferences.data(forKey:NativeQuickShortcutStore.preferenceKey)==existing,"mode selection does not alter either shortcut binding")
        driver.tickets[2].action();driver.tickets[2].release();check(invoked==5 && released==2,"toggle mode still exposes paired physical events to coordinator")
        store.setMode(.hold);check(NativeSpeechShortcutStore(preferences:preferences,service:driver).mode == .hold,"explicit hold choice persists")
        driver.tickets[2].action();store.setActive(false);driver.tickets[2].release();check(!store.isHeld && released==2,"disable clears held state and rejects late release")
        store.setActive(false)
        preferences.set(Data("invalid".utf8), forKey: NativeSpeechShortcutStore.preferenceKey)
        check(NativeSpeechShortcutStore(preferences: preferences, service: driver).shortcut == NativeSpeechShortcutStore.standard, "corrupt preference uses voice default")
        preferences.set(try JSONEncoder().encode(NativeQuickShortcut(keyCode: 0, modifiers: 0)), forKey: NativeSpeechShortcutStore.preferenceKey)
        check(NativeSpeechShortcutStore(preferences: preferences, service: driver).shortcut == NativeSpeechShortcutStore.standard, "invalid saved bare key cannot capture normal typing")
        preferences.set("unknown",forKey:NativeSpeechShortcutStore.modePreferenceKey)
        check(NativeSpeechShortcutStore(preferences:preferences,service:driver).mode == .hold,"unknown saved mode safely defaults to hold")
        print("PASS: \(count) speech shortcut checks; injected registration only, no global key installation")
    }
}
