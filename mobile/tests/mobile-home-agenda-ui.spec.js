// Browser development acceptance only. Every test owns an empty browser context;
// no real account, model key, workspace, native device or notification is used.
import { test, expect } from '@playwright/test';

const APP = 'http://127.0.0.1:8899';
const prompt = '明天下午三点打篮球，帮我新建日程';
const now = new Date('2030-01-01T12:00:00+08:00');
const start = Date.parse('2030-01-02T15:00:00+08:00');
const end = Date.parse('2030-01-02T16:00:00+08:00');

test.use({ viewport: { width: 320, height: 720 }, isMobile: true, hasTouch: true,
  locale: 'zh-CN', timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' });
test.setTimeout(60000);

async function state(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('aibro-mobile-v1', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('state');
      const get = tx.objectStore('state').get('workspace');
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
      tx.oncomplete = () => db.close();
    };
  }));
}
const agendaRecords = saved => Object.entries(saved.records)
  .filter(([key, record]) => key.startsWith('notes:') && !record.deleted && record.data.kind === '日程');

async function noOverflow(page) {
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  expect(dimensions.scroll, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.width);
}

test('320px home creates an exact-time agenda proposal without a model and saves the same event once', async ({ page }, testInfo) => {
  const errors = [], external = [], modelRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/\/(chat\/completions|responses|audio\/transcriptions|multimodal-generation)\/?$/.test(new URL(request.url()).pathname)) modelRequests.push(request.url());
  });
  await page.route('**/__synthetic_agenda_blank', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>isolated agenda fixture</title>' }));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || url.protocol === 'data:') return route.fallback();
    external.push(url.origin);
    return route.abort('blockedbyclient');
  });
  // Only Date is fixed; UI timers, IndexedDB and animation continue normally.
  await page.clock.setFixedTime(now);
  await page.goto(APP + '/__synthetic_agenda_blank', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    const empty = { schema: 1, records: {}, cursor: 0, binding: null, settings: {}, drafts: {}, blobs: {} };
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('aibro-mobile-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('state');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('state', 'readwrite');
        tx.objectStore('state').put(empty, 'workspace');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  });
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('nav [data-tab=today]')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#home-chat-form')).toBeVisible();
  await expect(page.getByRole('button', { name: '语音新会话', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '键盘输入', exact: true })).toBeVisible();
  await expect(page.locator('#home-planner-root .mobile-planner')).toBeVisible();
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('home-empty-320.png'), fullPage: true, animations: 'disabled' });

  await page.getByRole('textbox', { name: '给 AI Bro 的新消息', exact: true }).fill(prompt);
  await page.getByRole('button', { name: '发送新会话', exact: true }).click();
  await expect(page.locator('.message.user')).toContainText(prompt);
  await expect(page.locator('.message.assistant')).toContainText('2030/01/02 15:00');
  await expect(page.locator('.message.assistant')).toContainText('2030/01/02 16:00');
  await expect(page.locator('.message.assistant')).toContainText('未指定时长，暂按 1 小时');
  await expect(page.locator('[data-action=review-plan]')).toBeVisible();
  let saved = await state(page);
  expect(saved.settings.model).toBeUndefined();
  expect(Object.values(saved.records).find(r => r.data?.title === prompt)).toBeTruthy();
  expect(saved.drafts["home:new"]).toBe("");
  expect(agendaRecords(saved)).toHaveLength(0);
  expect(Object.keys(saved.records).filter(key => key.startsWith('tasks:'))).toHaveLength(0);
  const proposal = Object.values(saved.records).find(record => record.data?.pendingPlan)?.data.pendingPlan;
  expect(proposal.status).toBe('pending');
  expect(proposal.actions).toHaveLength(1);
  expect(proposal.actions[0].kind).toBe('agenda');
  const plannedNote = proposal.actions[0].after;
  expect(JSON.parse(plannedNote.content)).toMatchObject({ title: '打篮球', start, end, timeZone: 'Asia/Shanghai', reminderMinutes: null });

  await page.getByRole('button', { name: '审阅 1 项修改', exact: true }).click();
  await expect(page.locator('#sheet .mobile-plan-review__item h3')).toContainText('打篮球');
  const reviewTime = page.locator('#sheet .mobile-plan-review__fields');
  await expect(reviewTime).toContainText('2030年1月2日 15:00');
  await expect(reviewTime).toContainText('2030年1月2日 16:00');
  await expect(reviewTime).toContainText('Asia/Shanghai');
  await expect(reviewTime).toContainText('不提醒');
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('agenda-proposal-320.png'), animations: 'disabled' });
  expect(agendaRecords(await state(page))).toHaveLength(0);
  await page.getByRole('button', { name: '确认保存', exact: true }).click();
  await expect(page.locator('#sheet')).not.toBeVisible();
  await expect(page.locator('.message.assistant')).toContainText('日程「打篮球」已保存到本机');
  saved = await state(page);
  expect(agendaRecords(saved)).toHaveLength(1);
  expect(agendaRecords(saved)[0][0]).toBe('notes:' + plannedNote.id);
  expect(JSON.parse(agendaRecords(saved)[0][1].data.content)).toMatchObject({ title: '打篮球', start, end, timeZone: 'Asia/Shanghai' });

  await page.locator('nav [data-tab=today]').click();
  await page.locator('#home-planner-root [data-planner-day="2030-01-02"]').click();
  const event = page.locator(`#home-planner-root [data-planner-type="event"][data-planner-id="${plannedNote.id}"]`);
  await expect(event).toHaveCount(1);
  await expect(event).toContainText('打篮球');
  await expect(event.locator('.mobile-planner__time strong')).toHaveText('15:00');
  await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('agenda-saved-320.png'), fullPage: true, animations: 'disabled' });
  await event.click();
  await expect(page.locator('#event-form [name=start]')).toHaveValue('2030-01-02T15:00');
  await expect(page.locator('#event-form [name=end]')).toHaveValue('2030-01-02T16:00');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('nav [data-tab=today]').click();
  await page.locator('#home-planner-root [data-planner-day="2030-01-02"]').click();
  await expect(event).toHaveCount(1);
  expect(agendaRecords(await state(page))).toHaveLength(1);
  expect(external).toEqual([]);
  expect(modelRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('home draft survives navigation, date change and reload, with no new conversation', async ({page}) => {
  await page.goto(APP);
  const input=page.locator('#home-chat-text');
  await input.fill('先记下想法，暂时不发给 AI。');
  await expect.poll(async()=>(await state(page)).drafts['home:new']).toBe('先记下想法，暂时不发给 AI。');
  await page.locator('nav [data-tab=knowledge]').click();
  await page.locator('nav [data-tab=today]').click();
  await expect(input).toHaveValue('先记下想法，暂时不发给 AI。');
  await page.locator('#home-planner-root [data-planner-day]').first().click();
  await expect(input).toHaveValue('先记下想法，暂时不发给 AI。');
  await page.reload(); await expect(input).toHaveValue('先记下想法，暂时不发给 AI。');
  expect(Object.keys((await state(page)).records).filter(k=>k.startsWith('conversations:'))).toHaveLength(0);
});
