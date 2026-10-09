// Isolated browser input/layout acceptance. Viewport resizing is controlled here;
// physical keyboard/IME candidate UI still requires native device acceptance.
import { test, expect } from '@playwright/test';
const APP = 'http://127.0.0.1:8899';
const MODEL = 'deepseek-v4.1-flash-private-research-long-model-name';
const DRAFT = Array.from({ length: 12 }, (_, i) => `第 ${i + 1} 行中文草稿🙂，保留输入与选区。`).join('\n');
test.use({ isMobile: true, hasTouch: true, locale: 'zh-CN', serviceWorkers: 'block' });

async function seed(page) {
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.fallback() : route.abort());
  await page.route('**/__composer_fixture', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><title>isolated composer fixture</title>' }));
  await page.goto(APP + '/__composer_fixture');
  await page.evaluate(async ({ model, draft }) => {
    const { Store, MemoryAdapter, IndexedAdapter, addMessage } = await import('/src/store.js');
    const { createConversationContext } = await import('/src/conversation-context.js');
    const store = await new Store(new MemoryAdapter()).load();
    const keys = [];
    for (let i = 0; i < 50; i++) { const id = `ref-${i}`; keys.push('notes:' + id); await store.put('notes', { id, kind: '笔记', title: '合成资料 ' + i, content: '仅测试引用计数', workspace: '科研' }); }
    await store.put('conversations', { id: 'layout', title: '较长的合成会话标题：检查中文输入与窄屏布局', mobileContext: createConversationContext(keys) });
    await addMessage(store, 'layout', 'assistant', '这是一段合成回答，供继续讨论。');
    await store.tx(s => {
      s.settings.model = { model, base: 'https://fixture.invalid/v1', format: 'chat' };
      s.drafts['home:new'] = draft; s.drafts['chat:layout'] = draft;
    });
    await new IndexedAdapter().write(store.state);
  }, { model: MODEL, draft: DRAFT });
  await page.goto(APP); await expect(page.locator('#home-chat-text')).toBeVisible();
}

async function retainedInput(page, selector) {
  const input = page.locator(selector);
  await input.focus();
  await input.evaluate(el => {
    window.composerIdentity047 = el; el.setSelectionRange(4, 9);
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中文' }));
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: '中文', isComposing: true }));
  });
  await expect.poll(() => input.evaluate(el => ({ same: el === window.composerIdentity047,
    focused: el === document.activeElement, start: el.selectionStart, end: el.selectionEnd })))
    .toEqual({ same: true, focused: true, start: 4, end: 9 });
  return input;
}
async function endComposition(input) {
  await input.evaluate(el => { el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }));
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '中文' })); });
}

for (const width of [320, 390]) {
  test(`home and conversation composers retain input and fit ${width}px with ${width === 320 ? 'dark reduced motion' : 'light'} layout`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ colorScheme: width === 320 ? 'dark' : 'light', reducedMotion: width === 320 ? 'reduce' : 'no-preference' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await seed(page);
    const home = page.locator('#home-chat-text');
    await expect(home).toHaveValue(DRAFT);
    await expect.poll(() => home.evaluate(el => el.getBoundingClientRect().height)).toBe(180);
    await retainedInput(page, '#home-chat-text');
    await page.setViewportSize({ width, height: 480 });
    await expect(page.locator('body')).toHaveClass(/keyboard-open/);
    await expect(page.locator('nav')).not.toBeVisible();
    await expect.poll(() => home.evaluate(el => el.getBoundingClientRect().height)).toBe(144);
    expect(await home.evaluate(el => el === window.composerIdentity047 && el === document.activeElement && el.selectionStart === 4 && el.selectionEnd === 9)).toBe(true);
    await endComposition(home); await home.fill('短草稿');
    await expect.poll(() => home.evaluate(el => el.getBoundingClientRect().height === parseFloat(getComputedStyle(el).minHeight))).toBe(true);
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator('body')).not.toHaveClass(/keyboard-open/);
    await expect(page.locator('nav')).toBeVisible();
    await home.blur(); await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: info.outputPath(`home-composer-${width}.png`), animations: 'disabled' });

    await page.locator('nav [data-tab=chat]').click();
    await page.locator('[data-action=conversation][data-id=layout]').click();
    const chat = page.locator('#chat-text');
    await expect(chat).toHaveValue(DRAFT);
    await expect(page.locator('main > .page-title')).not.toBeVisible();
    await expect(page.locator('.conversation-bar')).toContainText('较长的合成会话标题');
    await expect(page.locator('.composer-meta .context-count')).toHaveText('50 项引用');
    await expect(page.locator('.model-chip')).toHaveAttribute('title', MODEL);
    await expect(page.locator('.model-chip')).toHaveAttribute('aria-label', '模型设置：' + MODEL);
    expect(await page.locator('.composer-bottom > button').evaluateAll(buttons => buttons.every(el => {
      const r = el.getBoundingClientRect(); return r.width >= 44 && r.height >= 44;
    }))).toBe(true);
    expect(await page.locator('.composer-meta').evaluate(el => {
      const scope = el.querySelector('.context-count'), model = el.querySelector('.model-chip');
      const sr = scope.getBoundingClientRect(), mr = model.getBoundingClientRect(), r = el.getBoundingClientRect();
      return scope.scrollWidth <= scope.clientWidth + 1 && sr.right <= mr.left && mr.width >= 100 && mr.right <= r.right + 1;
    })).toBe(true);
    await expect.poll(() => chat.evaluate(el => el.getBoundingClientRect().height)).toBe(180);
    await retainedInput(page, '#chat-text');
    await page.setViewportSize({ width, height: 480 });
    await expect(page.locator('body')).toHaveClass(/keyboard-open/);
    await expect.poll(() => chat.evaluate(el => el.getBoundingClientRect().height)).toBe(144);
    expect(await chat.evaluate(el => el === window.composerIdentity047 && el === document.activeElement && el.selectionStart === 4 && el.selectionEnd === 9)).toBe(true);
    await endComposition(chat); await chat.fill('保留中文🙂短草稿');
    await expect.poll(() => chat.evaluate(el => el.getBoundingClientRect().height)).toBe(64);
    const bounds = await page.locator('#chat-form').evaluate(el => {
      const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: innerHeight, width: innerWidth };
    });
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.height); expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(width);
    await page.screenshot({ path: info.outputPath(`chat-composer-keyboard-${width}.png`), animations: 'disabled' });
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator('nav')).toBeVisible();
    await expect(chat).toHaveValue('保留中文🙂短草稿');
    await chat.blur(); await page.evaluate(() => scrollTo(0, 0));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`chat-composer-${width}.png`), animations: 'disabled' });
    expect(errors).toEqual([]);
  });
}
