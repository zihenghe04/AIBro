const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

test('native panel preferences retain layout, gate available modules and recover default pages', { skip: process.platform !== 'darwin', timeout: 90000 }, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-panel-preferences-'));
  try {
    const source = fs.readFileSync(path.join(root, 'native/Sources/AIBro/NativeQuickPanelPreferences.swift'), 'utf8');
    const program = path.join(temporary, 'Checks.swift'), binary = path.join(temporary, 'checks');
    fs.writeFileSync(program, source + `
func nativeUI(_ zh: String, _ en: String) -> String { en }
@main struct Checks {
 @MainActor static func main() {
    let suite = "test.ai-bro.panel." + UUID().uuidString
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let prefs = NativeQuickPanelPreferences(defaults: defaults)
    let available: Set<NativeQuickPanelSection> = [.home, .tasks, .capture, .runs, .settings]
    precondition(prefs.defaultSection(available: available) == .home)
    precondition(!prefs.visibleSections(available: available).contains(.recordings), "Unregistered feature must remain hidden")
    prefs.setDefault(.capture, available: available)
    precondition(NativeQuickPanelPreferences(defaults: defaults).defaultSection(available: available) == .capture, "Default must survive recreation")
    prefs.setSection(.capture, visible: false)
    precondition(prefs.defaultSection(available: available) == .home, "Hiding default page falls back to home")
    prefs.setSection(.home, visible: false); prefs.setSection(.settings, visible: false)
    precondition(prefs.visibleSections(available: available).contains(.home) && prefs.visibleSections(available: available).contains(.settings))
    prefs.setDefault(.vault, available: available)
    precondition(prefs.defaultSection(available: available) == .home, "Unavailable module cannot become default")

    let allModules = ["music", "pomodoro", "windows", "recorder", "mirror", "note", "commands", "tasks", "runs"]
    precondition(prefs.visibleHomeIDs(available: allModules) == Array(allModules.prefix(7)), "Native defaults mirror the upstream seven-widget canvas")
    precondition(!prefs.usesAutomaticLayout(available: allModules), "Optional task/run cards do not force default widgets into automatic small sizes")
    let modules = ["music", "note", "windows"]
    prefs.setSize(.large, for: "note")
    prefs.moveHome("windows", before: "music", available: modules)
    let order = prefs.configuration.homeOrder, sizes = prefs.configuration.homeSizes
    precondition(prefs.orderedHomeIDs(available: modules) == ["windows", "music", "note"])
    precondition(prefs.setHomeModule("note", visible: false, available: modules))
    precondition(prefs.usesAutomaticLayout(available: modules))
    precondition(prefs.configuration.homeOrder == order && prefs.configuration.homeSizes == sizes, "Auto fill must retain preferred order and sizes")
    precondition(prefs.setHomeModule("music", visible: false, available: modules))
    precondition(!prefs.setHomeModule("windows", visible: false, available: modules), "Last available home module cannot be hidden")
    precondition(prefs.visibleHomeIDs(available: modules) == ["windows"])
    precondition(!prefs.setHomeModule("fake", visible: true, available: modules))
    let reopened = NativeQuickPanelPreferences(defaults: defaults)
    precondition(reopened.visibleHomeIDs(available: modules) == ["windows"])
    precondition(reopened.configuration.homeSizes == sizes)
    _ = reopened.setHomeModule("note", visible: true, available: modules)
    _ = reopened.setHomeModule("music", visible: true, available: modules)
    precondition(!reopened.usesAutomaticLayout(available: modules))
    precondition(reopened.preferredSize("note") == .large && reopened.orderedHomeIDs(available: modules) == ["windows", "music", "note"])
    let beforeUnknown = reopened.configuration
    reopened.moveHome("foreign", before: "music", available: modules)
    precondition(reopened.configuration == beforeUnknown)
    reopened.moveHome("windows", offset: 1, available: modules)
    precondition(reopened.orderedHomeIDs(available: modules) == ["music", "windows", "note"])
    for custom in 0...3 {
        let migrationSuite = "test.ai-bro.migration." + UUID().uuidString
        let migrationDefaults = UserDefaults(suiteName: migrationSuite)!
        var legacy = NativeQuickPanelPreferences.Configuration()
        legacy.homeOrder = ["tasks", "note", "runs", "music", "pomodoro", "windows", "recorder", "mirror", "commands"]
        legacy.homeSizes = ["tasks": .medium, "note": .small, "runs": .small, "music": .medium, "pomodoro": .mini, "windows": .large, "recorder": .small, "mirror": .medium, "commands": .mini]
        legacy.hiddenHomeModules = []
        legacy.defaultSection = .capture
        if custom == 1 { legacy.homeOrder.swapAt(0, 1) }
        if custom == 2 { legacy.homeSizes["note"] = .large }
        if custom == 3 { legacy.hiddenHomeModules = ["mirror"] }
        migrationDefaults.set(try! JSONEncoder().encode(legacy), forKey: "ai-bro-native-quick-panel-preferences-v1")
        let migrated = NativeQuickPanelPreferences(defaults: migrationDefaults)
        if custom == 0 {
            precondition(migrated.visibleHomeIDs(available: allModules) == Array(allModules.prefix(7)), "Untouched legacy home migrates to the upstream default")
            precondition(migrated.defaultSection(available: available) == .capture, "Migration preserves unrelated navigation settings")
            precondition(NativeQuickPanelPreferences(defaults: migrationDefaults).configuration == migrated.configuration, "Migration survives restart")
        } else { precondition(migrated.configuration == legacy, "Any user size, order or visibility choice remains exactly unchanged") }
        migrationDefaults.removePersistentDomain(forName: migrationSuite)
    }
    print("PASS: persisted preferences, default fallback, availability, minimum visibility and layout retention")
 }
}
`);
    const compiled = spawnSync('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', program, '-o', binary], { encoding: 'utf8', timeout: 60000 });
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /PASS: persisted preferences/);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test('explicit capture route and hidden module lifecycle are kept separate from the default home page', () => {
  const source = fs.readFileSync(path.join(root, 'native/Sources/AIBro/NativeQuickEntry.swift'), 'utf8');
  assert.match(source, /func showCapture\(\)\s*\{\s*showPanel\(section: \.capture\)/);
  assert.match(source, /if let requestedSection[\s\S]*else if !presentation\.wantsExpanded[\s\S]*defaultSection/);
  assert.match(source, /sizingOptions = \[\]/);
  const home = fs.readFileSync(path.join(root, 'native/Sources/AIBro/NativeQuickHomeView.swift'), 'utf8');
  assert.match(home, /onChange\(of: visible\)[\s\S]*onVisibilityChange\?\(value\)/);
  assert.match(home, /onDisappear \{ module\.onVisibilityChange\?\(false\); module\.onActivityChange\?\(false\) \}/);
  assert.match(home, /await workbench\.setTaskCompleted/);
  assert.match(home, /await capture\.saveCapture\(\)/);
});
