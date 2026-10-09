import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { Store, MemoryAdapter, conflictReview } from "../src/store.js";
import { createBackup, restoreBackup } from "../src/backup.js";
import { Sync } from "../src/sync.js";

const digest = async (bytes) => createHash("sha256").update(bytes).digest("hex");
const workspace = () => new Store(new MemoryAdapter()).load();
const vault = () => {
  const values = new Map();
  return {
    get: async (key) => values.get(key),
    set: async (key, value) => values.set(key, value),
    remove: async (key) => values.delete(key),
  };
};
const fileStore = () => {
  const values = new Map();
  return {
    write: async (hash, bytes) => values.set(hash, bytes.slice()),
    read: async (hash) => {
      if (!values.has(hash)) throw Error("原件未下载");
      return values.get(hash).slice();
    },
  };
};

test("conflict decisions compare both reviewed versions and reject stale or missing review", async () => {
  const store = await workspace();
  await store.put("notes", { id: "n", title: "Local", content: "local edit" });
  await store.tx((s) => {
    s.records["notes:n"].conflict = {
      version: 3, deleted: false, data: { id: "n", title: "Remote", content: "remote edit" },
    };
  });
  const firstReview = conflictReview(store.state.records["notes:n"]);
  await assert.rejects(store.resolve("notes:n", "remote"), /重新打开/);
  await assert.rejects(store.resolve("notes:n", "unknown", firstReview), /本机或云端/);
  await store.tx((s) => {
    s.records["notes:n"].conflict = { version: 4, deleted: true, data: null };
  });
  await assert.rejects(store.resolve("notes:n", "remote", firstReview), /冲突版本已变化/);
  assert.equal(store.get("notes", "n").content, "local edit");
  assert.equal(store.state.records["notes:n"].conflict.version, 4);

  const secondReview = conflictReview(store.state.records["notes:n"]);
  await store.put("notes", { ...store.get("notes", "n"), content: "new local edit" });
  await assert.rejects(store.resolve("notes:n", "remote", secondReview), /冲突版本已变化/);
  assert.equal(store.get("notes", "n").content, "new local edit");

  const latest = conflictReview(store.state.records["notes:n"]);
  const reloaded = await new Store(store.adapter).load();
  await reloaded.resolve("notes:n", "local", latest);
  assert.equal(reloaded.get("notes", "n").content, "new local edit");
  assert.equal(reloaded.state.records["notes:n"].version, 4);
  assert.equal(reloaded.state.records["notes:n"].dirty, true);
  assert.equal(reloaded.state.records["notes:n"].conflict, null);
});

test("sync repairs missing legacy blob metadata before pushing a new import, but refuses a missing original", async () => {
  const bytes = new TextEncoder().encode("older restored original"), hash = await digest(bytes);
  const store = await workspace(), secrets = vault(), files = fileStore();
  await store.put("imports", { id: "legacy", name: "legacy.txt", blobHash: hash });
  await store.tx((s) => s.binding = { base: "https://sync.example" });
  await secrets.set("sync", JSON.stringify({ base: "https://sync.example", token: "fixture" }));
  const calls = [];
  const sync = new Sync(store, async (url, options = {}) => {
    if (url.endsWith("/capabilities")) throw Object.assign(Error("legacy fixture"), { status: 404 });
    calls.push(options.method === "PUT" ? "blob" : options.method === "HEAD" ? "head" : url.endsWith("/push") ? "push" : "pull");
    if (options.method === "HEAD") throw Object.assign(Error("not found"), { status: 404 });
    if (options.method === "PUT") return {};
    if (url.endsWith("/push")) return {
      accepted: options.body.operations.map((op) => ({ ...op, version: 1 })), conflicts: [],
    };
    return { changes: [], cursor: 0, hasMore: false };
  }, secrets, files);
  await assert.rejects(sync.run(), /原件不在本机或当前同步账号/);
  assert.deepEqual(calls, ["head"]);
  assert.equal(store.state.records["imports:legacy"].dirty, true);
  await files.write(hash, bytes);
  calls.length = 0;
  await sync.run();
  assert.deepEqual(calls, ["blob", "push", "pull"]);
  assert.equal(store.state.blobs[hash].uploaded, true);
  assert.equal(store.state.blobs[hash].size, bytes.length);

  // A pulled record can be edited without downloading its already-remote original.
  await store.tx((s) => delete s.blobs[hash]);
  await store.put("imports", { ...store.get("imports", "legacy"), title: "Updated title" });
  calls.length = 0;
  await sync.run();
  assert.deepEqual(calls, ["push", "pull"]);
});

test("restored originals and reminder overrides survive isolated mobile/Desktop/cloud roundtrips", async () => {
  const python = [process.env.PYTHON, "python3.13", "python3.12", "python3.11", "python3"]
    .filter(Boolean).find((p) => spawnSync(p, ["-c", 'import hashlib; assert hasattr(hashlib,"scrypt")']).status === 0);
  assert.ok(python, "Python with hashlib.scrypt is required");
  const child = spawn(python, ["tests/cloud-fixture.py"], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (data) => stderr += data);
  const stopped = new Promise((_, reject) => child.on("exit", (code) => reject(Error(`fixture exited ${code}: ${stderr}`))));
  try {
    const [chunk] = await Promise.race([once(child.stdout, "data"), stopped]);
    const base = "http://127.0.0.1:" + String(chunk).trim();
    const request = async (url, options = {}) => {
      const response = await fetch(url, {
        method: options.method || "GET",
        headers: { "Content-Type": "application/json", ...options.headers },
        body: options.bytes || (options.body ? JSON.stringify(options.body) : undefined),
      });
      const value = options.raw ? new Uint8Array(await response.arrayBuffer()) : await response.json();
      if (!response.ok) throw Object.assign(Error(value.error), { status: response.status });
      return value;
    };
    const original = new TextEncoder().encode("restored cloud original"), hash = await digest(original);
    const source = await workspace();
    await source.put("imports", { id: "restored-file", name: "evidence.txt", content: "Evidence", blobHash: hash });
    await source.put("notes", { id: "restored-note", title: "Evidence", sourceAttachmentIds: ["restored-file"] });
    for (const [id, reminderMinutes] of [["off", null], ["at-due", 0], ["early", 15], ["week", 10080]])
      await source.put("tasks", { id, title: id, dueAt: "2030-01-01T08:00:00Z", reminderMinutes });
    const archive = await createBackup(source, async () => original, digest);
    const target = await workspace(), localFiles = fileStore();
    await restoreBackup(target, archive, localFiles, digest);
    const restored = await new Store(target.adapter).load();
    assert.equal(restored.state.blobs[hash].uploaded, false);
    assert.equal(restored.state.blobs[hash].size, original.length);
    const firstVault = vault();
    await new Sync(restored, request, firstVault, localFiles).login(base, "mobile-test", "fixture-password-42!");
    assert.equal(restored.state.blobs[hash].uploaded, true);

    const second = await workspace(), secondVault = vault();
    const peer = new Sync(second, request, secondVault, fileStore());
    await peer.login(base, "mobile-test", "fixture-password-42!");
    assert.equal(second.get("imports", "restored-file").blobHash, hash);
    assert.deepEqual(second.get("notes", "restored-note").sourceAttachmentIds, ["restored-file"]);
    for (const task of source.list("tasks"))
      assert.equal(second.get("tasks", task.id).reminderMinutes, task.reminderMinutes);
    const { token } = JSON.parse(await secondVault.get("sync"));
    const response = await fetch(base + "/v1/blobs/" + hash, { headers: { Authorization: "Bearer " + token } });
    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), original);
    const desktop = JSON.parse(execFileSync(python, ["tests/desktop-sync-reminders.py"], {
      input: JSON.stringify({ base, token }), encoding: "utf8", timeout: 15000,
    }));
    assert.equal(desktop.accepted, 4);
    await peer.run();
    assert.equal(second.get("tasks", "off").reminderMinutes, null);
    assert.equal(second.get("tasks", "at-due").reminderMinutes, 0);
    assert.equal(second.get("tasks", "early").reminderMinutes, 60);
    assert.equal(Object.hasOwn(second.get("tasks", "week"), "reminderMinutes"), false);
    assert.match(second.get("tasks", "week").title, /reviewed on desktop/);

    // A v1 backup has metadata only; its original can remain in the same account.
    const legacy = await workspace();
    const legacyRecord = source.state.records["imports:restored-file"];
    await restoreBackup(legacy, new TextEncoder().encode(JSON.stringify({
      format: "aibro-mobile-backup-v1", records: { "imports:restored-file": legacyRecord },
    })), fileStore(), digest);
    await new Sync(legacy, request, vault(), fileStore()).login(base, "mobile-test", "fixture-password-42!");
    assert.equal(legacy.state.blobs[hash].uploaded, true);
    await peer.logout();
  } finally {
    child.kill("SIGTERM");
  }
});
