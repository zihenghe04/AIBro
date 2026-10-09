import test from "node:test";
import assert from "node:assert/strict";
import { Store, MemoryAdapter, addMessage } from "../src/store.js";
import { createAgentTools, applyPlan, rejectPlan } from "../src/agent-tools.js";
import { conversationMessage, conversationResults, inspectResultTarget } from "../src/conversation-results.js";
import { acknowledgeGroup } from "../src/sync-groups.js";

async function fixture() {
  const store = await new Store(new MemoryAdapter()).load();
  for (const id of ["a", "b"]) await store.put("conversations", { id, title: `合成会话${id}`, projectId: null });
  return store;
}
async function proposal(store, actions, reads = [], cid = "a") {
  const tools = createAgentTools({ store, conversationID: cid });
  for (const read of reads) assert.equal((await tools.execute("knowledge_read", read)).error, undefined);
  const output = await tools.execute("propose_changes", { actions });
  assert.equal(output.error, undefined, output.error);
  const plan = tools.pendingPlan();
  const messageID = await addMessage(store, cid, "assistant", "待审阅", { status: "completed", pendingPlan: plan });
  return { plan, message: () => conversationMessage(store, { conversationID: cid, messageID }) };
}
async function acknowledgeAll(store) {
  await store.tx(state => {
    for (const group of Object.values(state.syncGroups || {})) acknowledgeGroup(state, group.groupId, {
      version: 1, groupId: group.groupId, status: "accepted", cursor: state.cursor + group.payload.operations.length,
      conflicts: [], accepted: group.payload.operations.map(op => ({ opId: op.opId, entityType: op.entityType, entityId: op.entityId, version: op.baseVersion + 1 })),
    });
  });
}

test("only durable applied receipts expose exact project/task/agenda targets, including after reload", async () => {
  const store = await fixture();
  const { plan, message } = await proposal(store, [
    { operation: "create", kind: "projects", ref: "project", changes: { name: "合成计划" } },
    { operation: "create", kind: "tasks", changes: { title: "合成任务", projectRef: "project" } },
    { operation: "create", kind: "agenda", changes: { title: "合成日程", projectRef: "project", start: "2030-01-02T15:00:00+08:00", end: "2030-01-02T16:00:00+08:00", timeZone: "Asia/Shanghai" } },
  ]);
  assert.deepEqual(conversationResults(store, message()).items, []);
  assert.equal(conversationResults(store, message()).state, "pending");
  const applied = await applyPlan(store, plan);
  const reopened = await new Store(store.adapter).load(), model = conversationResults(reopened, message());
  assert.equal(model.state, "applied");
  assert.deepEqual(model.items.map(item => item.target), applied.receipts.map(({ kind, id }) => ({ kind, id })));
  assert.match(model.items[2].detail, /15:00.*16:00.*Asia\/Shanghai/);
  assert.ok(model.items.every(item => inspectResultTarget(reopened, item.target).state === "available"));
  const task = model.items[1].target;
  await reopened.put("tasks", { ...reopened.get("tasks", task.id), title: "后来改名" });
  assert.match(conversationResults(reopened, message()).items[1].detail, /当前名称：后来改名/);
});

test("message lookup is scoped to conversation and wire key even with duplicate legacy IDs", async () => {
  const store = await fixture();
  for (const cid of ["a", "b"]) await addMessage(store, cid, "assistant", `正文${cid}`, { id: "legacy_duplicate" });
  const a = conversationMessage(store, { conversationID: "a", messageID: "legacy_duplicate" });
  const b = conversationMessage(store, { conversationID: "b", messageID: "legacy_duplicate" });
  assert.equal(a.content, "正文a"); assert.equal(b.content, "正文b");
  assert.notEqual(a._key, b._key);
  assert.equal(conversationMessage(store, { conversationID: "b", messageID: "legacy_duplicate", key: a._key }), null);
  assert.equal(conversationMessage(store, { messageID: "legacy_duplicate" }), null);
});

test("rejected, invalidated, cancelled and cross-conversation plans never advertise executable results", async () => {
  const store = await fixture();
  const { plan, message } = await proposal(store, [{ operation: "create", kind: "tasks", changes: { title: "不得创建" } }]);
  await rejectPlan(store, plan);
  assert.equal(conversationResults(store, message()).state, "rejected");
  assert.deepEqual(conversationResults(store, message()).items, []);
  for (const status of ["invalidated", "pending"]) {
    await store.tx(s => { const m = s.records[message()._key].data; m.pendingPlan.status = status; m.status = "cancelled"; });
    assert.equal(conversationResults(store, message()).state, "invalidated");
  }
  await store.tx(s => { s.records[message()._key].data.pendingPlan.conversationID = "b"; });
  assert.equal(conversationResults(store, message()), null);
  assert.equal(store.list("tasks").length, 0);
});

test("trash and archive receipts lead only to recovery review, restored receipts expose original IDs", async () => {
  const store = await fixture();
  await store.put("projects", { id: "p", name: "保留子项的项目" });
  await store.put("tasks", { id: "t", title: "可恢复任务", projectId: "p" });
  const removed = await proposal(store, [
    { operation: "remove", kind: "tasks", id: "t" }, { operation: "remove", kind: "projects", id: "p" },
  ], [{ kind: "tasks", id: "t" }, { kind: "projects", id: "p" }]);
  const applied = await applyPlan(store, removed.plan);
  const model = conversationResults(store, removed.message());
  assert.deepEqual(model.items.map(item => item.target), [null, null]);
  assert.deepEqual(model.items.map(item => item.recoveryKey), applied.receipts.map(r => r.recoveryKey));
  assert.deepEqual(model.items.map(item => item.action), ["已移入回收站", "已归档"]);
  const trashID = applied.receipts[0].recoveryKey.split(":")[1];
  await acknowledgeAll(store); // The next decision follows a synthetic whole-group acknowledgement.
  const restored = await proposal(store, [
    { operation: "restore", kind: "projects", id: "p" }, { operation: "restore", kind: "trash", id: trashID },
  ], [{ kind: "projects", id: "p", archived: true }, { kind: "trash", id: trashID, archived: true }]);
  await applyPlan(store, restored.plan);
  assert.deepEqual(conversationResults(store, restored.message()).items.map(item => item.target), [{ kind: "projects", id: "p" }, { kind: "tasks", id: "t" }]);
  assert.equal(conversationResults(store, removed.message()).items[0].detail, "当前已恢复");
  assert.equal(store.get("tasks", "t").projectId, "p");
});

test("receipt status distinguishes local queued/blocked groups and ignores an unrelated conversation's group", async () => {
  const store = await fixture();
  const first = await proposal(store, [{ operation: "create", kind: "tasks", changes: { title: "本机已保存" } }]);
  await applyPlan(store, first.plan);
  assert.equal(conversationResults(store, first.message()).detail, "已保存到本机，等待整组同步。");
  await store.tx(state => {
    const group = Object.values(state.syncGroups)[0];
    acknowledgeGroup(state, group.groupId, { version: 1, groupId: group.groupId, status: "conflict", cursor: 1, accepted: [], conflicts: [{ synthetic: true }] });
  });
  assert.match(conversationResults(store, first.message()).detail, /同步有冲突/);
  await acknowledgeAll(store);
  const second = await proposal(store, [{ operation: "create", kind: "tasks", changes: { title: "另一个会话的结果" } }], [], "b");
  await applyPlan(store, second.plan);
  assert.match(conversationResults(store, second.message()).detail, /等待整组同步/);
  assert.equal(conversationResults(store, first.message()).detail, "已保存到本机；下方入口打开当前内容。");
});

test("removed or conflicted current targets never become blank new-record editors", async () => {
  const store = await fixture();
  const { plan, message } = await proposal(store, [{ operation: "create", kind: "tasks", changes: { title: "稍后不存在" } }]);
  const receipt = (await applyPlan(store, plan)).receipts[0];
  const key = `tasks:${receipt.id}`;
  await store.tx(s => { s.records[key].conflict = { data: { id: receipt.id, title: "别处修改" }, deleted: false }; });
  let item = conversationResults(store, message()).items[0];
  assert.equal(item.target, null); assert.match(item.detail, /冲突/); assert.equal(item.buttonLabel, null);
  await store.tx(s => { delete s.records[key].conflict; s.records[key].deleted = true; s.records[key].data = null; });
  item = conversationResults(store, message()).items[0];
  assert.equal(item.target, null); assert.match(item.detail, /已删除/);
  assert.equal(inspectResultTarget(store, { kind: "tasks", id: receipt.id }).state, "missing");
});
