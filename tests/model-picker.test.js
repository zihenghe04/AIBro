const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/model-picker.js'), 'utf8');
const markup = fs.readFileSync(require.resolve('../app/index.html'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const catalogue = [
  { model: 'account-default', displayName: 'Default account model', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] },
  { id: 'account-fast', displayName: 'Fast account model', supportedReasoningEfforts: ['low', 'medium'], defaultReasoningEffort: 'low' },
];
const response = models => ({ ok: true, json: async () => ({ data: models }) });

function harness(options = {}) {
  let focused = null;
  const elements = new Map();
  class Option {
    constructor(text, value) { this.textContent = text; this.value = value; this.disabled = false; }
  }
  class Element {
    constructor(id) {
      this.id = id; this.attributes = {}; this.listeners = {}; this.options = [];
      this.disabled = false; this.hidden = false; this.open = false; this.style = {};
      this._value = ''; this.textContent = ''; this.title = '';
      this.isSelect = ['conversationProvider', 'conversationAccountModel', 'conversationEffort'].includes(id);
      this.classes = new Set();
      this.classList = { toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
    }
    get value() { return this._value; }
    set value(value) { value = String(value); this._value = !this.isSelect || this.options.some(option => option.value === value) ? value : ''; }
    replaceChildren(...items) { this.children = items; if (this.isSelect) { this.options = items; this._value = items[0]?.value || ''; } }
    add(option) { this.options.push(option); }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name]; }
    addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
    async fire(type, attributes = {}) {
      const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...attributes };
      await Promise.all((this.listeners[type] || []).map(callback => callback(event)));
      return event;
    }
    focus() { focused = this.id; void this.fire('focus'); }
    showModal() { this.open = true; }
    close() { if (!this.open) return; this.open = false; void this.fire('close'); }
    getBoundingClientRect() { return { left: 500, top: 500, right: 820, bottom: 740, width: 320, height: 240 }; }
  }
  const el = id => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); };
  el('conversationProvider').replaceChildren(new Option('API', 'api'), new Option('Account', 'openai-auth'));
  const state = { conversations: options.conversations || [{ id: 'first', title: 'First conversation' }, { id: 'second', title: 'Second conversation' }] };
  let currentId = state.conversations[0].id;
  const defaults = options.defaults || { provider: 'api', model: 'api-default', effort: '' };
  const calls = [], toasts = [];
  let saves = 0, ensureCount = 0;
  const context = vm.createContext({
    document: { getElementById: el, createElement: tag => { const element = new Element(''); element.tagName = tag.toUpperCase(); return element; } }, Option, AbortController, setTimeout, clearTimeout,
    innerWidth: 1200, innerHeight: 900, addEventListener() {},
    fetch: (url, init) => { calls.push({ url, init }); return options.fetch ? options.fetch(url, init) : Promise.resolve(response(catalogue)); },
    OpenAIAuth: { ensureReady: async () => { ensureCount++; if (options.ensureReady) await options.ensureReady(); } },
  });
  vm.runInContext(source, context);
  const api = context.ConversationModels;
  api.init({
    getState: () => state, getConversation: () => state.conversations.find(conversation => conversation.id === currentId),
    getDefaults: () => defaults, save: () => saves++, toast: message => toasts.push(message),
  });
  return {
    api, state, defaults, el, calls, toasts,
    open: () => el('composerModel').fire('click'),
    submit: () => el('modelPickerForm').fire('submit'),
    // HTML dialog Escape fires cancel then closes unless preventDefault is called.
    escape: async () => { const event = await el('modelPicker').fire('cancel'); if (!event.defaultPrevented) el('modelPicker').close(); },
    provider: async value => { el('conversationProvider').focus(); el('conversationProvider').value = value; await el('conversationProvider').fire('change'); },
    switchConversation: id => { currentId = id; api.sync(); },
    get saves() { return saves; }, get focused() { return focused; }, get ensureCount() { return ensureCount; },
  };
}

test('conversations inherit live defaults until explicitly selected, without mutating other conversations', () => {
  const h = harness();
  assert.deepEqual(plain(h.api.current()), { provider: 'api', model: 'api-default', effort: '' });
  h.api.setSelection(h.state.conversations[0], { provider: 'openai-auth', model: 'account-default', effort: 'high' });
  h.defaults.model = 'updated-global'; h.defaults.effort = 'low';
  assert.deepEqual(plain(h.api.current()), { provider: 'openai-auth', model: 'account-default', effort: 'high' });
  h.switchConversation('second');
  assert.deepEqual(plain(h.api.current()), { provider: 'api', model: 'updated-global', effort: 'low' });
  assert.equal(h.state.conversations[1].modelConfig, undefined);
  assert.match(h.el('composerModel').title, /继承默认/);
});

test('configuration normalization and reasoning capability catalogue preserve provider-specific choices', () => {
  const h = harness();
  const config = h.api.configuration({ modelConfig: { provider: 'api', model: '  custom-model  ', effort: 'auto' } });
  assert.deepEqual(plain(config), { provider: 'api', model: 'custom-model', effort: '' });
  assert.deepEqual(plain(h.api.effortsFor(catalogue, 'account-default')), ['low', 'medium', 'high']);
  assert.deepEqual(plain(h.api.effortsFor(catalogue, 'account-fast')), ['low', 'medium']);
  assert.deepEqual(plain(h.api.effortsFor(catalogue, 'missing')), []);
  const conversation = h.state.conversations[0];
  h.api.setSelection(conversation, { provider: 'api', model: 'api-a', effort: 'low' });
  const saved = h.api.setSelection(conversation, { provider: 'openai-auth', model: 'account-fast', effort: 'medium' });
  saved.model = 'external-mutation';
  assert.deepEqual(plain(conversation.modelChoices), {
    api: { model: 'api-a', effort: 'low' }, 'openai-auth': { model: 'account-fast', effort: 'medium' },
  });
  assert.equal(conversation.modelConfig.model, 'account-fast');
});

test('an in-flight model and effort snapshot stays fixed while the conversation selection changes', async () => {
  const ready = deferred();
  const h = harness({ ensureReady: () => ready.promise });
  const conversation = h.state.conversations[0];
  h.api.setSelection(conversation, { provider: 'openai-auth', model: 'account-default', effort: 'high' });
  const runInput = h.api.current();
  const run = h.api.resolve(runInput);
  runInput.model = 'account-fast'; runInput.effort = 'low';
  h.api.setSelection(conversation, { provider: 'api', model: 'new-api', effort: 'medium' });
  ready.resolve();
  assert.deepEqual(plain(await run), { provider: 'openai-auth', model: 'account-default', effort: 'high' });
  assert.equal(h.api.current().model, 'new-api');
  assert.equal(h.ensureCount, 1);
});

test('account model resolution rejects unavailable names and unsupported effort instead of silently falling back', async () => {
  const h = harness();
  await assert.rejects(h.api.resolve({ provider: 'openai-auth', model: 'missing', effort: '' }), /当前模型不可用/);
  await assert.rejects(h.api.resolve({ provider: 'openai-auth', model: 'account-fast', effort: 'high' }), /不支持 high/);
  assert.deepEqual(plain(await h.api.resolve({ provider: 'openai-auth', model: '', effort: '' })), {
    provider: 'openai-auth', model: 'account-default', effort: 'medium',
  });
  const noDefault = harness({ fetch: async () => response([catalogue[1]]) });
  await assert.rejects(noDefault.api.resolve({ provider: 'openai-auth', model: '', effort: '' }), /当前模型不可用/);
});

test('async account catalogue loading retains the existing reasoning effort', async () => {
  const pending = deferred();
  const h = harness({ fetch: () => pending.promise, defaults: { provider: 'openai-auth', model: 'account-default', effort: 'high' } });
  const opening = h.open();
  assert.equal(h.el('modelPicker').open, true);
  assert.equal(h.el('conversationEffort').value, 'high');
  assert.equal(h.el('applyModelSelection').disabled, true);
  pending.resolve(response(catalogue)); await opening;
  assert.equal(h.el('conversationEffort').value, 'high');
  assert.equal(h.el('conversationEffort').disabled, false);
  assert.equal(h.el('applyModelSelection').disabled, false);
  await h.submit();
  assert.equal(h.state.conversations[0].modelConfig.effort, 'high');
});

test('provider switches restore independent unsaved model and reasoning drafts', async () => {
  const h = harness(); await h.open();
  h.el('conversationApiModel').value = 'draft-api'; h.el('conversationEffort').value = 'high';
  await h.provider('openai-auth');
  h.el('conversationAccountModel').value = 'account-fast';
  await h.el('conversationAccountModel').fire('change');
  h.el('conversationEffort').value = 'medium';
  await h.provider('api');
  assert.equal(h.el('conversationApiModel').value, 'draft-api');
  assert.equal(h.el('conversationEffort').value, 'high');
  await h.provider('openai-auth');
  assert.equal(h.el('conversationAccountModel').value, 'account-fast');
  assert.equal(h.el('conversationEffort').value, 'medium');
  await h.submit();
  assert.deepEqual(plain(h.state.conversations[0].modelChoices.api), { model: 'draft-api', effort: 'high' });
  assert.equal(h.saves, 1);
});

test('form submission applies to the conversation that opened the picker, even after navigation', async () => {
  const h = harness(); await h.open();
  h.el('conversationApiModel').value = 'first-only';
  h.el('conversationEffort').value = 'low';
  h.switchConversation('second');
  const event = await h.submit();
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.state.conversations[0].modelConfig.model, 'first-only');
  assert.equal(h.state.conversations[1].modelConfig, undefined);
  assert.equal(h.el('modelPicker').open, false);
  assert.equal(h.el('composerModel').getAttribute('aria-expanded'), 'false');
  // Native Enter submission is provided by a text input and a submit button.
  assert.match(markup, /<form\b[^>]*id="modelPickerForm"/);
  assert.match(markup, /<input\b[^>]*id="conversationApiModel"[^>]*type="text"/);
  assert.match(markup, /<button\b[^>]*id="applyModelSelection"[^>]*type="submit"/);
});

test('Escape closes without applying drafts, and delayed responses cannot reopen the picker', async () => {
  const pending = deferred(); const h = harness({ fetch: () => pending.promise });
  const opening = h.open();
  h.el('conversationApiModel').value = 'discard-me';
  await h.escape();
  assert.equal(h.el('modelPicker').open, false);
  assert.equal(h.saves, 0); assert.equal(h.state.conversations[0].modelConfig, undefined);
  assert.equal(h.el('composerModel').getAttribute('aria-expanded'), 'false');
  pending.resolve(response(catalogue)); await opening;
  assert.equal(h.el('modelPicker').open, false);
  assert.equal(h.state.conversations[0].modelConfig, undefined);
});

test('unknown saved account model is visibly unavailable and cannot be applied as the default', async () => {
  const h = harness({ defaults: { provider: 'openai-auth', model: 'retired-model', effort: 'high' } });
  await h.open();
  assert.equal(h.el('conversationAccountModel').value, 'retired-model');
  const unavailable = h.el('conversationAccountModel').options.find(option => option.value === 'retired-model');
  assert.equal(unavailable.disabled, true); assert.match(unavailable.textContent, /暂不可用/);
  await h.submit();
  assert.equal(h.saves, 0); assert.equal(h.el('modelPicker').open, true);
  assert.match(h.toasts.at(-1), /不可用/);
});

test('reset inherits current global defaults, while cancel preserves explicit configuration', async () => {
  const h = harness();
  h.api.setSelection(h.state.conversations[0], { provider: 'api', model: 'explicit', effort: 'high' });
  await h.open(); h.el('conversationApiModel').value = 'discard'; await h.escape();
  assert.equal(h.state.conversations[0].modelConfig.model, 'explicit');
  await h.open(); await h.el('resetModelSelection').fire('click');
  assert.equal(h.state.conversations[0].modelConfig, undefined);
  assert.equal(h.api.current().model, 'api-default');
  assert.equal(h.saves, 1);
});

test('empty API model and deleted target fail without writing unrelated conversation settings', async () => {
  const h = harness(); await h.open();
  h.el('conversationApiModel').value = '  '; await h.submit();
  assert.equal(h.focused, 'conversationApiModel'); assert.equal(h.saves, 0);
  h.state.conversations.shift(); h.switchConversation('second');
  h.el('conversationApiModel').value = 'should-not-save'; await h.submit();
  assert.equal(h.saves, 0); assert.equal(h.state.conversations[0].modelConfig, undefined);
});

test('stale model requests cannot overwrite catalogue from a more recently opened conversation', async () => {
  const first = deferred(), second = deferred(); let request = 0;
  const h = harness({ fetch: () => ++request === 1 ? first.promise : second.promise });
  const firstOpening = h.open(); await h.escape();
  h.switchConversation('second'); const secondOpening = h.open();
  second.resolve(response(catalogue)); await secondOpening;
  first.resolve(response([{ model: 'stale-only', isDefault: true }])); await firstOpening;
  await h.provider('openai-auth');
  assert.equal(h.el('conversationAccountModel').options.some(option => option.value === 'account-default'), true);
  assert.equal(h.el('conversationAccountModel').options.some(option => option.value === 'stale-only'), false);
});


test('new conversation inherits latest used provider, model and effort across restart without changing old conversations', async () => {
  const h=harness();await h.open();await h.provider('openai-auth');
  h.el('conversationAccountModel').value='account-fast';await h.el('conversationAccountModel').fire('change');h.el('conversationEffort').value='medium';await h.submit();
  const restored=JSON.parse(JSON.stringify(h.state));
  assert.deepEqual(plain(h.api.forNewConversation(restored,h.defaults)),{provider:'openai-auth',model:'account-fast',effort:'medium'});
  h.api.remember(restored,{provider:'api',model:'another',effort:'high'});
  assert.equal(h.api.forNewConversation(restored,h.defaults).model,'another');
  assert.equal(restored.conversations[0].modelConfig.model,'account-fast');
  assert.equal(restored.conversations[1].modelConfig,undefined);
});
test('existing workspace migrates most recent used model instead of fixed connection defaults',()=>{
  const h=harness();h.state.conversations[0].messages=[{at:10,modelConfig:{provider:'api',model:'old',effort:'low'}}];
  h.state.conversations[1].messages=[{at:20,modelConfig:{provider:'openai-auth',model:'account-fast',effort:'medium'}}];
  assert.equal(h.api.forNewConversation(h.state,h.defaults).model,'account-fast');
});
