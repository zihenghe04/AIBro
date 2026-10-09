// Browser-only development acceptance. This uses isolated IndexedDB and a local
// synthetic HTTPS/SSE provider; it does not validate native keyboards or devices.
import { test, expect } from '@playwright/test';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = 'http://127.0.0.1:8899';
let model, certDir, modelBase;
const gates = new Map(), requests = [];
const evidence = '合成证据：比较两组采样，样本数分别为 12 和 24。';
function chunk(response, delta, finish_reason = null) {
  response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + '\r\n\r\n');
}
function done(response, text = '') {
  if (text) chunk(response, { content: text });
  chunk(response, {}, 'stop');
  response.end('data: [DONE]\r\n\r\n');
}
function tool(response, name, args, id) {
  const raw = JSON.stringify(args), split = Math.floor(raw.length / 2);
  chunk(response, { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: raw.slice(0, split) } }] });
  chunk(response, { tool_calls: [{ index: 0, function: { arguments: raw.slice(split) } }] }, 'tool_calls');
  response.end('data: [DONE]\r\n\r\n');
}

test.use({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' });
// Chrome cold start on the native-build host can exceed the default 20 seconds;
// UI assertions retain Playwright's normal, bounded expect timeout.
test.setTimeout(60000);
test.beforeAll(async () => {
  certDir = mkdtempSync(join(tmpdir(), 'aibro-ui-sse-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  model = https.createServer({ key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem')) }, async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', APP);
    response.setHeader('Access-Control-Allow-Headers', 'authorization,content-type,accept');
    response.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    if (request.headers.authorization !== 'Bearer synthetic-key' || request.url !== '/v1/chat/completions') { response.writeHead(400); response.end(); return; }
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw); requests.push(body);
    const prompt = body.messages.filter(m => m.role === 'user').at(-1)?.content;
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' }); response.flushHeaders();
    if (prompt?.startsWith('并发')) {
      chunk(response, { reasoning_content: prompt + '真实推理片段' });
      chunk(response, { content: prompt + '第一段。' });
      gates.set(prompt, response); return;
    }
    if (prompt === '工具审阅' || prompt === '拒绝方案') {
      const round = body.messages.filter(m => m.role === 'tool').length;
      if (round === 0) {
        chunk(response, { reasoning_content: '先读取合成证据，再准备修改。' });
        tool(response, 'knowledge_read', { kind: 'notes', id: 'evidence' }, 'read-fixture');
      } else if (round === 1) {
        tool(response, 'propose_changes', { actions: [{ operation: 'create', kind: 'tasks', changes: { title: prompt === '工具审阅' ? '工具创建任务' : '拒绝的任务', description: '根据合成证据安排实验', priority: 'medium' } }] }, 'plan-fixture');
      } else {
        chunk(response, { content: '已经读取资料 [1]，请审阅修改。' });
        if (prompt === '拒绝方案') done(response); else gates.set('工具审阅:final', response);
      }
      return;
    }
    done(response, '合成回答。');
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  modelBase = `https://127.0.0.1:${model.address().port}/v1`;
});
test.afterAll(async () => {
  for (const response of gates.values()) response.destroy();
  gates.clear();
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  rmSync(certDir, { recursive: true, force: true });
});
test.beforeEach(async ({ page }) => {
  gates.clear(); requests.length = 0;
  await page.route('**/__synthetic_blank', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>isolated fixture</title>' }));
  // Fail closed for any unexpected nonlocal request, including sync/auth routes.
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || url.protocol === 'data:') return route.fallback();
    return route.abort('blockedbyclient');
  });
  await page.goto(APP + '/__synthetic_blank', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async ({ modelBase, evidence }) => {
    const now = Date.now(), records = {};
    const put = (kind, data) => records[`${kind}:${data.id}`] = { data, version: 0, remote: null, remoteDeleted: false, deleted: false, dirty: false };
    put('projects', { id: 'p', name: '测试项目', description: '原目标', workspace: '科研', createdAt: now, updatedAt: now });
    put('notes', { id: 'evidence', title: '测试证据', content: evidence, projectId: 'p', workspace: '科研', kind: '笔记', createdAt: now, updatedAt: now });
    put('tasks', { id: 'oldtask', title: '待删除任务', description: '保留说明', status: 'todo', priority: 'medium', projectId: 'p', workspace: '科研', dueAt: '2030-01-02', createdAt: now, updatedAt: now });
    for (const [id, title] of [['a', '会话 A'], ['b', '会话 B'], ['tools', '工具会话'], ['reject', '拒绝会话']])
      put('conversations', { id, title, projectId: id === 'tools' || id === 'reject' ? 'p' : null, workspace: '科研', createdAt: now, updatedAt: now });
    const state = { schema: 1, records, cursor: 0, binding: null, settings: { model: { base: modelBase, model: 'fixture-model', format: 'chat' } }, drafts: {}, blobs: {} };
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('aibro-mobile-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('state');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { const db = request.result, tx = db.transaction('state', 'readwrite'); tx.objectStore('state').put(state, 'workspace'); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
    });
    sessionStorage.setItem('aibro-web-session:live:model', 'synthetic-key');
  }, { modelBase, evidence });
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('nav')).toBeVisible();
});
async function state(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('aibro-mobile-v1', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { const db = request.result, tx = db.transaction('state'); const get = tx.objectStore('state').get('workspace'); get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error); tx.oncomplete = () => db.close(); };
  }));
}
async function selectChat(page, id) {
  await page.locator('nav [data-tab=chat]').click();
  if (await page.locator('[data-action=all-chats]').count()) await page.locator('[data-action=all-chats]').click();
  await page.locator(`[data-action=conversation][data-id=${id}]`).click();
}
async function send(page, text) {
  await page.locator('#chat-text').fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
}
async function noOverflow(page) {
  const result = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, offenders: [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(e).position !== 'fixed').slice(0, 8).map(e => ({ tag: e.tagName, class: e.className, right: e.getBoundingClientRect().right })) }));
  expect(result.scroll, JSON.stringify(result)).toBeLessThanOrEqual(result.width);
}

test('two active conversations keep independent new drafts and never navigate on completion', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await selectChat(page, 'a'); await send(page, '并发A');
  await expect(page.locator('#live-response')).toContainText('并发A第一段');
  await page.locator('#chat-text').fill('A 新草稿未发送');
  await selectChat(page, 'b'); await send(page, '并发B');
  await expect(page.locator('#live-response')).toContainText('并发B第一段');
  await page.locator('#chat-text').fill('B 新草稿未发送');
  done(gates.get('并发A'), 'A 完成');
  await expect.poll(async () => Object.values((await state(page)).records).find(r => r.data?.conversationId === 'a' && r.data?.role === 'assistant')?.data.status).toBe('completed');
  await expect(page.locator('.conversation-bar')).toContainText('会话 B');
  await expect(page.locator('#chat-text')).toHaveValue('B 新草稿未发送');
  await page.locator('#chat-text').evaluate(el => el.setSelectionRange(2, 5));
  done(gates.get('并发B'), 'B 完成');
  await expect(page.locator('#live-response')).toHaveCount(0);
  await expect(page.locator('#chat-text')).toHaveValue('B 新草稿未发送');
  await expect(page.locator('#chat-text')).toBeFocused();
  expect(await page.locator('#chat-text').evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([2, 5]);
  await selectChat(page, 'a');
  await expect(page.locator('#chat-text')).toHaveValue('A 新草稿未发送');
  await expect(page.locator('.messages')).toContainText('A 完成');
  await expect(page.locator('.messages')).not.toContainText('并发B第一段');
  await page.reload({ waitUntil: 'domcontentloaded' }); await selectChat(page, 'b');
  await expect(page.locator('#chat-text')).toHaveValue('B 新草稿未发送');
  expect(errors).toEqual([]);
});

test('SSE reasoning and actual tools remain inspectable, survive reload, and review applies once', async ({ page }, testInfo) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await selectChat(page, 'tools'); await send(page, '工具审阅');
  await expect(page.locator('#live-response')).toContainText('已经读取资料');
  await page.locator('#live-response details.reasoning summary').click();
  await expect(page.locator('#live-response details.reasoning')).toHaveAttribute('open', '');
  await page.locator('#live-response details.tool-trace').filter({ hasText: '读取资料' }).locator('summary').click();
  await expect(page.locator('#live-response details.tool-trace[open]')).toContainText(evidence);
  chunk(gates.get('工具审阅:final'), { content: ' 第二段增量。' });
  await expect(page.locator('#live-response')).toContainText('第二段增量');
  await expect(page.locator('#live-response details.reasoning')).toHaveAttribute('open', '');
  await expect(page.locator('#live-response details.tool-trace[open]')).toContainText(evidence);
  await page.setViewportSize({ width: 320, height: 720 }); await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('stream-tools-320.png'), fullPage: true });
  done(gates.get('工具审阅:final'));
  await expect(page.locator('[data-action=review-plan]')).toBeVisible();
  await page.reload(); await selectChat(page, 'tools');
  await page.locator('.message.assistant details.reasoning summary').click();
  await expect(page.locator('.message.assistant details.reasoning[open]')).toContainText('先读取合成证据');
  await page.locator('.message.assistant details.tool-trace').filter({ hasText: '读取资料' }).locator('summary').click();
  await expect(page.locator('.message.assistant details.tool-trace[open]')).toContainText(evidence);
  await page.locator('[data-action=review-plan]').click();
  await expect(page.locator('#sheet')).toContainText('工具创建任务');
  expect(Object.values((await state(page)).records).filter(r => r.data?.title === '工具创建任务')).toHaveLength(0);
  await noOverflow(page); await page.screenshot({ path: testInfo.outputPath('pending-review-320.png'), fullPage: true });
  await page.locator('#apply-plan').click();
  await expect(page.locator('#sheet')).not.toBeVisible();
  await expect(page.locator('.messages')).toContainText('已确认并保存 1 项修改');
  await page.reload(); await selectChat(page, 'tools');
  expect(Object.values((await state(page)).records).filter(r => r.data?.title === '工具创建任务')).toHaveLength(1);
  await expect(page.locator('[data-action=review-plan]')).toHaveCount(0);
  expect(requests[1].messages.find(m => m.role === 'tool').content).toContain(evidence);
  expect(errors).toEqual([]);
});

test('rejecting a generated plan persists the rejection without creating records', async ({ page }) => {
  await selectChat(page, 'reject'); await send(page, '拒绝方案');
  await page.locator('[data-action=review-plan]').click();
  await page.locator('#reject-plan').click();
  await expect(page.locator('.messages')).toContainText('已拒绝本次修改');
  await page.reload(); await selectChat(page, 'reject');
  await expect(page.locator('[data-action=review-plan]')).toHaveCount(0);
  const saved = await state(page);
  expect(Object.values(saved.records).filter(r => r.data?.title === '拒绝的任务')).toHaveLength(0);
  expect(Object.values(saved.records).find(r => r.data?.pendingPlan)?.data.pendingPlan.status).toBe('rejected');
});

test('project edit and task trash/restore retain the task identity and project link', async ({ page }) => {
  await page.locator('nav [data-tab=knowledge]').click();
  await page.locator('[data-action=knowledge-mode][data-mode=projects]').click();
  await page.locator('[data-action=project][data-id=p]').click();
  await page.locator('[data-action=edit-project]').click();
  await page.locator('#project-form [name=name]').fill('修改后的测试项目');
  await page.locator('#project-form [name=description]').fill('新的目标');
  await page.getByRole('button', { name: '保存项目', exact: true }).click();
  await page.locator('[data-action=project][data-id=p]').click();
  await expect(page.locator('#sheet')).toContainText('新的目标');
  await page.locator('[data-action=task][data-id=oldtask]').click();
  await page.locator('[data-action=remove-record][data-key="tasks:oldtask"]').click();
  await page.locator('[data-action=confirm-removal]').click();
  await expect.poll(async () => (await state(page)).records['tasks:oldtask'].deleted).toBe(true);
  await page.locator('header [data-tab=settings]').click();
  await page.locator('[data-action=recovery]').click();
  await page.locator('#sheet .item').filter({ hasText: '待删除任务' }).locator('[data-action=restore-record]').click();
  await page.locator('[data-action=confirm-restore]').click();
  await expect.poll(async () => (await state(page)).records['tasks:oldtask'].deleted).toBe(false);
  const restored = (await state(page)).records['tasks:oldtask'].data;
  expect(restored).toMatchObject({ id: 'oldtask', title: '待删除任务', description: '保留说明', projectId: 'p', dueAt: '2030-01-02' });
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.reload();
  expect((await state(page)).records['projects:p'].data).toMatchObject({ name: '修改后的测试项目', description: '新的目标' });
});

test('search composition is not interrupted before commit and 320px pages fit', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.locator('nav [data-tab=knowledge]').click();
  const search = page.locator('#search'); await search.focus();
  await search.evaluate(el => { el.dataset.imeMarker = 'same-input'; el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); el.value = '测试'; el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, data: '测试' })); });
  await expect(search).toHaveAttribute('data-ime-marker', 'same-input');
  await expect(search).toBeFocused();
  await search.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '测试' })));
  await expect(page.locator('#search')).toHaveValue('测试');
  await expect(page.locator('#search')).toBeFocused();
  await expect(page.locator('main')).toContainText('测试证据');
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('knowledge-ime-320.png'), fullPage: true });
  await selectChat(page, 'a'); await page.locator('#chat-text').fill('中文草稿');
  await noOverflow(page);
});

test('stopping a streamed reply preserves partial output and the new draft after reload', async ({ page }) => {
  await selectChat(page, 'a'); await send(page, '并发取消');
  await expect(page.locator('#live-response')).toContainText('并发取消第一段');
  await page.locator('#chat-text').fill('停止时的新草稿');
  await page.getByRole('button', { name: '停止回复', exact: true }).click();
  await expect(page.locator('#live-response')).toHaveCount(0);
  await expect(page.locator('.messages')).toContainText('已停止 · 保留了已生成的内容');
  await expect(page.locator('#chat-text')).toHaveValue('停止时的新草稿');
  await page.reload({ waitUntil: 'domcontentloaded' }); await selectChat(page, 'a');
  await expect(page.locator('.messages')).toContainText('并发取消第一段');
  await expect(page.locator('#chat-text')).toHaveValue('停止时的新草稿');
  expect(Object.values((await state(page)).records).find(r => r.data?.role === 'assistant')?.data.status).toBe('cancelled');
});

test('a reply finishing during Chinese composition keeps the composer node and focus', async ({ page }) => {
  await selectChat(page, 'a'); await send(page, '并发输入');
  await expect(page.locator('#live-response')).toContainText('并发输入第一段');
  const composer = page.locator('#chat-text'); await composer.focus();
  await composer.evaluate(el => {
    el.dataset.imeMarker = 'active-composition';
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    el.value = '正在输入';
    el.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true, data: '正在输入' }));
  });
  done(gates.get('并发输入'), '模型已完成。');
  await expect.poll(async () => Object.values((await state(page)).records).find(r => r.data?.role === 'assistant')?.data.status).toBe('completed');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(composer).toHaveAttribute('data-ime-marker', 'active-composition');
  await expect(composer).toBeFocused();
  await composer.evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '正在输入' })));
  await expect(page.locator('#live-response')).toHaveCount(0);
  await expect(page.locator('#chat-text')).toHaveValue('正在输入');
  await expect(page.locator('#chat-text')).toBeFocused();
});

test('restored and reused drafts replace stale focused values while newer typing wins', async ({ page }) => {
  const failReply = (response) => {
    response.write('data: ' + JSON.stringify({ error: { message: 'synthetic-provider-failure' } }) + '\r\n\r\n');
    response.end('data: [DONE]\r\n\r\n');
  };
  await selectChat(page, 'a'); await send(page, '并发失败');
  await expect(page.locator('#live-response')).toContainText('并发失败第一段');
  await page.locator('#chat-text').focus();
  failReply(gates.get('并发失败'));
  await expect(page.locator('#live-response')).toHaveCount(0);
  await expect(page.locator('.messages')).toContainText('回复未完成');
  await expect(page.locator('#chat-text')).toHaveValue('并发失败');
  await expect(page.locator('#chat-text')).toBeFocused();
  expect((await state(page)).drafts['chat:a']).toBe('并发失败');

  await page.locator('#chat-text').fill('回填前旧草稿');
  // iOS buttons need not move focus; exercise reuse while the textarea owns it.
  await page.locator('[data-action=reuse-message]').first().dispatchEvent('click');
  await expect(page.locator('#chat-text')).toHaveValue('并发失败');
  await expect(page.locator('#chat-text')).toBeFocused();
  expect((await state(page)).drafts['chat:a']).toBe('并发失败');

  await send(page, '并发失败二');
  await expect(page.locator('#live-response')).toContainText('并发失败二第一段');
  await page.locator('#chat-text').fill('失败前刚输入的新草稿');
  failReply(gates.get('并发失败二'));
  await expect(page.locator('#live-response')).toHaveCount(0);
  await expect(page.locator('#chat-text')).toHaveValue('失败前刚输入的新草稿');
  await page.reload({ waitUntil: 'domcontentloaded' }); await selectChat(page, 'a');
  await expect(page.locator('#chat-text')).toHaveValue('失败前刚输入的新草稿');
});
