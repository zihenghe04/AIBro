import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { Store, MemoryAdapter, clone, addMessage } from "../src/store.js";
import { createBackup, restoreBackup } from "../src/backup.js";
import { freezeDecisionGroup, applyPullPage, acknowledgeGroup, prepareGroupSend, queuedGroupIds, validateSyncGroups } from "../src/sync-groups.js";
import { createAgentTools, applyPlan } from "../src/agent-tools.js";
import { Sync } from "../src/sync.js";

const hash = async bytes => createHash("sha256").update(bytes).digest("hex");
const newStore = () => new Store(new MemoryAdapter()).load();
const manifest = bytes => JSON.parse(strFromU8(unzipSync(bytes)["manifest.json"]));
const modify = (bytes, change) => {
  const entries = unzipSync(bytes), value = JSON.parse(strFromU8(entries["manifest.json"]));
  change(value); entries["manifest.json"] = strToU8(JSON.stringify(value)); return zipSync(entries);
};
const noFiles = { write: async () => assert.fail("unexpected file write") };

async function approve(store, actions) {
  if (!store.get("conversations", "chat")) await store.put("conversations", { id: "chat", title: "chain fixture", projectId: null });
  const tools = createAgentTools({ store, conversationID: "chat" });
  for (const action of actions) if (action.id)
    assert.equal((await tools.execute("knowledge_read", { kind: action.kind, id: action.id, archived: action.operation === "restore" })).error, undefined);
  const output = await tools.execute("propose_changes", { actions }); assert.equal(output.error, undefined, output.error);
  const plan = tools.pendingPlan();
  await addMessage(store, "chat", "assistant", "合成待审批", { pendingPlan: plan, status: "completed" });
  const applied = await applyPlan(store, plan);
  return { plan, applied, group: Object.values(store.state.syncGroups).find(group => group.planId === plan.id) };
}

async function acknowledge(store, groupId, cursor) {
  const group = store.state.syncGroups[groupId];
  await store.tx(state => acknowledgeGroup(state, groupId, { version: 1, groupId, status: "accepted", conflicts: [], cursor,
    accepted: group.payload.operations.map(op => ({ opId: op.opId, entityType: op.entityType, entityId: op.entityId, version: op.baseVersion + 1 })) }));
}

async function queuedStore(bound = true) {
  const store = await newStore();
  await store.put("conversations", { id: "chat", projectId: null, title: "fixture" });
  const plan = { id: "plan", conversationID: "chat", projectID: null, actions: [], status: "pending" };
  await store.put("messages", { id: "message", conversationId: "chat", role: "assistant", content: "review", pendingPlan: plan });
  await store.tx(state => {
    if (bound) state.binding = { base: "https://sync.example.test", username: "fixture", accountID: "account", deviceID: "old-device" };
    state.settings = { model: { key: "DO-NOT-EXPORT-API-KEY" }, ucas: { password: "DO-NOT-EXPORT-PASSWORD" } };
    state.drafts = { "chat:chat": "device-local draft" };
    const before = clone(state.records);
    state.records["messages:message"].data.pendingPlan.status = "applied";
    freezeDecisionGroup(state, before, { messageKey: "messages:message", plan, decision: "applied" });
  });
  return store;
}

test("bound checkpoint preserves immutable groups, versions, old flights and conflicts without credentials", async () => {
  const source = await queuedStore();
  await source.tx(state => {
    state.cursor = 9;
    const old = { id: "note", title: "old" }, next = { id: "note", title: "new" };
    state.records["notes:note"] = { version: 3, remote: old, remoteDeleted: false, dirty: true, deleted: false, data: next,
      flight: { opId: "old-flight", entityType: "notes", entityId: "note", baseVersion: 3, deleted: false, data: next },
      conflict: { version: 4, deleted: false, data: { id: "note", title: "peer" } } };
  });
  const bytes = await createBackup(source, async () => assert.fail("unexpected read"), hash), saved = manifest(bytes);
  assert.equal(saved.format, "aibro-mobile-backup-v3");
  assert.deepEqual(saved.checkpoint.records, source.state.records);
  assert.deepEqual(saved.checkpoint.syncGroups, source.state.syncGroups);
  assert.deepEqual(saved.checkpoint.binding, { base: "https://sync.example.test", username: "fixture", accountID: "account" });
  assert.doesNotMatch(JSON.stringify(saved), /DO-NOT-EXPORT|old-device|device-local draft/);
  const restored = await newStore(), result = await restoreBackup(restored, bytes, noFiles, hash);
  assert.equal(result.checkpoint, true); assert.equal(result.requiresOriginalAccount, true); assert.equal(result.pendingGroups, 1);
  assert.deepEqual(restored.state.records, source.state.records); assert.deepEqual(restored.state.syncGroups, source.state.syncGroups);
  assert.equal(restored.state.cursor, 9); assert.deepEqual(restored.state.settings, {}); assert.deepEqual(restored.state.drafts, {});
  let network = 0, credentials = 0;
  const sync = new Sync(restored, async () => { network++; return { accessToken: "fixture-token", account: { id: "different", username: "fixture" }, device: { id: "new" } }; }, { set: async () => credentials++ }, {});
  await assert.rejects(sync.login("https://other.example.test", "fixture", "password"), /其他账号或服务/);
  assert.equal(network, 0);
  await assert.rejects(sync.login("https://sync.example.test", "fixture", "password"), /账号标识变化/);
  assert.equal(credentials, 0);
});

test("unbound offline groups remain unbound and may first bind after restore", async () => {
  const source = await queuedStore(false), bytes = await createBackup(source, async () => {}, hash), restored = await newStore();
  const result = await restoreBackup(restored, bytes, noFiles, hash);
  assert.equal(result.checkpoint, true); assert.equal(result.requiresOriginalAccount, false); assert.equal(restored.state.binding, null);
  let credentialWrites = 0;
  const sync = new Sync(restored, async () => ({ accessToken: "new-fixture-token", account: { id: "first-account", username: "fixture" }, device: { id: "first-device" } }), { set: async () => credentialWrites++ }, {});
  sync.run = async () => {};
  await sync.login("https://sync.example.test", "fixture", "password");
  assert.equal(credentialWrites, 1); assert.equal(restored.state.binding.accountID, "first-account");
  assert.deepEqual(restored.state.syncGroups, source.state.syncGroups);
});

test("incoming blocked group checkpoint preserves every envelope member and cursor", async () => {
  const source = await newStore();
  await source.tx(state => state.binding = { base: "https://sync.example.test", username: "fixture", accountID: "account" });
  await source.put("tasks", { id: "task", title: "local draft" });
  await source.tx(state => applyPullPage(state, { version: 1, cursor: 2, hasMore: false, changes: [{ type: "atomic-group", groupId: "incoming", firstSeq: 1, lastSeq: 2,
    changes: [{ seq: 1, entityType: "tasks", entityId: "task", version: 1, deleted: false, data: { id: "task", title: "peer" } },
      { seq: 2, entityType: "notes", entityId: "new-note", version: 1, deleted: false, data: { id: "new-note", title: "not visible until whole resolution" } }] }] }, { grouped: true }));
  const bytes = await createBackup(source, async () => {}, hash), restored = await newStore();
  const result = await restoreBackup(restored, bytes, noFiles, hash);
  assert.equal(result.incomingGroups, 1); assert.equal(result.pendingGroups, 0);
  assert.deepEqual(restored.state.syncIncomingGroups, source.state.syncIncomingGroups);
  assert.deepEqual(restored.state.records, source.state.records); assert.equal(restored.state.cursor, 2);
  assert.equal(restored.get("tasks", "task").title, "local draft"); assert.equal(restored.get("notes", "new-note"), null);
});

test("blocked outgoing checkpoints retain exact durable conflict result and completed remote comparison", async () => {
  const source = await queuedStore(), groupId = Object.keys(source.state.syncGroups)[0];
  await source.tx(state => {
    acknowledgeGroup(state, groupId, { version: 1, groupId, status: "conflict", accepted: [], cursor: 3,
      conflicts: [{ entityType: "messages", entityId: "message", check: "read", expectedVersion: 0, remote: { version: 1, deleted: false } }] });
    state.syncGroups[groupId].remoteReady = true; state.syncGroups[groupId].remoteCursor = 3;
  });
  const bytes = await createBackup(source, async () => {}, hash), restored = await newStore();
  await restoreBackup(restored, bytes, noFiles, hash);
  assert.deepEqual(restored.state.syncGroups, source.state.syncGroups);
  await assert.rejects(restoreBackup(await newStore(), modify(bytes, m => { Object.values(m.checkpoint.syncGroups)[0].conflict.conflicts[0].remote.token = "forbidden"; }), noFiles, hash));
});

test("all checkpoint blob references including remote and trash remain recoverable and verified", async () => {
  const source = await queuedStore(), original = strToU8("old original"), current = strToU8("new original");
  const originalHash = await hash(original), currentHash = await hash(current), data = new Map([[originalHash, original], [currentHash, current]]);
  await source.tx(state => {
    state.records["imports:file"] = { version: 1, remote: { id: "file", title: "old snapshot", blobHash: originalHash }, remoteDeleted: false,
      data: { id: "file", title: "current snapshot", blobHash: currentHash }, dirty: true, deleted: false };
    state.records["trash:trash"] = { version: 0, remote: null, remoteDeleted: false, data: { id: "trash", data: { imports: [{ id: "old-file", blobHash: originalHash }] } }, dirty: true, deleted: false };
  });
  const seen = [];
  const bytes = await createBackup(source, async (digest, captured) => { seen.push([digest, clone(captured)]); return data.get(digest); }, hash);
  assert.deepEqual(new Set(manifest(bytes).blobs), new Set(data.keys())); assert.equal(seen.length, 2);
  assert.ok(seen.every(([digest, captured]) => captured.blobHash === digest));
  const restored = await newStore(), writes = [];
  const result = await restoreBackup(restored, bytes, { write: async (...args) => writes.push(args) }, hash);
  assert.equal(result.files, 2); assert.equal(writes.length, 2);
  assert.ok([...data.keys()].every(digest => restored.state.blobs[digest].uploaded === false));
  const broken = unzipSync(bytes); broken["blobs/" + originalHash][0] ^= 1;
  const empty = await newStore(), badWrites = [];
  await assert.rejects(restoreBackup(empty, zipSync(broken), { write: async (...args) => badWrites.push(args) }, hash), /缺失或损坏/);
  assert.equal(badWrites.length, 0); assert.deepEqual(empty.state.records, {});
});

test("backup captures one immutable complete state before awaiting original reads", async () => {
  const source = await queuedStore(), bytes = strToU8("fixture-original"), digest = await hash(bytes);
  await source.put("imports", { id: "file", title: "captured title", blobHash: digest });
  const before = clone(source.state), backup = await createBackup(source, async (requested, captured) => {
    assert.equal(requested, digest); assert.equal(captured.title, "captured title");
    await source.put("imports", { id: "file", title: "later title", blobHash: digest });
    await source.put("notes", { id: "later", title: "not in checkpoint" });
    return bytes;
  }, hash);
  assert.deepEqual(manifest(backup).checkpoint.records, before.records);
  assert.deepEqual(manifest(backup).checkpoint.syncGroups, before.syncGroups);
});

test("unknown schemas, credential metadata, missing members and altered group structure reject before files or state", async () => {
  const source = await queuedStore(), bytes = await createBackup(source, async () => {}, hash);
  const mutations = [
    m => { m.format = "aibro-mobile-backup-v9"; },
    m => { m.checkpoint.schema = 2; },
    m => { m.config = { token: "must reject" }; },
    m => { m.checkpoint.settings = { model: { key: "must reject" } }; },
    m => { m.checkpoint.binding.token = "must reject"; },
    m => { m.checkpoint.binding.base = "https://user:password@sync.example.test"; },
    m => { m.checkpoint.binding = null; m.checkpoint.cursor = 1; },
    m => { delete m.checkpoint.records["messages:message"]; },
    m => { Object.values(m.checkpoint.syncGroups)[0].payload.version = 2; },
    m => { Object.values(m.checkpoint.syncGroups)[0].payload.operations.pop(); },
    m => { Object.values(m.checkpoint.syncGroups)[0].payload.readSet.pop(); },
    m => { Object.values(m.checkpoint.syncGroups)[0].payload.operations[0].authorization = "must reject"; },
    m => { Object.values(m.checkpoint.syncGroups)[0].payload.readSet[0].password = "must reject"; },
    m => { m.checkpoint.records["messages:message"].token = "must reject"; },
    m => { m.checkpoint.records["messages:message"].data.pendingPlan.syncGroupId = "different"; },
  ];
  for (const mutate of mutations) {
    const empty = await newStore();
    await assert.rejects(restoreBackup(empty, modify(bytes, mutate), noFiles, hash));
    assert.deepEqual(empty.state.records, {});
  }
});

test("restore requires an empty workspace again at durable commit and preserves queue on write failure", async () => {
  const source = await queuedStore(), original = strToU8("fixture"), digest = await hash(original);
  await source.put("imports", { id: "file", blobHash: digest });
  const bytes = await createBackup(source, async () => original, hash), changing = await newStore();
  await assert.rejects(restoreBackup(changing, bytes, { write: async () => changing.put("notes", { id: "concurrent", title: "keep" }) }, hash), /工作区已发生变化/);
  assert.equal(changing.get("notes", "concurrent").title, "keep"); assert.equal(Object.keys(changing.state.syncGroups || {}).length, 0);
  const failed = await new Store({ read: async () => null, write: async () => { throw Error("fixture persistence failure"); } }).load();
  await assert.rejects(restoreBackup(failed, bytes, { write: async () => {} }, hash), /fixture persistence failure/);
  assert.deepEqual(failed.state.records, {}); assert.equal(Object.keys(failed.state.syncGroups || {}).length, 0);
});

test("ordinary v2 and legacy v1 keep clean portable-record behavior", async () => {
  const source = await newStore();
  await source.put("notes", { id: "note", title: "ordinary" });
  await source.tx(state => { state.binding = { base: "https://sync.example.test", username: "fixture", accountID: "account", deviceID: "device" }; state.records["notes:note"].version = 8; });
  const bytes = await createBackup(source, async () => {}, hash), saved = manifest(bytes);
  assert.equal(saved.format, "aibro-mobile-backup-v2"); assert.equal(saved.records["notes:note"].version, 0); assert.equal(saved.checkpoint, undefined);
  const restored = await newStore(), result = await restoreBackup(restored, bytes, noFiles, hash);
  assert.equal(result.checkpoint, undefined); assert.equal(restored.state.binding, null);
  const legacy = await newStore();
  const legacyResult = await restoreBackup(legacy, strToU8(JSON.stringify({ format: "aibro-mobile-backup-v1", records: saved.records })), noFiles, hash);
  assert.equal(legacyResult.legacy, true); assert.equal(legacy.get("notes", "note").title, "ordinary");
});

test("unbound offline CRUD chains preserve projected predecessor heads, cursor evidence and send order", async () => {
  const source = await newStore();
  const first = await approve(source, [{ operation: "create", kind: "tasks", changes: { title: "合成离线任务" } }]);
  const id = first.plan.actions[0].targetId;
  await approve(source, [{ operation: "update", kind: "tasks", id, changes: { title: "合成离线修改" } }]);
  const removed = await approve(source, [{ operation: "remove", kind: "tasks", id }]);
  const trashId = removed.applied.receipts[0].recoveryKey.split(":")[1];
  await approve(source, [{ operation: "restore", kind: "trash", id: trashId }]);
  assert.equal(Object.keys(source.state.syncGroups).length, 4);
  assert.ok(Object.values(source.state.syncGroups).some(group => group.predecessorHeads.some(head => head.version > 0)));
  const bytes = await createBackup(source, async () => assert.fail("no originals"), hash);
  const reordered = modify(bytes, saved => { saved.checkpoint.syncGroups = Object.fromEntries(Object.entries(saved.checkpoint.syncGroups).reverse()); });
  const restored = await newStore(); await restoreBackup(restored, reordered, noFiles, hash);
  assert.deepEqual(restored.state.records, source.state.records);
  assert.deepEqual(restored.state.syncGroups, source.state.syncGroups);
  assert.deepEqual(queuedGroupIds(restored.state), queuedGroupIds(source.state));
  assert.equal(restored.get("tasks", id).title, "合成离线修改");
  assert.equal(restored.state.binding, null);
  validateSyncGroups(restored.state);

  for (const mutate of [
    group => { delete group.predecessors; },
    group => { group.pendingPredecessors = ["missing-group"]; },
    group => { group.predecessorHeads[0].data.title = "伪造冻结前序"; },
    group => { group.predecessorHeads[0].password = "forbidden"; },
    group => { group.queueOrder = 0; },
    group => { group.sent = "forbidden"; },
    group => { group.cursorBase++; },
    group => { group.cursorAcknowledgements.push({ groupId: "secret", firstSeq: 1, lastSeq: 1, count: 1, token: "forbidden" }); },
  ]) {
    const corrupted = modify(bytes, saved => mutate(Object.values(saved.checkpoint.syncGroups).find(group => group.planId === removed.plan.id)));
    const empty = await newStore(); await assert.rejects(restoreBackup(empty, corrupted, noFiles, hash));
    assert.deepEqual(empty.state.records, {});
  }
});

test("checkpoint retains unknown send and acknowledged predecessor evidence without exporting other settings", async () => {
  const source = await newStore();
  await source.tx(state => {
    state.binding = { base: "https://sync.example.test", username: "fixture", accountID: "account" };
    state.settings = { model: { key: "DO-NOT-EXPORT-CHAIN-KEY" }, token: "DO-NOT-EXPORT-CHAIN-TOKEN" };
  });
  const first = await approve(source, [{ operation: "create", kind: "tasks", changes: { title: "合成待发任务" } }]);
  const id = first.plan.actions[0].targetId;
  await approve(source, [{ operation: "update", kind: "tasks", id, changes: { description: "后继修改" } }]);
  const sent = await source.tx(state => prepareGroupSend(state, first.group.groupId));
  assert.ok(sent); assert.equal(source.state.syncGroups[first.group.groupId].sent, true);
  let bytes = await createBackup(source, async () => {}, hash), restored = await newStore();
  await restoreBackup(restored, bytes, noFiles, hash);
  assert.deepEqual(await restored.tx(state => prepareGroupSend(state, first.group.groupId)), sent, "unknown send replays exact original IDs and payload");
  await acknowledge(restored, first.group.groupId, first.group.payload.operations.length);
  assert.equal(restored.state.settings.syncNeedsPull, true);
  assert.equal(restored.state.settings.syncGroupAcks.length, 1);
  const removed = await approve(restored, [{ operation: "remove", kind: "tasks", id }]);
  assert.equal(removed.group.cursorAcknowledgements.length, 1);
  await restored.tx(state => { state.settings.syncLegacyPushAhead = false; state.settings.model = { key: "DO-NOT-EXPORT-AFTER-ACK" }; });
  bytes = await createBackup(restored, async () => {}, hash);
  assert.deepEqual(manifest(bytes).checkpoint.settings, { syncGroupAcks: restored.state.settings.syncGroupAcks, syncNeedsPull: true, syncLegacyPushAhead: false });
  assert.doesNotMatch(JSON.stringify(manifest(bytes)), /DO-NOT-EXPORT/);
  const after = await newStore(); await restoreBackup(after, bytes, noFiles, hash);
  assert.deepEqual(after.state.syncGroups, restored.state.syncGroups);
  assert.deepEqual(after.state.settings, manifest(bytes).checkpoint.settings);
  validateSyncGroups(after.state);
  for (const mutate of [
    saved => { saved.checkpoint.binding = null; },
    saved => { saved.checkpoint.settings.syncGroupAcks[0].token = "forbidden"; },
    saved => { saved.checkpoint.settings.syncNeedsPull = "not-boolean"; },
    saved => { saved.checkpoint.settings.model = { key: "forbidden" }; },
    saved => { Object.values(saved.checkpoint.syncGroups)[0].predecessorAcks[first.group.groupId].password = "forbidden"; },
  ]) {
    const empty = await newStore(); await assert.rejects(restoreBackup(empty, modify(bytes, mutate), noFiles, hash));
    assert.deepEqual(empty.state.records, {});
  }
});

test("legacy independent v3 groups remain readable without fabricated chain or checkpoint settings", async () => {
  const source = await queuedStore(false), bytes = await createBackup(source, async () => {}, hash);
  const legacy = modify(bytes, saved => {
    delete saved.checkpoint.settings;
    for (const group of Object.values(saved.checkpoint.syncGroups))
      for (const key of ["predecessors", "pendingPredecessors", "predecessorHeads", "predecessorAcks", "queueOrder", "sent"]) delete group[key];
  });
  const restored = await newStore(); await restoreBackup(restored, legacy, noFiles, hash);
  assert.deepEqual(restored.state.settings, {});
  assert.equal(Object.values(restored.state.syncGroups)[0].predecessors, undefined);
  validateSyncGroups(restored.state);
});
