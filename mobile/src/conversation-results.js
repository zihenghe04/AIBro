import { readEvent } from "./agenda.js";
import { reviewRestore } from "./lifecycle.js";
import { syncGroupSummaries } from "./sync-groups.js";

const kinds = { projects: "项目", tasks: "任务", notes: "笔记", agenda: "日程", imports: "资料" };
const operations = { create: "已新建", update: "已修改", remove: "已移入回收站", restore: "已恢复" };
const lifecycle = { archive: "已归档", trash: "已移入回收站", unarchive: "已恢复归档", "restore-trash": "已从回收站恢复" };
const archived = data => !!(data?.archived || data?.archivedAt || data?.status === "archived");
const stateOf = store => store.state || store;
const validID = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const physicalKind = kind => kind === "agenda" ? "notes" : kind;
const titleOf = data => data?.title || data?.name || data?.originalName || "未命名内容";

// Message IDs from older clients need not be globally unique. A DOM action
// carries both its conversation and its message, with the wire key when present.
export function conversationMessage(store, { conversationID, messageID, key } = {}) {
  if (!conversationID || !messageID) return null;
  const records = stateOf(store).records;
  const matches = (key ? [[key, records[key]]] : Object.entries(records)).filter(([recordKey, record]) =>
    recordKey.startsWith("messages:") && record && !record.deleted && record.data &&
    record.data.conversationId === conversationID && record.data.id === messageID);
  if (matches.length !== 1) return null;
  const [recordKey, record] = matches[0];
  return { ...record.data, _key: recordKey, _conflict: !!record.conflict };
}

export function inspectResultTarget(store, target) {
  if (!target || !Object.hasOwn(kinds, target.kind) || !validID(target.id))
    return { state: "missing", detail: "结果标识不可用" };
  const key = `${physicalKind(target.kind)}:${target.id}`, record = stateOf(store).records[key];
  if (!record || record.deleted || !record.data || record.data.deletedAt)
    return { state: "missing", key, detail: "这条内容已删除或尚未同步到此设备" };
  if (record.conflict) return { state: "conflict", key, detail: "这条内容有同步冲突，请先处理冲突" };
  const data = record.data, event = physicalKind(target.kind) === "notes" && readEvent(data);
  if (data.id !== target.id || (target.kind === "agenda" ? !event : target.kind === "notes" && event))
    return { state: "missing", key, detail: "内容类型已变化，请从列表确认" };
  if (archived(data)) return { state: "archived", key, detail: "当前已归档，关联内容保留" };
  return { state: "available", key, data, event, detail: "" };
}

function recoveryAvailable(store, key) {
  if (typeof key !== "string" || !/^(trash|projects|imports):[A-Za-z0-9_-]{1,200}$/.test(key)) return false;
  try { reviewRestore(store, key); return true; } catch { return false; }
}
function timeSummary(event) {
  if (!event) return "";
  try {
    const date = new Intl.DateTimeFormat("zh-CN", { timeZone: event.timeZone || "UTC", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
    return `${date.format(event.start)} — ${date.format(event.end)} · ${event.timeZone || "UTC"}`;
  } catch { return ""; }
}

// This is a read-only projection of persisted receipts. It never infers success
// from assistant prose and never treats a missing record as a new editor target.
export function conversationResults(store, message) {
  const m = conversationMessage(store, { conversationID: message?.conversationId, messageID: message?.id, key: message?._key });
  const plan = m?.pendingPlan;
  if (!m || m.role !== "assistant" || !plan || !validID(plan.id) || plan.conversationID !== m.conversationId) return null;
  const conversation = stateOf(store).records[`conversations:${m.conversationId}`];
  if (!conversation || conversation.deleted || !conversation.data || archived(conversation.data) || conversation.data.deletedAt) return null;
  const groups = syncGroupSummaries(stateOf(store)).filter(group => group.groupId === plan.syncGroupId || group.messageKey === m._key || group.keys.includes(m._key));
  if (m._conflict && !(plan.status === "applied" && groups.length)) return { state: "conflict", title: "消息存在同步冲突", detail: "先处理冲突，再查看或审阅这份方案。", items: [] };
  const states = {
    pending: ["待确认", "审阅并确认后才会修改工作区。"],
    rejected: ["未采用", "这份方案没有执行，原内容保留。"],
    invalidated: ["方案已失效", "原消息已修改，请重新发起请求。"],
  };
  if (states[plan.status]) {
    if (plan.status === "pending" && ["cancelled", "failed"].includes(m.status))
      return { state: "invalidated", title: "本次未执行", detail: "回复已停止或未完成，请重新发起请求。", items: [] };
    return { state: plan.status, title: states[plan.status][0], detail: states[plan.status][1], items: [] };
  }
  if (plan.status !== "applied" || !Array.isArray(plan.receipts) || !plan.receipts.length) return null;
  const items = [];
  for (const receipt of plan.receipts) {
    if (!receipt || !Object.hasOwn(operations, receipt.operation) || !validID(receipt.id)) continue;
    const targets = receipt.lifecycleOperation === "restore-trash" && Array.isArray(receipt.restored)
      ? receipt.restored.filter(target => Object.hasOwn(kinds, target?.kind) && validID(target.id)) : [receipt];
    for (const target of targets) {
      if (!Object.hasOwn(kinds, target?.kind)) continue;
      const identity = { kind: target.kind, id: target.id }, current = inspectResultTarget(store, identity);
      const recoveryKey = current.state === "archived" ? current.key : receipt.recoveryKey;
      const canRecover = current.state !== "available" && recoveryAvailable(store, recoveryKey);
      const action = lifecycle[receipt.lifecycleOperation] || operations[receipt.operation];
      const title = String(target.title || receipt.title || kinds[target.kind]);
      const currentTitle = current.data && titleOf(current.data);
      // A visible card may outlive a sync update while the composer has focus.
      // Bind its action to the message/plan/receipt and resolved destination,
      // never an array position. Content/title updates do not change identity.
      const key = JSON.stringify([m._key, m.conversationId, m.id, plan.id,
        receipt.operation, receipt.kind ?? null, receipt.id, receipt.lifecycleOperation ?? null,
        target.kind, target.id, receipt.recoveryKey ?? null,
        current.state === "available" ? "open" : canRecover ? "recover" : "unavailable",
        canRecover ? recoveryKey : null]);
      items.push({ key, title, kind: target.kind, action,
        detail: current.state === "available" ? [receipt.operation === "remove" ? "当前已恢复" : "", currentTitle !== title ? `当前名称：${currentTitle}` : "", timeSummary(current.event)].filter(Boolean).join(" · ") : current.detail,
        target: current.state === "available" ? identity : null,
        recoveryKey: canRecover ? recoveryKey : null,
        buttonLabel: current.state === "available" ? `打开${kinds[target.kind]}` : canRecover ? "审阅恢复" : null,
      });
    }
  }
  if (!items.length) return { state: "applied", title: "已确认", detail: "此历史回执没有可打开的结果，请从工作区列表确认。", items: [] };
  const detail = groups.some(group => group.status === "blocked") ? "已保存到本机，同步有冲突；请在同步详情中整组处理。"
    : groups.length ? "已保存到本机，等待整组同步。" : "已保存到本机；下方入口打开当前内容。";
  return { state: "applied", title: `已确认 · ${plan.receipts.length} 项操作`, detail, items };
}
