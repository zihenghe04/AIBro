import "./style.css";
import { mountMobileViewport } from "./mobile-viewport.js";
import { sizeComposer, sizeComposers } from "./composer-size.js";
import { version as appVersion } from "../package.json";
import { conversationMessage, conversationResults, inspectResultTarget } from "./conversation-results.js";
import { NavigationMemory, captureConversationPosition, conversationScrollTarget } from "./navigation.js";
import { messageSources } from "./message-sources.js";
import { mountConversationResults } from "./ui/conversation-results.js";
import { mountConversationActivity, stableContent, isActivityLayoutScroll } from "./ui/conversation-activity.js";
import { applyMarkdownEdit } from "./markdown-edit.js";
import { createConversationContext, restoreConversationContext, conversationContextStatus, conversationContextOptions, selectConversationContext } from "./conversation-context.js";
import { mountConversationContextStatus } from "./ui/conversation-context-status.js";
import { mountDocumentToolbar, mountDocumentSaveBar, mountDocumentOrigin } from "./ui/document-toolbar.js";
import "./ui/document-workspace.css";
import { mountTaskActions } from "./ui/task-actions.js";
import { mountHomePlanner } from "./ui/home-planner.js";
import "./ui/home-workspace.css";
import { taskChecklistRows, editedChecklist, unchangedTaskDate } from "./task-editor.js";
import { taskStatusOptions, taskPriorityOptions, taskStatusSelection, taskPrioritySelection, taskStatusLabel, taskStatePatch } from "./task-status.js";
import { editedProject, recordProjectSelection, recordProjectOptions } from "./record-project.js";
import { createEditorDraft, inspectEditorDraft, getEditorDraftWrite, editorDraftCopy } from "./editor-draft.js";
import { mountEditorRecovery } from "./ui/editor-recovery.js";
import { formDraftKey, createFormDraft, inspectFormDraft, getFormDraftWrite, clearFormDraft } from "./form-draft.js";
import { mountFormDraft } from "./ui/form-draft.js";
import { syncGroupSummaries, syncGroupReview } from "./sync-groups.js";
import { mountSyncGroupReview } from "./ui/sync-group-review.js";
import { icon } from "./icons.js";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { App } from "@capacitor/app";
import { Store, id, putRecord, conflictReview, equal } from "./store.js";
import { ConversationSessions } from "./conversation-session.js";
import { validatePlan, applyPlan, rejectPlan } from "./agent-tools.js";
import { reviewRemoval, removeRecord, reviewRestore, restoreRecord, listRecoverable } from "./lifecycle.js";
import { Sync } from "./sync.js";
import { SyncScheduler } from "./sync-scheduler.js";
import { mountSyncStatus } from "./ui/sync-status.js";
import { mountPlanReview } from "./ui/plan-review.js";
import {
  adapter,
  prepareWorkspace,
  extractText,
  vault,
  http,
  httpStream,
  platformName,
  deviceLabel,
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
import { saveModelSettings, useModelProfile } from "./model-credentials.js";
import { deleteApiProfile } from "./api-profiles.js";
import { createApiProfileEditor } from "./api-profile-editor.js";
import { mountApiProfileSettings } from "./ui/api-profile-settings.js";
import "../../app/connection-vault.js";
import "../../app/connection-sync-client.js";
import { createConnectionManager } from "./connection-sync.js";
import { mountConnectionSync, mountConnectionNavigation } from "./connection-sync-ui.js";
import { connectionSelectionView, paintConnectionSelection, revealSettingsTarget } from "./connection-presentation.js";
import { validateSpeechConnection, transcribeWithConnections } from "./connection-speech.js";
import { editAgendaEvent, eventLocalInput, eventLocalInstant, isRepeatingEvent } from "./agenda-edit.js";
import { saveSpeechSettings, useSpeechProfile, testSpeechSettings } from "./speech.js";
import { VoiceSession, waitForVoiceAcceptance } from "./voice-session.js";
import { voiceDestination, voiceDestinationLabel, prepareVoiceConversation } from "./voice-routing.js";
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
import { extractPendingImports, retryImportText } from "./import-processing.js";
import { createBackup, restoreBackup } from "./backup.js";
import { diffLines } from "diff";
import { stageDraft, applyDraft } from "./review.js";
const app = document.querySelector("#app"),
  sheet = document.querySelector("#sheet");
const mobileViewport = mountMobileViewport({ native,
  onChange: ({ visibleHeight }) => sizeComposers(document, { visibleHeight }),
});
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
const sync = new Sync(store, http, vault, files, deviceLabel),
  ucas = new UCAS(http, vault);
let connectionSyncUI = null;
let connectionNavigationUI = null, connectionSettingsMount = null;
let apiProfileUIs = [];
const apiProfileEditors = Object.fromEntries(['chat', 'speech'].map(purpose => [purpose, createApiProfileEditor({ store, purpose,
  save: values => purpose === 'chat' ? saveModelSettings(store, vault, values) : saveSpeechSettings(store, vault, values),
  use: profileId => purpose === 'chat' ? useModelProfile(store, vault, profileId) : useSpeechProfile(store, vault, profileId),
  remove: profileId => deleteApiProfile(store, purpose, profileId),
  test: purpose === 'speech' ? values => testSpeechSettings({ store, vault, values, http }) : null,
})]));
const connectionSync = createConnectionManager({ store, vault, bridge: Bridge, http, native,
  cryptoAPI: globalThis.AIBroConnectionVault.createConnectionVault(),
  onChange: state => { connectionSyncUI?.update(state); paintModelConnection(state); for (const ui of apiProfileUIs) ui.update(); },
});
function modelConnectionView(purpose = 'chat', state = connectionSync.snapshot()) {
  return connectionSelectionView(state, store.state.settings, store.state.binding, purpose);
}
function paintModelConnection(state = connectionSync.snapshot()) {
  paintConnectionSelection(document, modelConnectionView('chat', state));
}
async function mountConnectionSettings() {
  const root = document.querySelector('#connection-sync-root');
  if (!root) return;
  const handle = await mountConnectionSync(root, connectionSync, {
    selectionView: modelConnectionView, onConnectCloud: () => openSettingsSection('#sync-form'),
  });
  if (!root.isConnected) return handle?.unmount();
  connectionSyncUI = handle;
  const nav = document.querySelector('#connection-navigation-root');
  const navigationHandle = nav && await mountConnectionNavigation(nav, target => openSettingsSection(target));
  if (!root.isConnected) return navigationHandle?.unmount();
  connectionNavigationUI = navigationHandle;
  for (const [purpose, formID] of [['chat', 'model-form'], ['speech', 'speech-form']]) {
    const host = document.querySelector(`#api-${purpose}-profiles`), form = document.getElementById(formID);
    if (!host || !form) continue;
    const profileHandle = await mountApiProfileSettings(host, form, apiProfileEditors[purpose], { purpose,
      onSaved: () => { connectionSyncUI?.update(connectionSync.snapshot()); paintModelConnection(); }, onError: error });
    if (!root.isConnected) { profileHandle?.unmount(); return; }
    if (profileHandle) apiProfileUIs.push(profileHandle);
  }
}
async function openSettingsSection(selector) {
  if (tab !== 'settings') navigatePage('settings');
  const revision = navigationRevision, root = document.querySelector('#connection-sync-root');
  await connectionSettingsMount;
  // Kit commits on the next frame; never scroll an empty or superseded island.
  await new Promise(resolve => requestAnimationFrame(resolve));
  if (tab !== 'settings' || navigationRevision !== revision || root !== document.querySelector('#connection-sync-root')) return;
  revealSettingsTarget(document, selector);
}
const sessions = new ConversationSessions(), refsByConversation = new Map(), conflictReviews = new Map();
let tab = "today",
  selectedDay = dayKey(),
  knowledgeMode = "notes",
  query = "",
  currentProject = null,
  currentConversation = null,
  selectedRefs = new Set(),
  sourceMode = false,
  activeNote = null,
  noteOriginal = null,
  activeImport = null;
let homeDraft = store.state.drafts["home:new"] || "", composingHome = null, deferredHomeRender = false, homeDraftRevision = 0;
let navigationRevision = 0, resultIslands = [];
const navigation = new NavigationMemory();
let homePlannerUI = null, homePlannerMode = "agenda", homeShowCompleted = false;
let syncScheduler, syncSnapshot, lastSyncError = "", syncHeaderUI, syncPanelUI;
let reviewDraft = null,
  courses =
    store.state.settings.ucasCache?.day === schoolDay()
      ? store.state.settings.ucasCache.courses
      : [],
  courseStatus = courses.length ? "上次课程缓存，请刷新确认最新状态" : "",
  noteTimer,
  toastTimer,
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
    (value && !items.some(p => p.id === value) ? `<option value="${esc(value)}" selected>原项目（暂不可用）</option>` : "") +
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
function disposeSyncPanel() { syncPanelUI?.unmount(); syncPanelUI = null; }
sheet.addEventListener("close", disposeSyncPanel);
let planReviewUI = null, planReviewBusy = false;
let taskActionsUI = null, taskSaving = false;
let editorRecoveryUI = null, editorSaving = false, editorSession = null;
let documentToolbarUI = null, documentSaveUI = null, documentOriginUI = null;
let pendingContextRefs = null, contextPickerID = null, contextPickerBase = null;
let contextStatusUI = null, contextStatusMount = null, contextSaving = false;
const captureRefs = new Set();
function disposeDocumentUI() { documentToolbarUI?.unmount(); documentSaveUI?.unmount(); documentToolbarUI = documentSaveUI = null; }
sheet.addEventListener("close", disposeDocumentUI);
const editorForms = new WeakMap();
function disposeEditorRecovery() { editorRecoveryUI?.unmount(); editorRecoveryUI = null; }
sheet.addEventListener("close", disposeEditorRecovery);
function disposeTaskActions() { taskActionsUI?.unmount(); taskActionsUI = null; }
sheet.addEventListener("close", disposeTaskActions);
function disposePlanReview() { planReviewUI?.unmount(); planReviewUI = null; }
sheet.addEventListener("close", disposePlanReview);
let syncGroupUI = null, syncGroupBusy = false;
function disposeSyncGroups() { syncGroupUI?.unmount(); syncGroupUI = null; }
sheet.addEventListener("close", disposeSyncGroups);
sheet.addEventListener("cancel", event => { event.preventDefault(); closeSheetNavigation().catch(error); });
sheet.addEventListener("close", () => { if (!sheet.open) navigation.clearSheets(); });
function openSheet(title, body, destination = null) {
  navigationRevision++;
  if (!sheet.open) navigation.clearSheets();
  navigation.openSheet(destination, sheet.scrollTop);
  sheet.classList.remove("document-sheet");
  disposeDocumentUI();
  pendingContextRefs = null; contextPickerID = null; contextPickerBase = null;
  stopQR();
  disposePlanReview();
  disposeSyncPanel();
  disposeSyncGroups();
  disposeTaskActions();
  disposeEditorRecovery();
  clearTimeout(noteTimer);
  sheet.innerHTML = `<div class="sheet-head"><h2 title="${esc(title)}">${esc(title)}</h2><div class="sheet-head-actions">${navigation.hasParentSheet ? button("返回", "sheet-back", "", "quiet") : ""}${button("关闭", "close", "", "quiet")}</div></div>${body}`;
  if (!sheet.open) sheet.showModal();
  sheet.scrollTop = 0;
}
async function preserveSheetDraftForNavigation() {
  if (typeof retainSheetFormDraft === 'function' && !await retainSheetFormDraft()) return false;
  const form = sheet.querySelector('#capture-form,#note-form');
  if (form) await retainEditorInput(form);
  await store.tail;
  return true;
}
function restoreSheetDestination(destination) {
  const target = { kind: destination.kind === 'captures' ? 'notes' : destination.kind, id: destination.id };
  const current = inspectResultTarget(store, target);
  if (current.state !== 'available' || destination.kind === 'captures' && current.data.kind !== '随记')
    throw Error('上层内容已不可用，已返回原页面');
  return openResultTarget(target);
}
async function closeSheetNavigation({ all = false } = {}) {
  if (taskSaving || editorSaving || planReviewBusy || syncGroupBusy) return false;
  const revision = ++navigationRevision;
  if (!await preserveSheetDraftForNavigation()) return false;
  if (revision !== navigationRevision || !sheet.open) return false;
  let parent;
  while (!all && (parent = navigation.backSheet())) {
    try {
      await restoreSheetDestination(parent.destination);
      sheet.scrollTop = parent.scrollTop;
      return true;
    } catch (failure) { error(failure); }
  }
  sheet.close(); navigation.clearSheets(); render();
  return true;
}
function navigatePage(nextTab, conversationID = currentConversation) {
  navigationRevision++;
  tab = nextTab; currentConversation = conversationID;
  navigation.clearSheets(); sheet.close(); render();
}
async function navigateBack() {
  navigationRevision++;
  if (voiceDialog.open) { await voice.cancel(); voiceDialog.close(); return; }
  if (sheet.open) return closeSheetNavigation();
  if (tab === 'chat' && currentConversation) return navigatePage('chat', null);
  if (tab !== 'today') return navigatePage('today');
  if (native) return App.minimizeApp();
}
async function openAppURL({ url }) {
  if (!url?.startsWith('aibro://voice/new') && !url?.startsWith('aibro://today')) return;
  const revision = ++navigationRevision;
  if (sheet.open && !await preserveSheetDraftForNavigation()) return;
  if (revision !== navigationRevision) return;
  if (url.startsWith('aibro://voice/new')) {
    const pending = await Bridge.voiceShortcutPending();
    if (revision === navigationRevision) return acceptVoiceShortcut(pending);
    return;
  }
  navigatePage('today');
}
function countConflicts() {
  const groups = syncGroupSummaries(store.state), groupedKeys = new Set(groups.flatMap(group => group.keys));
  return groups.filter(group => group.status === "blocked").length +
    Object.entries(store.state.records).filter(([key, record]) => record.conflict && !groupedKeys.has(key)).length;
}
function syncView() {
  const s = syncSnapshot || { authenticated: false, online: navigator.onLine };
  const conflictCount = countConflicts();
  const state = s.authBlocked ? "auth-expired" : !s.authenticated || !s.online ? "offline"
    : s.running ? "syncing" : conflictCount ? "conflict" : s.failures ? "error"
    : s.pendingCount || !store.state.settings.lastSync ? "pending" : "synced";
  return { state, connected: s.authenticated, online: s.online, pendingCount: s.pendingCount,
    conflictCount, lastSync: store.state.settings.lastSync,
    error: ["error", "auth-expired"].includes(state) ? lastSyncError : "" };
}
function updateSyncUI(snapshot = syncSnapshot) {
  syncSnapshot = snapshot;
  const props = syncView();
  syncHeaderUI?.update(props); syncPanelUI?.update(props);
}
async function mountHeaderSync() {
  const root = document.querySelector("#sync-status-root");
  if (!root) return;
  try {
    const handle = await mountSyncStatus(root, { ...syncView(), compact: true, onOpen: openSyncDetails });
    if (!root.isConnected) return handle.unmount();
    syncHeaderUI = handle;
    handle.update(syncView());
  } catch {
    if (root.isConnected && !root.childNodes.length)
      root.innerHTML = button("同步", "sync-details", 'aria-label="打开同步详情"', "quiet");
  }
}
async function openSyncDetails() {
  openSheet("设备同步", '<div id="sync-detail-root"></div>');
  const root = sheet.querySelector("#sync-detail-root");
  try {
    const handle = await mountSyncStatus(root, { ...syncView(), onSync: performSync, onConflicts: conflicts,
      onSettings: () => openSettingsSection('#sync-form') });
    if (!root.isConnected || !sheet.open) return handle.unmount();
    syncPanelUI = handle;
    handle.update(syncView());
  } catch (e) { if (root.isConnected && sheet.open) error(e); }
}
async function savedSyncSession() {
  try {
    const s = JSON.parse(await vault.get("sync") || "null");
    return s?.token && s.base === store.state.binding?.base ? s.token : null;
  } catch { return null; }
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
let composingChat = null, deferredChatRender = null, composerEndTimer, composerRevision = 0;
function render({ chatDraftUpdate = null } = {}) {
  const homeInput = document.querySelector('#home-chat-text');
  const homeInputState = tab === "today" && homeInput && document.activeElement === homeInput
    ? { start: homeInput.selectionStart, end: homeInput.selectionEnd } : null;
  if (homeInput) homeDraft = homeInput.value;
  if (tab === 'today' && composingHome?.isConnected) { deferredHomeRender = true; return; }
  deferredHomeRender = false;
  const sameConversation = tab === "chat" && currentConversation && renderedConversation === currentConversation;
  // Replacing even a refocused textarea cancels the native IME candidate range.
  // Wait through compositionend's following input event before rebuilding it.
  if (sameConversation && composingChat?.element.isConnected && composingChat.conversationID === currentConversation) {
    deferredChatRender = { chatDraftUpdate: chatDraftUpdate || deferredChatRender?.chatDraftUpdate || null };
    return;
  }
  composingChat = null;
  deferredChatRender = null;
  const existingInput = sameConversation && document.querySelector("#chat-text");
  const inputState = existingInput ? { value: existingInput.value, start: existingInput.selectionStart, end: existingInput.selectionEnd, focused: document.activeElement === existingInput } : null;
  const useDraftUpdate = chatDraftUpdate?.conversationID === currentConversation && chatDraftUpdate.inputRevision === composerRevision;
  if (sameConversation && reconcileConversation()) {
    if (useDraftUpdate && existingInput) existingInput.value = chatDraftUpdate.value;
    refreshConversationContextUI();
    documentOriginUI?.unmount(); documentOriginUI = null;
    document.querySelector('#document-origin-root')?.replaceChildren(); mountDocumentSource();
    updateSyncUI(syncScheduler?.snapshot);
    paintModelConnection();
    sizeComposers(document, { visibleHeight: mobileViewport.state.visibleHeight });
    return;
  }
  if (renderedConversation && !sameConversation)
    navigation.rememberConversation(renderedConversation, captureConversationPosition(document, window.scrollY));
  const oldY = window.scrollY;
  app.dataset.activeConversation = String(tab === "chat" && !!currentConversation);
  const titles = {
    today: "首页",
    captures: "随记",
    knowledge: "知识与项目",
    chat: "对话",
    settings: "设置",
  };
  documentOriginUI?.unmount(); documentOriginUI = null;
  contextStatusUI?.unmount(); contextStatusUI = null; contextStatusMount = null;
  syncHeaderUI?.unmount(); syncHeaderUI = null;
  for (const island of resultIslands) island.unmount();
  resultIslands = [];
  disposeMessageReaders();
  homePlannerUI?.unmount(); homePlannerUI = null;
  connectionSyncUI?.unmount(); connectionSyncUI = null;
  connectionNavigationUI?.unmount(); connectionNavigationUI = null; connectionSettingsMount = null;
  for (const ui of apiProfileUIs) ui.unmount(); apiProfileUIs = [];
  app.innerHTML = `<header><div class="brand"><img src="/brand.png" alt=""><span>AI Bro</span></div><div class="header-actions"><div id="sync-status-root"></div>${button(icon("settings"), "tab", 'data-tab="settings" aria-label="设置"', "icon-button")}</div></header><main data-route="${tab}"><div class="page-title"><div><div class="eyebrow">${tab === "today" ? new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" }) : "你的随身 AI 助手"}</div><h1>${titles[tab]}</h1></div>${tab === "captures" ? button("＋", "new-capture", "", "round") : ""}</div>${tab === "today" ? today() : tab === "captures" ? captures() : tab === "knowledge" ? knowledge() : tab === "chat" ? chat() : settings()}</main><nav aria-label="主导航">${["today", "captures", "knowledge", "chat"].map((t) => `<button data-action="tab" data-tab="${t}" aria-current="${t === tab ? "page" : "false"}" class="${t === tab ? "selected" : ""}"><span>${icon(t)}</span>${{ today: "首页", captures: "随记", knowledge: "知识", chat: "对话" }[t]}</button>`).join("")}</nav>`;
  mountHeaderSync();
  if (tab === "today") {
    mountHomeWorkspace();
    if (homeInputState) {
      const input = document.querySelector("#home-chat-text");
      input.focus({ preventScroll: true });
      input.setSelectionRange(homeInputState.start, homeInputState.end);
      window.scrollTo(0, oldY);
    }
  }
  if (tab === "chat" && currentConversation) {
    reconcileConversation();
    mountMessageResults();
    mountDocumentSource();
    refreshConversationContextUI();
    const input = document.querySelector("#chat-text");
    input.value = store.state.drafts["chat:" + currentConversation] || "";
    if (useDraftUpdate) input.value = chatDraftUpdate.value;
    else if (inputState) input.value = inputState.value;
    if (inputState?.focused) {
      input.focus({ preventScroll: true });
      input.setSelectionRange(useDraftUpdate ? input.value.length : inputState.start, useDraftUpdate ? input.value.length : inputState.end);
    }
    if (renderedConversation === currentConversation) window.scrollTo(0, oldY);
    else {
      const cid = currentConversation, revision = navigationRevision, position = navigation.conversation(cid);
      if (position && sessions.get(cid)) sessions.get(cid).follow = false;
      const restore = () => {
        if (tab !== 'chat' || currentConversation !== cid || navigationRevision !== revision) return;
        window.scrollTo(0, conversationScrollTarget(document, position, window.scrollY));
        previousScroll = window.scrollY;
      };
      restore(); requestAnimationFrame(restore);
    }
  }
  renderedConversation = tab === "chat" ? currentConversation : null;
  if (tab === "settings") connectionSettingsMount = mountConnectionSettings().catch(error);
  if (tab === "chat") paintModelConnection();
  if (tab === "settings" && native) refreshVoiceStatus();
  sizeComposers(document, { visibleHeight: mobileViewport.state.visibleHeight });
}
let renderedConversation = null;
function homePlannerProps() {
  const from = new Date(selectedDay + "T00:00:00"), to = new Date(from);
  to.setDate(to.getDate() + 1);
  const update = () => homePlannerUI?.update(homePlannerProps());
  return {
    mode: homePlannerMode, selectedDay, today: dayKey(), showCompleted: homeShowCompleted,
    events: eventsFor(store, +from, +to), tasks: active(store.list("tasks")), projects: active(store.list("projects")),
    onMode: mode => { homePlannerMode = mode; update(); },
    onDay: day => { selectedDay = day; update(); },
    onShowCompleted: value => { homeShowCompleted = value; update(); },
    onNewEvent: day => editEvent(null, null, day),
    onNewTask: () => taskEditor(null),
    onTask: task => openResultTarget({ kind: "tasks", id: task.id }),
    onEvent: event => openResultTarget({ kind: event.task ? "tasks" : "agenda", id: event.id }),
    onError: error,
    onImport: () => chooseFile(".ics,text/calendar", importICS),
    onCourses: () => actions.ucas(),
  };
}
async function mountHomeWorkspace() {
  const root = document.querySelector("#home-planner-root");
  if (!root) return;
  try {
    const handle = await mountHomePlanner(root, homePlannerProps());
    if (!root.isConnected) { handle?.unmount(); return; }
    homePlannerUI = handle;
  } catch (e) {
    if (root.isConnected) root.innerHTML = `<p class="hint">安排列表暂时未能加载，请重新打开首页。</p><div class="actions">${button("新建日程", "new-event")}${button("新建任务", "new-task")}</div>`;
  }
}
function today() {
  const recent = active(store.list("conversations")).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0)).slice(0,3);
  const projects = active(store.list("projects")).slice(0,3);
  return `<section class="home-conversation" aria-label="开始新对话"><form id="home-chat-form"><label class="sr-only" for="home-chat-text">给 AI Bro 的新消息</label><textarea id="home-chat-text" rows="2" required placeholder="记下一件事，或让 AI 帮你处理…">${esc(homeDraft)}</textarea><div class="home-compose-actions">${button(icon('microphone')+' 说句话', "voice-new", 'type="button" aria-label="语音新会话"', "primary")}${button("键盘输入", "focus-home", 'type="button"', "quiet")}<button type="submit" class="round" aria-label="发送新会话">${icon("send")}</button></div></form><small>语音发送前可预览、修改或取消</small></section>
    ${recent.length ? `<section class="home-recent-section"><div class="section-heading"><h2>最近对话</h2>${button("全部", "home-chats", 'aria-label="查看全部对话"', "text-button")}</div><div class="home-recent">${recent.map(c=>`<button class="home-recent-item" data-action="conversation" data-id="${esc(c.id)}"><span class="home-recent-icon">${icon("chat")}</span><span class="home-recent-copy"><strong>${esc(c.title||"新对话")}</strong><small>${esc(store.get("projects",c.projectId)?.name||"独立对话")}${sessions.get(c.id)?" · 正在回复":""}</small></span><span aria-hidden="true">›</span></button>`).join("")}</div></section>` : ""}
    <section id="home-planner-root" aria-label="日程与待办"></section>
    <section class="home-projects"><div class="section-heading"><h2>项目</h2>${button("全部项目", "projects", "", "text-button")}</div>${projects.length ? `<div class="stack">${projects.map(projectRow).join("")}</div>` : `<div class="home-project-empty"><p>把相关的资料、任务和对话放在一起。</p>${button("新建项目", "new-project", "", "quiet")}</div>`}</section>`;
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
  return `<p class="lead">记下零散的念头，让它们慢慢长成线索。</p><input class="search" id="search" placeholder="搜索想法、标签…" value="${esc(query)}"><div class="actions">${button("✦ 整理所选随记", "synthesize", "", "quiet")}</div><section class="stack">${rows.map((n) => `<div class="capture-card"><label class="select-capture"><input type="checkbox" data-ref="notes:${n.id}" ${captureRefs.has("notes:" + n.id) ? "checked" : ""}>选择</label>${noteRow(n)}</div>`).join("") || '<div class="empty">路上想到的事，先放在这里。<small>支持文字、链接、图片与文件。</small></div>'}</section>`;
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
function messageFooter(m) {
  const assistant = m.role === "assistant";
  const status = { cancelled: "已停止 · 保留了已生成的内容", failed: "回复未完成", running: "上次回复尚未完成，可重新发送" }[m.status];
  return `${status ? `<p class="hint">${esc(status)}${m.error ? "：" + esc(m.error) : ""}</p>` : ""}${m.pendingPlan?.status === "pending" && m.pendingPlan.conversationID === m.conversationId && !m._conflict && !["failed", "cancelled"].includes(m.status) ? button(`审阅 ${m.pendingPlan.actions.length} 项修改`, "review-plan", `data-id="${esc(m.id)}"`, "primary") : ""}<div class="message-actions">${button("复制", "copy-message", `data-id="${esc(m.id)}"`, "text-button")}${assistant ? button("保存为笔记", "save-message", `data-id="${esc(m.id)}"`, "text-button") : button("再次编辑", "reuse-message", `data-id="${esc(m.id)}"`, "text-button")}</div><div class="message-sources">${messageSources(store,m).map(source => button(`[${source.label}] ${esc(source.title)}`, "reference", `data-source-index="${source.index}" ${source.target ? `data-source-kind="${esc(source.identity.kind)}" data-source-id="${esc(source.identity.id)}" data-source-target-kind="${esc(source.target.kind)}" data-source-target-id="${esc(source.target.id)}"` : "disabled"}`, "reference")).join("")}</div>`;
}
function messageHTML(m) {
  const assistant = m.role === "assistant";
  return `<article class="message ${assistant ? "assistant" : "user"}" data-message="${esc(m.id)}" data-conversation="${esc(m.conversationId)}" data-message-key="${esc(m._key || "")}"><small>${assistant ? "AI Bro" : "你"}</small>${assistant ? '<div data-conversation-activity></div><div data-conversation-results></div>' : ''}<div class="markdown message-body"></div><div class="message-footer">${messageFooter(m)}</div></article>`;
}
function messageForAction(button) {
  const row = button.closest("[data-message][data-conversation]");
  const identity = { conversationID: row?.dataset.conversation, messageID: row?.dataset.message, key: row?.dataset.messageKey || undefined };
  if (tab !== "chat" || identity.conversationID !== currentConversation) throw Error("对话已切换，请在原消息中重试");
  const message = conversationMessage(store, identity);
  if (!message) throw Error("消息已变化或删除，请重新打开对话");
  return message;
}
function openResultTarget(target) {
  const current = inspectResultTarget(store, target);
  if (current.state !== "available") throw Error(current.detail);
  if (target.kind === "projects") return projectDetail(current.data);
  if (target.kind === "tasks") return taskEditor(current.data);
  if (target.kind === "agenda") return editEvent(current.data);
  if (target.kind === "imports") return openImport(target.id);
  return current.data.kind === "随记" ? editCapture(current.data) : openNote(current.data);
}
function openRecoveryReview(key) {
  pendingRestore = reviewRestore(store, key);
  openSheet("恢复内容", `<h3>${esc(pendingRestore.title)}</h3>${pendingRestore.warnings.map(w => `<p>${esc(w)}</p>`).join("")}${button("确认恢复", "confirm-restore", "", "primary")}`);
}
function mountMessageResults() {
  const mounted = mountMessageResults.roots ||= new WeakMap();
  for (const root of app.querySelectorAll("[data-conversation-results]")) {
    const message = messageForAction(root), model = conversationResults(store, message);
    if (!model) continue;
    const signature = JSON.stringify(model), previous = mounted.get(root);
    if (previous?.pending || previous?.signature === signature) continue;
    if (previous?.handle) previous.handle.unmount();
    else if (previous) root.replaceChildren();
    const entry = { signature, pending: true };
    mounted.set(root, entry);
    mountConversationResults(root, { model, onOpen: key => {
      // Only the action bound to this rendered card may be opened. Stable keys
      // include message, plan, entity and recovery identity, not array positions.
      if (!root.isConnected || !model.items.some(item => item.key === key))
        throw Error("这条结果已变化，请重新打开对话");
      const latest = conversationResults(store, messageForAction(root));
      const item = latest?.items.find(item => item.key === key);
      if (item?.target) return openResultTarget(item.target);
      if (item?.recoveryKey) return openRecoveryReview(item.recoveryKey);
      throw Error(item?.detail || "这条结果已变化，请重新打开对话");
    } }).then(handle => {
      entry.pending = false;
      if (!root.isConnected) { mounted.delete(root); return handle.unmount(); }
      const owned = { unmount() {
        if (mounted.get(root) === entry) mounted.delete(root);
        resultIslands = resultIslands.filter(island => island !== owned);
        handle.unmount();
      } };
      entry.handle = owned;
      resultIslands.push(owned);
      // A message may have changed while the shared component loaded.
      mountMessageResults();
    }).catch(e => {
      entry.pending = false;
      if (root.isConnected) root.textContent = `${model.title}。${model.detail} ${e.message}`;
      else mounted.delete(root);
    });
  }
}
function liveHTML() {
  return '<small>AI Bro</small><div data-conversation-activity></div><div class="live-result-root"></div><div class="markdown message-body live-text"></div><div class="message-footer"></div>';
}
function chat() {
  if (!currentConversation)
    return `<p class="lead">问资料、整理想法，或安排下一步。</p>${button("＋ 新对话", "new-chat", "", "primary wide")}<section class="stack">${active(store.list("conversations")).sort((a, b) => b.updatedAt - a.updatedAt).map(c => `<button class="item" data-action="conversation" data-id="${c.id}"><span class="item-icon">✦</span><span><strong>${esc(c.title)}</strong><small>${esc(store.get("projects", c.projectId)?.name || "独立对话")}${sessions.get(c.id) ? " · 正在回复" : ""}</small></span><span>›</span></button>`).join("")}</section>`;
  const c = store.get("conversations", currentConversation), run = sessions.get(currentConversation);
  const messages = store.list("messages").filter(m => m.conversationId === currentConversation && (!run || run.messageIDs.has(m.id) || m.role === "user")).sort((a, b) => a.position - b.position);
  const model = modelConnectionView().label;
  return `<div class="conversation-bar">${button("‹", "all-chats", 'aria-label="全部对话"', "quiet")}<strong>${esc(c?.title || "新对话")}</strong>${button("改名", "rename-chat", "", "quiet")}</div><div id="document-origin-root"></div><div class="messages">${messages.map(messageHTML).join("") || (run ? "" : '<div class="empty">引用一份课件、论文或笔记，开始讨论。<small>也可以直接描述要查找的内容。</small></div>')}${run ? `<article id="live-response" class="message assistant" aria-label="正在生成的回复">${liveHTML(run)}</article>` : ""}</div>${run ? button("↓ 最新回复", "latest-response", `aria-label="回到最新回复" ${run.follow ? "hidden" : ""}`, "latest-response") : ""}<form id="chat-form" class="composer"><div id="conversation-context-status-root"></div><textarea id="chat-text" aria-label="消息" placeholder="发消息，或先引用资料…" required rows="2"></textarea><div class="composer-meta"><small class="context-count" title="${esc(conversationContextStatus(store, c).label)}">${esc(conversationContextStatus(store, c).label)}</small>${button(esc(model), "model-settings", `aria-label="模型设置：${esc(model)}" title="${esc(model)}"`, "model-chip")}</div><small data-model-connection-hint class="model-connection-hint" hidden></small><div class="composer-bottom">${button(icon("plus"), "pick-context", 'aria-label="引用资料"', "quiet")}${button(icon("microphone"), "voice-current", 'aria-label="在当前对话语音输入"', "quiet voice-small")}${run ? button("■", "stop-response", 'aria-label="停止回复"', "round stop") : `<button class="round" type="submit" aria-label="发送">${icon('send')}</button>`}</div></form>`;
}
let paintFrame;
const messageReaders = new Map();
function disposeMessageReaders() {
  for (const reader of messageReaders.values()) { reader.activity?.dispose(); reader.body.dispose(); }
  messageReaders.clear();
}
function pauseReading() {
  const run = tab === 'chat' && sessions.get(currentConversation);
  if (run) { run.follow = false; updateFollowButton(run); }
}
function updateFollowButton(run) {
  const latest = document.querySelector('.latest-response');
  if (latest) latest.hidden = !!run?.follow;
}
let followingScroll = false;
function followLatest(run) {
  if (!run?.follow || tab !== 'chat' || currentConversation !== run.conversationID) return;
  followingScroll = true;
  window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
  requestAnimationFrame(() => { previousScroll = window.scrollY; followingScroll = false; });
}
function updateMessageReader(node, model, live = false) {
  let reader = messageReaders.get(node);
  if (!reader) {
    const layout = () => { const run = sessions.get(currentConversation); if (run?.follow) scheduleRunPaint(run); };
    reader = { body: stableContent(node.querySelector('.message-body'), (element, value) => { element.innerHTML = md(value); }, layout) };
    const activity = node.querySelector('[data-conversation-activity]');
    if (activity) reader.activity = mountConversationActivity(activity, { markdown: md, onRead: pauseReading, onLayout: layout });
    messageReaders.set(node, reader);
  }
  reader.body.update(live ? model.text : model.content || model.text || '');
  reader.activity?.update({ reasoning: model.reasoning || '', events: live ? model.events : model.toolEvents || [],
    status: live ? (model.controller.signal.aborted ? 'cancelled' : 'running') : model.status === 'running' ? 'interrupted' : model.status || 'completed', phase: model.phase });
  if (!live) {
    node.dataset.message = model.id; node.dataset.conversation = model.conversationId; node.dataset.messageKey = model._key || '';
    const footer = node.querySelector('.message-footer'), html = messageFooter(model);
    if (reader.footer !== html) { footer.innerHTML = html; reader.footer = html; }
  }
}
function reconcileConversation() {
  const container = document.querySelector('main[data-route="chat"] .messages');
  if (!container || !store.get('conversations', currentConversation)) return false;
  const run = sessions.get(currentConversation);
  const messages = store.list('messages').filter(m => m.conversationId === currentConversation && (!run || run.messageIDs.has(m.id) || m.role === 'user')).sort((a, b) => a.position - b.position);
  const ids = new Set(messages.map(m => m.id));
  for (const node of container.querySelectorAll('[data-message]')) if (!ids.has(node.dataset.message)) {
    const reader = messageReaders.get(node); reader?.activity?.dispose(); reader?.body.dispose(); messageReaders.delete(node); node.remove();
  }
  if (run || messages.length) container.querySelector('.empty')?.remove();
  let cursor = container.firstElementChild;
  for (const message of messages) {
    let node = [...container.querySelectorAll('[data-message]')].find(node => node.dataset.message === message.id);
    if (!node) { const template = document.createElement('template'); template.innerHTML = messageHTML(message); node = template.content.firstElementChild; }
    if (node !== cursor) container.insertBefore(node, cursor);
    updateMessageReader(node, message); cursor = node.nextElementSibling;
  }
  if (run) {
    let live = container.querySelector('#live-response');
    if (!live) { live = document.createElement('article'); live.id = 'live-response'; live.className = 'message assistant'; live.setAttribute('aria-label', '正在生成的回复'); live.innerHTML = liveHTML(); container.append(live); }
    updateMessageReader(live, run, true);
  }
  const stop = document.querySelector('#chat-form [data-action="stop-response"]'), send = document.querySelector('#chat-form button[type="submit"]');
  if (run && send) send.outerHTML = button('■', 'stop-response', 'aria-label="停止回复"', 'round stop');
  else if (!run && stop) stop.outerHTML = `<button class="round" type="submit" aria-label="发送">${icon('send')}</button>`;
  const latest = document.querySelector('.latest-response');
  if (run && !latest) document.querySelector('#chat-form').insertAdjacentHTML('beforebegin', button('↓ 最新回复', 'latest-response', 'aria-label="回到最新回复"', 'latest-response'));
  else if (!run) latest?.remove();
  updateFollowButton(run);
  const title = document.querySelector('.conversation-bar strong');
  if (title) title.textContent = store.get('conversations', currentConversation)?.title || '新对话';
  mountMessageResults();
  return true;
}
function finishRunPaint(run) {
  if (tab !== 'chat' || currentConversation !== run.conversationID) return;
  const live = document.querySelector('#live-response');
  if (!live) return;
  const message = store.list('messages').find(m => m.conversationId === run.conversationID && m.id === run.savedMessageID);
  if (!message) {
    const reader = messageReaders.get(live); reader?.activity?.dispose(); reader?.body.dispose(); messageReaders.delete(live); live.remove(); return;
  }
  live.removeAttribute('id'); live.removeAttribute('aria-label');
  live.querySelector('.live-text')?.classList.remove('live-text');
  live.querySelector('.live-result-root')?.setAttribute('data-conversation-results', '');
  updateMessageReader(live, message);
}
function scheduleRunPaint(run) {
  if (paintFrame || tab !== "chat" || currentConversation !== run.conversationID) return;
  paintFrame = requestAnimationFrame(() => {
    paintFrame = null;
    if (tab !== "chat" || currentConversation !== run.conversationID || sessions.get(run.conversationID) !== run) return;
    const node = document.querySelector("#live-response");
    if (!node) return;
    // Add the durably saved user message without replacing the composer.
    for (const m of store.list("messages").filter(m => m.conversationId === run.conversationID && m.role === "user" && !run.messageIDs.has(m.id))) {
      if (![...document.querySelectorAll("[data-message]")].some(el => el.dataset.message === m.id)) node.insertAdjacentHTML("beforebegin", messageHTML(m));
    }
    for (const m of store.list('messages').filter(m => m.conversationId === run.conversationID && m.role === 'user')) {
      const row = [...node.parentElement.querySelectorAll('[data-message]')].find(row => row.dataset.message === m.id);
      if (row) updateMessageReader(row, m);
    }
    updateMessageReader(node, run, true);
    followLatest(run); updateFollowButton(run);
  });
}
let previousScroll = window.scrollY;
window.addEventListener("scroll", () => {
  const run = tab === "chat" && sessions.get(currentConversation), y = window.scrollY;
  if (run && !followingScroll) {
    if (y < previousScroll - 1) run.follow = false;
    const latest = document.querySelector(".latest-response");
    if (latest) latest.hidden = run.follow;
  }
  previousScroll = y;
}, { passive: true });
window.addEventListener("wheel", (e) => { if (e.deltaY < 0) { const run = sessions.get(currentConversation); if (run) run.follow = false; } }, { passive: true });
for (const type of ['touchstart', 'pointerdown']) document.addEventListener(type, event => {
  if (event.target.closest?.('.message-body,[data-conversation-activity]')) pauseReading();
}, { passive: true });
document.addEventListener('scroll', event => {
  if (event.target?.matches?.('.tool-trace pre,.reasoning .markdown') && !isActivityLayoutScroll(event.target)) pauseReading();
}, { capture: true, passive: true });
document.addEventListener('selectionchange', () => {
  const selection = document.getSelection();
  if (!selection?.isCollapsed && selection?.anchorNode?.parentElement?.closest('.message')) pauseReading();
});

function settings() {
  const c = store.state.settings.model || {};
  return `<div id="connection-navigation-root"></div><div id="connection-sync-root"></div><section class="settings-card"><h2>此手机的模型</h2><p class="hint">单独配置此手机。保存后，对话将使用这里的服务；Mac 同步配置仍会保留。</p><div id="api-chat-profiles"></div><form id="model-form"><p class="hint" data-api-profile-loading role="status">正在载入模型方案…</p><fieldset class="api-profile-fields" data-api-profile-fields disabled><input name="profileId" type="hidden">${field("profileName", "方案名称", "text", "新模型方案")}${field("base", "API 地址（以 /v1 结尾）", "url", c.base || "")}${field("model", "模型名称", "text", c.model || "")}${field("key", "API Key（留空保留此方案同地址的 Key）", "password")}<label>接口格式<select name="format"><option value="chat">Chat Completions 兼容接口</option><option value="responses" ${c.format === "responses" ? "selected" : ""}>Responses 兼容接口</option></select></label><button class="primary" type="submit">保存并使用模型方案</button></fieldset></form><p class="hint">Chat Completions 与 Responses 均可调用工作区工具，具体可用性取决于服务和模型。修改内容前会先提供方案供你确认。引用内容会发送到你配置的模型服务，学校账号不会进入模型上下文。</p></section>${speechSettings()}<section class="settings-card"><h2>云账号与资料同步</h2><p>${esc(sync.status)}</p><details class="connection-help"><summary>连接说明</summary><p class="hint">与 Mac「设置 → 账号与云同步」使用同一服务和账号。Tailscale 地址需先连接同一网络。云账号密码不是 SSH 或学校密码。云同步为可选，课程助手可单独使用。</p></details><details class="connection-account" ${store.state.binding ? "" : "open"}><summary>${store.state.binding ? "更换或重新连接账号" : "连接云账号"}</summary><form id="sync-form">${field("server", "自托管同步服务", "url", store.state.binding?.base || import.meta.env.VITE_SYNC_URL || "")}${field("username", "云同步用户名", "text", store.state.binding?.username || "")}${field("password", "云同步账号密码", "password")}<label class="check"><input name="merge" type="checkbox" required>合并当前设备与此账号的资料</label><button class="primary" type="submit">连接并同步</button></form></details><div class="actions">${button("立即同步", "sync")}${button("断开连接", "disconnect", "", "quiet")}${button(`处理冲突 · ${countConflicts()}`, "conflicts", "", "quiet")}</div></section><section class="settings-card"><h2>日程提醒</h2><p>${store.state.settings.notifications ? "已启用" : "尚未启用"} · ${native ? "设备本地通知" : "网页打开期间提醒；关闭后请使用手机 App 提醒"}</p>${button("开启提醒", "notifications")}<form id="task-reminder-settings"><label>普通任务临期提醒<select name="minutes">${[["off","关闭"],["0","截止时"],["15","提前 15 分钟"],["60","提前 1 小时"],["1440","提前 1 天"]].map(([v,t])=>`<option value="${v}" ${v===String(store.state.settings.taskReminderMinutes===null?"off":store.state.settings.taskReminderMinutes ?? 60)?"selected":""}>${t}</option>`).join("")}</select></label><button type="submit">保存提醒设置</button></form>${button("关闭提醒", "notifications-off", "", "quiet")}</section><section class="settings-card"><h2>课程连接</h2>${button("国科大 · 轻新课堂 ›", "ucas", "", "wide")}</section><section class="settings-card"><h2>数据与恢复</h2>${button("导出工作区备份", "backup")}${button("导入工作区备份", "restore", "", "quiet")}${button("归档与回收站", "recovery", "", "quiet")}<p class="hint">离线内容保存在此设备。普通备份包含内容与附件原件，不包含密码、登录会话与连接设置。有待同步整组操作时，会保存恢复检查点：保留原账号身份与待处理队列，不包含密码或令牌。</p></section><p class="footnote">AI Bro ${platformName === "android" ? "Android" : native ? "iOS" : "Web"} · ${esc(appVersion)}<br>知识与行动，在一起。</p>`;
}
function projectEditorOptions(record, value) {
  const items = recordProjectOptions(record, store.list("projects"));
  if (value && !items.some(item => item.value === value)) items.push({ value, label: "原项目（暂不可用）" });
  return items.map(item => `<option value="${esc(item.value)}" ${item.value === value ? "selected" : ""}>${esc(item.label)}</option>`).join("");
}
function beginEditor(kind, note) {
  const current = note?.id ? store.get("notes", note.id) : null;
  const key = (kind === "capture" ? "capture:" : "editor:") + (note?.id || "new");
  const values = kind === "capture" ? { content: current?.content || "", tags: (current?.tags || []).join(", "), projectId: recordProjectSelection(current, store.list("projects")) || null }
    : { title: current?.title || "", content: current?.content || "" };
  editorSession = { originConversationID: tab === "chat" ? currentConversation : null, selection: null, composing: false, kind, key, recordID: note?.id || null, draft: structuredClone(store.state.drafts[key] ?? createEditorDraft(kind, current, values)), latest: false };
  return editorSession;
}
function editorInspection(ctx) { return inspectEditorDraft(ctx.kind, ctx.draft, ctx.recordID ? store.get("notes", ctx.recordID) : null); }
function editorValues(form, kind) {
  return kind === "capture" ? { content: form.elements.content.value, tags: form.elements.tags.value, projectId: form.elements.project.value || null }
    : { title: form.elements.title.value, content: form.elements.content.value };
}
function retainEditorInput(form) {
  const ctx = editorForms.get(form), inspected = ctx && inspectEditorDraft(ctx.kind, ctx.draft, null);
  if (!ctx || !Object.hasOwn(inspected, "base")) return;
  ctx.draft = createEditorDraft(ctx.kind, inspected.base, editorValues(form, ctx.kind));
  const draft = structuredClone(ctx.draft);
  return store.tx(state => state.drafts[ctx.key] = draft);
}
function bindEditor(ctx) {
  const form = sheet.querySelector(ctx.kind === "capture" ? "#capture-form" : "#note-form");
  const inspected = editorInspection(ctx);
  if (form) {
    editorForms.set(form, ctx);
    if (!inspected.canSave) form.querySelectorAll("input,select,textarea,button").forEach(control => control.disabled = true);
  }
  const root = sheet.querySelector("#editor-recovery-root");
  if (!root || inspected.canSave) return;
  mountEditorRecovery(root, { state: inspected.state, kind: ctx.kind, busy: editorSaving,
    onLatest: () => { ctx.latest = true; showEditor(ctx); },
    onSaveCopy: () => saveEditorCopy(ctx),
  }).then(handle => { if (root.isConnected && sheet.open) editorRecoveryUI = handle; else handle?.unmount(); }).catch(failure => { if (root.isConnected && sheet.open) error(failure); });
}
function showEditor(ctx) {
  if (ctx !== editorSession) return;
  if (ctx.kind === "capture") showCapture(ctx); else showNote(store.get("notes", ctx.recordID) || { id: ctx.recordID, title: "原资料已移除" });
}
async function editorSave(work) {
  if (editorSaving) return;
  editorSaving = true; editorRecoveryUI?.update({ busy: true });
  if (editorSession?.kind === "note") updateDocumentUI(editorSession);
  const controls = [...sheet.querySelectorAll("input,textarea,select,button")];
  const disabled = controls.map(control => control.disabled);
  controls.forEach(control => control.disabled = true);
  try { return await work(); }
  finally { editorSaving = false; controls.forEach((control, index) => control.disabled = disabled[index]); editorRecoveryUI?.update({ busy: false }); if (editorSession?.kind === "note") updateDocumentUI(editorSession); }
}
async function saveEditorCopy(ctx) {
  return editorSave(async () => {
    const copy = editorDraftCopy(ctx.kind, ctx.draft, ctx.recordID ? store.get("notes", ctx.recordID) : null,
      { id: id(), projects: store.list("projects") });
    await store.tx(state => { putRecord(state, "notes", copy); if (equal(state.drafts[ctx.key], ctx.draft)) delete state.drafts[ctx.key]; });
    if (editorSession === ctx && sheet.open) openNote(copy);
    notify("草稿已另存，原资料保持不变"); render();
  });
}
function editCapture(note) {
  activeNote = note?.id || null;
  noteOriginal = note || null;
  showCapture(beginEditor("capture", note));
}
function showCapture(ctx) {
  const inspected = editorInspection(ctx), note = inspected.current;
  const values = inspected.values || { content: "", tags: "", projectId: null };
  openSheet(note ? "编辑随记" : "记个想法",
    `${inspected.canSave ? "" : '<div id="editor-recovery-root"></div>'}${ctx.latest ? `<article class="markdown reader">${note ? md(note.content) : "原资料已被移除，草稿仍保留。"}</article>` : `<form id="capture-form"><textarea name="content" class="large" placeholder="此刻想到什么？也可以粘贴链接…">${esc(values.content)}</textarea>${field("tags", "标签，用逗号分开", "text", values.tags)}<label>关联项目<select name="project">${projectEditorOptions(inspected.base || note, values.projectId || "")}</select></label><label class="file-picker">＋ 图片 / 文件<input name="files" type="file" multiple></label><label class="file-picker">拍照记录<input name="camera" type="file" accept="image/*" capture="environment"></label><button class="primary wide" type="submit">保存随记</button></form>`}<div class="attachment-list">${(note?.sourceAttachmentIds || []).map(i => button("▤ " + esc(store.get("imports", i)?.name || "附件"), "file", `data-id="${esc(i)}"`, "reference")).join("")}</div>`, ctx.recordID ? { kind: "captures", id: ctx.recordID } : null);
  bindEditor(ctx);
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
      entry.parser = native ? platformName + "-device" : "browser-pdf";
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
async function persistEditorForm(f) {
      const ctx = editorForms.get(f);
      if (!ctx) throw Error("编辑会话已变化，请重新打开资料");
      await retainEditorInput(f);
      return editorSave(async () => {
        const { base: old, values } = getEditorDraftWrite(ctx.kind, ctx.draft, ctx.recordID ? store.get("notes", ctx.recordID) : null);
        const submittedDraft = structuredClone(ctx.draft), now = Date.now();
        let record;
        if (ctx.kind === "capture") {
          const selected = [...f.elements.files.files, ...f.elements.camera.files];
          if (!values.content.trim() && !selected.length) throw Error("写一点内容或添加附件");
          const attachments = [...(old?.sourceAttachmentIds || [])];
          for (const file of selected) attachments.push(await attach(file));
          record = { ...old, id: ctx.recordID || id(), kind: "随记", userEdited: true, userEditedAt: now,
            ...editedProject(old, values.projectId, store.list("projects")),
            title: values.content.trim().split("\n")[0].slice(0,70) || "附件随记", content: values.content,
            tags: values.tags.split(/[,，]/).map(x=>x.trim()).filter(Boolean), sourceAttachmentIds: attachments,
            createdAt: old?.createdAt || now, updatedAt: now };
        } else record = { ...old, title: values.title, content: values.content, updatedAt: now, userEdited: true,
          revisionHistory: [...(old.revisionHistory || []), { title: old.title, content: old.content, at: now, reason: "手机编辑" }] };
        await store.tx(state => {
          const current = ctx.recordID ? state.records["notes:" + ctx.recordID] : null;
          getEditorDraftWrite(ctx.kind, submittedDraft, current && !current.deleted ? current.data : null);
          putRecord(state, "notes", record, old || undefined);
          if (equal(state.drafts[ctx.key], submittedDraft)) delete state.drafts[ctx.key];
        });
        if (editorSession === ctx && f.isConnected && sheet.open) {
          if (ctx.kind === "capture") sheet.close();
          else { ctx.draft = createEditorDraft("note", record, { title: record.title, content: record.content }); noteOriginal = record; updateDocumentUI(ctx); }
        }
        notify("已保存到此设备"); render();
        return record;
      });
}
function openNote(n) {
  beginEditor("note", n);
  activeNote = n.id;
  noteOriginal = n;
  sourceMode = false;
  showNote(n);
}
function documentDirty(ctx) {
  const view = editorInspection(ctx);
  return !!view.values && (view.values.title !== view.base?.title || view.values.content !== view.base?.content);
}
function documentIsCurrent(ctx) { return editorSession === ctx && sheet.open && sheet.classList.contains("document-sheet"); }
function updateDocumentUI(ctx) {
  if (!documentIsCurrent(ctx)) return;
  const view = editorInspection(ctx), dirty = documentDirty(ctx), editing = sourceMode && !ctx.latest;
  sheet.style.setProperty("--document-viewport", Math.max(180, (window.visualViewport?.height || innerHeight) - 12) + "px");
  const busy = editorSaving || ctx.composing;
  documentToolbarUI?.update({ mode: editing ? "edit" : "read", busy, disabled: !view.canSave, hasUnsavedDraft: dirty, hasAIDraft: !!view.current?.aiDraft });
  documentSaveUI?.update({ busy, disabled: !view.canSave || !dirty,
    status: !view.canSave ? "草稿保留在本机" : dirty ? "本机草稿 · 尚未保存到资料" : "已保存到资料" });
  sheet.querySelector("#document-save-root").hidden = !editing;
  sheet.querySelector("#note-form").hidden = !editing;
  if (editing) { const area=sheet.querySelector('#note-form [name="content"]'); area.style.height="0px"; area.style.height=Math.max(240,area.scrollHeight)+"px"; }
  sheet.querySelector("#document-reader").hidden = editing;
  const values = ctx.latest ? view.current : view.values;
  if (!editing) sheet.querySelector("#document-reader").innerHTML = values ? md(values.content) : '<p class="hint">原资料已被移除，草稿仍保留。</p>';
  sheet.querySelector(".sheet-head h2").textContent = values?.title || "未命名资料";
}
async function documentMode(ctx, mode) {
  if (!documentIsCurrent(ctx) || editorSaving) return;
  if (ctx.composing) { ctx.pendingMode = mode; return; }
  await store.tail;
  if (!documentIsCurrent(ctx)) return;
  sourceMode = mode === "edit";
  if (sourceMode) ctx.latest = false;
  updateDocumentUI(ctx);
}
window.visualViewport?.addEventListener("resize", () => { if (editorSession?.kind === "note") updateDocumentUI(editorSession); });
function rememberDocumentSelection(textarea) {
  const ctx = editorForms.get(textarea.form);
  if (ctx) ctx.selection = { selectionStart: textarea.selectionStart, selectionEnd: textarea.selectionEnd, selectionDirection: textarea.selectionDirection };
}
function formatDocument(ctx, command) {
  if (!documentIsCurrent(ctx) || editorSaving || ctx.composing || !editorInspection(ctx).canSave) return;
  const textarea = sheet.querySelector('#note-form [name="content"]');
  if (!textarea || textarea.disabled) return;
  const range = ctx.selection || { selectionStart: textarea.selectionStart, selectionEnd: textarea.selectionEnd, selectionDirection: textarea.selectionDirection };
  textarea.focus({ preventScroll: true }); textarea.setSelectionRange(range.selectionStart, range.selectionEnd, range.selectionDirection);
  if (command === "undo" || command === "redo") {
    document.execCommand(command); rememberDocumentSelection(textarea); retainEditorInput(textarea.form)?.then(()=>updateDocumentUI(ctx)).catch(error); return;
  }
  const result = applyMarkdownEdit({ text: textarea.value, ...range }, command);
  if (!result.changed) return;
  const old = textarea.value;
  let start = 0, end = old.length, nextEnd = result.text.length;
  while (start < end && start < nextEnd && old[start] === result.text[start]) start++;
  while (end > start && nextEnd > start && old[end - 1] === result.text[nextEnd - 1]) { end--; nextEnd--; }
  textarea.setSelectionRange(start, end);
  document.execCommand("insertText", false, result.text.slice(start, nextEnd));
  if (textarea.value !== result.text) { textarea.setSelectionRange(range.selectionStart, range.selectionEnd, range.selectionDirection); throw Error("当前输入方式无法应用格式，文字保持不变"); }
  textarea.setSelectionRange(result.selectionStart, result.selectionEnd, result.selectionDirection);
  rememberDocumentSelection(textarea);
  retainEditorInput(textarea.form)?.then(()=>updateDocumentUI(ctx)).catch(error);
}
async function saveDocument(ctx) {
  if (!documentIsCurrent(ctx) || ctx.composing) return;
  try { return await persistEditorForm(sheet.querySelector("#note-form")); }
  catch (failure) { if (documentIsCurrent(ctx) && !editorInspection(ctx).canSave) showEditor(ctx); throw failure; }
}
async function documentAction(ctx, action) {
  if (!documentIsCurrent(ctx) || editorSaving || ctx.composing) return;
  const noteID = ctx.recordID;
  if (["discuss", "rewrite-note"].includes(action)) {
    if (!editorInspection(ctx).canSave) throw Error("原文已变化，请先处理草稿");
    if (documentDirty(ctx)) await saveDocument(ctx);
    if (!documentIsCurrent(ctx)) return;
  }
  if (action === "from-note" && documentDirty(ctx)) throw Error("请先保存修改，再安排日程");
  if (action === "export-note") {
    const view = editorInspection(ctx), values = ctx.latest ? view.current : view.values;
    if (!values) throw Error("资料暂不可用");
    return exportFile((values.title || "笔记") + ".md", new TextEncoder().encode(values.content), "text/markdown");
  }
  return actions[action]({ dataset: { id: noteID } });
}
function showNote(n) {
  const ctx = editorSession?.kind === "note" && editorSession.recordID === n.id ? editorSession : beginEditor("note", n);
  const inspected = editorInspection(ctx), values = inspected.values || {title:n.title||"",content:n.content||""};
  openSheet((ctx.latest ? inspected.current?.title : values.title) || "资料",
    `<div id="document-toolbar-root"></div><div class="document-body">${inspected.canSave ? "" : '<div id="editor-recovery-root"></div>'}
      <form id="note-form" class="document-editor"><label class="document-title">标题<input name="title" aria-label="文档标题" value="${esc(values.title)}" placeholder="未命名资料"></label>
      <textarea name="content" class="document-source source" aria-label="Markdown 正文" spellcheck="false" placeholder="开始写下内容…">${esc(values.content)}</textarea></form>
      <article id="document-reader" class="markdown reader"></article>
      <div class="attachment-list">${(n.sourceAttachmentIds || []).map(i=> { const file=store.get("imports",i);return file ? button("▤ "+esc(file.title||file.name),"file",`data-id="${esc(i)}"`,"reference") : ""; }).join("")}</div>
    </div><div id="document-save-root"></div>`, { kind: "notes", id: n.id });
  sheet.classList.add("document-sheet");
  bindEditor(ctx);
  const toolbar = sheet.querySelector("#document-toolbar-root"), footer=sheet.querySelector("#document-save-root");
  mountDocumentToolbar(toolbar, { mode: sourceMode && !ctx.latest ? "edit" : "read", busy: editorSaving, disabled: !inspected.canSave,
    hasUnsavedDraft: documentDirty(ctx), hasAIDraft: !!inspected.current?.aiDraft,
    onMode: mode=>documentMode(ctx,mode), onFormat: command=>formatDocument(ctx,command),
    onDiscuss: ()=>documentAction(ctx,"discuss"), onRewrite: ()=>documentAction(ctx,"rewrite-note"), onReviewDraft: ()=>documentAction(ctx,"review-draft"),
    onSchedule: ()=>documentAction(ctx,"from-note"), onExport: ()=>documentAction(ctx,"export-note"), onTrash: ()=>documentAction(ctx,"archive-note"),
  }).then(handle=>{ if(documentIsCurrent(ctx)&&toolbar.isConnected) { documentToolbarUI=handle; updateDocumentUI(ctx); } else handle?.unmount(); }).catch(failure=>{if(toolbar.isConnected)error(failure)});
  mountDocumentSaveBar(footer, {busy:editorSaving, disabled:!inspected.canSave || !documentDirty(ctx), status:"", onSave:()=>saveDocument(ctx)})
    .then(handle=>{if(documentIsCurrent(ctx)&&footer.isConnected){documentSaveUI=handle;updateDocumentUI(ctx)}else handle?.unmount()}).catch(failure=>{if(footer.isConnected)error(failure)});
  updateDocumentUI(ctx);
}
function mountDocumentSource() {
  const root = document.querySelector("#document-origin-root"), conversation = store.get("conversations",currentConversation);
  if (!root || !conversation?.mobileContext?.source) return;
  const view = restoreConversationContext(store,conversation), source=view.source;
  mountDocumentOrigin(root,{ title:source?store.get("notes",source.id)?.title:"资料不可用", unavailable:!source, hasParentConversation:!!source?.conversationId,
    onSource:()=>{const fresh=restoreConversationContext(store,store.get("conversations",conversation.id));if(!fresh.source)throw Error("来源资料已不可用");openResultTarget({kind:"notes",id:fresh.source.id});},
    onParent:()=>{const fresh=restoreConversationContext(store,store.get("conversations",conversation.id));if(!fresh.source?.conversationId)throw Error("原对话已不可用");openConversation(fresh.source.conversationId);},
  }).then(handle=>{if(root.isConnected)documentOriginUI=handle;else handle?.unmount()}).catch(failure=>{if(root.isConnected)error(failure)});
}

const formDraftSessions = new WeakMap();
function formDraftValues(form, kind) {
  const names = kind === "task" ? ["title","description","status","priority","due","start","reminder","project"]
    : ["title","start","end","location","reminder","project","details","frequency","repeatInterval","repeatCount","repeatUntil"];
  const values = Object.fromEntries(names.map(name => [name, form.elements[name]?.value || ""]));
  if (kind === "task") values.checklist = [...form.querySelectorAll(".task-checklist-row")].map(row => ({
    index: /^\d+$/.test(row.dataset.checklistIndex) ? Number(row.dataset.checklistIndex) : null,
    text: row.querySelector('input[type="text"]').value, done: row.querySelector('input[type="checkbox"]').checked,
  }));
  else Object.assign(values, { repeatDays: [...form.querySelectorAll('[name="repeatDay"]:checked')].map(input => input.value), weekdaysEdited: form.dataset.weekdaysEdited === "true" });
  return values;
}
function formDraftCurrent(ctx, state = store.state) {
  const record = ctx.recordID && state.records[(ctx.kind === "task" ? "tasks:" : "notes:") + ctx.recordID];
  return record && !record.deleted ? record.data : null;
}
function applyFormDraftValues(form, kind, values) {
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "string" || !form.elements[name]) continue;
    const control = form.elements[name];
    if (control.tagName === "SELECT" && ![...control.options].some(option => option.value === value)) control.add(new Option(value ? "原选项（暂不可用）" : "未选择", value));
    control.value = value;
  }
  if (kind === "task") form.querySelector("#task-checklist").innerHTML = values.checklist.map(checklistRow).join("");
  else {
    form.dataset.weekdaysEdited = String(values.weekdaysEdited);
    for (const input of form.querySelectorAll('[name="repeatDay"]')) input.checked = values.repeatDays.includes(input.value);
    const frequency = values.frequency;
    if (form.querySelector('.repeat-fields')) form.querySelector('.repeat-fields').hidden = frequency === "none";
    if (form.querySelector('.repeat-weekdays')) form.querySelector('.repeat-weekdays').hidden = frequency !== "weekly";
  }
}
function updateFormDraftUI(ctx) {
  if (!ctx.form.isConnected) return;
  const view = inspectFormDraft(ctx.kind, ctx.draft, formDraftCurrent(ctx));
  for (const control of ctx.form.querySelectorAll("input,textarea,select,button")) control.disabled = ctx.busy || !view.canSave || ctx.viewingLatest;
  for (const control of sheet.querySelectorAll('.task-manage button,[data-action="delete-event"]')) control.disabled = ctx.busy || !view.canSave;
  ctx.ui?.update({ state: view.state, retained: ctx.retained, busy: ctx.busy, viewingLatest: ctx.viewingLatest });
  ctx.form.hidden = ctx.viewingLatest;
  const latest = ctx.form.parentElement.querySelector(".form-latest");
  if (latest) {
    latest.hidden = !ctx.viewingLatest;
    if (ctx.viewingLatest) {
      const record = view.current, event = ctx.kind === "event" && record && readEvent(record);
      latest.innerHTML = record && !record.archived && !record.deletedAt
        ? `<h3>${esc(record.title)}</h3><dl><dt>${event ? "时间" : "说明"}</dt><dd>${esc(event ? new Date(event.start).toLocaleString("zh-CN", { timeZone: event.timeZone || "UTC" }) + " · " + (event.timeZone || "UTC") : record.description || "未填写")}</dd>${event ? `<dt>备注</dt><dd>${esc(event.details || "未填写")}</dd>` : ""}</dl>`
        : '<p>原内容已移除或归档。未保存的草稿仍留在本机。</p>';
    }
  }
}
function bindFormDraft(kind, form, base, scopeID = null, context = {}) {
  const key = formDraftKey(kind, base?.id || null, { scopeID }), initial = formDraftValues(form, kind);
  const stored = store.state.drafts[key], ctx = { kind, key, form, recordID: base?.id || null, scopeID,
    draft: structuredClone(stored ?? createFormDraft(kind, base || null, initial, context)), initial,
    retained: stored != null, saved: false, busy: false, viewingLatest: false };
  formDraftSessions.set(form, ctx);
  const view = inspectFormDraft(kind, ctx.draft, formDraftCurrent(ctx));
  if (view.values) applyFormDraftValues(form, kind, view.values);
  if (kind === "event" && view.context) {
    form.dataset.source = view.context.sourceID || "";
    const label = form.querySelector(".form-timezone"); if (label) label.textContent = "时区：" + view.context.timeZone;
  }
  const root = document.createElement("div"), latest = document.createElement("article");
  root.className = "form-draft-root"; latest.className = "form-latest"; latest.hidden = true;
  form.before(root, latest);
  const invoke = fn => () => Promise.resolve().then(fn).catch(error);
  mountFormDraft(root, { state: view.state, retained: ctx.retained, busy: false, viewingLatest: false,
    onLatest: invoke(() => { ctx.viewingLatest = true; updateFormDraftUI(ctx); }),
    onDraft: invoke(() => { ctx.viewingLatest = false; updateFormDraftUI(ctx); }),
    onDiscard: invoke(async () => {
      if (ctx.busy) return;
      const expected = structuredClone(ctx.draft);
      await store.tx(state => { if (!clearFormDraft(state, key, expected)) throw Error("草稿已变化，请重新打开后再丢弃"); });
      ctx.saved = true;
      if (!form.isConnected || !sheet.open) return;
      const current = formDraftCurrent(ctx);
      if (ctx.recordID && (!current || current.archived || current.deletedAt)) { await closeSheetNavigation(); return; }
      if (kind === "task") taskEditor(current, scopeID); else editEvent(current, context.sourceID || null);
    }),
  }).then(handle => { if (!root.isConnected) { handle?.unmount(); return; } ctx.ui = handle; updateFormDraftUI(ctx); }).catch(error);
  updateFormDraftUI(ctx);
  return ctx;
}
async function retainFormDraftInput(form) {
  const ctx = formDraftSessions.get(form);
  if (!ctx || ctx.saved || ctx.busy || ctx.viewingLatest) return;
  const view = inspectFormDraft(ctx.kind, ctx.draft, null);
  if (!view.values) return;
  const values = formDraftValues(form, ctx.kind);
  if (!ctx.retained && equal(values, ctx.initial)) return;
  ctx.draft = createFormDraft(ctx.kind, view.base, values, view.context);
  const draft = structuredClone(ctx.draft);
  await store.tx(state => { state.drafts[ctx.key] = draft; });
  ctx.retained = true; updateFormDraftUI(ctx);
}
async function retainSheetFormDraft() {
  const form = sheet.querySelector("#task-form,#event-form"), ctx = form && formDraftSessions.get(form);
  if (ctx?.busy) return false;
  if (form) await retainFormDraftInput(form);
  return true;
}
async function saveRecordForm(form, buildRecord) {
  const ctx = formDraftSessions.get(form);
  if (!ctx || ctx.saved || ctx.busy) return;
  await retainFormDraftInput(form);
  const submitted = structuredClone(ctx.draft), revision = navigationRevision;
  ctx.busy = true; updateFormDraftUI(ctx);
  let record;
  try {
    await store.tx(state => {
      const write = getFormDraftWrite(ctx.kind, submitted, formDraftCurrent(ctx, state));
      record = buildRecord(write);
      if (write.base === null && state.records[(ctx.kind === "task" ? "tasks:" : "notes:") + record.id]) throw Error("新记录标识已被使用，草稿仍保留");
      putRecord(state, ctx.kind === "task" ? "tasks" : "notes", record, write.base || undefined);
      clearFormDraft(state, ctx.key, submitted);
    });
    ctx.saved = true; ctx.busy = false;
    if (form.isConnected && sheet.open && revision === navigationRevision) await closeSheetNavigation();
    notify(ctx.kind === "event" ? "日程已保存到本机" : record.status === "done" ? "任务已完成" : "任务已保存到本机");
  } finally { ctx.busy = false; updateFormDraftUI(ctx); }
}
function editEvent(note, sourceID, initialDay) {
  const e = note && readEvent(note);
  activeNote = note?.id || null;
  noteOriginal = note || null;
  const zone = e ? e.timeZone || "UTC" : Intl.DateTimeFormat().resolvedOptions().timeZone;
  const local = t => eventLocalInput(t, zone);
  const initialStart = initialDay && initialDay !== dayKey() ? +new Date(initialDay + "T09:00:00") : Date.now() + 3600000;
  const r = e?.recurrence, frequency = r?.frequency || "none";
  const repeatFields = e?.ics
    ? '<p class="hint">修改应用于整组课表，保留导入的重复规则。可调整每天的时刻；原始首次日期、复杂规则仍在原日历中修改。</p>'
    : `<label>重复<select name="frequency">${[["none","不重复"],["daily","每天"],["weekly","每周"],["monthly","每月"]].map(([value,label])=>`<option value="${value}" ${frequency===value?"selected":""}>${label}</option>`).join("")}</select></label>
      <div class="repeat-fields" ${frequency==="none"?"hidden":""}><label>每隔<input name="repeatInterval" type="number" min="1" max="52" value="${r?.interval||1}" inputmode="numeric"></label>
      <fieldset class="repeat-weekdays" ${frequency!=="weekly"?"hidden":""}><legend>每周</legend>${[[2,"一"],[3,"二"],[4,"三"],[5,"四"],[6,"五"],[7,"六"],[1,"日"]].map(([value,label])=>`<label><input type="checkbox" name="repeatDay" value="${value}" ${(r?.weekdays?.length?r.weekdays:[(new Date(local(e?.start||initialStart).slice(0,10)+"T12:00:00Z").getUTCDay()+1)]).includes(value)?"checked":""}><span>${label}</span></label>`).join("")}</fieldset>
      <div class="repeat-end-fields"><label>重复次数<input name="repeatCount" type="number" min="1" max="10000" placeholder="不限" value="${r?.count||""}" inputmode="numeric"></label><label>截止时间<input name="repeatUntil" type="datetime-local" value="${r?.until?local(r.until):""}"></label></div>
      <p class="hint">次数和截止时间留空表示持续重复。每月按首次日期的日号安排，缺少该日的月份会跳过。</p></div>`;
  openSheet(
    e ? "日程详情" : "安排日程",
    `<form id="event-form" data-new="${!e}" data-start="${e ? local(e.start) : ""}" data-end="${e ? local(e.end) : ""}" data-source="${sourceID || ""}">${isRepeatingEvent(e)?'<p class="repeat-scope">正在编辑整个重复系列，所有日期将一起更新。</p>':""}<p class="hint form-timezone">时区：${esc(zone)}</p>${field("title", "标题", "text", e?.title || store.get("notes", sourceID)?.title || "")}${field("start", "开始", "datetime-local", local(e?.start || initialStart))}${field("end", "结束", "datetime-local", local(e?.end || initialStart + 3600000))}${field("location", "地点", "text", e?.location || "")}<label>提醒<select name="reminder">${[
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
      )}</select></label><label>关联项目<select name="project">${options(store.list("projects"), e?.projectId)}</select></label><label>备注<textarea name="details">${esc(e?.details || "")}</textarea></label>${repeatFields}<button class="primary wide" type="submit">${e ? "保存日程" : "添加日程"}</button></form>${e ? button("删除日程", "delete-event", `data-id="${note.id}"`, "danger") : ""}`,
    note?.id ? { kind: "agenda", id: note.id } : null,
  );
  bindFormDraft("event", sheet.querySelector("#event-form"), note || null, sourceID || null, { timeZone: zone, sourceID: sourceID || null });
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
    <details class="school-login"><summary>连接 / 更换学校账号</summary><form id="ucas-form">${field("username", "SEP 邮箱 / 轻新课堂学号")}${field("password", "对应账号的密码", "password")}<label class="check"><input type="checkbox" name="remember"> 在本机记住凭据，过期时恢复连接</label><button class="primary" type="submit">连接账号</button></form><p class="hint">两类账号共用此入口。默认只保存会话；勾选后可恢复连接。退出账号会清除凭据。${native ? "密码仅存于设备安全存储。" : "网页版可直接连接学校，无需云同步账号。学校请求由网站的课程连接服务转发，不在服务器保存账号密码；凭据仅保留在当前标签页会话中。"}</p></details>
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
    `<p>${esc(f.mimeType || "文件")} · ${Math.round((f.size || 0) / 1024)} KB</p><div class="actions">${button("预览原件", "preview-file")}${button("导出原件", "export-file")}${button("归档资料", "remove-record", `data-key="imports:${f.id}"`, "quiet")}${native || /\.pdf$/i.test(f.name || "") ? button("提取可引用文字", "extract-file", "", "quiet") : ""}</div>${f.warning ? `<p class="hint">${esc(f.warning)}</p>` : ""}${f.content ? `<article class="markdown reader">${md(f.content)}</article>` : '<p class="hint">可预览或导出原件；文件中的内容尚未作为可检索文字。</p>'}`,
    { kind: "imports", id: f.id },
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
function refreshConversationContextUI() {
  const root = document.querySelector("#conversation-context-status-root");
  if (tab !== "chat" || !currentConversation || !root) return;
  const cid = currentConversation, current = store.get("conversations", cid);
  const view = conversationContextStatus(store, current);
  selectedRefs = new Set(view.keys); refsByConversation.set(cid, selectedRefs);
  const label = document.querySelector(".context-count");
  if (label) label.textContent = view.label;
  const props = { view, busy: contextSaving,
    onChoose: () => { if(currentConversation !== cid) throw Error("对话已切换"); pickContext(); },
    onUseScope: () => saveConversationContext(cid, [], { useKnowledgeScope: true, base: structuredClone(store.get("conversations",cid)) }),
  };
  if (contextStatusUI?.element === root) { contextStatusUI.update(props); return; }
  if (contextStatusMount === root) return;
  contextStatusMount = root;
  mountConversationContextStatus(root, props).then(handle => {
    if (!root.isConnected || currentConversation !== cid) return handle.unmount();
    contextStatusUI = handle; contextStatusMount = null; refreshConversationContextUI();
  }).catch(failure => { if(contextStatusMount===root)contextStatusMount=null; if(root.isConnected)error(failure); });
}
function pickContext() {
  const c = store.get("conversations", currentConversation);
  if (!c) throw Error("对话已不可用");
  const view = conversationContextStatus(store, c), chosen = new Set(view.keys);
  const choices = conversationContextOptions(store);
  openSheet("引用资料",
    `<p class="hint">只使用选中的资料讨论。切换到知识检索时，请使用下方的“${esc(view.resetLabel)}”。</p>
      <div class="ref-list" id="context-picker-list">${choices.map(n=>
        `<label><input type="checkbox" data-ref="${esc(n.key)}" ${chosen.has(n.key)?"checked":""}><span>${esc(n.title)}<small>${n.kind==="imports"?"文件":"笔记"}</small></span></label>`
      ).join("") || '<p class="hint">暂无可引用资料。可以恢复原资料，或改用知识检索。</p>'}</div>
      ${button("使用这些引用", "finish-context", chosen.size?"":"disabled", "primary wide")}
      ${button(esc(view.resetLabel), "use-knowledge-scope", "", "quiet wide")}`);
  contextPickerID = c.id; contextPickerBase = structuredClone(c); pendingContextRefs = chosen;
}
async function saveConversationContext(cid, keys, { useKnowledgeScope = false, base } = {}) {
  if (!cid || cid !== currentConversation) throw Error("对话已变化，请重新选择引用");
  if (contextSaving) return;
  contextSaving = true; refreshConversationContextUI();
  const revision = navigationRevision;
  try {
    await store.tx(state => {
      const current = state.records["conversations:"+cid]?.data;
      if (!current || !equal(current, base)) throw Error("对话已在其他位置更新，请重新打开引用列表；输入已保留");
      const mobileContext = selectConversationContext(state, current, keys, { useKnowledgeScope });
      putRecord(state, "conversations", {...current, mobileContext, updatedAt:Date.now()}, base);
    });
    if (currentConversation === cid && revision === navigationRevision) { sheet.close(); render(); }
  } finally { contextSaving = false; refreshConversationContextUI(); }
}

function conflicts() {
  conflictReviews.clear();
  const groups = syncGroupSummaries(store.state), groupedKeys = new Set(groups.flatMap(group => group.keys));
  const seen = new Set(), reviews = [], unavailable = [];
  for (const group of groups.filter(group => group.status === "blocked")) {
    if (seen.has(group.groupId)) continue;
    try {
      const review = syncGroupReview(store.state, group.groupId);
      reviews.push(review); for (const groupId of review.groupIds) seen.add(groupId);
    } catch (e) { seen.add(group.groupId); unavailable.push({ ...group, error: e.message }); }
  }
  for (const [key, record] of Object.entries(store.state.records)) if (record.conflict && !groupedKeys.has(key)) conflictReviews.set(key, conflictReview(record));
  const singles = Object.entries(store.state.records)
      .filter(([key, record]) => record.conflict && !groupedKeys.has(key))
      .map(([key, record]) => `<section class="settings-card"><h3>${esc(record.data?.title || record.data?.name || record.conflict.data?.title || "已删除的记录")}</h3><details><summary>比较本机与云端</summary><h4>本机</h4><pre>${esc(record.deleted ? "已删除" : JSON.stringify(record.data, null, 2))}</pre><h4>云端</h4><pre>${esc(record.conflict.deleted ? "已删除" : JSON.stringify(record.conflict.data, null, 2))}</pre></details><div class="actions">${button("保留本机", "resolve", `data-key="${esc(key)}" data-choice="local"`)}${button("使用云端", "resolve", `data-key="${esc(key)}" data-choice="remote"`)}</div></section>`).join("");
  openSheet(
    "处理同步冲突",
    `${reviews.length || unavailable.length ? '<div id="sync-group-review-root"></div>' : ""}${singles}` || '<div class="empty">没有需要处理的冲突。</div>',
  );
  if (!reviews.length && !unavailable.length) return;
  const root = sheet.querySelector("#sync-group-review-root");
  mountSyncGroupReview(root, { reviews, unavailable,
    onBusy: value => { syncGroupBusy = value; const close = sheet.querySelector('.sheet-head [data-action="close"]'); if (close) close.disabled = value; },
    onResolve: async review => {
      await store.resolveGroup(review.groupId, "remote", review);
      conflicts(); render(); notify("已整组采用云端内容。需要的修改请重新生成并审阅方案。");
    },
    onSync: async () => { await performSync(); conflicts(); },
  }).then(handle => { if (!root.isConnected || !sheet.open) return handle.unmount(); syncGroupUI = handle; })
    .catch(e => { if (root.isConnected && sheet.open) error(e); });
}
function openConversation(conversationID) {
  const c = store.get("conversations", conversationID);
  if (!c || c.archived || c.deletedAt) throw Error("对话已删除或归档，请从列表重新打开");
  selectedRefs = new Set(restoreConversationContext(store, c).keys);
  refsByConversation.set(c.id, selectedRefs);
  currentProject = c.projectId || null;
  navigatePage("chat", c.id);
}
async function newChat(projectID = null, refs = [], { draft, homeSubmission, source } = {}) {
  const revision = ++navigationRevision;
  const c = {
    id: id(), title: "新对话", projectId: projectID,
    mobileContext: createConversationContext(refs, source),
    workspace: store.get("projects", projectID)?.workspace || "日常",
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  let homeCleared = false;
  await store.tx(state => {
    putRecord(state, "conversations", c);
    if (draft !== undefined) state.drafts["chat:" + c.id] = draft;
    if (homeSubmission && homeDraftRevision === homeSubmission.revision && state.drafts["home:new"] === homeSubmission.value) {
      state.drafts["home:new"] = ""; homeCleared = true;
    }
  });
  refsByConversation.set(c.id, new Set(refs));
  if (homeCleared && homeDraftRevision === homeSubmission.revision) {
    homeDraft = "";
    const input = document.querySelector("#home-chat-text");
    if (input?.value === homeSubmission.value) input.value = "";
  }
  if (navigationRevision === revision && (!homeSubmission || homeDraftRevision === homeSubmission.revision)) openConversation(c.id);
  return c.id;
}
async function submitChatText(text, conversationID = currentConversation, onAccepted = () => {}, contextSnapshot = null) {
      if (!text || !conversationID) return;
      await store.tail;
      const conversation = store.get("conversations",conversationID);
      const context = restoreConversationContext(store, contextSnapshot ? { ...conversation, mobileContext: createConversationContext(contextSnapshot.contextKeys) } : conversation);
      if (context.unavailableCount) throw Error("部分引用资料已不可用，请重新选择引用后发送；没有扩大检索范围。");
      const run = sessions.start({ conversationID, projectID: contextSnapshot ? contextSnapshot.projectID : store.get("conversations", conversationID)?.projectId || null,
        contextKeys: context.keys, prompt: text, messageIDs: store.list("messages").filter(m => m.conversationId === conversationID).map(m => m.id) });
      let restoredDraft = null;
      try {
        await store.tx(s => {
          if (s.drafts["chat:" + conversationID]?.trim() === text.trim()) s.drafts["chat:" + conversationID] = "";
          const conversation = s.records['conversations:' + conversationID];
          if (conversation && !conversation.deleted && conversation.data.title === '新对话' && run.messageIDs.size === 0) {
            putRecord(s, 'conversations', { ...conversation.data, title: Array.from(text.replace(/\s+/g, ' ').trim()).slice(0,36).join(''), updatedAt: Date.now() });
          }
        });
        if (tab === "chat" && currentConversation === conversationID) {
          const input = document.querySelector("#chat-text");
          if (input?.value.trim() === text) input.value = "";
        }
        if (tab === "chat" && currentConversation === conversationID) render();
        run.phase = "正在准备引用资料";
        scheduleRunPaint(run);
        await extractPendingImports({ store, files, extractText, native, platformName });
        const result = await ask({ store, http, stream: httpStream, vault, connectionSync, prompt: text, conversationID,
          projectID: run.projectID, contextKeys: run.contextKeys, signal: run.controller.signal, onAccepted: acceptance => {
            // The callback follows the durable user/assistant insert, before any
            // provider output; only adopt the unambiguous new assistant identity.
            const replies = store.list('messages').filter(m => m.conversationId === conversationID && m.role === 'assistant' && !run.messageIDs.has(m.id));
            if (replies.length === 1) run.savedMessageID = replies[0].id;
            onAccepted(acceptance);
          },
          onProgress: event => { if (sessions.progress(run, event)) scheduleRunPaint(run); } });
        run.savedMessageID = result.messageID;
        return result;
      } catch (err) {
        // Restore only an empty draft. New typing in this or another chat wins.
        const inputRevision = composerRevision;
        const restored = await store.tx(s => {
          if (s.drafts["chat:" + conversationID]) return false;
          s.drafts["chat:" + conversationID] = text;
          return true;
        });
        if (restored) restoredDraft = { conversationID, value: text, inputRevision };
        if (err.name !== "AbortError") throw err;
      } finally {
        sessions.finish(run);
        finishRunPaint(run);
        if (tab === "chat" && currentConversation === conversationID) { render({ chatDraftUpdate: restoredDraft }); followLatest(run); }
        else notify("对话「" + (store.get("conversations", conversationID)?.title || "新对话") + "」已结束");
      }
}

function speechSettings() {
  const c = store.state.settings.speech || {};
  return `<section class="settings-card"><h2>语音输入</h2><p class="hint">这里单独配置此手机的语音识别服务。保存后，语音将使用这里的配置；要使用 Mac 配置，请在上方“从 Mac 同步模型”中选择。语音先转成文字，再发送给对话模型。</p><div id="api-speech-profiles"></div><form id="speech-form"><p class="hint" data-api-profile-loading role="status">正在载入语音方案…</p><fieldset class="api-profile-fields" data-api-profile-fields disabled><input name="profileId" type="hidden">${field('profileName','方案名称','text','新语音方案')}<label>语音接口<select name="provider">${[['aliyun','阿里百炼原生 ASR'],['qwen','Qwen ASR · Chat 兼容'],['openai','Transcriptions 兼容接口']].map(([v,l])=>`<option value="${v}" ${(c.provider||'aliyun')===v?'selected':''}>${l}</option>`).join('')}</select></label>${field('base','语音 API 地址','url',c.base||'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1')}${field('model','语音识别模型','text',c.model||'qwen-audio-3.0-asr-flash')}${field('key','语音 API Key（留空保留此方案同地址的 Key）','password')}${field('language','语言代码（可留空）','text',c.language||'')}<button type="submit" class="primary">保存并使用语音方案</button></fieldset></form><form id="voice-input-settings"><label class="check"><input type="checkbox" name="autoSend" ${store.state.settings.voiceAutoSend!==false?'checked':''}>转写后自动发送，保留 3 秒取消时间</label><button type="submit">保存发送偏好</button></form><div class="voice-shortcut-settings"><h3>快捷唤起</h3><p id="voice-shortcut-status" class="hint" role="status"></p>${platformName==='android'?`<p class="hint">开启后，在 App 内连续按 3 次音量减即可唤起；在其他 App 中使用，需要手动允许 AI Bro 无障碍服务。仅监听快捷按键，不读取屏幕内容。按键仍会正常降低音量；请先解锁手机。</p>${button('设置三按音量减','voice-shortcut-enable')}${button('关闭快捷唤起','voice-shortcut-disable','','quiet')}`:`<p class="hint">在系统「快捷指令」中选择 AI Bro → 语音记录，可绑定操作按钮或轻点背面。iPhone 不支持应用拦截全局三按音量键。</p>`}</div></section>`;
}
async function refreshVoiceStatus() {
  const node=document.querySelector('#voice-shortcut-status');if(!node)return;
  try {const state=await Bridge.voiceStatus();if(!node.isConnected)return;
    node.textContent=platformName==='android'?(state.shortcutEnabled?'三按音量减：已开启全局唤起':state.shortcutOptIn?'三按音量减：App 内可用；全局唤起等待系统授权':'三按音量减：未开启'):'通过 Siri 或系统快捷指令打开语音记录';
  } catch {if(node.isConnected)node.textContent='需要安装包含语音功能的最新 App';}
}

const voiceDialog = document.createElement('dialog');
voiceDialog.id = 'voice-dialog'; voiceDialog.className = 'voice-dialog';
voiceDialog.setAttribute('aria-label', '语音新会话'); document.body.append(voiceDialog);
let voiceSnapshot = null, voiceTick = null;
function paintVoice(run) {
  voiceSnapshot = run;
  const destinationLabel = voiceDestinationLabel(run.destination);
  voiceDialog.setAttribute('aria-label', '语音输入 · ' + destinationLabel);
  if (['starting','failed'].includes(run.stage) && !voiceDialog.open) voiceDialog.showModal();
  if (['submitting','sent'].includes(run.stage)) { voiceDialog.close(); clearInterval(voiceTick); return; }
  if (!voiceDialog.open) return;
  const title = {starting:'正在打开麦克风',recording:'正在听，说完点完成',transcribing:'正在转成文字',preview:'听到的是这些',editing:'正在保留文字',failed:'这次没有完成',cancelled:'已取消，未发送'}[run.stage] || '语音输入';
  const busy = ['starting','recording','transcribing'].includes(run.stage);
  voiceDialog.innerHTML = `<div class="sheet-head"><h2>${title}</h2><button type="button" data-voice="cancel" aria-label="取消语音">×</button></div><p class="voice-destination">发送到${esc(destinationLabel)}</p><div class="voice-indicator ${busy?'active':''}" aria-hidden="true">${run.stage==='recording'?'◉':run.stage==='transcribing'?'◌':'♫'}</div><p class="voice-time" aria-live="off"></p>${run.text?`<blockquote class="voice-transcript">${esc(run.text)}</blockquote>`:''}${run.error?`<p class="voice-error" role="alert">${esc(run.error)}</p>`:''}<p class="voice-state" role="status">${run.stage==='recording'?'最多录制 2 分钟，取消不会发送给 AI。':run.stage==='transcribing'?'识别完成后可预览、取消或修改文字。':run.stage==='preview'?(run.sendAt?'3 秒后发送':'文字已保留，确认后再发送'):''}</p><div class="actions">${run.stage==='recording'?'<button type="button" data-voice="finish" class="primary">完成并转写</button>':''}${run.text&&['preview','failed'].includes(run.stage)?'<button type="button" data-voice="send" class="primary">现在发送</button><button type="button" data-voice="edit">修改文字</button>':''}${run.stage==='failed'&&!run.text?'<button type="button" data-voice="retry">重新录制</button>':''}<button type="button" data-voice="cancel" class="quiet">${run.stage==='cancelled'?'关闭':'取消'}</button></div>`;
  if(run.stage==='editing')voiceDialog.querySelectorAll('button').forEach(button=>button.disabled=true);
  clearInterval(voiceTick);
  const tick = () => {
    if (!voiceDialog.open) { clearInterval(voiceTick); return; }
    const elapsed = Math.max(0,Math.floor((Date.now()-run.startedAt)/1000));
    voiceDialog.querySelector('.voice-time').textContent = run.stage==='recording'?`${String(Math.floor(elapsed/60)).padStart(2,'0')}:${String(elapsed%60).padStart(2,'0')}`:'';
    if (run.stage==='preview'&&run.sendAt) voiceDialog.querySelector('.voice-state').textContent=`${Math.max(0,Math.ceil((run.sendAt-Date.now())/1000))} 秒后发送`;
  }; tick(); if (run.stage==='recording'||run.sendAt) voiceTick=setInterval(tick,250);
}
const voice = new VoiceSession({
  record: { start: requestId => Bridge.voiceStart({requestId}), stop: requestId => Bridge.voiceStop({requestId}), cancel: requestId => Bridge.voiceCancel({requestId}) },
  transcribe: (audio,signal) => transcribeWithConnections({store,connectionSync,audio,http,vault,signal}),
  submit: async (text,requestId,destination) => {
    // Recording/cancellation never creates a conversation. Explicit send or
    // edit prepares its destination once, in the same write as the request ID.
    const route = await prepareVoiceConversation(store,{requestId,destination,text});
    openConversation(route.conversationID);
    await waitForVoiceAcceptance(accepted => submitChatText(text,route.conversationID,accepted,route), error);
    return {conversationID:route.conversationID};
  },
  onChange: run => { paintVoice(run); if(run.stage==='failed'&&!voiceDialog.open)error(Error(run.error)); },
});
async function startVoice(destination = voiceDestination(store)) {
  if (!native) throw Error('语音快捷输入请在 Android 或 iOS App 中使用');
  try { await validateSpeechConnection({store,connectionSync,vault}); }
  catch(e) { await openSettingsSection(modelConnectionView('speech').target); throw e; }
  if (voice.current?.stage==='recording') return voice.stop({autoSend:store.state.settings.voiceAutoSend!==false});
  if (voice.current?.stage==='preview') { voice.hold(); if(!voiceDialog.open){voiceDialog.showModal();paintVoice(voice.current);}return; }
  if (!await voice.start(destination)) {
    if (['starting','transcribing'].includes(voice.current?.stage)) {
      if (!voiceDialog.open) voiceDialog.showModal(); paintVoice(voice.current);
    } else if (['submitting','editing'].includes(voice.current?.stage)) notify('正在保存这条语音，请稍候');
  }
}
voiceDialog.addEventListener('click',async e=>{
  const action=e.target.closest('[data-voice]')?.dataset.voice;if(!action)return;
  if(voice.current?.stage==='editing')return;
  try {
    if(action==='finish')await voice.stop({autoSend:store.state.settings.voiceAutoSend!==false});
    if(action==='send')await voice.send();
    if(action==='cancel'){await voice.cancel();voiceDialog.close();clearInterval(voiceTick);}
    if(action==='retry')await voice.start(voice.current?.destination);
    if(action==='edit'){
      const route=await voice.edit((text,requestId,destination)=>prepareVoiceConversation(store,{requestId,destination,text,edit:true}));
      if(!route)return;
      voiceDialog.close();
      refsByConversation.set(route.conversationID,new Set(route.contextKeys));
      openConversation(route.conversationID);
      document.querySelector('#chat-text')?.focus();
    }
  } catch(e){error(e);}
});
voiceDialog.addEventListener('cancel',e=>{e.preventDefault();if(voice.current?.stage==='editing')return;voice.cancel().finally(()=>{voiceDialog.close();clearInterval(voiceTick);});});
const seenVoiceShortcuts=new Set();
async function acceptVoiceShortcut(event) {
  if(!event?.requestId||seenVoiceShortcuts.has(event.requestId)||!appForeground)return;
  navigationRevision++;
  seenVoiceShortcuts.add(event.requestId);if(seenVoiceShortcuts.size>64)seenVoiceShortcuts.delete(seenVoiceShortcuts.values().next().value);
  try {
    if(Number.isFinite(event.createdAt)&&Date.now()-event.createdAt>5*60*1000)return;
    await startVoice();
  } catch(e){error(e);}
  finally {await Bridge.voiceShortcutAck({requestId:event.requestId}).catch(()=>{});}
}

function projectDetail(p) {
  if (!p) throw Error("项目已不存在，请刷新列表");
  const tasks = active(store.list("tasks")).filter(t => t.projectId === p.id);
  const notes = active(store.list("notes")).filter(n => n.projectId === p.id);
  const agenda = notes.map(n => ({ note: n, event: readEvent(n) })).filter(item => item.event).sort((a,b) => a.event.start - b.event.start);
  const chats = active(store.list("conversations")).filter(c => c.projectId === p.id).sort((a,b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const empty = text => `<p class="hint">${text}</p>`;
  openSheet(
    p.name || p.title,
    `<p class="lead">${esc(p.description || "给计划、资料和想法一个共同的位置。")}</p>${button("✦ 新建项目对话", "project-chat", `data-id="${esc(p.id)}"`, "primary wide")}<div class="actions">${button("编辑项目", "edit-project", `data-id="${esc(p.id)}"`)}${button("归档项目", "remove-record", `data-key="projects:${esc(p.id)}"`, "quiet")}</div>
    <h3>项目对话</h3>${chats.map(c => `<button class="item" data-action="conversation" data-id="${esc(c.id)}"><span class="item-icon">✦</span><span><strong>${esc(c.title)}</strong><small>${sessions.get(c.id) ? "正在回复" : "继续对话"}</small></span><span>›</span></button>`).join("") || empty("还没有项目对话。")}
    <div class="section-heading"><h3>任务</h3>${button("＋ 添加", "new-task", `data-project="${esc(p.id)}"`)}</div>${tasks.map(t => `<button class="item" data-action="task" data-id="${esc(t.id)}"><span>${t.status === "done" ? "✓" : "○"}</span><strong>${esc(t.title)}</strong><small>${esc(taskStatusLabel(t.status))}</small></button>`).join("") || empty("还没有任务。")}
    <h3>项目日程</h3>${agenda.map(({ note, event }) => `<button class="item event-row" data-action="event" data-id="${esc(note.id)}"><span class="item-icon">▦</span><span><strong>${esc(note.title)}</strong><small>${esc(new Date(event.start).toLocaleString("zh-CN", { timeZone: event.timeZone || "UTC", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }))} · ${esc(event.timeZone || "UTC")}${isRepeatingEvent(event) ? " · 重复日程" : ""}</small></span><span>›</span></button>`).join("") || empty("还没有项目日程。")}
    <h3>资料与笔记</h3>${notes.filter(n => !readEvent(n)).map(noteRow).join("") || empty("还没有笔记。")}`,
    { kind: "projects", id: p.id },
  );
}
function checklistRow({ index = null, text = "", done = false }) {
  return `<div class="task-checklist-row" data-checklist-index="${index ?? "new"}"><label><input type="checkbox" aria-label="完成清单项" ${done ? "checked" : ""}></label><input type="text" aria-label="清单内容" value="${esc(text)}" maxlength="1000"><button type="button" data-action="task-checklist-remove" aria-label="移除此清单项">×</button></div>`;
}
function taskDateInput(value) {
  if (!value) return "";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value + "T09:00";
  return Number.isFinite(+new Date(value)) ? localInput(value) : "";
}
function taskEditor(t, projectID) {
  taskOriginal = t || null;
  const due = taskDateInput(t?.dueAt), start = taskDateInput(t?.startAt);
  openSheet(
    t ? "任务详情" : "添加任务",
    `<form id="task-form" data-id="${esc(t?.id || "")}" data-due-original="${due}" data-start-original="${start}">
      <label class="task-title">任务<input name="title" value="${esc(t?.title || "")}" required maxlength="12000" placeholder="要完成什么？"></label>
      <label>说明<textarea name="description" rows="3" maxlength="12000" placeholder="补充资料、要求或下一步…">${esc(t?.description || "")}</textarea></label>
      <fieldset class="task-checklist"><legend>清单</legend><div id="task-checklist">${taskChecklistRows(t).map(checklistRow).join("")}</div>${button("＋ 添加清单项", "task-checklist-add", 'type="button"', "quiet task-checklist-add")}</fieldset>
      <div class="task-fields"><label>状态<select name="status">${taskStatusOptions(t?.status).map(({value,label})=>`<option value="${esc(value)}" ${taskStatusSelection(t?.status)===value?"selected":""}>${esc(label)}</option>`).join("")}</select></label>
      <label>优先级<select name="priority">${taskPriorityOptions(t?.priority).map(({value,label})=>`<option value="${esc(value)}" ${taskPrioritySelection(t?.priority)===value?"selected":""}>${esc(label)}</option>`).join("")}</select></label></div>
      ${field("due", "截止时间", "datetime-local", due)}
      <label>项目<select name="project">${projectEditorOptions(t, t ? recordProjectSelection(t, store.list("projects")) : projectID || "")}</select></label>
      <details class="task-properties" ${t?.startAt ? "open" : ""}><summary>开始时间与提醒</summary>
      ${field("start", "开始时间", "datetime-local", start)}
      <label>提醒<select name="reminder">${[["inherit","跟随本机设置"],["off","不提醒"],["0","到点提醒"],["15","提前 15 分钟"],["60","提前 1 小时"],["1440","提前 1 天"],...([0,15,60,1440,null,undefined].includes(t?.reminderMinutes)?[]:[[String(t.reminderMinutes),`提前 ${t.reminderMinutes} 分钟`]])].map(([v,label])=>`<option value="${v}" ${v===(t&&Object.hasOwn(t,"reminderMinutes")?(t.reminderMinutes===null?"off":String(t.reminderMinutes)):"inherit")?"selected":""}>${label}</option>`).join("")}</select></label></details>
      <div id="task-actions-root" class="task-actions-root"></div>
    </form>${t ? `<div class="task-manage">${button("移入回收站", "remove-record", `data-key="tasks:${esc(t.id)}"`, "danger")}</div>` : ""}`,
    t?.id ? { kind: "tasks", id: t.id } : null,
  );
  const root = sheet.querySelector("#task-actions-root"), form = sheet.querySelector("#task-form");
  const draftSession = bindFormDraft("task", form, t || null, projectID || null);
  mountTaskActions(root, { existing: !!t, completed: t?.status === "done", busy: false,
    onComplete: () => { form.elements.status.value = t?.status === "done" ? "todo" : "done"; form.requestSubmit(); },
  }).then(handle => {
    if (!root.isConnected || !sheet.open) { handle?.unmount(); return; }
    taskActionsUI = handle; updateFormDraftUI(draftSession);
  }).catch(() => { if (root.isConnected) { root.innerHTML = '<button class="primary wide" type="submit">保存任务</button>'; updateFormDraftUI(draftSession); } });
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
    await syncScheduler.runNow();
    notify(sync.status);
  } finally {
    safeRender();
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
let pendingRemoval = null, pendingRestore = null, projectOriginal = null, taskOriginal = null;
function removalSheet(key) {
  pendingRemoval = reviewRemoval(store, key);
  openSheet(pendingRemoval.operation === "archive" ? "归档内容" : "移入回收站", `<h3>${esc(pendingRemoval.title)}</h3>${pendingRemoval.warnings.map(w => `<p>${esc(w)}</p>`).join("")}<div class="actions">${button("确认", "confirm-removal", "", "danger")}${button("取消", "close", "", "quiet")}</div>`);
}
function recoverySheet() {
  openSheet("归档与回收站", listRecoverable(store).map(item => `<section class="item"><span><strong>${esc(item.title)}</strong><small>${esc(item.label)}${item.reason ? " · " + esc(item.reason) : ""}</small></span>${item.canRestore ? button("恢复", "restore-record", `data-key="${esc(item.key)}"`) : ""}</section>`).join("") || '<p class="empty">没有待恢复的内容。</p>');
}
function editProject(p) {
  projectOriginal = p || null;
  openSheet(p ? "编辑项目" : "新建项目", `<form id="project-form">${field("name", "项目名称", "text", p?.name || p?.title || "")}<label>空间<select name="workspace">${["科研", "课程", "日常"].map(w => `<option ${w === p?.workspace ? "selected" : ""}>${w}</option>`).join("")}</select></label><label>项目目标<textarea name="description">${esc(p?.description || "")}</textarea></label><button class="primary" type="submit">保存项目</button></form>`);
}
const actions = {
  "voice-new": () => startVoice(),
  "voice-current": () => {
    const view = conversationContextStatus(store, store.get("conversations",currentConversation));
    if (!view.canSend) throw Error(view.message);
    return startVoice(voiceDestination(store,currentConversation,view.keys));
  },
  "voice-settings": () => { navigatePage('settings'); document.querySelector('#speech-form')?.scrollIntoView({block:'start'}); },
  "voice-shortcut-enable": async () => { await Bridge.voiceShortcutSet({enabled:true}); await Bridge.openVoiceShortcutSettings(); notify('请在系统页面手动允许 AI Bro 快捷语音，然后返回'); },
  "voice-shortcut-disable": async () => { await Bridge.voiceShortcutSet({enabled:false});await refreshVoiceStatus(); notify('已关闭三按音量减唤起'); },
  "model-settings": () => openSettingsSection(modelConnectionView().target),
  "stop-response": () => { sessions.cancel(currentConversation); const run = sessions.get(currentConversation); if (run) scheduleRunPaint(run); },
  "latest-response": () => { const run = sessions.get(currentConversation); if (run) { run.follow = true; followLatest(run); updateFollowButton(run); } },
  "copy-message": async b => { const m = messageForAction(b); await navigator.clipboard.writeText(m?.content || m?.text || ""); notify("已复制"); },
  "reuse-message": async b => {
    const m = messageForAction(b), conversationID = m.conversationId;
    if (!m || m.conversationId !== conversationID) return;
    const value = m.content || m.text || "", inputRevision = composerRevision;
    await store.tx(s => s.drafts["chat:" + conversationID] = value);
    if (tab === "chat" && currentConversation === conversationID) {
      render({ chatDraftUpdate: { conversationID, value, inputRevision } });
      document.querySelector("#chat-text")?.focus();
    }
  },
  "review-plan": async b => {
    const m = messageForAction(b);
    const plan = validatePlan(store, m?.pendingPlan);
    openSheet("审阅 AI 修改", '<div id="plan-review-root"></div>');
    const root = sheet.querySelector("#plan-review-root");
    const handle = await mountPlanReview(root, {
      plan, projects: Object.fromEntries(store.list("projects").map(p => [p.id,p.name || p.title])),
      onBusy: value => { planReviewBusy = value; const close = sheet.querySelector('.sheet-head [data-action="close"]'); if (close) close.disabled = value; },
      onApply: async () => { const result = await applyPlan(store, plan); sheet.close(); render(); notify(`已完成 ${result.receipts.length} 项操作`); },
      onReject: async () => { await rejectPlan(store, plan); sheet.close(); render(); notify("未采用修改，原内容保留"); },
    });
    if (!root.isConnected || !sheet.open) return handle.unmount();
    planReviewUI = handle;
  },
  "remove-record": b => removalSheet(b.dataset.key),
  "confirm-removal": async () => { const result = await removeRecord(store, pendingRemoval); sheet.close(); render(); notify(result.operation === "archive" ? "已归档，可在设置中恢复" : "已移入回收站，可在设置中恢复"); },
  recovery: recoverySheet,
  "restore-record": b => openRecoveryReview(b.dataset.key),
  "confirm-restore": async () => { await restoreRecord(store, pendingRestore); recoverySheet(); render(); notify("已恢复"); },
  "edit-project": b => editProject(store.get("projects", b.dataset.id)),

  "rewrite-note": (b) => {
    activeNote = b.dataset.id;
    openSheet(
      "AI 改写草稿",
      `<form id="rewrite-form" data-note-id="${esc(activeNote)}">${field("instruction", "希望如何改写？", "text", "整理结构，保留事实与来源，输出完整 Markdown 正文。")}<p class="hint">生成后先审阅，不会直接覆盖笔记。</p><button type="submit" class="primary">生成草稿</button></form>`,
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
  close: () => closeSheetNavigation({ all: true }),
  "sheet-back": () => closeSheetNavigation(),
  tab: (b) => {
    query = "";
    navigatePage(b.dataset.tab);
  },
  day: (b) => {
    selectedDay = b.dataset.day;
    render();
  },
  projects: () => {
    knowledgeMode = "projects";
    navigatePage("knowledge");
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
    beginEditor("note", n);
    activeNote = n.id;
    noteOriginal = n;
    sourceMode = true;
    showNote(n);
  },
  "note-preview": async () => {
    await store.tail;
    await documentMode(editorSession, "read");
  },
  "note-source": async () => {
    await store.tail;
    await documentMode(editorSession, "edit");
  },
  discuss: async (b) => {
    const note = store.get("notes",b.dataset.id);
    if (!note || note.archived || note.deletedAt) throw Error("来源资料已不可用");
    await newChat(note.projectId, ["notes:" + note.id], { source: {kind:"notes",id:note.id,...(editorSession?.originConversationID ? {conversationId:editorSession.originConversationID}: {})} });
  },
  "from-note": (b) => editEvent(null, b.dataset.id),
  "archive-note": b => removalSheet("notes:" + b.dataset.id),
  "export-note": (b) => {
    const n = store.get("notes", b.dataset.id);
    return exportFile(
      n.title + ".md",
      new TextEncoder().encode(n.content),
      "text/markdown",
    );
  },
  "new-event": () => editEvent(),
  event: (b) => openResultTarget({ kind: "agenda", id: b.dataset.id }),
  "delete-event": b => removalSheet("notes:" + b.dataset.id),
  "new-project": () => editProject(),
  project: (b) => projectDetail(store.get("projects", b.dataset.id)),
  "project-chat": (b) => newChat(b.dataset.id),
  "new-task": (b) => taskEditor(null, b.dataset.project),
  "task-checklist-add": () => {
    const list = sheet.querySelector("#task-checklist");
    if (!list || taskSaving) return;
    if (list.children.length >= 100) throw Error("清单最多 100 项，请拆分任务");
    list.insertAdjacentHTML("beforeend", checklistRow({}));
    list.lastElementChild.querySelector('input[type="text"]').focus();
    return retainFormDraftInput(list.closest("form"));
  },
  "task-checklist-remove": b => { if (!taskSaving) { const form = b.closest("form"); b.closest(".task-checklist-row")?.remove(); return retainFormDraftInput(form); } },
  task: (b) => openResultTarget({ kind: "tasks", id: b.dataset.id }),
  "new-chat": () => newChat(),
  "focus-home": () => document.querySelector("#home-chat-text")?.focus(),
  "home-chats": () => { navigatePage("chat", null); window.scrollTo(0, 0); },
  "all-chats": () => navigatePage("chat", null),
  conversation: b => openConversation(b.dataset.id),
  "rename-chat": () =>
    openSheet(
      "重命名对话",
      `<form id="rename-form">${field("title", "名称", "text", store.get("conversations", currentConversation)?.title)}<button class="primary">保存</button></form>`,
    ),
  "pick-context": pickContext,
  "finish-context": () => saveConversationContext(contextPickerID, [...(pendingContextRefs || [])], {base:contextPickerBase}),
  "use-knowledge-scope": () => saveConversationContext(contextPickerID, [], {useKnowledgeScope:true,base:contextPickerBase}),

  reference: (b) => {
    if (b.dataset.sourceIndex !== undefined) {
      // A sync may update the message while its old buttons remain visible to
      // preserve the focused composer. Resolve the rendered identity, not index.
      const source = messageSources(store,messageForAction(b)).find(source =>
        source.identity?.kind === b.dataset.sourceKind && source.identity?.id === b.dataset.sourceId);
      if (!source?.target || source.target.kind !== b.dataset.sourceTargetKind || source.target.id !== b.dataset.sourceTargetId)
        throw Error("来源已变化或不可用，请重新打开对话刷新来源");
      return openResultTarget(source.target);
    }
    if (["tasks", "projects", "agenda", "notes", "imports"].includes(b.dataset.kind)) return openResultTarget({ kind: b.dataset.kind, id: b.dataset.id });
    const n = store.get("notes", b.dataset.id);
    if (n) openResultTarget({ kind: readEvent(n) ? "agenda" : "notes", id: n.id });
    else if (store.get("imports", b.dataset.id))
      return openImport(b.dataset.id);
    else notify("原始资料已删除或尚未同步");
  },
  "save-message": async (b) => {
    const m = messageForAction(b);
    const c = store.get("conversations", m.conversationId);
    if (!c) throw Error("对话已不存在，未保存笔记");
    const n = {
      id: id(),
      title: c.title,
      content: m.content || m.text || "",
      kind: "note",
      workspace: c.workspace,
      projectId: c.projectId,
      sourceConversationId: c.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await store.put("notes", n);
    if (tab === "chat" && currentConversation === m.conversationId) openNote(n);
    else notify("消息已保存为笔记「" + n.title + "」");
  },
  synthesize: async () => {
    if (!captureRefs.size) throw Error("先选择要整理的随记");
    const draft = "请基于所选随记整理共同主题、可能的关联和下一步建议。区分已有证据与待验证的想法。";
    await newChat(null, [...captureRefs], { draft });
  },
  "sync-details": openSyncDetails,
  sync: performSync,
  disconnect: async () => {
    syncScheduler.setAuthenticated(false);
    connectionSync.invalidate({ signedOut: true });
    if (store.state.settings.connectionProfiles?.chat) for (const run of sessions.runs.values()) run.controller.abort();
    if (store.state.settings.connectionProfiles?.speech) await voice.cancel();
    try { await sync.logout(); } finally { render(); }
  },
  conflicts: conflicts,
  resolve: async (b) => {
    await store.resolve(b.dataset.key, b.dataset.choice, conflictReviews.get(b.dataset.key));
    conflicts();
    render();
  },
  file: (b) => openImport(b.dataset.id),
  "extract-file": async () => {
    const f = activeImport;
    notify("正在设备上识别文字…");
    await readImport(f);
    const result = await retryImportText({ store, files, extractText, native, platformName }, f.id, f);
    await openImport(f.id);
    if (!result.ready) notify(result.results[0]?.warning || (result.changed ? "资料已变化，请重新打开后再试" : "未提取到可引用文字，原件保留"));
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
      (hash, snapshotSourceRecord) => snapshotSourceRecord ? readImport(snapshotSourceRecord) : files.read(hash),
      sha256,
    );
    await exportFile("AI-Bro-mobile-backup.zip", bytes, "application/zip");
  },
  restore: () =>
    chooseFile(".zip,.json", async (f) => {
      if (f.size > 129 * 1024 * 1024) throw Error("备份文件过大");
      if (Object.keys(store.state.records).length || store.state.binding || syncGroupSummaries(store.state).length)
        throw Error("请在空白且未连接同步账号的工作区恢复，现有内容没有改变");
      // A checkpoint preserves account identity, never a login session. Clear
      // an orphaned token before any restored records can reach disk or restart.
      syncScheduler.setAuthenticated(false);
      await vault.remove("sync");
      const result = await restoreBackup(
        store,
        new Uint8Array(await f.arrayBuffer()),
        files,
        sha256,
      );
      if (result.checkpoint) {
        syncScheduler.setAuthenticated(false);
        tab = "settings"; render();
        openSheet("恢复检查点已载入", `<p>工作区与 ${result.files} 份原件已恢复，保留 ${result.pendingGroups} 组待同步操作、${result.incomingGroups} 组传入冲突。</p><p>${result.requiresOriginalAccount ? `关闭此页后，请重新登录原同步服务 ${esc(result.binding?.base || "")} 的原账号 ${esc(result.binding?.username || "")}，再继续同步队列。` : "这个检查点尚未关联账号。关闭此页后，可首次连接同步服务与账号。"}</p><p class="hint">检查点不包含密码或令牌。整组冲突需要在同步详情中审阅处理。</p>`);
      } else {
        notify(result.legacy ? "旧版记录已恢复；附件原件需从同步服务下载" : `工作区与 ${result.files} 份原件已恢复`);
        render();
      }
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
  if (e.target.matches('#event-form [name="repeatDay"]')) e.target.form.dataset.weekdaysEdited = "true";
  if (e.target.matches('#event-form [name="start"]') && e.target.form.dataset.new === "true" && !e.target.form.dataset.weekdaysEdited) {
    const day = new Date(e.target.value.slice(0,10)+"T12:00:00Z").getUTCDay()+1;
    if (Number.isFinite(day)) for (const input of e.target.form.querySelectorAll('[name="repeatDay"]')) input.checked = Number(input.value) === day;
  }
  if (e.target.matches('#event-form [name="frequency"]')) {
    const form=e.target.form, value=e.target.value;
    form.querySelector('.repeat-fields').hidden=value==='none';
    form.querySelector('.repeat-weekdays').hidden=value!=='weekly';
  }

  const recordForm = e.target.closest("#task-form,#event-form");
  if (recordForm) retainFormDraftInput(recordForm).catch(error);

  if (e.target.dataset.ref) {
    const target = e.target.closest("#context-picker-list") ? pendingContextRefs : captureRefs;
    if (target) e.target.checked ? target.add(e.target.dataset.ref) : target.delete(e.target.dataset.ref);
    if (e.target.closest("#context-picker-list")) {
      const confirm = sheet.querySelector('[data-action="finish-context"]');
      if (confirm) confirm.disabled = contextSaving || !pendingContextRefs?.size;
    }
  }
  if (e.target.id === "day-picker") {
    selectedDay = e.target.value;
    render();
  }
});
for (const event of ["select", "keyup", "pointerup", "focusout"]) document.addEventListener(event, e => {
  if(e.target.matches?.('#note-form [name="content"]')) rememberDocumentSelection(e.target);
});
document.addEventListener("keydown", e => {
  if(e.target.matches?.('#note-form [name="content"]') && (e.metaKey || e.ctrlKey) && !e.altKey && !e.isComposing && ["b","i","k"].includes(e.key.toLowerCase())) {
    e.preventDefault(); rememberDocumentSelection(e.target); formatDocument(editorForms.get(e.target.form),{b:"bold",i:"italic",k:"link"}[e.key.toLowerCase()]);
  }
});
document.addEventListener("compositionstart", e => {
  if (e.target.closest("#note-form")) { const ctx=editorForms.get(e.target.form); if(ctx){ctx.composing=true;updateDocumentUI(ctx)} return; }
  if (e.target.id === "home-chat-text") { composingHome = e.target; return; }
  if (e.target.id !== "chat-text") return;
  clearTimeout(composerEndTimer);
  composingChat = { element: e.target, conversationID: currentConversation };
  composerRevision++;
});
document.addEventListener("compositionend", e => {
  if (e.target.closest("#note-form")) {
    const ctx=editorForms.get(e.target.form); if(ctx) setTimeout(()=>{ctx.composing=false;retainEditorInput(e.target.form)?.then(()=>{updateDocumentUI(ctx);if(ctx.pendingMode){const mode=ctx.pendingMode;ctx.pendingMode=null;documentMode(ctx,mode)}}).catch(error)},0); return;
  }
  if (e.target.id === "home-chat-text") {
    homeDraft = e.target.value;
    const value = homeDraft;
    store.tx(s => s.drafts["home:new"] = value).catch(error);
    setTimeout(() => { composingHome = null; if (deferredHomeRender) render(); }, 0);
    return;
  }
  if (e.target.id === "search") {
    // Native keyboards normally emit the committed input next. Only synthesize
    // the fallback when no such event updated the query; never render twice.
    setTimeout(() => { if (e.target.isConnected && query !== e.target.value) e.target.dispatchEvent(new Event("input", { bubbles: true })); }, 0);
  }
  if (e.target.id !== "chat-text" || composingChat?.element !== e.target) return;
  const composition = composingChat, value = e.target.value;
  composerRevision++;
  store.tx(s => s.drafts["chat:" + composition.conversationID] = value).catch(error);
  clearTimeout(composerEndTimer);
  composerEndTimer = setTimeout(() => {
    if (composingChat !== composition) return;
    composingChat = null;
    if (deferredChatRender) render(deferredChatRender);
  }, 0);
});
document.addEventListener("input", (e) => {
  const recordForm = e.target.closest("#task-form,#event-form");
  if (recordForm) retainFormDraftInput(recordForm).catch(error);
  if (e.target.matches?.('#home-chat-text,#chat-text'))
    sizeComposer(e.target, { visibleHeight: mobileViewport.state.visibleHeight });
  if (e.target.id === 'home-chat-text') {
    const value = e.target.value; homeDraft = value; homeDraftRevision++;
    store.tx(s => s.drafts['home:new'] = value).catch(error);
  }
  if (e.target.id === "search") {
    if (e.isComposing) return;
    query = e.target.value;
    const start = e.target.selectionStart;
    render();
    const input = document.querySelector("#search");
    input.focus();
    input.setSelectionRange(start, start);
  }
  const editorForm = e.target.closest("#capture-form,#note-form");
  if (editorForm && !["files", "camera"].includes(e.target.name)) retainEditorInput(editorForm)?.then(()=>{const ctx=editorForms.get(editorForm);if(ctx?.kind==="note")updateDocumentUI(ctx)}).catch(error);
  if (e.target.id === "chat-text") {
    composerRevision++;
    const key = "chat:" + currentConversation,
      text = e.target.value;
    clearTimeout(noteTimer);
    store.tx((s) => (s.drafts[key] = text)).catch(error);
  }
});
document.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  // These two forms belong exclusively to their profile controllers. Before
  // Kit is ready (or after unmount), never route a submit to a second writer.
  if (f.id === "model-form" || f.id === "speech-form") return;
  const v = Object.fromEntries(new FormData(f)),
    submit = f.querySelector('button[type="submit"],button:not([type])');
  if (submit?.disabled) return;
  if (submit) submit.disabled = true;
  try {
    if (f.id === "home-chat-form") {
      const value = f.querySelector('textarea').value, text = value.trim();
      if (!text) return;
      const cid = await newChat(null, [], { draft: text, homeSubmission: { value, revision: homeDraftRevision } });
      await submitChatText(text, cid);
    } else if (f.id === "rewrite-form") {
      const noteID = f.dataset.noteId, originRevision = navigationRevision,
        base = store.get("notes", noteID);
      if (!base || base.aiDraft) throw Error("请先处理现有草稿");
      notify("正在生成草稿…");
      const result = await ask({
        allowWritePlans: false,
        stream: httpStream,
        connectionSync,
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
      if (f.isConnected && sheet.open && navigationRevision === originRevision) reviewNote(store.get("notes", noteID));
      else notify("改写草稿已保存，可从原资料中审阅");
    } else if (f.id === "capture-form" || f.id === "note-form") {
      await persistEditorForm(f);
    } else if (f.id === "event-form") {
      await saveRecordForm(f, ({ base, values: v, context }) => {
        const old = base && readEvent(base), zone = context.timeZone;
        if (base && !old) throw Error("原日程已无法识别，草稿仍保留");
        const start = old && v.start === eventLocalInput(old.start, zone) ? old.start : eventLocalInstant(v.start, zone);
        const end = old && v.end === eventLocalInput(old.end, zone) ? old.end : eventLocalInstant(v.end, zone);
        if (v.project && v.project !== old?.projectId) {
          const project = store.get("projects", v.project);
          if (!project || project.archived || project.archivedAt || project.deletedAt || project.status === "archived") throw Error("关联项目已不可用，请重新选择");
        }
        const patch = { title: v.title, start, end, timeZone: zone, location: v.location, details: v.details,
          projectId: v.project || null, sourceNoteIds: context.sourceID ? [context.sourceID] : old?.sourceNoteIds || [],
          reminderMinutes: v.reminder === "" ? null : Number(v.reminder) };
        if (!old?.ics) {
          const frequency = v.frequency || "none";
          patch.recurrence = { ...(old?.recurrence || {}), frequency, interval: Number(v.repeatInterval || 1),
            weekdays: frequency === "weekly" ? v.repeatDays.map(Number) : old?.recurrence?.weekdays || [],
            count: v.repeatCount ? Number(v.repeatCount) : null,
            until: v.repeatUntil ? old?.recurrence?.until && v.repeatUntil === eventLocalInput(old.recurrence.until,zone)
              ? old.recurrence.until : eventLocalInstant(v.repeatUntil,zone) : null };
          if (frequency === "weekly" && !patch.recurrence.weekdays.length) throw Error("请选择至少一个重复的星期");
          if (frequency === "none") patch.recurrence = { frequency:"none", interval:1, weekdays:[], count:null, until:null };
        }
        return agendaNote(editAgendaEvent(old, patch, { scope: "series" }), base);
      });
    } else if (f.id === "project-form") {
      if (!v.name.trim()) throw Error("填写项目名称");
      await store.put("projects", {
        ...projectOriginal,
        id: projectOriginal?.id || id(),
        name: v.name,
        workspace: v.workspace,
        description: v.description,
        status: projectOriginal?.status || "active",
        createdAt: projectOriginal?.createdAt || Date.now(),
        updatedAt: Date.now(),
      }, projectOriginal || undefined);
      sheet.close();
      render();
    } else if (f.id === "task-form") {
      await saveRecordForm(f, ({ base: old, values: v }) => {
        if (!v.title.trim()) throw Error("填写任务名称");
        const checklist = editedChecklist(old, v.checklist), stateChanges = {};
        if (!old || v.status !== taskStatusSelection(old.status)) stateChanges.status = v.status;
        if (!old || v.priority !== taskPrioritySelection(old.priority)) stateChanges.priority = v.priority;
        const task = { ...old, ...taskStatePatch(old, stateChanges), ...editedProject(old, v.project, store.list("projects")),
          id: old?.id || id(), title: v.title.trim(), description: v.description,
          dueAt: unchangedTaskDate(v.due, taskDateInput(old?.dueAt), old?.dueAt),
          startAt: unchangedTaskDate(v.start, taskDateInput(old?.startAt), old?.startAt),
          createdAt: old?.createdAt || Date.now(), updatedAt: Date.now() };
        if (checklist.length || Array.isArray(old?.checklist)) task.checklist = checklist;
        if (v.reminder === "inherit") delete task.reminderMinutes;
        else task.reminderMinutes = v.reminder === "off" ? null : Number(v.reminder);
        return task;
      });
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
    } else if (f.id === "voice-input-settings") {
      await store.tx(s => { s.settings.voiceAutoSend = v.autoSend === "on"; });
      notify("语音发送偏好已保存"); render();
    } else if (f.id === "sync-form") {
      if (new URLSearchParams(location.search).get("demo") === "1")
        throw Error("演示工作区不连接真实账号，请打开普通页面");
      notify("正在连接并同步…");
      const previousSession = await savedSyncSession();
      connectionSync.invalidate();
      try {
        await sync.login(v.server, v.username, v.password);
        lastSyncError = "";
        syncScheduler.setAuthenticated(true);
        connectionSync.refresh().catch(()=>{});
      } catch (failure) {
        const currentSession = await savedSyncSession();
        // Login can persist a new session before its first transfer fails.
        if (currentSession && currentSession !== previousSession) { syncScheduler.setAuthenticated(true); connectionSync.refresh().catch(()=>{}); }
        throw failure;
      }
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
      await submitChatText(f.querySelector("textarea").value.trim());
    }
  } catch (err) {
    const ctx = editorForms.get(f);
    if (ctx && editorSession === ctx && sheet.open && !editorInspection(ctx).canSave) showEditor(ctx);
    error(err);
  } finally {
    if (submit) submit.disabled = false;
    const recordContext = formDraftSessions.get(f);
    if (recordContext) updateFormDraftUI(recordContext);
  }
});
let notificationKey = "";
store.addEventListener("change", () => {
  const form = sheet.querySelector("#task-form,#event-form"), ctx = form && formDraftSessions.get(form);
  if (ctx && !ctx.saved) updateFormDraftUI(ctx);
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
  const result = await extractPendingImports({ store, files, extractText, native, platformName });
  if (count) {
    notify("已接收 " + count + " 条分享资料" + (result.failed ? "，部分文件未提取到文字，可在资料中重试" : ""));
    safeRender();
  }
}

syncScheduler = new SyncScheduler({
  store, sync, authenticated: !!await savedSyncSession(), foreground: !document.hidden,
  online: navigator.onLine,
  onStateChange: updateSyncUI,
  onSuccess: () => { lastSyncError = ""; updateSyncUI(syncScheduler.snapshot); refreshConversationContextUI(); safeRender(); },
  onError: failure => { lastSyncError = failure.message || "同步未完成"; updateSyncUI(syncScheduler.snapshot); },
});

if (native) {
  const { Keyboard } = await import("@capacitor/keyboard");
  Keyboard.addListener("keyboardWillShow", info => mobileViewport.keyboardWillShow(info));
  Keyboard.addListener("keyboardWillHide", () => mobileViewport.keyboardWillHide());
  App.addListener("appStateChange", ({ isActive }) => {
    appForeground = isActive;
    syncScheduler.setForeground(isActive);
    if (!isActive) {
      // iOS permission sheets resign active without backgrounding the App.
      if(voice.current?.stage!=="starting"){voice.cancel().catch(()=>{});voiceDialog.close();}
      stopQR();
      const q = sheet.querySelector("#qr-image");
      if (q) q.innerHTML = "";
    }
    if (isActive) {
      connectionSync.refresh().catch(()=>{});
      if(tab==='settings')refreshVoiceStatus();
      Bridge.voiceShortcutPending().then(acceptVoiceShortcut).catch(()=>{});
      refreshNotifications(true);
      publishWidget().catch(error);
      tickCourses().catch(error);
      acceptShared().catch(error);

    }
  });
  App.addListener('pause',()=>{voice.cancel().catch(()=>{});voiceDialog.close();});
  appForeground=(await App.getState()).isActive;
  syncScheduler.setForeground(appForeground);
  Bridge.addListener('voiceShortcut', event => acceptVoiceShortcut(event).catch(error));
  Bridge.addListener('voiceRecordingEvent', event => voice.interrupted(event).catch(error));
  const openURL = event => openAppURL(event).catch(error);
  App.addListener("appUrlOpen", openURL);
  const launch = await App.getLaunchUrl();
  if (launch) openURL(launch);
  Bridge.voiceShortcutPending().then(acceptVoiceShortcut).catch(()=>{});
  Bridge.addListener("sharedReceived", () => acceptShared().catch(error));
  if (platformName === "android") App.addListener("backButton", () => navigateBack().catch(error));
  const { LocalNotifications } = await import("@capacitor/local-notifications");
  LocalNotifications.addListener("localNotificationActionPerformed", () => {
    openAppURL({ url: 'aibro://today' }).catch(error);
  });
  refreshNotifications(true);
  acceptShared().catch(error);
}
window.addEventListener("online", () => syncScheduler.setOnline(true));
window.addEventListener("offline", () => syncScheduler.setOnline(false));
render();
connectionSync.refresh().catch(()=>{});
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
  if (!native) syncScheduler.setForeground(!document.hidden);
  if (document.hidden) {
    if(!native){voice.cancel().catch(()=>{});voiceDialog.close();}
    stopQR();
    const q = sheet.querySelector("#qr-image");
    if (q) q.innerHTML = "";
    const label = sheet.querySelector("#qr-status");
    if (label) label.textContent = "已暂停，请返回课程重新打开签到码";
  } else {

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
