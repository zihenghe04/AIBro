// Synthetic, isolated browser acceptance of the real durable group APIs + UI.
import { test, expect } from "@playwright/test";

const APP = "http://127.0.0.1:8899";
test.use({ viewport: { width: 320, height: 760 }, isMobile: true, hasTouch: true,
  locale: "zh-CN", timezoneId: "Asia/Shanghai", serviceWorkers: "block", colorScheme: "dark", reducedMotion: "reduce" });
test.setTimeout(60000);

async function seed(page, ready = true) {
  await page.route("**/__group_fixture", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>synthetic atomic conflict</title>" }));
  await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.fallback() : route.abort("blockedbyclient"));
  // Capture only this synthetic page's actual Store instance, even when Vite
  // appends HMR timestamps to module URLs during parallel source development.
  await page.route("**/src/store.js*", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()) + '\nconst fixtureLoad = Store.prototype.load; Store.prototype.load = async function() { await fixtureLoad.call(this); window.__syntheticGroupStore = this; return this; };\n' });
  });
  await page.goto(APP + "/__group_fixture");
  await page.evaluate(async ready => {
    const { Store, MemoryAdapter, addMessage } = await import("/src/store.js");
    const { createAgentTools, applyPlan } = await import("/src/agent-tools.js");
    const { acknowledgeGroup, refreshGroupHeads } = await import("/src/sync-groups.js");
    const store = await new Store(new MemoryAdapter()).load();
    await store.put("conversations", { id: "groupchat", title: "合成整组对话", projectId: null });
    for (const id of ["one", "two"]) await store.put("tasks", { id, title: `原任务${id}`, status: "todo" });
    const tools = createAgentTools({ store, conversationID: "groupchat" });
    for (const id of ["one", "two"]) await tools.execute("knowledge_read", { kind: "tasks", id });
    const result = await tools.execute("propose_changes", { actions: ["one", "two"].map(id => ({ operation: "update", kind: "tasks", id, changes: { title: `本机任务${id}` } })) });
    if (result.error) throw Error(result.error);
    const plan = tools.pendingPlan();
    await addMessage(store, "groupchat", "assistant", "合成修改待确认", { pendingPlan: plan, status: "completed" });
    // This fixture starts from a synthetic, already synced baseline.
    await store.tx(state => { for (const record of Object.values(state.records)) { record.version = 1; record.remote = structuredClone(record.data); record.dirty = false; } });
    const before = structuredClone(store.state.records);
    await applyPlan(store, plan);
    await store.tx(state => {
      const group = Object.values(state.syncGroups)[0];
      acknowledgeGroup(state, group.groupId, { version: 1, groupId: group.groupId, cursor: 4, status: "conflict", accepted: [], conflicts: [{ entityType: "tasks", entityId: "one", version: 2, deleted: false, data: { id: "one", title: "云端任务one", status: "todo" } }] });
      if (ready) {
        const changes = group.lockKeys.map((key, index) => {
          const data = structuredClone(before[key].data), [entityType, entityId] = key.split(":");
          if (entityType === "tasks") data.title = `云端任务${entityId}`;
          if (entityType === "messages") { data.pendingPlan.status = "invalidated"; data.content = "其他设备已更新这组任务，请重新生成方案。"; }
          return { seq: index + 1, entityType, entityId, version: 2, deleted: false, data };
        });
        refreshGroupHeads(state, { version: 1, cursor: changes.length, changes, hasMore: false });
      }
    });
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("aibro-mobile-v1", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("state");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { const db = request.result, tx = db.transaction("state", "readwrite"); tx.objectStore("state").put(store.state, "workspace"); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
    });
  }, ready);
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
async function openConflicts(page) {
  await page.locator('header [data-tab="settings"]').click();
  await expect(page.locator('[data-action="conflicts"]')).toContainText("1");
  await page.locator('[data-action="conflicts"]').click();
}

test("blocked group has scoped local-only status and one whole-cloud adoption action", async ({ page }, info) => {
  await seed(page);
  await page.locator('.home-recent [data-id="groupchat"]').click();
  await expect(page.locator(".conversation-results")).toContainText("已保存到本机，同步有冲突");
  await openConflicts(page);
  await expect(page.locator('[aria-label="整组同步冲突"]')).toHaveCount(1);
  await expect(page.locator('#sheet [data-action="resolve"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "采用整组云端内容", exact: true })).toHaveCount(1);
  await page.locator(".sync-group-review__record summary").getByText("本机任务one", { exact: true }).click();
  await expect(page.locator(".sync-group-review__record[open]")).toContainText("云端任务one");
  expect(await page.evaluate(() => { const sheet = document.querySelector("#sheet"); return sheet.scrollWidth <= sheet.clientWidth; })).toBe(true);
  await page.screenshot({ path: info.outputPath("group-conflict-dark-320.png") });
  await page.getByRole("button", { name: "采用整组云端内容", exact: true }).click();
  await expect(page.locator("#sheet")).toContainText("没有需要处理的冲突");
  const state = await saved(page);
  expect(Object.keys(state.syncGroups)).toHaveLength(0);
  expect(state.records["tasks:one"].data.title).toBe("云端任务one");
  expect(state.records["tasks:two"].data.title).toBe("云端任务two");
  expect(state.records["tasks:one"].dirty).toBe(false);
  expect(state.records["tasks:two"].dirty).toBe(false);
});

test("a later local edit makes the displayed group review refuse adoption without partial overwrite", async ({ page }) => {
  await seed(page); await openConflicts(page);
  await expect(page.getByRole("button", { name: "采用整组云端内容", exact: true })).toBeVisible();
  await page.evaluate(() => window.__syntheticGroupStore.put("tasks", { ...window.__syntheticGroupStore.get("tasks", "one"), title: "审阅后本机的新编辑" }));
  await page.getByRole("button", { name: "采用整组云端内容", exact: true }).click();
  await expect(page.locator(".sync-group-review__error")).toContainText("已变化");
  const state = await saved(page);
  expect(Object.keys(state.syncGroups)).toHaveLength(1);
  expect(state.records["tasks:one"].data.title).toBe("审阅后本机的新编辑");
  expect(state.records["tasks:two"].data.title).toBe("本机任务two");
});

test("incomplete cloud heads leave the group inspectable with a read action and no premature adoption", async ({ page }) => {
  await seed(page, false); await openConflicts(page);
  await expect(page.locator("#sheet")).toContainText("整组云端内容尚未读取完整");
  await expect(page.getByRole("button", { name: "读取整组云端内容", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "采用整组云端内容", exact: true })).toHaveCount(0);
  await expect(page.locator('#sheet [data-action="resolve"]')).toHaveCount(0);
  expect(Object.keys((await saved(page)).syncGroups)).toHaveLength(1);
});
