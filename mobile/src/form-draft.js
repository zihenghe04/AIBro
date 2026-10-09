// Task/calendar form input is local-only. Keep the complete record the user
// began editing; a later sync must not silently become the draft's baseline.
import { clone, equal } from "./store.js";

export const FORM_DRAFT_FORMAT = "aibro.form-draft.v1";
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const kinds = new Set(["task", "event"]);
const fields = {
  task: ["title", "description", "status", "priority", "due", "start", "reminder", "project"],
  event: ["title", "start", "end", "location", "reminder", "project", "details", "frequency", "repeatInterval", "repeatCount", "repeatUntil"],
};
const validRecord = value => value === null || object(value) && identifier(value.id);
const recordData = value => {
  if (value === null) return null;
  const { _key, _conflict, ...data } = value;
  return clone(data);
};
const failure = (code, message) => Object.assign(new Error(message), { code });
function validValues(kind, values) {
  if (!object(values) || !fields[kind].every(key => typeof values[key] === "string")) return false;
  if (kind === "task") return Object.keys(values).length === fields.task.length + 1
    && Array.isArray(values.checklist) && values.checklist.every(row => object(row)
      && Object.keys(row).length === 3 && (row.index === null || Number.isSafeInteger(row.index) && row.index >= 0)
      && typeof row.text === "string" && typeof row.done === "boolean");
  return Object.keys(values).length === fields.event.length + 2 && typeof values.weekdaysEdited === "boolean"
    && Array.isArray(values.repeatDays) && values.repeatDays.every(day => typeof day === "string" && /^[1-7]$/.test(day));
}
function validContext(kind, context) {
  if (!object(context)) return false;
  if (kind === "task") return Object.keys(context).length === 0;
  if (Object.keys(context).length !== 2 || !own(context, "sourceID")
      || context.sourceID !== null && !identifier(context.sourceID) || typeof context.timeZone !== "string") return false;
  try { new Intl.DateTimeFormat("en", { timeZone: context.timeZone }); return !!context.timeZone; } catch { return false; }
}
export function formDraftKey(kind, recordID = null, { scopeID = null } = {}) {
  if (!kinds.has(kind) || recordID !== null && !identifier(recordID) || scopeID !== null && !identifier(scopeID))
    throw failure("FORM_DRAFT_INVALID", "表单草稿标识无效");
  return `form:${kind}:` + (recordID ? `record:${recordID}` : `new${scopeID ? ":" + scopeID : ""}`);
}
export function createFormDraft(kind, base, values, context = {}) {
  if (!kinds.has(kind) || !validRecord(base) || !validValues(kind, values) || !validContext(kind, context))
    throw failure("FORM_DRAFT_INVALID", "草稿格式不完整，原输入没有改变");
  return { format: FORM_DRAFT_FORMAT, kind, base: recordData(base), values: clone(values), context: clone(context) };
}
export function inspectFormDraft(kind, raw, current) {
  if (!kinds.has(kind) || !validRecord(current)) throw failure("FORM_DRAFT_INVALID", "草稿或当前记录格式无效");
  current = recordData(current);
  const result = (state, data = {}) => ({ state, canSave: state === "ready", current: clone(current), ...data });
  if (raw == null) return result("none", { values: null });
  if (!object(raw) || raw.format !== FORM_DRAFT_FORMAT || raw.kind !== kind || !own(raw, "base")
      || !validRecord(raw.base) || !validValues(kind, raw.values) || !validContext(kind, raw.context))
    return result("invalid", { values: null });
  const data = { base: recordData(raw.base), values: clone(raw.values), context: clone(raw.context) };
  if (current && (current.archived || current.deleted || current.deletedAt || ["archived", "deleted"].includes(current.status)))
    return result("changed", { ...data, reason: "record-unavailable" });
  if (equal(data.base, current)) return result("ready", data);
  return result("changed", { ...data, reason: data.base === null ? "new-record-already-exists"
    : current === null ? "record-removed" : current.id !== data.base.id ? "record-identity-changed" : "record-changed" });
}
// Recheck inside Store.tx before putRecord. An inspection before an await is
// insufficient: sync may have changed or removed the record in the meantime.
export function getFormDraftWrite(kind, raw, current) {
  const view = inspectFormDraft(kind, raw, current);
  if (!view.canSave) throw failure("FORM_DRAFT_" + view.state.toUpperCase(), view.state === "changed"
    ? "原内容已变化，未覆盖最新记录。请查看最新内容；你的草稿仍保留。" : "草稿暂时无法保存，原内容没有改变。");
  return { base: view.base, values: view.values, context: view.context };
}
// Call in the same transaction as the successful record write, or after an
// explicit discard. Never clear newer input queued while a save was pending.
export function clearFormDraft(state, key, expected) {
  if (!/^form:(task|event):/.test(key) || !state?.drafts || !expected || !equal(state.drafts[key], expected)) return false;
  delete state.drafts[key];
  return true;
}
