import test from "node:test";
import assert from "node:assert/strict";
import { syncStatusModel } from "../src/ui/sync-status-model.js";

test("sync status uses reported facts and cannot turn pending changes into completion", () => {
  assert.equal(syncStatusModel().state, "offline");
  assert.match(syncStatusModel({ state: "synced", pending: 3 }).title, /3 项待推送/);
  assert.equal(syncStatusModel({ state: "synced", conflicts: 2 }).state, "conflict");
  assert.equal(syncStatusModel({ state: "synced", connected: false }).state, "offline");
  assert.equal(syncStatusModel({ state: "pending", online: false, pending: 2 }).canSync, false);
  assert.equal(syncStatusModel({ state: "auth-expired", conflicts: 2 }).state, "auth-expired");
  assert.equal(syncStatusModel({ state: "auth-expired" }).canSync, false);
  assert.equal(syncStatusModel({ state: "syncing", pending: 2 }).syncing, true);
  assert.equal(syncStatusModel({ state: "error", pending: 2 }).state, "error");
});

test("completion copy reports the sync service and fixed last-success timestamp without claiming Mac applied it", () => {
  const model = syncStatusModel({ state: "synced", pending: 0, conflicts: 0, lastSync: Date.parse("2030-02-01T15:00:00+08:00") });
  assert.equal(model.title, "已同步");
  assert.match(model.detail, /上次同步/);
  assert.doesNotMatch(model.detail, /电脑已|Mac已|刚刚/);
  assert.equal(syncStatusModel({ state: "conflict", conflicts: 3 }).showConflicts, true);
  assert.equal(syncStatusModel({ state: "offline", connected: false }).settingsPrimary, true);
});
