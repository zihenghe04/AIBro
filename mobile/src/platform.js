import { Capacitor, registerPlugin } from "@capacitor/core";
import { Filesystem, Directory } from "@capacitor/filesystem";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Share } from "@capacitor/share";
import { IndexedAdapter } from "./store.js";
import { httpError } from "./http-error.js";
import { tabVault, browserRequest, browserNotifications, claimWorkspace, extractPDF } from "./web-platform.js";
export const native = Capacitor.isNativePlatform();
export const Bridge = registerPlugin("MobileBridge");
export const adapter = native
  ? {
      read: async () => {
        const r = await Bridge.load();
        return r.value ? JSON.parse(r.value) : null;
      },
      write: async (value) => Bridge.save({ value: JSON.stringify(value) }),
    }
  : new IndexedAdapter(
      new URLSearchParams(location.search).get("demo") === "1"
        ? "aibro-mobile-demo-v1"
        : "aibro-mobile-v1",
    );
// Keychain on iOS; browser credentials are scoped to this tab.
const secrets = native ? null : tabVault(sessionStorage, "aibro-web-session:" + (new URLSearchParams(location.search).get("demo") === "1" ? "demo:" : "live:"));
export const vault = {
  get: async (key) =>
    native ? (await Bridge.secretGet({ key })).value : secrets.get(key),
  set: async (key, value) =>
    native ? Bridge.secretSet({ key, value }) : secrets.set(key, value),
  remove: async (key) =>
    native ? Bridge.secretRemove({ key }) : secrets.remove(key),
};
export const toBase64 = (bytes) => {
  let out = "";
  for (let i = 0; i < bytes.length; i += 16384)
    out += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(out);
};
export const fromBase64 = (s) =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export async function http(
  url,
  { method = "GET", headers = {}, body, bytes, raw = false } = {},
) {
  const u = new URL(url);
  if (
    u.protocol !== "https:" &&
    !(
      u.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)
    )
  )
    throw Error("请使用 HTTPS 地址");
  if (u.username || u.password) throw Error("地址不可包含账号密码");
  if (body !== undefined)
    headers = { "Content-Type": "application/json", ...headers };
  let status, data;
  if (native) {
    const r = await Bridge.request({
      url,
      method,
      headers,
      body: bytes
        ? toBase64(bytes)
        : body === undefined
          ? ""
          : typeof body === "string"
            ? body
            : JSON.stringify(body),
      binaryBody: !!bytes,
      raw,
    });
    status = r.status;
    data = raw ? fromBase64(r.data) : r.data;
  } else {
    const r = await browserRequest(url, {
      method,
      headers,
      body:
        bytes ||
        (body === undefined
          ? undefined
          : typeof body === "string"
            ? body
            : JSON.stringify(body)),
      redirect: "error",
      signal: AbortSignal.timeout(120000),
    }, vault);
    status = r.status;
    data = raw ? new Uint8Array(await r.arrayBuffer()) : await r.text();
  }
  if (status < 200 || status >= 300) {
    throw httpError(status, data);
  }
  if (raw) return data;
  try {
    return typeof data === "string" ? JSON.parse(data) : data;
  } catch {
    throw Error("服务返回了无法识别的内容");
  }
}
let blobDB;
async function db() {
  return (blobDB ||= new Promise((resolve, reject) => {
    const r = indexedDB.open(new URLSearchParams(location.search).get("demo") === "1" ? "aibro-mobile-demo-files" : "aibro-mobile-files", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("blobs");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}
export const files = {
  async write(hash, bytes) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw Error("文件标识无效");
    if (native)
      return Filesystem.writeFile({
        path: "files/" + hash,
        data: toBase64(bytes),
        directory: Directory.Data,
        recursive: true,
      });
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction("blobs", "readwrite");
      t.objectStore("blobs").put(bytes, hash);
      t.oncomplete = resolve;
      t.onerror = () => reject(t.error);
    });
  },
  async read(hash) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw Error("文件标识无效");
    if (native) {
      const r = await Filesystem.readFile({
        path: "files/" + hash,
        directory: Directory.Data,
      });
      return fromBase64(r.data);
    }
    const d = await db();
    return new Promise((resolve, reject) => {
      const r = d.transaction("blobs").objectStore("blobs").get(hash);
      r.onsuccess = () =>
        r.result ? resolve(r.result) : reject(Error("原件未下载"));
      r.onerror = () => reject(r.error);
    });
  },
};
export async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
export async function exportFile(
  name,
  bytes,
  mime = "application/octet-stream",
) {
  if (native) {
    const safe = name.replace(/[\\/\u0000-\u001f]/g, "_");
    const r = await Filesystem.writeFile({
      path: "exports/" + safe,
      data: toBase64(bytes),
      directory: Directory.Cache,
      recursive: true,
    });
    await Share.share({ title: name, url: r.uri });
  } else {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}
export async function reconcileNotifications(events, enabled) {
  if (!native) return browserNotifications(events, enabled);
  const pending = await LocalNotifications.getPending();
  const ours = pending.notifications.filter((n) => n.extra?.aibro === true);
  if (!enabled) {
    if (ours.length)
      await LocalNotifications.cancel({
        notifications: ours.map((x) => ({ id: x.id })),
      });
    return { scheduled: 0 };
  }
  const permission = await LocalNotifications.checkPermissions();
  if (permission.display !== "granted")
    return { scheduled: 0, message: "请在设置中允许通知" };
  const next = events
    .filter((e) => e.reminderAt > Date.now())
    .sort((a, b) => a.reminderAt - b.reminderAt)
    .slice(0, 48);
  if (ours.length)
    await LocalNotifications.cancel({
      notifications: ours.map((x) => ({ id: x.id })),
    });
  if (next.length)
    await LocalNotifications.schedule({
      notifications: next.map((e, i) => ({
        id: 40000 + i,
        title: "AI Bro · 日程提醒",
        body: e.title,
        schedule: { at: new Date(e.reminderAt) },
        extra: { aibro: true, eventID: e.id },
      })),
    });
  return { scheduled: next.length };
}
export async function enableNotifications() {
  if (!native) {
    if (!globalThis.Notification) throw Error("此浏览器未提供系统通知，请使用 iOS App 的日程提醒。");
    return await Notification.requestPermission() === "granted";
  }
  return (await LocalNotifications.requestPermissions()).display === "granted";
}

export async function prepareWorkspace() {
  if (!native) await claimWorkspace(adapter.name);
}
export async function extractText(name, bytes) {
  if (native) return Bridge.extractText({ name, data: toBase64(bytes) });
  if (/\.pdf$/i.test(name)) return extractPDF(bytes);
  throw Error("图片文字识别可在 iOS 或 Mac 完成后同步；网页版保留图片原件。");
}
