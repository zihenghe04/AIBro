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
  let focused = null, painting = false, surfaceProps = null;
  const focusEvents=[];
  const elements = new Map();
  class Option {
    constructor(text, value) { this.textContent = text; this.value = value; this.disabled = false; }
  }
  class Element {
    constructor(id) {
      this.id = id; this.attributes = {}; this.listeners = {}; this.options = [];
      this.disabled = false; this._hidden = id==='modelPicker'; this.hideCount=0; this.style = {};
      this._value = ''; this.textContent = ''; this.title = '';
      this.isConnected = true; this.onValue = null;this.tabIndex=0;this.focusCount=0;
      this.isSelect = ['conversationProvider', 'conversationAccountModel', 'conversationEffort'].includes(id);
      this.classes = new Set();
      this.classList = { add: name => this.classes.add(name), toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name) };
    }
    get hidden(){return this._hidden;}
    set hidden(value){if(value&&!this._hidden)this.hideCount++;this._hidden=!!value;}
    get value() { return this._value; }
    set value(value) { value = String(value); this._value = !this.isSelect || this.options.some(option => option.value === value) ? value : ''; if (!painting) this.onValue?.(this._value); }
    replaceChildren(...items) { this.children = items; if (this.isSelect) { this.options = items; this._value = items[0]?.value || ''; } }
    add(option) { this.options.push(option); }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name]; }
    addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
    async fire(type, attributes = {}) {
      const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...attributes };
      const direct=this['on'+type]?.(event); await Promise.all([direct,...(this.listeners[type] || []).map(callback => callback(event))]);
      return event;
    }
    focus() { focused = this.id;this.focusCount++;focusEvents.push({id:this.id,pickerVisible:elements.get('modelPicker')?.hidden===false});void this.fire('focus');void documentEvents.fire('focusin',{target:this}); }
    contains(value) { return value===this || this.id==='modelPicker'&&['conversationProvider','conversationAccountModel','conversationApiModel','conversationEffort','applyModelSelection','modelPickerForm','closeModelPicker'].includes(value?.id); }
    getBoundingClientRect() { return { left: 500, top: 500, right: 820, bottom: 740, width: 320, height: 240 }; }
  }
  const el = id => { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); };
  el('conversationProvider').replaceChildren(new Option('API', 'api'), new Option('Account', 'openai-auth'), new Option('Claude', 'claude-auth'));
  const state = { conversations: options.conversations || [{ id: 'first', title: 'First conversation' }, { id: 'second', title: 'Second conversation' }] };
  let currentId = state.conversations[0].id;
  const defaults = options.defaults || { provider: 'api', model: 'api-default', effort: '' };
  const calls = [], toasts = [];
  let saves = 0, ensureCount = 0, claudeEnsureCount = 0;
  function paint(props) {
    surfaceProps=props;painting=true;
    const select=(id,values,value,disabled,onValue)=>{const control=el(id);control.replaceChildren(...values.map(entry=>Object.assign(new Option(entry.label,entry.value),{disabled:!!entry.disabled})));control.value=value;control.disabled=disabled;control.onValue=onValue;};
    select('conversationProvider',[{value:'api',label:'API'},{value:'openai-auth',label:'Account'},{value:'claude-auth',label:'Claude'}],props.selection.provider,props.saving,props.onProvider);
    select('conversationAccountModel',props.accountOptions,props.selection.model,props.accountDisabled||props.saving,props.onModel);
    select('conversationEffort',props.effortOptions,props.selection.effort,props.effortDisabled||props.saving,props.onEffort);
    el('conversationApiModel').value=props.selection.model;el('conversationApiModel').onValue=props.onModel;
    el('conversationApiModelField').hidden=props.selection.provider!=='api';el('conversationAccountModelField').hidden=props.selection.provider==='api';
    el('modelPickerStatus').textContent=props.error||props.status;el('applyModelSelection').disabled=props.applyDisabled;
    el('modelPickerForm').onsubmit=event=>{event.preventDefault();return props.onSubmit();};
    el('closeModelPicker').onclick=props.onClose;el('resetModelSelection').onclick=props.onReset;el('modelPickerSettings').onclick=props.onSettings;el('retryModelCatalogue').onclick=props.onRetry;
    painting=false;
  }
  const documentEvents=new Element('document');
  const context = vm.createContext({
    document: { get activeElement(){return focused?el(focused):null;}, documentElement:{lang:'zh'}, getElementById: el, addEventListener:(...args)=>documentEvents.addEventListener(...args), querySelector:()=>null, createElement: tag => { const element = new Element(''); element.tagName = tag.toUpperCase(); return element; } }, Option, AbortController, setTimeout, clearTimeout, structuredClone,
    HalaskaUI:{mount(_host,name,props){assert.equal(name,'ModelPickerSurface');paint(props);return{update:paint,unmount(){}};}},
    innerWidth: 1200, innerHeight: 900, addEventListener() {}, ComposerUI:options.composerUI,
    fetch: (url, init) => { calls.push({ url, init }); return options.fetch ? options.fetch(url, init) : Promise.resolve(response(catalogue)); },
    OpenAIAuth: { ensureReady: async () => { ensureCount++; if (options.ensureReady) await options.ensureReady(); } },
    ClaudeAuth: { ensureReady: async () => { claudeEnsureCount++; if (options.claudeEnsureReady) await options.claudeEnsureReady(); } },
    ...(options.getApiModels ? { ModelCatalog: require('../app/model-catalog.js') } : {}),
  });
  vm.runInContext(source, context);
  const api = context.ConversationModels;
  api.init({
    getState: () => state, getConversation: () => state.conversations.find(conversation => conversation.id === currentId),
    getDefaults: () => defaults, getResolvedConfig:options.getResolvedConfig, getApiModels:options.getApiModels, canSave:options.canSave, save: async () => {saves++;return options.save?options.save():true;}, toast: message => toasts.push(message),
  });
  return {
    api, state, defaults, el, calls, toasts,focusEvents,
    open: () => el('composerModel').fire('click'),
    submit: () => el('modelPickerForm').fire('submit'),
    escape: attributes => documentEvents.fire('keydown',{key:'Escape',...attributes}),
    outside: attributes => documentEvents.fire('pointerdown',{target:el('outside'),...attributes}),
    provider: async value => { el('conversationProvider').focus(); el('conversationProvider').value = value; await el('conversationProvider').fire('change'); },
    switchConversation: id => { currentId = id; api.sync(); },
    get surface(){return surfaceProps;}, get saves() { return saves; }, get focused() { return focused; }, get ensureCount() { return ensureCount; }, get claudeEnsureCount(){return claudeEnsureCount;},
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
  assert.equal(h.el('modelPicker').hidden, false);
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

test('navigation dismisses unsaved model preferences without applying them to either conversation', async () => {
  const h = harness(); await h.open();
  h.el('conversationApiModel').value = 'first-only';
  h.el('conversationEffort').value = 'low';
  h.switchConversation('second');
  const event = await h.submit();
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.state.conversations[0].modelConfig, undefined);
  assert.equal(h.state.conversations[1].modelConfig, undefined);
  assert.equal(h.el('modelPicker').hidden, true);
  assert.equal(h.el('composerModel').getAttribute('aria-expanded'), 'false');
  // Native Enter submission is provided by a text input and a submit button.
  assert.match(markup, /<form\b[^>]*id="modelPickerForm"/);
  assert.match(markup, /<input\b[^>]*id="conversationApiModel"[^>]*type="text"/);
  assert.match(markup, /<button\b[^>]*id="applyModelSelection"[^>]*type="submit"/);
});

test('non-modal outside dismissal and IME Escape never apply drafts or lose the invoking control',async()=>{
 const h=harness();await h.open();h.el('conversationApiModel').value='unsaved';await h.escape({isComposing:true});assert.equal(h.el('modelPicker').hidden,false);await h.escape({defaultPrevented:true});assert.equal(h.el('modelPicker').hidden,false);
 await h.outside();assert.equal(h.el('modelPicker').hidden,true);assert.equal(h.saves,0);assert.equal(h.api.isSaving(),false);assert.equal(h.state.conversations[0].modelConfig,undefined);
});

test('ordinary model panel has explicit hidden/ARIA state and needs no HTML dialog methods or aliases',async()=>{
 const h=harness(),panel=h.el('modelPicker');
 assert.equal(panel.hidden,true);assert.equal(h.api.isOpen(),false);assert.equal(panel.getAttribute('role'),'dialog');assert.equal(panel.getAttribute('aria-modal'),'false');
 for(const name of ['open','show','showModal','close'])assert.equal(name in panel,false,name+' must not be emulated on the panel');
 await h.open();assert.equal(panel.hidden,false);assert.equal(h.api.isOpen(),true);await h.escape();assert.equal(panel.hidden,true);assert.equal(h.api.isOpen(),false);
});

test('AX-style opening from reader focus closes before one composer focus restoration, without focusin re-entry',async()=>{
 const h=harness(),reader=h.el('reader-summary');reader.focus();await h.open();
 assert.equal(h.focused,'conversationProvider');const openedVersion=Number(h.surface.ownerKey.split(':').at(-1));
 h.focusEvents.length=0;await h.escape();
 assert.equal(h.el('modelPicker').hideCount,1,'focusin must not cause a nested visibility transition');
 assert.equal(reader.focusCount,1,'the last reader focus is not the model panel invoker');
 assert.equal(h.el('composerModel').focusCount,1);assert.equal(h.focused,'composerModel');
 assert.deepEqual(h.focusEvents,[{id:'composerModel',pickerVisible:false}],'focus is restored only after the panel is hidden');
 h.api.close({restoreFocus:false,force:true});assert.equal(h.el('composerModel').focusCount,1,'a later repeated close cannot restore twice');
 await h.open();assert.equal(Number(h.surface.ownerKey.split(':').at(-1)),openedVersion+2,'one close and one reopen each invalidate exactly one UI version');
});

test('outside focusin dismissal closes once and preserves the newly focused reader target',async()=>{
 const h=harness();await h.open();h.focusEvents.length=0;h.el('reader-summary').focus();
 assert.equal(h.el('modelPicker').hidden,true);assert.equal(h.el('modelPicker').hideCount,1);assert.equal(h.focused,'reader-summary');
 assert.equal(h.el('composerModel').focusCount,0,'outside focus must not be stolen by the synchronous close event');
 assert.deepEqual(h.focusEvents,[{id:'reader-summary',pickerVisible:true}]);h.api.close({restoreFocus:false,force:true});assert.equal(h.focused,'reader-summary');
});

test('force navigation closes once without restoring focus and keeps the original successful save alive',async()=>{
 const gate=deferred(),h=harness({save:()=>gate.promise});await h.open();h.el('conversationApiModel').value='saved-after-navigation';const pending=h.submit();
 assert.equal(h.api.isSaving(),true);h.focusEvents.length=0;assert.equal(h.api.close({restoreFocus:false,force:true}),true);
 assert.equal(h.el('modelPicker').hideCount,1);assert.deepEqual(h.focusEvents,[]);assert.equal(h.api.isSaving(),true);
 h.api.close({restoreFocus:false,force:true});assert.deepEqual(h.focusEvents,[]);h.switchConversation('second');gate.resolve(true);await pending;
 assert.equal(h.api.isSaving(),false);assert.equal(h.state.conversations[0].modelConfig.model,'saved-after-navigation');assert.equal(h.state.conversations[1].modelConfig,undefined);
 assert.equal(h.el('modelPicker').hideCount,1);assert.deepEqual(h.focusEvents,[]);assert.equal(h.el('modelPicker').hidden,true);
});

test('navigation during a durable model save keeps the original transaction bound and reports failure',async()=>{
 const gate=deferred(),h=harness({save:()=>gate.promise});await h.open();h.el('conversationApiModel').value='pending';const pending=h.submit();assert.equal(h.api.isSaving(),true);h.switchConversation('second');assert.equal(h.el('modelPicker').hidden,true);
 gate.reject(Error('disk full'));await pending;assert.equal(h.api.isSaving(),false);assert.equal(h.state.conversations[0].modelConfig,undefined);assert.equal(h.state.conversations[1].modelConfig,undefined);assert.match(h.toasts.at(-1),/模型设置未保存.*disk full/);
});

test('Escape closes without applying drafts, and delayed responses cannot reopen the picker', async () => {
  const pending = deferred(); const h = harness({ fetch: () => pending.promise });
  const opening = h.open();
  h.el('conversationApiModel').value = 'discard-me';
  await h.escape();
  assert.equal(h.el('modelPicker').hidden, true);
  assert.equal(h.saves, 0); assert.equal(h.state.conversations[0].modelConfig, undefined);
  assert.equal(h.el('composerModel').getAttribute('aria-expanded'), 'false');
  pending.resolve(response(catalogue)); await opening;
  assert.equal(h.el('modelPicker').hidden, true);
  assert.equal(h.state.conversations[0].modelConfig, undefined);
});

test('unknown saved account model is visibly unavailable and cannot be applied as the default', async () => {
  const h = harness({ defaults: { provider: 'openai-auth', model: 'retired-model', effort: 'high' } });
  await h.open();
  assert.equal(h.el('conversationAccountModel').value, 'retired-model');
  const unavailable = h.el('conversationAccountModel').options.find(option => option.value === 'retired-model');
  assert.equal(unavailable.disabled, true); assert.match(unavailable.textContent, /暂不可用/);
  await h.submit();
  assert.equal(h.saves, 0); assert.equal(h.el('modelPicker').hidden, false);
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


test('durable save waits for ACK, prevents duplicate submission, and blocks Escape until resolved',async()=>{
 const gate=deferred(),h=harness({save:()=>gate.promise});await h.open();h.el('conversationApiModel').value='pending-model';const pending=h.submit();
 assert.equal(h.saves,1);assert.equal(h.surface.saving,true);assert.equal(h.el('modelPicker').hidden,false);await h.submit();assert.equal(h.saves,1);await h.escape();assert.equal(h.el('modelPicker').hidden,false);
 gate.resolve(true);await pending;assert.equal(h.surface.saving,true);assert.equal(h.el('modelPicker').hidden,true);assert.equal(h.state.conversations[0].modelConfig.model,'pending-model');
});
test('pending preferences cannot become the current model or a new conversation default before durable ACK',async()=>{
 const gate=deferred(),h=harness({save:()=>gate.promise});
 const before={provider:'api',model:'committed',effort:'low'};
 h.api.setSelection(h.state.conversations[0],before);h.api.remember(h.state,before);
 await h.open();h.el('conversationApiModel').value='pending';const pending=h.submit();
 assert.equal(h.api.current().model,'committed');
 assert.equal(h.api.configuration(h.state.conversations[0]).model,'committed');
 assert.equal(h.api.forNewConversation(h.state,h.defaults).model,'committed');
 h.switchConversation('second');assert.equal(h.api.current().model,'api-default');
 gate.resolve(true);await pending;
 assert.equal(h.api.forNewConversation(h.state,h.defaults).model,'pending');
 h.switchConversation('first');assert.equal(h.api.current().model,'pending');
});
test('first-ever pending selection and a failed save do not leak into new conversation inheritance',async()=>{
 const gate=deferred(),h=harness({save:()=>gate.promise});await h.open();h.el('conversationApiModel').value='never-committed';const pending=h.submit();
 assert.equal(h.api.forNewConversation(h.state,h.defaults).model,'api-default');
 gate.reject(Error('write failed'));await pending;
 assert.equal(h.api.forNewConversation(h.state,h.defaults).model,'api-default');
 assert.equal(h.api.isSaving(),false);assert.equal(h.state.settings,undefined);
});
test('reset keeps the committed override until ACK then publishes the actual inherited project model',async()=>{
 const gate=deferred(),project={provider:'api',model:'project',effort:'medium'};
 const h=harness({save:()=>gate.promise,getResolvedConfig:c=>c?.modelConfig||project});
 h.api.setSelection(h.state.conversations[0],{provider:'api',model:'override',effort:'low'});
 await h.open();const pending=h.el('resetModelSelection').fire('click');
 assert.equal(h.api.current().model,'override');assert.equal(h.api.forNewConversation(h.state,h.defaults).model,'override');
 gate.resolve(true);await pending;assert.equal(h.api.current().model,'project');assert.equal(h.api.forNewConversation(h.state,h.defaults).model,'project');
});
test('request preparation blocks model persistence while retaining the unsaved draft for a later apply',async()=>{
 let ready=false;const h=harness({canSave:()=>ready});await h.open();h.el('conversationApiModel').value='next';await h.submit();
 assert.equal(h.saves,0);assert.equal(h.state.conversations[0].modelConfig,undefined);assert.equal(h.surface.selection.model,'next');assert.match(h.surface.error,/正在准备请求/);
 ready=true;await h.submit();assert.equal(h.saves,1);assert.equal(h.api.current().model,'next');
});
test('save failure rolls back only owned configuration fields and keeps the draft ready to retry',async()=>{
 const gate=deferred(),h=harness({save:()=>gate.promise});h.api.setSelection(h.state.conversations[0],{provider:'api',model:'old',effort:'low'});h.api.remember(h.state,{provider:'api',model:'old',effort:'low'});const before=plain(h.state.conversations[0]);await h.open();h.el('conversationApiModel').value='unsaved';const pending=h.submit();h.state.settings.unrelated='preserved';gate.reject(Error('disk full'));await pending;
 assert.deepEqual(plain(h.state.conversations[0]),before);assert.equal(h.state.settings.recentConversationModel.model,'old');assert.equal(h.state.settings.unrelated,'preserved');assert.equal(h.el('modelPicker').hidden,false);assert.equal(h.surface.selection.model,'unsaved');assert.match(h.surface.error,/disk full/);assert.equal(h.surface.saving,false);
});
test('reset inherits the actual project configuration and remembers that resolution for new conversations',async()=>{
 const project={provider:'api',model:'project-model',effort:'medium',source:'project'};
 const h=harness({getResolvedConfig:conversation=>conversation?.modelConfig?{...conversation.modelConfig,source:'conversation'}:project});h.api.setSelection(h.state.conversations[0],{provider:'api',model:'override',effort:'low'});await h.open();assert.equal(h.surface.source,'对话设定');await h.el('resetModelSelection').fire('click');
 assert.equal(h.api.current().model,'project-model');assert.equal(h.api.current().source,'project');assert.equal(h.state.settings.recentConversationModel.model,'project-model');await h.open();assert.equal(h.surface.source,'项目设定');assert.equal(h.surface.selection.model,'project-model');
});
test('empty account catalog offers an honest retry and never invents a usable default',async()=>{
 let attempt=0;const h=harness({defaults:{provider:'openai-auth',model:'',effort:''},fetch:async()=>response(++attempt===1?[]:catalogue)});await h.open();assert.equal(h.surface.applyDisabled,true);assert.match(h.surface.error,/没有返回/);await h.el('retryModelCatalogue').fire('click');assert.equal(h.surface.error,'');assert.equal(h.surface.applyDisabled,false);await h.submit();assert.equal(h.saves,1);
});
test('composer synchronization delegates to the Kit owner instead of replacing its button DOM',()=>{
 const calls=[],h=harness({composerUI:{setModel:props=>calls.push(props)}});assert.equal(calls.length,1);assert.equal(calls[0].label,'api-default');assert.equal(calls[0].detail,'默认推理');assert.equal(h.el('composerModel').children,undefined);h.defaults.model='updated';h.api.sync();assert.equal(calls.at(-1).label,'updated');
});
test('a failed reset restores an explicit selection and never rewrites immutable run snapshots',async()=>{
 const h=harness({save:async()=>false}),conversation=h.state.conversations[0];conversation.messages=[{role:'agent',modelConfig:{provider:'api',model:'executed',effort:'high'}}];h.api.setSelection(conversation,{provider:'api',model:'override',effort:'low'});const before=plain(conversation);await h.open();await h.el('resetModelSelection').fire('click');assert.deepEqual(plain(conversation),before);assert.equal(h.el('modelPicker').hidden,false);assert.match(h.surface.error,/未能保存/);
});

test('Claude official default is a real provider selection with aliases, no catalogue and no API model fallback',async()=>{
 const h=harness({defaults:{provider:'claude-auth',model:'',effort:''},fetch:()=>{throw Error('Claude must not fetch OpenAI catalogue');}});await h.open();
 assert.equal(h.surface.selection.provider,'claude-auth');assert.equal(h.surface.selection.model,'');assert.equal(h.surface.accountDisabled,false);assert.equal(h.surface.effortDisabled,true);
 assert.deepEqual(Array.from(h.surface.accountOptions,x=>x.value),['','sonnet','opus','haiku']);assert.match(h.el('composerModel').title,/Claude/);await h.submit();
 assert.deepEqual(plain(h.state.conversations[0].modelConfig),{provider:'claude-auth',model:'',effort:''});assert.equal(h.calls.length,0);
 assert.deepEqual(plain(await h.api.resolve(h.api.current())),{provider:'claude-auth',model:'',effort:''});assert.equal(h.claudeEnsureCount,1);assert.equal(h.ensureCount,0);
 assert.equal(h.api.forNewConversation(h.state,h.defaults).provider,'claude-auth');
});
test('Claude defaults skip empty unconfigured levels and preserve independent unsaved API/OpenAI/Claude choices',async()=>{
 const h=harness({conversations:[{id:'first',modelConfig:{}},{id:'second'}],defaults:{provider:'claude-auth',model:'opus',effort:''}});assert.equal(h.api.current().provider,'claude-auth');await h.open();
 h.el('conversationAccountModel').value='haiku';await h.provider('api');h.el('conversationApiModel').value='api-personal';h.el('conversationEffort').value='high';
 await h.provider('openai-auth');await new Promise(r=>setImmediate(r));h.el('conversationAccountModel').value='account-fast';h.el('conversationEffort').value='low';
 await h.provider('claude-auth');assert.equal(h.el('conversationAccountModel').value,'haiku');assert.equal(h.surface.selection.effort,'');await h.submit();
 assert.deepEqual(plain(h.state.conversations[0].modelChoices),{api:{model:'api-personal',effort:'high'},'openai-auth':{model:'account-fast',effort:'low'},'claude-auth':{model:'haiku',effort:''}});
});
test('Claude run snapshots survive model changes and reject unsupported alias/reasoning before auth or transport',async()=>{
 const ready=deferred();const h=harness({claudeEnsureReady:()=>ready.promise});const input={provider:'claude-auth',model:'sonnet',effort:''};const run=h.api.resolve(input);input.model='haiku';ready.resolve();assert.equal((await run).model,'sonnet');
 await assert.rejects(h.api.resolve({provider:'claude-auth',model:'arbitrary-model',effort:''}),/别名/);
 await assert.rejects(h.api.resolve({provider:'claude-auth',model:'opus',effort:'high'}),/默认推理/);assert.equal(h.claudeEnsureCount,1);assert.equal(h.calls.length,0);
});

test('saved API model list drives picker choices, display names and per-model reasoning levels', async () => {
  const models = [{ model: 'api-default', label: 'Daily default', contextWindow: null, efforts: [] }, { model: 'deep', label: 'Deep thinker', contextWindow: 1000000, efforts: ['low', 'high', 'max'] }];
  const h = harness({ getApiModels: () => ({ models, protocol: 'chat' }) }); await h.open();
  assert.deepEqual(plain(h.surface.apiOptions.map(option => option.value)), ['api-default', 'deep']);
  assert.equal(h.surface.apiOptions[1].label, 'Deep thinker · deep');
  assert.equal(h.surface.currentModel, 'Daily default');
  // Empty list entry = every level the chat protocol can send; never Responses-only or unknown levels.
  assert.ok(h.surface.effortOptions.some(option => option.value === 'max'));
  assert.ok(!h.surface.effortOptions.some(option => option.value === 'ultra'));
  h.surface.onEffort('medium'); h.surface.onModel('deep');
  assert.deepEqual(plain(h.surface.effortOptions.map(option => option.value)), ['', 'low', 'high', 'max']);
  assert.equal(h.surface.selection.effort, '', 'an effort the model does not list is cleared, not sent');
  h.surface.onModel('unlisted');
  assert.ok(h.surface.apiOptions.some(option => option.value === 'unlisted' && /不在模型列表/.test(option.label)));
});

test('without a saved list the API picker keeps the free-text model field', async () => {
  const h = harness({ getApiModels: () => ({ models: [], protocol: 'auto' }) }); await h.open();
  assert.equal(h.surface.apiOptions.length, 0);
  assert.equal(h.surface.currentModel, 'api-default');
});
