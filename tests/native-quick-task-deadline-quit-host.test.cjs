const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');

test('actual requestQuit task predicate distinguishes automatic defaults from manual input', {skip:process.platform!=='darwin',timeout:180000},()=>{
 const root=path.resolve(__dirname,'..'),base=path.join(root,'native/Sources/AIBro');
 const host=fs.readFileSync(path.join(base,'AIBro.swift'),'utf8');
 const method=host.slice(host.indexOf('    func requestQuit(){'),host.indexOf('    func applicationShouldTerminate('));
 const assignment=method.match(/draftQuitQuickTasksBlocked = ([\s\S]*?)\n\s*draftQuitQuickAgendaBlocked =/);
 assert.ok(assignment,'The production requestQuit task gate must be located; never substitute a test-only predicate');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aibro-deadline-quit-host-'));
 try {
  const harness=path.join(dir,'Host.swift'),binary=path.join(dir,'quit-host');
  fs.writeFileSync(harness,`import Foundation
import Combine
func nativeUI(_ zh: String, _ en: String) -> String { en }
@MainActor final class TaskEntryFixture {
 let workbench: NativeQuickWorkbenchStore
 var taskDraft = ""
 init(_ store: NativeQuickWorkbenchStore) { workbench = store }
}
@MainActor func actualQuitTaskGate(_ quickEntry: TaskEntryFixture) -> Bool {
 let draftQuitQuickTasksBlocked = ${assignment[1]}
 return draftQuitQuickTasksBlocked
}
@main struct QuitHostTests {
 @MainActor static func main() async throws {
  let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
  func check(_ value: Bool, _ label: String) { precondition(value, label); print("PASS: " + label) }
  let prefs = NativeQuickTaskDeadlinePreferences(directory: root.appendingPathComponent("defaults"))
  try await prefs.save(.nextEvening)
  var calendar = Calendar(identifier: .gregorian); calendar.timeZone = TimeZone(identifier: "Asia/Shanghai")!
  let now = ISO8601DateFormatter().date(from: "2030-12-31T10:00:00+08:00")!
  let store = NativeQuickWorkbenchStore(deadlinePreferences: prefs, now: { now }, calendar: { calendar })
  store.configure(directory: root.appendingPathComponent("workspace"), command: { _ in [:] }, openTask: { _ in false }, openRun: { _ in false })
  store.accept(NativeQuickWorkbenchSnapshot(version: 1, status: "ready", reason: nil, tasks: [], runs: [], taskCount: 0, runCount: 0))
  await store.loadCreationDeadlinePreference()
  defer { store.taskInbox.setAvailable(false) }
  let entry = TaskEntryFixture(store)
  check(store.creationFields.dueAt != nil && store.creationFields != NativeQuickTaskFields(), "Before: old empty-fields comparison treats the automatic date as a draft")
  check(!actualQuitTaskGate(entry), "Actual requestQuit permits empty title plus automatic default date")
  store.markCreationDeadlineManual()
  check(actualQuitTaskGate(entry), "Actual requestQuit protects the same nonempty date after an explicit manual choice")
  store.creationFields.dueAt = nil
  check(!actualQuitTaskGate(entry), "Explicit no deadline with all fields empty does not invent a draft")
  entry.taskDraft = "Fictional unsaved task"
  check(actualQuitTaskGate(entry), "Actual requestQuit still protects a nonempty task title")
  entry.taskDraft = "  \\n  "
  check(!actualQuitTaskGate(entry), "Whitespace-only title and empty fields remain empty")
  store.creationFields.workspace = "科研"
  check(actualQuitTaskGate(entry), "Actual requestQuit protects an actual workspace field change")
  check(store.startNewTaskFields() && !actualQuitTaskGate(entry), "Explicit new form restores the automatic default without a false quit warning")
 }
}
`);
  const files=['NativeQuickRecordFocus.swift','NativeTaskInboxParser.swift','NativeTaskInbox.swift','NativeQuickTaskDeadlinePresets.swift','NativeQuickWorkbench.swift','NativeQuickTaskLifecycle.swift'];
  const built=spawnSync('xcrun',['swiftc','-parse-as-library','-swift-version','5',...files.map(f=>path.join(base,f)),harness,'-o',binary],{encoding:'utf8',timeout:140000});
  assert.equal(built.status,0,built.stdout+built.stderr);
  const result=spawnSync(binary,[path.join(dir,'fixture')],{encoding:'utf8',timeout:15000});
  process.stdout.write(result.stdout);assert.equal(result.status,0,result.stdout+result.stderr);
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
