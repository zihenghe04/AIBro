// Durable mobile workspace. Every mutation, cursor and in-flight operation is one transaction.
export const id = () => crypto.randomUUID().replaceAll("-", "");
export const clone = (value) => structuredClone(value);
export const keyOf = (kind, key) => `${kind}:${key}`;
export const equal = (a, b) => canonical(a) === canonical(b);
export function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export const empty = () => ({
  schema: 1,
  records: {},
  cursor: 0,
  binding: null,
  settings: {},
  drafts: {},
  blobs: {},
});
export function validateState(s) {
  if (
    !s ||
    s.schema !== 1 ||
    !s.records ||
    !Number.isSafeInteger(s.cursor) ||
    s.cursor < 0
  )
    throw Error("工作区格式不兼容，未覆盖原数据");
  const kinds = new Set([
    "projects",
    "tasks",
    "notes",
    "imports",
    "papers",
    "conversations",
    "messages",
    "attachments",
    "links",
    "trash",
    "skills",
    "folders",
  ]);
  if (Array.isArray(s.records) || !s.settings || !s.drafts || !s.blobs)
    throw Error("工作区结构无效，未覆盖原数据");
  for (const [key, r] of Object.entries(s.records)) {
    const [kind, recordID] = key.split(":");
    if (
      !kinds.has(kind) ||
      key !== kind + ":" + recordID ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(recordID) ||
      !r ||
      !Number.isSafeInteger(r.version) ||
      r.version < 0
    )
      throw Error("工作区记录无效，未覆盖原数据");
    if (
      !r.deleted &&
      (!r.data ||
        typeof r.data !== "object" ||
        Array.isArray(r.data) ||
        !/^[A-Za-z0-9_-]{1,200}$/.test(r.data.id) ||
        (kind !== "messages" && r.data.id !== recordID))
    )
      throw Error("工作区记录标识不一致");
  }
  return s;
}
export class MemoryAdapter {
  async read() {
    return this.value ? clone(this.value) : null;
  }
  async write(v) {
    this.value = clone(v);
  }
}
export class IndexedAdapter {
  constructor(name = "aibro-mobile-v1") {
    this.name = name;
  }
  async db() {
    return (this.connection ||= new Promise((resolve, reject) => {
      const r = indexedDB.open(this.name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore("state");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
  }
  async read() {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("state");
      const r = tx.objectStore("state").get("workspace");
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    });
  }
  async write(value) {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("state", "readwrite");
      tx.objectStore("state").put(value, "workspace");
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || Error("保存被中断"));
    });
  }
}
export class Store extends EventTarget {
  constructor(adapter) {
    super();
    this.adapter = adapter;
    this.state = empty();
    this.tail = Promise.resolve();
  }
  async load() {
    this.state = validateState((await this.adapter.read()) || empty());
    return this;
  }
  tx(fn) {
    const run = this.tail.then(async () => {
      const next = clone(this.state);
      const result = await fn(next);
      validateState(next);
      await this.adapter.write(next);
      this.state = next;
      this.dispatchEvent(new Event("change"));
      return result;
    });
    this.tail = run.catch(() => {});
    return run;
  }
  list(kind) {
    return Object.entries(this.state.records)
      .filter(([k, r]) => k.startsWith(kind + ":") && !r.deleted && r.data)
      .map(([k, r]) => ({
        ...clone(r.data),
        _key: k,
        _conflict: !!r.conflict,
      }));
  }
  get(kind, key) {
    const r = this.state.records[keyOf(kind, key)];
    return r && !r.deleted ? clone(r.data) : null;
  }
  async put(kind, data, expected) {
    return this.tx((s) => putRecord(s, kind, data, expected));
  }
  async remove(kind, key) {
    return this.tx((s) => {
      const r = s.records[keyOf(kind, key)];
      if (r) {
        r.deleted = true;
        r.data = null;
        r.dirty = true;
      }
    });
  }
  async resolve(key, choice) {
    return this.tx((s) => {
      const r = s.records[key];
      if (!r?.conflict) throw Error("冲突已变化");
      const remote = r.conflict;
      r.version = remote.version;
      r.remote = clone(remote.data);
      r.remoteDeleted = remote.deleted;
      r.flight = null;
      r.conflict = null;
      if (choice === "remote") {
        r.data = clone(remote.data);
        r.deleted = remote.deleted;
        r.dirty = false;
      } else r.dirty = true;
    });
  }
}
export function putRecord(s, kind, data, expected) {
  if (
    !/^[a-z]+$/.test(kind) ||
    !data?.id ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(data.id)
  )
    throw Error("记录标识无效");
  const key = keyOf(kind, data.id),
    prev = s.records[key];
  if (expected !== undefined && !equal(prev?.data, expected))
    throw Error("内容已在其他位置修改。你的输入仍保留，请重新打开后合并。");
  const { _key, _conflict, ...clean } = data;
  s.records[key] = {
    version: 0,
    remote: null,
    remoteDeleted: false,
    ...prev,
    data: clone(clean),
    deleted: false,
    dirty: true,
  };
  return clean;
}
// Matches Python uuid.uuid5(NAMESPACE_URL, json.dumps([conversationId,messageId], separators=(',',':'))).
export async function messageWireID(conversationID, messageID) {
  const ns = Uint8Array.from(
    "6ba7b8119dad11d180b400c04fd430c8".match(/../g),
    (x) => parseInt(x, 16),
  );
  const name = new TextEncoder().encode(
    JSON.stringify([conversationID, messageID]),
  );
  const bytes = new Uint8Array(ns.length + name.length);
  bytes.set(ns);
  bytes.set(name, ns.length);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", bytes)).slice(
    0,
    16,
  );
  hash[6] = (hash[6] & 15) | 80;
  hash[8] = (hash[8] & 63) | 128;
  return [...hash].map((x) => x.toString(16).padStart(2, "0")).join("");
}
export async function addMessage(
  store,
  conversationID,
  role,
  content,
  extra = {},
) {
  const mid = id(),
    wire = await messageWireID(conversationID, mid);
  await store.tx((s) => {
    const messages = Object.values(s.records).filter(
      (r) => r.data?.conversationId === conversationID && !r.deleted,
    );
    const position =
      Math.max(-1, ...messages.map((r) => r.data.position ?? -1)) + 1;
    s.records[keyOf("messages", wire)] = {
      data: {
        id: mid,
        conversationId: conversationID,
        position,
        role,
        content,
        at: Date.now(),
        ...extra,
      },
      version: 0,
      remote: null,
      remoteDeleted: false,
      deleted: false,
      dirty: true,
    };
  });
  return mid;
}
