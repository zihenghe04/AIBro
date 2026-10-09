// Isolated browser restore UI. Checkpoints and account identities are synthetic.
import { test, expect } from "@playwright/test";
const APP = "http://127.0.0.1:8899";
test.use({ viewport: { width: 320, height: 760 }, isMobile: true, hasTouch: true,
  locale: "zh-CN", timezoneId: "Asia/Shanghai", serviceWorkers: "block", reducedMotion: "reduce" });
test.setTimeout(60000);

for (const bound of [true, false]) test(`${bound ? "bound" : "unbound"} checkpoint restore retains its queue and gives the correct login boundary`, async ({ page }, info) => {
  const external = [];
  await page.route("**/__checkpoint_fixture", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>synthetic checkpoint</title>" }));
  await page.route("**/*", route => {
    if (new URL(route.request().url()).hostname === "127.0.0.1") return route.fallback();
    external.push(route.request().url()); return route.abort("blockedbyclient");
  });
  await page.goto(APP + "/__checkpoint_fixture");
  const bytes = await page.evaluate(async bound => {
    const { Store, MemoryAdapter, clone } = await import("/src/store.js");
    const { freezeDecisionGroup } = await import("/src/sync-groups.js");
    const { createBackup } = await import("/src/backup.js");
    const store = await new Store(new MemoryAdapter()).load();
    await store.put("conversations", { id: "chat", projectId: null, title: "合成检查点" });
    const plan = { id: "plan", conversationID: "chat", projectID: null, actions: [], status: "pending" };
    await store.put("messages", { id: "message", conversationId: "chat", role: "assistant", content: "合成审阅", pendingPlan: plan });
    await store.tx(state => {
      if (bound) state.binding = { base: "https://sync.example.test", username: "fixture", accountID: "account", deviceID: "old-device" };
      const before = clone(state.records);
      state.records["messages:message"].data.pendingPlan.status = "applied";
      freezeDecisionGroup(state, before, { messageKey: "messages:message", plan, decision: "applied" });
    });
    const hash = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256", value))].map(n => n.toString(16).padStart(2, "0")).join("");
    const archive = await createBackup(store, async () => { throw Error("fixture has no original files"); }, hash);
    return [...archive];
  }, bound);
  if (bound) await page.evaluate(() => sessionStorage.setItem("aibro-web-session:live:sync", JSON.stringify({ base: "https://sync.example.test", token: "synthetic-old-other-account-token" })));
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  await page.locator('header [data-tab="settings"]').click();
  await expect(page.locator("main")).toContainText("保留原账号身份与待处理队列，不包含密码或令牌");
  const chooser = page.waitForEvent("filechooser");
  await page.locator('[data-action="restore"]').click();
  await (await chooser).setFiles({ name: "synthetic-checkpoint.zip", mimeType: "application/zip", buffer: Buffer.from(bytes) });
  await expect(page.locator("#sheet")).toContainText("恢复检查点已载入");
  await expect(page.locator("#sheet")).toContainText("1 组待同步操作");
  if (bound) {
    await expect(page.locator("#sheet")).toContainText("重新登录原同步服务 https://sync.example.test 的原账号 fixture");
    await expect(page.locator('#sync-form [name="server"]')).toHaveValue("https://sync.example.test");
    await expect(page.locator('#sync-form [name="username"]')).toHaveValue("fixture");
  } else {
    await expect(page.locator("#sheet")).toContainText("可首次连接同步服务与账号");
    await expect(page.locator('#sync-form [name="username"]')).toHaveValue("");
  }
  await expect(page.locator('#sync-form [name="password"]')).toHaveValue("");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`${bound ? "bound" : "unbound"}-checkpoint-320.png`) });
  if (bound) {
    expect(await page.evaluate(() => sessionStorage.getItem("aibro-web-session:live:sync"))).toBeNull();
    await page.reload({ waitUntil: "domcontentloaded" });
    expect(await page.evaluate(() => sessionStorage.getItem("aibro-web-session:live:sync"))).toBeNull();
  }
  expect(external).toEqual([]);
});
