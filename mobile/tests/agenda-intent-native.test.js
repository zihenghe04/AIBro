import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Store, MemoryAdapter } from "../src/store.js";
import { ask } from "../src/ai.js";
import { applyPlan } from "../src/agent-tools.js";

const run = promisify(execFile);
test("a real locally approved mobile agenda projects into the Mac engine with the same wire identity", async () => {
  const store = await new Store(new MemoryAdapter()).load();
  const proposal = await ask({ store, prompt: "明天下午三点打篮球，帮我新建日程" });
  await applyPlan(store, proposal.pendingPlan);
  const folder = await mkdtemp(join(tmpdir(), "aibro-local-agenda-"));
  try {
    const source = join(folder, "CalendarCheck.swift"), fixture = join(folder, "event.json"), binary = join(folder, "check");
    await writeFile(fixture, JSON.stringify(store.list("notes")[0]));
    await writeFile(source, `import Foundation
@main struct CalendarCheck {
 static func main() throws {
  let source = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
  let note = try AgendaWire.object(source)
  let id = note["id"] as! String
  let decoded = try AgendaWire.decode(source, id: "mobile:" + id)
  precondition(decoded.title == "打篮球")
  precondition(decoded.end.timeIntervalSince(decoded.start) == 3600)
  precondition(decoded.reminderMinutes == nil)
  let plan = AgendaWire.plan(events: [], receipts: [:], notes: [id: source])
  precondition(plan.warnings.isEmpty && plan.conflicts.isEmpty && plan.changes.count == 1)
  precondition(plan.changes[0].after.id == "mobile:" + id)
  precondition(AgendaWire.noteID(plan.changes[0].after) == id)
  let encoded = try AgendaWire.encode(decoded, noteID: id, previous: source)
  let roundTrip = try AgendaWire.decode(encoded, id: decoded.id)
  precondition(roundTrip == decoded)
  print("PASS mobile local agenda projection")
 }
}
`);
    const root = resolve("..");
    await run("xcrun", ["swiftc", join(root, "native/Sources/AIBro/AgendaCore.swift"), join(root, "native/Sources/AIBro/AgendaSync.swift"), source, "-o", binary]);
    const { stdout } = await run(binary, [fixture]);
    assert.match(stdout, /PASS mobile local agenda projection/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
