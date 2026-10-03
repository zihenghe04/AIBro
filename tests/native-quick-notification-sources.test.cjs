const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('notification sources baseline real terminal changes and accept only committed timer completions', {
  skip: process.platform !== 'darwin', timeout: 90000,
}, () => {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-notification-sources-'));
  try {
    const file = path.join(temp, 'SourceTests.swift'), binary = path.join(temp, 'source-tests');
    fs.writeFileSync(file, String.raw`
import Foundation
import AppKit
func nativeUI(_ zh: String, _ en: String) -> String { en }
@main struct SourceTests {
  @MainActor static func main() throws {
    typealias S = NativeQuickNotificationSources
    typealias E = NativeQuickNotificationEvent
    var checks = 0
    func check(_ value: @autoclosure () -> Bool, _ message: String) { checks += 1; precondition(value(), message) }
    var date = Date(timeIntervalSince1970: 2_000_000_000)
    let queue = NativeQuickNotificationQueue(ownerID: "workspace", schedulesTimers: false)
    let source = S(queue: queue, now: { date })
    func run(_ id: String, _ status: String, end: Double? = 2_000_000_001_000, ready: Bool = true, title: String = "Synthetic research") -> S.Run {
      .init(id: id, title: title, status: status, finishedAt: end, notificationReady: ready)
    }
    source.accept([run("old", "completed", end: 1_900_000_000_000), run("pending-history", "completed", end: 1_900_000_000_001, ready: false), run("active", "running", end: nil, ready: false)])
    check(queue.history.isEmpty, "First complete snapshot establishes a baseline without replaying history")
    source.accept([run("old", "completed", end: 1_900_000_000_000), run("pending-history", "completed", end: 1_900_000_000_001), run("imported", "completed", end: 1_900_000_000_002), run("active", "awaiting-save", ready: false)])
    check(queue.history.isEmpty, "Delayed historical messages, imported history and awaiting-save never notify success")
    source.accept([run("active", "completed")])
    check(queue.history.count == 1 && queue.history[0].outcome == .completed, "Observed run completion emits one typed success")
    check(queue.history[0].destination == .run("active") && queue.history[0].source == .agent, "Original navigation identity and source are retained")
    source.accept([run("active", "completed", title: "Renamed conversation")])
    check(queue.history.count == 1, "Renaming and repeated snapshots cannot replay a terminal event")
    var terminals = [run("active", "completed")]
    for (status, outcome) in [("failed", E.Outcome.failed), ("cancelled", .stopped), ("interrupted", .interrupted), ("rejected", .rejected)] {
      terminals.append(run(status, status)); source.accept(terminals)
      check(queue.history.first?.outcome == outcome && queue.history.first?.outcome != .completed, "A non-success terminal never gets a completed presentation")
    }
    let count = queue.history.count
    source.accept(terminals + [run("not-done", "awaiting-input"), run("bad-time", "completed", end: .infinity), run("no-message", "completed", ready: false), run("collision", "completed"), run("collision", "failed")])
    check(queue.history.count == count, "Nonterminal, malformed, missing-final and ambiguous identities cannot notify")
    source.accept(terminals.filter { $0.id != "failed" })
    check(!queue.history.contains(where: { $0.destination == .run("failed") }), "Access-filtered deletion/private movement withdraws queued titles and destinations")
    source.accept(nil)
    check(queue.history.isEmpty && queue.current == nil && !source.available, "Privacy/unavailability clears copied titles and destinations")
    check(!source.acceptPomodoro(runID: "timer", phase: "focus", duration: 5, completedAt: date, ownerID: "workspace"), "Unavailable source does not claim visual delivery")
    source.accept(terminals)
    check(queue.history.isEmpty, "Unlock establishes a fresh baseline instead of replaying private-period history")
    check(!source.acceptPomodoro(runID: "timer", phase: "focus", duration: 5, completedAt: date, ownerID: "other"), "Timer from another workspace is rejected")
    check(source.acceptPomodoro(runID: "timer", phase: "focus", duration: 5, completedAt: date, ownerID: "workspace"), "Committed timer accepted for the correct owner")
    check(source.acceptPomodoro(runID: "timer", phase: "focus", duration: 5, completedAt: date, ownerID: "workspace") && queue.history.count == 1, "Repeated commit receipt retains one event")
    check(queue.history[0].destination == .pomodoro("timer"), "Timer navigation points to the completed interval")

    let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
    var failWrite = false, fallback = 0
    var completions: [NativeQuickPomodoroCompletion] = []
    let store = NativeQuickUtilitiesStore(now: { date }, write: { data, url in
      if failWrite { throw CocoaError(.fileWriteNoPermission) }
      try data.write(to: url, options: .atomic)
    }, copy: { _ in false }, notify: { _ in fallback += 1 }, schedulesTimers: false)
    store.onCommittedCompletion = { event in
      let saved = try! String(contentsOf: directory.appendingPathComponent("native-quick-utilities.json"), encoding: .utf8)
      check(saved.contains("\"completed\""), "Committed hook sees durable completed bytes")
      completions.append(event); return true
    }
    store.configure(directory: directory)
    check(store.configurePomodoro(focusSeconds: 2, restSeconds: 1) && store.startPomodoro(phase: .focus), "Start synthetic focus interval")
    let runID = store.currentPomodoroRunID
    failWrite = true; date = date.addingTimeInterval(3); store.tick()
    check(completions.isEmpty && fallback == 0, "Failed disk write triggers neither completion queue nor old attention")
    failWrite = false; date = date.addingTimeInterval(6); store.tick()
    check(completions.count == 1 && fallback == 0, "Only successful retry invokes the committed hook")
    check(completions[0].runID == runID && completions[0].phase == .focus && completions[0].duration == 2 && completions[0].directory == directory, "Hook preserves canonical run, phase, duration and owner directory")
    store.tick(); check(completions.count == 1, "Later ticks do not re-enqueue completion")
    store.onCommittedCompletion = { _ in false }
    check(store.startPomodoro(phase: .rest), "Start rest interval")
    date = date.addingTimeInterval(2); store.tick()
    check(fallback == 1, "Queue unavailable/full retains established attention fallback")
    let reloaded = NativeQuickUtilitiesStore(now: { date }, copy: { _ in false }, notify: { _ in fallback += 1 }, schedulesTimers: false)
    reloaded.onCommittedCompletion = { _ in fatalError("Saved historical completion replayed") }
    reloaded.configure(directory: directory)
    check(reloaded.status == .completed && fallback == 1, "Restart never replays already committed timer completion")
    check(NSApp == nil, "Source checks never launch or operate an application")
    print("PASS: \(checks) real-source and durable-commit assertions")
  }
}
`);
    const production = ['NativeQuickNotificationQueue.swift', 'NativeQuickNotificationSources.swift',
      'NativeQuickNotificationPanel.swift', 'NativeQuickUtilities.swift', 'NativeQuickWidgetContext.swift']
      .map(name => path.join(root, 'native/Sources/AIBro', name));
    const built = spawnSync('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', ...production, file, '-o', binary], { encoding: 'utf8', timeout: 70000 });
    assert.equal(built.status, 0, built.stdout + built.stderr + (built.error?.message || ''));
    const result = spawnSync(binary, [path.join(temp, 'synthetic-workspace')], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message || ''));
    assert.match(result.stdout, /PASS: \d+ real-source/); console.log(result.stdout.trim());
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
