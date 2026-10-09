import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";

const APP = "http://127.0.0.1:8899";
test.use({ viewport: { width: 320, height: 720 }, locale: "zh-CN", timezoneId: "Asia/Shanghai", serviceWorkers: "block" });

async function fixture(page) {
  const external = [], errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (new URL(request.url()).origin !== APP) external.push(request.url()); });
  await page.route("**/__sync_component_fixture", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'"><title>Isolated sync component</title></head><body><main style="padding:16px"><form id="other-form"><textarea id="draft" aria-label="未发送草稿">不应丢失的草稿</textarea><div id="owned-sync-root"></div></form></main></body></html>` }));
  await page.route("https://**/*", route => route.abort());
  await page.goto(APP + "/__sync_component_fixture");
  const timing = await page.evaluate(async () => {
    await import("/src/style.css");
    const { mountSyncStatus } = await import("/src/ui/sync-status.js");
    window.mountSyncStatus = mountSyncStatus;
    window.calls = { sync: 0, conflicts: 0, settings: 0, submits: 0 };
    document.querySelector("#other-form").addEventListener("submit", event => { event.preventDefault(); calls.submits++; });
    const start = performance.now();
    window.statusIsland = await mountSyncStatus(document.querySelector("#owned-sync-root"), {
      state: "pending", pending: 2, conflicts: 0, connected: true, online: true,
      onSync: () => { calls.sync++; }, onConflicts: () => { calls.conflicts++; }, onSettings: () => { calls.settings++; },
    });
    const mountMs = performance.now() - start;
    await document.fonts.ready;
    return { mountMs, fontReady: document.fonts.check('14px "AI Bro Mobile Geist"'), resources: performance.getEntriesByType("resource")
      .filter(entry => /halaska-ui|woff2/.test(entry.name)).map(({ name, duration, transferSize, decodedBodySize }) => ({ name, duration, transferSize, decodedBodySize })) };
  });
  return { timing, external, errors };
}

test("actual offline Halaska controls retain draft focus across state updates and execute each real callback once", async ({ page }, info) => {
  const evidence = await fixture(page);
  await expect(page.locator('[data-halaska-root="MobileSyncStatus"]')).toBeVisible();
  await expect(page.getByRole("status")).toContainText("2 项待推送");
  await page.getByRole("button", { name: "立即同步", exact: true }).click();
  await page.getByRole("button", { name: "打开同步设置", exact: true }).click();
  await page.locator("#draft").focus();
  await page.evaluate(() => {
    window.sameSyncButton = document.querySelector('[aria-label="立即同步"]');
    statusIsland.update({ state: "syncing", pending: 2 });
  });
  await expect(page.getByRole("button", { name: "立即同步", exact: true })).toBeDisabled();
  await expect(page.locator("#draft")).toBeFocused();
  await page.evaluate(() => statusIsland.update({ state: "synced", pending: 0, lastSync: Date.parse("2030-02-01T15:00:00+08:00") }));
  expect(await page.evaluate(() => sameSyncButton === document.querySelector('[aria-label="立即同步"]'))).toBe(true);
  await expect(page.getByRole("status")).toContainText("已同步");
  await expect(page.getByRole("status")).toContainText("2/1 15:00");
  await expect(page.locator("#draft")).toHaveValue("不应丢失的草稿");
  await page.evaluate(() => statusIsland.update({ state: "conflict", conflicts: 2 }));
  await page.getByRole("button", { name: "查看冲突", exact: true }).click();
  expect(await page.evaluate(() => calls)).toEqual({ sync: 1, conflicts: 1, settings: 1, submits: 0 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.screenshot({ path: info.outputPath("sync-conflict-light-320.png") });
  const timingPath = info.outputPath("offline-load.json");
  await writeFile(timingPath, JSON.stringify(evidence.timing, null, 2));
  await info.attach("offline-load.json", { path: timingPath, contentType: "application/json" });
  expect(evidence.timing.fontReady).toBe(true);
  expect(evidence.timing.resources.some(item => /halaska-ui/.test(item.name))).toBe(true);
  expect(evidence.external).toEqual([]);
  expect(evidence.errors).toEqual([]);
});

test("dark reduced-motion layout reports real failures, auth expiry and safe owned-root cleanup", async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  const evidence = await fixture(page);
  await page.evaluate(() => statusIsland.update({ state: "error", error: "合成连接失败：" + "长服务描述".repeat(24), onSync: async () => { throw Error("合成重试失败，原内容已保留"); } }));
  await page.getByRole("button", { name: "立即同步", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("合成重试失败");
  await page.evaluate(() => statusIsland.update({ state: "auth-expired", error: "", pending: 2 }));
  await expect(page.getByRole("status")).toContainText("登录已失效");
  await expect(page.getByRole("button", { name: "立即同步", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => ({
    text: getComputedStyle(document.querySelector(".mobile-sync-status__copy strong")).color,
    transition: getComputedStyle(document.querySelector('[aria-label="打开同步设置"]')).transitionDuration,
    scroll: document.documentElement.scrollWidth,
  }))).toEqual({ text: "rgb(228, 238, 233)", transition: "0s", scroll: 320 });
  await page.screenshot({ path: info.outputPath("sync-auth-dark-320.png") });
  const lifecycle = await page.evaluate(async () => {
    const draft = document.querySelector("#draft");
    const occupied = document.createElement("div"); occupied.textContent = "真实编辑内容"; document.body.append(occupied);
    let rejected = false; try { await mountSyncStatus(occupied, {}); } catch { rejected = true; }
    statusIsland.unmount();
    return { rejected, preserved: occupied.textContent, rootEmpty: document.querySelector("#owned-sync-root").childNodes.length === 0,
      updateAfterClose: statusIsland.update({ state: "synced" }), draft: draft.value };
  });
  expect(lifecycle).toEqual({ rejected: true, preserved: "真实编辑内容", rootEmpty: true, updateAfterClose: false, draft: "不应丢失的草稿" });
  expect(evidence.external).toEqual([]);
  expect(evidence.errors).toEqual([]);
});

test("compact header is one real 44px Kit button whose node survives every state update", async ({ page }) => {
  const evidence = await fixture(page);
  await page.evaluate(async () => {
    statusIsland.unmount();
    const root = document.querySelector("#owned-sync-root"); root.style.width = "132px";
    window.opens = 0;
    window.statusIsland = await mountSyncStatus(root, { compact: true, state: "offline", connected: false, onOpen: () => { opens++; } });
    window.compactButton = root.querySelector("button");
  });
  const button = page.locator(".mobile-sync-status--compact button");
  await expect(button).toHaveText("本机");
  await button.click();
  for (const [state, title, pending, conflicts] of [
    ["pending", "待同步 12", 12, 0], ["syncing", "同步中", 12, 0], ["synced", "已同步", 0, 0],
    ["conflict", "需合并 3", 0, 3], ["auth-expired", "同步异常", 0, 0], ["error", "同步异常", 0, 0],
  ]) {
    await page.evaluate(({ state, pending, conflicts }) => statusIsland.update({ state, pending, conflicts, connected: true, error: "不应在页头显示的长错误文本" }), { state, pending, conflicts });
    await expect(button).toHaveText(title);
    expect(await page.evaluate(() => compactButton === document.querySelector(".mobile-sync-status--compact button"))).toBe(true);
  }
  expect(await page.locator("#owned-sync-root button").count()).toBe(1);
  expect(await page.locator("#owned-sync-root p, #owned-sync-root [role=alert]").count()).toBe(0);
  expect(await button.getAttribute("aria-label")).toContain("本机内容已保留");
  expect(await button.evaluate(element => element.getBoundingClientRect().height)).toBe(44);
  expect(await page.evaluate(() => ({ opens, width: document.documentElement.scrollWidth }))).toEqual({ opens: 1, width: 320 });
  expect(evidence.external).toEqual([]);
  expect(evidence.errors).toEqual([]);
});
