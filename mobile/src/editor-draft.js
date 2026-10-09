// Drafts retain the record the user actually started from. Reopening a draft
// must never silently replace that baseline with a newer synchronized record.
import { clone, equal } from "./store.js";
import { editedProject } from "./record-project.js";

export const EDITOR_DRAFT_FORMAT = "aibro.editor-draft.v1";
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const validKind = kind => kind === "note" || kind === "capture";
const identifier = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
// A legacy selection is an opaque, retained form option, not a project ID.
// editedProject remains responsible for rejecting any new alias assignment.
const projectSelection = value => {
  if (value === null || identifier(value)) return true;
  if (typeof value !== "string" || value.length > 12000 || !value.startsWith("legacy:")) return false;
  const encoded = value.slice(7);
  try { const name = decodeURIComponent(encoded); return !!name.trim() && encodeURIComponent(name) === encoded; }
  catch { return false; }
};
const validRecord = value => value === null || object(value) && identifier(value.id);
const fields = { note: ["title", "content"], capture: ["content", "tags", "projectId"] };
// Store.list adds view decorations, whereas Store.get/put retain pure records.
const recordData = value => {
  if (value === null) return null;
  const { _key, _conflict, ...data } = value;
  return clone(data);
};

function validValues(kind, values) {
  return object(values) && Object.keys(values).length === fields[kind].length
    && fields[kind].every(key => own(values, key))
    && typeof values.content === "string"
    && (kind === "note" ? typeof values.title === "string"
      : typeof values.tags === "string" && projectSelection(values.projectId));
}

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Capture raw form values without trimming or changing the original record. */
export function createEditorDraft(kind, base, values) {
  if (!validKind(kind) || !validRecord(base) || !validValues(kind, values))
    throw failure("EDITOR_DRAFT_INVALID", "草稿格式不完整，原输入没有改变");
  return { format: EDITOR_DRAFT_FORMAT, kind, base: recordData(base), values: clone(values) };
}

/**
 * `base` is deliberately absent for legacy/invalid/none, distinct from the
 * explicit null baseline of a new record. Inspection never mutates its inputs.
 * `current` must be Store.get() data, or null when the record is missing/new.
 */
export function inspectEditorDraft(kind, raw, current) {
  if (!validKind(kind) || !validRecord(current))
    throw failure("EDITOR_DRAFT_INVALID", "草稿或当前记录格式无效");
  current = recordData(current);
  const result = (state, data = {}) => ({ state, canSave: state === "ready", current: clone(current), ...data });
  if (raw === undefined || raw === null) return result("none", { values: null });
  if (object(raw) && own(raw, "format")) {
    if (raw.format !== EDITOR_DRAFT_FORMAT || raw.kind !== kind || !own(raw, "base")
        || !validRecord(raw.base) || !validValues(kind, raw.values))
      return result("invalid", { values: null, reason: "invalid-envelope" });
    const data = { base: recordData(raw.base), values: clone(raw.values) };
    if (equal(data.base, current)) return result("ready", data);
    const reason = raw.base === null ? "new-record-already-exists"
      : current === null ? "record-removed"
      : current.id !== raw.base.id ? "record-identity-changed" : "record-changed";
    return result("changed", { ...data, reason });
  }
  // Legacy capture drafts contained only text; they never captured tags or
  // ownership. Defaults make explicit Save As New independent of any new owner.
  if (kind === "capture" && typeof raw === "string")
    return result("legacy", { values: { content: raw, tags: "", projectId: null }, reason: "missing-base" });
  if (kind === "note" && validValues("note", raw))
    return result("legacy", { values: clone(raw), reason: "missing-base" });
  return result("invalid", { values: null, reason: "invalid-legacy-draft" });
}

/** Call again inside Store.tx before putRecord; UI-time inspection is not CAS. */
export function getEditorDraftWrite(kind, raw, current) {
  const inspected = inspectEditorDraft(kind, raw, current);
  if (!inspected.canSave) {
    const messages = {
      none: "没有可保存的草稿",
      changed: "原记录已变化。请查看最新内容，或将草稿另存为新资料；草稿仍保留。",
      legacy: "这份旧草稿没有原始版本。请查看最新内容，或另存为新资料；不会覆盖现有内容。",
      invalid: "草稿格式无法识别，未覆盖现有内容。",
    };
    throw failure("EDITOR_DRAFT_" + inspected.state.toUpperCase(), messages[inspected.state]);
  }
  return { base: inspected.base, values: inspected.values };
}

/**
 * An explicit UI choice, never automatic conflict resolution. Does not delete
 * the old draft or create a record/ID. The caller owns a new-record session and
 * validates selected project/attachments when eventually saving it.
 */
export function editorDraftAsNew(kind, raw) {
  const inspected = inspectEditorDraft(kind, raw, null);
  if (inspected.state === "none" || inspected.state === "invalid")
    throw failure("EDITOR_DRAFT_INVALID", "草稿格式无法识别，不能另存；原草稿仍保留。");
  return createEditorDraft(kind, null, inspected.values);
}

/** Build an explicitly requested copy. Persistence and draft-cleanup CAS stay
 * with the caller; neither the source record nor the stored draft is modified.
 */
export function editorDraftCopy(kind, raw, current, { id, now = Date.now(), projects = [] } = {}) {
  const inspected = inspectEditorDraft(kind, raw, current), values = inspected.values;
  if (!values || !identifier(id) || id === inspected.base?.id || id === inspected.current?.id
      || !Number.isFinite(now) || now < 0 || !Array.isArray(projects))
    throw failure("EDITOR_DRAFT_INVALID", "草稿或副本标识无效，原内容仍保留");
  // A known null baseline means a new draft; it must not inherit an unrelated
  // current record. Only legacy drafts may use current metadata as a fallback.
  const base = own(inspected, "base") ? inspected.base : inspected.current;
  const defaultWorkspace = kind === "capture" ? "日常" : "科研";
  const copy = { ...base, id, kind: kind === "capture" ? "随记" : base?.kind || "note",
    workspace: base?.workspace || defaultWorkspace,
    title: (kind === "capture" ? values.content.trim().split("\n")[0].slice(0, 70) : values.title) + "（草稿副本）",
    content: values.content, createdAt: now, updatedAt: now, userEdited: true, userEditedAt: now };
  if (kind === "capture") Object.assign(copy, {
    tags: values.tags.split(/[,，]/).map(value => value.trim()).filter(Boolean),
    ...editedProject(base, values.projectId, projects),
  });
  if (!copy.workspace) copy.workspace = defaultWorkspace;
  for (const field of ["archived", "archivedAt", "deleted", "deletedAt"]) delete copy[field];
  if (copy.status === "archived" || copy.status === "deleted") delete copy.status;
  return copy;
}
