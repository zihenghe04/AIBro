const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process');
test('quick entry persists opt-out and chosen location across reconstruction without enabling other services', {skip: process.platform !== 'darwin', timeout: 60000}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-entry-preferences-'));
  try {
    const fixture = path.join(directory, 'checks.swift');
    fs.writeFileSync(fixture, `import Foundation
func nativeUI(_ zh: String, _ en: String) -> String { en }
@main struct Checks {
 static func main() {
  let suite = "dev.aibro.test.entry-preferences." + UUID().uuidString
  let defaults = UserDefaults(suiteName:suite)!
  defer { defaults.removePersistentDomain(forName:suite) }
  func entry() -> NativeQuickEntryPreferences { .init(defaults:UserDefaults(suiteName:suite)!) }
  precondition(entry().mode == .island)
  precondition(defaults.persistentDomain(forName:suite) == nil)
  for location in [NativeQuickEntryMode.island, .edge, .menuBar] {
   entry().save(location)
   precondition(entry().mode == location)
   entry().save(.off)
   precondition(entry().mode == .off)
   precondition(entry().preferredEnabledMode == location)
   entry().save(entry().preferredEnabledMode)
   precondition(entry().mode == location)
  }
  defaults.removePersistentDomain(forName:suite)
  entry().save(.off)
  precondition(entry().mode == .off && entry().preferredEnabledMode == .island)
  defaults.set("unknown",forKey:NativeQuickEntryPreferences.modeKey)
  defaults.set("off",forKey:NativeQuickEntryPreferences.lastEnabledModeKey)
  precondition(entry().mode == .off && entry().preferredEnabledMode == .island)
  defaults.set(["unexpected":true],forKey:NativeQuickEntryPreferences.modeKey)
  precondition(entry().mode == .off)
  let keys=Set(defaults.persistentDomain(forName:suite)!.keys)
  precondition(keys == Set([NativeQuickEntryPreferences.modeKey,NativeQuickEntryPreferences.lastEnabledModeKey]))
  print("PASS entry defaults, explicit off, reconstruction, remembered locations and isolated settings")
 }
}`);
    const binary=path.join(directory,'checks');
    const result=spawnSync('xcrun',['swiftc','-swift-version','5','-parse-as-library',path.resolve(__dirname,'../native/Sources/AIBro/NativeQuickEntryPreferences.swift'),fixture,'-o',binary],{encoding:'utf8',timeout:45000});
    assert.equal(result.status,0,result.stdout+result.stderr);
    const run=spawnSync(binary,[],{encoding:'utf8',timeout:10000});
    assert.equal(run.status,0,run.stdout+run.stderr);process.stdout.write(run.stdout);
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
