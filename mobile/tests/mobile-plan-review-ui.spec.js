// Isolated browser development acceptance of actual main.js/ask/tools/review UI.
// Synthetic HTTPS only; this does not claim native keyboard or device acceptance.
import { test, expect } from '@playwright/test';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP = 'http://127.0.0.1:8899';
const START = Date.parse('2030-01-07T08:00:00+08:00');
const UNTIL = Date.parse('2030-02-01T08:00:00+08:00');
const CREATE = '新建项目“合成计划”，并新建任务“检查样本”，并新建日程“合成组会”，都关联这个新项目';
const REMOVE = '删除任务“原任务”，并归档项目“原项目”';
const RESTORE = '恢复项目“原项目”，并恢复任务“原任务”';
const STALE = '把任务“原任务”修改为“模型拟定的新名称”，并新建任务“不得部分写入”';
let model, certDir, modelBase;
const requests = [];

function chunk(response, delta, finish_reason = null) {
  response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + '\r\n\r\n');
}
function done(response, text) {
  chunk(response, { content: text }); chunk(response, {}, 'stop');
  response.end('data: [DONE]\r\n\r\n');
}
function tool(response, name, args, id) {
  const json = JSON.stringify(args), split = Math.floor(json.length / 2);
  chunk(response, { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: json.slice(0, split) } }] });
  chunk(response, { tool_calls: [{ index: 0, function: { arguments: json.slice(split) } }] }, 'tool_calls');
  response.end('data: [DONE]\r\n\r\n');
}
function toolResult(body, id) {
  const message = body.messages.find(message => message.role === 'tool' && message.tool_call_id === id);
  return message && JSON.parse(message.content);
}

test.use({ ignoreHTTPSErrors: true, viewport: { width: 320, height: 760 }, isMobile: true, hasTouch: true,
  timezoneId: 'Asia/Shanghai', serviceWorkers: 'block', colorScheme: 'dark', reducedMotion: 'reduce' });
test.setTimeout(60000);
test.beforeAll(async () => {
  certDir = mkdtempSync(join(tmpdir(), 'aibro-plan-review-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  model = https.createServer({ key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem')) }, async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', APP);
    response.setHeader('Access-Control-Allow-Headers', 'authorization,content-type,accept');
    response.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    if (request.headers.authorization !== 'Bearer synthetic-plan-key' || request.url !== '/v1/chat/completions') { response.writeHead(400); response.end(); return; }
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw); requests.push(body);
    const prompt = body.messages.filter(message => message.role === 'user').at(-1)?.content;
    const round = body.messages.filter(message => message.role === 'tool').length;
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' }); response.flushHeaders();
    if (prompt === CREATE) {
      if (round === 0) return tool(response, 'propose_changes', { actions: [
        { operation: 'create', kind: 'projects', ref: 'new_project', changes: { name: '合成计划', description: '同一轮审批的合成项目', workspace: '科研' } },
        { operation: 'create', kind: 'tasks', changes: { title: '检查样本', description: '核对两组样本与记录', projectRef: 'new_project', dueAt: '2030-01-07', priority: 'high' } },
        { operation: 'create', kind: 'agenda', changes: { title: '合成组会', projectRef: 'new_project', start: START + 3600000, end: START + 7200000, timeZone: 'Asia/Shanghai', reminderMinutes: 15 } },
      ] }, 'create-three');
      return done(response, '已经完成项目、任务和日程创建。'); // Guard must replace this claim before approval.
    }
    if (prompt === REMOVE) {
      if (round === 0) return tool(response, 'knowledge_read', { kind: 'tasks', id: 'task' }, 'remove-read-task');
      if (round === 1) return tool(response, 'knowledge_read', { kind: 'projects', id: 'p' }, 'remove-read-project');
      if (round === 2) return tool(response, 'propose_changes', { actions: [
        { operation: 'remove', kind: 'tasks', id: 'task' }, { operation: 'remove', kind: 'projects', id: 'p' },
      ] }, 'remove-two');
      return done(response, '已经删除了任务和整个项目。');
    }
    if (prompt === RESTORE) {
      if (round === 0) return tool(response, 'workspace_list', { state: 'recoverable' }, 'recovery-directory');
      if (round === 1) return tool(response, 'knowledge_read', { kind: 'projects', id: 'p', archived: true }, 'restore-read-project');
      const trash = toolResult(body, 'recovery-directory')?.entries.find(entry => entry.kind === 'trash' && entry.title === '原任务');
      if (!trash) return done(response, '找不到合成回收记录，未执行。');
      if (round === 2) return tool(response, 'knowledge_read', { kind: 'trash', id: trash.id, archived: true }, 'restore-read-trash');
      if (round === 3) return tool(response, 'propose_changes', { actions: [
        { operation: 'restore', kind: 'projects', id: 'p' }, { operation: 'restore', kind: 'trash', id: trash.id },
      ] }, 'restore-two');
      return done(response, '已恢复，请继续操作。');
    }
    if (prompt === STALE) {
      if (round === 0) return tool(response, 'knowledge_read', { kind: 'tasks', id: 'task' }, 'stale-read');
      if (round === 1) return tool(response, 'propose_changes', { actions: [
        { operation: 'update', kind: 'tasks', id: 'task', changes: { title: '模型拟定的新名称' } },
        { operation: 'create', kind: 'tasks', changes: { title: '不得部分写入' } },
      ] }, 'stale-plan');
      return done(response, '请审阅任务修改。');
    }
    done(response, '合成测试未识别请求，未执行。');
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  modelBase = `https://127.0.0.1:${model.address().port}/v1`;
});
test.afterAll(async () => {
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve));
  rmSync(certDir, { recursive: true, force: true });
});
test.beforeEach(async ({ page }) => {
  requests.length = 0;
  await page.clock.setFixedTime(new Date('2030-01-07T07:00:00+08:00'));
  await page.addInitScript(() => {
    window.__qaWorkspaceWrites = [];
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, key) {
      if (this.name === 'state' && key === 'workspace' && value?.records) {
        const records = structuredClone(value.records);
        this.transaction.addEventListener('complete', () => window.__qaWorkspaceWrites.push(records), { once: true });
      }
      return original.call(this, value, key);
    };
  });
  await page.route('**/__synthetic_blank', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>isolated review fixture</title>' }));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.hostname === '127.0.0.1' || url.protocol === 'data:' ? route.fallback() : route.abort('blockedbyclient');
  });
  await page.goto(APP + '/__synthetic_blank', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async ({ modelBase, start, until }) => {
    const now = Date.now(), records = {};
    const put = (kind, data) => records[`${kind}:${data.id}`] = { data, version: 0, remote: null, remoteDeleted: false, deleted: false, dirty: false };
    put('projects', { id: 'p', name: '原项目', description: '原有资料保留', status: 'active', workspace: '科研', createdAt: now, updatedAt: now });
    put('tasks', { id: 'task', title: '原任务', description: '完整保留的原说明', status: 'todo', priority: 'medium', projectId: 'p', workspace: '科研', dueAt: '2030-01-07', createdAt: now, updatedAt: now });
    put('notes', { id: 'evidence', title: '合成证据笔记', content: '原项目中的合成原文，不应因归档项目而改变。', projectId: 'p', workspace: '科研', kind: '笔记', createdAt: now, updatedAt: now });
    put('notes', { id: 'series', title: '原重复课程', kind: '日程', projectId: null, workspace: '课程', createdAt: now, updatedAt: now,
      content: JSON.stringify({ format: 'aibro.agenda.v1', title: '原重复课程', start, end: start + 3600000, timeZone: 'Asia/Shanghai',
        recurrence: { frequency: 'weekly', interval: 1, weekdays: [2, 4, 6], count: 12, until },
        excluded: [start + 2 * 86400000], completed: [start + 4 * 86400000], details: '保留已取消和已完成日期', reminderMinutes: null }) });
    put('conversations', { id: 'plan', title: '合成审阅会话', projectId: null, workspace: '科研', createdAt: now, updatedAt: now });
    const state = { schema: 1, records, cursor: 0, binding: null, settings: { model: { base: modelBase, model: 'synthetic-review', format: 'chat' } }, drafts: {}, blobs: {} };
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('aibro-mobile-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('state');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { const db = request.result, tx = db.transaction('state', 'readwrite'); tx.objectStore('state').put(state, 'workspace'); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
    });
    sessionStorage.setItem('aibro-web-session:live:model', 'synthetic-plan-key');
  }, { modelBase, start: START, until: UNTIL });
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
function pending(saved) {
  return Object.values(saved.records).map(record => record.data).find(data => data?.pendingPlan?.status === 'pending')?.pendingPlan;
}
async function selectChat(page) {
  await page.locator('nav [data-tab=chat]').click();
  if (await page.locator('[data-action=all-chats]').count()) await page.locator('[data-action=all-chats]').click();
  await page.locator('[data-action=conversation][data-id=plan]').click();
}
async function send(page, text) {
  await page.locator('#chat-text').fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('[data-action=review-plan]')).toBeVisible();
  await expect(page.locator('#live-response')).toHaveCount(0);
}
async function openReview(page, confirm) {
  await page.locator('[data-action=review-plan]').click();
  await expect(page.locator('#sheet')).toContainText('审阅 AI 修改');
  await expect(page.locator('.mobile-plan-root .mobile-plan-review')).toBeVisible();
  await expect(page.locator('#apply-plan')).toHaveText(confirm);
  await expect(page.locator('#reject-plan')).toBeVisible();
}
async function noOverflow(page) {
  const result = await page.evaluate(() => {
    const sheet = document.querySelector('#sheet[open]');
    return { width: innerWidth, scroll: document.documentElement.scrollWidth,
      sheet: sheet ? { width: sheet.clientWidth, scroll: sheet.scrollWidth } : null,
      preferences: [matchMedia('(prefers-color-scheme: dark)').matches, matchMedia('(prefers-reduced-motion: reduce)').matches] };
  });
  expect(result.preferences).toEqual([true, true]);
  expect(result.scroll, JSON.stringify(result)).toBeLessThanOrEqual(result.width);
  if (result.sheet) expect(result.sheet.scroll, JSON.stringify(result)).toBeLessThanOrEqual(result.sheet.width);
}
async function committedWrites(page) { return page.evaluate(() => window.__qaWorkspaceWrites); }

test('actual model tool plan creates project, child task and agenda in one approved durable commit', async ({ page }, testInfo) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await selectChat(page); await send(page, CREATE);
  await expect(page.locator('.messages')).not.toContainText('已经完成项目、任务和日程创建');
  const before = await state(page), plan = pending(before), projectID = plan.refMap.new_project.id;
  expect(plan.actions).toHaveLength(3);
  expect(plan.actions.slice(1).map(action => action.after.projectId)).toEqual([projectID, projectID]);
  expect(before.records['projects:' + projectID]).toBeUndefined();
  await openReview(page, '确认保存');
  await expect(page.locator('#sheet')).toContainText('合成计划');
  await expect(page.locator('#sheet')).toContainText('检查样本');
  await expect(page.locator('#sheet')).toContainText('合成组会');
  await noOverflow(page);
  await page.locator('.mobile-plan-review__data summary').first().click();
  await expect(page.locator('.mobile-plan-review__data').first()).toHaveAttribute('open', '');
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('create-project-children-dark-320.png'), fullPage: true });
  await page.evaluate(() => { window.__qaWorkspaceWrites = []; });
  await page.locator('#apply-plan').click();
  await expect(page.locator('#sheet')).not.toBeVisible();
  await expect(page.locator('.messages')).toContainText('已确认并保存 3 项修改');
  const writes = await committedWrites(page), keys = plan.actions.map(action => `${action.kind === 'agenda' ? 'notes' : action.kind}:${action.targetId}`);
  expect(writes).toHaveLength(1);
  expect(keys.every(key => writes[0][key]?.data && !writes[0][key].deleted)).toBe(true);
  expect(Object.values(writes[0]).find(record => record.data?.pendingPlan?.id === plan.id).data.pendingPlan.status).toBe('applied');
  await page.reload(); await selectChat(page);
  const after = await state(page);
  expect(keys.every(key => after.records[key]?.data)).toBe(true);
  expect(after.records[keys[1]].data.projectId).toBe(projectID);
  expect(after.records[keys[2]].data.projectId).toBe(projectID);
  await expect(page.locator('[data-action=review-plan]')).toHaveCount(0);
  expect(requests).toHaveLength(2);
  expect(requests[1].messages.some(message => message.role === 'tool' && message.content.includes('awaiting_user_review'))).toBe(true);
  expect(errors).toEqual([]);
});

test('model removal truthfully archives a project and recovers the exact task identity through real directory tools', async ({ page }, testInfo) => {
  await selectChat(page); const before = await state(page), task = before.records['tasks:task'].data, note = before.records['notes:evidence'];
  await send(page, REMOVE); await openReview(page, '确认执行');
  await expect(page.locator('#sheet')).toContainText('归档');
  await expect(page.locator('#sheet')).toContainText('回收站');
  await expect(page.locator('#sheet')).toContainText('保留');
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('remove-archive-dark-320.png'), fullPage: true });
  await page.locator('#apply-plan').click();
  await expect(page.locator('#sheet')).not.toBeVisible();
  const removed = await state(page), receipt = Object.values(removed.records).find(record => record.data?.pendingPlan?.status === 'applied').data.pendingPlan.receipts;
  expect(removed.records['tasks:task'].deleted).toBe(true);
  expect(removed.records['projects:p'].data.archived).toBe(true);
  expect(removed.records['notes:evidence']).toEqual(note);
  const recoveryKey = receipt.find(item => item.kind === 'tasks').recoveryKey;
  expect(removed.records[recoveryKey].data.data.tasks).toEqual([task]);
  await send(page, RESTORE); const plan = pending(await state(page));
  expect(plan.actions[1]).toMatchObject({ operation: 'restore', kind: 'trash', targetId: recoveryKey.split(':')[1] });
  await openReview(page, '确认执行');
  await expect(page.locator('#sheet')).toContainText('恢复');
  await expect(page.locator('#sheet')).toContainText('原任务');
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('restore-original-ids-dark-320.png'), fullPage: true });
  await page.locator('#apply-plan').click();
  await expect(page.locator('#sheet')).not.toBeVisible();
  await page.reload(); await selectChat(page);
  const recovered = await state(page);
  expect(recovered.records['tasks:task'].data).toEqual(task);
  expect(recovered.records['projects:p'].data.archived).toBe(false);
  expect(recovered.records[recoveryKey].deleted).toBe(true);
  const applied = Object.values(recovered.records).find(record => record.data?.pendingPlan?.id === plan.id).data.pendingPlan;
  expect(applied.receipts[1].restored).toEqual([{ key: 'tasks:task', kind: 'tasks', id: 'task', title: '原任务' }]);
  expect(requests.some(body => body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'recovery-directory' && message.content.includes(recoveryKey)))).toBe(true);
});

test('a task manually changed after proposal makes the entire stale plan refuse approval', async ({ page }) => {
  await selectChat(page); await send(page, STALE);
  const plan = pending(await state(page));
  await page.locator('nav [data-tab=today]').click();
  await page.locator('[data-action=task][data-id=task]').click();
  await page.locator('#task-form [name=title]').fill('人工保留的新名称');
  await page.getByRole('button', { name: '保存任务', exact: true }).click();
  await selectChat(page);
  await page.locator('[data-action=review-plan]').click();
  await expect(page.locator('#toast')).toContainText('重新审阅');
  await expect(page.locator('#apply-plan')).toHaveCount(0);
  const saved = await state(page);
  expect(saved.records['tasks:task'].data.title).toBe('人工保留的新名称');
  expect(saved.records['tasks:' + plan.actions[1].targetId]).toBeUndefined();
  expect(pending(saved).status).toBe('pending');
});

test('manual recurrence form edits the whole series without flattening rules or losing excluded/completed dates', async ({ page }, testInfo) => {
  await page.locator('[data-action=event][data-id=series]').click();
  const form = page.locator('#event-form');
  await expect(form).toContainText('整个重复系列');
  await expect(form.locator('[name=frequency]')).toHaveValue('weekly');
  await expect(form.locator('[name=repeatInterval]')).toHaveValue('1');
  await expect(form.locator('[name=repeatCount]')).toHaveValue('12');
  await expect(form.locator('[name=repeatUntil]')).toHaveValue('2030-02-01T08:00');
  expect(await form.locator('[name=repeatDay]:checked').evaluateAll(inputs => inputs.map(input => Number(input.value)))).toEqual([2, 4, 6]);
  await form.locator('[name=start]').fill('2030-01-07T09:00');
  await form.locator('[name=end]').fill('2030-01-07T10:00');
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('repeat-series-form-dark-320.png'), fullPage: true });
  await page.getByRole('button', { name: '保存日程', exact: true }).click();
  await expect(page.locator('#sheet')).not.toBeVisible();
  const saved = JSON.parse((await state(page)).records['notes:series'].data.content);
  expect(saved.start).toBe(START + 3600000); expect(saved.end).toBe(START + 7200000);
  expect(saved.recurrence).toEqual({ frequency: 'weekly', interval: 1, weekdays: [2, 4, 6], count: 12, until: UNTIL + 3600000 });
  expect(saved.excluded).toEqual([START + 2 * 86400000 + 3600000]);
  expect(saved.completed).toEqual([START + 4 * 86400000 + 3600000]);
  await page.reload();
  await page.locator('[data-action=event][data-id=series]').click();
  await expect(page.locator('#event-form [name=frequency]')).toHaveValue('weekly');
  await expect(page.locator('#event-form [name=start]')).toHaveValue('2030-01-07T09:00');
  await expect(page.locator('#event-form [name=repeatUntil]')).toHaveValue('2030-02-01T09:00');
});

test('manual form creates a repeated calendar from a note with explicit weekdays and end conditions', async ({ page }) => {
  await page.locator('nav [data-tab=knowledge]').click();
  await page.locator('[data-action=note][data-id=evidence]').click();
  await page.locator('[data-action=from-note]').click();
  const form = page.locator('#event-form');
  await form.locator('[name=title]').fill('手工重复安排');
  await form.locator('[name=start]').fill('2030-01-07T10:00');
  await form.locator('[name=end]').fill('2030-01-07T11:00');
  await form.locator('[name=frequency]').selectOption('weekly');
  for (const input of await form.locator('[name=repeatDay]').all()) await input.uncheck();
  await form.locator('[name=repeatDay][value="2"]').check();
  await form.locator('[name=repeatDay][value="4"]').check();
  await form.locator('[name=repeatCount]').fill('4');
  await form.locator('[name=repeatUntil]').fill('2030-01-16T10:00');
  await noOverflow(page);
  await page.getByRole('button', { name: '添加日程', exact: true }).click();
  await expect(page.locator('#sheet')).not.toBeVisible();
  const note = Object.values((await state(page)).records).find(record => record.data?.title === '手工重复安排').data;
  const event = JSON.parse(note.content);
  expect(event.recurrence).toEqual({ frequency: 'weekly', interval: 1, weekdays: [2, 4], count: 4, until: Date.parse('2030-01-16T10:00:00+08:00') });
  expect(event.sourceNoteIds).toEqual(['evidence']);
  expect(note.kind).toBe('日程');
});
