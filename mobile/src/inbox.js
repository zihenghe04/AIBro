import { putRecord } from "./store.js";
const running = new WeakMap();
export function receiveShared(store, bridge, files, sha256) {
  if (running.has(store)) return running.get(store);
  const work = drain(store, bridge, files, sha256).finally(() =>
    running.delete(store),
  );
  running.set(store, work);
  return work;
}
async function drain(store, bridge, files, sha256) {
  let received = 0;
  for (let batch = 0; batch < 20; batch++) {
    const { items = [] } = await bridge.shared();
    if (!items.length) break;
    for (const item of items) {
      if (!/^[a-f0-9-]{36}$/i.test(item.id)) throw Error("分享记录标识无效");
      const captureID = "share_" + item.id;
      if (!store.get("notes", captureID)) {
        const imported = [];
        let total = 0;
        for (const [index, file] of (item.files || []).entries()) {
          const bytes = Uint8Array.from(atob(file.data), (c) =>
            c.charCodeAt(0),
          );
          total += bytes.length;
          if (total > 32 * 1024 * 1024) throw Error("分享附件合计超过 32 MB");
          const hash = await sha256(bytes);
          await files.write(hash, bytes);
          imported.push({
            id: "sharefile_" + item.id + "_" + index,
            name: file.name,
            title: file.name,
            originalName: file.name,
            mimeType: file.mimeType || "application/octet-stream",
            size: bytes.length,
            blobHash: hash,
            workspace: "日常",
            createdAt: item.createdAt || Date.now(),
            updatedAt: Date.now(),
          });
        }
        // Record metadata and the capture in ONE transaction, after original bytes are durable.
        await store.tx((s) => {
          for (const entry of imported) {
            s.blobs[entry.blobHash] ??= {
              name: entry.name,
              size: entry.size,
              uploaded: false,
            };
            putRecord(s, "imports", entry);
          }
          putRecord(s, "notes", {
            id: captureID,
            kind: "随记",
            userEdited: true,
            userEditedAt: Date.now(),
            workspace: "日常",
            title: String(item.text || "分享的资料").slice(0, 70),
            content: String(item.text || ""),
            sourceAttachmentIds: imported.map((f) => f.id),
            createdAt: item.createdAt || Date.now(),
            updatedAt: Date.now(),
          });
        });
        received++;
      }
      await bridge.sharedAck({ id: item.id });
    }
  }
  return received;
}
