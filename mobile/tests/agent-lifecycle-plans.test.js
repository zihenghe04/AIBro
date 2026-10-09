import test from "node:test";
import assert from "node:assert/strict";
import { Store, MemoryAdapter, clone, addMessage } from "../src/store.js";
import { createAgentTools, applyPlan, validatePlan, agentToolDefinitions } from "../src/agent-tools.js";
import { reviewRemoval, removeRecord } from "../src/lifecycle.js";
import { agendaNote, readEvent } from "../src/agenda.js";

async function fixture() {
  const store = await new Store(new MemoryAdapter()).load();
  await store.put("conversations", { id: "chat", title: "合成审阅会话", projectId: null });
  await store.put("projects", { id: "p", name: "合成项目", status: "active", workspace: "科研" });
  await store.put("tasks", { id: "t", title: "原任务", status: "todo", priority: "medium", projectId: "p", workspace: "科研" });
  await store.put("notes", { id: "n", title: "原笔记", content: "保留原文", projectId: "p", workspace: "科研" });
  return store;
}
const toolsFor = (store, options = {}) => createAgentTools({ store, conversationID: "chat", ...options });
async function read(tools, kind, id, archived = false) {
  const output = await tools.execute("knowledge_read", { kind, id, archived });
  assert.equal(output.error, undefined, output.error);
  return output;
}
async function propose(tools, actions) {
  const output = await tools.execute("propose_changes", { actions });
  assert.equal(output.error, undefined, output.error);
  assert.equal(output.executed, false);
  return tools.pendingPlan();
}
async function persist(store, plan) {
  await addMessage(store, "chat", "assistant", "请审阅，尚未执行。", { pendingPlan: plan });
  return plan;
}
const remove = (kind, id) => ({ operation: "remove", kind, id });
const restore = (kind, id) => ({ operation: "restore", kind, id });
const createTask = (title, changes = {}) => ({ operation: "create", kind: "tasks", changes: { title, ...changes } });

test("removal requires a read; approval atomically creates recoverable trash and durable truthful receipts", async () => {
  const store = await fixture(), tools = toolsFor(store), original = store.get("notes", "n");
  assert.match((await tools.execute("propose_changes", { actions: [remove("notes", "n")] })).error, /knowledge_read/);
  await read(tools, "notes", "n");
  const before = clone(store.state), plan = await propose(tools, [remove("notes", "n")]);
  assert.deepEqual(store.state, before, "proposal must not mutate even memory state");
  assert.equal(plan.actions[0].lifecycleOperation, "trash");
  await persist(store, plan);
  const reopened = await new Store(store.adapter).load();
  const applied = await applyPlan(reopened, plan), receipt = applied.receipts[0];
  assert.equal(reopened.get("notes", "n"), null);
  assert.deepEqual(reopened.get("trash", receipt.recoveryKey.split(":")[1]).data.notes, [original]);
  assert.match(reopened.list("messages")[0].content, /已将「原笔记」移入回收站/);
  assert.equal(receipt.operation, "remove");
  assert.equal(receipt.lifecycleOperation, "trash");
  assert.deepEqual(await applyPlan(reopened, plan), applied, "retry after durable save is idempotent");
  const restoreTools = toolsFor(reopened);
  assert.equal((await restoreTools.execute("knowledge_read", { kind: "trash", id: receipt.recoveryKey.split(":")[1] })).error, undefined);
  const recovered = await read(restoreTools, "trash", receipt.recoveryKey.split(":")[1], true);
  assert.deepEqual(recovered.recovery.targets.map(({ kind, id }) => ({ kind, id })), [{ kind: "notes", id: "n" }]);
  const recoveryPlan = await persist(reopened, await propose(restoreTools, [restore("trash", receipt.recoveryKey.split(":")[1])]));
  const result = await applyPlan(reopened, recoveryPlan);
  assert.deepEqual(reopened.get("notes", "n"), original);
  assert.deepEqual(result.receipts[0].restored, [{ key: "notes:n", kind: "notes", id: "n", title: "原笔记" }]);
  assert.equal(reopened.list("trash").length, 0);
});

test("project removal is archive and keeps children; archived lookup and restoration use the same stable ID", async () => {
  const store = await fixture(), tools = toolsFor(store), children = clone([store.get("tasks", "t"), store.get("notes", "n")]);
  await read(tools, "projects", "p");
  const plan = await persist(store, await propose(tools, [remove("projects", "p")]));
  assert.equal(plan.actions[0].lifecycleOperation, "archive");
  assert.match(plan.actions[0].warnings.join(" "), /仅归档项目/);
  const result = await applyPlan(store, plan);
  assert.equal(result.receipts[0].recoveryKey, "projects:p");
  assert.deepEqual([store.get("tasks", "t"), store.get("notes", "n")], children);
  assert.equal(store.list("trash").length, 0);
  const recovery = toolsFor(store);
  assert.equal((await recovery.execute("workspace_list", { state: "active", kind: "tasks" })).total, 0);
  const list = await recovery.execute("workspace_list", { state: "recoverable" });
  assert.deepEqual(list.entries.map(({ key, lifecycleOperation }) => ({ key, lifecycleOperation })), [{ key: "projects:p", lifecycleOperation: "unarchive" }]);
  await read(recovery, "projects", "p", true);
  await applyPlan(store, await persist(store, await propose(recovery, [restore("projects", "p")])));
  assert.equal(store.get("projects", "p").archived, false);
  assert.equal((await recovery.execute("workspace_list", { kind: "tasks" })).entries[0].id, "t");
});

test("mixed removal and creation reject changed targets, new relations or conflicts without partial writes", async () => {
  for (const change of [
    store => store.put("projects", { ...store.get("projects", "p"), name: "人工作的新标题" }),
    store => store.put("tasks", { id: "new", title: "后来新增的子项", projectId: "p" }),
    store => store.tx(state => { state.records["projects:p"].conflict = { version: 9, data: { id: "p", name: "远端" } }; }),
  ]) {
    const store = await fixture(), tools = toolsFor(store);
    await read(tools, "projects", "p");
    const plan = await persist(store, await propose(tools, [createTask("整批应拒绝"), remove("projects", "p")]));
    await change(store);
    const before = clone(store.state);
    await assert.rejects(applyPlan(store, plan), /变化|修改|冲突/);
    assert.deepEqual(store.state, before);
  }
});

test("restore review detects replaced originals and original project changes; disk failure rolls back all targets and receipts", async () => {
  for (const change of [
    store => store.put("tasks", { id: "t", title: "同标识的新内容" }),
    store => store.put("projects", { ...store.get("projects", "p"), name: "归属项目后来改名" }),
    async store => { store.adapter.write = async () => { throw Error("synthetic disk full"); }; },
  ]) {
    const store = await fixture(), removed = await removeRecord(store, reviewRemoval(store, "tasks:t")), tools = toolsFor(store);
    await read(tools, "trash", removed.trashId, true);
    const plan = await persist(store, await propose(tools, [createTask("一起写入"), restore("trash", removed.trashId)]));
    await change(store);
    const before = clone(store.state);
    await assert.rejects(applyPlan(store, plan), /变化|disk full/);
    assert.deepEqual(store.state, before);
  }
});

test("one approval creates project and its task, note and agenda with validated stable references", async () => {
  const store = await fixture(), tools = toolsFor(store);
  const plan = await propose(tools, [
    { operation: "create", kind: "projects", ref: "research", changes: { name: "新科研项目", workspace: "科研" } },
    createTask("新项目任务", { projectRef: "research" }),
    { operation: "create", kind: "notes", changes: { title: "新项目笔记", content: "内容", projectRef: "research" } },
    { operation: "create", kind: "agenda", changes: { title: "新项目会议", projectRef: "research", start: "2030-01-03T08:00:00+08:00", end: "2030-01-03T09:00:00+08:00", timeZone: "Asia/Shanghai" } },
  ]);
  const projectID = plan.refMap.research.id;
  assert.equal(store.get("projects", projectID), null);
  assert.equal(plan.actions[0].targetId, projectID);
  assert.ok(plan.actions.slice(1).every(action => action.after.projectId === projectID && action.after.workspace === "科研"));
  assert.ok(plan.actions.every(action => !Object.hasOwn(action.after, "projectRef")));
  const applied = await applyPlan(store, await persist(store, plan));
  assert.equal(applied.receipts.length, 4);
  assert.equal(store.list("tasks").find(item => item.title === "新项目任务").projectId, projectID);
  const event = readEvent(store.list("notes").find(item => item.kind === "日程"));
  assert.equal(event.projectId, projectID);
  assert.equal(applied.receipts[0].ref, "research");
});

test("project reference stays stable across tool calls; forward, duplicate and out-of-project references leave prior plan intact", async () => {
  const store = await fixture(), tools = toolsFor(store);
  const first = await propose(tools, [{ operation: "create", kind: "projects", ref: "pnew", changes: { name: "批次项目" } }]);
  const firstID = first.refMap.pnew.id;
  for (const actions of [
    [createTask("未定义引用", { projectRef: "later" }), { operation: "create", kind: "projects", ref: "later", changes: { name: "后建项目" } }],
    [{ operation: "create", kind: "projects", ref: "pnew", changes: { name: "重复引用" } }],
    [createTask("双重归属", { projectRef: "pnew", projectId: "p" })],
  ]) {
    assert.ok((await tools.execute("propose_changes", { actions })).error);
    assert.deepEqual(tools.pendingPlan(), first);
  }
  const combined = await propose(tools, [createTask("第二次调用的子项", { projectRef: "pnew" })]);
  assert.equal(combined.refMap.pnew.id, firstID);
  assert.equal(combined.actions[1].after.projectId, firstID);
  await applyPlan(store, await persist(store, combined));
  await store.put("conversations", { id: "chat", title: "固定项目会话", projectId: "p" });
  const scoped = toolsFor(store, { projectID: "p" });
  assert.match((await scoped.execute("propose_changes", { actions: [{ operation: "create", kind: "projects", ref: "outside", changes: { name: "范围外项目" } }] })).error, /当前项目/);
  assert.equal(scoped.pendingPlan(), null);
});

test("apply replays project overlay: ID collisions, changed ref maps and altered immutable payloads cannot commit", async () => {
  for (const mutate of [
    async (store, plan) => { await store.put("projects", { id: plan.actions[0].targetId, name: "占用该标识" }); },
    async (_store, plan) => { plan.refMap.work.id = "p"; },
    async (_store, plan) => { plan.actions[1].after.projectId = "p"; },
    async (_store, plan) => { plan.actions.reverse(); },
  ]) {
    const store = await fixture(), tools = toolsFor(store);
    const plan = await propose(tools, [{ operation: "create", kind: "projects", ref: "work", changes: { name: "审阅项目" } }, createTask("子项", { projectRef: "work" })]);
    await mutate(store, plan);
    await persist(store, plan);
    const before = clone(store.state);
    await assert.rejects(applyPlan(store, plan), /变化|修改|不一致|先创建/);
    assert.deepEqual(store.state, before);
  }
});

test("lifecycle payload tampering and conflicted approval message reject without losing originals", async () => {
  for (const mutate of [
    plan => { plan.actions[0].warnings = ["不真实的删除说明"]; },
    plan => { plan.actions[0].lifecycleReview.before.data.content = "伪造正文"; },
    plan => { plan.actions[0].after = { id: "n", title: "不应出现" }; },
    plan => { plan.actions[0].changes = { title: "偷偷改名" }; },
    plan => { delete plan.actions[0].trashId; },
  ]) {
    const store = await fixture(), tools = toolsFor(store);
    await read(tools, "notes", "n");
    const plan = await propose(tools, [remove("notes", "n")]);
    mutate(plan); await persist(store, plan);
    const before = clone(store.state);
    await assert.rejects(applyPlan(store, plan), /不一致|变化/);
    assert.deepEqual(store.state, before);
  }
  const store = await fixture(), tools = toolsFor(store);
  await read(tools, "notes", "n");
  const plan = await persist(store, await propose(tools, [remove("notes", "n")]));
  await store.tx(state => { Object.values(state.records).find(record => record.data?.pendingPlan).conflict = { version: 2 }; });
  assert.throws(() => validatePlan(store, plan), /审阅消息/);
  assert.ok(store.get("notes", "n"));
});

test("ten-content limit counts restored bundle members, and restore collisions stay atomic", async () => {
  const store = await fixture();
  await store.put("trash", { id: "bundle", title: "十一条桌面合成任务", deletedAt: 1,
    data: { tasks: Array.from({ length: 11 }, (_, i) => ({ id: "bundle_" + i, title: "任务" + i })) } });
  const tools = toolsFor(store);
  await read(tools, "trash", "bundle", true);
  assert.match((await tools.execute("propose_changes", { actions: [restore("trash", "bundle")] })).error, /最多 10/);
  assert.equal(tools.pendingPlan(), null);
  const bounded = await propose(tools, Array.from({ length: 10 }, (_, i) => createTask("有限任务" + i)));
  assert.match((await tools.execute("propose_changes", { actions: [createTask("第十一项")] })).error, /最多 10/);
  assert.deepEqual(tools.pendingPlan(), bounded);
});

test("recoverable directory excludes private and out-of-scope originals and keeps explicit project filters", async () => {
  const store = await fixture(), removed = await removeRecord(store, reviewRemoval(store, "notes:n"));
  for (const [id, data] of [["private", { id: "hidden", title: "private-secret", private: true }], ["elsewhere", { id: "foreign", title: "other-project-secret", projectId: "q" }]])
    await store.put("trash", { id, title: data.title, deletedAt: 1, data: { notes: [data] } });
  const tools = toolsFor(store, { projectID: "p" });
  const list = await tools.execute("workspace_list", { state: "trash", projectId: "p" });
  assert.deepEqual(list.entries.map(entry => entry.id), [removed.trashId]);
  assert.doesNotMatch(JSON.stringify(list), /private-secret|other-project-secret/);
  assert.match((await tools.execute("knowledge_read", { kind: "trash", id: "private", archived: true })).error, /范围/);
  assert.match((await tools.execute("knowledge_read", { kind: "trash", id: "elsewhere", archived: true })).error, /范围/);
  const notes = await tools.execute("workspace_list", { state: "recoverable", kind: "notes", projectId: "p" });
  assert.equal(notes.total, 1);
  assert.equal(notes.entries[0].kind, "trash");
  assert.deepEqual(notes.entries[0].recoveryTargets, [{ key: "notes:n", kind: "notes", id: "n", title: "原笔记",
    projectId: "p", workspace: "科研", restoreProjectId: "p", source: "trash-snapshot" }]);
});

test("unarchive then create child works in one overlay while two restores of overlapping originals are refused", async () => {
  const store = await fixture();
  await removeRecord(store, reviewRemoval(store, "projects:p"));
  const tools = toolsFor(store);
  await read(tools, "projects", "p", true);
  const plan = await propose(tools, [restore("projects", "p"), createTask("恢复后的子项", { projectId: "p" })]);
  await applyPlan(store, await persist(store, plan));
  assert.equal(store.get("projects", "p").archived, false);
  assert.equal(store.list("tasks").find(task => task.title === "恢复后的子项").workspace, "科研");
  for (const id of ["one", "two"]) await store.put("trash", { id, title: "重叠回收包", deletedAt: 1,
    data: { notes: [{ id: "overlap", title: "相同原文", content: "内容" }] } });
  const recovery = toolsFor(store);
  await read(recovery, "trash", "one", true); await read(recovery, "trash", "two", true);
  assert.match((await recovery.execute("propose_changes", { actions: [restore("trash", "one"), restore("trash", "two")] })).error, /重复目标/);
  assert.equal(recovery.pendingPlan(), null);
  assert.equal(store.get("notes", "overlap"), null);
});

test("day calendar removal and recovery identify agenda instead of generic notes and preserve series metadata", async () => {
  const store = await fixture(), start = Date.parse("2030-01-03T08:00:00+08:00");
  await store.put("notes", agendaNote({ title: "恢复重复课", start, end: start + 3600000, timeZone: "Asia/Shanghai",
    recurrence: { frequency: "weekly", interval: 1, weekdays: [4] }, completed: [start] }, { id: "calendar" }));
  const original = store.get("notes", "calendar"), tools = toolsFor(store);
  await read(tools, "agenda", "calendar");
  const removed = await applyPlan(store, await persist(store, await propose(tools, [remove("agenda", "calendar")])));
  const recovery = toolsFor(store), listing = await recovery.execute("workspace_list", { kind: "agenda", state: "trash" });
  assert.equal(listing.entries.length, 1);
  assert.equal(listing.entries[0].recoveryTargets[0].kind, "agenda");
  const trashID = removed.receipts[0].recoveryKey.split(":")[1];
  assert.equal((await read(recovery, "trash", trashID, true)).recovery.targets[0].kind, "agenda");
  const restored = await applyPlan(store, await persist(store, await propose(recovery, [restore("trash", trashID)])));
  assert.equal(restored.receipts[0].restored[0].kind, "agenda");
  assert.deepEqual(store.get("notes", "calendar"), original);
});

test("directory pagination is stable and task status, date and project filters return structured fields", async () => {
  const store = await fixture();
  for (let i = 0; i < 23; i++) await store.put("tasks", { id: "paged_" + String(i).padStart(2, "0"), title: "分页任务" + i, status: i % 2 ? "done" : "todo", dueAt: "2030-01-03", projectId: "p", updatedAt: i });
  const tools = toolsFor(store), first = await tools.execute("workspace_list", { kind: "tasks", query: "分页任务", limit: 20 });
  const second = await tools.execute("workspace_list", { kind: "tasks", query: "分页任务", offset: first.nextOffset });
  assert.equal(first.total, 23); assert.equal(first.entries.length, 20);
  assert.equal(second.entries.length, 3); assert.equal(second.nextOffset, null);
  assert.equal(new Set([...first.entries, ...second.entries].map(entry => entry.key)).size, 23);
  const filtered = await tools.execute("workspace_list", { kind: "tasks", projectId: "p", status: "todo", dateFrom: "2030-01-03", dateTo: "2030-01-04" });
  assert.equal(filtered.total, 12);
  assert.ok(filtered.entries.every(entry => entry.status === "todo" && entry.dueAt === "2030-01-03"));
  assert.equal((await tools.execute("workspace_list", { kind: "tasks", dateTo: "2030-01-03" })).total, 0);
  assert.equal((await tools.execute("workspace_list", { kind: "projects", status: "active" })).entries[0].status, "active");
});

test("agenda directory expands actual recurring dates and Agent edits require explicit whole-series scope", async () => {
  const store = await fixture(), tools = toolsFor(store), start = Date.parse("2030-01-03T08:00:00+08:00");
  const plan = await propose(tools, [{ operation: "create", kind: "agenda", changes: { title: "合成重复课", start, end: start + 3600000, timeZone: "Asia/Shanghai", projectId: "p", recurrence: { frequency: "daily", interval: 1, weekdays: [], count: 4 } } }]);
  await applyPlan(store, await persist(store, plan));
  const eventID = plan.actions[0].targetId, saved = store.get("notes", eventID), event = readEvent(saved);
  await store.put("notes", agendaNote({ ...event, excluded: [start + 86400000], completed: [start + 2 * 86400000] }, saved));
  const editing = toolsFor(store), listing = await editing.execute("workspace_list", { kind: "agenda", dateFrom: "2030-01-03T00:00:00+08:00", dateTo: "2030-01-07T00:00:00+08:00" });
  assert.equal(listing.total, 3);
  assert.ok(listing.entries.every(entry => entry.id === eventID));
  assert.equal(new Set(listing.entries.map(entry => entry.occurrenceID)).size, 3);
  assert.ok(!listing.entries.some(entry => entry.start === start + 86400000));
  await read(editing, "agenda", eventID);
  const action = { operation: "update", kind: "agenda", id: eventID, changes: { start: start + 3600000, end: start + 7200000 } };
  assert.match((await editing.execute("propose_changes", { actions: [action] })).error, /editScope/);
  action.changes.editScope = "series";
  const update = await persist(store, await propose(editing, [action]));
  await applyPlan(store, update);
  const after = readEvent(store.get("notes", eventID));
  assert.deepEqual(after.excluded, [start + 86400000 + 3600000]);
  assert.deepEqual(after.completed, [start + 2 * 86400000 + 3600000]);
  assert.equal(Object.hasOwn(after, "editScope"), false);
  assert.match((await editing.execute("workspace_list", { kind: "agenda", dateFrom: "2030-01-01", dateTo: "2032-01-01" })).error, /最多一年/);
});

test("tool schema exposes recovery, paginated retrieval and one-plan project refs", () => {
  const schemas = Object.fromEntries(agentToolDefinitions.map(tool => [tool.function.name, tool.function]));
  assert.deepEqual(schemas.workspace_list.parameters.properties.state.enum, ["active", "archived", "trash", "recoverable"]);
  assert.equal(schemas.knowledge_read.parameters.properties.archived.type, "boolean");
  assert.ok(schemas.knowledge_read.parameters.properties.kind.enum.includes("trash"));
  const action = schemas.propose_changes.parameters.properties.actions.items;
  assert.deepEqual(action.properties.operation.enum, ["create", "update", "remove", "restore"]);
  assert.equal(action.properties.ref.type, "string");
  assert.match(schemas.propose_changes.description, /projectRef/);
  assert.match(schemas.propose_changes.description, /editScope:series/);
});
