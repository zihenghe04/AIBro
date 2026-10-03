const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const harness = String.raw`
import Foundation
import Darwin
enum Failed: Error { case assertion(String) }
func check(_ condition: @autoclosure () throws -> Bool, _ message: String) throws { if try !condition() { throw Failed.assertion(message) } }
let fixed = ISO8601DateFormatter().date(from: "2030-10-02T12:00:00Z")!
let zone = TimeZone(identifier: "Asia/Shanghai")!
func json(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
func row(_ id: String = "external-one", title: String = "Review the synthetic handout") -> [String: Any] { ["id": id, "text": title, "category": "P1"] }
func write(_ directory: URL, _ value: Any, name: String = "tasks.json") throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let file = directory.appendingPathComponent(name)
    try json(value).write(to: file, options: .atomic)
    try FileManager.default.setAttributes([.modificationDate: fixed.addingTimeInterval(-5)], ofItemAtPath: file.path)
}
func names(_ directory: URL) throws -> [String] { try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted() }
func reports(_ directory: URL) throws -> [[String: Any]] {
    let folder = directory.appendingPathComponent("processed")
    return try names(folder).filter { $0.hasSuffix(".report.json") }.map { try JSONSerialization.jsonObject(with: Data(contentsOf: folder.appendingPathComponent($0))) as! [String: Any] }
}
@MainActor func store(_ directory: URL, date: Date = fixed, command: @escaping ([String: Any]) async throws -> [String: Any]) -> NativeTaskInbox {
    let value = NativeTaskInbox(automaticallyPoll: false, now: { date }, timeZone: { zone })
    value.configure(directory: directory, command: command); value.setAvailable(true); return value
}
@main struct Suite {
    @MainActor static func main() async throws {
        let name = CommandLine.arguments[1], directory = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let inbox = directory.appendingPathComponent("todo-inbox")
        switch name {
        case "parser-contract":
            let input: [String: Any] = ["categoryNames": ["P0": " 紧急   事项 ", "P1": "Important", "P2": "Important", "P3": "P0"], "todos": [
                ["text": "  One\n task  ", "category": "紧急 事项", "id": 123, "deadline": "2030-10-15"],
                ["text": "Key wins", "category": "p0", "id": "same", "workspace": "课程", "projectId": "course-one", "deadline": "2030-10-02T18:10:22.123456+08:00"],
                ["text": "Ambiguous", "category": "Important"], ["text": "Duplicate", "category": "P3", "id": "same"],
                ["text": "Invalid boolean", "category": "P2", "id": true], ["text": "Unknown scope", "category": "P2", "workspace": "fake"],
                ["text": "Bad calendar", "category": "P1", "deadline": "2030-02-30"], ["text": "Bad ID", "category": "P1", "id": "../escape"]]]
            let data = try json(input), parsed = NativeTaskInboxParser.parse(data, now: fixed, timeZone: zone)
            try check(parsed.entries.count == 2 && parsed.skipped.count == 6, "Partial bad records must not poison valid ones")
            let first = parsed.entries[0], second = parsed.entries[1]
            try check(first.title == "One task" && first.sourceID == "123" && first.category == "P0" && first.priority == "high", "Category display normalization and integer identity")
            try check(first.dueAt == "2030-10-15T15:30:00.000Z", "Date-only is local 23:30")
            try check(second.category == "P0" && second.workspace == "课程" && second.projectId == "course-one" && second.dueAt == "2030-10-02T10:10:22.123Z", "Key priority, exact scope and timezone")
            try check(first.id == NativeTaskInboxParser.taskID("123") && first.id.hasPrefix("quick_task_"), "Source IDs map deterministically into task namespace")
            let bom = Data([0xef,0xbb,0xbf]) + data
            try check(NativeTaskInboxParser.parse(bom, now: fixed).entries.count == 2, "UTF-8 BOM accepted")
        case "dates-and-bounds":
            func deadline(_ value: Any?) -> NativeTaskInboxParser.Deadline { NativeTaskInboxParser.parseDeadline(value, now: fixed, timeZone: zone) }
            try check(deadline(nil).iso == "2030-10-02T15:30:00.000Z", "Missing date frozen at local 23:30")
            try check(deadline("2028-02-29T09:00").iso == "2028-02-29T01:00:00.000Z", "Leap date and timezone-less local time")
            try check(deadline(1_917_086_400_000 as Int64).error == nil && deadline(1_917_086_400).error != nil, "Milliseconds accepted, seconds rejected")
            for value: Any in [true, 2.5, "2030-13-01", "2030-10-01T24:00", "2030-10-01T18:00+14:30", "2030-10-01T18:00+08:99", "1999-12-31", "2030-10-01junk", "２０３０-１０-０２", "2030-10-02T１８:００", "2030-10-02T18:00+０８:００", "2030-10-02T18:00:00.１２３Z"] { try check(deadline(value).error != nil, "Reject malformed date \(value)") }
            try check(NativeTaskInboxParser.parseDeadline("2030-03-10T02:30", now: fixed, timeZone: TimeZone(identifier: "America/New_York")!).error != nil, "Nonexistent DST time rejected instead of silently shifted")
            let capped = NativeTaskInboxParser.parse(try json((0..<201).map { row("item-\($0)") }), now: fixed)
            try check(capped.entries.count == 200 && capped.skipped.last?.index == 200, "200 item boundary is explicit")
            try check(NativeTaskInboxParser.parse(Data(repeating: 32, count: 1_048_577)).error != nil, "1 MiB parser boundary")
            try check(NativeTaskInboxParser.parse(try json([row("emoji", title: String(repeating: "😀", count: 41))])).skipped.count == 1, "Upstream UTF-16 length boundary")
            try check(NativeTaskInboxParser.parse(Data("[]".utf8)).error == nil && NativeTaskInboxParser.parse(Data("{}".utf8)).error != nil, "Array/envelope only")
        case "durable-import":
            try write(inbox, [row()]); let original = try Data(contentsOf: inbox.appendingPathComponent("tasks.json")); var calls = 0
            let value = store(directory) { payload in
                calls += 1
                let state = inbox.appendingPathComponent(".state")
                let pending = try names(state).filter { $0.hasSuffix(".json") }
                try check(pending.count == 1, "Journal durable before side effect")
                try check(FileManager.default.fileExists(atPath: inbox.appendingPathComponent("tasks.json").path), "Original stays before ACK")
                try check(payload["workspace"] as? String == "日常" && payload["projectId"] is NSNull, "No current-project inference")
                return ["status": "saved", "id": payload["id"]!, "alreadyExists": calls > 1]
            }
            await value.scan()
            try check(calls == 1 && value.error == nil && !FileManager.default.fileExists(atPath: inbox.appendingPathComponent("tasks.json").path), "ACK archives source")
            let report = try reports(inbox)[0]
            try check(report["status"] as? String == "imported" && (report["summary"] as? [String: Int])?["imported"] == 1, "Machine readable result")
            let archive = try names(inbox.appendingPathComponent("processed")).first { !$0.hasSuffix(".report.json") }!
            try check(try Data(contentsOf: inbox.appendingPathComponent("processed/" + archive)) == original, "Exact input retained")
            let permissions = try FileManager.default.attributesOfItem(atPath: inbox.appendingPathComponent("processed/" + archive).path)[.posixPermissions] as? NSNumber
            try check(permissions?.intValue == 0o600, "Owner-only archive")
            await value.scan(); try check(calls == 1, "Empty scanner never replays archive")
            try write(inbox, [row()]); await value.scan()
            try check(calls == 2 && (try reports(inbox)).count == 2, "An intentional file replay keeps its own report without overwriting the earlier import report")
        case "lost-ack-restart":
            try write(inbox, [row()]); var persisted: [String: Any]?
            let first = store(directory) { payload in persisted = payload; throw Failed.assertion("lost ACK") }
            await first.scan(); try check(persisted != nil && FileManager.default.fileExists(atPath: inbox.appendingPathComponent("tasks.json").path), "Uncertain save retains source")
            var retries = 0
            let second = store(directory, date: fixed.addingTimeInterval(86400)) { payload in
                retries += 1
                try check(payload["id"] as? String == persisted?["id"] as? String && payload["dueAt"] as? String == persisted?["dueAt"] as? String, "Restart uses frozen identity AND default deadline")
                return ["status": "saved", "id": payload["id"]!, "alreadyExists": true]
            }
            await second.scan(); try check(retries == 1 && second.lastReport?.skipped.count == 1, "Recovered ACK does not add a second task")
        case "partial-and-retry":
            try write(inbox, [row("good"), ["category": "P0"], row("wrong-project"), row("later")]); var calls: [String] = []; var fail = true
            let value = store(directory) { payload in
                let id = (payload["sourceTaskInbox"] as! [String: Any])["id"] as! String; calls.append(id)
                if id == "wrong-project" { return ["status": "error", "reason": "invalid"] }
                if id == "later" && fail { return ["status": "error", "reason": "storage_failed"] }
                return ["status": "saved", "id": payload["id"]!]
            }
            await value.scan(); try check(calls == ["good", "wrong-project", "later"] && value.lastReport == nil, "Retryable storage failure leaves partial source")
            fail = false; await value.scan()
            try check(calls == ["good", "wrong-project", "later", "later"], "ACKed prefix not replayed")
            try check(value.lastReport?.status == "partial" && value.lastReport?.imported.count == 2 && value.lastReport?.skipped.count == 2, "Parse and scope errors reported independently")
        case "wrong-ack":
            try write(inbox, [row()]); let value = store(directory) { _ in ["status": "saved", "id": "other"] }
            await value.scan(); try check(value.lastReport == nil && FileManager.default.fileExists(atPath: inbox.appendingPathComponent("tasks.json").path), "Mismatched identity is not ACK")
        case "replace-during-ack":
            try write(inbox, [row("old")]); var calls: [String] = []
            let value = store(directory) { payload in
                let id = (payload["sourceTaskInbox"] as! [String: Any])["id"] as! String; calls.append(id)
                if id == "old" { try write(inbox, [row("new")]) }
                return ["status": "saved", "id": payload["id"]!]
            }
            await value.scan(); try check(FileManager.default.fileExists(atPath: inbox.appendingPathComponent("tasks.json").path), "Replacement never archived as old input")
            await value.scan(); try check(calls == ["old", "new"] && (try reports(inbox)).count == 2, "Both acknowledged snapshots retained with their own hash")
        case "replace-mid-batch":
            try write(inbox, [row("first"), row("stale-second")]); var calls: [String] = []
            let value = store(directory) { payload in
                let id = (payload["sourceTaskInbox"] as! [String: Any])["id"] as! String; calls.append(id)
                if id == "first" { try write(inbox, [row("replacement")]) }
                return ["status": "saved", "id": payload["id"]!]
            }
            await value.scan(); await value.scan()
            try check(calls == ["first", "replacement"], "Replaced remaining rows are not silently executed")
            try check(try names(inbox.appendingPathComponent(".state")).contains { $0.hasPrefix("recovery-") }, "Old snapshot and partial ACK progress preserved")
        case "archive-failure":
            try write(inbox, [row()]); var blocker: URL?
            var calls = 0; let value = store(directory) { payload in
                calls += 1
                let file = inbox.appendingPathComponent(".state/" + NativeTaskInboxParser.hash(Data("tasks.json".utf8)) + ".json")
                let journal = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
                blocker = inbox.appendingPathComponent("processed/" + (journal["archiveID"] as! String) + ".report.json")
                try FileManager.default.createDirectory(at: blocker!, withIntermediateDirectories: true)
                return ["status": "saved", "id": payload["id"]!]
            }
            await value.scan(); try check(calls == 1 && FileManager.default.fileExists(atPath: inbox.appendingPathComponent("tasks.json").path), "Archive failure retains original and ACK progress")
            try FileManager.default.removeItem(at: blocker!); await value.scan()
            try check(calls == 1 && value.lastReport?.status == "imported", "Retry only archive, not backend")
        case "unsafe-files":
            try FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
            let outside = directory.appendingPathComponent("private.json"); try json([row()]).write(to: outside)
            try FileManager.default.createSymbolicLink(at: inbox.appendingPathComponent("symlink.json"), withDestinationURL: outside)
            try FileManager.default.linkItem(at: outside, to: inbox.appendingPathComponent("hardlink.json"))
            try check(mkfifo(inbox.appendingPathComponent("pipe.json").path, 0o600) == 0, "Fixture FIFO")
            var calls = 0; let value = store(directory) { _ in calls += 1; return [:] }; await value.scan()
            try check(calls == 0 && FileManager.default.fileExists(atPath: outside.path), "No linked or special files read/imported")
            try check(try names(inbox).contains("symlink.json") && names(inbox).contains("hardlink.json"), "Unsafe inputs never deleted")
        case "unsafe-directory":
            let outside = directory.appendingPathComponent("external"); try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
            try FileManager.default.createSymbolicLink(at: inbox, withDestinationURL: outside)
            var calls = 0; let value = store(directory) { _ in calls += 1; return [:] }; await value.scan()
            try check(calls == 0 && value.ensureDirectory() == nil && (try names(outside)).isEmpty, "Inbox symlink never followed or populated")
        case "limits-and-ignore":
            try write(inbox, [row()], name: ".hidden.json"); try write(inbox, [row()], name: "ignored.report.json")
            try write(inbox, [row()], name: "in-progress.tmp")
            try Data(repeating: 32, count: 1_048_577).write(to: inbox.appendingPathComponent("large.json"))
            try FileManager.default.setAttributes([.modificationDate: fixed.addingTimeInterval(-5)], ofItemAtPath: inbox.appendingPathComponent("large.json").path)
            var calls = 0; let value = store(directory) { _ in calls += 1; return [:] }; await value.scan()
            try check(calls == 0 && FileManager.default.fileExists(atPath: inbox.appendingPathComponent("large.json.report.json").path), "Oversized input gets explicit sidecar without reading/importing")
            try check(FileManager.default.fileExists(atPath: inbox.appendingPathComponent("large.json").path), "Oversized original retained")
            let longName = String(repeating: "a", count: 246) + ".json"
            try Data(repeating: 32, count: 1_048_577).write(to: inbox.appendingPathComponent(longName))
            try FileManager.default.setAttributes([.modificationDate: fixed.addingTimeInterval(-5)], ofItemAtPath: inbox.appendingPathComponent(longName).path)
            await value.scan()
            try check(try names(inbox).contains("error-" + NativeTaskInboxParser.hash(Data(longName.utf8)) + ".report.json"), "Long filenames still receive a bounded visible error report")
        case "entry-guide-and-workspace":
            let value = store(directory) { _ in [:] }
            value.setAvailable(false)
            try check(value.ensureDirectory() == nil && !FileManager.default.fileExists(atPath: inbox.path), "Menu cannot open/create a private or unavailable inbox")
            value.setAvailable(true)
            try check(value.ensureDirectory()?.path == inbox.resolvingSymlinksInPath().path, "Ready menu returns fixed bound directory")
            let guide = inbox.appendingPathComponent("README.txt")
            try check(try String(contentsOf: guide, encoding: .utf8).contains("{\"todos\""), "A real guide explains the exact contract")
            try Data("User explanation".utf8).write(to: guide)
            _ = value.ensureDirectory()
            try check(try String(contentsOf: guide, encoding: .utf8) == "User explanation", "Never replace an existing guide")
            value.configure(directory: directory.appendingPathComponent("another"), command: { _ in [:] })
            try check(value.ensureDirectory() == nil, "An old inbox is not exposed after workspace-binding mismatch")
        case "settle-ready-budget":
            try write(inbox, (0..<25).map { row("item-\($0)") }); var calls = 0
            let value = store(directory) { payload in calls += 1; return ["status": "saved", "id": payload["id"]!] }
            value.setAvailable(false); await value.scan(); try check(calls == 0, "No scan while workspace unavailable")
            value.setAvailable(true); try FileManager.default.setAttributes([.modificationDate: fixed], ofItemAtPath: inbox.appendingPathComponent("tasks.json").path)
            await value.scan(); try check(calls == 0, "One-second writer settling window")
            try FileManager.default.setAttributes([.modificationDate: fixed.addingTimeInterval(-5)], ofItemAtPath: inbox.appendingPathComponent("tasks.json").path)
            await value.scan(); try check(calls == 20 && value.lastReport == nil, "Bounded work per scan")
            await value.scan(); try check(calls == 25 && value.lastReport?.imported.count == 25, "Subsequent scan resumes exactly at ACK cursor")
        case "corrupt-journal":
            try write(inbox, [row()]); var calls = 0
            let value = store(directory) { _ in calls += 1; return [:] }; _ = value.ensureDirectory()
            let file = inbox.appendingPathComponent(".state/" + NativeTaskInboxParser.hash(Data("tasks.json".utf8)) + ".json")
            try Data("broken".utf8).write(to: file); await value.scan()
            try check(calls == 0 && (try Data(contentsOf: file)) == Data("broken".utf8), "Corrupt recovery never silently reset")
        default: throw Failed.assertion(name)
        }
        print("PASS: " + name)
    }
}
`;
test('native task inbox uses real files, durable identities and strict import contract', { skip: process.platform !== 'darwin', timeout: 180000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-task-inbox-'));
  try {
    const source = path.join(dir, 'suite.swift'), binary = path.join(dir, 'suite'); fs.writeFileSync(source, harness);
    const sources = ['NativeTaskInboxParser.swift', 'NativeTaskInbox.swift'].map(file => path.resolve(__dirname, '../native/Sources/AIBro', file));
    const compile = spawnSync('xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', ...sources, source, '-o', binary], { encoding: 'utf8', timeout: 90000 });
    assert.equal(compile.status, 0, compile.stdout + compile.stderr);
    for (const name of ['parser-contract', 'dates-and-bounds', 'durable-import', 'lost-ack-restart', 'partial-and-retry', 'wrong-ack', 'replace-during-ack', 'replace-mid-batch', 'archive-failure', 'unsafe-files', 'unsafe-directory', 'limits-and-ignore', 'entry-guide-and-workspace', 'settle-ready-budget', 'corrupt-journal']) {
      if (process.env.AIBRO_INBOX_CASE && !process.env.AIBRO_INBOX_CASE.split(',').includes(name)) continue;
      await t.test(name, () => {
        const result = spawnSync(binary, [name, path.join(dir, name)], { encoding: 'utf8', timeout: 15000 });
        assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /PASS:/);
      });
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
