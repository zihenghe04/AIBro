import AppKit

// Fake system: no events are posted and the real pasteboard is never touched.
@MainActor final class FakeInjectEnvironment: NativeDictationInjectEnvironment {
    var trusted = true, secureInput = false
    var front: NativeDictationInjectTarget?
    var fieldValue: NativeDictationInjectField? = .init(secure: false, value: "")
    var typeAccepted = true, typeLands = true
    var typed: [[String]] = [], pastes = 0, copies: [String] = [], restores = 0
    var clip = "user clip", changeCount = 1
    var afterSleep: (() -> Void)?
    func frontmost() -> NativeDictationInjectTarget? { front }
    func field(_ pid: pid_t) async -> NativeDictationInjectField? { fieldValue }
    func type(_ chunks: [String], pid: pid_t) async -> Bool {
        typed.append(chunks)
        if typeAccepted && typeLands, let old = fieldValue?.value { fieldValue?.value = old + chunks.joined() }
        return typeAccepted
    }
    func paste(pid: pid_t) -> Bool { pastes += 1; return true }
    func backupPasteboard() -> [NSPasteboardItem] { let item = NSPasteboardItem(); item.setString(clip, forType: .string); return [item] }
    func writeTransient(_ text: String) -> Int { clip = text; changeCount += 1; return changeCount }
    func copy(_ text: String) { copies.append(text); clip = text; changeCount += 1 }
    func restorePasteboard(_ items: [NSPasteboardItem]) { restores += 1; clip = items.first?.string(forType: .string) ?? ""; changeCount += 1 }
    func sleep(_ seconds: Double) async { await Task.yield(); afterSleep?(); afterSleep = nil }
}

@main struct DictationInjectorChecks {
    @MainActor static func main() async {
        var count = 0
        func check(_ ok: Bool, _ name: String) { precondition(ok, name); count += 1; print("PASS \(name)") }
        let target = NativeDictationInjectTarget(pid: 42, bundleID: "com.example.editor", launchedAt: Date(timeIntervalSince1970: 1), name: "Editor")
        func make() -> (FakeInjectEnvironment, NativeDictationInjector) {
            let env = FakeInjectEnvironment(); env.front = target; return (env, NativeDictationInjector(environment: env))
        }

        // Chunking keeps grapheme clusters whole and stays within 20 UTF-16 units.
        let family = "👨‍👩‍👧‍👦", text = String(repeating: "中", count: 19) + family + "🇨🇳ok"
        let chunks = NativeDictationInjector.chunks(text)
        check(chunks.joined() == text, "chunks round-trip")
        check(chunks.allSatisfy { $0.utf16.count <= 20 || $0.count == 1 }, "chunk size bound")
        check(chunks.contains(family) || chunks.contains { $0.contains(family) }, "ZWJ family not split")
        check(NativeDictationInjector.prefersTyping("短句，测试。"), "short single line types")
        check(!NativeDictationInjector.prefersTyping("第一行\n第二行"), "newline pastes")
        check(!NativeDictationInjector.prefersTyping("a\tb"), "tab pastes")
        check(!NativeDictationInjector.prefersTyping(String(repeating: "长", count: 301)), "long text pastes")

        do { // B path, verified by read-back
            let (env, injector) = make()
            let outcome = await injector.inject("  你好，世界 🙂\n", into: target)
            check(outcome == .typed && env.pastes == 0 && env.copies.isEmpty && env.clip == "user clip", "short text typed without clipboard")
            check(env.fieldValue?.value == "你好，世界 🙂", "trimmed text typed")
        }
        do { // multi-line goes through transient paste and restores
            let (env, injector) = make()
            let outcome = await injector.inject("第一行\n第二行", into: target)
            check(outcome == .pasted && env.typed.isEmpty && env.pastes == 1 && env.clip == "第一行\n第二行", "multi-line pasted")
            for _ in 0..<5 { await Task.yield() }
            check(env.restores == 1 && env.clip == "user clip", "clipboard restored after delay")
        }
        do { // someone else wrote the clipboard during the delay: keep theirs
            let (env, injector) = make()
            env.afterSleep = { env.clip = "newer"; env.changeCount += 1 }
            _ = await injector.inject(String(repeating: "长", count: 400), into: target)
            for _ in 0..<5 { await Task.yield() }
            check(env.restores == 0 && env.clip == "newer", "foreign clipboard change wins")
        }
        do { // typing ignored by the view: fall back to paste once
            let (env, injector) = make()
            env.typeLands = false
            let outcome = await injector.inject("hello", into: target)
            check(outcome == .pasted && env.typed.count == 1 && env.pastes == 1, "unchanged field falls back to paste")
        }
        do { // partial arrival must not paste a duplicate
            let (env, injector) = make()
            env.typeLands = false
            env.afterSleep = { env.fieldValue?.value = "hel" }
            let outcome = await injector.inject("hello", into: target)
            check(outcome == .copied(.unverified) && env.pastes == 0 && env.copies == ["hello"], "partial typing copies instead of duplicating")
        }
        do { // no AX value: cannot verify, trust typing
            let (env, injector) = make()
            env.fieldValue = nil
            check(await injector.inject("hello", into: target) == .typed && env.pastes == 0, "unreadable field trusts typing")
        }
        do { // secure input refuses and copies
            let (env, injector) = make()
            env.secureInput = true
            check(await injector.inject("secret words", into: target) == .copied(.secure) && env.typed.isEmpty && env.pastes == 0 && env.copies == ["secret words"], "secure input refused")
        }
        do { // password field subrole refuses and copies
            let (env, injector) = make()
            env.fieldValue = .init(secure: true, value: nil)
            check(await injector.inject("secret", into: target) == .copied(.secure) && env.typed.isEmpty && env.pastes == 0, "password field refused")
        }
        do { // focus moved to another app: never type into it
            let (env, injector) = make()
            env.front = .init(pid: 43, bundleID: "com.example.chat", launchedAt: nil, name: "Chat")
            check(await injector.inject("hello", into: target) == .copied(.targetChanged) && env.typed.isEmpty && env.pastes == 0, "target change refused")
            env.front = .init(pid: 42, bundleID: "com.example.editor", launchedAt: Date(timeIntervalSince1970: 2), name: "Editor")
            check(await injector.inject("hello", into: target) == .copied(.targetChanged), "relaunched pid refused")
        }
        do { // no accessibility trust
            let (env, injector) = make()
            env.trusted = false
            check(await injector.inject("hello", into: target) == .copied(.permission) && env.typed.isEmpty, "untrusted copies")
        }
        do { // empty transcript
            let (env, injector) = make()
            check(await injector.inject(" \n ", into: target) == .empty && env.copies.isEmpty, "empty ignored")
        }
        do { // a second paste restores the first backup before taking a new one
            let (env, injector) = make()
            env.afterSleep = {}
            _ = await injector.inject("a\nb", into: target)
            injector.restorePending()
            check(env.clip == "user clip" && env.restores == 1, "restorePending restores now")
        }
        check(NativeDictationInjectSystemEnvironment.keyCode(for: "v") != nil, "layout lookup finds V")
        print("dictation injector checks: \(count); no events posted")
    }
}
