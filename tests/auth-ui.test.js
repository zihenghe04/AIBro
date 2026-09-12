const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/auth-ui.js'), 'utf8');

// No network or account session is used. These doubles implement the form
// operations used by the real controller; fetch responses and polling are
// independently controlled so races are reproducible.
class Element {
  constructor(value = '') {
    this.value = value; this.hidden = false; this.disabled = false; this.textContent = '';
    this.href = ''; this.options = []; this.listeners = {}; this.clicks = 0;
    const classes = new Set();
    this.classList = { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); }, contains: name => classes.has(name) };
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type) { return Promise.all((this.listeners[type] || []).map(fn => fn({ target: this }))); }
  click() { if (this.disabled) return Promise.resolve(); this.clicks++; return this.dispatch('click'); }
  replaceChildren(...children) { this.options = children; this.value = children[0]?.value || ''; }
  add(option) { this.options.push(option); }
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness({ stored = {}, initialState = {}, desktop = false, integration = false } = {}) {
  const ids = ['provider','model','apiBase','apiKey','composerModel','apiCredentials','openaiAuthPanel','openaiAuthStatus','openaiAccountDetails','openaiSignIn','openaiCancelLogin','openaiSignOut','openaiRefreshStatus','openaiLoginLink','openaiModel','openaiAuthHelp'];
  const nodes = Object.fromEntries(ids.map(id => [id, new Element()]));
  nodes.provider.value = 'api'; nodes.openaiModel.options = [{ value: '', text: '账号默认模型' }];
  const storage = new Map(Object.entries(stored)); const calls = []; const queues = new Map(); const timers = new Map(); const opened = []; const toasts = [];
  let nextTimer = 0; let saves = 0;
  const state = { settings: { permissions: {}, ...initialState.settings }, ...initialState };
  const context = {
    document: { getElementById: id => nodes[id] || null },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    URL, AbortController,
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: async (path, options) => {
      calls.push({ path, method: options.method, body: options.body && JSON.parse(options.body) });
      const handler = queues.get(path)?.shift();
      if (!handler) throw new Error(`Unexpected request: ${path}`);
      const response = await handler(options);
      return { ok: response.status === undefined || response.status < 400, status: response.status || 200, json: async () => response.body };
    },
    state,
    save: () => saves++,
    toast: value => toasts.push(value),
    $: selector => nodes[selector.slice(1)] || null,
    $$: () => []
  };
  if (desktop) context.workstationDesktop = { openAuthURL: async url => { opened.push(url); } };
  context.window = context;
  vm.createContext(context); vm.runInContext(source, context);
  let integrationInit;
  if (integration) {
    const appSource = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
    for (const name of ['defaultModelConfiguration', 'syncComposerModel', 'renderSettings']) {
      const start = appSource.indexOf(`function ${name}(`);
      if (start < 0) continue;
      const rest = appSource.slice(start);
      const next = rest.search(/\n(?:async )?function /);
      vm.runInContext(rest.slice(0, next < 0 ? undefined : next), context);
    }
    integrationInit = appSource.split('\n').find(line => line.startsWith('window.OpenAIAuth?.init('));
    assert.ok(integrationInit, 'account controller registration should be present');
  }
  const api = context.OpenAIAuth;
  const queue = (path, body, status = 200) => { const handlers = queues.get(path) || []; handlers.push(typeof body === 'function' ? body : async () => ({ body, status })); queues.set(path, handlers); };
  const init = () => integration ? vm.runInContext(integrationInit, context) : api.init({ getState: () => state, save: () => saves++, toast: value => toasts.push(value), onChange: () => api.render() });
  const change = async (id, value) => { nodes[id].value = value; await nodes[id].dispatch('change'); await flush(); };
  const tick = async ms => { for (const [id, timer] of [...timers]) { if (timer.ms === ms) { timers.delete(id); await timer.fn(); } } await flush(); };
  return { api, nodes, storage, calls, timers, opened, toasts, state, queue, init, change, tick, saves: () => saves };
}

const signedOut = { available: true, authenticated: false };
const account = { available: true, authenticated: true, account: { email: 'ui-test@example.invalid', planType: 'test' } };

test('provider switching isolates account panel and preserves unsaved API fields through the app settings callback', async () => {
  const h = harness({ integration: true, stored: { 'workstation-api-base': 'https://saved.example.invalid/v1', 'workstation-api-key': 'saved-test-value', 'workstation-api-model': 'saved-model' } });
  h.init();
  h.nodes.apiBase.value = 'https://unsaved.example.invalid/v1'; h.nodes.apiKey.value = 'unsaved-test-value'; h.nodes.model.value = 'unsaved-model';
  h.queue('/__auth/status', signedOut);
  await h.change('provider', 'openai-auth');
  assert.equal(h.nodes.apiCredentials.hidden, true); assert.equal(h.nodes.openaiAuthPanel.hidden, false);
  assert.equal(h.storage.get('workstation-provider'), 'openai-auth');
  await h.change('provider', 'api');
  assert.equal(h.nodes.apiCredentials.hidden, false); assert.equal(h.nodes.openaiAuthPanel.hidden, true);
  assert.equal(h.nodes.apiBase.value, 'https://unsaved.example.invalid/v1');
  assert.equal(h.nodes.apiKey.value, 'unsaved-test-value'); assert.equal(h.nodes.model.value, 'unsaved-model');
  assert.equal(h.calls.filter(call => call.path === '/__auth/status').length, 1);
});

test('sign in transitions pending to authenticated with models and one external login opening', async () => {
  const h = harness({ desktop: true }); h.init(); h.queue('/__auth/status', signedOut); await h.change('provider','openai-auth');
  const login = deferred(); h.queue('/__auth/login', () => login.promise);
  const first = h.nodes.openaiSignIn.dispatch('click'); const duplicate = h.nodes.openaiSignIn.dispatch('click');
  assert.equal(h.nodes.openaiSignIn.disabled, true); assert.equal(h.nodes.openaiRefreshStatus.disabled, true);
  assert.equal(h.calls.filter(call => call.path === '/__auth/login').length, 1);
  login.resolve({ body: { authUrl: 'https://auth.openai.com/authorize?state=ui-test', loginId: 'isolated-test-login' } }); await first; await duplicate;
  assert.equal(h.nodes.openaiSignIn.hidden, true); assert.equal(h.nodes.openaiCancelLogin.hidden, false);
  assert.equal(h.nodes.openaiLoginLink.hidden, false); assert.equal(h.opened.length, 1);
  h.queue('/__auth/status', account); h.queue('/__auth/models', { data: [{ id: 'test-model', displayName: 'Test Model' }] }); await h.tick(1800);
  assert.equal(h.nodes.openaiSignOut.hidden, false); assert.equal(h.nodes.openaiCancelLogin.hidden, true); assert.equal(h.nodes.openaiLoginLink.hidden, true);
  assert.equal(h.nodes.openaiModel.disabled, false); assert.equal(h.nodes.openaiModel.options.length, 2);
  assert.match(h.nodes.openaiAccountDetails.textContent, /ui-test@example\.invalid/); assert.equal(h.toasts.length, 1);
  assert.equal([...h.timers.values()].filter(timer => timer.ms === 1800).length, 0);
});

test('cancel and logout call only the account lifecycle endpoints and stop pending polling', async () => {
  const h = harness(); h.init(); h.queue('/__auth/status', signedOut); await h.change('provider','openai-auth');
  h.queue('/__auth/login', { authUrl: 'https://auth.openai.com/authorize?state=test', loginId: 'cancel-me' }); await h.nodes.openaiSignIn.click();
  assert.equal(h.nodes.openaiLoginLink.clicks, 1);
  h.queue('/__auth/cancel', { cancelled: true }); h.queue('/__auth/status', signedOut); await h.nodes.openaiCancelLogin.click();
  assert.deepEqual(h.calls.find(call => call.path === '/__auth/cancel').body, { loginId: 'cancel-me' });
  assert.equal(h.nodes.openaiCancelLogin.hidden, true); assert.equal(h.nodes.openaiSignIn.hidden, false);
  assert.equal([...h.timers.values()].filter(timer => timer.ms === 1800).length, 0);
  h.queue('/__auth/status', account); h.queue('/__auth/models', { data: [{ id: 'test-model' }] }); await h.nodes.openaiRefreshStatus.click();
  h.queue('/__auth/logout', {}); h.queue('/__auth/status', signedOut); await h.nodes.openaiSignOut.click();
  assert.equal(h.nodes.openaiSignOut.hidden, true); assert.equal(h.nodes.openaiModel.disabled, true); assert.match(h.nodes.openaiAuthStatus.textContent, /尚未登录/);
  assert.equal(h.calls.some(call => /proxy|responses/.test(call.path)), false);
});

test('unavailable runtime, HTTP errors and invalid login URLs show recoverable errors', async () => {
  const h = harness(); h.init(); h.queue('/__auth/status', { available: false, authenticated: false }); await h.change('provider','openai-auth');
  assert.equal(h.nodes.openaiSignIn.disabled, true); assert.equal(h.nodes.openaiAuthStatus.classList.contains('auth-error'), true);
  h.queue('/__auth/status', signedOut); await h.nodes.openaiRefreshStatus.click(); assert.equal(h.nodes.openaiSignIn.disabled, false);
  h.queue('/__auth/login', { error: { message: '测试登录错误' } }, 503); await h.nodes.openaiSignIn.click();
  assert.match(h.nodes.openaiAuthStatus.textContent, /测试登录错误/); assert.equal(h.nodes.openaiSignIn.disabled, false);
  h.queue('/__auth/login', { authUrl: 'https://attacker.invalid/login' }); await h.nodes.openaiSignIn.click();
  assert.match(h.nodes.openaiAuthStatus.textContent, /地址校验失败/); assert.equal(h.nodes.openaiLoginLink.clicks, 0);
  assert.equal(h.nodes.openaiLoginLink.hidden, true);
});

test('concurrent refreshes share one request and switching to API stops polling', async () => {
  const h = harness(); h.init(); const refresh = deferred(); h.queue('/__auth/status', () => refresh.promise);
  h.nodes.provider.value = 'openai-auth'; h.api.render();
  const a = h.nodes.openaiRefreshStatus.click(); const b = h.nodes.openaiRefreshStatus.click();
  assert.equal(h.calls.length, 1); refresh.resolve({ body: { ...signedOut, login: { pending: true, loginId: 'pending' } } }); await a; await b;
  assert.equal([...h.timers.values()].filter(timer => timer.ms === 1800).length, 1);
  await h.change('provider','api'); await h.tick(1800); assert.equal(h.calls.length, 1);
});

test('selecting the default account model clears a previously saved model', async () => {
  const h = harness({ stored: { 'workstation-openai-model': 'old-model' } }); h.init();
  h.queue('/__auth/status', account); h.queue('/__auth/models', { data: [{ id: 'old-model' }, { id: 'new-model' }] }); await h.change('provider','openai-auth');
  assert.equal(h.nodes.openaiModel.value, 'old-model');
  await h.change('openaiModel','');
  assert.equal(h.api.model(), ''); assert.equal(h.storage.get('workstation-openai-model'), ''); assert.equal(h.state.settings.openaiModel, '');
});

test('login links require HTTPS, an exact approved hostname and no embedded credentials', () => {
  const h = harness();
  for (const url of ['https://auth.openai.com/authorize?state=test','https://chatgpt.com/auth/login']) assert.ok(h.api.safeAuthURL(url));
  for (const url of ['javascript:alert(1)','http://auth.openai.com/authorize','https://auth.openai.com.attacker.invalid','https://attacker.invalid/#https://auth.openai.com','https://user:secret@auth.openai.com/','https://auth.openai.com:8443/authorize','not a URL']) assert.equal(h.api.safeAuthURL(url), null);
});

test('request timeout releases loading controls and readiness never permits an unsigned account', async () => {
  const h = harness(); h.init(); h.queue('/__auth/status', signedOut); await h.change('provider','openai-auth');
  h.queue('/__auth/login', options => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); })));
  const login = h.nodes.openaiSignIn.click(); assert.equal(h.nodes.openaiSignIn.disabled, true);
  await h.tick(20000); await login;
  assert.match(h.nodes.openaiAuthStatus.textContent, /连接超时/); assert.equal(h.nodes.openaiSignIn.disabled, false); assert.equal(h.nodes.openaiRefreshStatus.disabled, false);
  h.queue('/__auth/status', signedOut); await assert.rejects(h.api.ensureReady(), /先在设置/);
  h.queue('/__auth/status', { available: false, authenticated: false }); await assert.rejects(h.api.ensureReady(), /运行环境/);
  h.queue('/__auth/status', account); h.queue('/__auth/models', { data: [{ id: 'test-model' }] }); await h.api.ensureReady();
  assert.equal(h.calls.some(call => /responses|proxy/.test(call.path)), false);
});

test('a status poll started before cancellation cannot resurrect the cancelled login', async () => {
  const h = harness(); h.init(); h.queue('/__auth/status', signedOut); await h.change('provider','openai-auth');
  h.queue('/__auth/login', { authUrl: 'https://auth.openai.com/authorize?state=test', loginId: 'cancel-during-poll' }); await h.nodes.openaiSignIn.click();
  const stale = deferred(); h.queue('/__auth/status', () => stale.promise);
  const polling = h.tick(1800); await flush();
  h.queue('/__auth/cancel', { cancelled: true }); h.queue('/__auth/status', signedOut);
  const cancelling = h.nodes.openaiCancelLogin.click(); await flush();
  stale.resolve({ body: { ...signedOut, login: { pending: true, loginId: 'cancel-during-poll' } } });
  await polling; await cancelling;
  assert.equal(h.nodes.openaiCancelLogin.hidden, true);
  assert.equal(h.nodes.openaiSignIn.hidden, false);
  assert.equal([...h.timers.values()].filter(timer => timer.ms === 1800).length, 0);
});

test('a stale authenticated status cannot undo logout or re-enable the model selector', async () => {
  const h = harness(); h.init(); h.queue('/__auth/status', account); h.queue('/__auth/models', { data: [{ id: 'test-model' }] }); await h.change('provider','openai-auth');
  assert.equal(h.nodes.openaiSignOut.hidden, false);
  const stale = deferred(); h.queue('/__auth/status', () => stale.promise); const refreshing = h.nodes.openaiRefreshStatus.click(); await flush();
  h.queue('/__auth/logout', {}); h.queue('/__auth/status', signedOut);
  const logout = h.nodes.openaiSignOut.click(); const duplicate = h.nodes.openaiSignOut.dispatch('click'); await flush();
  stale.resolve({ body: account }); await refreshing; await logout; await duplicate;
  assert.equal(h.calls.filter(call => call.path === '/__auth/logout').length, 1);
  assert.equal(h.nodes.openaiSignOut.hidden, true); assert.equal(h.nodes.openaiModel.disabled, true);
  assert.match(h.nodes.openaiAuthStatus.textContent, /尚未登录/);
  assert.equal(h.toasts.length, 1);
});
