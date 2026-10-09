import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { Store, MemoryAdapter, clone } from "../src/store.js";
import { createBackup, restoreBackup } from "../src/backup.js";
import { reviewRemoval, removeRecord, reviewRestore, restoreRecord, listRecoverable } from "../src/lifecycle.js";

const DesktopLifecycle = createRequire(import.meta.url)("../../app/content-lifecycle.js");
const digest = async (bytes) => createHash("sha256").update(bytes).digest("hex");
const fresh = () => new Store(new MemoryAdapter()).load();
async function fixture() {
  const store = await fresh();
  await store.put("projects", { id: "p", name: "课程项目", workspace: "课程", status: "active" });
  await store.put("notes", { id: "n", title: "课堂笔记", content: "人工原文", workspace: "课程", projectId: "p", sourceAttachmentIds: ["f"] });
  await store.put("tasks", { id: "t", title: "阅读原件", status: "todo", projectId: "p", sourceNoteIds: ["n"] });
  await store.put("imports", { id: "f", name: "原件.txt", projectId: "p", content: "原件文字" });
  await store.put("imports", { id: "unowned", name: "未归属资料.txt", projectId: null });
  await store.put("links", { id: "l", sourceId: "f", sourceType: "import", targetId: "n", targetType: "note" });
  await store.put("attachments", { id: "f", importId: "f", noteId: "n" });
  await store.put("conversations", { id: "c", title: "课程讨论", projectId: "p", attachments: ["f"] });
  return store;
}

test("project archive preserves every child, original ownership and unowned material", async () => {
  const store = await fixture(), before = clone(store.state.records);
  const review = reviewRemoval(store, "projects:p");
  assert.equal(review.operation, "archive");
  assert.ok(review.relatedKeys.includes("conversations:c"));
  assert.ok(!review.relatedKeys.includes("imports:unowned"));
  const result = await removeRecord(store, review);
  assert.equal(result.recoveryKey, "projects:p");
  assert.equal(store.get("projects", "p").archived, true);
  for (const key of Object.keys(before).filter((key) => key !== "projects:p")) assert.deepEqual(store.state.records[key], before[key]);
  assert.equal(store.list("trash").length, 0);
  await restoreRecord(store, reviewRestore(store, result.recoveryKey));
  assert.equal(store.get("projects", "p").archived, false);
  assert.equal(store.get("projects", "p").status, "active");
});

test("review refuses a changed title, new project child or new synchronization conflict", async () => {
  for (const change of [
    (store) => store.put("projects", { ...store.get("projects", "p"), name: "新的项目名" }),
    (store) => store.put("tasks", { id: "new", title: "新子项", projectId: "p" }),
    (store) => store.tx((state) => { state.records["projects:p"].conflict = { version: 8, data: { id: "p", name: "远端" }, deleted: false }; }),
  ]) {
    const store = await fixture(), review = reviewRemoval(store, "projects:p");
    await change(store);
    const before = clone(store.state);
    await assert.rejects(removeRecord(store, review), /已变化/);
    assert.deepEqual(store.state, before);
  }
});

test("archived import remains in complete backups with original bytes and all references", async () => {
  const store = await fixture(), bytes = new TextEncoder().encode("归档后仍备份原件"), hash = await digest(bytes);
  await store.put("imports", { ...store.get("imports", "f"), blobHash: hash });
  await store.tx((state) => { state.blobs[hash] = { name: "原件.txt", uploaded: false }; });
  const relations = clone({ note: store.get("notes", "n"), link: store.get("links", "l"), conversation: store.get("conversations", "c") });
  const result = await removeRecord(store, reviewRemoval(store, "imports:f"));
  assert.equal(store.get("imports", "f").archived, true);
  assert.equal(store.state.records["imports:f"].deleted, false);
  assert.equal(store.state.blobs[hash].uploaded, false);
  assert.deepEqual({ note: store.get("notes", "n"), link: store.get("links", "l"), conversation: store.get("conversations", "c") }, relations);
  const zip = await createBackup(store, async () => bytes, digest);
  assert.deepEqual(unzipSync(zip)["blobs/" + hash], bytes);
  const target = await fresh();
  await restoreBackup(target, zip, { write: async (_hash, restored) => assert.deepEqual(restored, bytes) }, digest);
  assert.equal(target.get("imports", "f").archived, true);
  await restoreRecord(target, reviewRestore(target, result.recoveryKey));
  assert.equal(target.get("imports", "f").blobHash, hash);
  assert.equal(target.get("imports", "f").archived, false);
});

test("note deletion is atomic, keeps exact original, relationships and immutable in-flight operation", async () => {
  const store = await fixture(), original = store.get("notes", "n");
  const flight = { opId: "already-sent", entityType: "notes", entityId: "n", baseVersion: 4, data: original, deleted: false };
  await store.tx((state) => { Object.assign(state.records["notes:n"], { version: 4, flight }); });
  const unrelated = Object.fromEntries(Object.entries(clone(store.state.records)).filter(([key]) => key !== "notes:n"));
  const result = await removeRecord(store, reviewRemoval(store, "notes:n"));
  assert.equal(store.get("notes", "n"), null);
  assert.deepEqual(store.state.records["notes:n"].flight, flight);
  const trash = store.get("trash", result.trashId);
  assert.equal(trash.type, "content");
  assert.deepEqual(trash.data.notes, [original]);
  for (const [key, record] of Object.entries(unrelated)) assert.deepEqual(store.state.records[key], record);
  const reopened = await new Store(store.adapter).load();
  await restoreRecord(reopened, reviewRestore(reopened, result.recoveryKey));
  assert.deepEqual(reopened.get("notes", "n"), original);
  assert.deepEqual(reopened.state.records["notes:n"].flight, flight);
  assert.equal(reopened.get("trash", result.trashId), null);
});

test("disk failure rolls back both tombstone and trash record", async () => {
  const store = await fixture(), before = clone(store.state);
  store.adapter.write = async () => { throw Error("fixture disk full"); };
  await assert.rejects(removeRecord(store, reviewRemoval(store, "tasks:t")), /disk full/);
  assert.deepEqual(store.state, before);
});

test("restore rejects a new record using the same id and keeps trash intact", async () => {
  const store = await fixture();
  const removed = await removeRecord(store, reviewRemoval(store, "tasks:t"));
  const review = reviewRestore(store, removed.recoveryKey);
  await store.put("tasks", { id: "t", title: "后来创建的新内容", status: "done" });
  const before = clone(store.state);
  await assert.rejects(restoreRecord(store, review), /已变化/);
  assert.deepEqual(store.state, before);
  assert.throws(() => reviewRestore(store, removed.recoveryKey), /未覆盖/);
  assert.equal(listRecoverable(store).find((item) => item.key === removed.recoveryKey).canRestore, false);
});

test("restore detects updated trash payload and archived content rather than overwriting edits", async () => {
  const store = await fixture();
  const removed = await removeRecord(store, reviewRemoval(store, "notes:n"));
  const review = reviewRestore(store, removed.recoveryKey);
  const trash = store.get("trash", removed.trashId);
  trash.data.notes[0].content = "桌面修改后的回收记录";
  await store.put("trash", trash);
  await assert.rejects(restoreRecord(store, review), /已变化/);
  await removeRecord(store, reviewRemoval(store, "imports:f"));
  const archiveReview = reviewRestore(store, "imports:f");
  await store.put("imports", { ...store.get("imports", "f"), name: "归档后重新命名.txt" });
  await assert.rejects(restoreRecord(store, archiveReview), /已变化/);
  assert.equal(store.get("imports", "f").archived, true);
});

test("restoration with a missing project creates unowned content and preserves its space", async () => {
  const store = await fixture();
  const removed = await removeRecord(store, reviewRemoval(store, "notes:n"));
  await store.remove("projects", "p");
  const review = reviewRestore(store, removed.recoveryKey);
  assert.match(review.warnings.join(" "), /未归属/);
  await restoreRecord(store, review);
  assert.equal(store.get("notes", "n").projectId, null);
  assert.equal(store.get("notes", "n").workspace, "课程");
  await removeRecord(store, reviewRemoval(store, "imports:f"));
  await restoreRecord(store, reviewRestore(store, "imports:f"));
  assert.equal(store.get("imports", "f").projectId, null);
});

test("project ownership change after restore review is detected", async () => {
  const store = await fixture();
  const removed = await removeRecord(store, reviewRemoval(store, "notes:n"));
  const review = reviewRestore(store, removed.recoveryKey);
  await store.remove("projects", "p");
  await assert.rejects(restoreRecord(store, review), /已变化/);
  assert.equal(store.get("notes", "n"), null);
  assert.ok(store.get("trash", removed.trashId));
});

test("mobile task/note trash is accepted by the actual desktop recovery engine", async () => {
  const store = await fixture(), original = store.get("notes", "n");
  const removed = await removeRecord(store, reviewRemoval(store, "notes:n"));
  const desktop = Object.fromEntries(["projects", "tasks", "notes", "imports", "papers", "attachments", "links", "conversations", "trash"].map((kind) => [kind, store.list(kind).map(({ _key, _conflict, ...data }) => data)]));
  const outcome = DesktopLifecycle.restore(desktop, removed.trashId);
  assert.deepEqual(outcome.state.notes.find((note) => note.id === "n"), original);
  assert.equal(outcome.state.trash.length, 0);
  assert.equal(outcome.state.imports.length, 2);
  assert.deepEqual(outcome.state.links, desktop.links);
});

test("simple desktop task/note bundle can restore without overwriting retained links", async () => {
  const store = await fixture();
  await store.put("trash", { id: "from_desktop", type: "content", title: "桌面删除的笔记", deletedAt: 1,
    data: { notes: [{ id: "desktop_n", title: "桌面笔记", content: "完整内容", projectId: "p" }], links: [store.get("links", "l")], attachments: [] } });
  const result = await restoreRecord(store, reviewRestore(store, "from_desktop"));
  assert.ok(result.restored.includes("notes:desktop_n"));
  assert.equal(store.get("notes", "desktop_n").content, "完整内容");
  assert.equal(store.list("links").length, 1);
});

test("complex desktop trash remains visible and intact with an explicit desktop recovery reason", async () => {
  const store = await fixture();
  await store.put("trash", { id: "complex", type: "project", title: "完整项目", deletedAt: 5,
    data: { projects: [{ id: "old", name: "旧项目" }], imports: [{ id: "source", blobHash: "a".repeat(64) }] } });
  const before = clone(store.state);
  const item = listRecoverable(store).find((item) => item.key === "trash:complex");
  assert.equal(item.canRestore, false);
  assert.match(item.reason, /请在桌面恢复/);
  assert.throws(() => reviewRestore(store, item.key), /请在桌面恢复/);
  assert.deepEqual(store.state, before);
});

test("changes to only sync acknowledgements do not invalidate an unchanged human review", async () => {
  const store = await fixture(), review = reviewRemoval(store, "notes:n");
  await store.tx((state) => { const record = state.records["notes:n"]; record.version = 9; record.remote = clone(record.data); record.dirty = false; });
  await removeRecord(store, review);
  assert.equal(store.state.records["notes:n"].version, 9);
  assert.equal(store.state.records["notes:n"].deleted, true);
});

test("mutations require a review object and reject edited action payloads", async () => {
  const store = await fixture();
  await assert.rejects(removeRecord(store, "notes:n"), /确认/);
  await assert.rejects(restoreRecord(store, "projects:p"), /确认/);
  const review = reviewRemoval(store, "notes:n");
  review.before.data.content = "替换确认内容";
  await assert.rejects(removeRecord(store, review), /已变化/);
  assert.equal(store.get("notes", "n").content, "人工原文");
});
