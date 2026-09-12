const test = require('node:test');
const assert = require('node:assert/strict');
const Tour = require('../onboarding');
const deferred = () => { let resolve; const promise = new Promise(yes => resolve = yes); return { promise, resolve }; };
function fixture(options = {}) {
  const nodes = new Map(), documentListeners = new Map(), windowListeners = new Map(), navigations = [], saves = [], toasts = [];
  const state = options.state || { ui: {}, notes: [{ id: 'note', title: '用户笔记', content: '用户正文' }], tasks: [{ id: 'task', title: '用户任务', status: 'todo' }], conversations: [{ id: 'c', draft: '未发送草稿' }], imports: [] };
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.style = {}; this.attributes = {}; this.hidden = false; this.disabled = false; this.isConnected = true; this.textContent = ''; this.dataset = {}; this.rect = { left: 40, top: 50, right: 340, bottom: 90, width: 300, height: 40 }; }
    set id(value) { this._id = value; nodes.set('#' + value, this); } get id() { return this._id; }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return this.attributes[key]; }
    getBoundingClientRect() { if (this.id === 'onboardingCard') return { width: 380, height: 438 }; return this.rect; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    focus() { document.activeElement = this; }
    remove() { this.isConnected = false; if (this.id) nodes.delete('#' + this.id); }
  }
  const document = { createElement: tag => new Element(tag), querySelector: selector => { const value = nodes.get(selector); return Array.isArray(value) ? value[0] || null : value || null; }, querySelectorAll: selector => { const value = nodes.get(selector); return Array.isArray(value) ? value : value ? [value] : []; },
    addEventListener: (type, fn) => documentListeners.set(type, fn), removeEventListener: type => documentListeners.delete(type) };
  document.body = new Element('body'); document.body.dataset.view = 'agent';
  for (const selector of ['#settings .page-heading', '#provider', '#composer', '.primary-nav', '#projectList', '#inspectorToggle', '#messageList', '#dashboardTasks', '#agentInput', '[data-view="dashboard"]', '[data-view="courses"]', '.primary-nav .active']) nodes.set(selector, new Element('button'));
  document.activeElement = nodes.get('.primary-nav .active');
  const env = { document, innerWidth: 1440, innerHeight: 900,
    addEventListener: (type, fn) => windowListeners.set(type, fn), removeEventListener: type => windowListeners.delete(type),
    requestAnimationFrame: fn => { fn(); return 1; }, cancelAnimationFrame() {}, setTimeout, clearTimeout };
  const hooks = { getState: () => state, save: () => { saves.push(JSON.parse(JSON.stringify(state))); return options.save ? options.save() : true; }, toast: text => toasts.push(text),
    showView: async view => { navigations.push(view); document.body.dataset.view = view; if (options.showView) await options.showView(view); }, autoStart: false, ...options.hooks };
  const controller = Tour.createController(hooks, env);
  const key = (key, other = {}) => { let prevented = false; documentListeners.get('keydown')?.({ key, preventDefault() { prevented = true; }, stopPropagation() {}, ...other }); return prevented; };
  return { state, nodes, document, env, controller, navigations, saves, toasts, documentListeners, windowListeners, key };
}

test('first-use and completed/skipped state have deterministic versioned behavior', () => {
  assert.equal(Tour.shouldStart({ ui: {} }), true);
  for (const status of ['completed', 'skipped']) assert.equal(Tour.shouldStart({ ui: { onboarding: { version: Tour.VERSION, status } } }), false);
  assert.equal(Tour.shouldStart({ ui: { onboarding: { version: 0, status: 'completed' } } }), true);
});

test('tour opens real view anchors, skips with Escape, persists only preference and restores focus', async () => {
  const h = fixture(), before = JSON.parse(JSON.stringify(h.state)), opener = h.document.activeElement;
  assert.equal(await h.controller.maybeStart(), true); assert.equal(h.controller.isOpen(), true); assert.deepEqual(h.navigations, ['settings']);
  assert.equal(h.nodes.get('#onboardingCard').getAttribute('aria-modal'), 'false'); assert.equal(h.nodes.get('#onboardingSpotlight'), undefined);
  assert.equal(h.key('Escape'), true); assert.equal(h.controller.isOpen(), false); assert.equal(h.state.ui.onboarding.status, 'skipped'); assert.equal(h.document.activeElement, opener);
  for (const key of ['notes', 'tasks', 'conversations', 'imports']) assert.deepEqual(h.state[key], before[key]);
  assert.equal(await h.controller.maybeStart(), false); assert.equal(h.navigations.length, 1);
});

test('settings reopening always works after skip and every step visits only existing views', async () => {
  const h = fixture({ state: { ui: { onboarding: { version: Tour.VERSION, status: 'skipped' } } } });
  assert.equal(await h.controller.maybeStart(), false); await h.nodes.get('#openOnboarding').onclick();
  assert.equal(h.controller.currentStep(), 'connection');
  for (let i = 0; i < 4; i++) await h.controller.next();
  assert.equal(h.controller.currentStep(), 'overview'); assert.equal(h.nodes.get('#onboardingNext').textContent, '完成引导'); await h.controller.next();
  assert.equal(h.state.ui.onboarding.status, 'completed'); assert.deepEqual(h.navigations, ['settings', 'agent', 'courses', 'agent', 'dashboard']);
});

test('use entry navigates and focuses a real control without submitting messages or creating mock data', async () => {
  const h = fixture(); await h.controller.open(); await h.controller.next(); const before = JSON.stringify(h.state.conversations);
  await h.nodes.get('#onboardingAction').onclick(); assert.equal(h.controller.isOpen(), false); assert.equal(h.document.activeElement, h.nodes.get('#agentInput'));
  assert.equal(JSON.stringify(h.state.conversations), before); assert.equal(h.state.tasks.length, 1); assert.equal(h.navigations.at(-1), 'agent');
});

test('arrow navigation only runs inside the guide and never hijacks composer editing', async () => {
  const h = fixture(); await h.controller.open(); h.document.activeElement = h.nodes.get('#agentInput'); assert.equal(h.key('ArrowRight'), false); assert.equal(h.controller.currentStep(), 'connection');
  h.document.activeElement = h.nodes.get('#onboardingCard'); assert.equal(h.key('ArrowRight'), true); await Promise.resolve(); await Promise.resolve(); assert.equal(h.controller.currentStep(), 'conversation');
  h.key('ArrowLeft'); await Promise.resolve(); await Promise.resolve(); assert.equal(h.controller.currentStep(), 'connection');
});

test('opening the tour never replaces a modal or consumes its Escape', async () => {
  const h = fixture(), modal = {};
  h.nodes.set('dialog[open]:not([aria-modal="false"])', modal); assert.equal(await h.controller.open(), false); assert.deepEqual(h.navigations, []);
  h.nodes.delete('dialog[open]:not([aria-modal="false"])'); await h.controller.open(); h.nodes.set('dialog[open]:not([aria-modal="false"])', modal);
  assert.equal(h.key('Escape'), false); assert.equal(h.controller.isOpen(), true);
});

test('closing during an asynchronous view transition cannot re-open or refocus the guide', async () => {
  const pending = deferred(), h = fixture({ showView: () => pending.promise }), opener = h.document.activeElement;
  const opening = h.controller.open(); assert.equal(h.controller.isOpen(), true); h.controller.close('skipped'); pending.resolve(); await opening;
  assert.equal(h.controller.isOpen(), false); assert.equal(h.nodes.get('#onboardingLayer').hidden, true); assert.equal(h.document.activeElement, opener); assert.equal(h.documentListeners.size, 0); assert.equal(h.windowListeners.size, 0);
});

test('failed navigation remains readable and failed preference saving is reported without touching contents', async () => {
  const h = fixture({ showView: () => { throw Error('blocked navigation'); }, save: () => false }); await h.controller.open();
  assert.match(h.nodes.get('#onboardingNotice').textContent, /暂不能切换/); assert.equal(h.nodes.get('#onboardingNext').disabled, false);
  h.controller.close(); await Promise.resolve(); assert.match(h.toasts[0], /入门记录尚未保存/); assert.equal(h.state.notes[0].content, '用户正文');
});

test('card placement and resized layouts remain within narrow and short viewports', async () => {
  for (const [width, height] of [[320, 480], [650, 680], [1440, 900], [1440, 380]]) {
    const result = Tour.placement({ left: 1100, right: 1350, top: 60, bottom: 120, width: 250, height: 60 }, { width: 380, height: 430 }, { width, height });
    assert.ok(result.left >= 16); assert.ok(result.top >= 16); assert.ok(result.left + result.width <= width - 16); assert.ok(result.maxHeight <= height - 32);
    const h = fixture(); await h.controller.open(); h.env.innerWidth = width; h.env.innerHeight = height; h.controller.layout(); const style = h.nodes.get('#onboardingCard').style;
    assert.ok(parseFloat(style.left) + parseFloat(style.width) <= width - 16); assert.ok(parseFloat(style.maxHeight) <= height - 32);
  }
});

test('startup waits for hydration and respects a preference loaded during that wait', async () => {
  const pending = deferred(), h = fixture({ hooks: { ready: () => pending.promise } }); const starting = h.controller.maybeStart(); assert.deepEqual(h.navigations, []);
  h.state.ui.onboarding = { version: Tour.VERSION, status: 'completed' }; pending.resolve(); assert.equal(await starting, false); assert.equal(h.controller.isOpen(), false);
});

test('tour anchors match actual application controls and absent reading tabs have a real fallback',()=>{
 const fs=require('node:fs');const html=fs.readFileSync(require.resolve('../index.html'),'utf8');const reader=fs.readFileSync(require.resolve('../reading-pane'),'utf8');
 for(const id of ['provider','composer','agentInput','inspectorToggle','dashboardTasks','projectList'])assert.match(html,new RegExp('id="'+id+'"'));
 assert.match(html,/settings-connection-card/);assert.match(reader,/pane\.id = 'readingPane'/);assert.match(reader,/toggle\.id = 'readingToggle'/);
 const app=fs.readFileSync(require.resolve('../app'),'utf8');assert.match(app,/result\.type === 'note'.*data-open-note=/);
 const note=Tour.steps.find(step=>step.id==='notes');assert.ok(note.selectors.includes('#messageList [data-open-note]'));assert.ok(note.selectors.includes('#messageList'));assert.ok(note.selectors.includes('#composer'));assert.ok(!note.selectors.includes('#inspectorToggle'));
});

test('closing after a route change restores focus to a visible real control when the opener is hidden',async()=>{
 const h=fixture();const opener=h.document.activeElement;await h.controller.open();await h.controller.next();opener.hidden=true;h.nodes.get('#openOnboarding').hidden=true;
 h.controller.close();assert.notEqual(h.document.activeElement,opener);assert.equal(h.document.activeElement,h.nodes.get('#agentInput'));
});

test('an existing workspace is offered this version once, then skip prevents repeated automatic interruption',async()=>{
 const h=fixture();assert.equal(h.state.notes.length,1);assert.equal(await h.controller.maybeStart(),true);h.controller.close('skipped');assert.equal(await h.controller.maybeStart(),false);assert.equal(h.state.notes[0].content,'用户正文');
 await h.controller.open();assert.equal(h.controller.currentStep(),'connection');h.controller.close();
});

test('note step highlights the first visible actual note card, not a hidden first match or inspector control',async()=>{
 const h=fixture();const hidden=h.document.createElement('button'),visible=h.document.createElement('button');hidden.hidden=true;hidden.rect={left:150,top:300,right:450,bottom:340,width:300,height:40};visible.rect={left:620,top:300,right:920,bottom:340,width:300,height:40};
 h.nodes.set('#messageList [data-open-note]',[hidden,visible]);
 await h.controller.open();for(let i=0;i<3;i++)await h.controller.next();
 assert.equal(h.controller.currentStep(),'notes');const spotlight=h.nodes.get('#onboardingLayer').children[0];assert.equal(spotlight.style.left,'615px');assert.equal(spotlight.style.top,'295px');
});

test('without any reading tabs or visible note cards the guide points at messages and explains creating a first note',async()=>{
 const h=fixture();h.nodes.get('#messageList').rect={left:470,top:150,right:1070,bottom:450,width:600,height:300};
 await h.controller.open();for(let i=0;i<3;i++)await h.controller.next();
 const spotlight=h.nodes.get('#onboardingLayer').children[0];assert.equal(spotlight.style.left,'465px');assert.match(h.nodes.get('#onboardingBody').textContent,/先完成一次资料整理，再点击对话结果中的笔记卡/);
 h.nodes.get('#messageList').hidden=true;h.nodes.get('#composer').rect={left:530,top:590,right:1130,bottom:740,width:600,height:150};h.controller.layout();assert.equal(spotlight.style.left,'525px');
});

test('existing reader has priority over available note result cards',async()=>{
 const h=fixture(),reader=h.document.createElement('aside'),note=h.document.createElement('button');reader.rect={left:930,top:80,right:1390,bottom:830,width:460,height:750};note.rect={left:400,top:300,right:800,bottom:340,width:400,height:40};h.nodes.set('#readingPane:not([hidden])',reader);h.nodes.set('#messageList [data-open-note]',[note]);
 await h.controller.open();for(let i=0;i<3;i++)await h.controller.next();assert.equal(h.nodes.get('#onboardingLayer').children[0].style.left,'925px');
});
