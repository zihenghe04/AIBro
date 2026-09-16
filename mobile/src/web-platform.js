// Browser-only adapters. Credentials are tab-scoped, never part of workspace sync.
export function tabVault(storage, prefix = "aibro-web-session:") {
  return {
    async get(key) { return storage.getItem(prefix + key); },
    async set(key, value) { storage.setItem(prefix + key, value); },
    async remove(key) { storage.removeItem(prefix + key); },
  };
}

export async function claimWorkspace(name) {
  if (!navigator.locks) throw Error("当前浏览器不支持安全的多标签页保存，请使用新版 Safari、Chrome 或 Firefox。");
  await new Promise((resolve, reject) => {
    navigator.locks.request(name, { ifAvailable: true }, async (lock) => {
      if (!lock) return reject(Error("这个工作区已在另一个标签页打开。请回到原页面，或关闭它后刷新此页，避免覆盖未同步的修改。"));
      resolve();
      await new Promise(() => {}); // Released automatically when the document closes.
    }).catch(reject);
  });
}

export async function browserRequest(url, options, vault, request = fetch) {
  const target = new URL(url);
  const school = target.origin === "https://iclass.ucas.edu.cn:8181";
  if (school) {
    try {
      return await request("/api/ucas", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, method: options.method || "GET", headers: { sessionId: options.headers?.sessionId }, body: options.body }),
        redirect: "error", credentials: "omit", signal: AbortSignal.timeout(30000),
      });
    } catch { throw Error("课程连接服务暂时无法访问，请检查网络后重试；不需要登录云同步。"); }
  }
  const saved = JSON.parse(await vault.get("sync") || "null");
  const relayModel = !school && options.headers?.Authorization && /\/(chat\/completions|responses)$/.test(target.pathname);
  if (relayModel && saved) {
    const response = await request(saved.base + "/v1/web/relay", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + saved.token },
      body: JSON.stringify({ url, method: options.method || "GET", headers: options.headers, body: options.body }),
      redirect: "error", credentials: "omit", signal: AbortSignal.timeout(120000),
    });
    return response;
  }
  try { return await request(url, { ...options, credentials: "omit" }); }
  catch (error) {
    if (error.name === "TypeError") throw Error("无法连接服务。请确认设备已接入 Tailscale（若使用私有服务器），并在同步服务中允许当前网页地址跨域访问。");
    throw error;
  }
}

let reminders = [], reminderTimer;
const delivered = new Set();
export async function browserNotifications(events, enabled) {
  clearInterval(reminderTimer);
  reminders = enabled ? events.filter(e => e.reminderAt >= Date.now() - 60000) : [];
  const check = async () => {
    for (const e of reminders) {
      const key = (e.occurrenceID || e.id) + ":" + e.reminderAt;
      if (e.reminderAt > Date.now() || Date.now() - e.reminderAt > 60000 || delivered.has(key)) continue;
      delivered.add(key);
      if (globalThis.Notification?.permission === "granted") {
        try {
          const registration = await navigator.serviceWorker?.getRegistration();
          if (registration) await registration.showNotification("AI Bro · 日程提醒", { body: e.title, tag: key, icon: "/icon-192.png" });
          else {
            const n = new Notification("AI Bro · 日程提醒", { body: e.title, tag: key, icon: "/icon-192.png" });
            n.onclick = () => { window.focus(); n.close(); };
          }
        } catch { /* Permission can be revoked while this tab is open. */ }
      }
    }
  };
  if (enabled) { check(); reminderTimer = setInterval(check, 10000); }
  return { scheduled: reminders.length, message: "网页打开期间提醒" };
}

export async function extractPDF(bytes) {
  const pdfjs = await import("pdfjs-dist");
  const { default: worker } = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const loading = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false });
  let pdf;
  try {
    pdf = await loading.promise;
    let text = "", pages = 0;
    for (let page = 1; page <= pdf.numPages && text.length < 200000; page++) {
      const p = await pdf.getPage(page), content = await p.getTextContent();
      text += content.items.map(i => (i.str || "") + (i.hasEOL ? "\n" : " ")).join("") + "\n\n";
      pages++; p.cleanup();
    }
    return { text: text.slice(0, 200000), warning: !text.trim() ? "此 PDF 没有可提取文字，扫描件可在 iOS 或 Mac 上识别后同步。" : pages < pdf.numPages || text.length > 200000 ? "正文较长，已提取前 200,000 字符；完整原件已保留。" : "" };
  } finally { await loading.destroy(); }
}
