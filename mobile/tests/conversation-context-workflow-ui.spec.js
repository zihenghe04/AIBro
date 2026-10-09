import { test, expect } from '@playwright/test';
const APP = 'http://127.0.0.1:8899';
test.use({ viewport: { width: 320, height: 760 }, isMobile: true, hasTouch: true, locale: 'zh-CN', serviceWorkers: 'block', reducedMotion: 'reduce' });
async function saved(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const r = indexedDB.open('aibro-mobile-v1', 1); r.onerror = () => reject(r.error);
    r.onsuccess = () => { const db = r.result, tx = db.transaction('state'), get = tx.objectStore('state').get('workspace'); get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error); tx.oncomplete = () => db.close(); };
  }));
}
async function seed(page, valid = false) {
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.fallback() : route.abort());
  await page.route('**/__reference_workflow', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><title>Synthetic reference workflow</title>' }));
  await page.goto(APP + '/__reference_workflow');
  await page.evaluate(async valid => {
    const { Store, MemoryAdapter, IndexedAdapter } = await import('/src/store.js');
    const { createConversationContext } = await import('/src/conversation-context.js');
    const store = await new Store(new MemoryAdapter()).load();
    await store.put('projects', { id: 'private-owner', name: '不可显示项目', private: true });
    for (const note of [{ id: 'a', title: '合成来源 A', content: '来源正文不变' }, { id: 'b', title: '合成资料 B', content: 'B 的正文' },
      { id: 'private', title: '私密候选', private: true }, { id: 'conflict', title: '冲突候选' }, { id: 'owned', title: '私密归属候选', projectId: 'private-owner' }])
      await store.put('notes', { ...note, kind: 'note', workspace: '科研' });
    await store.tx(s => { s.records['notes:conflict'].conflict = { version: 3, data: { id: 'conflict', title: '云端冲突候选' }, deleted: false }; });
    await store.put('conversations', { id: 'origin', title: '原对话' });
    await store.put('conversations', { id: 'c', title: '引用恢复讨论', mobileContext: createConversationContext([valid ? 'notes:b' : 'notes:missing'], { kind: 'notes', id: 'a', conversationId: 'origin' }) });
    await store.tx(s => { s.drafts['chat:c'] = '未发送的中文草稿'; });
    await new IndexedAdapter().write(store.state);
  }, valid);
  await page.goto(APP); await expect(page.locator('#home-chat-form')).toBeVisible();
  await openConversation(page);
}
async function openConversation(page) {
  await page.locator('nav [data-tab=chat]').click();
  await page.locator('[data-action=conversation][data-id=c]').click();
  await expect(page.locator('#chat-text')).toBeVisible();
}
async function captureRealStore(page) {
  await page.evaluate(async () => {
    const { Store } = await import('/src/store.js');
    const original = Store.prototype.tx;
    Store.prototype.tx = function (fn) { window.referenceOwnerStore = this; return original.call(this, fn); };
  });
  await page.locator('#chat-text').fill('未发送的中文草稿 · 新输入');
  await page.waitForFunction(() => !!window.referenceOwnerStore);
  await expect.poll(async () => (await saved(page)).drafts['chat:c']).toBe('未发送的中文草稿 · 新输入');
}
const picker = page => page.locator('#context-picker-list');
const finish = page => page.locator('[data-action=finish-context]');

test('all-lost status blocks send without scope widening; B selection retains source and draft across reload', async ({ page }, info) => {
  await seed(page);
  await expect(page.locator('.context-count')).toHaveText('1 项引用待处理');
  await expect(page.locator('#conversation-context-status-root')).toContainText('1 项引用已不可用');
  await expect(page.locator('#chat-text')).toHaveValue('未发送的中文草稿');
  await page.locator('#chat-form [aria-label=发送]').click();
  await expect(page.locator('#toast')).toContainText('没有扩大检索范围');
  expect(Object.keys((await saved(page)).records).filter(key => key.startsWith('messages:'))).toEqual([]);
  await page.getByRole('button', { name: '重新选择引用', exact: true }).click();
  await expect(picker(page)).not.toContainText('私密候选'); await expect(picker(page)).not.toContainText('冲突候选'); await expect(picker(page)).not.toContainText('私密归属候选');
  await expect(finish(page)).toBeDisabled();
  await picker(page).locator('[data-ref="notes:b"]').check(); await expect(finish(page)).toBeEnabled(); await finish(page).click();
  await expect(page.locator('#sheet')).not.toBeVisible();
  await expect(page.locator('.context-count')).toHaveText('1 项引用');
  await expect(page.locator('#chat-text')).toHaveValue('未发送的中文草稿');
  expect((await saved(page)).records['conversations:c'].data.mobileContext).toEqual({ version: 1, keys: ['notes:b'], source: { kind: 'notes', id: 'a', conversationId: 'origin' } });
  await page.reload(); await openConversation(page);
  await expect(page.locator('.context-count')).toHaveText('1 项引用'); await expect(page.locator('#chat-text')).toHaveValue('未发送的中文草稿');
  await page.locator('[data-document-control=source]').click(); await expect(page.locator('#document-reader')).toHaveText('来源正文不变');
  await expect(page.locator('#sheet h2')).toHaveText('合成来源 A');
  await page.screenshot({ path: info.outputPath('reference-recovered-source-320.png'), animations: 'disabled' });
});

test('intentional empty selection requires explicit knowledge button; source and draft survive', async ({ page }, info) => {
  await seed(page, true);
  await page.locator('[data-action=pick-context]').click();
  await picker(page).locator('[data-ref="notes:b"]').uncheck(); await expect(finish(page)).toBeDisabled();
  await finish(page).evaluate(button => button.click());
  expect((await saved(page)).records['conversations:c'].data.mobileContext.keys).toEqual(['notes:b']);
  await page.locator('#sheet [data-action=use-knowledge-scope]').click();
  await expect(page.locator('#sheet')).not.toBeVisible(); await expect(page.locator('.context-count')).toHaveText('全部知识');
  await expect(page.locator('#chat-text')).toHaveValue('未发送的中文草稿');
  expect((await saved(page)).records['conversations:c'].data.mobileContext.source).toEqual({ kind: 'notes', id: 'a', conversationId: 'origin' });
  await page.reload(); await openConversation(page);
  await expect(page.locator('.context-count')).toHaveText('全部知识'); await expect(page.locator('[data-document-control=source]')).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('reference-explicit-knowledge-320.png'), animations: 'disabled' });
});

test('real Store updates refresh availability after reopen and reject selections which change while picker is open', async ({ page }) => {
  await seed(page, true); await captureRealStore(page);
  await page.locator('[data-action=pick-context]').click();
  await page.evaluate(async () => {
    const s = window.referenceOwnerStore;
    await s.put('notes', { ...s.get('notes', 'b'), private: true });
  });
  await finish(page).click(); await expect(page.locator('#sheet .sheet-status')).toContainText('所选资料已不可用');
  expect((await saved(page)).records['conversations:c'].data.mobileContext.keys).toEqual(['notes:b']);
  await page.locator('#sheet [data-action=close]').click(); await page.reload(); await openConversation(page);
  await expect(page.locator('.context-count')).toHaveText('1 项引用待处理');
  await expect(page.locator('#chat-text')).toHaveValue('未发送的中文草稿 · 新输入');
  await page.getByRole('button', { name: '重新选择引用', exact: true }).click();
  await expect(picker(page).locator('[data-ref="notes:b"]')).toHaveCount(0);
  await picker(page).locator('[data-ref="notes:a"]').check(); await finish(page).click();
  await expect(page.locator('.context-count')).toHaveText('1 项引用');
  expect((await saved(page)).records['conversations:c'].data.mobileContext.keys).toEqual(['notes:a']);
});

test('desktop singular note/task citations with colliding IDs open the persisted collection and never fall back to a note', async ({ page }) => {
  await seed(page, true); await captureRealStore(page);
  await page.evaluate(async () => {
    const s = window.referenceOwnerStore;
    await s.put('notes', { id: 'collision', title: '同 ID 笔记', content: '必须打开笔记正文', kind: 'note' });
    await s.put('tasks', { id: 'collision', title: '同 ID 任务', description: '必须打开任务详情', status: 'todo' });
    await s.put('messages', { id: 'desktop_message', conversationId: 'c', role: 'assistant', text: '合成 Mac 来源回答', status: 'completed', retrievedSources: [
      { type: 'note', id: 'collision', title: '旧缓存笔记标题' },
      { type: 'task', id: 'collision', title: '旧缓存任务标题' },
      { type: 'task', id: 'a', title: '只有同 ID 笔记的失效任务' },
    ] });
  });
  await page.reload(); await openConversation(page);
  const message = page.locator('[data-message=desktop_message]');
  await expect(message.locator('[data-source-index="0"]')).toHaveText('[1] 同 ID 笔记');
  await expect(message.locator('[data-source-index="1"]')).toHaveText('[2] 同 ID 任务');
  await expect(message.locator('[data-source-index="2"]')).toBeDisabled();
  await expect(message.locator('[data-source-index="2"]')).toHaveText('[3] 来源不可用');
  await message.locator('[data-source-index="0"]').click();
  await expect(page.locator('#document-reader')).toHaveText('必须打开笔记正文');
  await expect(page.locator('#task-form')).toHaveCount(0);
  await page.locator('#sheet [data-action=close]').click();
  await message.locator('[data-source-index="1"]').click();
  await expect(page.locator('#task-form [name=title]')).toHaveValue('同 ID 任务');
  await expect(page.locator('#task-form [name=description]')).toHaveValue('必须打开任务详情');
  await expect(page.locator('#document-reader')).toHaveCount(0);
  await page.locator('#sheet [data-action=close]').click();
  await expect(page.locator('#chat-text')).toHaveValue('未发送的中文草稿 · 新输入');
});

test('stale citation buttons preserve source identity across sync reorder and reject replaced or redirected targets', async ({ page }) => {
  await seed(page, true); await captureRealStore(page);
  await page.evaluate(async () => {
    const { SyncScheduler } = await import('/src/sync-scheduler.js');
    const schedule = SyncScheduler.prototype._schedule;
    SyncScheduler.prototype._schedule = function (...args) {
      window.referenceOwnerScheduler = this;
      return schedule.apply(this, args);
    };
    const s = window.referenceOwnerStore;
    await s.put('notes', { id: 'collision', title: '应打开的笔记', content: '原笔记正文', kind: 'note' });
    await s.put('tasks', { id: 'collision', title: '不能误打开的任务', description: '同 ID 不同类型', status: 'todo' });
    await s.put('papers', { id: 'paper', title: '有链接的论文', noteId: 'a' });
    await s.put('messages', { id: 'stale_sources', conversationId: 'c', role: 'assistant', content: '合成来源回答', status: 'completed', retrievedSources: [
      { type: 'note', id: 'collision' }, { type: 'task', id: 'collision' }, { type: 'paper', id: 'paper' },
    ] });
    document.activeElement.blur();
    window.referenceOwnerScheduler.onSuccess();
  });
  const message = page.locator('[data-message=stale_sources]');
  const note = message.locator('[data-source-kind=notes][data-source-id=collision]');
  const paper = message.locator('[data-source-kind=papers][data-source-id=paper]');
  await expect(note).toHaveText('[1] 应打开的笔记');
  await expect(paper).toHaveAttribute('data-source-target-id', 'a');
  await page.locator('#chat-text').focus();
  await page.evaluate(async () => {
    window.staleComposer = document.querySelector('#chat-text');
    window.staleNoteButton = document.querySelector('[data-source-kind=notes][data-source-id=collision]');
    const s = window.referenceOwnerStore, m = s.get('messages', 'stale_sources');
    await s.put('messages', { ...m, retrievedSources: [m.retrievedSources[1], m.retrievedSources[0], m.retrievedSources[2]] });
    // Invoke the actual main.js sync-success callback after a synthetic durable
    // incoming update. No network/model or replacement navigation handler.
    window.referenceOwnerScheduler.onSuccess();
  });
  await expect(note).toHaveText('[1] 应打开的笔记');
  expect(await page.evaluate(() => document.activeElement === window.staleComposer && window.staleNoteButton.isConnected)).toBe(true);
  await note.click();
  await expect(page.locator('#document-reader')).toHaveText('原笔记正文');
  await expect(page.locator('#task-form')).toHaveCount(0);
  await page.locator('#sheet [data-action=close]').click();
  await expect(note).toHaveText('[2] 应打开的笔记');

  await page.locator('#chat-text').focus();
  await page.evaluate(async () => {
    const s = window.referenceOwnerStore, m = s.get('messages', 'stale_sources');
    await s.put('messages', { ...m, retrievedSources: [{ type: 'task', id: 'collision' }, { type: 'paper', id: 'paper' }] });
    window.referenceOwnerScheduler.onSuccess();
  });
  await expect(note).toHaveText('[2] 应打开的笔记');
  await note.click();
  await expect(page.locator('#toast')).toContainText('请重新打开对话刷新来源');
  await expect(page.locator('#sheet')).not.toBeVisible();
  await expect(page.locator('#task-form')).toHaveCount(0);

  await page.locator('#chat-text').focus();
  await page.evaluate(async () => {
    const s = window.referenceOwnerStore;
    await s.put('papers', { ...s.get('papers', 'paper'), noteId: 'b' });
    window.referenceOwnerScheduler.onSuccess();
    document.querySelector('#toast').textContent = '';
  });
  await expect(paper).toHaveAttribute('data-source-target-id', 'a');
  await paper.click();
  await expect(page.locator('#toast')).toContainText('请重新打开对话刷新来源');
  await expect(page.locator('#sheet')).not.toBeVisible();
  await expect(page.locator('#chat-text')).toHaveValue('未发送的中文草稿 · 新输入');
  expect((await saved(page)).drafts['chat:c']).toBe('未发送的中文草稿 · 新输入');
});
