import { test, expect } from "@playwright/test";

const APP = "http://127.0.0.1:8899";
test.use({ viewport: { width: 320, height: 760 }, locale: "zh-CN", serviceWorkers: "block" });
async function mount(page, props = {}) {
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.route("**/__document_toolbar_044", route => route.fulfill({ contentType: "text/html; charset=utf-8", body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Document controls fixture</title><div style="padding:22px"><div id="toolbar"></div><textarea id="body" aria-label="正文" style="display:block;width:100%;height:160px;margin:20px 0">中文正文与 emoji 👩🏽‍💻</textarea><div id="savebar"></div><div id="origin"></div><button id="outside">外部操作</button></div>` }));
  await page.route("**/*", route => new URL(route.request().url()).hostname === "127.0.0.1" ? route.fallback() : route.abort());
  await page.goto(`${APP}/__document_toolbar_044`);
  await page.evaluate(async props => {
    await import("/src/style.css");
    const { mountDocumentToolbar, mountDocumentSaveBar, mountDocumentOrigin } = await import("/src/ui/document-toolbar.js");
    window.calls = [];
    const action = name => (...args) => window.calls.push([name, ...args]);
    window.toolbar = await mountDocumentToolbar(document.getElementById("toolbar"), {
      mode: "read", onMode: action("mode"), onDiscuss: action("discuss"), onRewrite: action("rewrite"),
      onReviewDraft: action("review-draft"), onSchedule: action("schedule"), onExport: action("export"), onTrash: action("trash"), onFormat: action("format"), ...props,
    });
    window.savebar = await mountDocumentSaveBar(document.getElementById("savebar"), { status: "草稿已保存在本机", onSave: action("save") });
    window.origin = await mountDocumentOrigin(document.getElementById("origin"), { title: "很长的中文来源资料标题与 emoji 👩🏽‍💻，需要截断且保留完整辅助名称", hasParentConversation: true, onSource: action("source"), onParent: action("parent") });
  }, props).catch(error => { throw Error(`${error.message}\n${pageErrors.join("\n")}`); });
}
const control = (page, name) => page.locator(`[data-document-control="${name}"]`);

test("mode is controlled; menu actions execute once and conditional draft action stays hidden", async ({ page }) => {
  await mount(page);
  await expect(control(page, "read")).toHaveAttribute("aria-pressed", "true");
  await control(page, "edit").click();
  expect(await page.evaluate(() => window.calls)).toEqual([["mode", "edit"]]);
  await expect(control(page, "read")).toHaveAttribute("aria-pressed", "true");
  await control(page, "more").click();
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(control(page, "review-draft")).toHaveCount(0);
  await expect(page.getByRole("menuitem").last()).toHaveAttribute("data-document-control", "trash");
  await control(page, "export").click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect(await page.evaluate(() => window.calls)).toEqual([["mode", "edit"], ["export"]]);
  expect(await page.locator("#toolbar [data-action]").count()).toBe(0);
});

test("menu keyboard and outside close preserve focus without covering the document", async ({ page }) => {
  await mount(page, { hasAIDraft: true });
  await control(page, "more").click();
  await expect(control(page, "rewrite")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(control(page, "review-draft")).toBeFocused();
  await page.keyboard.press("End");
  await expect(control(page, "trash")).toBeFocused();
  const bounds = await page.evaluate(() => ({ menu: document.querySelector('[role="menu"]').getBoundingClientRect().bottom, body: document.getElementById("body").getBoundingClientRect().top }));
  expect(bounds.menu).toBeLessThanOrEqual(bounds.body);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(control(page, "more")).toBeFocused();
  await control(page, "more").click();
  await page.locator("#body").click();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await control(page, "more").click();
  await page.evaluate(() => window.toolbar.unmount());
  await page.locator("#outside").focus();
  await page.keyboard.press("Escape");
  await expect(page.locator("#outside")).toBeFocused();
});

test("format strip preserves pointer selection and 320px dark layout; conflicts leave modes usable", async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await mount(page, { mode: "edit", hasUnsavedDraft: true });
  await expect(control(page, "discuss")).toHaveText("保存并讨论");
  await page.locator("#body").evaluate(element => { element.focus(); element.setSelectionRange(0, 4); });
  await control(page, "format-bold").click();
  await expect(page.locator("#body")).toBeFocused();
  expect(await page.locator("#body").evaluate(element => [element.selectionStart, element.selectionEnd])).toEqual([0, 4]);
  expect(await page.evaluate(() => window.calls)).toEqual([["format", "bold"]]);
  expect(await control(page, "format-bold").evaluate(element => element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerType: "touch", button: 0 })))).toBe(true);
  const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth,
    targets: [...document.querySelectorAll('[data-document-control]')].map(button => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })),
    originOverflow: document.getElementById("origin").scrollWidth > document.getElementById("origin").clientWidth,
    stripScrolls: document.querySelector('.document-toolbar__formats').scrollWidth > document.querySelector('.document-toolbar__formats').clientWidth }));
  expect(layout.overflow).toBe(false); expect(layout.originOverflow).toBe(false); expect(layout.stripScrolls).toBe(true);
  expect(layout.targets.every(target => target.width >= 44 && target.height >= 44)).toBe(true);
  await page.screenshot({ path: info.outputPath("document-toolbar-dark-320.png"), animations: "disabled" });
  await page.evaluate(() => window.toolbar.update({ disabled: true }));
  await expect(control(page, "format-bold")).toBeDisabled();
  await expect(control(page, "discuss")).toBeDisabled();
  await expect(control(page, "read")).toBeEnabled();
  await control(page, "more").click();
  await expect(control(page, "rewrite")).toHaveText("保存并改写");
  await expect(control(page, "rewrite")).toBeDisabled();
  await expect(control(page, "export")).toBeEnabled();
});

test("save awaits the owner's promise and unavailable origin never navigates", async ({ page }) => {
  await mount(page);
  await page.evaluate(() => window.savebar.update({ onSave: () => new Promise(resolve => { window.calls.push(["save"]); window.finishSave = resolve; }) }));
  await control(page, "save").click();
  await expect(control(page, "save")).toBeDisabled();
  await expect(control(page, "save")).toHaveAccessibleName("正在保存文档");
  await control(page, "save").evaluate(element => element.click());
  expect(await page.evaluate(() => window.calls)).toEqual([["save"]]);
  await page.evaluate(() => window.finishSave());
  await expect(control(page, "save")).toBeEnabled();
  await expect(page.locator("[data-document-status]")).not.toHaveAttribute("aria-live", /.+/);
  await page.evaluate(() => window.origin.update({ unavailable: true }));
  await expect(control(page, "source")).toHaveText("来源资料不可用");
  await expect(control(page, "source")).toBeDisabled();
  await control(page, "source").evaluate(element => element.click());
  await control(page, "parent").click();
  expect(await page.evaluate(() => window.calls)).toEqual([["save"], ["parent"]]);
});
