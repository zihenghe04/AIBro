// Browser development acceptance of the real app entry point. Every test owns
// an empty browser context and synthetic data; no native/real account is used.
import { test, expect } from "@playwright/test";

const APP = "http://127.0.0.1:8899";
const SERVICE = "https://sync-fixture.invalid";
const homeDraft = "同步状态变化时，这段尚未发送的手机草稿必须保留。";

test.use({ viewport: { width: 320, height: 720 }, isMobile: true, hasTouch: true,
  locale: "zh-CN", timezoneId: "Asia/Shanghai", serviceWorkers: "block" });
test.setTimeout(45000);

async function savedState(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open("aibro-mobile-v1", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction("state");
      const get = tx.objectStore("state").get("workspace");
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
      tx.oncomplete = () => db.close();
    };
  }));
}

async function instrument(page, fixture) {
  const evidence = { external: [], errors: [], console: [], csp: [] };
  page.on("pageerror", error => evidence.errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") evidence.console.push({ text: message.text(), url: message.location().url });
  });
  await page.addInitScript(() => {
    window.integrationCSPViolations = [];
    document.addEventListener("securitypolicyviolation", event => integrationCSPViolations.push({
      directive: event.violatedDirective, blocked: event.blockedURI,
    }));
  });
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === APP || url.protocol === "data:" || url.protocol === "blob:") return route.fallback();
    if (fixture && url.origin === SERVICE) return fixture.handle(route);
    evidence.external.push(url.href);
    return route.abort("blockedbyclient");
  });
  return evidence;
}

async function verifyEvidence(page, evidence, expected401s = 0) {
  expect(await page.evaluate(() => integrationCSPViolations)).toEqual([]);
  expect(evidence.external).toEqual([]);
  expect(evidence.errors).toEqual([]);
  const expected = evidence.console.filter(entry => entry.url.startsWith(SERVICE) && /401/.test(entry.text));
  expect(expected).toHaveLength(expected401s);
  expect(evidence.console.filter(entry => !expected.includes(entry))).toEqual([]);
  const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  expect(layout.scroll, JSON.stringify(layout)).toBeLessThanOrEqual(layout.width);
}

const headerButton = page => page.locator("#sync-status-root[data-halaska-root] button");
const fullPanel = page => page.locator("#sync-detail-root[data-halaska-root]");

async function openSettingsThroughSync(page) {
  await headerButton(page).click();
  await expect(fullPanel(page)).toBeVisible();
  await page.locator("#sync-detail-root").getByRole("button", { name: "打开同步设置", exact: true }).click();
  await expect(page.locator("#sheet")).not.toBeVisible();
  await expect(page.locator("main")).toHaveAttribute("data-route", "settings");
  await expect(page.locator("#sync-form")).toBeVisible();
}

async function saveCapture(page, content) {
  await page.locator('nav [data-tab="captures"]').click();
  await page.locator('[data-action="new-capture"]').click();
  await page.locator('#capture-form [name="content"]').fill(content);
  await page.getByRole("button", { name: "保存随记", exact: true }).click();
  await expect(page.locator("#sheet")).not.toBeVisible();
  await expect(page.locator(".capture-card")).toContainText([content]);
}

function fakeSyncService() {
  const calls = [], records = new Map();
  let cursor = 0, tokenNumber = 0, expired = false, pendingGate;
  return {
    calls, records,
    expire() { expired = true; },
    holdPush() {
      let release;
      const promise = new Promise(resolve => { release = resolve; });
      pendingGate = promise;
      return release;
    },
    async handle(route) {
      const request = route.request(), url = new URL(request.url());
      const method = request.method(), path = url.pathname;
      const body = request.postData() ? request.postDataJSON() : null;
      calls.push({ path, method, operations: body?.operations });
      const reply = (data, status = 200) => route.fulfill({ status,
        headers: { "access-control-allow-origin": APP, "access-control-allow-headers": "content-type,authorization", "access-control-allow-methods": "GET,POST,OPTIONS" },
        contentType: "application/json", body: JSON.stringify(data) });
      if (method === "OPTIONS") return reply({});
      if (path === "/v1/auth/login") {
        expect(body).toMatchObject({ username: "sync-ui-fixture", password: "synthetic-password-only" });
        expired = false;
        return reply({ accessToken: `synthetic-session-${++tokenNumber}`, account: { id: "fixture-account", username: "sync-ui-fixture" }, device: { id: "fixture-device" } });
      }
      expect(request.headers().authorization).toBe(`Bearer synthetic-session-${tokenNumber}`);
      if (expired) return reply({ code: "unauthorized" }, 401);
      if (path === "/v1/sync/push") {
        if (pendingGate) { const gate = pendingGate; pendingGate = null; await gate; }
        const accepted = body.operations.map(op => {
          const key = `${op.entityType}:${op.entityId}`;
          const previous = records.get(key);
          // Support immutable operation replay as the real protocol does.
          if (previous?.opId === op.opId) return previous.ack;
          const ack = { opId: op.opId, entityType: op.entityType, entityId: op.entityId, version: (previous?.ack.version || 0) + 1 };
          records.set(key, { opId: op.opId, data: op.data, deleted: op.deleted, ack }); cursor++;
          return ack;
        });
        return reply({ accepted, conflicts: [] });
      }
      if (path === "/v1/sync/pull") return reply({ changes: [], cursor, hasMore: false });
      if (path === "/v1/auth/logout") return reply({ ok: true });
      throw Error(`Unexpected synthetic sync request: ${method} ${path}`);
    },
  };
}

test("real 320px home mounts offline Kit under app CSP and retains drafts through sync sheet/settings/routes", async ({ page, context }, info) => {
  const evidence = await instrument(page);
  await page.goto(APP);
  await expect(headerButton(page)).toHaveText("本机");
  await expect.poll(() => page.evaluate(() => document.fonts.check('14px "AI Bro Mobile Geist"'))).toBe(true);
  await expect(page.locator("main")).toHaveAttribute("data-route", "today");
  expect(await page.locator('#sync-status-root button').evaluate(element => element.getBoundingClientRect().height)).toBe(44);
  await page.locator("#home-chat-text").fill(homeDraft);
  await page.evaluate(() => { window.savedHomeNode = document.querySelector("#home-chat-text"); window.savedHeaderNode = document.querySelector("#sync-status-root button"); });
  await context.setOffline(true);
  await expect(headerButton(page)).toHaveText("本机");
  expect(await page.evaluate(() => savedHomeNode === document.querySelector("#home-chat-text") && savedHeaderNode === document.querySelector("#sync-status-root button"))).toBe(true);
  await expect(page.locator("#home-chat-text")).toBeFocused();
  await expect.poll(async () => (await savedState(page)).drafts["home:new"]).toBe(homeDraft);
  await headerButton(page).click();
  await expect(fullPanel(page)).toBeVisible();
  await expect(fullPanel(page).getByRole("button", { name: "立即同步", exact: true })).toBeDisabled();
  await page.locator('#sheet [data-action="close"]').click();
  await expect(page.locator("#home-chat-text")).toHaveValue(homeDraft);
  await expect(fullPanel(page)).toHaveCount(0);
  await openSettingsThroughSync(page);
  await expect(headerButton(page)).toHaveText("本机");
  await page.locator('nav [data-tab="today"]').click();
  await expect(page.locator("#home-chat-text")).toHaveValue(homeDraft);
  await saveCapture(page, "本机离线随记：同步入口不得覆盖这份内容。");
  await page.locator('nav [data-tab="today"]').click();
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.screenshot({ path: info.outputPath("home-offline-dark-320.png"), fullPage: true, animations: "disabled" });
  await headerButton(page).click();
  await page.screenshot({ path: info.outputPath("sync-sheet-offline-dark-320.png"), animations: "disabled" });
  await expect(fullPanel(page)).toContainText("1 项本机修改等待同步");
  await page.locator('#sheet [data-action="close"]').click();
  await context.setOffline(false);
  await page.reload();
  await expect(page.locator("#home-chat-text")).toHaveValue(homeDraft);
  await page.locator('nav [data-tab="captures"]').click();
  await expect(page.locator(".capture-card")).toContainText("本机离线随记");
  await expect(headerButton(page)).toHaveText("本机");
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('14px "AI Bro Mobile Geist"'))).toBe(true);
  expect(await page.evaluate(() => performance.getEntriesByType("resource").some(entry => /halaska-ui/.test(entry.name)))).toBe(true);
  await verifyEvidence(page, evidence);
});

test("real app login automatically pushes, preserves focused input, pauses after 401 and reconnects through UI", async ({ page }, info) => {
  const fixture = fakeSyncService();
  const evidence = await instrument(page, fixture);
  // Install before app startup so every scheduler timer is controlled, while
  // the initial debounce still runs at the normal browser clock speed.
  await page.clock.install();
  await page.goto(APP);
  await page.locator("#home-chat-text").fill(homeDraft);
  await openSettingsThroughSync(page);
  await page.locator('#sync-form [name="server"]').fill(SERVICE);
  await page.locator('#sync-form [name="username"]').fill("sync-ui-fixture");
  await page.locator('#sync-form [name="password"]').fill("synthetic-password-only");
  await page.locator('#sync-form [name="merge"]').check();
  await page.locator('#sync-form button[type="submit"]').click();
  await expect(headerButton(page)).toHaveText("已同步");
  expect(fixture.calls.filter(call => call.path === "/v1/auth/login")).toHaveLength(1);
  const release = fixture.holdPush();
  await saveCapture(page, "自动上传的合成随记");
  await expect.poll(() => fixture.calls.filter(call => call.path === "/v1/sync/push").length).toBe(1);
  await expect(headerButton(page)).toHaveText("同步中");
  await page.locator('nav [data-tab="today"]').click();
  await page.locator("#home-chat-text").fill(homeDraft + "继续输入。");
  await page.evaluate(() => { window.liveHomeNode = document.querySelector("#home-chat-text"); window.liveHeaderNode = document.querySelector("#sync-status-root button"); liveHomeNode.setSelectionRange(2, 5); });
  release();
  await expect(headerButton(page)).toHaveText("已同步");
  await expect(page.locator("#home-chat-text")).toBeFocused();
  await expect(page.locator("#home-chat-text")).toHaveValue(homeDraft + "继续输入。");
  expect(await page.evaluate(() => ({ home: liveHomeNode === document.querySelector("#home-chat-text"), header: liveHeaderNode === document.querySelector("#sync-status-root button"), selection: [liveHomeNode.selectionStart, liveHomeNode.selectionEnd] }))).toEqual({ home: true, header: true, selection: [2, 5] });
  expect([...fixture.records.values()].map(record => record.data.content)).toContain("自动上传的合成随记");
  await expect.poll(async () => Object.values((await savedState(page)).records).filter(record => record.dirty).length).toBe(0);

  fixture.expire();
  await saveCapture(page, "登录失效后仍保留的合成随记");
  await expect(headerButton(page)).toHaveText("同步异常");
  await headerButton(page).click();
  await expect(fullPanel(page)).toContainText("登录已失效");
  await expect(fullPanel(page).getByRole("button", { name: "立即同步", exact: true })).toBeDisabled();
  await expect(fullPanel(page).getByRole("alert")).toContainText("重新连接");
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.screenshot({ path: info.outputPath("sync-auth-expired-dark-320.png"), animations: "disabled" });
  const callsAfter401 = fixture.calls.length;
  // Advance only after the initial real browser timers exercised the debounce;
  // both a retry deadline and two idle polls must leave the expired token alone.
  await page.clock.fastForward(125000);
  expect(fixture.calls).toHaveLength(callsAfter401);
  const unsynced = Object.values((await savedState(page)).records).filter(record => record.dirty);
  expect(unsynced).toHaveLength(1);
  expect(unsynced[0].data.content).toBe("登录失效后仍保留的合成随记");
  await page.locator("#sync-detail-root").getByRole("button", { name: "打开同步设置", exact: true }).click();
  await expect(page.locator("#sync-form")).toBeVisible();
  await page.locator('#sync-form [name="password"]').fill("synthetic-password-only");
  await page.locator('#sync-form [name="merge"]').check();
  await page.locator('#sync-form button[type="submit"]').click();
  await expect(headerButton(page)).toHaveText("已同步");
  expect(fixture.calls.filter(call => call.path === "/v1/auth/login")).toHaveLength(2);
  expect([...fixture.records.values()].map(record => record.data.content)).toContain("登录失效后仍保留的合成随记");
  await expect.poll(async () => Object.values((await savedState(page)).records).filter(record => record.dirty).length).toBe(0);
  await page.locator('nav [data-tab="today"]').click();
  await expect(page.locator("#home-chat-text")).toHaveValue(homeDraft + "继续输入。");
  await verifyEvidence(page, evidence, 1);
});

for (const width of [320, 360]) test(`real header keeps Chinese short status visible at ${width}px with bundled and system fonts`, async ({ page }, info) => {
  const evidence = await instrument(page);
  await page.setViewportSize({ width, height: 720 });
  await page.goto(APP);
  await expect(headerButton(page)).toHaveText("本机");
  await page.evaluate(() => { window.originalHeaderButton = document.querySelector("#sync-status-root button"); });
  for (const font of ["bundled", "system"]) {
    await page.evaluate(font => {
      const root = document.querySelector("#sync-status-root");
      if (font === "system") root.style.setProperty("font-family", 'system-ui, "PingFang SC", sans-serif', "important");
    }, font);
    for (const [state, title, pendingCount, conflictCount] of [
      ["synced", "已同步", 0, 0], ["auth-expired", "同步异常", 0, 0], ["error", "同步异常", 0, 0],
      ["pending", "待同步 99+", 123456789, 0], ["conflict", "需合并 99+", 0, 123456789],
      ["syncing", "同步中", 0, 0], ["offline", "本机", 0, 0],
    ]) {
      // Layout-only props on the real main.js-owned island; this does not claim
      // a network transition or invoke a synthetic business operation.
      await page.evaluate(props => HalaskaUI.update(document.querySelector("#sync-status-root"), {
        ...props, connected: true, online: true,
      }), { state, pendingCount, conflictCount });
      await expect(headerButton(page)).toHaveText(title);
      await page.evaluate(() => document.fonts.ready);
      const geometry = await page.evaluate(() => {
        const title = document.querySelector(".mobile-sync-status__short-title");
        const button = document.querySelector("#sync-status-root button");
        const settings = document.querySelector("header .icon-button").getBoundingClientRect();
        return { title: title.textContent, scroll: title.scrollWidth, client: title.clientWidth,
          buttonRight: button.getBoundingClientRect().right, settingsLeft: settings.left,
          sameButton: button === originalHeaderButton, pageWidth: document.documentElement.scrollWidth };
      });
      expect(geometry.scroll, `${font}/${state}: ${JSON.stringify(geometry)}`).toBeLessThanOrEqual(geometry.client);
      expect(geometry.buttonRight).toBeLessThanOrEqual(geometry.settingsLeft);
      expect(geometry.pageWidth).toBe(width);
      expect(geometry.sameButton).toBe(true);
      if (pendingCount || conflictCount) await expect(headerButton(page)).toHaveAttribute("aria-label", /123456789/);
      if (font === "system" && state === "auth-expired") await page.screenshot({ path: info.outputPath(`header-system-${width}.png`), animations: "disabled" });
    }
  }
  await verifyEvidence(page, evidence);
});
