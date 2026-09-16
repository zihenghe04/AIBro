import "./style.css";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { App } from "@capacitor/app";
import { Store, id, putRecord } from "./store.js";
import { Sync } from "./sync.js";
import {
  adapter,
  prepareWorkspace,
  extractText,
  vault,
  http,
  files,
  sha256,
  exportFile,
  native,
  Bridge,
  enableNotifications,
  reconcileNotifications,
} from "./platform.js";
import {
  agendaNote,
  readEvent,
  eventsFor,
  parseICS,
  dayKey,
} from "./agenda.js";
import { ask } from "./ai.js";
import { UCAS } from "./ucas.js";
import QRCode from "qrcode";
import {
  schoolDay,
  courseInstant,
  currentAndNext,
  inCourseWindow,
  autoAttend,
} from "./course-time.js";
import { receiveShared } from "./inbox.js";
import { createBackup, restoreBackup } from "./backup.js";
import { diffLines } from "diff";
import { stageDraft, applyDraft } from "./review.js";
const app = document.querySelector("#app"),
  sheet = document.querySelector("#sheet");
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const md = (s) =>
  DOMPurify.sanitize(marked.parse(String(s || "")), {
    FORBID_TAGS: ["img", "iframe", "style", "input", "form"],
    FORBID_ATTR: ["style"],
  });
const icons = {
  today: "◷",
  captures: "✎",
  knowledge: "▤",
  chat: "✦",
  settings: "⚙",
  folder: "▱",
};
async function loadWorkspace() {
  try {
    await prepareWorkspace();
    return await new Store(adapter).load();
  } catch (e) {
    app.innerHTML =
      "<main><h1>暂时无法打开工作区</h1><p>原数据没有被覆盖。请先解锁设备并重开 App；若仍失败，请保留此设备的数据用于恢复。</p><pre>" +
      esc(e.message) +
      "</pre></main>";
    throw e;
  }
}
const store = await loadWorkspace();
const sync = new Sync(store, http, vault, files, native ? "AI Bro iPhone" : "AI Bro Web"),
  ucas = new UCAS(http, vault);
let tab = "today",
  selectedDay = dayKey(),
  knowledgeMode = "notes",
  query = "",
  currentProject = null,
  currentConversation = null,
  selectedRefs = new Set(),
  busy = false,
  sourceMode = false,
  activeNote = null,
  noteOriginal = null,
  activeImport = null;
let reviewDraft = null,
  courses =
    store.state.settings.ucasCache?.day === schoolDay()
      ? store.state.settings.ucasCache.courses
      : [],
  courseStatus = courses.length ? "上次课程缓存，请刷新确认最新状态" : "",
  noteTimer,
  toastTimer,
  syncTimer,
  noticeTail = Promise.resolve();
const safeRender = () => {
  if (!sheet.open && !document.activeElement?.matches("input,textarea,select"))
    render();
};
const active = (xs) => xs.filter((x) => !x.archived && !x.deletedAt);
const localInput = (t) => {
  const d = new Date(t);
  return (
    dayKey(d) +
    "T" +
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0")
  );
};
const fmt = (stamp) =>
  new Date(stamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
function notify(text) {
  if (sheet.open) {
    let status = sheet.querySelector(".sheet-status");
    if (!status) {
      status = document.createElement("p");
      status.className = "sheet-status";
      status.setAttribute("role", "status");
      sheet.querySelector(".sheet-head").after(status);
    }
    status.textContent = text;
  }

  const box = document.querySelector("#toast");
  box.textContent = text;
  box.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove("visible"), 5000);
}
function error(e) {
  notify(e.message || "操作未完成，输入已保留");
}
function button(label, action, data = "", cls = "") {
  return `<button class="${cls}" data-action="${action}" ${data}>${label}</button>`;
}
function field(name, label, type = "text", value = "") {
  return `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${type === "password" ? 'autocomplete="off"' : ""}></label>`;
}
function options(items, value = "", emptyLabel = "不关联项目") {
  return (
    `<option value="">${emptyLabel}</option>` +
    items
      .map(
        (p) =>
          `<option value="${p.id}" ${p.id === value ? "selected" : ""}>${esc(p.name || p.title)}</option>`,
      )
      .join("")
  );
}
let qrTimer,
  qrExpiry,
  qrGeneration = 0;
function stopQR() {
  clearTimeout(qrTimer);
  clearTimeout(qrExpiry);
  qrGeneration++;
}
sheet.addEventListener("close", stopQR);
function openSheet(title, body) {
  stopQR();
  clearTimeout(noteTimer);
  sheet.innerHTML = `<div class="sheet-head"><h2>${esc(title)}</h2>${button("关闭", "close", "", "quiet")}</div>${body}`;
  if (!sheet.open) sheet.showModal();
  sheet.scrollTop = 0;
}
function countConflicts() {
  return Object.values(store.state.records).filter((x) => x.conflict).length;
}
function noteRow(n) {
  return `<button class="item note-row" data-action="note" data-id="${n.id}"><span class="item-icon">${n.kind === "随记" ? "✎" : "▤"}</span><span><strong>${esc(n.title)}</strong><small>${esc(n.wikiCategory || n.kind || "笔记")} · ${esc((n.tags || []).join(" · ")) || new Date(n.updatedAt || n.createdAt).toLocaleDateString("zh-CN")}</small><p>${esc(
    String(n.content || "")
      .replace(/[#*`]/g, "")
      .slice(0, 85),
  )}</p></span><span class="chevron">›</span></button>`;
}
function projectRow(p) {
  return `<button class="item" data-action="project" data-id="${p.id}"><span class="item-icon lilac">▱</span><span><strong>${esc(p.name || p.title)}</strong><small>${esc(p.workspace || "日常")} · ${store.list("notes").filter((n) => n.projectId === p.id).length} 篇笔记</small></span><span class="chevron">›</span></button>`;
}
function eventRow(e) {
  return `<button class="item event-row" data-action="${e.task ? "task" : "event"}" data-id="${e.id}"><time>${e.allDay ? "全天" : fmt(e.start)}</time><span><strong>${esc(e.title)}</strong><small>${esc(e.location || (e.task ? "待办任务" : "日程"))}</small></span><span class="chevron">›</span></button>`;
}
function render() {
  const titles = {
    today: "今天",
    captures: "随记",
    knowledge: "知识与项目",
    chat: "对话",
    settings: "设置",
  };
  app.innerHTML = `<header><div class="brand"><img src="/brand.png" alt=""><span>AI Bro</span></div>${button("⚙", "tab", 'data-tab="settings"', "icon-button")}</header><main><div class="page-title"><div><div class="eyebrow">${tab === "today" ? new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" }) : "你的随身 AI 助手"}</div><h1>${titles[tab]}</h1></div>${tab === "captures" ? button("＋", "new-capture", "", "round") : ""}</div>${tab === "today" ? today() : tab === "captures" ? captures() : tab === "knowledge" ? knowledge() : tab === "chat" ? chat() : settings()}</main><nav aria-label="主导航">${["today", "captures", "knowledge", "chat"].map((t) => `<button data-action="tab" data-tab="${t}" aria-current="${t === tab ? "page" : "false"}" class="${t === tab ? "selected" : ""}"><span>${icons[t]}</span>${{ today: "今天", captures: "随记", knowledge: "知识", chat: "对话" }[t]}</button>`).join("")}</nav>`;
  if (tab === "chat" && currentConversation) {
    const input = document.querySelector("#chat-text");
    input.value = store.state.drafts["chat:" + currentConversation] || "";
  }
}
function today() {
  const from = new Date(selectedDay + "T00:00:00"),
    to = new Date(from);
  to.setDate(to.getDate() + 1);
  const es = eventsFor(store, +from, +to);
  return `<section class="hero"><span class="hero-orbit"></span><p class="eyebrow">KNOWLEDGE → ACTION</p><h2>想法先记下，<br>下一步慢慢来。</h2><p>科研、课程和生活，在这里接着继续。</p><div class="actions">${button("✎ 记个想法", "new-capture", "", "primary")}${button("＋ 安排日程", "new-event")}</div></section><div class="section-heading"><h2>我的安排</h2>${button("国科大课程 ›", "ucas", "", "text-button")}</div><div class="date-strip">${[
    -2, -1, 0, 1, 2, 3, 4,
  ]
    .map((i) => {
      const d = new Date();
      d.setDate(d.getDate() + i);
      const key = dayKey(d);
      return `<button data-action="day" data-day="${key}" class="${key === selectedDay ? "selected" : ""}"><small>${d.toLocaleDateString("zh-CN", { weekday: "short" })}</small><strong>${d.getDate()}</strong></button>`;
    })
    .join(
      "",
    )}</div><input aria-label="选择日期" type="date" id="day-picker" value="${selectedDay}"><section class="stack">${es.length ? es.map(eventRow).join("") : '<div class="empty">今天还有留白。<small>安排课程、会议，也给自己留点时间。</small></div>'}</section><div class="actions">${button("导入课表 .ics", "import-ics", "", "quiet")}${button("提醒设置", "tab", 'data-tab="settings"', "quiet")}</div><div class="section-heading"><h2>继续推进</h2>${button("全部项目 ›", "projects", "", "text-button")}</div><section class="stack">${active(store.list("projects")).slice(0, 3).map(projectRow).join("") || '<div class="empty">连接同步后，电脑上的项目也会出现在这里。</div>'}</section><div class="sync-line">${esc(sync.status)}${store.state.binding ? " · " + esc(store.state.binding.username) : ""}</div>`;
}
function captures() {
  const rows = active(store.list("notes"))
    .filter(
      (n) =>
        n.kind === "随记" &&
        (!query ||
          (n.title + " " + n.content + " " + n.tags)
            .toLowerCase()
            .includes(query.toLowerCase())),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return `<p class="lead">记下零散的念头，让它们慢慢长成线索。</p><input class="search" id="search" placeholder="搜索想法、标签…" value="${esc(query)}"><div class="actions">${button("✦ 整理所选随记", "synthesize", "", "quiet")}</div><section class="stack">${rows.map((n) => `<div class="capture-card"><label class="select-capture"><input type="checkbox" data-ref="notes:${n.id}" ${selectedRefs.has("notes:" + n.id) ? "checked" : ""}>选择</label>${noteRow(n)}</div>`).join("") || '<div class="empty">路上想到的事，先放在这里。<small>支持文字、链接、图片与文件。</small></div>'}</section>`;
}
function wikiTree(notes) {
  const root = { children: {}, notes: [] };
  for (const n of notes) {
    const path = String(
      n.folderPath ||
        n.wikiCategory ||
        n.kind?.replace("科研 Wiki/", "") ||
        "未分类",
    )
      .replace(/^wiki\//, "")
      .split("/")
      .filter(Boolean);
    let node = root;
    for (const part of path.slice(0, 8))
      node = node.children[part] ||= { children: {}, notes: [] };
    node.notes.push(n);
  }
  const tree = (node) =>
    Object.entries(node.children)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([name, child]) =>
          `<details class="wiki-folder" ${query ? "open" : ""}><summary>▱ ${esc(name)}</summary>${tree(child)}</details>`,
      )
      .join("") + node.notes.map(noteRow).join("");
  return tree(root);
}
function knowledge() {
  const tabs = [
    ["notes", "笔记"],
    ["wiki", "科研 Wiki"],
    ["projects", "项目"],
    ["files", "文件"],
  ];
  let html = "";
  const match = (x) =>
    !query ||
    [x.title, x.name, x.content, x.wikiCategory, x.folderPath]
      .join(" ")
      .toLowerCase()
      .includes(query.toLowerCase());
  if (knowledgeMode === "projects")
    html = active(store.list("projects"))
      .filter(match)
      .map(projectRow)
      .join("");
  else if (knowledgeMode === "files")
    html = active(store.list("imports"))
      .filter(match)
      .map(
        (f) =>
          `<button class="item" data-action="file" data-id="${f.id}"><span class="item-icon">▤</span><span><strong>${esc(f.title || f.name)}</strong><small>${esc(f.mimeType || "文件")} · ${Math.round((f.size || 0) / 1024)} KB</small></span><span>›</span></button>`,
      )
      .join("");
  else {
    const notes = active(store.list("notes"))
      .filter(
        (n) =>
          n.kind !== "日程" &&
          (knowledgeMode !== "wiki" ||
            n.wikiCategory ||
            /wiki|科研/i.test(n.kind)),
      )
      .filter(match);
    html =
      knowledgeMode === "wiki" ? wikiTree(notes) : notes.map(noteRow).join("");
  }
  return `<div class="segments">${tabs.map(([k, t]) => button(t, "knowledge-mode", `data-mode="${k}"`, k === knowledgeMode ? "selected" : "")).join("")}</div><input id="search" class="search" placeholder="搜索知识与资料…" value="${esc(query)}"><section class="stack">${html || '<div class="empty">把值得留下的内容，慢慢积累起来。</div>'}</section><div class="actions">${button("＋ 新建笔记", "new-note", "", "primary")}${button("＋ 新建项目", "new-project")}</div>`;
}
function chat() {
  if (!currentConversation)
    return `<p class="lead">带上你的资料，继续一个想法。</p>${button("✦ 开始新对话", "new-chat", "", "primary wide")}<section class="stack">${active(
      store.list("conversations"),
    )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(
        (c) =>
          `<button class="item" data-action="conversation" data-id="${c.id}"><span class="item-icon">✦</span><span><strong>${esc(c.title)}</strong><small>${esc(store.get("projects", c.projectId)?.name || "独立对话")}</small></span><span>›</span></button>`,
      )
      .join("")}</section>`;
  const c = store.get("conversations", currentConversation),
    messages = store
      .list("messages")
      .filter((m) => m.conversationId === currentConversation)
      .sort((a, b) => a.position - b.position);
  return `<div class="conversation-bar">${button("‹ 全部对话", "all-chats", "", "quiet")}<strong>${esc(c?.title || "新对话")}</strong>${button("改名", "rename-chat", "", "quiet")}</div><div class="messages">${messages.map((m) => `<article class="message ${m.role === "user" ? "user" : ""}"><small>${m.role === "user" ? "你" : "✦ AI Bro"}</small><div class="markdown">${md(m.content || m.text)}</div>${m.role === "assistant" ? button("保存为笔记", "save-message", `data-id="${m.id}"`, "text-button") : ""}${(m.retrievedSources || []).map((s, i) => button(`[${i + 1}] ${esc(s.title || "来源")}`, "reference", `data-id="${esc(s.id)}"`, "reference")).join("")}</article>`).join("") || '<div class="empty">可以引用笔记或项目记忆，让对话有据可依。</div>'}${busy ? '<div class="thinking">✦ 正在整理思路…</div>' : ""}</div><form id="chat-form" class="composer"><textarea id="chat-text" placeholder="有什么想一起理清楚的？" required></textarea><div class="composer-bottom">${button("＋ 引用资料", "pick-context", "", "quiet")}<small>${selectedRefs.size} 项引用</small><button class="round" ${busy ? "disabled" : ""} type="submit" aria-label="发送">↑</button></div></form>`;
}
function settings() {
  const c = store.state.settings.model || {};
  return `<section class="settings-card"><h2>设备与同步</h2><p>${esc(sync.status)}</p><p class="hint">连接与 Mac「设置 → 账号与云同步」相同的服务和账号。云同步是可选功能，课程助手可以直接登录学校账号使用。要与电脑共用资料，请填写同一同步服务的 HTTPS 地址、云同步用户名和密码。使用 Tailscale 私有地址时，先在此设备连接同一 Tailscale 网络。云同步密码不是 SSH 密码，也不是学校密码。</p><form id="sync-form">${field("server", "自托管同步服务", "url", store.state.binding?.base || import.meta.env.VITE_SYNC_URL || "")}${field("username", "云同步用户名", "text", store.state.binding?.username || "")}${field("password", "云同步账号密码", "password")}<label class="check"><input name="merge" type="checkbox" required>合并当前设备与此账号的资料</label><button class="primary" type="submit">连接并同步</button></form><div class="actions">${button("立即同步", "sync")}${button("断开连接", "disconnect", "", "quiet")}${button(`处理冲突 · ${countConflicts()}`, "conflicts", "", "quiet")}</div></section><section class="settings-card"><h2>模型连接</h2><form id="model-form">${field("base", "API 地址（以 /v1 结尾）", "url", c.base || "")}${field("model", "模型名称", "text", c.model || "")}${field("key", "API Key（留空保留原值）", "password")}<label>接口格式<select name="format"><option value="chat">Chat Completions 兼容接口</option><option value="responses" ${c.format === "responses" ? "selected" : ""}>Responses 兼容接口</option></select></label><button class="primary" type="submit">保存模型连接</button></form><p class="hint">引用内容会发送到你配置的模型服务。学校账号不会进入模型上下文。</p></section><section class="settings-card"><h2>日程提醒</h2><p>${store.state.settings.notifications ? "已启用" : "尚未启用"} · ${native ? "iOS 本地通知" : "网页打开期间提醒；关闭后请使用 iOS 提醒"}</p>${button("开启提醒", "notifications")}<form id="task-reminder-settings"><label>普通任务临期提醒<select name="minutes">${[["off","关闭"],["0","截止时"],["15","提前 15 分钟"],["60","提前 1 小时"],["1440","提前 1 天"]].map(([v,t])=>`<option value="${v}" ${v===String(store.state.settings.taskReminderMinutes===null?"off":store.state.settings.taskReminderMinutes ?? 60)?"selected":""}>${t}</option>`).join("")}</select></label><button type="submit">保存提醒设置</button></form>${button("关闭提醒", "notifications-off", "", "quiet")}</section><section class="settings-card"><h2>课程连接</h2>${button("国科大 · 轻新课堂 ›", "ucas", "", "wide")}</section><section class="settings-card"><h2>数据与恢复</h2>${button("导出工作区备份", "backup")}${button("导入工作区备份", "restore", "", "quiet")}<p class="hint">离线内容保存在此设备。备份包含内容与附件原件，不包含密码、会话与连接设置。</p></section><p class="footnote">AI Bro ${native ? "iOS" : "Web"} · 0.1.3<br>知识与行动，在一起。</p>`;
}
function editCapture(note) {
  activeNote = note?.id || null;
  noteOriginal = note || null;
  const saved = store.state.drafts["capture:" + (activeNote || "new")];
  openSheet(
    note ? "编辑随记" : "记个想法",
    `<form id="capture-form"><textarea name="content" class="large" placeholder="此刻想到什么？也可以粘贴链接…">${esc(saved ?? note?.content ?? "")}</textarea>${field("tags", "标签，用逗号分开", "text", (note?.tags || []).join(", "))}<label>关联项目<select name="project">${options(store.list("projects"), note?.projectId)}</select></label><label class="file-picker">＋ 图片 / 文件<input name="files" type="file" multiple></label><label class="file-picker">拍照记录<input name="camera" type="file" accept="image/*" capture="environment"></label><button class="primary wide" type="submit">保存随记</button></form><div class="attachment-list">${(note?.sourceAttachmentIds || []).map((i) => button("▤ " + esc(store.get("imports", i)?.name || "附件"), "file", `data-id="${i}"`, "reference")).join("")}</div>`,
  );
}
async function attach(file) {
  if (file.size > 64 * 1024 * 1024) throw Error("单个文件最多 64 MB");
  const bytes = new Uint8Array(await file.arrayBuffer()),
    hash = await sha256(bytes);
  await files.write(hash, bytes);
  const entry = {
    id: id(),
    name: file.name,
    title: file.name,
    originalName: file.name,
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    blobHash: hash,
    workspace: "日常",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    content: /\.(md|txt|csv|js|py|json|html)$/i.test(file.name)
      ? new TextDecoder().decode(bytes).slice(0, 200000)
      : "",
  };
  if (/\.pdf$/i.test(file.name) || (native && file.type.startsWith("image/"))) {
    try {
      const extracted = await extractText(file.name, bytes);
      entry.content = extracted.text;
      entry.warning = extracted.warning;
      entry.parser = native ? "ios-device" : "browser-pdf";
    } catch (e) {
      entry.warning = e.message;
    }
  }
  await store.tx((s) => {
    s.blobs[hash] = { name: file.name, size: file.size, uploaded: false };
    putRecord(s, "imports", entry);
  });
  return entry.id;
}
function openNote(n) {
  activeNote = n.id;
  noteOriginal = n;
  sourceMode = false;
  showNote(n);
}
function showNote(n) {
  const draft = store.state.drafts["editor:" + n.id];
  if (draft) n = { ...n, ...draft };

  openSheet(
    n.title,
    `<div class="actions">${button("预览", "note-preview", "", "" + (!sourceMode ? "selected" : ""))}${button("源码", "note-source", "", "" + (sourceMode ? "selected" : ""))}${button("与 AI 讨论", "discuss", `data-id="${n.id}"`)}${button("AI 改写草稿", "rewrite-note", `data-id="${n.id}"`)}${n.aiDraft ? button("审阅 AI 草稿", "review-draft", `data-id="${n.id}"`, "primary") : ""}${button("安排日程", "from-note", `data-id="${n.id}"`)}</div>${sourceMode ? `<form id="note-form">${field("title", "标题", "text", n.title)}<textarea name="content" class="large source">${esc(n.content)}</textarea><button class="primary" type="submit">保存修改</button></form>` : `<article class="markdown reader">${md(n.content)}</article>`}<div class="attachment-list">${(
      n.sourceAttachmentIds || []
    )
      .map((i) => {
        const f = store.get("imports", i);
        return f
          ? button(
              "▤ " + esc(f.title || f.name),
              "file",
              `data-id="${i}"`,
              "reference",
            )
          : "";
      })
      .join(
        "",
      )}</div><div class="actions">${button("导出 Markdown", "export-note", `data-id="${n.id}"`)}${button("归档", "archive-note", `data-id="${n.id}"`, "quiet")}</div>`,
  );
}
function editEvent(note, sourceID) {
  const e = note && readEvent(note);
  activeNote = note?.id || null;
  noteOriginal = note || null;
  const local = (t) => {
    const d = new Date(t);
    return (
      dayKey(d) +
      "T" +
      String(d.getHours()).padStart(2, "0") +
      ":" +
      String(d.getMinutes()).padStart(2, "0")
    );
  };
  openSheet(
    e ? "日程详情" : "安排日程",
    `<form id="event-form" data-start="${e ? local(e.start) : ""}" data-end="${e ? local(e.end) : ""}" data-source="${sourceID || ""}">${field("title", "标题", "text", e?.title || store.get("notes", sourceID)?.title || "")}${field("start", "开始", "datetime-local", local(e?.start || Date.now() + 3600000))}${field("end", "结束", "datetime-local", local(e?.end || Date.now() + 7200000))}${field("location", "地点", "text", e?.location || "")}<label>提醒<select name="reminder">${[
      ["", "不提醒"],
      ["0", "开始时"],
      ["5", "提前 5 分钟"],
      ["15", "提前 15 分钟"],
      ["30", "提前 30 分钟"],
      ["60", "提前 1 小时"],
    ]
      .map(
        ([v, t]) =>
          `<option value="${v}" ${v === (e ? (e.reminderMinutes == null ? "" : String(e.reminderMinutes)) : "15") ? "selected" : ""}>${t}</option>`,
      )
      .join(
        "",
      )}</select></label><label>关联项目<select name="project">${options(store.list("projects"), e?.projectId)}</select></label><label>备注<textarea name="details">${esc(e?.details || "")}</textarea></label>${e?.ics || (e?.recurrence && e.recurrence.frequency !== "none") ? '<p class="hint">此日程来自重复课表。首版保留原重复规则，请重新导入课表更新时间。</p>' : ""}<button class="primary wide" type="submit">${e ? "保存日程" : "添加日程"}</button></form>${e ? button("删除日程", "delete-event", `data-id="${note.id}"`, "danger") : ""}`,
  );
}
function school() {
  const { current, next } = currentAndNext(courses);
  const auto =
    store.state.settings.ucasAuto?.enabled &&
    store.state.settings.ucasAuto.day === schoolDay();
  openSheet(
    "国科大课程助手",
    `
    <p class="lead">轻新课堂 · 让课程安排一目了然</p>
    <details class="school-login"><summary>连接 / 更换学校账号</summary><form id="ucas-form">${field("username", "SEP 邮箱 / 轻新课堂学号")}${field("password", "对应账号的密码", "password")}<label class="check"><input type="checkbox" name="remember"> 在本机记住凭据，过期时恢复连接</label><button class="primary" type="submit">连接账号</button></form><p class="hint">两类账号共用此入口。默认只保存会话；勾选后可恢复连接。退出账号会清除凭据。${native ? "密码仅存于设备钥匙串。" : "网页版可直接连接学校，无需云同步账号。学校请求由网站的课程连接服务转发，不在服务器保存账号密码；凭据仅保留在当前标签页会话中。"}</p></details>
    <div class="actions">${button("检查学校连接", "ucas-check", "", "quiet")}${button("刷新今日课程", "ucas-refresh")}${button("退出学校账号", "ucas-logout", "", "quiet")}</div>
    <div class="school-overview"><div><small>当前课程 · 含课前 25 分钟</small><strong>${esc(current?.title || "暂无")}</strong></div><div><small>下一节课</small><strong>${esc(next?.title || "今日没有更多课程")}</strong></div></div>
    <p class="hint">学校时间 · ${esc(schoolDay())} · Asia/Shanghai</p><p role="status">${esc(courseStatus)}</p>
    <div class="actions">${button(auto ? "关闭今日自动签到" : "开启今日前台自动签到", "ucas-auto", "", auto ? "primary" : "quiet")}${button("开启课程提醒", "ucas-notices", "", "quiet")}</div>
    <p class="hint">${auto ? "已开启：App 在前台时，每门课只自动尝试一次。结果不明请手动刷新核对。锁屏或切到后台后暂停。" : "签到结果以学校确认状态为准。课程小组件会显示最近一次刷新后的安排。"}</p>
    <section>${courses.map((c) => `<div class="school-course"><strong>${esc(c.title)}</strong><small>${esc(c.teacher)} · ${esc(c.start)} — ${esc(c.end)}</small><p>${c.signed ? "学校显示已签到" : "未确认签到"}</p><div class="actions">${button("到课签到", "ucas-sign", `data-id="${esc(c.id)}"`, c.signed ? "quiet" : "primary")}${button("动态签到码", "ucas-qr", `data-id="${esc(c.id)}"`, "quiet")}${button("加入日程", "ucas-calendar", `data-id="${esc(c.id)}"`, "quiet")}</div></div>`).join("")}</section>`,
  );
}
async function refreshCourses() {
  const epoch = ucas.epoch,
    day = schoolDay();
  const result = await ucas.courses(day);
  await store.tx((s) => {
    ucas.assertCurrent(epoch);
    s.settings.ucasCache = {
      day,
      courses: result,
      updatedAt: Date.now(),
    };
  });
  ucas.assertCurrent(epoch);
  courses = result;
  courseStatus = "已从学校更新 " + result.length + " 门课程";
  refreshNotifications(true);
  publishWidget().catch(error);
}
async function courseQR(c) {
  if (!c || !inCourseWindow(c))
    throw Error("当前不在课程显示窗口（课前 25 分钟至下课），请核对课程");
  openSheet(
    c.title + " · 动态签到码",
    `<div class="school-qr"><div id="qr-image"></div><p id="qr-status" role="status">正在与学校校时…</p></div><p class="hint">有效期内自动刷新。离开此页或切到后台后停止显示。</p>${button("返回课程", "ucas", "", "wide")}`,
  );
  const generation = qrGeneration;
  const update = async () => {
    if (!sheet.open || generation !== qrGeneration || document.hidden) return;
    const image = sheet.querySelector("#qr-image"),
      label = sheet.querySelector("#qr-status");
    if (!image || !label) return;
    try {
      const now = await ucas.schoolTime();
      if (!inCourseWindow(c, now.timestamp)) throw Error("已离开课程时间窗口");
      const qr = await ucas.qr(/^\d{7}$/.test(c.id) ? c.id : c.uuid);
      const data = await QRCode.toDataURL(qr.url, {
        width: 300,
        margin: 3,
        errorCorrectionLevel: "M",
      });
      if (generation !== qrGeneration || document.hidden || !sheet.open) return;
      const remaining = qr.expiresAt - Date.now();
      if (remaining <= 0) throw Error("签到码已过期，请重新打开");
      image.innerHTML = `<img alt="学校动态签到二维码" src="${data}" width="300" height="300">`;
      label.textContent = "学校时间已同步 · 自动刷新中";
      clearTimeout(qrExpiry);
      qrExpiry = setTimeout(() => {
        image.innerHTML = "";
        label.textContent = "正在刷新签到码…";
      }, remaining);
      qrTimer = setTimeout(update, remaining);
    } catch (e) {
      image.innerHTML = "";
      label.textContent = e.message;
    }
  };
  await update();
}
let autoBusy = false,
  appForeground = true;
async function tickCourses() {
  if (
    autoBusy ||
    !appForeground ||
    document.hidden ||
    !store.state.settings.ucasAuto?.enabled ||
    store.state.settings.ucasAuto.day !== schoolDay()
  )
    return;
  autoBusy = true;
  try {
    if (Date.now() - (store.state.settings.ucasCache?.updatedAt || 0) > 60000)
      await refreshCourses();
    const results = await autoAttend({
      ucas,
      store,
      courses,
      visible: appForeground && !document.hidden,
    });
    if (results.length) {
      courseStatus = results
        .map((r) => r.course.title + "：" + r.message)
        .join("；");
      notify(courseStatus);
    }
  } catch (e) {
    courseStatus = e.message;
  } finally {
    autoBusy = false;
  }
}
function courseNotices() {
  if (
    !store.state.settings.ucasNotices ||
    store.state.settings.ucasCache?.day !== schoolDay()
  )
    return [];
  return courses.map((c) => ({
    id: "ucas:" + c.id,
    occurrenceID: "ucas:" + c.day + ":" + c.id,
    title: "课程 · " + c.title,
    reminderAt: courseInstant(c.day, c.start) - 15 * 60000,
  }));
}
let widgetKey = "";
async function publishWidget() {
  if (!native) return;
  const events = eventsFor(store, Date.now(), Date.now() + 7 * 86400000);
  const list = events.map((e) => ({
    id: e.occurrenceID || e.id,
    title: e.title,
    start: e.start,
    end: e.end || e.start + 3600000,
    category: "日程",
    signed: false,
  }));
  if (store.state.settings.ucasCache?.day === schoolDay())
    for (const c of courses) {
      list.push({
        id: "ucas:" + c.id,
        title: c.title,
        start: courseInstant(c.day, c.start),
        end: courseInstant(c.day, c.end),
        category: "课程",
        signed: c.signed,
      });
    }
  const items = list
    .filter(
      (x) =>
        Number.isFinite(x.start) &&
        Number.isFinite(x.end) &&
        x.end > Date.now(),
    )
    .sort((a, b) => a.start - b.start)
    .slice(0, 64);
  const key = JSON.stringify(items);
  if (key === widgetKey) return;
  await Bridge.widgetSave({
    value: JSON.stringify({ updatedAt: Date.now(), items }),
  });
  widgetKey = key;
}
async function openImport(importID) {
  const f = store.get("imports", importID);
  if (!f) throw Error("文件不存在");
  activeImport = f;
  openSheet(
    f.title || f.name,
    `<p>${esc(f.mimeType || "文件")} · ${Math.round((f.size || 0) / 1024)} KB</p><div class="actions">${button("预览原件", "preview-file")}${button("导出原件", "export-file")}${native || /\.pdf$/i.test(f.name || "") ? button("提取可引用文字", "extract-file", "", "quiet") : ""}</div>${f.warning ? `<p class="hint">${esc(f.warning)}</p>` : ""}${f.content ? `<article class="markdown reader">${md(f.content)}</article>` : '<p class="hint">可预览或导出原件；文件中的内容尚未作为可检索文字。</p>'}`,
  );
}
async function readImport(f) {
  try {
    return await files.read(f.blobHash);
  } catch {
    const saved = await vault.get("sync");
    if (!saved) throw Error("原件尚未下载，请先连接同步");
    const s = JSON.parse(saved);
    notify("正在下载原件…");
    const bytes = await http(s.base + "/v1/blobs/" + f.blobHash, {
      raw: true,
      headers: { Authorization: "Bearer " + s.token },
    });
    if ((await sha256(bytes)) !== f.blobHash)
      throw Error("原件校验失败，未保存");
    await files.write(f.blobHash, bytes);
    return bytes;
  }
}
function pickContext() {
  openSheet(
    "引用资料",
    `<p class="hint">仅将选中的文本与当前项目记忆发送给模型。</p><div class="ref-list">${active(
      store.list("notes"),
    )
      .filter((n) => n.kind !== "日程")
      .map(
        (n) =>
          `<label><input type="checkbox" data-ref="notes:${n.id}" ${selectedRefs.has("notes:" + n.id) ? "checked" : ""}><span>${esc(n.title)}<small>${esc(n.kind || "笔记")}</small></span></label>`,
      )
      .join("")}${active(store.list("imports"))
      .filter((n) => n.content)
      .map(
        (n) =>
          `<label><input type="checkbox" data-ref="imports:${n.id}" ${selectedRefs.has("imports:" + n.id) ? "checked" : ""}>${esc(n.title || n.name)}</label>`,
      )
      .join("")}</div>${button("完成", "close", "", "primary wide")}`,
  );
}
function conflicts() {
  openSheet(
    "处理同步冲突",
    Object.entries(store.state.records)
      .filter(([, r]) => r.conflict)
      .map(
        ([k, r]) =>
          `<section class="settings-card"><h3>${esc(r.data?.title || r.data?.name || r.conflict.data?.title || "已删除的记录")}</h3><details><summary>比较本机与云端</summary><h4>本机</h4><pre>${esc(r.deleted ? "已删除" : JSON.stringify(r.data, null, 2))}</pre><h4>云端</h4><pre>${esc(r.conflict.deleted ? "已删除" : JSON.stringify(r.conflict.data, null, 2))}</pre></details><div class="actions">${button("保留本机", "resolve", `data-key="${esc(k)}" data-choice="local"`)}${button("使用云端", "resolve", `data-key="${esc(k)}" data-choice="remote"`)}</div></section>`,
      )
      .join("") || '<div class="empty">没有需要处理的冲突。</div>',
  );
}
async function newChat(projectID = null) {
  const c = {
    id: id(),
    title: "新对话",
    projectId: projectID,
    workspace: store.get("projects", projectID)?.workspace || "日常",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await store.put("conversations", c);
  currentConversation = c.id;
  currentProject = projectID;
  tab = "chat";
  sheet.close();
  render();
}
function projectDetail(p) {
  currentProject = p.id;
  openSheet(
    p.name || p.title,
    `<p class="lead">${esc(p.description || "给计划、资料和想法一个共同的位置。")}</p>${button("✦ 在项目里继续对话", "project-chat", `data-id="${p.id}"`, "primary wide")}<div class="section-heading"><h3>任务</h3>${button("＋ 添加", "new-task", `data-project="${p.id}"`)}</div>${store
      .list("tasks")
      .filter((t) => t.projectId === p.id)
      .map(
        (t) =>
          `<button class="item" data-action="task" data-id="${t.id}"><span>${t.status === "done" ? "✓" : "○"}</span><strong>${esc(t.title)}</strong><small>${t.status === "done" ? "已完成" : "待推进"}</small></button>`,
      )
      .join("")}<h3>资料与笔记</h3>${store
      .list("notes")
      .filter((n) => n.projectId === p.id && n.kind !== "日程")
      .map(noteRow)
      .join("")}`,
  );
}
function taskEditor(t, projectID) {
  openSheet(
    t ? "任务详情" : "添加任务",
    `<form id="task-form" data-id="${t?.id || ""}">${field("title", "任务", "text", t?.title || "")}${field("due", "截止时间", "datetime-local", t?.dueAt ? localInput(t.dueAt) : "")}<label>提醒<select name="reminder">${[["inherit","跟随本机设置"],["off","不提醒"],["0","到点提醒"],["15","提前 15 分钟"],["60","提前 1 小时"],["1440","提前 1 天"],...([0,15,60,1440,null,undefined].includes(t?.reminderMinutes)?[]:[[String(t.reminderMinutes),`提前 ${t.reminderMinutes} 分钟`]])].map(([v,label])=>`<option value="${v}" ${v===(t&&Object.hasOwn(t,"reminderMinutes")?(t.reminderMinutes===null?"off":String(t.reminderMinutes)):"inherit")?"selected":""}>${label}</option>`).join("")}</select></label><label>状态<select name="status">${[
      ["todo", "待开始"],
      ["doing", "进行中"],
      ["done", "已完成"],
      ["blocked", "受阻"],
    ]
      .map(
        ([v, tit]) =>
          `<option value="${v}" ${t?.status === v ? "selected" : ""}>${tit}</option>`,
      )
      .join(
        "",
      )}</select></label><label>项目<select name="project">${options(store.list("projects"), t?.projectId || projectID)}</select></label><button class="primary" type="submit">保存任务</button></form>`,
  );
}
async function chooseFile(accept, handler) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.onchange = () => input.files[0] && handler(input.files[0]).catch(error);
  input.click();
}
async function importICS(file) {
  const parsed = parseICS(await file.text());
  openSheet(
    "导入课表",
    `<p>${parsed.events.length} 项可导入</p>${parsed.warnings.map((x) => `<p class="hint">${esc(x)}</p>`).join("")}<div class="stack">${parsed.events.map((e) => `<div class="item"><strong>${esc(e.title)}</strong><small>${new Date(e.start).toLocaleString("zh-CN")}</small></div>`).join("")}</div>${parsed.events.length ? button("确认导入", "commit-ics", "", "primary wide") : ""}`,
  );
  sheet._ics = parsed.events;
}
async function performSync() {
  try {
    await sync.run();
    notify(sync.status);
  } finally {
    render();
  }
}
function reviewNote(n) {
  activeNote = n.id;
  reviewDraft = n.aiDraft;
  if (!reviewDraft) throw Error("没有待审阅草稿");
  const diff = diffLines(n.content || "", reviewDraft.content || "");
  openSheet(
    "审阅修改",
    `<p class="lead">${esc(n.title)}</p><p class="hint">确认采纳后才替换原文，旧版本仍会保留。</p><div class="diff">${diff.map((part) => `<pre class="${part.added ? "added" : part.removed ? "removed" : "same"}">${esc((part.added ? "+ " : part.removed ? "− " : "  ") + part.value)}</pre>`).join("")}</div><details><summary>排版预览</summary><article class="markdown">${md(reviewDraft.content)}</article></details><div class="actions">${button("采纳修改", "apply-draft", `data-id="${n.id}"`, "primary")}${button("保留原文，丢弃草稿", "discard-draft", `data-id="${n.id}"`, "quiet")}</div>`,
  );
}
const actions = {
  "rewrite-note": (b) => {
    activeNote = b.dataset.id;
    openSheet(
      "AI 改写草稿",
      `<form id="rewrite-form">${field("instruction", "希望如何改写？", "text", "整理结构，保留事实与来源，输出完整 Markdown 正文。")}<p class="hint">生成后先审阅，不会直接覆盖笔记。</p><button type="submit" class="primary">生成草稿</button></form>`,
    );
  },
  "review-draft": (b) => reviewNote(store.get("notes", b.dataset.id)),
  "apply-draft": async (b) => {
    const n = await applyDraft(store, b.dataset.id, reviewDraft);
    openNote(n);
    render();
    notify("已采纳，原文保留在版本记录");
  },
  "discard-draft": async (b) => {
    const n = store.get("notes", b.dataset.id);
    if (JSON.stringify(n.aiDraft) !== JSON.stringify(reviewDraft))
      throw Error("草稿已经变化，请重新审阅");
    await store.put("notes", { ...n, aiDraft: null, updatedAt: Date.now() }, n);
    openNote(store.get("notes", n.id));
  },
  close: () => {
    sheet.close();
    render();
  },
  tab: (b) => {
    tab = b.dataset.tab;
    query = "";
    render();
  },
  day: (b) => {
    selectedDay = b.dataset.day;
    render();
  },
  projects: () => {
    tab = "knowledge";
    knowledgeMode = "projects";
    render();
  },
  "knowledge-mode": (b) => {
    knowledgeMode = b.dataset.mode;
    render();
  },
  "new-capture": () => editCapture(),
  note: (b) => {
    const n = store.get("notes", b.dataset.id);
    if (n.kind === "随记") editCapture(n);
    else openNote(n);
  },
  "new-note": async () => {
    const n = {
      id: id(),
      title: "新笔记",
      content: "",
      kind: "note",
      workspace: "科研",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await store.put("notes", n);
    activeNote = n.id;
    noteOriginal = n;
    sourceMode = true;
    showNote(n);
  },
  "note-preview": async () => {
    await store.tail;
    sourceMode = false;
    showNote(store.get("notes", activeNote));
  },
  "note-source": async () => {
    await store.tail;
    sourceMode = true;
    showNote(store.get("notes", activeNote));
  },
  discuss: async (b) => {
    selectedRefs = new Set(["notes:" + b.dataset.id]);
    await newChat(store.get("notes", b.dataset.id)?.projectId);
  },
  "from-note": (b) => editEvent(null, b.dataset.id),
  "archive-note": async (b) => {
    const n = store.get("notes", b.dataset.id);
    await store.put("notes", { ...n, archived: true, updatedAt: Date.now() });
    sheet.close();
    render();
  },
  "export-note": (b) => {
    const n = store.get("notes", b.dataset.id);
    return exportFile(
      n.title + ".md",
      new TextEncoder().encode(n.content),
      "text/markdown",
    );
  },
  "new-event": () => editEvent(),
  event: (b) => editEvent(store.get("notes", b.dataset.id)),
  "delete-event": async (b) => {
    await store.remove("notes", b.dataset.id);
    sheet.close();
    render();
  },
  "new-project": () =>
    openSheet(
      "新建项目",
      `<form id="project-form">${field("name", "项目名称")}<label>空间<select name="workspace"><option>科研</option><option>课程</option><option>日常</option></select></label><label>项目目标<textarea name="description"></textarea></label><button class="primary" type="submit">创建项目</button></form>`,
    ),
  project: (b) => projectDetail(store.get("projects", b.dataset.id)),
  "project-chat": (b) => newChat(b.dataset.id),
  "new-task": (b) => taskEditor(null, b.dataset.project),
  task: (b) => taskEditor(store.get("tasks", b.dataset.id)),
  "new-chat": () => newChat(),
  "all-chats": () => {
    currentConversation = null;
    render();
  },
  conversation: (b) => {
    currentConversation = b.dataset.id;
    currentProject = store.get("conversations", currentConversation)?.projectId;
    render();
  },
  "rename-chat": () =>
    openSheet(
      "重命名对话",
      `<form id="rename-form">${field("title", "名称", "text", store.get("conversations", currentConversation)?.title)}<button class="primary">保存</button></form>`,
    ),
  "pick-context": pickContext,
  reference: (b) => {
    const n = store.get("notes", b.dataset.id);
    if (n) openNote(n);
    else if (store.get("imports", b.dataset.id))
      return openImport(b.dataset.id);
    else notify("原始资料已删除或尚未同步");
  },
  "save-message": async (b) => {
    const m = store.list("messages").find((x) => x.id === b.dataset.id);
    const c = store.get("conversations", currentConversation);
    const n = {
      id: id(),
      title: c.title,
      content: m.content,
      kind: "note",
      workspace: c.workspace,
      projectId: c.projectId,
      sourceConversationId: c.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await store.put("notes", n);
    openNote(n);
  },
  synthesize: async () => {
    if (!selectedRefs.size) throw Error("先选择要整理的随记");
    await newChat();
    document.querySelector("#chat-text").value =
      "请基于所选随记整理共同主题、可能的关联和下一步建议。区分已有证据与待验证的想法。";
  },
  sync: performSync,
  disconnect: async () => {
    await sync.logout();
    render();
  },
  conflicts: conflicts,
  resolve: async (b) => {
    await store.resolve(b.dataset.key, b.dataset.choice);
    conflicts();
    render();
  },
  file: (b) => openImport(b.dataset.id),
  "extract-file": async () => {
    const f = activeImport;
    if (!(
      /\.pdf$/i.test(f.name || f.originalName || "") ||
      f.mimeType?.startsWith("image/")
    ))
      throw Error("当前支持 PDF 文本与图片文字识别");
    notify("正在设备上识别文字…");
    const r = await extractText(f.originalName || f.name, await readImport(f));
    await store.put(
      "imports",
      {
        ...f,
        content: r.text,
        warning: r.warning,
        parser: native ? "ios-device" : "browser-pdf",
        updatedAt: Date.now(),
      },
      f,
    );
    await openImport(f.id);
  },
  "export-file": async () =>
    exportFile(
      activeImport.originalName || activeImport.name,
      await readImport(activeImport),
      activeImport.mimeType,
    ),
  "preview-file": async () => {
    const f = activeImport,
      bytes = await readImport(f);
    if (native) {
      const { toBase64 } = await import("./platform.js");
      await Bridge.preview({
        name: f.originalName || f.name || "file",
        data: toBase64(bytes),
      });
    } else {
      const url = URL.createObjectURL(new Blob([bytes], { type: f.mimeType }));
      openSheet(
        f.title || f.name,
        f.mimeType?.startsWith("image/")
          ? `<img class="file-preview" src="${url}" alt="${esc(f.name)}">`
          : f.mimeType === "application/pdf"
            ? `<iframe title="PDF 预览" src="${url}"></iframe>`
            : `<pre>${esc(f.content || "请导出文件后使用相应应用打开。")}</pre>`,
      );
      sheet.addEventListener("close", () => URL.revokeObjectURL(url), {
        once: true,
      });
    }
  },
  notifications: async () => {
    const allowed = await enableNotifications();
    await store.tx((s) => (s.settings.notifications = allowed));
    notify(allowed ? "提醒已开启" : "尚未获得通知权限");
    render();
  },
  "notifications-off": async () => {
    await store.tx((s) => (s.settings.notifications = false));
    render();
  },
  "import-ics": () => chooseFile(".ics,text/calendar", importICS),
  "commit-ics": async () => {
    const events = sheet._ics;
    await store.tx((s) => {
      for (const e of events) {
        const old = Object.values(s.records).find(
          (r) =>
            !r.deleted &&
            r.data?.kind === "日程" &&
            readEvent(r.data)?.sourceUID === e.sourceUID,
        )?.data;
        putRecord(s, "notes", agendaNote(e, old));
      }
    });
    sheet.close();
    notify("课表已保存");
    render();
  },
  ucas: school,
  "ucas-check": async () => {
    try {
      await ucas.schoolTime(true);
      courseStatus = "学校校时服务连接正常；账号是否有效仍需登录验证。此次检查未提交账号或签到。";
    } catch {
      courseStatus = "无法连接学校校时服务，请检查网络后重试。这不代表账号或密码错误。";
    }
    school();
  },
  "ucas-refresh": async () => {
    courseStatus = "正在查询…";
    school();
    await refreshCourses();
    school();
  },
  "ucas-logout": async () => {
    courses = [];
    await ucas.logout();
    await store.tx((s) => {
      delete s.settings.ucasCache;
      delete s.settings.ucasAuto;
      s.settings.ucasNotices = false;
    });
    courses = [];
    courseStatus = "已退出";
    ucas.clock = null;
    await publishWidget();
    refreshNotifications(true);
    school();
  },
  "ucas-sign": async (b) => {
    const c = courses.find((x) => x.id === b.dataset.id);
    if (!c) throw Error("请先刷新课程");
    if (c.signed) {
      notify("学校已显示签到，请刷新核对");
      return;
    }
    const epoch = ucas.epoch;
    const r = await ucas.sign(c);
    ucas.assertCurrent(epoch);
    courseStatus = r.message;
    if (r.status === "signed") {
      c.signed = true;
      await store.tx((s) => {
        ucas.assertCurrent(epoch);
        if (s.settings.ucasCache) s.settings.ucasCache.courses = courses;
      });
      await publishWidget();
    }
    school();
    notify(r.message);
  },
  "ucas-qr": (b) => courseQR(courses.find((c) => c.id === b.dataset.id)),
  "ucas-auto": async () => {
    if (
      store.state.settings.ucasAuto?.enabled &&
      store.state.settings.ucasAuto.day === schoolDay()
    ) {
      await store.tx((s) => (s.settings.ucasAuto.enabled = false));
      school();
      return;
    }
    openSheet(
      "今日前台自动签到",
      `<p>开启后，AI Bro 在前台时会在课程窗口内自动向学校提交签到。每门课只尝试一次，结果不明时等你手动核对。</p><p>切换后台或锁屏后暂停；明天需要重新开启。请只在实际到课时使用。</p>${button("开启今天的自动签到", "ucas-auto-confirm", "", "primary wide")}`,
    );
  },
  "ucas-auto-confirm": async () => {
    await refreshCourses();
    await store.tx((s) => {
      s.settings.ucasAuto = {
        enabled: true,
        day: schoolDay(),
        attempts:
          s.settings.ucasAuto?.day === schoolDay()
            ? s.settings.ucasAuto.attempts || {}
            : {},
      };
    });
    school();
    await tickCourses();
  },
  "ucas-notices": async () => {
    if (!(await enableNotifications())) throw Error("请在 iOS 设置中允许通知");
    await store.tx((s) => {
      s.settings.ucasNotices = true;
    });
    refreshNotifications(true);
    notify("已为已查询的今日课程安排课前 15 分钟提醒");
  },
  "ucas-calendar": async (b) => {
    const c = courses.find((x) => x.id === b.dataset.id);
    const start = courseInstant(c.day, c.start),
      end = courseInstant(c.day, c.end);
    if (!Number.isFinite(start) || !(end > start))
      throw Error("课程时间无法识别，未创建日程");
    const sourceUID = "ucas:" + c.id + ":" + c.day;
    const old = store
      .list("notes")
      .find((n) => readEvent(n)?.sourceUID === sourceUID);
    await store.put(
      "notes",
      agendaNote(
        {
          title: c.title,
          start,
          end,
          details: c.teacher,
          workspace: "课程",
          sourceUID,
          reminderMinutes: 15,
        },
        old,
      ),
    );
    notify(old ? "课程日程已更新" : "已加入日程");
  },
  backup: async () => {
    notify("正在打包内容与附件原件…");
    const bytes = await createBackup(
      store,
      (hash) => {
        const record = Object.values(store.state.records).find(
          (r) => !r.deleted && r.data?.blobHash === hash,
        )?.data;
        return record ? readImport(record) : files.read(hash);
      },
      sha256,
    );
    await exportFile("AI-Bro-mobile-backup.zip", bytes, "application/zip");
  },
  restore: () =>
    chooseFile(".zip,.json", async (f) => {
      if (f.size > 129 * 1024 * 1024) throw Error("备份文件过大");
      const result = await restoreBackup(
        store,
        new Uint8Array(await f.arrayBuffer()),
        files,
        sha256,
      );
      notify(
        result.legacy
          ? "旧版记录已恢复；附件原件需从同步服务下载"
          : `工作区与 ${result.files} 份原件已恢复`,
      );
      render();
    }),
};
document.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-action]");
  if (!b) return;
  e.preventDefault();
  if (b.disabled) return;
  const fn = actions[b.dataset.action];
  if (fn) {
    b.disabled = true;
    Promise.resolve()
      .then(() => fn(b))
      .catch(error)
      .finally(() => (b.disabled = false));
  }
});
document.addEventListener("change", (e) => {
  if (e.target.dataset.ref) {
    e.target.checked
      ? selectedRefs.add(e.target.dataset.ref)
      : selectedRefs.delete(e.target.dataset.ref);
  }
  if (e.target.id === "day-picker") {
    selectedDay = e.target.value;
    render();
  }
});
document.addEventListener("input", (e) => {
  if (e.target.id === "search") {
    query = e.target.value;
    const start = e.target.selectionStart;
    render();
    const input = document.querySelector("#search");
    input.focus();
    input.setSelectionRange(start, start);
  }
  if (e.target.closest("#capture-form") && e.target.name === "content") {
    const key = "capture:" + (activeNote || "new"),
      text = e.target.value;
    clearTimeout(noteTimer);
    store.tx((s) => (s.drafts[key] = text)).catch(error);
  }
  if (e.target.closest("#note-form")) {
    const form = e.target.closest("form"),
      draft = {
        title: form.elements.title.value,
        content: form.elements.content.value,
      },
      key = "editor:" + activeNote;
    store.tx((s) => (s.drafts[key] = draft)).catch(error);
  }
  if (e.target.id === "chat-text") {
    const key = "chat:" + currentConversation,
      text = e.target.value;
    clearTimeout(noteTimer);
    store.tx((s) => (s.drafts[key] = text)).catch(error);
  }
});
document.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target,
    v = Object.fromEntries(new FormData(f)),
    submit = f.querySelector('button[type="submit"],button:not([type])');
  if (submit?.disabled) return;
  if (submit) submit.disabled = true;
  try {
    if (f.id === "rewrite-form") {
      const noteID = activeNote,
        base = store.get("notes", noteID);
      if (!base || base.aiDraft) throw Error("请先处理现有草稿");
      notify("正在生成草稿…");
      const result = await ask({
        store,
        http,
        vault,
        prompt:
          v.instruction +
          "\n请直接输出改写后的完整 Markdown 正文，不添加外围代码围栏。",
        projectID: base.projectId,
        contextKeys: ["notes:" + noteID],
      });
      await stageDraft(store, noteID, result.text, base);
      reviewNote(store.get("notes", noteID));
    } else if (f.id === "capture-form") {
      const selected = [...f.elements.files.files, ...f.elements.camera.files];
      if (!String(v.content).trim() && !selected.length)
        throw Error("写一点内容或添加附件");
      const attachments = [...(noteOriginal?.sourceAttachmentIds || [])];
      for (const file of selected) attachments.push(await attach(file));
      const now = Date.now(),
        n = {
          ...noteOriginal,
          id: activeNote || id(),
          kind: "随记",
          userEdited: true,
          userEditedAt: Date.now(),
          workspace: "日常",
          title: v.content.trim().split("\n")[0].slice(0, 70) || "附件随记",
          content: v.content,
          tags: v.tags
            .split(/[,，]/)
            .map((x) => x.trim())
            .filter(Boolean),
          projectId: v.project || null,
          sourceAttachmentIds: attachments,
          createdAt: noteOriginal?.createdAt || now,
          updatedAt: now,
        };
      clearTimeout(noteTimer);
      await store.put("notes", n, noteOriginal || undefined);
      await store.tx(
        (s) => delete s.drafts["capture:" + (activeNote || "new")],
      );
      sheet.close();
      notify("已保存到此设备");
      render();
    } else if (f.id === "note-form") {
      const old = noteOriginal;
      await store.put(
        "notes",
        {
          ...old,
          title: v.title,
          content: v.content,
          updatedAt: Date.now(),
          userEdited: true,
          revisionHistory: [
            ...(old.revisionHistory || []),
            {
              title: old.title,
              content: old.content,
              at: Date.now(),
              reason: "手机编辑",
            },
          ],
        },
        old,
      );
      await store.tx((s) => delete s.drafts["editor:" + old.id]);
      openNote(store.get("notes", old.id));
      render();
    } else if (f.id === "event-form") {
      const old = noteOriginal && readEvent(noteOriginal),
        start =
          old && v.start === f.dataset.start ? old.start : +new Date(v.start),
        end = old && v.end === f.dataset.end ? old.end : +new Date(v.end);
      if (!v.title.trim() || !(end > start))
        throw Error("请填写标题，并让结束时间晚于开始时间");
      if (
        (old?.ics ||
          (old?.recurrence && old.recurrence.frequency !== "none")) &&
        (start !== old.start || end !== old.end)
      )
        throw Error("重复课表请通过重新导入修改时间");
      await store.put(
        "notes",
        agendaNote(
          {
            ...old,
            title: v.title,
            timeZone:
              old?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
            start,
            end,
            location: v.location,
            details: v.details,
            projectId: v.project || null,
            sourceNoteIds: f.dataset.source
              ? [f.dataset.source]
              : old?.sourceNoteIds || [],
            reminderMinutes: v.reminder === "" ? null : Number(v.reminder),
          },
          noteOriginal,
        ),
        noteOriginal || undefined,
      );
      sheet.close();
      render();
    } else if (f.id === "project-form") {
      if (!v.name.trim()) throw Error("填写项目名称");
      await store.put("projects", {
        id: id(),
        name: v.name,
        workspace: v.workspace,
        description: v.description,
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      sheet.close();
      render();
    } else if (f.id === "task-form") {
      if (!v.title.trim()) throw Error("填写任务名称");
      const old = store.get("tasks", f.dataset.id);
      const task = {
        ...old,
        id: old?.id || id(),
        title: v.title,
        status: v.status,
        projectId: v.project || null,
        workspace: store.get("projects", v.project)?.workspace || "日常",
        dueAt: v.due ? new Date(v.due).toISOString() : null,
        completedAt:
          v.status === "done" ? old?.completedAt || Date.now() : null,
        createdAt: old?.createdAt || Date.now(),
        updatedAt: Date.now(),
      };
      if (v.reminder === "inherit") delete task.reminderMinutes;
      else task.reminderMinutes = v.reminder === "off" ? null : Number(v.reminder);
      await store.put("tasks", task);
      sheet.close();
      render();
    } else if (f.id === "rename-form") {
      if (!v.title.trim()) throw Error("填写名称");
      await store.put("conversations", {
        ...store.get("conversations", currentConversation),
        title: v.title,
        updatedAt: Date.now(),
      });
      sheet.close();
      render();
    } else if (f.id === "task-reminder-settings") {
      await store.tx(s=>s.settings.taskReminderMinutes=v.minutes === "off" ? null : Number(v.minutes));
      notify("提醒设置已保存"); render();
    } else if (f.id === "model-form") {
      const u = new URL(v.base);
      if (
        u.protocol !== "https:" ||
        u.username ||
        u.password ||
        u.search ||
        u.hash ||
        !v.model.trim()
      )
        throw Error("请填写有效 HTTPS API 地址和模型名称");
      if (v.key) await vault.set("model", v.key.trim());
      await store.tx(
        (s) =>
          (s.settings.model = {
            base: u.href.replace(/\/$/, ""),
            model: v.model.trim(),
            format: v.format,
          }),
      );
      notify(
        native
          ? "连接设置已保存，Key 存入钥匙串"
          : "设置已保存；Key 只保留在当前标签页会话，关闭后需重新填写",
      );
      render();
    } else if (f.id === "sync-form") {
      if (new URLSearchParams(location.search).get("demo") === "1")
        throw Error("演示工作区不连接真实账号，请打开普通页面");
      notify("正在连接并同步…");
      await sync.login(v.server, v.username, v.password);
      f.elements.password.value = "";
      notify(sync.status);
      render();
    } else if (f.id === "ucas-form") {
      await ucas.login(v.username, v.password, {
        remember: v.remember === "on",
      });
      const epoch = ucas.epoch;
      f.elements.password.value = "";
      await store.tx((s) => {
        ucas.assertCurrent(epoch);
        delete s.settings.ucasAuto;
        delete s.settings.ucasCache;
        s.settings.ucasNotices = false;
      });
      ucas.assertCurrent(epoch);
      courses = [];
      await publishWidget();
      refreshNotifications(true);
      try {
        await refreshCourses();
        courseStatus = "学校账号已连接";
      } catch (err) {
        courseStatus = "账号已连接，但课程读取未完成：" + err.message;
      }
      school();
    } else if (f.id === "chat-form") {
      const text = f.querySelector("textarea").value.trim();
      if (!text || busy) return;
      await store.tx((s) => (s.drafts["chat:" + currentConversation] = text));
      busy = true;
      render();
      try {
        const r = await ask({
          store,
          http,
          vault,
          prompt: text,
          conversationID: currentConversation,
          projectID: currentProject,
          contextKeys: [...selectedRefs],
        });
        currentConversation = r.conversationID;
        await store.tx((s) => delete s.drafts["chat:" + currentConversation]);
      } catch (err) {
        if (err.conversationID) currentConversation = err.conversationID;
        throw err;
      } finally {
        busy = false;
        render();
      }
    }
  } catch (err) {
    error(err);
  } finally {
    if (submit) submit.disabled = false;
  }
});
let notificationKey = "";
store.addEventListener("change", () => {
  clearTimeout(syncTimer);
  if (
    store.state.binding &&
    !sync.busy &&
    Object.values(store.state.records).some((r) => r.dirty && !r.conflict)
  )
    syncTimer = setTimeout(
      () =>
        sync
          .run()
          .then(() => {
            safeRender();
          })
          .catch(() => {
            safeRender();
          }),
      5000,
    );
  refreshNotifications();
  publishWidget().catch(error);
});
function refreshNotifications(force = false) {
  const next = [
      ...(store.state.settings.notifications
        ? eventsFor(store, Date.now(), Date.now() + 30 * 86400000)
        : []),
      ...courseNotices(),
    ],
    key = JSON.stringify([
      store.state.settings.notifications,
      next.map((e) => [e.occurrenceID, e.title, e.reminderAt]),
    ]);
  if (force || key !== notificationKey) {
    notificationKey = key;
    noticeTail = noticeTail
      .catch(() => {})
      .then(() =>
        reconcileNotifications(
          next,
          !!(
            store.state.settings.notifications ||
            store.state.settings.ucasNotices
          ),
        ),
      )
      .catch(error);
  }
}

async function acceptShared() {
  if (!native) return;
  const count = await receiveShared(store, Bridge, files, sha256);
  if (count) {
    notify("已接收 " + count + " 条分享资料");
    safeRender();
  }
}

if (native) {
  const { Keyboard } = await import("@capacitor/keyboard");
  Keyboard.addListener("keyboardWillShow", () =>
    document.body.classList.add("keyboard-open"),
  );
  Keyboard.addListener("keyboardWillHide", () =>
    document.body.classList.remove("keyboard-open"),
  );
  App.addListener("appStateChange", ({ isActive }) => {
    appForeground = isActive;
    if (!isActive) {
      stopQR();
      const q = sheet.querySelector("#qr-image");
      if (q) q.innerHTML = "";
    }
    if (isActive) {
      refreshNotifications(true);
      publishWidget().catch(error);
      tickCourses().catch(error);
      acceptShared().catch(error);
      sync
        .run()
        .then(safeRender)
        .catch(() => {});
    }
  });
  App.addListener("appUrlOpen", ({ url }) => {
    if (url.startsWith("aibro://today")) {
      sheet.close();
      tab = "today";
      render();
    }
  });
  const { LocalNotifications } = await import("@capacitor/local-notifications");
  LocalNotifications.addListener("localNotificationActionPerformed", () => {
    tab = "today";
    render();
  });
  refreshNotifications(true);
  acceptShared().catch(error);
}
window.addEventListener("online", () =>
  sync
    .run()
    .then(safeRender)
    .catch(() => {}),
);
render();
sync
  .run()
  .then(safeRender)
  .catch(() => {});
// Synthetic demo is explicitly opt-in and never added to a nonempty workspace.
if (
  new URLSearchParams(location.search).get("demo") === "1" &&
  !Object.keys(store.state.records).length
) {
  const { seed } = await import("./seed.js");
  await seed(store);
  render();
}

setInterval(tickCourses, 15000);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopQR();
    const q = sheet.querySelector("#qr-image");
    if (q) q.innerHTML = "";
    const label = sheet.querySelector("#qr-status");
    if (label) label.textContent = "已暂停，请返回课程重新打开签到码";
  } else {
    sync.run().then(safeRender).catch(() => {});
    refreshNotifications(true);
    tickCourses().catch(error);
    publishWidget().catch(error);
  }
});
publishWidget().catch(error);

if (!native) {
  document.body.classList.add("web-app");
  refreshNotifications(true);
  if (import.meta.env.PROD && "serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}
