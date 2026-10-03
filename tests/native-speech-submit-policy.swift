import AppKit
import Combine

func nativeUI(_ zh: String, _ en: String) -> String { en }

@MainActor final class SubmitPolicyTicket: NativeSpeechShortcutRegistration {
    let down: () -> Void
    let up: () -> Void
    var resets = 0
    init(down: @escaping () -> Void, up: @escaping () -> Void) { self.down = down; self.up = up }
    func resetPress() { resets += 1 }
    func cancel() {}
}
@MainActor final class SubmitPolicyDriver: NativeSpeechShortcutService {
    var tickets: [SubmitPolicyTicket] = []
    func register(_ shortcut: NativeQuickShortcut, action: @escaping () -> Void, release: @escaping () -> Void) throws -> NativeSpeechShortcutRegistration {
        let value = SubmitPolicyTicket(down: action, up: release); tickets.append(value); return value
    }
}

@main struct SubmitPolicyChecks {
    @MainActor static func main() {
        let suite = "test.aibro.speech-send-policy." + UUID().uuidString
        let preferences = UserDefaults(suiteName: suite)!
        defer { preferences.removePersistentDomain(forName: suite) }
        let driver = SubmitPolicyDriver(), store = NativeSpeechShortcutStore(preferences: preferences, service: driver)
        var count = 0
        func check(_ ok: Bool, _ name: String) { precondition(ok, name); count += 1; print("PASS \(name)") }
        check(!store.autoSubmit && driver.tickets.isEmpty, "unset preference requires confirmation without registering shortcut")
        let modeBefore = store.mode, shortcutBefore = store.shortcut
        var changes: [Bool] = []
        let subscription = store.$autoSubmit.dropFirst().sink { changes.append($0) }
        store.setAutoSubmit(true)
        check(store.autoSubmit && changes == [true], "explicit opt-in publishes sending preference")
        check(NativeSpeechShortcutStore(preferences: preferences, service: driver).autoSubmit, "explicit opt-in survives store recreation")
        store.setAutoSubmit(true)
        check(changes == [true] && driver.tickets.isEmpty, "same choice neither republishes nor registers")
        store.setActive(true)
        var downs = 0, ups = 0
        store.onInvoke = { downs += 1 }; store.onRelease = { ups += 1 }
        let ticket = driver.tickets[0]
        ticket.down()
        check(store.isHeld && downs == 1, "fixture owns an actual paired store press")
        store.setAutoSubmit(false)
        check(store.isHeld && ticket.resets == 0 && downs == 1 && ups == 0 && driver.tickets.count == 1,
              "changing send preference cannot submit or invalidate the physical press")
        ticket.down(); ticket.up(); ticket.up()
        check(downs == 1 && ups == 1 && !store.isHeld, "original physical release is still delivered exactly once")
        check(!NativeSpeechShortcutStore(preferences: preferences, service: driver).autoSubmit && changes == [true, false],
              "return to confirmation persists and publishes")
        check(store.mode == modeBefore && store.shortcut == shortcutBefore,
              "sending preference is independent of hold mode and binding")
        store.setMode(.toggle)
        check(!store.autoSubmit, "toggle mode does not enable automatic sending")
        store.setActive(false)
        check(preferences.object(forKey: NativeSpeechShortcutStore.modePreferenceKey) as? String == "toggle"
              && preferences.object(forKey: NativeSpeechShortcutStore.autoSubmitPreferenceKey) as? Bool == false,
              "mode and sending preference use independent persisted keys")
        preferences.set("invalid", forKey: NativeSpeechShortcutStore.autoSubmitPreferenceKey)
        check(!NativeSpeechShortcutStore(preferences: preferences, service: driver).autoSubmit, "invalid saved value falls back to confirmation")
        subscription.cancel()
        print("PASS: \(count) speech submit-policy checks; no OS registration, microphone or provider")
    }
}
