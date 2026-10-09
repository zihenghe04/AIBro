// Browser development acceptance with isolated IndexedDB and synthetic records.
// Actual Store/tools/main/Halaska components run; no model, account or device data.
import { test, expect } from "@playwright/test";

const APP = "http://127.0.0.1:8899";
const PROMPT = "明天下午三点打篮球，帮我新建日程";
test.use({ viewport: { width: 320, height: 760 }, isMobile: true, hasTouch: true,
  locale: "zh-CN", timezoneId: "Asia/Shanghai", serviceWorkers: "block", reducedMotion: "reduce" });
test.setTimeout(60000);

async function seed(page, mode = "empty") {
  await page.clock.setFixedTime(new Date("2030-01-01T12:00:00+08:00"));
  await page.route("**/__result_fixture", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>synthetic navigation fixture</title>" }));
  await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.fallback() : route.abort("blockedbyclient"));
  await page.goto(APP + "/__result_fixture");
  await page.evaluate(async mode => {
    const { Store, MemoryAdapter, addMessage } = await import("/src/store.js");
    const { createAgentTools, applyPlan } = await import("/src/agent-tools.js");
    const store = await new Store(new MemoryAdapter()).load();
    for (const [id, title, updatedAt] of [["a", "合成会话 A", 1], ["b", "合成会话 B", 2]])
      await store.put("conversations", { id, title, workspace: "日常", projectId: null, updatedAt });
    if (mode === "plans") {
      for (const cid of ["a", "b"]) {
        await addMessage(store, cid, "user", `属于${cid}的原始草稿`, { id: "legacy-user" });
        const tools = createAgentTools({ store, conversationID: cid });
        const actions = cid === "a" ? [{ operation: "create", kind: "tasks", changes: { title: "不得误建的 A 任务" } }] : [
          { operation: "create", kind: "projects", ref: "p", changes: { name: "合成产出项目", description: "核对真实结果导航" } },
          { operation: "create", kind: "tasks", changes: { title: "合成产出任务", projectRef: "p" } },
          { operation: "create", kind: "agenda", changes: { title: "合成产出日程", projectRef: "p", start: "2030-01-02T15:00:00+08:00", end: "2030-01-02T16:00:00+08:00", timeZone: "Asia/Shanghai" } },
          { operation: "create", kind: "notes", changes: { title: "合成产出笔记", content: "来自 B 的合成正文", projectRef: "p" } },
        ];
        const output = await tools.execute("propose_changes", { actions });
        if (output.error) throw Error(output.error);
        await addMessage(store, cid, "assistant", `属于${cid}的方案正文`, { id: "legacy-assistant", status: "completed", pendingPlan: tools.pendingPlan() });
      }
    }
    if (mode === "removed") {
      await store.put("tasks", { id: "recover-task", title: "合成可恢复任务", status: "todo" });
      const tools = createAgentTools({ store, conversationID: "b" });
      await tools.execute("knowledge_read", { kind: "tasks", id: "recover-task" });
      const output = await tools.execute("propose_changes", { actions: [{ operation: "remove", kind: "tasks", id: "recover-task" }] });
      if (output.error) throw Error(output.error);
      const plan = tools.pendingPlan();
      await addMessage(store, "b", "assistant", "请审阅合成删除", { pendingPlan: plan });
      await applyPlan(store, plan);
    }
    store.state.drafts["chat:b"] = "B 未发送草稿";
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("aibro-mobile-v1", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("state");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { const db = request.result, tx = db.transaction("state", "readwrite"); tx.objectStore("state").put(store.state, "workspace"); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
    });
  }, mode);
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  await expect(page.locator("nav")).toBeVisible();
}
async function saved(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("aibro-mobile-v1", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { const db = request.result, tx = db.transaction("state"); const get = tx.objectStore("state").get("workspace"); get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error); tx.oncomplete = () => db.close(); };
  }));
}
const live = (state, kind) => Object.entries(state.records).filter(([key, record]) => key.startsWith(kind + ":") && !record.deleted).map(([,record]) => record.data);
async function openB(page) {
  await page.locator('.home-recent-section .home-recent-item[data-action="conversation"][data-id="b"]').click();
  await expect(page.locator('main[data-route="chat"]')).toBeVisible();
  await expect(page.locator(".conversation-bar")).toContainText("合成会话 B");
}
async function closeSheet(page) { await page.locator('#sheet .sheet-head [data-action="close"]').click(); }
async function noOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const button of await page.locator(".conversation-results button").all()) {
    const bounds = await button.boundingBox(); expect(bounds.height).toBeGreaterThanOrEqual(44);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
  }
}

test("home natural language agenda becomes an openable real result and survives reopening with its draft", async ({ page }, info) => {
  await seed(page);
  await page.locator("#home-chat-text").fill(PROMPT);
  await page.getByRole("button", { name: "发送新会话", exact: true }).click();
  await page.locator('[data-action="review-plan"]').click();
  await expect(page.locator("#sheet")).toContainText("15:00");
  await page.locator("#apply-plan").click();
  await expect(page.locator('[data-result-state="applied"]')).toContainText("已确认");
  await page.locator("#chat-text").fill("确认后仍然保留的下一条草稿");
  await page.getByRole("button", { name: "打开日程：打篮球", exact: true }).click();
  await expect(page.locator('#event-form [name="title"]')).toHaveValue("打篮球");
  await expect(page.locator('#event-form [name="start"]')).toHaveValue("2030-01-02T15:00");
  const state = await saved(page), event = live(state, "notes").find(n => n.kind === "日程");
  expect(live(state, "notes")).toHaveLength(1);
  await expect(page.locator('#event-form')).toHaveAttribute('data-new', 'false');
  expect(await page.locator('#sheet [data-action="delete-event"]').getAttribute('data-id')).toBe(event.id);
  await closeSheet(page);
  await expect(page.locator("#chat-text")).toHaveValue("确认后仍然保留的下一条草稿");
  await noOverflow(page);
  await page.screenshot({ path: info.outputPath("agenda-result-320.png"), fullPage: true });
  const conversation = live(state, "conversations").find(c => c.title.startsWith("明天"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(`.home-recent-section .home-recent-item[data-action="conversation"][data-id="${conversation.id}"]`).click();
  await expect(page.locator("#chat-text")).toHaveValue("确认后仍然保留的下一条草稿");
  await expect(page.getByRole("button", { name: "打开日程：打篮球", exact: true })).toBeVisible();
});

test("duplicate legacy message IDs stay scoped while project/task/agenda/note receipts open their actual records", async ({ page }, info) => {
  await seed(page, "plans"); await openB(page);
  await page.locator('[data-action="reuse-message"]').click();
  await expect(page.locator("#chat-text")).toHaveValue("属于b的原始草稿");
  await page.locator('[data-action="review-plan"]').click();
  await expect(page.locator("#sheet")).toContainText("合成产出项目");
  await expect(page.locator("#sheet")).not.toContainText("不得误建的 A 任务");
  await page.locator("#apply-plan").click();
  await expect(page.locator('[data-result-state="applied"]')).toContainText("4 项操作");
  const state = await saved(page), project = live(state, "projects")[0];
  expect(live(state, "tasks").map(t => t.title)).toEqual(["合成产出任务"]);
  expect(live(state, "messages").find(m => m.conversationId === "a" && m.role === "assistant").pendingPlan.status).toBe("pending");
  await page.locator("#chat-text").fill("多项确认后的草稿");
  await page.getByRole("button", { name: "打开项目：合成产出项目", exact: true }).click();
  await expect(page.locator("#sheet")).toContainText("项目日程");
  await expect(page.locator("#sheet")).toContainText("合成产出日程");
  await page.locator('#sheet [data-action="project-chat"]').click();
  await page.locator('nav [data-tab="knowledge"]').click();
  await page.locator('[data-action="knowledge-mode"][data-mode="projects"]').click();
  await page.locator(`[data-action="project"][data-id="${project.id}"]`).click();
  await expect(page.locator('#sheet [data-action="conversation"]')).toHaveCount(1);
  const projectChatID = await page.locator('#sheet [data-action="conversation"]').getAttribute("data-id");
  await page.locator('#sheet [data-action="conversation"]').click();
  await expect(page.locator("#sheet")).not.toBeVisible();
  await expect(page.locator(".context-count")).toHaveText("项目知识");
  expect(live(await saved(page), "conversations").find(c => c.id === projectChatID).projectId).toBe(project.id);
  await page.locator('[data-action="all-chats"]').click();
  await page.locator('[data-action="conversation"][data-id="b"]').click();
  await expect(page.locator("#chat-text")).toHaveValue("多项确认后的草稿");
  await noOverflow(page);
  await page.locator(".conversation-results").evaluate(el => el.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: info.outputPath("multiple-results-project-task-320.png") });
  await page.getByRole("button", { name: "打开日程：合成产出日程", exact: true }).evaluate(el => el.closest('.conversation-results__item').scrollIntoView({ block: "start" }));
  await page.screenshot({ path: info.outputPath("multiple-results-agenda-note-320.png") });
  await page.getByRole("button", { name: "打开任务：合成产出任务", exact: true }).click();
  await expect(page.locator('#task-form [name="title"]')).toHaveValue("合成产出任务"); await closeSheet(page);
  await page.getByRole("button", { name: "打开日程：合成产出日程", exact: true }).click();
  await expect(page.locator('#event-form [name="start"]')).toHaveValue("2030-01-02T15:00"); await closeSheet(page);
  await page.getByRole("button", { name: "打开笔记：合成产出笔记", exact: true }).click();
  await expect(page.locator("#sheet .reader")).toHaveText("来自 B 的合成正文"); await closeSheet(page);
  await page.locator('[data-action="save-message"]').click();
  await expect(page.locator("#sheet .reader")).toContainText("属于b的方案正文");
  await expect(page.locator("#sheet .reader")).not.toContainText("属于a的方案正文");
  await closeSheet(page);
  await page.getByRole("button", { name: "打开任务：合成产出任务", exact: true }).click();
  await page.locator('#sheet [data-action="remove-record"]').click();
  await page.locator('#sheet [data-action="confirm-removal"]').click();
  await expect(page.getByRole("button", { name: "打开任务：合成产出任务", exact: true })).toHaveCount(0);
  await expect(page.locator(".conversation-results")).toContainText("这条内容已删除或尚未同步到此设备");
  await expect(page.locator("#task-form")).toHaveCount(0);
});

test("a removed result opens only recovery review and never restores without confirmation", async ({ page }, info) => {
  await seed(page, "removed"); await openB(page);
  await expect(page.locator(".conversation-results")).toContainText("已移入回收站");
  await expect(page.locator(".conversation-results")).not.toContainText("打开任务");
  await page.getByRole("button", { name: "审阅恢复：合成可恢复任务", exact: true }).click();
  await expect(page.locator("#sheet")).toContainText("确认恢复");
  expect(live(await saved(page), "tasks")).toHaveLength(0);
  await page.screenshot({ path: info.outputPath("recovery-review-320.png"), fullPage: true });
  await closeSheet(page);
  expect(live(await saved(page), "tasks")).toHaveLength(0);
  await expect(page.locator("#chat-text")).toHaveValue("B 未发送草稿");
});

async function holdNextTransaction(page) {
  await page.evaluate(async () => {
    const { Store } = await import("/src/store.js"), original = Store.prototype.tx;
    let first = true;
    Store.prototype.tx = function(fn) {
      if (!first) return original.call(this, fn);
      first = false; window.__navigationTransactionHeld = true;
      return new Promise(resolve => { window.__releaseNavigationTransaction = resolve; }).then(() => original.call(this, fn));
    };
  });
}
for (const destination of ["conversation", "home-draft"]) test(`home async submission keeps its own identity after switching ${destination}`, async ({ page }) => {
  await seed(page);
  await page.locator("#home-chat-text").fill(PROMPT);
  await expect.poll(async () => (await saved(page)).drafts["home:new"]).toBe(PROMPT);
  await holdNextTransaction(page);
  await page.getByRole("button", { name: "发送新会话", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__navigationTransactionHeld)).toBe(true);
  if (destination === "conversation") { await openB(page); await page.locator("#chat-text").fill("B 后来的独立草稿"); }
  else await page.locator("#home-chat-text").fill("首页后来输入的新草稿");
  await page.evaluate(() => window.__releaseNavigationTransaction());
  await expect.poll(async () => live(await saved(page), "messages").filter(m => m.role === "assistant").length).toBe(1);
  const state = await saved(page), message = live(state, "messages").find(m => m.role === "user");
  expect(message.content).toBe(PROMPT); expect(message.conversationId).not.toBe("b");
  expect(live(state, "messages").filter(m => m.conversationId === "b")).toHaveLength(0);
  if (destination === "conversation") {
    await expect(page.locator(".conversation-bar")).toContainText("合成会话 B");
    await expect(page.locator("#chat-text")).toHaveValue("B 后来的独立草稿");
    expect(state.drafts["chat:b"]).toBe("B 后来的独立草稿");
  } else {
    await expect(page.locator('main[data-route="today"]')).toBeVisible();
    await expect(page.locator("#home-chat-text")).toHaveValue("首页后来输入的新草稿");
    expect(state.drafts["home:new"]).toBe("首页后来输入的新草稿");
  }
});
