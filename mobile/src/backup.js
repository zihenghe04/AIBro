import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { empty, validateState } from "./store.js";
const limit = 128 * 1024 * 1024;
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
  const records = clean(structuredClone(store.state.records)),
    blobs = hashes(records);
  const manifest = strToU8(
    JSON.stringify({ format: "aibro-mobile-backup-v2", records, blobs }),
  );
  const archive = { "manifest.json": [manifest, { level: 6 }] };
  let total = manifest.length;
  for (const hash of blobs) {
    const data = await read(hash);
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
  if (Object.keys(store.state.records).length || store.state.binding)
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
    if (manifest.format !== "aibro-mobile-backup-v2")
      throw Error("备份版本不兼容");
  } else {
    manifest = JSON.parse(strFromU8(bytes));
    if (manifest.format !== "aibro-mobile-backup-v1")
      throw Error("备份版本不兼容");
  }
  const records = clean(manifest.records),
    blobs = hashes(records);
  // Validate the complete archive before persisting even its first attachment.
  if (manifest.format.endsWith("v2"))
    for (const hash of blobs) {
      if (
        !archive["blobs/" + hash] ||
        (await sha256(archive["blobs/" + hash])) !== hash
      )
        throw Error("备份原件缺失或损坏，未恢复记录");
    }
  if (manifest.format.endsWith("v2"))
    for (const hash of blobs) await files.write(hash, archive["blobs/" + hash]);
  await store.tx((s) => {
    if (Object.keys(s.records).length || s.binding)
      throw Error("工作区已发生变化，未覆盖新内容");
    s.records = records;
  });
  return {
    files: manifest.format.endsWith("v2") ? blobs.length : 0,
    legacy: manifest.format.endsWith("v1"),
  };
}
