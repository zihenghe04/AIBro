import test from "node:test";
import assert from "node:assert/strict";
import { Store, MemoryAdapter, addMessage, clone } from "../src/store.js";
import { createAgentTools, applyPlan, agentToolDefinitions } from "../src/agent-tools.js";
import { reviewRemoval, removeRecord } from "../src/lifecycle.js";
import { agendaNote, readEvent } from "../src/agenda.js";

async function fixture() {
  const store = await new Store(new MemoryAdapter()).load();
  await store.put("conversations", { id: "chat", title: "合成恢复审查", projectId: null });
  await store.put("projects", { id: "p", name: "原科研项目", workspace: "科研" });
  await store.put("tasks", { id: "task", title: "原任务", description: "实际任务说明", status: "done", projectId: "p", workspace: "科研" });
  await store.put("notes", { id: "note", title: "原笔记", content: "真实存储正文", projectId: "p", workspace: "科研" });
  await store.put("notes", agendaNote({ title: "原日程", projectId: "p", workspace: "科研", start: Date.parse("2032-10-10T17:00:00+08:00"),
    end: Date.parse("2032-10-10T18:00:00+08:00"), timeZone: "Asia/Shanghai", details: "日程原备注", location: "合成会议室" }, { id: "event" }));
  const originals = Object.fromEntries(["tasks:task", "notes:note", "notes:event"].map(key => [key, clone(store.state.records[key].data)]));
  const removed = [];
  for (const key of Object.keys(originals)) removed.push(await removeRecord(store, reviewRemoval(store, key)));
  return { store, originals, removed };
}
const toolsFor = (store, scope = {}) => createAgentTools({ store, conversationID: "chat", ...scope });
async function call(tools, descriptor) {
  assert.equal(descriptor.tool, "knowledge_read");
  const result = await tools.execute(descriptor.tool, descriptor.arguments);
  assert.equal(result.error, undefined, result.error);
  return result;
}

test("recorded three-target recovery path has complete executable read descriptors and no empty or fabricated ownership", async () => {
  const { store, originals } = await fixture(), tools = toolsFor(store), before = clone(store.state);
  const directory = await tools.execute("workspace_list", { state: "recoverable", limit: 50 });
  assert.equal(directory.total, 3);
  const restoredKinds = [], actions = [];
  for (const entry of directory.entries) {
    assert.deepEqual(entry.read, { tool: "knowledge_read", arguments: { kind: "trash", id: entry.id, archived: true } });
    assert.equal(Object.hasOwn(entry, "projectId"), false, "container must not claim no project");
    assert.equal(Object.hasOwn(entry, "workspace"), false, "container must not invent the 日常 workspace");
    assert.equal(entry.recoveryTargets[0].projectId, "p");
    assert.equal(entry.recoveryTargets[0].workspace, "科研");
    const result = await call(tools, entry.read);
    assert.equal(result.contentSource, "stored-recovery-snapshot");
    assert.ok(result.totalCharacters > 0);
    assert.equal(result.nextRead, null);
    assert.equal(result.originalRead, false, "source file access is not claimed");
    assert.match(result.recovery.note, /原记录标识|原记录|原 ID/);
    assert.match(result.content, /"projectId": "p"/);
    assert.match(result.content, /"workspace": "科研"/);
    const target = result.recovery.targets[0];
    restoredKinds.push(target.kind);
    if (target.kind === "notes") assert.match(result.content, /真实存储正文/);
    if (target.kind === "tasks") assert.match(result.content, /实际任务说明/);
    if (target.kind === "agenda") assert.match(result.content, /日程原备注|合成会议室/);
    assert.deepEqual(result.recovery.restoreAction, { operation: "restore", kind: "trash", id: entry.id });
    actions.push(result.recovery.restoreAction);
  }
  assert.deepEqual(restoredKinds.sort(), ["agenda", "notes", "tasks"]);
  assert.deepEqual(store.state, before, "directory and snapshot reads never mutate or restore");
  const proposal = await tools.execute("propose_changes", { actions });
  assert.equal(proposal.error, undefined, proposal.error); assert.equal(proposal.executed, false);
  assert.deepEqual(store.state, before);
  const plan = tools.pendingPlan(); await addMessage(store, "chat", "assistant", "等待审阅", { pendingPlan: plan });
  const result = await applyPlan(store, plan);
  assert.equal(result.receipts.length, 3);
  for (const [key, original] of Object.entries(originals)) assert.deepEqual(store.state.records[key].data, original);
  assert.equal(readEvent(store.get("notes", "event")).projectId, "p");
});

test("the exact first invalid reads now select trash explicitly without a redundant flag, but archived:false is never ignored", async () => {
  const { store, removed } = await fixture(), tools = toolsFor(store);
  for (const item of removed) {
    const read = await tools.execute("knowledge_read", { kind: "trash", id: item.trashId });
    assert.equal(read.error, undefined, read.error);
    assert.equal(read.recovery.canRestore, true);
    assert.match((await tools.execute("knowledge_read", { kind: "trash", id: item.trashId, archived: false })).error, /冲突/);
  }
  const originalID = await tools.execute("knowledge_read", { kind: "tasks", id: "task", archived: true });
  assert.match(originalID.error, /不存在或不在/);
  assert.equal(store.get("tasks", "task"), null, "read never revives a tombstone or substitutes a different ID");
});

test("ordinary archived records still require explicit archived selection and return a restore action for their own ID", async () => {
  const { store } = await fixture(); await removeRecord(store, reviewRemoval(store, "projects:p"));
  const tools = toolsFor(store);
  assert.match((await tools.execute("knowledge_read", { kind: "projects", id: "p" })).error, /范围/);
  assert.match((await tools.execute("knowledge_read", { kind: "projects", id: "p", archived: false })).error, /范围/);
  const list = await tools.execute("workspace_list", { kind: "projects", state: "archived" });
  assert.deepEqual(list.entries[0].read.arguments, { kind: "projects", id: "p", archived: true });
  const read = await call(tools, list.entries[0].read);
  assert.deepEqual(read.recovery.restoreAction, { operation: "restore", kind: "projects", id: "p" });
  assert.equal(read.recovery.targets[0].source, "archived-record");
  assert.equal(store.get("projects", "p").archived, true);
});

test("recovery body and nested business fields use a whitelist, never raw credentials or private history", async () => {
  const { store } = await fixture();
  await store.put("trash", { id: "white", title: "白名单回收包", deletedAt: { password: "CONTAINER_SECRET" }, updatedAt: { token: "CONTAINER_SECRET" },
    apiKey: "CONTAINER_SECRET", data: {
      tasks: [{ id: "safe_task", title: "可读任务", projectId: "p", workspace: "科研", description: "当前说明", status: "todo",
        apiKey: "TASK_SECRET", rawHeaders: { authorization: "TASK_SECRET" }, revisionHistory: [{ description: "PRIVATE_HISTORY" }],
        checklist: [{ text: "当前清单", done: true, password: "CHECKLIST_SECRET", history: "PRIVATE_HISTORY" }] }],
      notes: [{ id: "safe_note", title: "可读笔记", content: "当前正文", projectId: "p", workspace: "科研",
        credential: "NOTE_SECRET", revisionHistory: [{ content: "PRIVATE_HISTORY" }], privateMetadata: { source: "PRIVATE_HISTORY" } },
        agendaNote({ title: "可读日程", start: 1980000000000, end: 1980003600000, details: "当前日程备注",
          recurrence: { frequency: "weekly", interval: 1, weekdays: [1], credential: "RECURRENCE_SECRET" },
          ics: "ICS_PRIVATE_METADATA", revisionHistory: "PRIVATE_HISTORY" }, { id: "safe_event" })],
      links: [{ id: "link", sourceId: "safe_note", targetId: "safe_task", token: "LINK_SECRET", description: "LINK_SECRET" }],
      attachments: [{ id: "attachment", name: "附件标题", authorization: "ATTACHMENT_SECRET", content: "ATTACHMENT_SECRET" }],
    } });
  const tools = toolsFor(store), directory = await tools.execute("workspace_list", { state: "trash" });
  const read = await tools.execute("knowledge_read", { kind: "trash", id: "white" });
  assert.equal(read.error, undefined, read.error);
  assert.match(read.content, /当前说明/); assert.match(read.content, /当前清单/); assert.match(read.content, /当前正文/);
  assert.match(read.content, /当前日程备注/); assert.match(read.content, /"frequency": "weekly"/);
  assert.doesNotMatch(JSON.stringify({ directory, read }), /CONTAINER_SECRET|TASK_SECRET|CHECKLIST_SECRET|NOTE_SECRET|LINK_SECRET|ATTACHMENT_SECRET|RECURRENCE_SECRET|ICS_PRIVATE_METADATA|PRIVATE_HISTORY|rawHeaders|revisionHistory|privateMetadata/);
});

test("long recovery snapshots page through the same container, preserving full permitted text without expanding record scope", async () => {
  const { store } = await fixture(), content = "合成正文段落。".repeat(4000) + "FINAL_RECOVERY_PARAGRAPH";
  await store.put("trash", { id: "long", title: "长篇快照", deletedAt: 1,
    data: { notes: [{ id: "original_long", title: "长笔记", content, projectId: "p" }] } });
  const tools = toolsFor(store, { projectID: "p", contextKeys: ["notes:original_long"] });
  let descriptor = { tool: "knowledge_read", arguments: { kind: "trash", id: "long", limit: 12000 } }, combined = "", previous = -1;
  while (descriptor) {
    const result = await call(tools, descriptor);
    assert.ok(result.offset > previous); previous = result.offset;
    assert.equal(result.id, "long"); assert.equal(result.kind, "trash");
    assert.ok(result.content.length <= 12000); combined += result.content;
    if (result.nextRead) assert.deepEqual(result.nextRead.arguments, { kind: "trash", id: "long", archived: true, offset: result.nextOffset, limit: 12000 });
    descriptor = result.nextRead;
  }
  assert.ok(combined.includes(content));
  assert.match(combined, /"workspace": null/, "missing workspace remains unknown instead of fabricated 日常");
  assert.equal(store.get("notes", "original_long"), null);
});

test("mixed private, foreign-project or unselected members deny the entire package before emitting snapshots or descriptors", async () => {
  const { store } = await fixture();
  await store.put("projects", { id: "q", name: "范围外项目" });
  const safe = { id: "selected", title: "已选笔记", projectId: "p", content: "SCOPE_SAFE" };
  for (const [id, blocked] of [
    ["private", { id: "secret", title: "PRIVATE_TITLE", content: "PRIVATE_BODY", projectId: "p", private: true }],
    ["foreign", { id: "foreign", title: "FOREIGN_TITLE", content: "FOREIGN_BODY", projectId: "q" }],
    ["unselected", { id: "unselected", title: "UNSELECTED_TITLE", content: "UNSELECTED_BODY", projectId: "p" }],
  ]) await store.put("trash", { id, title: blocked.title, deletedAt: 1, data: { notes: [safe, blocked] } });
  const tools = toolsFor(store, { projectID: "p", contextKeys: ["notes:selected"] });
  const directory = await tools.execute("workspace_list", { state: "trash" });
  assert.ok(directory.entries.every(entry => !["private", "foreign", "unselected"].includes(entry.id)));
  assert.equal(directory.total, 1, "the in-scope task stays readable under the existing scope rules");
  for (const id of ["private", "foreign", "unselected"]) {
    const result = await tools.execute("knowledge_read", { kind: "trash", id });
    assert.match(result.error, /范围/);
    assert.equal(result.read, undefined); assert.equal(result.recovery, undefined); assert.equal(result.content, undefined);
  }
  assert.doesNotMatch(JSON.stringify(directory), /PRIVATE_|FOREIGN_|UNSELECTED_|SCOPE_SAFE/);
});

test("listing is not a capability grant: private source conversations and ownership changes are rechecked on read", async () => {
  const { store, removed } = await fixture(), tools = toolsFor(store, { projectID: "p" });
  const directory = await tools.execute("workspace_list", { state: "trash" });
  assert.equal(directory.total, 3);
  const descriptor = directory.entries.find(entry => entry.id === removed[0].trashId).read;
  await store.tx(state => { state.records[removed[0].recoveryKey].data.data.tasks[0].projectId = "q"; });
  assert.match((await tools.execute(descriptor.tool, descriptor.arguments)).error, /范围/);
  await store.put("conversations", { id: "private_owner", title: "私密会话", private: true });
  await store.tx(state => { state.records[removed[1].recoveryKey].data.data.notes[0].sourceConversationId = "private_owner"; });
  assert.match((await tools.execute("knowledge_read", { kind: "trash", id: removed[1].trashId })).error, /范围/);
});

test("snapshot ownership distinguishes original project from a missing-project restoration and keeps CAS protection", async () => {
  const { store, removed } = await fixture(); await store.remove("projects", "p");
  const tools = toolsFor(store), read = await tools.execute("knowledge_read", { kind: "trash", id: removed[0].trashId });
  assert.equal(read.recovery.targets[0].projectId, "p");
  assert.equal(read.recovery.targets[0].restoreProjectId, null);
  assert.match(read.recovery.warnings.join(" "), /原项目已不存在/);
  assert.match(read.content, /"projectId": "p"/);
  const proposal = await tools.execute("propose_changes", { actions: [read.recovery.restoreAction] });
  assert.equal(proposal.error, undefined);
  const plan = tools.pendingPlan(); await addMessage(store, "chat", "assistant", "请审阅", { pendingPlan: plan });
  await store.put("projects", { id: "p", name: "此后恢复的项目" });
  const before = clone(store.state);
  await assert.rejects(applyPlan(store, plan), /变化/);
  assert.deepEqual(store.state, before);
});

test("unrestorable complex bundles do not advertise an executable restore action", async () => {
  const { store } = await fixture();
  await store.put("trash", { id: "complex", title: "复杂项目回收包", deletedAt: 1,
    data: { projects: [{ id: "old_project", name: "旧项目", credential: "COMPLEX_SECRET" }], imports: [{ id: "file", title: "原件", content: "已提取文字", authentication: "COMPLEX_SECRET" }] } });
  const tools = toolsFor(store), result = await tools.execute("knowledge_read", { kind: "trash", id: "complex" });
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.recovery.canRestore, false); assert.match(result.recovery.reason, /桌面恢复/);
  assert.equal(result.recovery.restoreAction, undefined);
  assert.doesNotMatch(JSON.stringify(result), /COMPLEX_SECRET/);
});

test("tool schemas direct the model to exact container calls, paged snapshots and approved restore actions", () => {
  const definitions = Object.fromEntries(agentToolDefinitions.map(tool => [tool.function.name, tool.function.description]));
  assert.match(definitions.workspace_list, /read.arguments/);
  assert.match(definitions.knowledge_read, /省略 archived 也可读/);
  assert.match(definitions.knowledge_read, /nextRead/);
  assert.match(definitions.knowledge_read, /原 ID 恢复前不可当活动记录读取/);
  assert.match(definitions.propose_changes, /recovery.restoreAction/);
});
