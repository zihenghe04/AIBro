import { test, expect } from '@playwright/test';

const APP = 'http://127.0.0.1:8899';
test.use({ viewport: { width: 320, height: 760 }, locale: 'zh-CN', serviceWorkers: 'block' });
async function mount(page) {
  await page.route('**/__context_status', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div style="padding:20px"><textarea id="draft" aria-label="消息">仍保留的中文草稿</textarea><div id="context"></div><button id="after">下一个控件</button></div>' }));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.fallback() : route.abort());
  await page.goto(`${APP}/__context_status`);
  await page.evaluate(async () => {
    await import('/src/style.css');
    const { Store, MemoryAdapter, putRecord } = await import('/src/store.js');
    const { createConversationContext, conversationContextStatus, selectConversationContext } = await import('/src/conversation-context.js');
    const { mountConversationContextStatus } = await import('/src/ui/conversation-context-status.js');
    const store = window.testStore = await new Store(new MemoryAdapter()).load();
    await store.put('conversations', { id: 'c', mobileContext: createConversationContext(['notes:missing']) });
    window.calls = [];
    window.view = () => conversationContextStatus(store, store.get('conversations', 'c'));
    const onUseScope = async () => {
      window.calls.push('scope');
      await store.tx(state => {
        const c = state.records['conversations:c'].data;
        putRecord(state, 'conversations', { ...c, mobileContext: selectConversationContext(state, c, [], { useKnowledgeScope: true }) }, c);
      });
      window.contextUI.update({ view: window.view() });
    };
    window.contextUI = await mountConversationContextStatus(document.getElementById('context'), { view: window.view(), onChoose: () => window.calls.push('choose'), onUseScope });
  });
}

test('all-lost references show explicit recovery; keyboard choose retains external draft and 44px controls', async ({ page }) => {
  await mount(page);
  await expect(page.getByRole('status')).toHaveText('1 项引用已不可用。你的输入仍保留，发送前请调整引用。');
  const choose = page.getByRole('button', { name: '重新选择引用', exact: true });
  await choose.focus(); await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.calls)).toEqual(['choose']);
  await expect(page.locator('#draft')).toHaveValue('仍保留的中文草稿');
  expect(await page.locator('#context [data-action]').count()).toBe(0);
  expect(await page.evaluate(() => [...document.querySelectorAll('#context button')].every(b => b.getBoundingClientRect().height >= 44))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('explicit scope action persists empty context and clears only recovery surface after success', async ({ page }) => {
  await mount(page);
  await page.getByRole('button', { name: '改用全部知识', exact: true }).click();
  await expect(page.getByRole('region', { name: '引用资料待处理' })).toHaveCount(0);
  expect(await page.evaluate(() => window.calls)).toEqual(['scope']);
  expect(await page.evaluate(() => window.testStore.get('conversations', 'c').mobileContext.keys)).toEqual([]);
  await expect(page.locator('#draft')).toHaveValue('仍保留的中文草稿');
});

test('async failure stays visible, prevents duplicate callbacks and releases controls after rejection', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => window.contextUI.update({ onUseScope: () => new Promise((_, reject) => { window.calls.push('pending'); window.rejectScope = reject; }) }));
  const scope = page.getByRole('button', { name: '改用全部知识', exact: true });
  await scope.click(); await expect(scope).toBeDisabled();
  await expect(page.getByRole('button', { name: '重新选择引用', exact: true })).toBeDisabled();
  await scope.evaluate(button => button.click());
  expect(await page.evaluate(() => window.calls)).toEqual(['pending']);
  await page.evaluate(() => window.rejectScope(Error('对话已变化，请重新选择')));
  await expect(page.getByRole('alert')).toHaveText('对话已变化，请重新选择');
  await expect(scope).toBeEnabled();
  expect(await page.evaluate(() => window.testStore.get('conversations', 'c').mobileContext.keys)).toEqual(['notes:missing']);
  await page.evaluate(() => window.contextUI.unmount());
  await expect(page.locator('#context')).toBeEmpty();
  await expect(page.locator('#draft')).toHaveValue('仍保留的中文草稿');
});
