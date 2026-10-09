import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { Store, MemoryAdapter, clone, addMessage, conflictReview } from "../src/store.js";
import { createAgentTools, applyPlan, rejectPlan } from "../src/agent-tools.js";
import { Sync } from "../src/sync.js";
import { acknowledgeGroup, applyPullPage, refreshGroupHeads, syncGroupReview, syncGroupSummaries, groupLocks } from "../src/sync-groups.js";

const workspace = () => new Store(new MemoryAdapter()).load();
const vault = () => { const map = new Map(); return { get: async key => map.get(key), set: async (key, value) => map.set(key, value), remove: async key => map.delete(key) }; };
const firstGroup = store => Object.values(store.state.syncGroups)[0];
const outgoing = (key, data, version = 0, deleted = false) => ({ opId: crypto.randomUUID(), entityType: key.split(":")[0], entityId: key.split(":")[1], baseVersion: version, deleted, data });
const remote = async (request, base, secrets, path, body) => request(base + path, { headers: { Authorization: "Bearer " + JSON.parse(await secrets.get("sync")).token }, ...(body ? { method: "POST", body } : {}) });
async function prepare(store, actions = [{ operation: "create", kind: "tasks", changes: { title: "合成待确认任务" } }]) {
  if (!store.get("conversations", "chat")) await store.put("conversations", { id: "chat", title: "合成会话", projectId: null });
  const agent = createAgentTools({ store, conversationID: "chat" });
  for (const action of actions) if (action.id) assert.equal((await agent.execute("knowledge_read", { kind: action.kind, id: action.id, archived: action.operation === "restore" })).error, undefined);
  const proposed = await agent.execute("propose_changes", { actions }); assert.equal(proposed.error, undefined, proposed.error);
  const plan = agent.pendingPlan(); await addMessage(store, "chat", "assistant", "合成待审批", { pendingPlan: plan, status: "completed" });
  return plan;
}
async function cloud(run) {
  const python = ["python3.13", "python3.12", "python3.11", "python3"].find(cmd => spawnSync(cmd, ["-c", 'import hashlib; assert hasattr(hashlib,"scrypt")']).status === 0);
  assert.ok(python);
  const child = spawn(python, ["tests/cloud-fixture.py"], { stdio: ["ignore", "pipe", "pipe"] });
  let errors = ""; child.stderr.on("data", chunk => errors += chunk);
  try {
    const [chunk] = await Promise.race([once(child.stdout, "data"), once(child, "exit").then(() => { throw Error(errors); })]);
    const base = "http://127.0.0.1:" + String(chunk).trim();
    const request = async (url, options = {}) => {
      assert.equal(new URL(url).hostname, "127.0.0.1");
      const response = await fetch(url, { method: options.method || "GET", headers: { "Content-Type": "application/json", ...options.headers }, body: options.body ? JSON.stringify(options.body) : undefined });
      const data = await response.json();
      if (!response.ok) throw Object.assign(Error(data.message || data.error), { status: response.status, code: data.error });
      return data;
    };
    await run({ base, request });
  } finally { child.kill("SIGTERM"); await once(child, "exit").catch(() => {}); }
}
function accept(store) {
  return store.tx(state => { for (const group of Object.values(state.syncGroups)) acknowledgeGroup(state, group.groupId, {
    version: 1, groupId: group.groupId, status: "accepted", conflicts: [], cursor: state.cursor + group.payload.operations.length,
    accepted: group.payload.operations.map(op => ({ opId: op.opId, entityType: op.entityType, entityId: op.entityId, version: op.baseVersion + 1 })),
  }); });
}

test("offline approval freezes the explicit transaction and unsent ownership dependencies durably", async () => {
  const store = await workspace();
  await store.put("projects", { id: "p", name: "必要项目" });
  await store.put("notes", { id: "unrelated", title: "独立脏记录", content: "不能混入审阅组" });
  const plan = await prepare(store, [{ operation: "create", kind: "tasks", changes: { title: "组内任务", projectId: "p" } }]);
  const applied = await applyPlan(store, plan), group = firstGroup(store);
  assert.equal(applied.syncGroupId, group.groupId); assert.equal(store.state.binding, null);
  assert.ok(group.writeKeys.includes("conversations:chat")); assert.ok(group.writeKeys.includes("projects:p"));
  assert.ok(group.writeKeys.includes("tasks:" + plan.actions[0].targetId)); assert.ok(group.writeKeys.includes(group.messageKey));
  assert.ok(!group.lockKeys.includes("notes:unrelated"));
  assert.deepEqual((await new Store(store.adapter).load()).state.syncGroups, store.state.syncGroups);
  const frozen = clone(group.payload);
  await store.put("tasks", { ...store.get("tasks", plan.actions[0].targetId), title: "审批后的独立编辑" });
  assert.deepEqual(firstGroup(store).payload, frozen);
  await accept(store);
  assert.equal(store.state.records["tasks:" + plan.actions[0].targetId].dirty, true);
  assert.equal(store.state.records[group.messageKey].dirty, false);
});

test("entity limits roll back a permitted multi-note approval before any durable write", async () => {
  const store = await workspace();
  const plan = await prepare(store, Array.from({ length: 8 }, (_, index) => ({ operation: "create", kind: "notes",
    changes: { title: "合成长笔记" + index, content: "合".repeat(100000) } })));
  const before = clone(store.state), durableBefore = await store.adapter.read();
  assert.ok(Buffer.byteLength(JSON.stringify(store.list("messages")[0])) > 4 * 1024 * 1024,
    "the full review exceeds one server entity even though its individual notes obey tool limits");
  let writes = 0;
  const write = store.adapter.write.bind(store.adapter);
  store.adapter.write = async value => { writes++; await write(value); };
  await assert.rejects(applyPlan(store, plan), /4 MiB.*尚未执行.*拆分/);
  assert.equal(writes, 0); assert.deepEqual(store.state, before);
  assert.deepEqual(await store.adapter.read(), durableBefore);
  assert.equal(store.list("notes").length, 0); assert.equal(syncGroupSummaries(store.state).length, 0);
  assert.equal(store.list("messages")[0].pendingPlan.status, "pending");
});

test("entity limits validate both frozen operations and read snapshots for size, depth and values", async () => {
  let tooDeep = "leaf";
  for (let depth = 0; depth < 32; depth++) tooDeep = { child: tooDeep };
  for (const [extra, message] of [
    [{ payload: "x".repeat(4 * 1024 * 1024) }, /4 MiB/],
    [{ payload: tooDeep }, /32 层/],
    [{ payload: Array(20000).fill(null) }, /20000 个字段值/],
  ]) for (const snapshot of ["operation", "read"]) {
    const store = await workspace();
    await store.put("projects", { id: "p", name: "合成依赖", ...(snapshot === "operation" ? extra : {}) });
    if (snapshot === "read") await store.tx(state => {
      const record = state.records["projects:p"];
      Object.assign(record, { version: 1, dirty: false, remote: { ...record.data, ...extra }, remoteDeleted: false });
    });
    const plan = await prepare(store, [{ operation: "create", kind: "tasks", changes: { title: "依赖检查", projectId: "p" } }]);
    const before = clone(store.state);
    await assert.rejects(applyPlan(store, plan), message, snapshot);
    assert.deepEqual(store.state, before); assert.deepEqual(await store.adapter.read(), before);
  }
});

test("entity limits allow exact byte, depth and value boundaries accepted by the real server", async () => cloud(async ({ base, request }) => {
  const store = await workspace(), secrets = vault();
  let nesting = "leaf";
  for (let depth = 0; depth < 31; depth++) nesting = { child: nesting };
  const project = { id: "p", name: "合成边界项目", payload: "", nesting, values: Array(19963).fill(null) };
  // root + id/name/payload + 31 nested objects/leaf + values array/items = 20000;
  // the nested leaf sits at depth 32, with the record root at depth zero.
  project.payload = "x".repeat(4 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(project)));
  assert.equal(Buffer.byteLength(JSON.stringify(project)), 4 * 1024 * 1024);
  await store.put("projects", project);
  const plan = await prepare(store, [{ operation: "create", kind: "tasks", changes: { title: "边界组内任务", projectId: "p" } }]);
  await applyPlan(store, plan);
  assert.deepEqual(firstGroup(store).payload.operations.find(op => op.entityType === "projects").data, project);
  await new Sync(store, request, secrets, {}).login(base, "mobile-test", "fixture-password-42!");
  assert.equal(syncGroupSummaries(store.state).length, 0);
  assert.equal(store.state.records["projects:p"].version, 1);
  assert.deepEqual(store.get("projects", "p"), project);
  assert.equal(store.get("tasks", plan.actions[0].targetId).projectId, "p");
  const pulled = await remote(request, base, secrets, "/v1/sync/pull-group?cursor=0&limit=100");
  assert.equal(pulled.changes.length, 1); assert.equal(pulled.changes[0].type, "atomic-group");
}));

test("old flights and running responses preserve pending approval instead of mutating their immutable operations", async () => {
  for (const obstruction of ["flight", "running"]) {
    const store = await workspace(), plan = await prepare(store);
    await store.tx(state => {
      const key = Object.keys(state.records).find(key => key.startsWith("messages:"));
      if (obstruction === "flight") state.records[key].flight = outgoing(key, clone(state.records[key].data));
      else state.records[key].data.status = "running";
    });
    const before = clone(store.state);
    await assert.rejects(applyPlan(store, plan), /先完成同步|等待当前答复/);
    assert.deepEqual(store.state, before); assert.equal(store.list("tasks").length, 0);
  }
});

test("legacy servers keep whole groups local while ordinary unrelated changes remain compatible", async () => {
  const store = await workspace(), plan = await prepare(store); await applyPlan(store, plan);
  await store.put("notes", { id: "ordinary", title: "普通写入" });
  const secrets = vault(); await secrets.set("sync", JSON.stringify({ base: "https://synthetic.invalid", token: "fixture" }));
  await store.tx(state => state.binding = { base: "https://synthetic.invalid" });
  const pushes = [], sync = new Sync(store, async (url, options = {}) => {
    if (url.endsWith("capabilities")) throw Object.assign(Error("legacy"), { status: 404 });
    if (url.endsWith("/push")) { pushes.push(options.body); return { accepted: options.body.operations.map(op => ({ ...op, version: 1 })), conflicts: [] }; }
    assert.ok(url.includes("/pull?")); return { changes: [], cursor: 0, hasMore: false };
  }, secrets, {});
  const payload = clone(firstGroup(store).payload); await sync.run();
  assert.deepEqual(pushes.flatMap(batch => batch.operations.map(op => op.entityType + ":" + op.entityId)), ["notes:ordinary"]);
  assert.deepEqual(firstGroup(store).payload, payload); assert.match(sync.status, /尚不支持整组/);
});

test("legacy cloud conflicts can be reviewed as a whole without degrading any group to per-record pushes", async () => {
  const store = await workspace(), plan = await prepare(store); await applyPlan(store, plan);
  const tid = plan.actions[0].targetId, secrets = vault(), groupId = firstGroup(store).groupId;
  await secrets.set("sync", JSON.stringify({ base: "https://synthetic.invalid", token: "fixture" }));
  await store.tx(state => state.binding = { base: "https://synthetic.invalid" });
  const change = { seq: 1, entityType: "tasks", entityId: tid, version: 1, deleted: false, data: { id: tid, title: "旧服务上的远端记录" } };
  await new Sync(store, async url => {
    if (url.endsWith("capabilities")) throw Object.assign(Error("legacy"), { status: 404 });
    assert.ok(url.includes("/pull?"), "no grouped or per-record business upload is allowed");
    return { changes: [change], cursor: 1, hasMore: false };
  }, secrets, {}).run();
  assert.equal(firstGroup(store).status, "blocked");
  await store.resolveGroup(groupId, "remote", syncGroupReview(store.state, groupId));
  assert.equal(store.get("tasks", tid).title, "旧服务上的远端记录"); assert.equal(syncGroupSummaries(store.state).length, 0);
});

test("dropped accepted response replays the identical group after restart, then syncs later local edits", async () => cloud(async ({ base, request }) => {
  const store = await workspace(), secrets = vault(), plan = await prepare(store); await applyPlan(store, plan);
  const frozen = clone(firstGroup(store).payload), requests = [];
  let drop = true;
  const flaky = async (url, options) => {
    const result = await request(url, options);
    if (url.endsWith("push-group")) { requests.push(clone(options.body)); if (drop) { drop = false; throw Error("synthetic dropped response"); } }
    return result;
  };
  await assert.rejects(new Sync(store, flaky, secrets, {}).login(base, "mobile-test", "fixture-password-42!"), /dropped/);
  const reloaded = await new Store(store.adapter).load(); assert.deepEqual(firstGroup(reloaded).payload, frozen);
  await reloaded.put("tasks", { ...reloaded.get("tasks", plan.actions[0].targetId), title: "后续本机修改" });
  await new Sync(reloaded, flaky, secrets, {}).run();
  assert.deepEqual(requests, [frozen, frozen]); assert.equal(Object.keys(reloaded.state.syncGroups).length, 0);
  const incoming = await remote(request, base, secrets, "/v1/sync/pull-group?cursor=0&limit=100");
  assert.equal(incoming.changes.filter(change => change.type === "atomic-group").length, 1);
  const taskChanges = incoming.changes.flatMap(change => change.changes || [change]).filter(change => change.entityType === "tasks");
  assert.deepEqual(taskChanges.map(change => change.version), [1, 2]);
  assert.equal(taskChanges[1].data.title, "后续本机修改");
}));

test("a target conflict uploads neither applied receipt nor sibling targets, and resolution is whole-group CAS", async () => cloud(async ({ base, request }) => {
  const store = await workspace(), secrets = vault();
  await store.put("tasks", { id: "target", title: "共同原记录" });
  const plan = await prepare(store, [{ operation: "update", kind: "tasks", id: "target", changes: { title: "已审阅本机改动" } },
    { operation: "create", kind: "notes", changes: { title: "同组新笔记", content: "不可部分创建" } }]);
  const sync = new Sync(store, request, secrets, {}); await sync.login(base, "mobile-test", "fixture-password-42!");
  await applyPlan(store, plan); const group = clone(firstGroup(store));
  await remote(request, base, secrets, "/v1/sync/push", { operations: [outgoing("tasks:target", { id: "target", title: "另一设备修改" }, 1)] });
  const before = await remote(request, base, secrets, "/v1/sync/pull?cursor=0&limit=100");
  await sync.run();
  const after = await remote(request, base, secrets, "/v1/sync/pull?cursor=0&limit=100");
  assert.deepEqual(after, before, "conflicted group has zero cloud changes");
  assert.equal(firstGroup(store).status, "blocked"); assert.match(sync.status, /操作组/);
  await assert.rejects(store.resolve("tasks:target", "remote", conflictReview(store.state.records["tasks:target"])), /不能逐条/);
  const review = syncGroupReview(store.state, group.groupId);
  await store.put("tasks", { ...store.get("tasks", "target"), description: "较晚草稿" });
  await assert.rejects(store.resolveGroup(group.groupId, "remote", review), /后续本机修改/);
  assert.equal(store.get("tasks", "target").description, "较晚草稿");
  await assert.rejects(store.resolveGroup(group.groupId, "local", syncGroupReview(store.state, group.groupId)), /不能自动覆盖/);
  await store.resolveGroup(group.groupId, "remote", syncGroupReview(store.state, group.groupId));
  assert.equal(store.get("tasks", "target").title, "另一设备修改");
  assert.equal(store.get("notes", plan.actions[1].targetId), null);
  assert.equal(store.state.records[group.messageKey].data.pendingPlan.status, "pending");
  assert.equal(syncGroupSummaries(store.state).length, 0);
}));

test("exact project dependency changes reject the whole group before either task or result is published", async () => cloud(async ({ base, request }) => {
  const store = await workspace(), secrets = vault(); await store.put("projects", { id: "p", name: "审阅所依赖项目" });
  const plan = await prepare(store, [{ operation: "create", kind: "tasks", changes: { title: "归属必须保留", projectId: "p" } }]);
  const sync = new Sync(store, request, secrets, {}); await sync.login(base, "mobile-test", "fixture-password-42!");
  await applyPlan(store, plan);
  await remote(request, base, secrets, "/v1/sync/push", { operations: [outgoing("projects:p", { id: "p", name: "云端归档", archived: true }, 1)] });
  const before = await remote(request, base, secrets, "/v1/sync/pull?cursor=0&limit=100"); await sync.run();
  assert.deepEqual(await remote(request, base, secrets, "/v1/sync/pull?cursor=0&limit=100"), before);
  assert.ok(firstGroup(store).conflict.conflicts.some(conflict => conflict.entityType === "projects" && conflict.check === "read"));
}));

test("two devices applying versus rejecting the same plan have one complete cloud winner", async () => cloud(async ({ base, request }) => {
  const first = await workspace(), a = vault(), plan = await prepare(first);
  const syncA = new Sync(first, request, a, {}); await syncA.login(base, "mobile-test", "fixture-password-42!");
  const second = await workspace(), b = vault(), syncB = new Sync(second, request, b, {}); await syncB.login(base, "mobile-test", "fixture-password-42!");
  await applyPlan(first, plan); await rejectPlan(second, plan);
  await Promise.all([syncA.run(), syncB.run()]);
  const result = await remote(request, base, a, "/v1/sync/pull-group?cursor=0&limit=100");
  const latest = new Map(result.changes.flatMap(change => change.changes || [change]).map(change => [change.entityType + ":" + change.entityId, change]));
  const message = [...latest.values()].find(change => change.entityType === "messages");
  const target = latest.get("tasks:" + plan.actions[0].targetId);
  if (message.data.pendingPlan.status === "applied") assert.ok(target && !target.deleted);
  else { assert.equal(message.data.pendingPlan.status, "rejected"); assert.equal(target, undefined); }
  assert.equal(result.changes.filter(change => change.type === "atomic-group").length, 1);
  const losers = [first, second].filter(store => Object.values(store.state.syncGroups).some(group => group.status === "blocked"));
  assert.equal(losers.length, 1);
  const loser = losers[0], review = syncGroupReview(loser.state, firstGroup(loser).groupId);
  assert.ok(review.groupIds.length >= 2, "overlapping outgoing and incoming groups must be reviewed together");
  await loser.resolveGroup(review.groupId, "remote", review);
  assert.equal(syncGroupSummaries(loser.state).length, 0);
  assert.equal(loser.list("messages")[0].pendingPlan.status, message.data.pendingPlan.status);
  assert.equal(!!loser.get("tasks", plan.actions[0].targetId), !!target);
}));

test("lifecycle phantom relations invalidate the frozen cursor without publishing removal or its receipt", async () => cloud(async ({ base, request }) => {
  const store = await workspace(), secrets = vault();
  await store.put("projects", { id: "p", name: "待归档项目" });
  const plan = await prepare(store, [{ operation: "remove", kind: "projects", id: "p" }]);
  const sync = new Sync(store, request, secrets, {}); await sync.login(base, "mobile-test", "fixture-password-42!");
  await applyPlan(store, plan); assert.equal(firstGroup(store).payload.expectedCursor, store.state.cursor);
  await remote(request, base, secrets, "/v1/sync/push", { operations: [outgoing("tasks:new-child", { id: "new-child", title: "审阅后云端新增子项", projectId: "p" })] });
  const before = await remote(request, base, secrets, "/v1/sync/pull?cursor=0&limit=100"); await sync.run();
  assert.deepEqual(await remote(request, base, secrets, "/v1/sync/pull?cursor=0&limit=100"), before);
  assert.ok(firstGroup(store).conflict.cursorConflict);
}));

test("removal and restoration publish complete tombstone/trash/receipt transactions through the real server", async () => cloud(async ({ base, request }) => {
  const store = await workspace(), secrets = vault(); await store.put("tasks", { id: "t", title: "保存原任务", description: "原正文" });
  const remove = await prepare(store, [{ operation: "remove", kind: "tasks", id: "t" }]);
  const sync = new Sync(store, request, secrets, {}); await sync.login(base, "mobile-test", "fixture-password-42!");
  const receipt = (await applyPlan(store, remove)).receipts[0]; await sync.run();
  assert.equal(store.get("tasks", "t"), null);
  const restore = await prepare(store, [{ operation: "restore", kind: "trash", id: receipt.recoveryKey.split(":")[1] }]);
  await sync.run(); // Existing pending message reaches its independent baseline before this approval.
  await applyPlan(store, restore); await sync.run();
  const pages = await remote(request, base, secrets, "/v1/sync/pull-group?cursor=0&limit=100");
  const groups = pages.changes.filter(change => change.type === "atomic-group"); assert.equal(groups.length, 2);
  for (const group of groups) assert.deepEqual(group.changes.map(change => change.entityType).sort(), ["messages", "tasks", "trash"]);
  assert.equal(groups[0].changes.find(change => change.entityType === "tasks").deleted, true);
  assert.equal(groups[1].changes.find(change => change.entityType === "trash").deleted, true);
  assert.equal(store.get("tasks", "t").description, "原正文"); assert.equal(syncGroupSummaries(store.state).length, 0);
}));

test("offline create-update-remove-restore chains keep exact predecessor heads and survive reordered checkpoint keys", async () => cloud(async ({ base, request }) => {
  const store = await workspace(), secrets = vault(), first = await prepare(store); await applyPlan(store, first);
  const tid = first.actions[0].targetId, g1 = clone(firstGroup(store));
  await store.put("tasks", { ...store.get("tasks", tid), title: "审批之间的明确本机编辑" });
  const second = await prepare(store, [{ operation: "update", kind: "tasks", id: tid, changes: { description: "第二次审批" } }]); await applyPlan(store, second);
  const g2 = Object.values(store.state.syncGroups).find(group => group.planId === second.id);
  assert.equal(g2.predecessorHeads.find(head => head.key === "tasks:" + tid).data.title, "合成待确认任务");
  assert.equal(g2.payload.operations.find(op => op.entityType === "tasks").data.title, "审批之间的明确本机编辑");
  assert.equal(g2.payload.operations.find(op => op.entityType === "tasks").baseVersion, 1);
  const third = await prepare(store, [{ operation: "remove", kind: "tasks", id: tid }]), removed = await applyPlan(store, third);
  const trashId = removed.receipts[0].recoveryKey.split(":")[1];
  const fourth = await prepare(store, [{ operation: "restore", kind: "trash", id: trashId }]); await applyPlan(store, fourth);
  const snapshots = Object.values(store.state.syncGroups).map(group => clone(group.payload));
  const deleteGroup = Object.values(store.state.syncGroups).find(group => group.planId === third.id);
  assert.equal(deleteGroup.payload.expectedCursor, g1.payload.operations.length + g2.payload.operations.length);
  await store.tx(state => state.syncGroups = Object.fromEntries(Object.entries(state.syncGroups).reverse()));
  const restored = await new Store(store.adapter).load(), sent = [];
  const sync = new Sync(restored, async (url, options) => { if (url.endsWith("push-group")) sent.push(clone(options.body)); return request(url, options); }, secrets, {});
  await sync.login(base, "mobile-test", "fixture-password-42!");
  assert.deepEqual(sent, snapshots, "payloads are unchanged; queueOrder survives map serialization order");
  assert.equal(syncGroupSummaries(restored.state).length, 0); assert.equal(restored.get("tasks", tid).description, "第二次审批");
  const history = await remote(request, base, secrets, "/v1/sync/pull-group?cursor=0&limit=100");
  assert.equal(history.changes.filter(change => change.type === "atomic-group").length, 4);
  assert.deepEqual(history.changes.flatMap(change => change.changes || [change]).filter(change => change.entityType === "tasks").map(change => change.version), [1, 2, 3, 4]);
}));

test("unknown predecessor response sends no successor until identical replay is acknowledged", async () => cloud(async ({ base, request }) => {
  const store = await workspace(), secrets = vault(), first = await prepare(store); await applyPlan(store, first);
  const second = await prepare(store, [{ operation: "update", kind: "tasks", id: first.actions[0].targetId, changes: { title: "后继审批" } }]); await applyPlan(store, second);
  const groups = Object.values(store.state.syncGroups).map(clone), sent = []; let drop = true;
  const flaky = async (url, options) => { const result = await request(url, options); if (url.endsWith("push-group")) {
    sent.push(options.body.groupId); if (drop) { drop = false; throw Error("unknown predecessor acknowledgement"); }
  } return result; };
  await assert.rejects(new Sync(store, flaky, secrets, {}).login(base, "mobile-test", "fixture-password-42!"), /unknown predecessor/);
  assert.deepEqual(sent, [groups[0].groupId]); assert.equal(store.state.syncGroups[groups[0].groupId].sent, true);
  assert.equal(store.state.syncGroups[groups[1].groupId].sent, false);
  const restored = await new Store(store.adapter).load(); await new Sync(restored, flaky, secrets, {}).run();
  assert.deepEqual(sent, [groups[0].groupId, groups[0].groupId, groups[1].groupId]);
  assert.equal(restored.get("tasks", first.actions[0].targetId).title, "后继审批");
}));

test("a conflicted predecessor blocks all later decisions and whole-group review includes those local changes", async () => cloud(async ({ base, request }) => {
  const store = await workspace(), secrets = vault(); await store.put("tasks", { id: "t", title: "原内容" });
  const first = await prepare(store, [{ operation: "update", kind: "tasks", id: "t", changes: { title: "第一个审批" } }]);
  const sent = [], sync = new Sync(store, async (url, options) => { if (url.endsWith("push-group")) sent.push(options.body.groupId); return request(url, options); }, secrets, {});
  await sync.login(base, "mobile-test", "fixture-password-42!"); await applyPlan(store, first);
  const second = await prepare(store, [{ operation: "create", kind: "notes", changes: { title: "后继笔记", content: "后继不能偷跑" } }]); await applyPlan(store, second);
  const groups = Object.values(store.state.syncGroups).map(clone);
  await remote(request, base, secrets, "/v1/sync/push", { operations: [outgoing("tasks:t", { id: "t", title: "外部胜出" }, 1)] });
  const before = await remote(request, base, secrets, "/v1/sync/pull?cursor=0&limit=100"); await sync.run();
  assert.deepEqual(sent, [groups[0].groupId]); assert.ok(Object.values(store.state.syncGroups).every(group => group.status === "blocked"));
  assert.deepEqual(await remote(request, base, secrets, "/v1/sync/pull?cursor=0&limit=100"), before);
  const review = syncGroupReview(store.state, groups[0].groupId);
  assert.ok(review.groupIds.includes(groups[1].groupId)); assert.ok(review.records.some(record => record.key === "notes:" + second.actions[0].targetId));
  await store.resolveGroup(review.groupId, "remote", review);
  assert.equal(store.get("notes", second.actions[0].targetId), null); assert.equal(syncGroupSummaries(store.state).length, 0);
}));

test("a third-party cursor gap in predecessor acknowledgements never rebases a queued deletion", async () => cloud(async ({ base, request }) => {
  const store = await workspace(), secrets = vault(), first = await prepare(store); await applyPlan(store, first);
  const second = await prepare(store, [{ operation: "remove", kind: "tasks", id: first.actions[0].targetId }]); await applyPlan(store, second);
  const groups = Object.values(store.state.syncGroups).map(clone), sent = [];
  const session = await request(base + "/v1/auth/login", { method: "POST", body: { username: "mobile-test", password: "fixture-password-42!", deviceName: "isolated fixture" } });
  await secrets.set("sync", JSON.stringify({ base, token: session.accessToken }));
  await store.tx(state => state.binding = { base, username: "mobile-test", accountID: session.account.id, deviceID: session.device.id });
  await remote(request, base, secrets, "/v1/sync/push", { operations: [outgoing("notes:external", { id: "external", title: "第三方序列" })] });
  await new Sync(store, async (url, options) => { if (url.endsWith("push-group")) sent.push(options.body.groupId); return request(url, options); }, secrets, {}).run();
  assert.deepEqual(sent, [groups[0].groupId]);
  assert.equal(store.state.syncGroups[groups[1].groupId].status, "blocked");
  assert.deepEqual(store.state.syncGroups[groups[1].groupId].payload, groups[1].payload);
  assert.match(store.state.syncGroups[groups[1].groupId].reason, /其他设备/);
  const history = await remote(request, base, secrets, "/v1/sync/pull-group?cursor=0&limit=100");
  assert.equal(history.changes.filter(change => change.type === "atomic-group").length, 1);
}));

test("acknowledged but not yet pulled predecessors keep range evidence across restart for a new offline deletion", async () => cloud(async ({ base, request }) => {
  const store = await workspace(), secrets = vault(), first = await prepare(store); await applyPlan(store, first);
  let failPull = true;
  const flaky = (url, options) => { if (failPull && url.includes("/pull-group?")) throw Error("synthetic disconnected before pull"); return request(url, options); };
  await assert.rejects(new Sync(store, flaky, secrets, {}).login(base, "mobile-test", "fixture-password-42!"), /before pull/);
  assert.equal(Object.keys(store.state.syncGroups).length, 0); assert.ok(store.state.settings.syncGroupAcks.length);
  const restored = await new Store(store.adapter).load();
  const second = await prepare(restored, [{ operation: "remove", kind: "tasks", id: first.actions[0].targetId }]); await applyPlan(restored, second);
  const group = firstGroup(restored); assert.equal(group.cursorAcknowledgements.length, 1);
  assert.equal(group.payload.expectedCursor, group.cursorAcknowledgements[0].lastSeq);
  failPull = false; await new Sync(restored, flaky, secrets, {}).run();
  assert.equal(restored.get("tasks", first.actions[0].targetId), null); assert.equal(syncGroupSummaries(restored.state).length, 0);
  assert.deepEqual(restored.state.settings.syncGroupAcks, []); assert.equal(restored.state.settings.syncNeedsPull, false);
}));

function envelope() {
  return { type: "atomic-group", groupId: "incoming", firstSeq: 1, lastSeq: 2, changes: [
    { seq: 1, entityType: "tasks", entityId: "t", version: 1, deleted: false, data: { id: "t", title: "云端任务" } },
    { seq: 2, entityType: "notes", entityId: "n", version: 1, deleted: false, data: { id: "n", title: "同组云端笔记" } },
  ] };
}
test("incoming groups and cursor land in one durable transaction; one dirty member stages the entire envelope", async () => {
  const store = await workspace(); await store.put("tasks", { id: "t", title: "本机草稿" });
  const page = { version: 1, changes: [envelope()], cursor: 2, hasMore: false }, before = clone(store.state);
  const write = store.adapter.write.bind(store.adapter); store.adapter.write = async () => { throw Error("disk full"); };
  await assert.rejects(store.tx(state => applyPullPage(state, page, { grouped: true })), /disk full/);
  assert.deepEqual(store.state, before);
  store.adapter.write = write; await store.tx(state => applyPullPage(state, page, { grouped: true }));
  const restored = await new Store(store.adapter).load();
  assert.equal(restored.state.cursor, 2); assert.equal(restored.get("tasks", "t").title, "本机草稿");
  assert.equal(restored.get("notes", "n"), null, "the clean sibling is not partially applied");
  assert.deepEqual(restored.state.syncIncomingGroups.incoming.envelope, envelope());
  const review = syncGroupReview(restored.state, "incoming");
  await restored.resolveGroup("incoming", "remote", review);
  assert.equal(restored.get("tasks", "t").title, "云端任务"); assert.equal(restored.get("notes", "n").title, "同组云端笔记");
  assert.equal(restored.state.cursor, 2); assert.equal(groupLocks(restored.state).size, 0);
});

test("invalid partial acknowledgements, truncated pulls and local save failures retain every group member", async () => {
  const store = await workspace(), plan = await prepare(store), before = clone(store.state);
  const write = store.adapter.write.bind(store.adapter); store.adapter.write = async () => { throw Error("disk full"); };
  await assert.rejects(applyPlan(store, plan), /disk full/); assert.deepEqual(store.state, before);
  store.adapter.write = write; await applyPlan(store, plan); const group = firstGroup(store), frozen = clone(store.state);
  await assert.rejects(store.tx(state => acknowledgeGroup(state, group.groupId, { version: 1, groupId: group.groupId, status: "accepted", accepted: [], conflicts: [], cursor: 1 })), /完整操作组/);
  assert.deepEqual(store.state, frozen);
  const broken = envelope(); broken.changes.pop();
  await assert.rejects(store.tx(state => applyPullPage(state, { version: 1, changes: [broken], cursor: 2, hasMore: false }, { grouped: true })), /不完整/);
  assert.deepEqual(store.state, frozen);
});

test("durable queue validation rejects erased predecessor obligations and forged frozen heads", async () => {
  const store = await workspace(), first = await prepare(store); await applyPlan(store, first);
  const second = await prepare(store, [{ operation: "update", kind: "tasks", id: first.actions[0].targetId, changes: { title: "后继" } }]); await applyPlan(store, second);
  const nextId = Object.values(store.state.syncGroups).find(group => group.planId === second.id).groupId, before = clone(store.state);
  for (const alter of [
    group => group.pendingPredecessors = [],
    group => group.sent = true,
    group => group.predecessorHeads[0].data.title = "伪造前序数据",
    group => group.queueOrder = 1,
  ]) {
    await assert.rejects(store.tx(state => alter(state.syncGroups[nextId])), /同步|前序/);
    assert.deepEqual(store.state, before);
  }
});

test("incoming protocol IDs remain own dictionary keys and cursor gaps never discard unseen groups", async () => {
  const store = await workspace(); await store.put("tasks", { id: "t", title: "原本机草稿" });
  const incoming = envelope(); incoming.groupId = "__proto__";
  await store.tx(state => applyPullPage(state, { version: 1, changes: [incoming], cursor: 2, hasMore: false }, { grouped: true }));
  assert.equal(Object.hasOwn(store.state.syncIncomingGroups, "__proto__"), true);
  assert.equal(syncGroupSummaries(store.state)[0].groupId, "__proto__");
  const before = clone(store.state);
  await assert.rejects(store.tx(state => applyPullPage(state, { version: 1, changes: [], cursor: 9, hasMore: false }, { grouped: true })), /游标/);
  assert.deepEqual(store.state, before);
});

test("whole-group comparisons require complete pages and correct a same-version cached baseline mismatch", async () => {
  const store = await workspace(); await store.put("tasks", { id: "t", title: "缓存基线" });
  await store.tx(state => { state.records["tasks:t"].version = 1; state.records["tasks:t"].remote = { id: "t", title: "缓存基线" }; });
  const plan = await prepare(store, [{ operation: "update", kind: "tasks", id: "t", changes: { title: "新修改" } }]); await applyPlan(store, plan);
  const group = firstGroup(store);
  await store.tx(state => acknowledgeGroup(state, group.groupId, { version: 1, groupId: group.groupId, status: "conflict", accepted: [], cursor: 1,
    conflicts: [{ entityType: "tasks", entityId: "t", check: "read", expectedVersion: 1, remote: { version: 1, deleted: false } }] }));
  const page = { version: 1, cursor: 1, hasMore: false, changes: [{ seq: 1, entityType: "tasks", entityId: "t", version: 1, deleted: false, data: { id: "t", title: "服务器真实基线" } }] };
  const before = clone(store.state);
  await assert.rejects(store.tx(state => refreshGroupHeads(state, { ...page, hasMore: undefined })), /响应无效/);
  assert.deepEqual(store.state, before);
  await store.tx(state => refreshGroupHeads(state, { ...page, hasMore: true }));
  assert.equal(firstGroup(store).remoteCursor, 1); assert.equal(firstGroup(store).remoteReady, false);
  const reopened = await new Store(store.adapter).load();
  await reopened.tx(state => refreshGroupHeads(state, { version: 1, cursor: 2, hasMore: false,
    changes: [{ seq: 2, entityType: "notes", entityId: "elsewhere", version: 1, deleted: false, data: { id: "elsewhere", title: "比较范围外" } }] }, { fromCursor: 1 }));
  const review = syncGroupReview(reopened.state, group.groupId);
  assert.equal(review.records.find(record => record.key === "tasks:t").remote.data.title, "服务器真实基线");
  assert.equal(firstGroup(reopened).remoteCursor, 2); assert.equal(reopened.get("notes", "elsewhere"), null);
});
