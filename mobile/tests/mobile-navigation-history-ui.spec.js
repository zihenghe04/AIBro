// Isolated browser acceptance of actual main navigation; synthetic IndexedDB only.
import { test, expect } from '@playwright/test';

const APP = 'http://127.0.0.1:8899';
test.use({ viewport: { width: 320, height: 760 }, isMobile: true, hasTouch: true,
  locale: 'zh-CN', timezoneId: 'Asia/Shanghai', serviceWorkers: 'block', reducedMotion: 'reduce' });
test.setTimeout(30000);

async function seed(page) {
  await page.route('**/__navigation_fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>synthetic navigation</title>' }));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.fallback() : route.abort('blockedbyclient'));
  await page.goto(APP + '/__navigation_fixture');
  await page.evaluate(async () => {
    const { Store, MemoryAdapter, addMessage } = await import('/src/store.js');
    const store = await new Store(new MemoryAdapter()).load();
    for (const id of ['a', 'b']) await store.put('conversations', { id, title: '合成会话 ' + id, workspace: '日常', updatedAt: 10 });
    await store.put('projects', { id: 'p', name: '合成项目用于返回上层与长标题布局验收', workspace: '日常' });
    await store.put('tasks', { id: 't', title: '合成子任务', description: '原始说明', projectId: 'p', status: 'todo' });
    await store.put('notes', { id: 'n', title: '合成资料', content: '合成资料的真实正文', kind: '笔记', projectId: 'p' });
    for (const cid of ['a', 'b']) {
      for (let i = 0; i < 18; i++) await addMessage(store, cid, 'assistant', `第 ${i} 段合成阅读内容。\n\n` + '保留会话阅读位置。'.repeat(15), { id: cid + i, status: 'completed' });
    }
    await addMessage(store, 'a', 'assistant', '已保存合成项目和资料。', { id: 'result', status: 'completed', pendingPlan: {
      id: 'plan', conversationID: 'a', status: 'applied', receipts: [
        { operation: 'create', kind: 'projects', id: 'p', title: '合成项目' },
        { operation: 'create', kind: 'notes', id: 'n', title: '合成资料' },
      ],
    } });
    store.state.drafts['chat:a'] = 'A 未发送导航草稿'; store.state.drafts['chat:b'] = 'B 独立草稿';
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('aibro-mobile-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('state');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { const db = request.result, tx = db.transaction('state', 'readwrite'); tx.objectStore('state').put(store.state, 'workspace'); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
    });
  });
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('nav')).toBeVisible();
  await page.locator('.home-recent-item[data-action="conversation"][data-id="a"]').click();
  await expect(page.locator('#chat-text')).toHaveValue('A 未发送导航草稿');
}
async function saved(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('aibro-mobile-v1', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { const db = request.result, tx = db.transaction('state'), get = tx.objectStore('state').get('workspace'); get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error); tx.oncomplete = () => db.close(); };
  }));
}
const position = (page, id) => page.locator(`[data-message="${id}"]`).evaluate(el => el.getBoundingClientRect().top);
async function place(page, id, offset) {
  await page.locator(`[data-message="${id}"]`).evaluate((el, offset) => window.scrollBy(0, el.getBoundingClientRect().top - offset), offset);
  await expect.poll(async () => Math.abs(await position(page, id) - offset)).toBeLessThan(1.5);
}
async function showList(page) {
  // Dispatch the real header action without scrolling to it first; the user can
  // also reach this state through native Back (covered by actual callback tests).
  await page.locator('[data-action="all-chats"]').evaluate(el => el.click());
  await expect(page.locator('#chat-text')).toHaveCount(0);
}

test('each conversation restores its reading anchor and unsent draft through tabs and list', async ({ page }, info) => {
  await seed(page);
  await place(page, 'a8', -20);
  await page.locator('nav [data-tab="knowledge"]').click();
  await page.locator('nav [data-tab="chat"]').click();
  await expect.poll(async () => Math.abs(await position(page, 'a8') + 20)).toBeLessThan(1.5);
  await expect(page.locator('#chat-text')).toHaveValue('A 未发送导航草稿');
  await showList(page);
  await page.locator('[data-action="conversation"][data-id="b"]').click();
  await place(page, 'b4', -35);
  await showList(page);
  await page.locator('[data-action="conversation"][data-id="a"]').click();
  await expect.poll(async () => Math.abs(await position(page, 'a8') + 20)).toBeLessThan(1.5);
  await expect(page.locator('#chat-text')).toHaveValue('A 未发送导航草稿');
  await showList(page);
  await page.locator('[data-action="conversation"][data-id="b"]').click();
  await expect.poll(async () => Math.abs(await position(page, 'b4') + 35)).toBeLessThan(1.5);
  await expect(page.locator('#chat-text')).toHaveValue('B 独立草稿');
  await page.screenshot({ path: info.outputPath('conversation-anchor-restored-320.png') });
});

test('result project child sheets return to fresh parent and explicit close preserves original conversation', async ({ page }, info) => {
  await seed(page);
  const before = await saved(page);
  await page.getByRole('button', { name: '打开项目：合成项目', exact: true }).click();
  await page.locator('#sheet [data-action="task"][data-id="t"]').click();
  await expect(page.locator('#task-form [name="title"]')).toHaveValue('合成子任务');
  await expect(page.locator('#sheet .sheet-head [data-action="sheet-back"]')).toHaveText('返回');
  await expect(page.locator('#sheet .sheet-head [data-action="close"]')).toHaveText('关闭');
  await page.keyboard.press('Escape');
  await expect(page.locator('#sheet .sheet-head h2')).toHaveText('合成项目用于返回上层与长标题布局验收');
  await expect(page.locator('#sheet [data-action="task"][data-id="t"]')).toBeVisible();
  await page.locator('#sheet [data-action="note"][data-id="n"]').click();
  await expect(page.locator('#sheet article.reader')).toHaveText('合成资料的真实正文');
  await page.locator('#sheet .sheet-head [data-action="sheet-back"]').click();
  await expect(page.locator('#sheet .sheet-head h2')).toHaveText('合成项目用于返回上层与长标题布局验收');
  await page.locator('#sheet [data-action="task"][data-id="t"]').click();
  await page.locator('#task-form [name="description"]').fill('返回时保留的未保存说明');
  await page.locator('#sheet .sheet-head [data-action="close"]').click();
  await expect(page.locator('#sheet')).not.toBeVisible();
  await expect(page.locator('#chat-text')).toHaveValue('A 未发送导航草稿');
  await page.getByRole('button', { name: '打开项目：合成项目', exact: true }).click();
  await page.locator('#sheet [data-action="task"][data-id="t"]').click();
  await expect(page.locator('#task-form [name="description"]')).toHaveValue('返回时保留的未保存说明');
  for (const button of await page.locator('#sheet .sheet-head button').all()) {
    const box = await button.boundingBox(); expect(box.height).toBeGreaterThanOrEqual(44); expect(box.x + box.width).toBeLessThanOrEqual(320);
  }
  await page.screenshot({ path: info.outputPath('nested-task-return-close-320.png') });
  const after = await saved(page);
  expect(after.records).toEqual(before.records); // Back/Close never replay a write/approval.
  expect(Object.keys(after.drafts).length).toBeGreaterThan(Object.keys(before.drafts).length);
});
