import { clone, equal, id, putRecord } from "./store.js";

const supported = new Set(["projects", "tasks", "notes", "imports"]);
const restorableCollections = new Set(["tasks", "notes", "links", "attachments"]);
const labels = { projects: "项目", tasks: "任务", notes: "笔记", imports: "资料" };
const validID = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const list = (value) => Array.isArray(value) ? value : [];
const titleOf = (data) => String(data?.title || data?.name || data?.originalName || "未命名内容");
const archived = (data) => !!(data?.archived || data?.archivedAt || data?.status === "archived");
const present = (record) => !!record && !record.deleted && !!record.data;
const snapshot = (record) => record ? { data: clone(record.data), deleted: !!record.deleted, conflict: clone(record.conflict || null) } : null;
const changed = () => Error("内容或关联已变化，请重新打开确认；没有覆盖新内容。");
const stateOf = (store) => store.state || store;

function splitKey(key) {
  if (typeof key !== "string") throw Error("内容标识无效");
  const [kind, identifier, extra] = key.split(":");
  if (extra !== undefined || !validID(identifier)) throw Error("内容标识无效");
  return [kind, identifier];
}

function currentRecord(state, key) {
  const record = state.records[key];
  if (!present(record)) throw Error("内容已不存在，请刷新后重试");
  if (record.conflict) throw Error("请先处理这条内容的同步冲突");
  return record;
}

function references(data, kind, identifier) {
  if (kind === "projects") return data.projectId === identifier;
  if (kind === "imports") return [data.sourceAttachmentId, data.importId,
    ...list(data.sourceAttachmentIds), ...list(data.attachmentIds), ...list(data.attachments)]
    .some((value) => value === identifier || value?.id === identifier);
  if (kind === "notes") return data.noteId === identifier ||
    [...list(data.sourceNoteIds), ...list(data.relatedNoteIds)].includes(identifier);
  return data.taskId === identifier || list(data.dependsOn).includes(identifier);
}

function retainedRelations(state, key, kind, identifier) {
  return Object.entries(state.records)
    .filter(([otherKey, record]) => otherKey !== key && present(record) && !otherKey.startsWith("trash:") &&
      (references(record.data, kind, identifier) ||
       ((otherKey.startsWith("links:") || otherKey.startsWith("attachments:")) &&
        (record.data.sourceId === identifier || record.data.targetId === identifier))))
    .map(([key, record]) => ({ key, title: titleOf(record.data) }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function removalReview(state, key) {
  const [kind, identifier] = splitKey(key);
  if (!supported.has(kind)) throw Error("此类内容请在桌面管理");
  const record = currentRecord(state, key);
  if (archived(record.data) || record.data.deletedAt || record.data.deleted)
    throw Error("内容已经归档或停用，请从恢复入口查看");
  const retained = retainedRelations(state, key, kind, identifier);
  const operation = ["projects", "imports"].includes(kind) ? "archive" : "trash";
  const counts = Object.fromEntries([...supported].map((name) => [name, 0]));
  for (const relation of retained) {
    const name = relation.key.split(":")[0];
    if (Object.hasOwn(counts, name)) counts[name]++;
  }
  const warnings = operation === "archive"
    ? kind === "projects"
      ? ["仅归档项目。项目内任务、笔记、资料和对话全部保留，原归属不变，可随时恢复项目。"]
      : ["仅归档资料。原件、备份和同步记录保留；原有引用不改写，可随时恢复资料。"]
    : ["仅将本条内容移入回收站。来源原件、关联记录和其他内容全部保留。"];
  if (retained.length) warnings.push(`${retained.length} 条关联内容或关系会保留。`);
  return { schema: 1, action: "remove", operation, key, kind, title: titleOf(record.data),
    before: snapshot(record), counts, relatedKeys: retained.map((item) => item.key), retained, warnings };
}

export function reviewRemoval(store, key) {
  return removalReview(stateOf(store), key);
}

function tombstone(state, key) {
  const record = state.records[key];
  record.data = null;
  record.deleted = true;
  record.dirty = true;
  // Keep remote/version/flight: a prior immutable sync operation still needs acknowledgement.
}

export async function removeRecord(store, review) {
  const expected = clone(review);
  return store.tx((state) => applyRemovalReview(state, expected));
}

// The Agent uses the same CAS checks on an ephemeral plan overlay, then commits
// that overlay in one Store transaction. These helpers never persist by themselves.
export function applyRemovalReview(state, review, { now = Date.now(), trashId = "trash_" + id() } = {}) {
  if (!Number.isSafeInteger(now) || now < 0) throw Error("操作时间无效");
  const expected = clone(review);
  if (expected?.action !== "remove") throw Error("请先查看删除或归档确认");
  let current;
  try { current = removalReview(state, expected.key); } catch { throw changed(); }
  if (!equal(current, expected)) throw changed();
  const original = clone(state.records[current.key].data);
  if (current.operation === "archive") {
    putRecord(state, current.kind, { ...original, archived: true, updatedAt: now }, original);
    return { key: current.key, recoveryKey: current.key, operation: "archive", title: current.title };
  }
  if (!validID(trashId) || state.records["trash:" + trashId]) throw Error("回收记录标识已存在，请重新生成方案");
  const trashID = trashId;
  const counts = { total: 1, task: current.kind === "tasks" ? 1 : 0, note: current.kind === "notes" ? 1 : 0, import: 0, paper: 0 };
  putRecord(state, "trash", { id: trashID, type: "content", title: current.title, deletedAt: now,
    counts, data: { [current.kind]: [original], links: [], attachments: [] } });
  tombstone(state, current.key);
  return { key: current.key, recoveryKey: "trash:" + trashID, trashId: trashID, operation: "trash", title: current.title };
}

function trashContents(entry) {
  if (!entry?.data || typeof entry.data !== "object" || Array.isArray(entry.data)) throw Error("回收站记录格式无效，内容仍保留");
  const entries = [], seen = new Set();
  for (const [kind, values] of Object.entries(entry.data)) {
    if (Array.isArray(values) && values.length === 0) continue;
    if (!restorableCollections.has(kind) || !Array.isArray(values))
      throw Error("此回收记录包含项目、原件或复杂关系，请在桌面恢复；记录仍保留");
    for (const data of values) {
      if (!data || typeof data !== "object" || !validID(data.id)) throw Error("回收站记录标识无效，内容仍保留");
      const key = `${kind}:${data.id}`;
      if (seen.has(key)) throw Error("回收站记录标识重复，内容仍保留");
      seen.add(key);
      entries.push({ key, kind, data: clone(data) });
    }
  }
  if (!entries.length) throw Error("此回收记录没有可恢复内容");
  return entries;
}

function restoreReview(state, rawKey) {
  const key = rawKey?.includes(":") ? rawKey : "trash:" + rawKey;
  const [kind] = splitKey(key), record = currentRecord(state, key);
  const warnings = [], dependencies = {}, entries = [];
  if (kind !== "trash") {
    if (!supported.has(kind) || !archived(record.data) || record.data.deletedAt || record.data.deleted)
      throw Error("此内容当前无法从归档恢复");
    const after = clone(record.data);
    after.archived = false;
    delete after.archivedAt;
    if (after.status === "archived") {
      if (kind === "projects") after.status = "active";
      else delete after.status;
    }
    if (kind !== "projects" && after.projectId) {
      const projectKey = "projects:" + after.projectId, project = state.records[projectKey];
      dependencies[projectKey] = snapshot(project);
      if (project?.conflict) throw Error("原项目有同步冲突，请先处理冲突");
      if (!present(project)) {
        after.projectId = null;
        after.project = null;
        warnings.push("原项目已不存在，将恢复到原空间的未归属内容。");
      } else if (archived(project.data) || project.data.deletedAt) {
        warnings.push("原项目已归档，内容会保留原归属；可随后恢复项目。");
      }
    }
    return { schema: 1, action: "restore", operation: "unarchive", key, kind,
      title: titleOf(record.data), before: snapshot(record), after, dependencies,
      warnings: warnings.length ? warnings : ["恢复此内容并保留当前资料及原归属。"] };
  }
  for (const entry of trashContents(record.data)) {
    const target = state.records[entry.key];
    dependencies[entry.key] = snapshot(target);
    if (target?.conflict) throw Error("待恢复内容有同步冲突，请先处理冲突");
    if (present(target) && !equal(target.data, entry.data))
      throw Error("已有同标识的新内容，未覆盖；原记录仍在回收站");
    let data = clone(entry.data);
    if (["tasks", "notes"].includes(entry.kind) && data.projectId) {
      const projectKey = "projects:" + data.projectId, project = state.records[projectKey];
      dependencies[projectKey] = snapshot(project);
      if (project?.conflict) throw Error("原项目有同步冲突，请先处理冲突");
      if (!present(project)) {
        data.projectId = null;
        data.project = null;
        warnings.push("原项目已不存在，将恢复到原空间的未归属内容。");
      } else if (archived(project.data) || project.data.deletedAt) {
        warnings.push("原项目已归档，内容会保留原归属；可随后恢复项目。");
      }
    }
    entries.push({ ...entry, data });
  }
  return { schema: 1, action: "restore", operation: "restore-trash", key, kind,
    title: titleOf(record.data), before: snapshot(record), dependencies, entries,
    warnings: [...new Set(warnings)] };
}

export function reviewRestore(store, key) {
  return restoreReview(stateOf(store), key);
}

export async function restoreRecord(store, review) {
  const expected = clone(review);
  return store.tx((state) => applyRestoreReview(state, expected));
}

export function applyRestoreReview(state, review, { now = Date.now() } = {}) {
  if (!Number.isSafeInteger(now) || now < 0) throw Error("操作时间无效");
  const expected = clone(review);
  if (expected?.action !== "restore") throw Error("请先查看恢复确认");
  let current;
  try { current = restoreReview(state, expected.key); } catch { throw changed(); }
  if (!equal(current, expected)) throw changed();
  if (current.operation === "unarchive") {
    const original = state.records[current.key].data;
    const restored = { ...current.after, updatedAt: now };
    putRecord(state, current.kind, restored, original);
    return { key: current.key, restored: [current.key], warnings: current.warnings };
  }
  const restored = [];
  for (const entry of current.entries) {
    if (!present(state.records[entry.key])) putRecord(state, entry.kind, entry.data);
    restored.push(entry.key);
  }
  tombstone(state, current.key);
  return { key: current.key, restored, warnings: current.warnings };
}

export function listRecoverable(store) {
  const state = stateOf(store), items = [];
  for (const [key, record] of Object.entries(state.records)) {
    if (!present(record)) continue;
    const kind = key.split(":")[0];
    if (kind !== "trash" && !(supported.has(kind) && archived(record.data))) continue;
    let canRestore = true, reason = "";
    try { restoreReview(state, key); } catch (error) { canRestore = false; reason = error.message; }
    items.push({ key, id: record.data.id, kind, title: titleOf(record.data),
      label: kind === "trash" ? "回收站" : `已归档${labels[kind]}`,
      time: record.data.deletedAt || record.data.updatedAt || record.data.archivedAt || 0,
      canRestore, reason });
  }
  return items.sort((a, b) => b.time - a.time || a.key.localeCompare(b.key));
}
