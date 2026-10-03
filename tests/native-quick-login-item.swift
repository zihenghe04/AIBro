import Foundation

func nativeUI(_ zh: String, _ en: String) -> String { en }

@MainActor final class TestLoginService: NativeQuickLoginItemService {
    var status: NativeQuickLoginItemStatus = .notRegistered
    var registerCalls = 0
    var unregisterCalls = 0
    var settingsCalls = 0
    var registrationResult: NativeQuickLoginItemStatus = .enabled
    var failure = false
    var suspendUnregister = false
    var continuation: CheckedContinuation<Void, Never>?
    func register() throws {
        registerCalls += 1
        if failure { throw NSError(domain: "fixture", code: 1) }
        status = registrationResult
    }
    func unregister() async throws {
        unregisterCalls += 1
        if suspendUnregister { await withCheckedContinuation { continuation = $0 } }
        if failure { throw NSError(domain: "fixture", code: 1) }
        status = .notRegistered
    }
    func openSettings() { settingsCalls += 1 }
}

@main struct Test {
    @MainActor static func main() async {
        let service = TestLoginService()
        let store = NativeQuickLoginItemStore(service: service)
        assert(store.status == .notRegistered && service.registerCalls == 0)
        store.refresh()
        assert(service.registerCalls == 0, "read-only startup must not register")
        await store.setEnabled(true)
        assert(store.status == .enabled && store.issue == nil && service.registerCalls == 1)
        await store.setEnabled(true)
        assert(service.registerCalls == 1, "no duplicate OS registration")
        service.status = .requiresApproval
        store.refresh()
        assert(store.status == .requiresApproval && store.status.isRegistered)
        store.openSettings()
        assert(service.settingsCalls == 1 && service.registerCalls == 1)
        await store.setEnabled(false)
        assert(store.status == .notRegistered && service.unregisterCalls == 1)
        service.registrationResult = .requiresApproval
        await store.setEnabled(true)
        assert(store.status == .requiresApproval && store.issue == nil)
        service.suspendUnregister = true
        let pending = Task { await store.setEnabled(false) }
        while service.continuation == nil { await Task.yield() }
        assert(store.changing)
        await store.setEnabled(true)
        assert(service.registerCalls == 2, "pending operation must not race a second toggle")
        service.continuation?.resume()
        await pending.value
        assert(!store.changing && store.status == .notRegistered)
        service.failure = true
        await store.setEnabled(true)
        assert(store.status == .notRegistered && store.issue != nil)
        service.status = .enabled
        let callsBeforeExternalRecovery = service.registerCalls
        store.refresh()
        assert(store.status == .enabled && store.issue == nil && service.registerCalls == callsBeforeExternalRecovery)
        service.status = .notRegistered
        service.failure = false
        service.registrationResult = .notRegistered
        await store.setEnabled(true)
        assert(store.status == .notRegistered && store.issue != nil, "successful call is not proof of OS registration")
        service.status = .notFound
        let calls = service.registerCalls
        store.refresh()
        assert(store.status == .notFound && service.registerCalls == calls, "notFound refresh must not register implicitly")
        await store.setEnabled(false)
        assert(service.registerCalls == calls && service.unregisterCalls == 2, "turning an absent item off is a no-op")
        service.registrationResult = .enabled
        await store.setEnabled(true)
        assert(store.status == .enabled && store.issue == nil && service.registerCalls == calls + 1,
               "explicit enabling may recover a notFound lookup")
        service.status = .notFound
        service.registrationResult = .requiresApproval
        await store.setEnabled(true)
        assert(store.status == .requiresApproval && store.issue == nil && service.registerCalls == calls + 2,
               "notFound registration may require OS approval")
        service.status = .notFound
        service.failure = true
        await store.setEnabled(true)
        assert(store.status == .notFound && store.issue != nil && service.registerCalls == calls + 3,
               "an actual registration error must remain visible without automatic retry")
        store.refresh()
        assert(store.issue != nil && service.registerCalls == calls + 3)
        service.failure = false
        service.registrationResult = .notFound
        await store.setEnabled(true)
        assert(store.status == .notFound && store.issue != nil && service.registerCalls == calls + 4,
               "no-error registration cannot invent an enabled OS state")
        service.status = .unknown
        await store.setEnabled(true)
        assert(store.status == .unknown && service.registerCalls == calls + 4)
        let absent = TestLoginService()
        absent.status = .notFound
        let absentStore = NativeQuickLoginItemStore(service: absent)
        absentStore.refresh()
        assert(absent.registerCalls == 0 && absentStore.status == .notFound,
               "starting with notFound is read-only")
        print("PASS: login startup read-only, OS state, approval, disable, serialized changes, errors, explicit notFound recovery and unsupported status")
    }
}
