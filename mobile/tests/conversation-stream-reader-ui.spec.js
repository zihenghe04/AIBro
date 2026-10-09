// Browser development acceptance only. Real Store, tools, stream parser, page and
// offline Kit run against an isolated database and a gated synthetic SSE provider.
// This does not establish native transport, keyboard or selection-handle behavior.
import { test, expect } from '@playwright/test';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = 'http://127.0.0.1:8899';
const EVIDENCE = Array.from({ length: 65 }, (_, i) => `合成证据第 ${i + 1} 行：读取资料时保持原位置，样本数为 ${i + 12}。`).join('\n')
  + '\nhttps://fixture.invalid/' + 'long-segment-'.repeat(45);
const REASONING = Array.from({ length: 38 }, (_, i) => `推理段落 ${i + 1}：核对合成资料中的采样记录，再解释观察结果。`).join('\n\n');
const BODY = '可选择的正文起点，保留这一段选区。\n\n'
  + Array.from({ length: 24 }, (_, i) => `正文段落 ${i + 1}：这是一份用于验证阅读位置的合成回答，引用资料 [1]。`).join('\n\n');
const gates = new Map(), requests = [];
let model, certDir, modelBase;

test.use({ ignoreHTTPSErrors: true, viewport: { width: 320, height: 720 }, isMobile: true,
  hasTouch: true, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', serviceWorkers: 'block', reducedMotion: 'reduce' });
test.setTimeout(60000);

function chunk(response, delta, finishReason = null) {
  if (!response || response.destroyed || response.writableEnded) throw Error('Synthetic stream gate is not open');
  response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] }) + '\r\n\r\n');
}
function finish(response) {
  chunk(response, {}, 'stop');
  response.end('data: [DONE]\r\n\r\n');
}
function tool(response) {
  const args = JSON.stringify({ kind: 'notes', id: 'reader-evidence', limit: 12000 });
  const at = Math.floor(args.length / 2);
  chunk(response, { tool_calls: [{ index: 0, id: 'reader-call', type: 'function',
    function: { name: 'knowledge_read', arguments: args.slice(0, at) } }] });
  chunk(response, { tool_calls: [{ index: 0, function: { arguments: args.slice(at) } }] }, 'tool_calls');
  response.end('data: [DONE]\r\n\r\n');
}

test.beforeAll(async () => {
  certDir = mkdtempSync(join(tmpdir(), 'aibro-reader-sse-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(certDir, 'key.pem'),
    '-out', join(certDir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  model = https.createServer({ key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem')) }, async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', APP);
    response.setHeader('Access-Control-Allow-Headers', 'authorization,content-type,accept');
    response.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions'
        || request.headers.authorization !== 'Bearer synthetic-reader-key') { response.writeHead(400); response.end(); return; }
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw); requests.push(body);
    const prompt = body.messages.filter(message => message.role === 'user').at(-1)?.content;
    if (!prompt?.startsWith('阅读状态验收')) { response.writeHead(400); response.end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    response.flushHeaders();
    if (!body.messages.some(message => message.role === 'tool')) {
      chunk(response, { reasoning_content: REASONING });
      tool(response);
    } else {
      chunk(response, { content: BODY });
      gates.set(prompt, response); // The test, rather than a timer, releases each next delta and completion.
    }
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  modelBase = `https://127.0.0.1:${model.address().port}/v1`;
});

test.afterEach(() => {
  for (const response of gates.values()) response.destroy();
  gates.clear();
});
test.afterAll(async () => {
  if (model) { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); }
  if (certDir) rmSync(certDir, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  requests.length = 0;
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/__reader_fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>isolated stream reader fixture</title>' }));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === APP || url.origin === new URL(modelBase).origin || url.protocol === 'data:') return route.fallback();
    external.push(url.href); return route.abort('blockedbyclient');
  });
  await page.goto(APP + '/__reader_fixture', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async ({ modelBase, evidence }) => {
    const { Store, MemoryAdapter, addMessage } = await import('/src/store.js');
    const { createConversationContext } = await import('/src/conversation-context.js');
    const store = await new Store(new MemoryAdapter()).load();
    await store.tx(state => { state.settings.model = { base: modelBase, model: 'synthetic-reader', format: 'chat' }; });
    await store.put('notes', { id: 'reader-evidence', title: '合成阅读证据', content: evidence, kind: '笔记', workspace: '科研' });
    for (const id of ['reader', 'cancelled', 'failed']) {
      await store.put('conversations', { id, title: `合成阅读 ${id}`, workspace: '科研', projectId: null,
        mobileContext: createConversationContext(['notes:reader-evidence']) });
      if (id !== 'reader') await addMessage(store, id, 'assistant', '中断前的合成正文。', {
        status: id, reasoning: '中断前的思考。', ...(id === 'failed' ? { error: 'synthetic-provider-failure' } : {}),
        toolEvents: [{ type: 'tool-start', title: 'knowledge_read', input: { kind: 'notes', id: 'reader-evidence' }, at: 1 }],
      });
    }
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase('aibro-mobile-v1');
      request.onsuccess = resolve; request.onerror = () => reject(request.error);
      request.onblocked = () => reject(Error('Fixture database unexpectedly open'));
    });
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('aibro-mobile-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('state');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('state', 'readwrite');
        tx.objectStore('state').put(store.state, 'workspace');
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
      };
    });
    sessionStorage.setItem('aibro-web-session:live:model', 'synthetic-reader-key');
  }, { modelBase, evidence: EVIDENCE });
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('nav')).toBeVisible();
  page.__readerEvidence = { errors, external };
});

async function openChat(page, id = 'reader') {
  await page.locator('nav [data-tab=chat]').click();
  if (await page.locator('[data-action=all-chats]').count()) await page.locator('[data-action=all-chats]').click();
  await page.locator(`[data-action=conversation][data-id=${id}]`).click();
}
async function start(page, prompt) {
  await openChat(page);
  await page.locator('#chat-text').fill(prompt);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('#live-response .live-text')).toContainText('正文段落 24');
  await expect(page.locator('#live-response [data-conversation-activity]')).toBeVisible();
  await expect.poll(() => gates.has(prompt)).toBe(true);
  expect(requests).toHaveLength(2);
  const toolMessage = requests[1].messages.find(message => message.role === 'tool');
  expect(toolMessage?.content).toContain('合成证据第 65 行');
  expect(JSON.parse(toolMessage.content).error).toBeUndefined();
}
async function openDetails(page) {
  await page.locator('#live-response details.reasoning summary').click();
  await page.locator('#live-response details.tool-trace').filter({ hasText: '读取资料' }).locator('summary').click();
  await expect(page.locator('#live-response details.reasoning')).toHaveJSProperty('open', true);
  await expect(page.locator('#live-response details.tool-trace')).toHaveJSProperty('open', true);
}
async function rememberReader(page) {
  return page.evaluate(() => {
    const article = document.querySelector('#live-response');
    const reasoning = article.querySelector('details.reasoning'), tool = article.querySelector('details.tool-trace');
    const reasonText = reasoning.querySelector('.markdown'), output = [...tool.querySelectorAll('pre')].at(-1);
    const summary = tool.querySelector('summary'), body = article.querySelector('.live-text');
    reasonText.scrollTop = 117; output.scrollTop = 91; summary.focus({ preventScroll: true });
    window.__reader = { article, reasoning, tool, reasonText, output, summary, body,
      reasonScroll: reasonText.scrollTop, toolScroll: output.scrollTop };
    return { reasonScroll: reasonText.scrollTop, toolScroll: output.scrollTop,
      reasonOverflow: reasonText.scrollHeight - reasonText.clientHeight, toolOverflow: output.scrollHeight - output.clientHeight };
  });
}
async function readerState(page) {
  return page.evaluate(() => {
    const r = window.__reader;
    return { article: r.article.isConnected, reasoning: r.reasoning === r.article.querySelector('details.reasoning'),
      tool: r.tool === r.article.querySelector('details.tool-trace'), reasonText: r.reasonText === r.reasoning.querySelector('.markdown'),
      output: r.output === [...r.tool.querySelectorAll('pre')].at(-1), body: r.body === r.article.querySelector('.live-text, .message-body'),
      focused: document.activeElement === r.summary, reasonOpen: r.reasoning.open, toolOpen: r.tool.open,
      reasonScroll: r.reasonText.scrollTop, toolScroll: r.output.scrollTop };
  });
}
async function quietEvidence(page) {
  expect(page.__readerEvidence.errors).toEqual([]);
  expect(page.__readerEvidence.external).toEqual([]);
}

test('stream deltas and completion preserve details, inner reading positions, focus and selected body text', async ({ page }) => {
  const prompt = '阅读状态验收：稳定阅读';
  await start(page, prompt); await openDetails(page);
  const initial = await rememberReader(page);
  expect(initial.reasonOverflow).toBeGreaterThan(200); expect(initial.toolOverflow).toBeGreaterThan(200);
  expect(initial.reasonScroll).toBe(117); expect(initial.toolScroll).toBe(91);
  const expected = { article: true, reasoning: true, tool: true, reasonText: true, output: true, body: true,
    focused: true, reasonOpen: true, toolOpen: true, reasonScroll: 117, toolScroll: 91 };
  chunk(gates.get(prompt), { content: '\n\n正文增量一：已到达。' });
  await expect(page.locator('#live-response .live-text')).toContainText('正文增量一');
  expect(await readerState(page)).toEqual(expected);

  // Closing is an explicit state too; later content must not reopen either panel.
  await page.locator('#live-response details.reasoning summary').click();
  await page.locator('#live-response details.tool-trace summary').click();
  chunk(gates.get(prompt), { reasoning_content: '\n\n关闭后新增推理。', content: '\n\n关闭后新增正文。' });
  await expect(page.locator('#live-response .live-text')).toContainText('关闭后新增正文');
  await expect(page.locator('#live-response details.reasoning')).toHaveJSProperty('open', false);
  await expect(page.locator('#live-response details.tool-trace')).toHaveJSProperty('open', false);
  await expect(page.locator('#live-response .reasoning .markdown')).not.toContainText('关闭后新增推理');
  expect((await readerState(page)).reasoning).toBe(true); expect((await readerState(page)).tool).toBe(true);

  await page.locator('#live-response details.reasoning summary').click();
  await expect(page.locator('#live-response .reasoning .markdown')).toContainText('关闭后新增推理');
  await page.evaluate(() => {
    const node = document.querySelector('#live-response .live-text p').firstChild;
    const selection = getSelection(), range = document.createRange();
    range.setStart(node, 0); range.setEnd(node, 8); selection.removeAllRanges(); selection.addRange(range);
    window.__selected = { node, text: selection.toString(), anchor: selection.anchorOffset, focus: selection.focusOffset };
  });
  // A reasoning marker proves the new batch was processed without waiting for a
  // body mutation that must intentionally be buffered while the range is active.
  chunk(gates.get(prompt), { reasoning_content: '\n\n选区期间推理已更新。', content: '\n\n选区期间正文应缓冲。' });
  await expect(page.locator('#live-response .reasoning .markdown')).toContainText('选区期间推理已更新');
  await expect(page.locator('#live-response .live-text')).not.toContainText('选区期间正文应缓冲');
  expect(await page.evaluate(() => {
    const selection = getSelection(), saved = window.__selected;
    return { text: selection.toString() === saved.text, anchor: selection.anchorNode === saved.node,
      focus: selection.focusNode === saved.node, offsets: [selection.anchorOffset, selection.focusOffset], connected: saved.node.isConnected };
  })).toEqual({ text: true, anchor: true, focus: true, offsets: [0, 8], connected: true });
  await page.evaluate(() => getSelection().removeAllRanges());
  await expect(page.locator('#live-response .live-text')).toContainText('选区期间正文应缓冲');

  await page.locator('#live-response details.reasoning summary').click();
  await openDetails(page); await rememberReader(page);
  await page.evaluate(() => {
    const node = window.__reader.body.querySelector('p').firstChild;
    const selection = getSelection(), range = document.createRange();
    range.setStart(node, 0); range.setEnd(node, 8); selection.removeAllRanges(); selection.addRange(range);
    window.__terminalSelection = { node, text: selection.toString() };
  });
  chunk(gates.get(prompt), { content: '\n\n跨越终态的最后正文后缀。' });
  finish(gates.get(prompt));
  await expect(page.locator('#live-response')).toHaveCount(0);
  await expect(page.locator('.message.assistant .message-body')).toContainText('选区期间正文应缓冲');
  await expect(page.locator('.message.assistant .message-body')).not.toContainText('跨越终态的最后正文后缀');
  expect(await readerState(page)).toEqual(expected);
  await expect(page.locator('.message.assistant [data-activity-status]')).toHaveAttribute('data-activity-status', 'completed');
  expect(await page.evaluate(() => {
    const selection = getSelection(), saved = window.__terminalSelection;
    return { connected: saved.node.isConnected, text: selection.toString() === saved.text,
      anchor: selection.anchorNode === saved.node, focus: selection.focusNode === saved.node,
      offsets: [selection.anchorOffset, selection.focusOffset] };
  })).toEqual({ connected: true, text: true, anchor: true, focus: true, offsets: [0, 8] });
  await page.evaluate(() => getSelection().removeAllRanges());
  await expect(page.locator('.message.assistant .message-body')).toContainText('跨越终态的最后正文后缀');
  await quietEvidence(page);
});

test('touching a tool suspends following until latest is requested, with readable 320px dark content', async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  const prompt = '阅读状态验收：触摸阅读';
  await start(page, prompt); await openDetails(page);
  const latest = page.getByRole('button', { name: '回到最新回复', exact: true });
  if (await latest.isVisible()) await latest.click();
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
  const bottomGap = () => page.evaluate(() => Math.max(0, document.documentElement.scrollHeight - innerHeight - scrollY));
  await expect.poll(bottomGap).toBeLessThanOrEqual(2);
  await page.locator('#live-response .tool-trace pre').last().dispatchEvent('touchstart', { bubbles: true });
  await expect(latest).toBeVisible();
  const before = await page.evaluate(() => scrollY);
  chunk(gates.get(prompt), { content: '\n\n触摸后的新段落。\n\n' + Array.from({ length: 8 }, (_, i) => `触摸增量 ${i}：继续生成但保持阅读位置。`).join('\n\n') });
  await expect(page.locator('#live-response .live-text')).toContainText('触摸增量 7');
  expect(Math.abs(await page.evaluate(() => scrollY) - before)).toBeLessThanOrEqual(2);
  expect(await bottomGap()).toBeGreaterThan(100);

  await latest.click();
  await expect.poll(bottomGap).toBeLessThanOrEqual(2);
  chunk(gates.get(prompt), { content: '\n\n主动回到底部后继续跟随。\n\n又一段使页面继续增长。' });
  await expect(page.locator('#live-response .live-text')).toContainText('主动回到底部后继续跟随');
  await expect.poll(bottomGap).toBeLessThanOrEqual(2);
  await expect(latest).toBeHidden();
  const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
    nodes: [...document.querySelectorAll('#live-response .reasoning .markdown, #live-response .tool-trace pre, #live-response [data-conversation-activity]')]
      .map(element => ({ right: element.getBoundingClientRect().right, left: element.getBoundingClientRect().left,
        client: element.clientWidth, scroll: element.scrollWidth })),
    dark: matchMedia('(prefers-color-scheme: dark)').matches, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches }));
  expect(layout.width).toBe(320); expect(layout.scroll).toBeLessThanOrEqual(320);
  expect(layout.dark && layout.reduced).toBe(true);
  for (const node of layout.nodes) {
    expect(node.left).toBeGreaterThanOrEqual(0); expect(node.right).toBeLessThanOrEqual(320);
    expect(node.scroll).toBeLessThanOrEqual(node.client);
  }
  await page.locator('#live-response details.reasoning').evaluate(element => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: info.outputPath('stream-reader-dark-reduced-320.png'), animations: 'disabled' });
  finish(gates.get(prompt));
  await expect(page.locator('#live-response')).toHaveCount(0);
  await quietEvidence(page);
});

for (const status of ['cancelled', 'failed']) {
  test(`${status} persisted replies never label an unreturned tool as completed`, async ({ page }) => {
    await openChat(page, status);
    const message = page.locator('.message.assistant');
    await expect(message.locator('[data-activity-status]')).toHaveAttribute('data-activity-status', status);
    await expect(message.locator('[data-tool-status]')).toHaveAttribute('data-tool-status', 'incomplete');
    await expect(message.locator('details.tool-trace summary')).toContainText('未完成');
    await message.locator('details.tool-trace summary').click();
    await expect(message.locator('details.tool-trace')).not.toContainText('合成证据第 65 行');
    expect(requests).toHaveLength(0);
    await quietEvidence(page);
  });
}
