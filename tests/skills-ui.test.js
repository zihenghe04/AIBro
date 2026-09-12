const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Core = require('../app/skills-core');
const source = fs.readFileSync(require.resolve('../app/skills-ui'), 'utf8');

function harness() {
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.attributes = {}; this.style = {}; this.className = ''; this.value = ''; this.hidden = false; this.open = false; this._text = ''; }
    append(...nodes) { nodes.forEach(node => { node.parentElement = this; this.children.push(node); }); }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    insertBefore(node, reference) { node.parentElement = this; const index = this.children.indexOf(reference); index < 0 ? this.children.push(node) : this.children.splice(index, 0, node); }
    insertAdjacentHTML() {}
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
    async fire(type, values = {}) { const event = { target: this, preventDefault() {}, ...values }; for (const handler of this.listeners[type] || []) await handler(event); }
    dispatchEvent(event) { void this.fire(event.type); }
    all() { return [this, ...this.children.flatMap(node => node.all())]; }
    matches(selector) { return selector.startsWith('#') ? this.id === selector.slice(1) : selector.startsWith('.') ? this.className.split(' ').includes(selector.slice(1)) : selector.startsWith('[name=') ? this.name === selector.slice(6, -1) : selector.startsWith('[role=') ? this.attributes.role === selector.slice(6, -1) : this.tagName === selector; }
    querySelector(selector) { return this.all().find(node => node.matches(selector)) || null; }
    querySelectorAll(selector) { return this.all().filter(node => node.matches(selector)); }
    closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
    contains(target) { return this.all().includes(target); }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    scrollIntoView() {}
  }
  const body = new Element('body'), sidebar = new Element('div'), composer = new Element('section'), footer = new Element('div'), input = new Element('textarea');
  sidebar.id = 'sidebar'; composer.id = 'composer'; input.id = 'agentInput'; input.value = '尚未发送的研究想法';
  const tools = new Element('div'); tools.className = 'sidebar-tools'; sidebar.append(tools); footer.className = 'composer-footer'; composer.append(input, footer); body.append(sidebar, composer);
  const document = { body, activeElement: null, createElement: tag => new Element(tag), addEventListener() {}, querySelector: selector => selector === '#sidebar .sidebar-tools' ? tools : selector === '#composer .composer-footer' ? footer : body.querySelector(selector) };
  const state = { skills: [], settings: { skillsEnabled: true }, currentConversationId: 'c', conversations: [{ id: 'c', skillId: 'builtin-paper', draft: input.value }, { id: 'c2', skillId: 'builtin-course' }] };
  let saves = 0, createdConversations = 0; const toasts = [];
  const sandbox = { document, WorkstationSkillsCore: Core, WorkstationIcons: { icon: () => '<svg></svg>' }, addEventListener() {}, queueMicrotask, Event: class { constructor(type) { this.type = type; } }, confirm: () => { throw Error('Copy must not ask to delete'); } };
  vm.createContext(sandbox); vm.runInContext(source, sandbox);
  const api = sandbox.WorkstationSkills.init({ getState: () => state, getConversation: () => state.conversations[0], newConversation: () => { createdConversations++; }, save: () => { saves++; }, toast: message => toasts.push(message) });
  api.open();
  const visible = node => { for (let entry = node; entry; entry = entry.parentElement) if (entry.hidden) return false; return true; };
  const buttons = label => body.all().filter(node => node.tagName === 'button' && node.textContent === label && visible(node));
  const click = async label => { const node = buttons(label)[0]; assert.ok(node, `Missing button ${label}`); await node.fire('click'); };
  const view = async (id = 'builtin-paper') => {
    api.open(); const skill = Core.get(state, id); const row = body.querySelectorAll('.skills-row').find(node => node.textContent.includes(`/${skill.command}`));
    await row.children[1].children[0].fire('click');
  };
  return { api, state, input, document, buttons, click, view, toasts, field: name => body.querySelector(`#skillsField-${name}`), get saves() { return saves; }, get createdConversations() { return createdConversations; } };
}

test('builtin viewer stays read-only and a custom copy is editable without changing state or the active conversation', async () => {
  const h = harness(), before = JSON.stringify(h.state); await h.view();
  for (const name of ['name', 'command', 'description', 'instructions']) assert.equal(h.field(name).readOnly, true);
  assert.equal(h.buttons('保存技能').length, 0); await h.click('复制为自定义');
  assert.equal(h.buttons('删除技能').length, 0, 'an unsaved copy is not an existing deletable skill');
  for (const name of ['name', 'command', 'description', 'instructions']) assert.equal(h.field(name).readOnly, false);
  assert.equal(h.field('command').value, 'paper-custom'); assert.match(h.field('name').value, /论文深读.*自定义/);
  assert.equal(h.field('instructions').value, Core.get(h.state, 'builtin-paper').instructions);
  assert.equal(JSON.stringify(h.state), before); assert.equal(h.saves, 0); assert.equal(h.createdConversations, 0);
  assert.equal(h.input.value, '尚未发送的研究想法'); assert.equal(h.state.conversations[0].skillId, 'builtin-paper');
});

test('Return, close and reopening abandon unsaved custom copies without allocating catalog entries', async () => {
  const h = harness(), before = JSON.stringify(h.state);
  await h.view(); await h.click('复制为自定义'); h.field('instructions').value = '尚未保存'; await h.click('返回');
  assert.equal(JSON.stringify(h.state), before); await h.view(); await h.click('复制为自定义'); await h.click('×');
  h.api.open(); assert.equal(JSON.stringify(h.state), before); assert.equal(h.saves, 0);
  await h.view(); await h.click('复制为自定义'); assert.equal(h.field('command').value, 'paper-custom');
  assert.equal(h.field('instructions').value, Core.get(h.state, 'builtin-paper').instructions);
});

test('explicit Save creates the edited copy through Core while preserving builtin and every conversation selection', async () => {
  const h = harness(), builtin = Core.get(h.state, 'builtin-paper'), conversations = JSON.stringify(h.state.conversations);
  await h.view(); await h.click('复制为自定义'); h.field('name').value = '控制领域深读'; h.field('instructions').value = '重点分析稳定性证明和实验局限。'; await h.click('保存技能');
  assert.equal(h.state.skills.length, 1); const copy = Core.get(h.state, h.state.skills[0].id);
  assert.equal(copy.name, '控制领域深读'); assert.equal(copy.instructions, '重点分析稳定性证明和实验局限。'); assert.equal(copy.command, 'paper-custom'); assert.equal(copy.builtin, false);
  assert.equal(h.saves, 1); assert.deepEqual(Core.get(h.state, 'builtin-paper'), builtin);
  assert.equal(JSON.stringify(h.state.conversations), conversations); assert.equal(h.createdConversations, 0); assert.equal(h.input.value, '尚未发送的研究想法');
});

test('repeated copies get unique commands and never overwrite the first custom workflow', async () => {
  const h = harness(); await h.view(); await h.click('复制为自定义'); await h.click('保存技能');
  const first = structuredClone(h.state.skills[0]); await h.view(); await h.click('复制为自定义'); assert.equal(h.field('command').value, 'paper-custom-2');
  await h.click('保存技能'); assert.equal(h.state.skills.length, 2); assert.deepEqual(h.state.skills[0], first);
  await h.view(); await h.click('复制为自定义'); assert.equal(h.field('command').value, 'paper-custom-3'); assert.equal(h.saves, 2);
});

test('a command occupied while editing or changed to a reserved builtin fails without a partial write', async () => {
  const h = harness(); await h.view(); await h.click('复制为自定义');
  h.state.skills = Core.upsert(h.state, { name: '并发新技能', command: 'paper-custom', instructions: '已存在的工作流' }).skills;
  const before = JSON.stringify(h.state); await h.click('保存技能'); assert.equal(JSON.stringify(h.state), before); assert.equal(h.saves, 0); assert.match(h.toasts.at(-1), /已被使用/);
  h.field('command').value = 'paper'; await h.click('保存技能'); assert.equal(JSON.stringify(h.state), before); assert.equal(h.saves, 0);
  h.field('command').value = 'paper-personal'; await h.click('保存技能'); assert.equal(h.state.skills.length, 2); assert.equal(h.saves, 1);
});

test('only immutable builtin list names and descriptions are marked as interface text',()=>{
 const h=harness();h.state.skills=Core.upsert(h.state,{name:'论文深读',command:'my-paper',description:'允许注入技能说明',instructions:'保留我的原文'}).skills;const before=JSON.stringify(h.state);h.api.open();
 const rows=h.document.body.querySelectorAll('.skills-row'),custom=rows.find(row=>row.textContent.includes('/my-paper'));
 for(const row of rows.filter(row=>row!==custom)){const name=row.querySelector('.skills-name');assert.ok(name.className.includes('skills-builtin'));assert.equal(name.children[0].attributes['data-i18n'],'');assert.equal(row.children[0].children[1].attributes['data-i18n'],'');}
 const name=custom.querySelector('.skills-name');assert.ok(!name.className.includes('skills-builtin'));assert.equal(name.children[0].attributes['data-user-content'],'');assert.equal(custom.children[0].children[1].attributes['data-user-content'],'');assert.equal(JSON.stringify(h.state),before);assert.equal(h.saves,0);
});
