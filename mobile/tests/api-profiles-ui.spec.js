// Development DOM/Kit check only. Isolated browser storage and synthetic HTTP;
// this does not assert native IME, Keystore/Keychain or device acceptance.
import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
const APP = 'http://127.0.0.1:8899';
test.use({ viewport: { width: 320, height: 780 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
test.setTimeout(45000);
async function state(page) { return page.evaluate(async () => (await import('/src/store.js')).IndexedAdapter.prototype.read.call(new (await import('/src/store.js')).IndexedAdapter())); }
async function settings(page) {
  await page.goto(APP); await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.locator('#api-chat-profiles')).toHaveAttribute('data-halaska-root', /.+/);
  await expect(page.locator('#api-speech-profiles')).toHaveAttribute('data-halaska-root', /.+/);
  expect(await page.locator('.settings-card input:not([type=checkbox]):not([type=hidden]), .settings-card textarea, .settings-card select')
    .evaluateAll(elements => elements.every(element => parseFloat(getComputedStyle(element).fontSize) >= 16))).toBe(true);
}
async function fill(form, values) { for (const [name, value] of Object.entries(values)) await form.locator(`[name=${name}]`).fill(value); }
test('in-flight profile save survives actual settings navigation and updates only the current form', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  // Hold the actual offline Kit script, not its Vite URL export, to expose the
  // cold-mount window while the plain settings markup is already visible.
  let releaseKit, blockedScripts = 0;
  const kitGate = new Promise(resolve => { releaseKit = resolve; });
  await page.route(/\/halaska-ui\.js(?:\?|$)/, async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.has('url') || url.searchParams.has('import')) return route.continue();
    blockedScripts++; await kitGate; return route.continue();
  });
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  try {
    await expect.poll(() => blockedScripts).toBeGreaterThan(0);
    for (const formID of ['model-form', 'speech-form']) {
      await expect(page.locator(`#${formID} [name=profileName]`)).toBeDisabled();
      await expect(page.locator(`#${formID} button[type=submit]`)).toBeDisabled();
    }
    await page.evaluate(() => document.querySelector('#model-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    // A fresh workspace has no durable row until its first real mutation.
    expect((await state(page))?.settings?.apiProfiles?.chat).toBeUndefined();
  } finally { releaseKit(); }
  await expect(page.locator('#api-chat-profiles')).toHaveAttribute('data-halaska-root', /.+/);
  await expect(page.locator('#api-speech-profiles')).toHaveAttribute('data-halaska-root', /.+/);
  await expect(page.locator('#model-form [name=profileName]')).toBeEnabled();
  await expect(page.locator('#speech-form [name=profileName]')).toBeEnabled();
  // Delay only the real credential boundary. All navigation, forms, editor,
  // encrypted tab vault and Store transactions remain the production path.
  await page.evaluate(async () => {
    const { vault } = await import('/src/platform.js'), original = vault.set;
    const gate = { started: false, calls: 0 }; let release;
    const pending = new Promise(resolve => { release = resolve; });
    gate.release = () => { vault.set = original; release(); };
    window.__apiProfileSaveGate = gate;
    vault.set = async (key, value) => {
      if (key === 'model') { gate.started = true; gate.calls++; await pending; }
      return original(key, value);
    };
  });
  const form = page.locator('#model-form'), control = page.locator('#api-chat-profiles');
  await fill(form, { profileName: '异步保存的模型', base: 'https://profile-lifecycle.example.test/v1', model: 'pending-model', key: 'synthetic-pending-key' });
  await form.getByRole('button', { name: '保存并使用模型方案', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__apiProfileSaveGate.started)).toBe(true);
  await page.locator('nav [data-tab=today]').click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(control).toHaveAttribute('data-halaska-root', /.+/);
  await expect(form.locator('[name=model]')).toBeDisabled();
  await expect(form.locator('[name=model]')).toHaveValue('pending-model');
  await expect(control.getByText('正在保存方案…', { exact: true })).toBeVisible();
  await expect(form.getByRole('button', { name: '保存并使用模型方案', exact: true })).toBeDisabled();
  await page.evaluate(() => window.__apiProfileSaveGate.release());
  await expect(control.locator('[data-api-active]')).toHaveText('当前启用：异步保存的模型');
  await expect(control.locator('.api-profile-message')).toHaveText('方案已保存并启用。');
  await expect(form.locator('[name=model]')).toBeEnabled();
  await expect(form.locator('[name=key]')).toHaveValue('');
  const saved = await state(page);
  await expect(form.locator('[name=profileId]')).toHaveValue(saved.settings.apiProfileSelection.chat);
  expect(saved.settings.apiProfiles.chat).toHaveLength(1);
  expect(JSON.stringify(saved)).not.toContain('synthetic-pending-key');
  expect(await page.evaluate(() => window.__apiProfileSaveGate.calls)).toBe(1);
  expect(errors).toEqual([]);
});
test('real settings preserves multiple scheme drafts and switches only explicitly, with no keys in durable Store', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message)); await settings(page);
  const form = page.locator('#model-form'), control = page.locator('#api-chat-profiles');
  await fill(form, { profileName: '模型甲', base: 'https://a.example.test/v1', model: 'model-a', key: 'synthetic-key-a' });
  await form.getByRole('button', { name: '保存并使用模型方案', exact: true }).click();
  await expect(control.locator('[data-api-active]')).toHaveText('当前启用：模型甲');
  const a = (await state(page)).settings.apiProfileSelection.chat;
  await page.locator('#api-chat-new').click();
  await fill(form, { profileName: '模型乙', base: 'https://b.example.test/v1', model: 'model-b', key: 'synthetic-key-b' });
  await form.getByRole('button', { name: '保存并使用模型方案', exact: true }).click();
  await expect(control.locator('[data-api-active]')).toHaveText('当前启用：模型乙');
  const b = (await state(page)).settings.apiProfileSelection.chat;
  await control.getByRole('combobox').selectOption(a); await expect(form.locator('[name=model]')).toHaveValue('model-a');
  await form.locator('[name=model]').fill('甲未保存🙂'); await page.locator('#api-chat-use').click();
  await expect(control.locator('.api-profile-message')).toContainText('未保存');
  expect((await state(page)).settings.apiProfileSelection.chat).toBe(b);
  await page.locator('#api-chat-new').click();
  await fill(form, { profileName: '未保存的新方案', base: 'https://c.example.test/v1', model: 'model-c-draft', key: 'synthetic-draft-key' });
  await control.getByRole('combobox').selectOption(b); await control.getByRole('combobox').selectOption('');
  await expect(form.locator('[name=model]')).toHaveValue('model-c-draft'); await expect(form.locator('[name=key]')).toHaveValue('synthetic-draft-key');
  // Leaving settings retains all scheme drafts, not only the last selected one.
  await page.locator('nav [data-tab=today]').click(); await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.locator('#api-chat-profiles')).toHaveAttribute('data-halaska-root', /.+/);
  await expect(form.locator('[name=model]')).toHaveValue('model-c-draft');
  await control.getByRole('combobox').selectOption(a); await expect(form.locator('[name=model]')).toHaveValue('甲未保存🙂');
  await control.getByRole('combobox').selectOption('');
  const persisted = JSON.stringify(await state(page)); expect(persisted).not.toContain('synthetic-key-'); expect(persisted).not.toContain('synthetic-draft-key');
  await page.reload(); await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(control).toHaveAttribute('data-halaska-root', /.+/); await control.getByRole('combobox').selectOption('');
  await expect(form.locator('[name=model]')).toHaveValue('model-c-draft'); await expect(form.locator('[name=key]')).toHaveValue('');
  await control.getByRole('combobox').selectOption(a); await expect(form.locator('[name=model]')).toHaveValue('甲未保存🙂');
  // Explicit save reuses only this scheme's matching endpoint credential.
  await form.getByRole('button', { name: '保存并使用模型方案', exact: true }).click();
  await expect(control.locator('[data-api-active]')).toHaveText('当前启用：模型甲');
  await expect(page.locator('#api-chat-remove')).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mkdir('build/api-profiles-ui', { recursive: true }); await control.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'build/api-profiles-ui/chat-320.png' }); expect(errors).toEqual([]);
});
test('actual speech test submits edited scheme silent audio without saving or changing active profile', async ({ page }) => {
  const calls = []; let wrongShape = false;
  await page.route('https://speech-profile.example.test/**', route => {
    const request = route.request(); calls.push({ url: request.url(), authorization: request.headers().authorization, body: request.postDataBuffer() });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(wrongShape ? { ok: true } : { text: '' }) });
  });
  await settings(page); const form = page.locator('#speech-form'), control = page.locator('#api-speech-profiles');
  await form.locator('[name=provider]').selectOption('openai');
  await fill(form, { profileName: '语音甲', base: 'https://speech-profile.example.test/v1', model: 'asr-a', key: 'synthetic-asr-a' });
  await form.getByRole('button', { name: '保存并使用语音方案', exact: true }).click();
  await expect(control.locator('[data-api-active]')).toHaveText('当前启用：语音甲'); const a = (await state(page)).settings.apiProfileSelection.speech;
  await page.locator('#api-speech-new').click(); await form.locator('[name=provider]').selectOption('openai');
  await fill(form, { profileName: '语音乙', base: 'https://speech-profile.example.test/second', model: 'asr-b', key: 'synthetic-asr-b' });
  await form.getByRole('button', { name: '保存并使用语音方案', exact: true }).click();
  await expect(control.locator('[data-api-active]')).toHaveText('当前启用：语音乙'); const before = (await state(page)).settings;
  await control.getByRole('combobox').selectOption(a); await page.locator('#api-speech-test').click();
  await expect(control.locator('.api-profile-message')).toContainText('服务已接受测试音频');
  expect(calls).toHaveLength(1); expect(calls[0].url).toBe('https://speech-profile.example.test/v1/audio/transcriptions');
  expect(calls[0].authorization).toBe('Bearer synthetic-asr-a'); expect(calls[0].body.includes(Buffer.from('RIFF'))).toBe(true);
  expect((await state(page)).settings).toEqual(before);
  wrongShape = true; await page.locator('#api-speech-test').click(); await expect(control.locator('.api-profile-message')).toContainText('接口不匹配');
  await form.locator('[name=base]').fill('https://speech-profile.example.test/unmatched');
  await page.locator('#api-speech-test').click(); await expect(control.locator('.api-profile-message')).toContainText('API Key'); expect(calls).toHaveLength(2);
  await page.emulateMedia({ colorScheme: 'dark' }); await control.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await mkdir('build/api-profiles-ui', { recursive: true }); await page.screenshot({ path: 'build/api-profiles-ui/speech-dark-320.png' });
});
