import { test, expect } from "@playwright/test";

const APP = "http://127.0.0.1:8899";
test.use({ viewport: { width: 320, height: 760 }, isMobile: true, hasTouch: true, locale: "zh-CN", timezoneId: "Asia/Shanghai", serviceWorkers: "block", reducedMotion: "reduce" });
test.setTimeout(40000);
const control = (page, name) => page.locator(`[data-document-control="${name}"]`);
async function saved(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("aibro-mobile-v1", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { const db = request.result, tx = db.transaction("state"), get = tx.objectStore("state").get("workspace"); get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error); tx.oncomplete = () => db.close(); };
  }));
}
async function seed(page, unavailableSource = false) {
  await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.fallback() : route.abort());
  await page.route("**/__document_workflow_044", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: '<!doctype html><meta charset="utf-8"><title>synthetic document workflow</title>' }));
  await page.goto(APP + "/__document_workflow_044");
  await page.evaluate(async unavailableSource => {
    const { Store, MemoryAdapter } = await import("/src/store.js");
    const { createConversationContext } = await import("/src/conversation-context.js");
    const store = await new Store(new MemoryAdapter()).load();
    await store.put("notes", { id: "note-a", title: "合成资料 A", content: "中文正文 👩🏽‍💻\n\n第二段资料", kind: "note", workspace: "科研", createdAt: 1, updatedAt: 1 });
    await store.put("notes", { id: "note-b", title: "合成资料 B", content: "B 的原文保持不变", kind: "note", workspace: "课程", createdAt: 1, updatedAt: 1 });
    await store.put("conversations", { id: "parent", title: "原始讨论", workspace: "科研", createdAt: 1, updatedAt: 1 });
    await store.put("conversations", { id: "discussion", title: "资料讨论", workspace: "科研", createdAt: 2, updatedAt: 2,
      mobileContext: createConversationContext(["notes:note-a"], { kind: "notes", id: "note-a", conversationId: "parent" }) });
    store.state.settings.model = { base: "https://document-model.example.test/v1", model: "synthetic", format: "chat" };
    if (unavailableSource) store.state.records["notes:note-a"].deleted = true;
    sessionStorage.setItem("aibro-web-session:live:model", "synthetic-document-key");
    await new Promise((resolve, reject) => { const request = indexedDB.open("aibro-mobile-v1", 1); request.onupgradeneeded = () => request.result.createObjectStore("state"); request.onerror = () => reject(request.error); request.onsuccess = () => { const db = request.result, tx = db.transaction("state", "readwrite"); tx.objectStore("state").put(store.state, "workspace"); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); }; });
  }, unavailableSource);
  await page.goto(APP);
  await expect(page.locator(".mobile-planner")).toBeVisible();
}
async function openNote(page, id = "note-a") {
  await page.locator('nav [data-tab="knowledge"]').click();
  await page.locator(`[data-action="note"][data-id="${id}"]`).click();
  await expect(control(page, "read")).toHaveAttribute("aria-pressed", "true");
}
async function openDiscussion(page) {
  await page.locator('nav [data-tab="chat"]').click();
  await page.locator('[data-action="conversation"][data-id="discussion"]').click();
  await expect(control(page, "source")).toHaveText("来源资料：合成资料 A");
}
async function model(page, handler) {
  await page.route("https://document-model.example.test/**", async route => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*" } });
    const text = await handler(route.request().postDataJSON());
    await route.fulfill({ contentType: "text/event-stream; charset=utf-8", headers: { "access-control-allow-origin": "*" }, body: `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n` });
  });
}

test("format, undo, redo, preview and save retain the same textarea and its local draft", async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await seed(page); await openNote(page); await control(page, "edit").click();
  const area = page.locator('#note-form [name="content"]');
  await area.evaluate(element => { window.documentArea = element; element.focus(); element.setSelectionRange(0, 4); });
  await control(page, "format-bold").click();
  await expect(area).toHaveValue("**中文正文** 👩🏽‍💻\n\n第二段资料");
  await control(page, "format-undo").click();
  await expect(area).toHaveValue("中文正文 👩🏽‍💻\n\n第二段资料");
  await control(page, "format-redo").click();
  await expect(area).toHaveValue("**中文正文** 👩🏽‍💻\n\n第二段资料");
  await control(page, "read").click();
  await expect(page.locator("#document-reader strong")).toHaveText("中文正文");
  await control(page, "edit").click();
  expect(await area.evaluate(element => element === window.documentArea)).toBe(true);
  await expect(area).toHaveValue("**中文正文** 👩🏽‍💻\n\n第二段资料");
  await expect(control(page, "save")).toBeEnabled();
  await control(page, "save").click();
  await expect.poll(async () => (await saved(page)).records["notes:note-a"].data.content).toBe("**中文正文** 👩🏽‍💻\n\n第二段资料");
  await expect(control(page, "save")).toBeDisabled();
  expect(await area.evaluate(element => element === window.documentArea)).toBe(true);
  const state = await saved(page);
  expect(state.records["notes:note-a"].data.content).toBe("**中文正文** 👩🏽‍💻\n\n第二段资料");
  expect(state.drafts["editor:note-a"]).toBeUndefined();
  expect(await page.locator("#sheet").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("document-editor-dark-320.png"), animations: "disabled" });
  await page.locator('#sheet [data-action="close"]').click(); await page.reload(); await openNote(page);
  await expect(page.locator("#document-reader strong")).toHaveText("中文正文");
});

test("Chinese composition leaves the editor DOM intact and formatting waits until composition ends", async ({ page }) => {
  await seed(page); await openNote(page); await control(page, "edit").click();
  const area = page.locator('#note-form [name="content"]');
  await area.evaluate(element => { window.documentArea = element; element.focus(); element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "中文" })); });
  await expect(control(page, "format-bold")).toBeDisabled();
  await area.evaluate(element => { element.value = "正在输入中文 👩🏽‍💻"; element.dispatchEvent(new InputEvent("input", { bubbles: true, data: "中文", inputType: "insertCompositionText", isComposing: true })); });
  expect(await area.evaluate(element => element === window.documentArea)).toBe(true);
  await area.evaluate(element => element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中文" })));
  await expect(control(page, "format-bold")).toBeEnabled();
  await expect.poll(async () => (await saved(page)).drafts["editor:note-a"]?.values.content).toBe("正在输入中文 👩🏽‍💻");
});

test("save and discuss persists the exact draft before source retrieval; source and parent survive reload", async ({ page }) => {
  await seed(page); await openDiscussion(page);
  await control(page, "source").click(); await control(page, "edit").click();
  await page.locator('#note-form [name="content"]').fill("保存后才交给 AI 的新正文");
  await expect(control(page, "discuss")).toHaveText("保存并讨论");
  await control(page, "discuss").click();
  await expect(page.locator("#sheet")).not.toBeVisible();
  await expect(control(page, "source")).toHaveText("来源资料：合成资料 A");
  let request;
  await model(page, body => { request = body; return "合成回答"; });
  await page.locator("#chat-text").fill("总结这篇资料");
  await page.locator('#chat-form button[aria-label="发送"]').click();
  await expect(page.locator(".message.assistant")).toContainText("合成回答");
  expect(request.messages[0].content).toContain("保存后才交给 AI 的新正文");
  let state = await saved(page);
  const conversation = Object.values(state.records).find(record => record.data?.mobileContext?.source?.conversationId === "discussion").data;
  expect(state.records["notes:note-a"].data.content).toBe("保存后才交给 AI 的新正文");
  await page.reload(); await page.locator('nav [data-tab="chat"]').click();
  await page.locator(`[data-action="conversation"][data-id="${conversation.id}"]`).click();
  await expect(control(page, "source")).toBeEnabled(); await expect(control(page, "parent")).toBeEnabled();
  await control(page, "parent").click();
  await expect(page.locator(".conversation-bar")).toContainText("资料讨论");
  await control(page, "source").click();
  await expect(page.locator("#document-reader")).toContainText("保存后才交给 AI 的新正文");
});

test("rewrite shows a review when current and never takes over a later note window", async ({ page }) => {
  await seed(page);
  let delay = false, release, calls = 0;
  await model(page, async () => { calls++; if (delay) await new Promise(resolve => { release = resolve; }); return "# 改写结果\n\n完整合成正文"; });
  await openNote(page); await control(page, "more").click(); await control(page, "rewrite").click();
  await page.locator('#rewrite-form button[type="submit"]').click();
  await expect(page.locator('#sheet [data-action="apply-draft"]')).toBeVisible();
  await page.locator('#sheet [data-action="discard-draft"]').click();
  await expect(control(page, "more")).toBeVisible();
  delay = true;
  await control(page, "more").click(); await control(page, "rewrite").click();
  await page.locator('#rewrite-form button[type="submit"]').click();
  await expect.poll(() => calls).toBe(2);
  await page.locator('#sheet [data-action="close"]').click(); await openNote(page, "note-b");
  release();
  await expect.poll(async () => (await saved(page)).records["notes:note-a"].data.aiDraft?.content).toContain("完整合成正文");
  await expect(page.locator("#sheet h2")).toHaveText("合成资料 B");
  await expect(page.locator("#document-reader")).toHaveText("B 的原文保持不变");
  expect((await saved(page)).records["notes:note-b"].data.aiDraft).toBeUndefined();
});

test("failed durable save keeps the draft open and cannot start a discussion with stale text", async ({ page }) => {
  await seed(page); await openNote(page); await control(page, "edit").click();
  await page.locator('#note-form [name="content"]').fill("合成待保存正文");
  await expect(control(page, "discuss")).toHaveText("保存并讨论");
  await page.evaluate(async () => {
    const { IndexedAdapter } = await import("/src/store.js");
    const write = IndexedAdapter.prototype.write;
    window.failDocumentSave = true;
    IndexedAdapter.prototype.write = function (value) {
      if (window.failDocumentSave && value.records["notes:note-a"].data.content === "合成待保存正文") throw Error("合成保存失败，草稿保留");
      return write.call(this, value);
    };
  });
  await control(page, "discuss").click();
  await expect(page.locator("#document-toolbar-root [role=alert]")).toContainText("合成保存失败");
  await expect(page.locator('#note-form [name="content"]')).toHaveValue("合成待保存正文");
  let state = await saved(page);
  expect(state.records["notes:note-a"].data.content).toBe("中文正文 👩🏽‍💻\n\n第二段资料");
  expect(Object.keys(state.records).filter(key => key.startsWith("conversations:"))).toHaveLength(2);
  await page.evaluate(() => { window.failDocumentSave = false; });
  await control(page, "discuss").click();
  await expect(page.locator("#sheet")).not.toBeVisible();
  state = await saved(page);
  expect(state.records["notes:note-a"].data.content).toBe("合成待保存正文");
  expect(Object.keys(state.records).filter(key => key.startsWith("conversations:"))).toHaveLength(3);
});

test("a removed source remains explicitly unavailable instead of opening a new blank document", async ({ page }) => {
  await seed(page, true);
  await page.locator('nav [data-tab="chat"]').click();
  await page.locator('[data-action="conversation"][data-id="discussion"]').click();
  await expect(control(page, "source")).toHaveText("来源资料不可用");
  await expect(control(page, "source")).toBeDisabled();
  await control(page, "source").evaluate(element => element.click());
  await expect(page.locator("#sheet")).not.toBeVisible();
  expect((await saved(page)).records["notes:note-a"].deleted).toBe(true);
});
