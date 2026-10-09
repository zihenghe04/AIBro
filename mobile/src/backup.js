import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { empty, equal, validateState } from "./store.js";
import { validateSyncGroups, validateEnvelope } from "./sync-groups.js";
const limit = 128 * 1024 * 1024;
const validID = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value && typeof value === "object" && !Array.isArray(value);
const recordFields = ["data", "deleted", "version", "remote", "remoteDeleted", "dirty", "flight", "conflict"];
const hasGroups = state => Object.keys(state.syncGroups || {}).length || Object.keys(state.syncIncomingGroups || {}).length;
const restoreEmpty = state => !Object.keys(state.records).length && !state.binding && !hasGroups(state);
// Only durable synchronization evidence belongs in a checkpoint. Connection
// configuration, API credentials and every other device setting stay local.
const checkpointSettings = ["syncGroupAcks", "syncNeedsPull", "syncLegacyPushAhead"];
const chainFields = ["predecessors", "pendingPredecessors", "predecessorHeads", "predecessorAcks", "queueOrder", "sent"];
const cursorFields = ["cursorBase", "cursorPredecessors", "cursorAcknowledgements"];
function fields(value, allowed, required = []) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key)))
    throw Error("同步检查点含未知、凭据或不完整字段，未恢复");
}
function identity(binding) {
  if (binding === null) return null;
  fields(binding, ["base", "username", "accountID"], ["base", "username", "accountID"]);
  let url;
  try { url = new URL(binding.base); } catch { throw Error("同步检查点账号绑定无效"); }
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) ||
      url.username || url.password || url.search || url.hash || url.href.replace(/\/$/, "") !== binding.base ||
      typeof binding.username !== "string" || !/^[^\s\x00-\x1f\x7f/\\:]{1,80}$/.test(binding.username) || !validID(binding.accountID))
    throw Error("同步检查点账号绑定无效");
  return binding;
}
function remote(value, versionField = "version") {
  fields(value, [versionField, "deleted", "data"], [versionField, "deleted", "data"]);
  if (!integer(value[versionField]) || typeof value.deleted !== "boolean" ||
      (value.deleted ? value.data !== null : value.data !== null && !object(value.data))) throw Error("同步检查点远端版本无效");
}
function operation(value, key) {
  fields(value, ["opId", "entityType", "entityId", "baseVersion", "deleted", "data"], ["opId", "entityType", "entityId", "baseVersion", "deleted", "data"]);
  if (!validID(value.opId) || `${value.entityType}:${value.entityId}` !== key || !validID(value.entityId) ||
      !integer(value.baseVersion) || typeof value.deleted !== "boolean" ||
      (value.deleted ? value.data !== null : !object(value.data))) throw Error("同步检查点待发操作无效");
  validateState({ ...empty(), records: { [key]: { version: value.baseVersion, deleted: value.deleted, data: value.data } } });
}
function checkpointState(checkpoint) {
  fields(checkpoint, ["schema", "records", "cursor", "binding", "syncGroups", "syncIncomingGroups", "settings"],
    ["schema", "records", "cursor", "binding", "syncGroups", "syncIncomingGroups"]);
  identity(checkpoint.binding);
  const settings = checkpoint.settings === undefined ? {} : checkpoint.settings;
  fields(settings, checkpointSettings);
  const acknowledgement = (value, withID = true) => fields(value,
    [...(withID ? ["groupId"] : []), "firstSeq", "lastSeq", "count"],
    [...(withID ? ["groupId"] : []), "firstSeq", "lastSeq", "count"]);
  if (settings.syncGroupAcks !== undefined) {
    if (!Array.isArray(settings.syncGroupAcks)) throw Error("同步检查点确认范围无效");
    settings.syncGroupAcks.forEach(value => acknowledgement(value));
  }
  const state = { ...empty(), ...checkpoint, settings };
  validateState(state);
  validateSyncGroups(state);
  // Positive versions in an unbound offline chain may be projected from an
  // earlier, still-queued operation. They are not server acknowledgements.
  const localProjection = (group, item, versionField) => item[versionField] === 0 ||
    group.predecessorHeads?.some(head => head.key === `${item.entityType}:${item.entityId}` &&
      Object.hasOwn(state.syncGroups, head.groupId) && head.version === item[versionField]);
  if (!state.binding && (state.cursor !== 0 || Object.keys(state.syncIncomingGroups).length ||
      settings.syncGroupAcks?.length || settings.syncNeedsPull || settings.syncLegacyPushAhead ||
      Object.values(state.records).some(record => record.version !== 0 || record.remote != null || record.remoteDeleted || record.conflict || record.flight) ||
      Object.values(state.syncGroups).some(group => group.sent || group.conflict || group.remoteReady || group.remoteCursor > 0 ||
        Object.keys(group.predecessorAcks || {}).length || group.cursorAcknowledgements?.length || group.cursorBase > 0 ||
        group.payload.operations.some(op => !localProjection(group, op, "baseVersion")) ||
        group.payload.readSet.some(item => !localProjection(group, item, "version") || item.version === 0 && (item.deleted || item.data !== null)))))
    throw Error("已有远端版本的同步检查点缺少原账号绑定，未恢复");
  for (const [key, record] of Object.entries(state.records)) {
    fields(record, recordFields, ["data", "version", "deleted", "dirty"]);
    if (typeof record.deleted !== "boolean" || typeof record.dirty !== "boolean" ||
        record.deleted && record.data !== null || Object.hasOwn(record, "remoteDeleted") && typeof record.remoteDeleted !== "boolean" ||
        record.remote !== undefined && record.remote !== null && !object(record.remote)) throw Error("同步检查点记录无效");
    if (record.flight != null) operation(record.flight, key);
    if (record.conflict != null) remote(record.conflict);
  }
  for (const group of Object.values(state.syncGroups)) {
    fields(group, ["groupId", "planId", "decision", "messageKey", "createdAt", "status", "payload", "writeKeys", "lockKeys", "reason", "conflict", "remoteReady", "remoteCursor", ...chainFields, ...cursorFields],
      ["groupId", "planId", "decision", "messageKey", "createdAt", "status", "payload", "writeKeys", "lockKeys", "reason"]);
    if (!validID(group.planId) || !["applied", "rejected"].includes(group.decision) || !integer(group.createdAt) || typeof group.reason !== "string" ||
        Object.hasOwn(group, "remoteReady") && typeof group.remoteReady !== "boolean" || Object.hasOwn(group, "remoteCursor") && !integer(group.remoteCursor))
      throw Error("同步检查点操作组决定无效");
    if (chainFields.some(key => Object.hasOwn(group, key))) {
      if (chainFields.some(key => !Object.hasOwn(group, key))) throw Error("同步检查点缺少完整前序链");
      for (const head of group.predecessorHeads) {
        fields(head, ["key", "groupId", "version", "deleted", "data"], ["key", "groupId", "version", "deleted", "data"]);
        remote({ version: head.version, deleted: head.deleted, data: head.data });
        validateState({ ...empty(), records: { [head.key]: { version: head.version, deleted: head.deleted, data: head.data } } });
      }
      Object.values(group.predecessorAcks).forEach(value => acknowledgement(value, false));
    }
    if (cursorFields.some(key => Object.hasOwn(group, key))) {
      if (!Object.hasOwn(group.payload, "expectedCursor") || cursorFields.some(key => !Object.hasOwn(group, key)) ||
          !Object.hasOwn(group, "predecessors")) throw Error("同步检查点缺少完整游标链");
      group.cursorAcknowledgements.forEach(value => acknowledgement(value));
    }
    fields(group.payload, ["version", "groupId", "operations", "readSet", "expectedCursor"], ["version", "groupId", "operations", "readSet"]);
    if (new Set(group.payload.operations.map(op => op.opId)).size !== group.payload.operations.length || new Set(group.writeKeys).size !== group.writeKeys.length)
      throw Error("同步检查点操作组成员重复");
    for (const op of group.payload.operations) {
      const key = `${op.entityType}:${op.entityId}`;
      operation(op, key);
      if (!Object.hasOwn(state.records, key)) throw Error("同步检查点缺少操作组成员");
    }
    const readKeys = new Set();
    for (const item of group.payload.readSet) {
      fields(item, ["entityType", "entityId", "version", "deleted", "data"], ["entityType", "entityId", "version", "deleted", "data"]);
      remote({ version: item.version, deleted: item.deleted, data: item.data });
      const key = `${item.entityType}:${item.entityId}`;
      if (!validID(item.entityId) || readKeys.has(key)) throw Error("同步检查点读取条件重复或无效");
      validateState({ ...empty(), records: { [key]: { version: item.version, deleted: item.deleted || item.data === null, data: item.data } } });
      readKeys.add(key);
    }
    if (!equal([...readKeys].sort(), [...group.lockKeys].sort())) throw Error("同步检查点缺少完整读取条件");
    const message = state.records[group.messageKey]?.data;
    if (!group.messageKey.startsWith("messages:") || !group.writeKeys.includes(group.messageKey) ||
        message?.pendingPlan?.id !== group.planId || message.pendingPlan.syncGroupId !== group.groupId || message.pendingPlan.status !== group.decision)
      throw Error("同步检查点缺少原操作组确认消息");
    if (group.conflict !== undefined) {
      fields(group.conflict, ["version", "groupId", "status", "accepted", "conflicts", "cursor", "cursorConflict"], ["version", "groupId", "status", "accepted", "conflicts", "cursor"]);
      if (group.conflict.version !== 1 || group.conflict.groupId !== group.groupId || group.conflict.status !== "conflict" ||
          !Array.isArray(group.conflict.accepted) || group.conflict.accepted.length || !Array.isArray(group.conflict.conflicts) || !integer(group.conflict.cursor))
        throw Error("同步检查点整组冲突无效");
      if (group.status !== "blocked" || !group.conflict.conflicts.length && !group.conflict.cursorConflict) throw Error("同步检查点整组冲突不完整");
      for (const conflict of group.conflict.conflicts) {
        fields(conflict, ["entityType", "entityId", "check", "expectedVersion", "remote"], ["entityType", "entityId", "check", "expectedVersion", "remote"]);
        fields(conflict.remote, ["version", "deleted"], ["version", "deleted"]);
        if (!["write", "read"].includes(conflict.check) || !integer(conflict.expectedVersion) || !integer(conflict.remote.version) ||
            typeof conflict.remote.deleted !== "boolean" || !group.lockKeys.includes(`${conflict.entityType}:${conflict.entityId}`)) throw Error("同步检查点整组冲突成员无效");
      }
      if (group.conflict.cursorConflict) {
        fields(group.conflict.cursorConflict, ["expected", "actual"], ["expected", "actual"]);
        if (!integer(group.conflict.cursorConflict.expected) || !integer(group.conflict.cursorConflict.actual)) throw Error("同步检查点冲突游标无效");
      }
    }
  }
  for (const group of Object.values(state.syncIncomingGroups)) {
    fields(group, ["groupId", "status", "reason", "createdAt", "envelope", "lockKeys"], ["groupId", "status", "reason", "createdAt", "envelope", "lockKeys"]);
    fields(group.envelope, ["type", "groupId", "firstSeq", "lastSeq", "changes"], ["type", "groupId", "firstSeq", "lastSeq", "changes"]);
    validateEnvelope(group.envelope);
    if (group.status !== "blocked" || group.envelope.groupId !== group.groupId || group.envelope.lastSeq > state.cursor || !integer(group.createdAt) || typeof group.reason !== "string" ||
        !equal([...group.lockKeys].sort(), group.envelope.changes.map(item => `${item.entityType}:${item.entityId}`).sort())) throw Error("同步检查点接收组不完整");
    for (const change of group.envelope.changes) {
      fields(change, ["seq", "entityType", "entityId", "version", "deleted", "data"], ["seq", "entityType", "entityId", "version", "deleted", "data"]);
      validateState({ ...empty(), records: { [`${change.entityType}:${change.entityId}`]: { version: change.version, deleted: change.deleted, data: change.data } } });
    }
  }
  return state;
}
function checkpointSources(checkpoint) {
  const sources = new Map(), seen = new WeakSet(), pending = [checkpoint.records, checkpoint.syncGroups, checkpoint.syncIncomingGroups];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (Object.hasOwn(value, "blobHash")) {
      if (typeof value.blobHash !== "string" || !/^[a-f0-9]{64}$/.test(value.blobHash)) throw Error("备份中的文件标识无效");
      if (!sources.has(value.blobHash)) sources.set(value.blobHash, value);
    }
    pending.push(...Object.values(value).filter(item => item && typeof item === "object"));
  }
  return sources;
}
function clean(records) {
  if (!records || Array.isArray(records) || typeof records !== "object")
    throw Error("备份记录无效");
  const result = Object.fromEntries(
    Object.entries(records).map(([key, r]) => [
      key,
      {
        data: r.data,
        deleted: !!r.deleted,
        version: 0,
        remote: null,
        remoteDeleted: false,
        dirty: true,
      },
    ]),
  );
  validateState({ ...empty(), records: result });
  return result;
}
function hashes(records) {
  return [
    ...new Set(
      Object.values(records)
        .filter((r) => !r.deleted && r.data?.blobHash)
        .map((r) => r.data.blobHash),
    ),
  ].map((hash) => {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw Error("备份中的文件标识无效");
    return hash;
  });
}
export async function createBackup(store, read, sha256) {
  const snapshot = structuredClone(store.state);
  const queued = hasGroups(snapshot);
  let checkpoint, records, sources;
  if (queued) {
    checkpoint = { schema: snapshot.schema, records: snapshot.records, cursor: snapshot.cursor,
      binding: snapshot.binding ? { base: snapshot.binding.base, username: snapshot.binding.username, accountID: snapshot.binding.accountID } : null,
      syncGroups: snapshot.syncGroups || {}, syncIncomingGroups: snapshot.syncIncomingGroups || {} };
    const settings = Object.fromEntries(checkpointSettings.filter(key => Object.hasOwn(snapshot.settings, key)).map(key => [key, snapshot.settings[key]]));
    if (Object.keys(settings).length) checkpoint.settings = settings;
    checkpointState(checkpoint);
    sources = checkpointSources(checkpoint);
  } else {
    records = clean(snapshot.records);
    sources = new Map(hashes(records).map(hash => [hash, Object.values(records).find(record => !record.deleted && record.data?.blobHash === hash)?.data]));
  }
  const blobs = [...sources.keys()];
  const manifest = strToU8(
    JSON.stringify(checkpoint ? { format: "aibro-mobile-backup-v3", checkpoint, blobs } : { format: "aibro-mobile-backup-v2", records, blobs }),
  );
  const archive = { "manifest.json": [manifest, { level: 6 }] };
  let total = manifest.length;
  if (total > limit) throw Error("完整备份超过 128 MB，请通过同步服务迁移原件");
  for (const hash of blobs) {
    const data = await read(hash, sources.get(hash));
    if ((await sha256(data)) !== hash) throw Error("原件校验失败，未导出备份");
    total += data.length;
    if (total > limit)
      throw Error("完整备份超过 128 MB，请通过同步服务迁移原件");
    archive["blobs/" + hash] = [data, { level: 0 }];
  }
  return zipSync(archive);
}
export async function restoreBackup(store, bytes, files, sha256) {
  if (bytes.length > limit + 1024 * 1024) throw Error("备份过大");
  if (!restoreEmpty(store.state))
    throw Error("请恢复到尚未连接同步的空工作区");
  let manifest,
    archive = {},
    total = 0;
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const seen = new Set();
    archive = unzipSync(bytes, {
      filter: (entry) => {
        if (
          seen.has(entry.name) ||
          !/^(manifest\.json|blobs\/[a-f0-9]{64})$/.test(entry.name)
        )
          throw Error("备份包含重复或未知文件");
        seen.add(entry.name);
        total += entry.originalSize;
        if (total > limit) throw Error("备份解压后过大");
        return true;
      },
    });
    if (!archive["manifest.json"]) throw Error("缺少备份清单");
    manifest = JSON.parse(strFromU8(archive["manifest.json"]));
    if (!["aibro-mobile-backup-v2", "aibro-mobile-backup-v3"].includes(manifest.format))
      throw Error("备份版本不兼容");
  } else {
    manifest = JSON.parse(strFromU8(bytes));
    if (manifest.format !== "aibro-mobile-backup-v1")
      throw Error("备份版本不兼容");
  }
  const checkpoint = manifest.format === "aibro-mobile-backup-v3";
  let restored, records, blobs, sources;
  if (checkpoint) {
    fields(manifest, ["format", "checkpoint", "blobs"], ["format", "checkpoint", "blobs"]);
    restored = checkpointState(manifest.checkpoint);
    records = restored.records;
    sources = checkpointSources(manifest.checkpoint);
    blobs = [...sources.keys()];
    if (!Array.isArray(manifest.blobs) || !equal([...manifest.blobs].sort(), [...blobs].sort())) throw Error("同步检查点原件清单不完整");
  } else {
    records = clean(manifest.records);
    blobs = hashes(records);
  }
  const complete = !manifest.format.endsWith("v1");
  // Validate the complete archive before persisting even its first attachment.
  if (complete)
    for (const hash of blobs) {
      if (
        !archive["blobs/" + hash] ||
        (await sha256(archive["blobs/" + hash])) !== hash
      )
        throw Error("备份原件缺失或损坏，未恢复记录");
    }
  if (complete)
    for (const hash of blobs) await files.write(hash, archive["blobs/" + hash]);
  await store.tx((s) => {
    if (!restoreEmpty(s))
      throw Error("工作区已发生变化，未覆盖新内容");
    s.records = records;
    if (checkpoint) {
      s.cursor = restored.cursor;
      s.binding = restored.binding;
      s.syncGroups = restored.syncGroups;
      s.syncIncomingGroups = restored.syncIncomingGroups;
      // Do not merge stale synchronization evidence from the destination.
      for (const key of checkpointSettings) delete s.settings[key];
      Object.assign(s.settings, restored.settings);
    }
    // Restored originals belong to this device, not to the next sync account.
    // Keep the upload queue durable alongside the records that refer to them.
    if (complete)
      for (const hash of blobs) {
        const source = sources?.get(hash) || Object.values(records).find(
          (r) => !r.deleted && r.data?.blobHash === hash,
        )?.data;
        s.blobs[hash] = {
          name: source?.originalName || source?.name || source?.title || hash,
          size: archive["blobs/" + hash].length,
          uploaded: false,
        };
      }
  });
  return {
    files: complete ? blobs.length : 0,
    legacy: manifest.format.endsWith("v1"),
    ...(checkpoint ? { checkpoint: true, requiresOriginalAccount: !!restored.binding,
      binding: structuredClone(restored.binding), pendingGroups: Object.keys(restored.syncGroups).length,
      incomingGroups: Object.keys(restored.syncIncomingGroups).length } : {}),
  };
}
