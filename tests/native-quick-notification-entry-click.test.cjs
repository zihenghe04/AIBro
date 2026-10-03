const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');

// Compile the actual collapsed SwiftUI Button callback and coordinator methods,
// not a parallel implementation of their guard. Only window side effects are
// replaced with counters; the notification queue and presentation are production.
test('collapsed entry callback respects notification ownership and immediately recovers', {skip:process.platform !== 'darwin', timeout:90000}, () => {
  const source = fs.readFileSync(path.join(root, 'native/Sources/AIBro/NativeQuickEntry.swift'), 'utf8');
  function method(name) {
    const start = source.indexOf('    func ' + name + '(');
    if (start < 0) return '';
    let cursor = source.indexOf('{', start), depth = 1;
    const opening = cursor++;
    while (depth && cursor < source.length) {
      const c = source[cursor++]; if (c === '{') depth++; else if (c === '}') depth--;
    }
    assert.equal(depth, 0, name);
    return source.slice(start, cursor);
  }
  const button = source.slice(source.indexOf('private var collapsedContent: some View')).match(/Button \{([^{}]+)\} label:/)?.[1];
  const shortcut = source.match(/shortcutStore\.onInvoke = (\{ \[weak self\] in self\?\.[^{}]+ \})/)?.[1];
  assert.ok(button && shortcut, 'actual production entry routes must be found');
  assert.match(source, /@objc private func statusItemPressed\(_ sender: Any\?\) \{ togglePanel\(\) \}/);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-notification-entry-'));
  try {
    const program = path.join(temporary, 'CallbackChecks.swift'), binary = path.join(temporary, 'checks');
    fs.writeFileSync(program, String.raw`
import AppKit
@MainActor final class CallbackHost {
    enum Section { case home, tasks }
    struct Workbench { func endTaskSelection() -> Bool { false } }
    var section = Section.home
    let workbench = Workbench()
    var presentation = NativeQuickPresentation()
    var geometry = NativeQuickGeometry.resolve(screen: CGRect(x: 0, y: 0, width: 1512, height: 982),
        visible: CGRect(x: 0, y: 0, width: 1512, height: 945), safeTop: 37, placement: .island)
    var notificationOccupiedRegion: CGRect?
    var opened = 0
    var closed = 0
    var voicePresented = false
    var voiceOnEscape: (() -> Void)?
    func dismissContent(returnFocus: Bool, notifyVoice: Bool) { voicePresented = false; dismiss() }
    func showPanel(screenIntent: NativeQuickScreenSelection.Intent = .anchored) { opened += 1; _ = presentation.request(expanded: true, reducedMotion: true) }
    func dismiss() { closed += 1; _ = presentation.request(expanded: false, reducedMotion: true) }
    func shortcutCallback() -> () -> Void { ${shortcut} }
${method('togglePanel')}
${method('openCollapsedEntry')}
${method('escape')}
}
@main struct Checks {
    @MainActor static func main() {
        var passed = 0, failed = 0
        func check(_ condition: Bool, _ message: String) {
            if condition { passed += 1; print("PASS " + message) }
            else { failed += 1; print("FAIL " + message) }
        }
        let coordinator = CallbackHost()
        let collapsedCallback: () -> Void = { ${button} }
        let shortcut = coordinator.shortcutCallback()
        let queue = NativeQuickNotificationQueue(ownerID: "synthetic-owner", schedulesTimers: false)
        let region = CGRect(x: 556, y: 880, width: 400, height: 102)
        func resetEntry() { coordinator.presentation.reset(); coordinator.opened = 0; coordinator.closed = 0 }
        func publishRegion() { coordinator.notificationOccupiedRegion = queue.current == nil ? nil : region }
        let event = NativeQuickNotificationEvent(id: "fixture-a", ownerID: "synthetic-owner", source: .externalCodex,
            title: "Synthetic completion", outcome: .completed, destination: .external("fixture-a"))!

        collapsedCallback()
        check(coordinator.opened == 1 && coordinator.presentation.wantsExpanded, "first ordinary click opens")
        resetEntry()
        _ = queue.enqueue(event); publishRegion()
        check(queue.phase == .entering, "production queue supplies the entering phase")
        collapsedCallback()
        check(coordinator.opened == 0, "local collapsed Button does not open through entering notification")
        resetEntry()
        queue.finishTransition(generation: queue.generation); publishRegion()
        check(queue.phase == .visible, "production queue reaches visible phase")
        collapsedCallback()
        check(coordinator.opened == 0, "same Button is suppressed while notification remains visible")
        resetEntry()
        queue.dismissCurrent(); publishRegion()
        check(queue.phase == .leaving, "production queue supplies leaving phase")
        collapsedCallback()
        check(coordinator.opened == 0, "local collapsed Button cannot open through exiting notification")
        resetEntry()
        shortcut()
        check(coordinator.opened == 1, "actual explicit shortcut callback still opens while occupied")
        coordinator.escape()
        check(coordinator.closed == 1 && !coordinator.presentation.wantsExpanded, "actual Escape route remains available")
        resetEntry()
        queue.finishTransition(generation: queue.generation); publishRegion()
        check(queue.current == nil && coordinator.notificationOccupiedRegion == nil, "completed exit releases region")
        collapsedCallback()
        check(coordinator.opened == 1, "very first click after release opens with no cooldown")
        resetEntry()
        coordinator.notificationOccupiedRegion = CGRect(x: -1400, y: 880, width: 400, height: 102)
        collapsedCallback()
        check(coordinator.opened == 1, "notification on non-overlapping screen does not block entry")
        resetEntry()
        coordinator.notificationOccupiedRegion = region
        coordinator.showPanel()
        check(coordinator.opened == 1, "explicit main-workspace open remains independent")
        let before = coordinator.closed
        collapsedCallback()
        check(coordinator.closed == before && coordinator.presentation.wantsExpanded, "stale collapsed callback cannot toggle a newly opened panel closed")
        var voiceCancelled = 0
        coordinator.voicePresented = true
        coordinator.voiceOnEscape = { voiceCancelled += 1 }
        coordinator.escape()
        check(voiceCancelled == 1 && !coordinator.voicePresented, "voice Escape cancels the voice subview through the shared island")
        check(NSApp == nil, "no application, window, event monitor or permission was created")
        print("\(passed) passed, \(failed) failed: production entry callback checks")
        if failed > 0 { exit(1) }
    }
}
`);
    const production = ['NativeQuickPresentation.swift', 'NativeQuickNotificationQueue.swift', 'NativeQuickScreenSelection.swift'].map(n => path.join(root, 'native/Sources/AIBro', n));
    const compiled = spawnSync('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', ...production, program, '-o', binary], {encoding:'utf8', timeout:60000});
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
    const run = spawnSync(binary, [], {encoding:'utf8', timeout:10000});
    process.stdout.write(run.stdout);
    assert.equal(run.status, 0, run.stdout + run.stderr);
  } finally { fs.rmSync(temporary, {recursive:true, force:true}); }
});
