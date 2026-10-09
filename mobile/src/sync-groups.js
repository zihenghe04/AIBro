// Durable, explicitly reviewed transactions. Never infer a group from dirty rows.
import { clone, equal, id } from "./store.js";

const validID = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const keyOf = item => `${item.entityType}:${item.entityId}`;
const split = key => ({ entityType: key.slice(0, key.indexOf(":")), entityId: key.slice(key.indexOf(":") + 1) });
const integer = value => Number.isSafeInteger(value) && value >= 0;
const wireSnapshot = (item, reading = false) => item && /^[a-z]+$/.test(item.entityType) && validID(item.entityId) &&
  integer(reading ? item.version : item.baseVersion) && typeof item.deleted === "boolean" &&
  (item.deleted ? item.data === null : reading && item.version === 0 && item.data === null ||
    item.data && typeof item.data === "object" && !Array.isArray(item.data));
const business = record => ({ data: record?.deleted ? null : clone(record?.data ?? null), deleted: !!record?.deleted });
const remoteOf = record => ({ version: record?.version || 0, deleted: !!record?.remoteDeleted, data: clone(record?.remote ?? null) });
// Match CloudStore.validate_operation before the approval transaction commits.
// The 16 MiB group envelope limit does not replace the per-record wire limits.
function validateEntityLimits(data) {
  const encoded = JSON.stringify(data);
  if (new TextEncoder().encode(encoded).byteLength > 4 * 1024 * 1024)
    throw Error("本次审阅的单条同步记录超过 4 MiB，尚未执行，请拆分方案或缩小内容");
  const pending = [[JSON.parse(encoded), 0]];
  let count = 0;
  while (pending.length) {
    const [value, depth] = pending.pop(); count++;
    if (depth > 32) throw Error("本次审阅的同步记录超过 32 层，尚未执行，请拆分方案或简化内容");
    const children = value && typeof value === "object" ? Object.values(value) : [];
    if (count + pending.length + children.length > 20000)
      throw Error("本次审阅的单条同步记录超过 20000 个字段值，尚未执行，请拆分方案或缩小内容");
    for (const child of children) pending.push([child, depth + 1]);
  }
}
const outgoingGroups = state => Object.values(state.syncGroups || {}).sort((a, b) =>
  (a.queueOrder || 0) - (b.queueOrder || 0) || a.createdAt - b.createdAt || a.groupId.localeCompare(b.groupId));
export const queuedGroupIds = state => outgoingGroups(state).map(group => group.groupId);
const allGroups = state => [...Object.values(state.syncGroups || {}).map(group => ({ ...group, direction: "outgoing" })),
  ...Object.values(state.syncIncomingGroups || {}).map(group => ({ ...group, direction: "incoming" }))];
const acknowledgedCursor = (base, ranges) => {
  let cursor = base;
  for (const range of ranges) {
    if (range.lastSeq <= cursor) continue;
    if (range.firstSeq > cursor + 1 || range.lastSeq !== range.firstSeq + range.count - 1) return null;
    cursor = range.lastSeq;
  }
  return cursor;
};

export function groupLocks(state) {
  return new Set(allGroups(state).flatMap(group => group.lockKeys));
}
export function syncGroupSummaries(state) {
  return allGroups(state).map(group => ({ groupId: group.groupId, direction: group.direction, status: group.status,
    reason: group.reason || "", count: group.lockKeys.length, keys: [...group.lockKeys],
    ...(group.planId ? { planId: group.planId, messageKey: group.messageKey } : {}) }));
}

export function validateSyncGroups(state) {
  for (const field of ["syncGroups", "syncIncomingGroups"]) {
    const groups = state[field];
    if (groups === undefined) continue; // Existing v1 workspaces migrate without fabricating groups.
    if (!groups || typeof groups !== "object" || Array.isArray(groups)) throw Error("同步操作组格式无效，原数据保留");
    for (const [groupId, group] of Object.entries(groups)) {
      if (!validID(groupId) || group?.groupId !== groupId || !["queued", "blocked"].includes(group.status) ||
          !Array.isArray(group.lockKeys) || !group.lockKeys.length || new Set(group.lockKeys).size !== group.lockKeys.length ||
          group.lockKeys.some(key => !/^[a-z]+:[A-Za-z0-9_-]{1,200}$/.test(key))) throw Error("同步操作组标识无效，原数据保留");
      if (field === "syncGroups") {
        const payload = group.payload;
        if (payload?.version !== 1 || payload.groupId !== groupId || !Array.isArray(payload.operations) ||
            !payload.operations.length || payload.operations.length > 100 || !Array.isArray(payload.readSet) || payload.readSet.length > 100 ||
            !Array.isArray(group.writeKeys) || !equal([...group.writeKeys].sort(), payload.operations.map(keyOf).sort()) ||
            new Set(payload.operations.map(op => op?.opId)).size !== payload.operations.length ||
            new Set(payload.operations.map(keyOf)).size !== payload.operations.length ||
            new Set(payload.readSet.map(keyOf)).size !== payload.readSet.length ||
            payload.operations.some(op => !validID(op?.opId) || !wireSnapshot(op) || !group.lockKeys.includes(keyOf(op))) ||
            payload.readSet.some(read => !wireSnapshot(read, true) || !group.lockKeys.includes(keyOf(read))) ||
            !equal([...group.lockKeys].sort(), [...new Set([...payload.operations, ...payload.readSet].map(keyOf))].sort()) ||
            Object.hasOwn(payload, "expectedCursor") && !integer(payload.expectedCursor)) throw Error("同步操作组快照无效，原数据保留");
      } else {
        validateEnvelope(group.envelope);
        if (group.status !== "blocked" || !equal([...group.lockKeys].sort(), group.envelope.changes.map(keyOf).sort())) throw Error("云端待比较组不完整，原数据保留");
      }
    }
  }
  const rangeValid = range => range && integer(range.firstSeq) && range.firstSeq > 0 && integer(range.lastSeq) &&
    Number.isSafeInteger(range.count) && range.count >= 1 && range.count <= 100 && range.lastSeq === range.firstSeq + range.count - 1;
  const groupAcks = state.settings?.syncGroupAcks;
  if (groupAcks !== undefined && (!Array.isArray(groupAcks) || groupAcks.some(ack => !validID(ack.groupId) || !rangeValid(ack)) ||
      new Set(groupAcks.map(ack => ack.groupId)).size !== groupAcks.length)) throw Error("整组同步确认范围无效，原数据保留");
  for (const field of ["syncNeedsPull", "syncLegacyPushAhead"]) if (state.settings?.[field] !== undefined && typeof state.settings[field] !== "boolean")
    throw Error("同步拉取状态无效，原数据保留");
  const orders = new Set();
  for (const group of outgoingGroups(state)) {
    if (group.predecessors === undefined) continue; // Previously stored independent groups have no chain.
    const { predecessors, pendingPredecessors, predecessorHeads, predecessorAcks } = group;
    if (!Number.isSafeInteger(group.queueOrder) || group.queueOrder < 1 || orders.has(group.queueOrder) || typeof group.sent !== "boolean" ||
        !Array.isArray(predecessors) || predecessors.some(parent => !validID(parent) || parent === group.groupId) ||
        new Set(predecessors).size !== predecessors.length || !Array.isArray(pendingPredecessors) ||
        new Set(pendingPredecessors).size !== pendingPredecessors.length || pendingPredecessors.some(parent => !predecessors.includes(parent)) ||
        !predecessorAcks || Array.isArray(predecessorAcks) || typeof predecessorAcks !== "object" ||
        Object.entries(predecessorAcks).some(([parent, ack]) => !predecessors.includes(parent) || pendingPredecessors.includes(parent) || !rangeValid(ack)) ||
        predecessors.some(parent => !pendingPredecessors.includes(parent) && !Object.hasOwn(predecessorAcks, parent)) ||
        group.sent && pendingPredecessors.length || !Array.isArray(predecessorHeads)) throw Error("同步前序队列不完整，原数据保留");
    orders.add(group.queueOrder);
    for (const parent of pendingPredecessors) {
      const earlier = state.syncGroups[parent];
      if (!earlier || (earlier.queueOrder || 0) >= group.queueOrder) throw Error("同步前序缺失或循环，原数据保留");
    }
    const readSet = new Map(group.payload.readSet.map(read => [keyOf(read), read]));
    if (new Set(predecessorHeads.map(head => head?.key)).size !== predecessorHeads.length) throw Error("同步前序目标重复，原数据保留");
    for (const head of predecessorHeads) {
      const read = readSet.get(head.key), parent = state.syncGroups[head.groupId], op = parent?.payload.operations.find(op => keyOf(op) === head.key);
      if (!predecessors.includes(head.groupId) || !read || !equal({ version: head.version, data: head.data, deleted: head.deleted },
        { version: read.version, data: read.data, deleted: read.deleted }) || parent && (!op || !equal(
        { version: op.baseVersion + 1, data: op.data, deleted: op.deleted }, { version: head.version, data: head.data, deleted: head.deleted })))
        throw Error("同步前序冻结结果不一致，原数据保留");
    }
    if (group.payload.operations.some(op => op.baseVersion !== readSet.get(keyOf(op))?.version)) throw Error("同步组读写基线不一致，原数据保留");
    if (Object.hasOwn(group.payload, "expectedCursor")) {
      if (!integer(group.cursorBase) || !Array.isArray(group.cursorAcknowledgements) ||
          group.cursorAcknowledgements.some(ack => !validID(ack.groupId) || !rangeValid(ack)) ||
          !Array.isArray(group.cursorPredecessors) || !equal(group.cursorPredecessors, predecessors)) throw Error("同步组游标证据不完整，原数据保留");
      const head = acknowledgedCursor(group.cursorBase, group.cursorAcknowledgements);
      const contribution = predecessors.reduce((sum, parent) => sum + (predecessorAcks[parent]?.count || state.syncGroups[parent]?.payload.operations.length || 0), 0);
      if (head === null || group.payload.expectedCursor !== head + contribution) throw Error("同步组游标贡献不一致，原数据保留");
    }
  }
}

// Called inside the same Store.tx that made the decision. beforeRecords is the
// exact pre-approval state; only that transaction's write set becomes operations.
export function freezeDecisionGroup(state, beforeRecords, { messageKey, plan, decision }) {
  const originalMessage = beforeRecords[messageKey];
  if (["running", "streaming"].includes(originalMessage?.data?.status)) throw Error("请等待当前答复完成后再确认修改");
  const writes = new Set(Object.keys(state.records).filter(key => !equal(business(beforeRecords[key]), business(state.records[key]))));
  writes.add(messageKey);
  const earlier = outgoingGroups(state);
  const heads = new Map(Object.entries(beforeRecords).map(([key, record]) => [key, remoteOf(record)])), headSources = new Map();
  for (const group of earlier) for (const op of group.payload.operations) {
    heads.set(keyOf(op), { version: op.baseVersion + 1, data: clone(op.data), deleted: op.deleted });
    headSources.set(keyOf(op), group.groupId);
  }
  const locks = new Set([...writes, "conversations:" + plan.conversationID]);
  if (plan.projectID) locks.add("projects:" + plan.projectID);
  for (const action of decision === "applied" ? plan.actions || [] : []) {
    for (const key of Object.keys(action.lifecycleReview?.dependencies || {})) locks.add(key);
    for (const key of action.lifecycleReview?.relatedKeys || []) locks.add(key);
  }
  // Freeze the identity/ownership dependencies used by validation, including
  // an offline conversation/project that has never reached the server.
  for (const key of locks) {
    const data = beforeRecords[key]?.data || state.records[key]?.data;
    for (const [field, kind] of [["projectId", "projects"], ["sourceConversationId", "conversations"], ["conversationId", "conversations"]])
      if (validID(data?.[field])) locks.add(`${kind}:${data[field]}`);
    if (!writes.has(key) && beforeRecords[key]?.dirty && !equal(business(beforeRecords[key]),
      { data: heads.get(key)?.data ?? null, deleted: heads.get(key)?.deleted || false })) writes.add(key);
  }
  const phantomSensitive = decision === "applied" && (plan.actions || []).some(action => action.operation === "remove");
  if (allGroups(state).some(group => group.status === "blocked" && (phantomSensitive || group.lockKeys.some(key => locks.has(key)))))
    throw Error("关联内容存在整组同步冲突，请先比较整个操作组后重新审阅");
  const cursorAcknowledgements = (state.settings.syncGroupAcks || []).filter(ack => ack.lastSeq > state.cursor).sort((a, b) => a.firstSeq - b.firstSeq);
  const cursorHead = acknowledgedCursor(state.cursor, cursorAcknowledgements);
  if (phantomSensitive && (cursorHead === null || state.settings.syncLegacyPushAhead || state.settings.syncNeedsPull && !cursorAcknowledgements.length))
    throw Error("云端写入尚未完成拉取确认，或出现其他设备写入，请先完成同步再审阅删除或归档方案");
  if ([...locks].some(key => beforeRecords[key]?.flight || beforeRecords[key]?.conflict) ||
      phantomSensitive && Object.values(beforeRecords).some(record => record.flight))
    throw Error("关联内容有尚未确认的同步操作，请先完成同步并重新审阅；本次修改尚未执行");
  if ([...locks].some(key => beforeRecords[key]?.version > 0 && !beforeRecords[key]?.remote && !beforeRecords[key]?.remoteDeleted))
    throw Error("关联内容缺少可验证的云端基线，请先完成同步后重新审阅；本次修改尚未执行");
  if (writes.size > 100 || locks.size > 100) throw Error("本次审阅的同步依赖超过整组限制，尚未执行，请缩小方案");
  const groupId = "group_" + id();
  const predecessors = earlier.filter(group => phantomSensitive || group.lockKeys.some(key => locks.has(key))).map(group => group.groupId);
  const predecessorHeads = [...locks].filter(key => headSources.has(key)).sort().map(key => ({ key, groupId: headSources.get(key), ...clone(heads.get(key)) }));
  state.records[messageKey].data.pendingPlan.syncGroupId = groupId;
  const payload = { version: 1, groupId,
    operations: [...writes].sort().map(key => ({ opId: id(), ...split(key), baseVersion: heads.get(key)?.version || 0,
      ...business(state.records[key]) })),
    readSet: [...locks].sort().map(key => ({ ...split(key), ...clone(heads.get(key) || remoteOf()) })),
    ...(phantomSensitive ? { expectedCursor: cursorHead + earlier.reduce((sum, group) => sum + group.payload.operations.length, 0) } : {}) };
  for (const snapshot of [...payload.operations, ...payload.readSet]) validateEntityLimits(snapshot.data);
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > 16 * 1024 * 1024)
    throw Error("本次修改的完整同步组超过 16 MB，尚未执行，请缩小方案");
  state.syncGroups ||= {};
  state.syncGroups[groupId] = { groupId, planId: plan.id, decision, messageKey, createdAt: Date.now(),
    queueOrder: Math.max(0, ...earlier.map(group => group.queueOrder || 0)) + 1,
    status: "queued", reason: predecessors.length ? "已保存到本机，等待前序操作组同步" : "已保存到本机，等待整组同步",
    payload, writeKeys: [...writes].sort(), lockKeys: [...locks].sort(), predecessors, pendingPredecessors: [...predecessors],
    predecessorHeads, predecessorAcks: {}, sent: false,
    ...(phantomSensitive ? { cursorBase: state.cursor, cursorPredecessors: [...predecessors], cursorAcknowledgements: clone(cursorAcknowledgements) } : {}) };
  return groupId;
}

function blockGroup(state, groupId, reason) {
  const blocked = new Set([groupId]);
  let progress = true;
  while (progress) {
    progress = false;
    for (const group of Object.values(state.syncGroups || {})) if (blocked.has(group.groupId) || (group.predecessors || []).some(parent => blocked.has(parent))) {
      if (!blocked.has(group.groupId)) { blocked.add(group.groupId); progress = true; }
      group.status = "blocked"; group.reason = group.groupId === groupId ? reason : "前序操作组未能同步，后继修改完整保留；请一起比较";
      group.remoteReady = false; group.remoteCursor = 0;
    }
  }
}

// The queued payload already contains projected versions from known frozen
// predecessors. Only exact predecessor acknowledgements authorize its first send.
export function prepareGroupSend(state, groupId) {
  const group = state.syncGroups?.[groupId];
  if (!group || group.status !== "queued" || group.pendingPredecessors?.length) return null;
  if (!group.sent && group.payload.readSet.some(read => {
    const record = state.records[keyOf(read)], remote = remoteOf(record);
    return record?.flight || record?.conflict || !equal(remote, { version: read.version, data: read.data, deleted: read.deleted });
  })) {
    blockGroup(state, groupId, "前序确认后的云端基线与审批时冻结结果不同；未上传此组，请重新比较");
    return null;
  }
  group.sent = true;
  return clone(group.payload);
}

export function acknowledgeGroup(state, groupId, result) {
  const group = state.syncGroups?.[groupId];
  if (!group || result?.version !== 1 || result.groupId !== groupId || !integer(result.cursor) ||
      !["accepted", "conflict"].includes(result.status) || !Array.isArray(result.accepted) || !Array.isArray(result.conflicts))
    throw Error("整组同步响应无效，保留完整重试队列");
  if (result.status === "conflict") {
    if (result.accepted.length || !result.conflicts.length && !result.cursorConflict) throw Error("整组冲突响应无效，保留完整重试队列");
    blockGroup(state, groupId, "云端目标或依赖已变化；整组尚未上传，请比较整组内容");
    group.conflict = clone(result);
    group.remoteReady = false;
    return;
  }
  const acks = new Map(result.accepted.map(ack => [ack.opId, ack]));
  if (result.cursor < group.payload.operations.length || result.conflicts.length || acks.size !== group.payload.operations.length || result.accepted.length !== acks.size ||
      group.payload.operations.some(op => {
        const ack = acks.get(op.opId);
        return !ack || keyOf(ack) !== keyOf(op) || ack.version !== op.baseVersion + 1;
      })) throw Error("服务器未确认完整操作组，保留完整重试队列");
  for (const op of group.payload.operations) {
    const record = state.records[keyOf(op)];
    if (!record) throw Error("整组本机记录缺失，未处理确认");
    record.version = acks.get(op.opId).version; record.remote = clone(op.data); record.remoteDeleted = op.deleted;
    record.flight = null; record.conflict = null;
    record.dirty = !equal(business(record), { data: op.data, deleted: op.deleted });
  }
  state.settings.syncNeedsPull = true;
  const acknowledgement = { firstSeq: result.cursor - group.payload.operations.length + 1, lastSeq: result.cursor, count: group.payload.operations.length };
  state.settings.syncGroupAcks = [...(state.settings.syncGroupAcks || []), { groupId, ...acknowledgement }];
  for (const successor of Object.values(state.syncGroups)) if (successor.predecessors?.includes(groupId)) {
    successor.pendingPredecessors = successor.pendingPredecessors.filter(parent => parent !== groupId);
    successor.predecessorAcks[groupId] = clone(acknowledgement);
    if (successor.cursorPredecessors) {
      let cursor = acknowledgedCursor(successor.cursorBase, successor.cursorAcknowledgements || []);
      for (const parent of successor.cursorPredecessors) {
        const ack = successor.predecessorAcks[parent];
        if (!ack) break;
        if (ack.firstSeq !== cursor + 1 || ack.lastSeq !== cursor + ack.count) {
          blockGroup(state, successor.groupId, "前序同步之间出现了其他设备写入，删除或归档的审阅基线已变化；后继组未上传"); break;
        }
        cursor = ack.lastSeq;
      }
    }
  }
  delete state.syncGroups[groupId];
}

function validateChange(change) {
  if (!change || !integer(change.seq) || !change.seq || !integer(change.version) || !change.version ||
      !/^[a-z]+$/.test(change.entityType) || !validID(change.entityId) || typeof change.deleted !== "boolean" ||
      (change.deleted ? change.data !== null : !change.data || typeof change.data !== "object" || Array.isArray(change.data)))
    throw Error("云端同步记录格式无效，游标未推进");
}
export function validateEnvelope(envelope) {
  if (envelope?.type !== "atomic-group" || !validID(envelope.groupId) || !Array.isArray(envelope.changes) ||
      !envelope.changes.length || envelope.changes.length > 100 || !integer(envelope.firstSeq) ||
      envelope.lastSeq !== envelope.firstSeq + envelope.changes.length - 1 ||
      new Set(envelope.changes.map(keyOf)).size !== envelope.changes.length) throw Error("云端操作组不完整，游标未推进");
  envelope.changes.forEach((change, index) => {
    validateChange(change);
    if (change.seq !== envelope.firstSeq + index) throw Error("云端操作组序列不连续，游标未推进");
  });
}

function conflictRecord(state, change, { refreshHead = false } = {}) {
  const key = keyOf(change);
  const record = state.records[key] ||= { version: 0, remote: null, remoteDeleted: false, data: null, deleted: true, dirty: false };
  const known = record.conflict || remoteOf(record), current = Math.max(record.version, record.conflict?.version || 0);
  if (change.version > current || refreshHead && change.version === current &&
      !equal(known, { version: change.version, deleted: change.deleted, data: change.data }))
    record.conflict = { version: change.version, deleted: change.deleted, data: clone(change.data) };
}
function applyChange(state, change, locks) {
  validateChange(change);
  const key = keyOf(change), record = state.records[key];
  if (record && change.version <= record.version) return;
  if (record?.dirty || record?.flight || record?.conflict || locks.has(key)) {
    conflictRecord(state, change);
    for (const group of Object.values(state.syncGroups || {})) if (group.lockKeys.includes(key))
      blockGroup(state, group.groupId, "云端记录与待上传方案的冻结基线不同；整组保留，需一起比较");
  }
  else state.records[key] = { data: clone(change.data), deleted: change.deleted, version: change.version,
    remote: clone(change.data), remoteDeleted: change.deleted, dirty: false };
}

export function applyPullPage(state, result, { grouped = false } = {}) {
  if (!Array.isArray(result.changes) || !integer(result.cursor) || result.cursor < state.cursor ||
      typeof result.hasMore !== "boolean" || grouped && result.version !== 1 || result.hasMore && result.cursor === state.cursor)
    throw Error("同步游标异常，未修改本机内容");
  let previous = state.cursor;
  for (const item of result.changes) {
    if (item?.type === "atomic-group") {
      if (!grouped) throw Error("服务器返回未协商的操作组");
      validateEnvelope(item);
      if (item.lastSeq <= previous || item.firstSeq > previous + 1 || item.lastSeq > result.cursor) throw Error("同步操作组游标不连续");
      const locks = groupLocks(state);
      const blocked = item.changes.some(change => {
        const record = state.records[keyOf(change)];
        return change.version > (record?.version || 0) && (record?.dirty || record?.flight || record?.conflict || locks.has(keyOf(change)));
      });
      if (blocked) {
        state.syncIncomingGroups = { ...state.syncIncomingGroups, [item.groupId]: { groupId: item.groupId, status: "blocked", createdAt: Date.now(),
          reason: "云端整组修改与本机内容重叠；尚未应用任何组成员", envelope: clone(item), lockKeys: item.changes.map(keyOf).sort() } };
        for (const change of item.changes) conflictRecord(state, change);
        for (const group of Object.values(state.syncGroups || {})) if (group.lockKeys.some(key => item.changes.some(change => keyOf(change) === key)))
          blockGroup(state, group.groupId, "云端整组修改与待上传方案重叠，需整组审阅");
      } else for (const change of item.changes) applyChange(state, change, locks);
      previous = item.lastSeq;
    } else {
      validateChange(item);
      if (item.seq !== previous + 1 || item.seq > result.cursor) throw Error("同步记录游标异常");
      applyChange(state, item, groupLocks(state)); previous = item.seq;
    }
  }
  if (previous !== result.cursor) throw Error("同步页末游标异常");
  state.cursor = result.cursor;
  state.settings.syncGroupAcks = (state.settings.syncGroupAcks || []).filter(ack => ack.lastSeq > state.cursor);
  if (!result.hasMore) { state.settings.syncNeedsPull = false; state.settings.syncLegacyPushAhead = false; }
}

// Refresh all remote heads after a blocked push, including absent rows and old
// rows below the normal cursor. This is a read-only replay, not a local rebase.
export function refreshGroupHeads(state, result, { grouped = true, fromCursor = 0 } = {}) {
  if (grouped && result?.version !== 1 || !Array.isArray(result.changes) || !integer(result.cursor) || typeof result.hasMore !== "boolean")
    throw Error("整组云端比较响应无效");
  const locks = groupLocks(state);
  let previous = fromCursor;
  for (const item of result.changes) {
    const changes = item.type === "atomic-group" ? (validateEnvelope(item), item.changes) : [item];
    if (item.type === "atomic-group" ? item.firstSeq > previous + 1 || item.lastSeq <= previous : item.seq !== previous + 1)
      throw Error("整组云端比较记录不连续");
    for (const change of changes) {
      validateChange(change);
      if (locks.has(keyOf(change))) conflictRecord(state, change, { refreshHead: true });
    }
    previous = item.type === "atomic-group" ? item.lastSeq : item.seq;
  }
  if (previous !== result.cursor || result.hasMore && previous === fromCursor) throw Error("整组云端比较游标异常");
  for (const group of Object.values(state.syncGroups || {})) if (group.status === "blocked" && !group.remoteReady && (group.remoteCursor || 0) <= fromCursor) {
    group.remoteCursor = result.cursor;
    if (!result.hasMore) group.remoteReady = true;
  }
}

export function syncGroupReview(state, groupId) {
  const groups = allGroups(state), selected = groups.find(group => group.groupId === groupId);
  if (!selected || selected.status !== "blocked") throw Error("此操作组没有待处理冲突");
  const chosen = new Map([[groupId, selected]]), keys = new Set(selected.lockKeys);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const group of groups) if (!chosen.has(group.groupId) &&
        (group.lockKeys.some(key => keys.has(key)) || (group.predecessors || []).some(parent => chosen.has(parent)))) {
      chosen.set(group.groupId, group); group.lockKeys.forEach(key => keys.add(key)); expanded = true;
    }
  }
  if ([...chosen.values()].some(group => group.direction === "outgoing" && !group.remoteReady)) throw Error("整组云端内容尚未读取完整，请先同步后再比较");
  return { groupId, direction: selected.direction, status: selected.status, reason: selected.reason,
    groupIds: [...chosen.keys()].sort(), groups: [...chosen.values()].sort((a, b) => a.groupId.localeCompare(b.groupId)),
    records: [...keys].sort().map(key => { const record = state.records[key]; return { key, local: business(record),
      remote: clone(record?.conflict || remoteOf(record)) }; }) };
}

export function resolveSyncGroup(state, groupId, choice, expectedReview) {
  if (choice !== "remote") throw Error("整组冲突不能自动覆盖云端；请比较后采用整组云端内容，再重新生成并审阅修改");
  if (!expectedReview || !equal(syncGroupReview(state, groupId), expectedReview)) throw Error("整组内容或后续本机修改已变化，请重新打开比较；原数据保留");
  for (const { key, remote } of expectedReview.records) state.records[key] = { version: remote.version, remote: clone(remote.data),
    remoteDeleted: remote.deleted, data: clone(remote.data), deleted: remote.deleted || remote.data === null, dirty: false, flight: null, conflict: null };
  for (const member of expectedReview.groupIds) { delete state.syncGroups?.[member]; delete state.syncIncomingGroups?.[member]; }
}
