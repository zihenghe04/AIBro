const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const sources = ['NativeQuickRecordFocus.swift', 'NativeTaskInboxParser.swift', 'NativeTaskInbox.swift', 'NativeQuickTaskDeadlinePresets.swift', 'NativeQuickWorkbench.swift', 'NativeQuickTaskLifecycle.swift', 'NativeQuickTaskDeadline.swift']
  .map(name => path.resolve(__dirname, '../native/Sources/AIBro', name));

// Compile production classification and the actual SwiftUI badge together.
// No app launch, user workspace, wall-clock sleeps, or mock deadline algorithm.
const harness = String.raw`
import Foundation
import Combine
import SwiftUI

func nativeUI(_ chinese: String, _ english: String) -> String { english }
enum Failure: Error { case assertion(String) }
func check(_ value: @autoclosure () -> Bool, _ message: String) throws {
    if !value() { throw Failure.assertion(message) }
}
func date(_ iso: String) -> Date { ISO8601DateFormatter().date(from: iso)! }
func calendar(_ zone: String = "Asia/Shanghai") -> Calendar {
    var value = Calendar(identifier: .gregorian)
    value.timeZone = TimeZone(identifier: zone)!; return value
}
func item(_ due: NativeQuickTaskDate?, created: Date? = nil, completed: Bool = false) -> NativeQuickTaskItem {
    var value = NativeQuickTaskItem(id: "synthetic-task", title: "Read synthetic material", projectTitle: "", dueLabel: "", isCompleted: completed, version: "v1", dueAt: due)
    value.createdAt = created.map { $0.timeIntervalSince1970 * 1000 }
    return value
}
func project(_ item: NativeQuickTaskItem, _ now: String, _ zone: String = "Asia/Shanghai") -> NativeQuickTaskDeadline? {
    NativeQuickTaskDeadline.presentation(for: item, now: date(now), calendar: calendar(zone))
}

@main struct DeadlineTests {
    static func main() {
        do { try run(CommandLine.arguments[1]); print("PASS: " + CommandLine.arguments[1]) }
        catch { FileHandle.standardError.write(Data("FAIL: \(error)\n".utf8)); exit(1) }
    }

    static func run(_ name: String) throws {
        switch name {
        case "all-day-midnight":
            let task = item(.text("2030-10-03"))
            let morning = project(task, "2030-10-03T00:00:00+08:00")!
            try check(morning.urgency == .today && morning.isAllDay, "An all-day task remains due throughout its local day")
            try check(morning.cutoff == date("2030-10-04T00:00:00+08:00"), "The exclusive boundary is the following local midnight")
            try check(project(task, "2030-10-03T23:59:59+08:00")?.urgency == .today, "The last second of a due day is not overdue")
            try check(project(task, "2030-10-04T00:00:00+08:00")?.urgency == .overdue, "All-day becomes overdue at next midnight")
            try check(task.dueAt == .text("2030-10-03"), "Presentation never rewrites the raw deadline")

        case "explicit-calendar-zone":
            let task = item(.text("2030-10-03"))
            let now = "2030-10-03T18:00:00Z"
            try check(project(task, now, "Asia/Shanghai")?.urgency == .overdue, "Shanghai is already the next day")
            try check(project(task, now, "America/Los_Angeles")?.urgency == .today, "The same raw date is still today in Los Angeles")

        case "daylight-saving-days":
            let spring = project(item(.text("2030-03-10")), "2030-03-10T00:00:00-08:00", "America/Los_Angeles")!
            try check(spring.cutoff.timeIntervalSince(spring.date) == 23 * 3600, "Spring all-day task is 23 hours, not a fixed 24h duration")
            try check(spring.cutoff == date("2030-03-11T00:00:00-07:00"), "Spring still expires at local midnight")
            let fall = project(item(.text("2030-11-03")), "2030-11-03T00:00:00-07:00", "America/Los_Angeles")!
            try check(fall.cutoff.timeIntervalSince(fall.date) == 25 * 3600, "Fall all-day task is 25 hours")

        case "exact-timestamp-boundary":
            let task = item(.text("2030-10-03T10:30:00+08:00"))
            try check(project(task, "2030-10-03T10:29:59+08:00")?.urgency == .today, "Future time on the same day is due today")
            let exact = project(task, "2030-10-03T10:30:00+08:00")!
            try check(exact.urgency == .overdue && !exact.isAllDay && exact.cutoff == exact.date, "Exact timestamp does not gain a whole extra day")
            let numeric = item(.milliseconds(exact.date.timeIntervalSince1970 * 1000))
            try check(project(numeric, "2030-10-03T10:30:00+08:00") == exact, "Legacy numeric timestamps follow the same boundary")

        case "soon-vs-today":
            let task = item(.text("2030-10-03T20:00:00+08:00"))
            try check(project(task, "2030-10-01T19:59:59+08:00")?.urgency == .scheduled, "More than 48h remains scheduled")
            try check(project(task, "2030-10-01T20:00:00+08:00")?.urgency == .soon, "48h horizon is inclusive")
            try check(project(task, "2030-10-03T00:00:00+08:00")?.urgency == .today, "Today takes precedence over the soon window")

        case "battery-real-start":
            let start = date("2030-10-03T10:00:00+08:00")
            let task = item(.text("2030-10-03T12:00:00+08:00"), created: start)
            try check(project(task, "2030-10-03T10:00:00+08:00")?.remainingPercent == 100, "Creation begins at a full battery")
            try check(project(task, "2030-10-03T11:00:00+08:00")?.remainingFraction == 0.5, "Half the actual allotment remains")
            try check(project(task, "2030-10-03T13:00:00+08:00")?.remainingPercent == 0, "Expired battery clamps at zero")

        case "rounded-zero-is-not-overdue":
            let task = item(.text("2030-10-03T12:00:00+08:00"), created: date("2030-10-03T10:00:00+08:00"))
            let nearly = project(task, "2030-10-03T11:59:59+08:00")!
            try check(nearly.remainingPercent == 0 && nearly.urgency == .today && nearly.remainingFraction! > 0, "Rounding a battery to 0 does not mean overdue")
            try check(project(task, "2030-10-03T12:00:00+08:00")?.urgency == .overdue, "Only the actual boundary is overdue")

        case "missing-invalid-created-at":
            var task = item(.text("2030-10-03T12:00:00+08:00"))
            try check(project(task, "2030-10-03T11:00:00+08:00")?.remainingFraction == nil, "Missing creation never fabricates a start")
            for value in [Double.nan, Double.infinity, -1, 0, 1e100, date("2030-10-03T12:00:00+08:00").timeIntervalSince1970 * 1000] {
                task.createdAt = value
                let state = project(task, "2030-10-03T11:00:00+08:00")!
                try check(state.remainingFraction == nil && state.urgency == .today, "Invalid intervals omit only the battery, not the due status")
            }
            task.createdAt = date("2030-10-03T11:30:00+08:00").timeIntervalSince1970 * 1000
            try check(project(task, "2030-10-03T11:00:00+08:00")?.remainingFraction == nil, "A future creation time is not a valid elapsed interval")

        case "no-invalid-deadline":
            for raw: NativeQuickTaskDate? in [nil, .text(""), .text("2030-02-30"), .text("2030-13-01"), .text("not a deadline"), .text("2030-02-30T10:00:00Z"), .milliseconds(.nan), .milliseconds(.infinity), .milliseconds(1e100)] {
                try check(project(item(raw), "2030-10-03T11:00:00+08:00") == nil, "Malformed or absent deadlines never show invented urgency")
            }
            try check(NativeQuickTaskDeadline.presentation(for: item(.text("2030-10-03")), now: Date(timeIntervalSince1970: .nan)) == nil, "An invalid current time is not a meaningful countdown")

        case "completed-neutral":
            let task = item(.text("2030-10-03"), created: date("2030-10-01T10:00:00+08:00"), completed: true)
            let state = project(task, "2030-10-05T11:00:00+08:00")!
            try check(state.isCompleted && state.urgency == .scheduled && state.remainingFraction == nil, "Completed task keeps neutral deadline metadata without an overdue alert")

        default: throw Failure.assertion("Unknown test " + name)
        }
    }
}
`;

test('production native task deadline presentation and badge compile', { skip: process.platform !== 'darwin', timeout: 180000 }, async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-task-deadline-'));
  try {
    const source = path.join(temporary, 'DeadlineTests.swift');
    const binary = path.join(temporary, 'deadline-tests');
    fs.writeFileSync(source, harness);
    const compiled = spawnSync('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', ...sources, source, '-o', binary], { encoding: 'utf8', timeout: 90000 });
    assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr + (compiled.error?.message ?? ''));
    for (const name of ['all-day-midnight', 'explicit-calendar-zone', 'daylight-saving-days', 'exact-timestamp-boundary', 'soon-vs-today', 'battery-real-start', 'rounded-zero-is-not-overdue', 'missing-invalid-created-at', 'no-invalid-deadline', 'completed-neutral']) {
      await t.test(name, () => {
        const result = spawnSync(binary, [name], { encoding: 'utf8', timeout: 15000 });
        assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message ?? ''));
        assert.ok(result.stdout.includes('PASS: ' + name));
      });
    }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
