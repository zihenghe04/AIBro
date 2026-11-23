import Foundation

@main struct DevPreferenceImportChecks {
    static func main() {
        var count=0
        func check(_ ok:Bool,_ name:String){precondition(ok,name);count+=1;print("PASS \(name)")}
        let suite="aibro-import-check-\(UUID().uuidString)"
        let release=UserDefaults(suiteName:suite+".release")!,dev=UserDefaults(suiteName:suite+".dev")!
        defer {release.removePersistentDomain(forName:suite+".release");dev.removePersistentDomain(forName:suite+".dev")}
        let voice=Data(#"{"modifiers":2560,"keyCode":9}"#.utf8)
        release.set(voice,forKey:"ai-bro-native-speech-shortcut-v1")
        release.set(Data(#"{"keyCode":0,"modifiers":4608}"#.utf8),forKey:"ai-bro-native-quick-shortcut-v1")
        release.set("island",forKey:"ai-bro-native-quick-entry-mode")
        release.set("https://example.invalid",forKey:"workstation-api-base")
        release.set("secret",forKey:"some-token")
        dev.set(Data(#"{"modifiers":6144,"keyCode":9}"#.utf8),forKey:"ai-bro-native-speech-shortcut-v1")
        let before=release.dictionaryRepresentation().filter{$0.key.hasPrefix("ai-bro")||$0.key=="workstation-api-base"||$0.key=="some-token"}.count

        let copied=NativeDevPreferenceImport.run(dev:dev,release:release)
        check(Set(copied)==["ai-bro-native-speech-shortcut-v1","ai-bro-native-quick-shortcut-v1","ai-bro-native-quick-entry-mode"],"copies only the listed keys the release app has")
        check(dev.data(forKey:"ai-bro-native-speech-shortcut-v1")==voice,"release ⌥⇧V replaces the Dev default once")
        check(dev.object(forKey:"workstation-api-base")==nil && dev.object(forKey:"some-token")==nil,"server address and tokens are never copied")
        check(!NativeDevPreferenceImport.keys.contains{key in ["api","token","secret","base","model","password"].contains{key.contains($0)}},"import list has no credential-like keys")
        check(dev.bool(forKey:NativeDevPreferenceImport.markerKey),"marker set after import")
        check(release.object(forKey:NativeDevPreferenceImport.markerKey)==nil,"release domain gets no marker")
        let after=release.dictionaryRepresentation().filter{$0.key.hasPrefix("ai-bro")||$0.key=="workstation-api-base"||$0.key=="some-token"}.count
        check(before==after,"release domain unchanged")

        dev.set(Data(#"{"modifiers":6144,"keyCode":49}"#.utf8),forKey:"ai-bro-native-quick-shortcut-v1")
        check(NativeDevPreferenceImport.run(dev:dev,release:release).isEmpty && dev.data(forKey:"ai-bro-native-quick-shortcut-v1")==Data(#"{"modifiers":6144,"keyCode":49}"#.utf8),"second launch keeps Dev's own later changes")

        let fresh=UserDefaults(suiteName:suite+".fresh")!
        defer {fresh.removePersistentDomain(forName:suite+".fresh")}
        check(NativeDevPreferenceImport.run(dev:fresh,release:nil).isEmpty && fresh.bool(forKey:NativeDevPreferenceImport.markerKey),"no release app: nothing copied, marker still set")

        let dir=FileManager.default.temporaryDirectory.appendingPathComponent(suite);try! FileManager.default.createDirectory(at:dir,withIntermediateDirectories:true)
        defer {try? FileManager.default.removeItem(at:dir)}
        let file=dir.appendingPathComponent("native-preferences.json")
        try! Data(#"{"ai-bro-language":"en","workstation-api-base":"https://example.invalid"}"#.utf8).write(to:file)
        check(NativeDevPreferenceImport.language(releasePreferences:file)=="en","language read from release preferences")
        try! Data(#"{"ai-bro-language":"fr"}"#.utf8).write(to:file)
        check(NativeDevPreferenceImport.language(releasePreferences:file)==nil,"unknown language ignored")
        check(NativeDevPreferenceImport.language(releasePreferences:dir.appendingPathComponent("missing.json"))==nil,"missing file ignored")
        check(NativeDevPreferenceImport.runAtLaunch(bundle:Bundle(for:BundleProbe.self)).isEmpty,"non-Dev bundle never imports")
        print("dev preference import checks: \(count)")
    }
}
final class BundleProbe {}
