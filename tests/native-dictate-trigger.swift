import AppKit
import Carbon.HIToolbox

func nativeUI(_ zh:String,_ en:String)->String { en }

@MainActor final class FakeToken: NativeQuickShortcutRegistration, NativeSpeechShortcutRegistration {
    var cancelled=false
    func cancel(){cancelled=true}
    func resetPress(){}
}
@MainActor final class FakeMonitor: NativeDictateMonitorService {
    var handler:(@MainActor (NativeDictateModifierTracker.Input)->Void)?
    var tokens:[FakeToken]=[]
    func observe(_ handler:@escaping @MainActor (NativeDictateModifierTracker.Input)->Void)->NativeQuickShortcutRegistration? {
        self.handler=handler;let t=FakeToken();tokens.append(t);return t
    }
    var live:Bool {tokens.last.map{!$0.cancelled} ?? false}
}
@MainActor final class FakeCarbon: NativeSpeechShortcutService {
    var registered:[NativeQuickShortcut]=[],fail=false
    var press:(()->Void)?,release:(()->Void)?
    func register(_ shortcut:NativeQuickShortcut,action:@escaping ()->Void,release:@escaping ()->Void) throws->NativeSpeechShortcutRegistration {
        if fail{throw NSError(domain:"fake",code:1)}
        registered.append(shortcut);press=action;self.release=release;return FakeToken()
    }
}

@main struct DictateTriggerChecks {
    @MainActor static func main() {
        var count=0
        func check(_ ok:Bool,_ name:String){precondition(ok,name);count+=1;print("PASS \(name)")}
        let ropt=UInt16(kVK_RightOption),lopt=UInt16(kVK_Option),rcmd=UInt16(kVK_RightCommand),shift=UInt16(kVK_Shift)
        let opt=NSEvent.ModifierFlags.option.rawValue,cmd=NSEvent.ModifierFlags.command.rawValue,sh=NSEvent.ModifierFlags.shift.rawValue

        var t=NativeDictateModifierTracker(kind:.rightOption)
        check(t.receive(.flags(keyCode:ropt,raw:opt|0x40)) == .press,"right option down presses")
        check(t.receive(.flags(keyCode:ropt,raw:0)) == .release,"right option up releases")
        check(t.receive(.flags(keyCode:lopt,raw:opt|0x20)) == nil && t.receive(.flags(keyCode:lopt,raw:0)) == nil,"left option is ignored")
        _=t.receive(.flags(keyCode:ropt,raw:opt|0x40))
        check(t.receive(.key) == .abort && t.receive(.key) == nil,"typing while held aborts once")
        check(t.receive(.flags(keyCode:ropt,raw:0)) == nil,"release after abort is silent")
        _=t.receive(.flags(keyCode:ropt,raw:opt|0x40))
        check(t.receive(.flags(keyCode:shift,raw:opt|0x40|sh|0x2)) == .abort,"another modifier joining aborts")
        _=t.receive(.flags(keyCode:shift,raw:opt|0x40));_=t.receive(.flags(keyCode:ropt,raw:0))
        _=t.receive(.flags(keyCode:ropt,raw:opt|0x40))
        check(t.receive(.pointer) == .abort,"option-click aborts")
        _=t.receive(.flags(keyCode:ropt,raw:0))
        check(t.receive(.flags(keyCode:ropt,raw:opt|0x40|sh|0x2)) == nil && t.receive(.flags(keyCode:ropt,raw:sh|0x2)) == nil,"right option pressed while shift held never triggers")
        check(t.receive(.flags(keyCode:ropt,raw:opt|0x40|0x20)) == nil,"both options together never trigger")
        _=t.receive(.flags(keyCode:ropt,raw:opt|0x20))
        check(t.receive(.flags(keyCode:lopt,raw:0)) == nil,"left option release after chord stays silent")
        check(t.receive(.flags(keyCode:ropt,raw:opt|0x40)) == .press,"tracker recovers after chord")
        _=t.receive(.flags(keyCode:ropt,raw:0))
        check(t.receive(.flags(keyCode:ropt,raw:0)) == nil,"unpaired release is ignored")
        check(t.receive(.flags(keyCode:ropt,raw:0x90140)) == .press,"right option presses while caps lock is on")
        check(t.receive(.flags(keyCode:ropt,raw:0x10100)) == .release,"right option releases while caps lock is on")

        var c=NativeDictateModifierTracker(kind:.rightCommand)
        check(c.receive(.flags(keyCode:rcmd,raw:cmd|0x10)) == .press && c.receive(.flags(keyCode:rcmd,raw:0)) == .release,"right command trigger works")
        check(c.receive(.flags(keyCode:ropt,raw:opt|0x40)) == nil,"right option ignored when right command chosen")
        var combo=NativeDictateModifierTracker(kind:.combo)
        check(combo.receive(.flags(keyCode:ropt,raw:opt|0x40)) == nil,"combo kind ignores modifier events")

        let suite="aibro-dictate-trigger-checks-\(UUID().uuidString)",prefs=UserDefaults(suiteName:suite)!
        defer{prefs.removePersistentDomain(forName:suite)}
        let m=FakeMonitor(),k=FakeCarbon()
        var granted=false,notices=0
        var s=NativeDictateTriggerStore(preferences:prefs,monitor:m,carbon:k,trusted:{granted})
        s.onNeedsAccess={notices+=1}
        check(s.enabled && s.kind == .rightOption && s.label=="Right ⌥","defaults: on, right option")
        s.setEnabled(false)
        s.setActive(true)
        check(m.tokens.isEmpty && !s.needsAccess && notices==0,"disabled store installs no monitor and asks for nothing")
        var events:[String]=[]
        s.onPress={events.append("p")};s.onRelease={events.append("r")};s.onAbort={events.append("a")}
        s.setEnabled(true)
        check(s.needsAccess && notices==1,"enabled without Accessibility reports it once")
        s.recheckAccess()
        check(notices==1,"rechecking while still missing does not repeat the notice")
        let installs=m.tokens.count
        granted=true;s.recheckAccess()
        check(!s.needsAccess && m.tokens.count == installs+1 && m.live,"granting access clears the notice and reinstalls the monitor")
        check(m.live && prefs.bool(forKey:NativeDictateTriggerStore.enabledPreferenceKey),"enabling installs the monitor and saves")
        m.handler?(.flags(keyCode:ropt,raw:opt|0x40));m.handler?(.key);m.handler?(.flags(keyCode:ropt,raw:0))
        m.handler?(.flags(keyCode:ropt,raw:opt|0x40));m.handler?(.flags(keyCode:ropt,raw:0))
        check(events==["p","a","p","r"],"store forwards press, abort and release")
        s.setRecording(true)
        check(!m.live,"recording a shortcut suspends the trigger")
        s.setRecording(false)
        check(m.live,"trigger resumes after shortcut capture")

        s.reserved={[NativeSpeechShortcutStore.standard,NativeQuickShortcut.standard]}
        check(!s.apply(NativeSpeechShortcutStore.standard) && s.issue != nil && s.combo == NativeDictateTriggerStore.standardCombo,"voice shortcut ⌃⌥V is refused")
        check(!s.apply(NativeQuickShortcut(keyCode:UInt32(kVK_ANSI_C),modifiers:UInt32(cmdKey))),"standard edit shortcut is refused")
        s.setKind(.combo)
        check(s.kind == .combo && !m.live && k.registered.last == NativeDictateTriggerStore.standardCombo,"combo kind registers carbon hotkey and stops monitor")
        events=[];k.press?();k.release?()
        check(events==["p","r"],"carbon combo forwards press and release")
        let custom=NativeQuickShortcut(keyCode:UInt32(kVK_ANSI_J),modifiers:UInt32(controlKey|cmdKey))
        check(s.apply(custom) && k.registered.last == custom && s.label == custom.label,"custom combo applies")
        k.fail=true
        check(!s.apply(NativeQuickShortcut(keyCode:UInt32(kVK_ANSI_K),modifiers:UInt32(controlKey|cmdKey))) && s.combo == custom,"failed registration keeps previous combo")
        k.fail=false
        s=NativeDictateTriggerStore(preferences:prefs,monitor:m,carbon:k,trusted:{granted})
        check(s.enabled && s.kind == .combo && s.combo == custom,"preferences persist across launches")
        s.setActive(true);s.setKind(.rightCommand);s.setActive(false)
        check(!m.live && !s.registered,"deactivating removes the trigger")

        // Raw tap events map to the same tracker input as NSEvent did.
        check(NativeDictateEventInput.input(type:.flagsChanged,keyCode:ropt,flags:0x80140) == .flags(keyCode:ropt,raw:0x80140),"tap flagsChanged keeps key and device bits")
        check(NativeDictateEventInput.input(type:.keyDown,keyCode:9,flags:0) == .key,"tap keyDown is a key")
        check([CGEventType.leftMouseDown,.rightMouseDown,.otherMouseDown,.scrollWheel].allSatisfy{NativeDictateEventInput.input(type:$0,keyCode:0,flags:0) == .pointer},"tap pointer events abort input")
        check(NativeDictateEventInput.input(type:.keyUp,keyCode:9,flags:0) == nil && NativeDictateEventInput.input(type:.tapDisabledByTimeout,keyCode:0,flags:0) == nil,"tap ignores keyUp and tap state events")
        let mask=NativeDictateEventInput.mask
        check(mask & (1<<CGEventType.flagsChanged.rawValue) != 0 && mask & (1<<CGEventType.keyDown.rawValue) != 0 && mask & (1<<CGEventType.keyUp.rawValue) == 0,"tap mask covers flagsChanged and keyDown only for keys")
        var tap=NativeDictateModifierTracker(kind:.rightOption)
        check(tap.receive(NativeDictateEventInput.input(type:.flagsChanged,keyCode:ropt,flags:0x80140)!) == .press
              && tap.receive(NativeDictateEventInput.input(type:.flagsChanged,keyCode:ropt,flags:0x100)!) == .release,"posted right option down/up flags press and release")

        // Settings page binding: a trigger change must reinstall the live trigger, not just write the preference.
        let suite2="aibro-settings-binding-\(UUID().uuidString)",bp=UserDefaults(suiteName:suite2)!
        defer{bp.removePersistentDomain(forName:suite2)}
        let bm=FakeMonitor(),bk=FakeCarbon(),bd=NativeDictateTriggerStore(preferences:bp,monitor:bm,carbon:bk,trusted:{true})
        let bs=NativeSpeechShortcutStore(preferences:bp,service:FakeCarbon())
        bd.setActive(true)
        let bInstalls=bm.tokens.count
        check(bm.live && bd.kind == .rightOption,"binding: starts on right option with a live monitor")
        check(NativeSettingsVoiceBinding.set("dictate.trigger",.string("combo"),dictate:bd,speech:bs,preferences:bp),"binding: trigger id is handled")
        check(bd.kind == .combo && !bm.live && bk.registered.last == bd.combo,"binding: switching to combo reinstalls live (monitor off, hotkey registered)")
        check(bp.string(forKey:NativeDictateTriggerStore.kindPreferenceKey) == "combo","binding: trigger preference saved")
        _ = NativeSettingsVoiceBinding.set("dictate.trigger",.string("rightCommand"),dictate:bd,speech:bs,preferences:bp)
        check(bd.kind == .rightCommand && bm.live && bm.tokens.count > bInstalls,"binding: switching back reinstalls the modifier monitor")
        check(NativeSettingsVoiceBinding.values(dictate:bd,speech:bs,preferences:bp)["dictate.trigger"] as? String == "rightCommand","binding: reply value is the effective trigger")
        _ = NativeSettingsVoiceBinding.set("dictate.trigger",.string("rightOption"),dictate:bd,speech:bs,preferences:bp)
        check(bd.kind == .rightOption && bm.live,"binding: right option restored live (caps lock press/release covered by the tracker checks above)")
        _ = NativeSettingsVoiceBinding.set("dictate.combo",.string("\(controlKey|cmdKey):\(kVK_ANSI_K)"),dictate:bd,speech:bs,preferences:bp)
        check(NativeSettingsVoiceBinding.values(dictate:bd,speech:bs,preferences:bp)["dictate.combo"] as? String == "\(controlKey|cmdKey):\(kVK_ANSI_K)","binding: combo applies and is reported")
        _ = NativeSettingsVoiceBinding.set("dictate.combo",.string("\(cmdKey):\(kVK_ANSI_C)"),dictate:bd,speech:bs,preferences:bp)
        check(bd.issue != nil && NativeSettingsVoiceBinding.values(dictate:bd,speech:bs,preferences:bp)["dictate.combo"] as? String == "\(controlKey|cmdKey):\(kVK_ANSI_K)","binding: refused combo keeps the effective value and reports an issue")
        _ = NativeSettingsVoiceBinding.set("speech.mode",.string("toggle"),dictate:bd,speech:bs,preferences:bp)
        _ = NativeSettingsVoiceBinding.set("speech.autoSubmit",.bool(true),dictate:bd,speech:bs,preferences:bp)
        check(bs.mode == .toggle && bs.autoSubmit && bp.bool(forKey:NativeSpeechShortcutStore.autoSubmitPreferenceKey),"binding: speech mode and auto submit")
        check(NativeSettingsVoiceBinding.set("speech.silence",.number(2.46),dictate:bd,speech:bs,preferences:bp) && NativeSettingsVoiceBinding.silence(bp) == 2.5,"binding: silence rounds to 0.1")
        _ = NativeSettingsVoiceBinding.set("speech.silence",.number(0),dictate:bd,speech:bs,preferences:bp)
        check(NativeSettingsVoiceBinding.silence(bp) == 0,"binding: silence 0 means off")
        check(!NativeSettingsVoiceBinding.set("login.enabled",.bool(true),dictate:bd,speech:bs,preferences:bp),"binding: other ids are not handled")

        print("dictate trigger checks: \(count); no global monitors installed")
    }
}
