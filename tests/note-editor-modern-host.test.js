const nodeTest = require('node:test');
const test = (name, callback) => nodeTest(name, { timeout: 3000 }, callback);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Canvas = require('../app/canvas-edit');

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const raw = '\uFEFF---\r\ntitle: Keep exact\r\n---\n\n重复 👩‍💻\r\n\n重复 👩‍💻\r\n';
const initial = () => ({ projects: [], imports: [], notes: [
  { id: 'n', title: '原始笔记', content: raw, createdAt: 1, updatedAt: 2 },
  { id: 'other', title: '另一篇', content: '另一篇正文', createdAt: 1, updatedAt: 2 }
] });

// Exercise host ownership and persistence with editor adapters at their public
// boundary. The real editing engines have their own renderer/IME acceptance.
function harness(options = {}) {
  const elements = [], handles = [], timers = new Map(), calls = { ensures: 0, saves: 0, saved: [], clears: [], remembered: [], flushes: 0 };
  let timerId = 0, recoveryHooks, canvasHooks, canvasRange, toolbar;
  const state = options.state || initial();
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attrs = {}; this.listeners = {};
      this.hidden = false; this.disabled = false; this.value = ''; this.textContent = ''; this.selectionStart = this.selectionEnd = 0;
      this.style = { setProperty: (key, value) => { this.style[key] = value; } };
      this.classList = { add: () => {}, remove: () => {}, toggle: () => {} };
      elements.push(this);
    }
    get ownerDocument() { return document; }
    get isConnected() { for (let item = this; item; item = item.parentElement) if (item === document.body) return true; return false; }
    append(...nodes) { for (const item of nodes) { item.remove(); item.parentElement = this; this.children.push(item); } }
    appendChild(node) { this.append(node); return node; }
    insertBefore(node, before) { node.remove(); node.parentElement = this; const index = this.children.indexOf(before); this.children.splice(index < 0 ? this.children.length : index, 0, node); return node; }
    replaceChildren(...nodes) { for (const item of this.children) item.parentElement = null; this.children = []; this.append(...nodes); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(item => item !== this); this.parentElement = null; }
    contains(node) { for (let item = node; item; item = item.parentElement) if (item === this) return true; return false; }
    setAttribute(name, value) { this.attrs[name] = String(value); }
    getAttribute(name) { return this.attrs[name] ?? null; }
    removeAttribute(name) { delete this.attrs[name]; }
    addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
    removeEventListener(type, callback) { this.listeners[type] = (this.listeners[type] || []).filter(item => item !== callback); }
    async fire(type, extras = {}) {
      const event = { target: this, key: '', preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extras };
      for (const callback of this.listeners[type] || []) await callback(event);
      return event;
    }
    focus() { document.activeElement = this; document.fire?.('focusin', { target: this }); }
    scrollIntoView() { this.scrolled = true; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    querySelectorAll(query) {
      const selectors = query.split(',').map(value => value.trim()), found = [];
      const matches = (item, selector) => selector.startsWith('.') ? (item.className || '').split(' ').includes(selector.slice(1)) : selector.startsWith('#') ? item.id === selector.slice(1) : item.tagName === selector.toUpperCase();
      const walk = item => { for (const child of item.children) { if (selectors.some(selector => matches(child, selector))) found.push(child); walk(child); } };
      walk(this); return found;
    }
    querySelector(query) { return this.querySelectorAll(query)[0] || null; }
    set innerHTML(value) { this.html = String(value); this.replaceChildren();
      for (const match of this.html.matchAll(/<(h[1-6])([^>]*)>([\s\S]*?)<\/h[1-6]>/g)) {
        const heading = new Element(match[1]); heading.textContent = match[3].replace(/<[^>]+>/g, '');
        heading.id = /\bid="([^"]*)"/.exec(match[2])?.[1] || '';
        const offset = /data-document-source-start="(\d+)"/.exec(match[2]); if (offset) heading.dataset.documentSourceStart = offset[1]; this.append(heading);
      }
    }
    get innerHTML() { return this.html || ''; }
  }
  const documentListeners = {};
  const document = { createElement: tag => new Element(tag), activeElement: null, documentElement: { lang: 'zh-CN' },
    addEventListener(type, callback) { (documentListeners[type] ||= []).push(callback); },
    removeEventListener(type, callback) { documentListeners[type] = (documentListeners[type] || []).filter(item => item !== callback); },
    fire(type, event = {}) { for (const callback of [...documentListeners[type] || []]) callback(event); }
  };
  document.body = new Element('body');
  const host = new Element('section'); document.body.append(host);
  const environmentListeners = {};
  const env = {
    document, module: { exports: {} }, console, Promise, AbortController,
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); }, addEventListener(type, callback) { (environmentListeners[type] ||= []).push(callback); },
    removeEventListener(type, callback) { environmentListeners[type] = (environmentListeners[type] || []).filter(item => item !== callback); }
  };
  if (options.history) env.DocumentEditHistory = require('./editor-history-fixture.cjs');
  if (options.documentMarkdown) env.DocumentMarkdown = options.documentMarkdown;
  if (options.reader) env.DocumentReading = options.reader;
  const makeAdapter = kind => ({ mount(target, config) {
    options.onMount?.(kind, config);
    let value = config.value, range = { start: 0, end: 0, exact: true }, composing = false;
    const contentDOM = options.nativeFocus ? new Element('div') : target;
    if (options.nativeFocus) { contentDOM.setAttribute('contenteditable', 'true'); target.append(contentDOM); }
    const handle = {
      kind, target, contentDOM, config, initialValue: value, sets: [], writes: [], disabled: [], destroyed: false, flushes: 0, focusCount: 0,
      ready: options.ready?.(kind, value) || Promise.resolve(true),
      getValue() { return value; },
      setValue(next, options = {}) { this.sets.push(next); this.writes.push({ value: next, ...options }); value = next; },
      setDisabled(next) { this.disabled.push(next);
        if (options.nativeFocus) {
          contentDOM.setAttribute('contenteditable', String(!next));
          // Model the WebKit blur caused by readonly; the real adapter retains
          // its selection model across editable-prop changes.
          if (next && document.activeElement === contentDOM) document.activeElement = document.body;
        }
      },
      selectionSource() { return { ...range, ...(options.inexactSelection ? {exact:false} : {}) }; },
      setSelectionRange(start, end, direction = 'forward') { range = { start, end, direction, exact: true }; },
      focus() { this.focusCount++; contentDOM.focus(); },
      destroy() { this.destroyed = true; },
      isComposing() { return composing; },
      flushPending() { this.flushes++; return Promise.resolve(options.flushPending?.(this) ?? (!composing && options.flushResult !== false)); },
      type(next) { assert.equal(this.destroyed, false, 'fixture must edit a live handle'); value = next; config.onChange(next); },
      beginComposition() { composing = true; },
      commitComposition(next) { value = next; composing = false; config.onChange(next); }
    };
    if (options.history) require('./editor-history-fixture.cjs').augment(handle, config);
    handles.push(handle); return handle;
  } });
  if (options.images) env.DocumentImages = options.images;
  const source = makeAdapter('source'), visual = makeAdapter('visual');
  const install = () => { env.DocumentSourceEditor = source; env.DocumentVisualEditor = visual; };
  if (!options.lazy) install();
  env.DocumentEditors = { ensure() {
    calls.ensures++;
    return Promise.resolve(options.lazy?.promise).then(() => { install(); return { source, visual, DocumentSourceEditor: source, DocumentVisualEditor: visual }; });
  } };
  env.HalaskaUI = {
    componentNames: ['DocumentToolbar', ...(options.canvas ? ['CanvasEditSurface'] : [])],
    mount(target, name, props) {
      const handle = { target, props, update(next) { this.props = { ...this.props, ...next }; }, unmount() { this.destroyed = true; } };
      if (name === 'DocumentToolbar') toolbar = handle;
      return handle;
    }
  };
  const recovery = options.recovery;
  if (recovery) env.NoteEditorRecovery = { create(hooks) {
    recoveryHooks = hooks;
    return {
      mount() {}, unmount() {}, remember(session) { calls.remembered.push({ ...session }); },
      saved(id) { calls.clears.push(id); return Promise.resolve(recovery.saved?.(id) ?? recovery.savedResult !== false); },
      discard() { return Promise.resolve(true); }, flushAll() { calls.flushes++; return Promise.resolve(recovery.flush?.() ?? true); }
    };
  } };
  if (options.canvas) {
    env.CanvasEdit = { ...Canvas, mount(_target, hooks) {
      canvasHooks = hooks;
      return { open(range) { canvasRange = range; return true; }, stop() {}, close() {}, dispose() {}, saved() {} };
    } };
  }
  vm.runInNewContext(fs.readFileSync(require.resolve('../app/note-editor'), 'utf8'), env, { filename: 'note-editor.js' });
  const Editor = env.module.exports;
  const api = Editor.createInlineController({
    getState: () => state,
    save: () => { calls.saves++; return options.save?.() ?? true; },
    onSaved: id => calls.saved.push(id), renderAll() {}, toast() {}, renderMarkdown: options.renderMarkdown, onOpenLink: options.onOpenLink
  }, env);
  const mount = (id = 'n', config = {}) => api.mount(host, id, config);
  const el = name => elements.find(item => host.contains(item) && (item.dataset.noteAction === name || item.className === name || item.attrs['aria-label'] === name));
  return {
    api, state, calls, host, env, handles, mount, el, environmentListeners,
    current: kind => handles.findLast(handle => handle.kind === kind && !handle.destroyed && host.contains(handle.target)),
    click: async name => {
      if (['edit', 'rich', 'preview'].includes(name) && toolbar && !toolbar.destroyed && host.contains(toolbar.target)) {
        assert.equal(typeof toolbar.props.onMode, 'function', 'the kit toolbar must control the same host session');
        await toolbar.props.onMode(name === 'preview' ? 'read' : name);
      } else { const element = el(name); assert.ok(element, `missing ${name} control`); await element.fire('click'); }
      await settle();
    },
    get canvasRange() { return canvasRange; }, get canvasHooks() { return canvasHooks; }, get recoveryHooks() { return recoveryHooks; },
    get toolbar() { return toolbar; },
    flushPreview() { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); }
  };
}

test('late lazy loading cannot mount or focus the document that has already been replaced', async () => {
  const lazy = deferred(), h = harness({ lazy });
  assert.equal(h.mount('n', { mode: 'rich' }), true); await settle();
  assert.ok(h.calls.ensures > 0, 'modern editor assets must be requested lazily');
  h.api.unmount({ force: true }); assert.equal(h.mount('other'), true);
  lazy.resolve(); await settle();
  assert.equal(h.api.snapshot().id, 'other'); assert.equal(h.api.snapshot().mode, 'read');
  assert.equal(h.handles.some(handle => handle.initialValue === raw && !handle.destroyed), false);
  assert.equal(h.state.notes[0].content, raw); assert.equal(h.calls.saves, 0);
});

test('a stale editor ready acknowledgement cannot take ownership after forced remount', async () => {
  const ready = deferred(), h = harness({ ready: (kind, value) => kind === 'visual' && value === raw ? ready.promise : Promise.resolve(true) });
  h.mount('n', { mode: 'rich' }); await settle(); const old = h.current('visual'); assert.ok(old);
  h.api.unmount({ force: true }); h.mount('other', { mode: 'edit' }); await settle();
  const active = h.current('source'); assert.ok(active); assert.equal(old.destroyed, true);
  ready.resolve(true); await settle();
  assert.equal(h.api.snapshot().id, 'other'); assert.equal(h.api.snapshot().mode, 'edit');
  assert.equal(active.getValue(), '另一篇正文'); assert.equal(active.destroyed, false); assert.equal(old.focusCount, 0);
});

test('raw source synchronizes in both directions without replacing unchanged editor history', async () => {
  const h = harness(); h.mount('n', { mode: 'edit' }); await settle(); const source = h.current('source'); assert.ok(source);
  assert.equal(source.getValue(), raw);
  const first = raw + '\n源码新增'; source.type(first); await h.click('rich');
  const rich = h.current('visual'); assert.ok(rich); assert.equal(rich.getValue(), first);
  const second = first + '\r\n可视新增'; rich.type(second); await h.click('edit');
  assert.equal(source.getValue(), second); assert.equal(h.api.getDraft('n').content, second);
  const sourceSets = source.sets.length, richSets = rich.sets.length;
  await h.click('rich'); await h.click('preview'); await h.click('edit'); await h.click('rich');
  assert.equal(source.sets.length, sourceSets, 'unchanged mode toggles must not reset source history');
  assert.equal(rich.sets.length, richSets, 'unchanged mode toggles must not reset visual history');
  assert.equal(h.state.notes[0].content, raw);
  assert.equal(await h.api.save(), true); assert.equal(h.state.notes[0].content, second);
});

test('mode switching preserves live composition and a retry receives the complete committed text', async () => {
  const h = harness(); h.mount('n', { mode: 'rich' }); await settle(); const rich = h.current('visual'); assert.ok(rich);
  rich.beginComposition(); await h.click('edit');
  assert.equal(h.api.snapshot().mode, 'rich'); assert.equal(rich.destroyed, false);
  assert.notEqual(rich.disabled.at(-1), true, 'a rejected mode switch must not interrupt active composition');
  const composed = raw + '完整中文候选'; rich.commitComposition(composed); await h.click('edit');
  assert.equal(h.api.snapshot().mode, 'edit'); assert.equal(h.current('source').getValue(), composed);
  assert.equal(h.api.getDraft('n').content, composed); assert.equal(h.calls.saves, 0);
});

test('save and draft flush reject unfinished composition and retry with its complete raw value', async () => {
  const h = harness({ recovery: {} }); h.mount('n', { mode: 'edit' }); await settle(); const source = h.current('source'); assert.ok(source);
  source.beginComposition(); assert.equal(await h.api.save(), false);
  assert.equal(h.calls.saves, 0); assert.equal(h.state.notes[0].content, raw);
  assert.notEqual(source.disabled.at(-1), true, 'save must not disable an editor while its IME is active');
  const saved = raw + '保存前提交'; source.commitComposition(saved);
  assert.equal(await h.api.save(), true); assert.equal(h.state.notes[0].content, saved); assert.equal(h.calls.saves, 1);
  source.beginComposition(); const priorFlushes = h.calls.flushes;
  assert.equal(await h.api.flushDrafts(), false); assert.equal(h.calls.flushes, priorFlushes);
  source.commitComposition(saved + '\r\n退出前提交'); assert.equal(await h.api.flushDrafts(), true);
  assert.ok(h.calls.flushes > priorFlushes); assert.equal(h.calls.remembered.at(-1).content, saved + '\r\n退出前提交');
});

test('title and folder IME guard save, routing, drafts and quit until the final input settles', async () => {
  for (const [label, field, committed] of [['笔记标题', 'title', '提交后的中文标题'], ['保存目录', 'folderPath', '资料/中文目录']]) {
    const h = harness({ recovery: {} }); h.mount('n', { mode: 'rich' }); await settle();
    const input = h.el(label), baseline = h.state.notes[0][field] || '';
    input.focus(); await input.fire('compositionstart'); input.value = 'zhong';
    await input.fire('input', { isComposing: true });
    assert.equal(h.api.currentContent(), null);
    assert.equal(await h.api.save(), false); assert.equal(await h.api.flushDrafts(), false);
    assert.equal(await h.api.suspend({ release: true }), false); assert.equal(await h.api.beforeLeave(), false);
    assert.equal(h.api.unmount({ force: true }), false); assert.equal(h.mount('other'), false);
    await h.click('edit'); assert.equal(h.api.snapshot().mode, 'rich');
    assert.equal(h.env.document.activeElement, input, 'rejected navigation must not steal candidate focus');
    let prevented = false;
    h.environmentListeners.beforeunload[0]({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true); assert.equal(h.calls.saves, 0); assert.equal(h.calls.flushes, 0);
    assert.equal(h.state.notes[0][field] || '', baseline);
    assert.equal(h.calls.remembered.some(session => session[field] === 'zhong'), false, 'candidate metadata is not a committed draft');
    await input.fire('compositionend');
    assert.equal(await h.api.save(), false, 'compositionend is not the final input commit');
    assert.equal(await h.api.suspend({ release: true }), false);
    input.value = committed; await input.fire('input', { isComposing: false });
    assert.equal(h.api.currentContent(), null); h.flushPreview();
    assert.equal(await h.api.save(), true); assert.equal(h.state.notes[0][field], committed);
    assert.equal(h.calls.saves, 1);
  }
});

test('metadata composition restart cancels its old settle and repeated mounts bind each input once', async () => {
  const h = harness({ recovery: {} }); h.mount('n', { mode: 'edit' }); await settle();
  const input = h.el('笔记标题');
  assert.equal(h.mount('n'), true); assert.equal(input.listeners.compositionstart.length, 1);
  await input.fire('compositionstart'); input.value = 'first'; await input.fire('compositionend');
  await input.fire('compositionstart'); input.value = 'second'; h.flushPreview();
  assert.equal(await h.api.save(), false, 'the previous settle must not release a new candidate session');
  await input.fire('compositionend'); input.value = '第二次提交'; await input.fire('input'); h.flushPreview();
  assert.equal(await h.api.suspend({ release: true }), true);
  assert.equal(h.mount('other', { mode: 'edit' }), true); await settle();
  await input.fire('compositionend'); h.flushPreview();
  assert.equal(h.api.snapshot().id, 'other'); assert.equal(await h.api.save(), true);
  assert.equal(h.state.notes[1].title, '另一篇');
  assert.equal(h.el('笔记标题').listeners.compositionstart.length, 1);
});

test('leave rejects active composition, then offers a decision for the committed unsaved text', async () => {
  const h = harness(); h.mount('n', { mode: 'rich' }); await settle(); const rich = h.current('visual'); assert.ok(rich);
  rich.beginComposition(); assert.equal(await h.api.beforeLeave(), false);
  assert.equal(rich.destroyed, false); assert.equal(h.api.snapshot().id, 'n');
  rich.commitComposition(raw + '离开前输入'); let settled = false;
  const leaving = Promise.resolve(h.api.beforeLeave()).then(value => { settled = true; return value; }); await settle();
  assert.equal(settled, false); assert.equal(h.el('note-document-leave').hidden, false);
  await h.click('stay'); assert.equal(await leaving, false);
  assert.equal(h.api.getDraft('n').content, raw + '离开前输入'); assert.equal(h.calls.saves, 0);
});

test('Canvas consumes raw source selection offsets once and applies only the selected duplicate', async () => {
  const h = harness({ canvas: true }); h.mount('n', { mode: 'edit' }); await settle(); const source = h.current('source'); assert.ok(source);
  const start = raw.lastIndexOf('重复'), end = start + '重复 👩‍💻'.length;
  source.setSelectionRange(start, end); assert.equal(await h.api.rewriteSelection(), true);
  assert.equal(h.canvasRange.start, start); assert.equal(h.canvasRange.end, end);
  assert.equal(raw.slice(h.canvasRange.start, h.canvasRange.end), '重复 👩‍💻');
  const replacement = '准确替换', updated = raw.slice(0, start) + replacement + raw.slice(end);
  assert.equal(await h.canvasHooks.writeDraft(updated, { expected: raw, start, end: start + replacement.length }), true);
  await settle(); assert.equal(source.getValue(), updated); assert.equal(h.api.getDraft('n').content, updated);
  assert.equal(source.selectionSource().start, start); assert.equal(source.selectionSource().end, start + replacement.length);
  assert.equal(h.state.notes[0].content, raw); assert.equal(h.calls.saves, 0);
});

test('failed recovery cleanup preserves the saved draft and continued input across editor disposal', async () => {
  const recovery = { savedResult: false }, h = harness({ recovery });
  h.mount('n', { mode: 'rich' }); await settle(); const rich = h.current('visual'); assert.ok(rich);
  const saved = raw + '已保存'; rich.type(saved); assert.equal(await h.api.save(), false);
  assert.equal(h.state.notes[0].content, saved); assert.equal(h.api.getDraft('n').content, saved);
  assert.match(h.el('note-document-status').textContent, /清理尚未确认/);
  assert.equal(h.toolbar.props.dirty, true, 'cleanup retry must remain actionable after formal content persistence');
  assert.equal(h.toolbar.props.saving, false); assert.equal(h.toolbar.props.loading, false);
  const continued = saved + '\r\n清理失败后继续输入'; rich.type(continued);
  h.api.unmount({ force: true }); assert.equal(rich.destroyed, true); assert.equal(h.api.getDraft('n').content, continued);
  h.mount('other'); h.api.unmount({ force: true }); h.mount('n'); await settle();
  assert.equal(h.api.getDraft('n').content, continued); assert.equal(h.current('source').getValue(), continued);
  recovery.savedResult = true; assert.equal(await h.api.save(), true);
  assert.equal(h.state.notes[0].content, continued); assert.equal(h.calls.saves, 2); assert.equal(h.api.getDraft('n'), null);
});

test('synchronous adapter mount failures clear loading and allow a fresh retry in either editing mode', async () => {
  for (const [kind, mode] of [['source', 'edit'], ['visual', 'rich']]) {
    let attempts = 0;
    const h = harness({ onMount(current) { if (current === kind && ++attempts === 1) throw new Error('fixture synchronous mount failure'); } });
    h.mount(); await h.click(mode);
    assert.equal(h.current(kind), undefined); assert.equal(h.toolbar.props.loading, false);
    assert.match(h.el('note-document-status').textContent, /加载失败/);
    assert.equal(h.state.notes[0].content, raw); assert.equal(h.calls.saves, 0);
    await h.click(mode);
    assert.equal(attempts, 2, 'retry must not reuse the already-rejected mount result');
    assert.ok(h.current(kind)); assert.equal(h.current(kind).getValue(), raw);
    assert.equal(h.toolbar.props.loading, false);
  }
});

test('returning to reading while an editor is still becoming ready prevents late focus theft', async () => {
  for (const [kind, mode] of [['source', 'edit'], ['visual', 'rich']]) {
    const ready = deferred(), h = harness({ ready: current => current === kind ? ready.promise : Promise.resolve(true) });
    h.mount(); const entering = h.click(mode); await settle();
    const editor = h.current(kind); assert.ok(editor); assert.equal(editor.focusCount, 0);
    await h.click('preview'); assert.equal(h.api.snapshot().mode, 'read');
    const focus = h.env.document.activeElement;
    ready.resolve(true); await entering; await settle();
    assert.equal(h.api.snapshot().mode, 'read'); assert.equal(editor.focusCount, 0);
    assert.equal(h.env.document.activeElement, focus); assert.equal(h.toolbar.props.loading, false);
    assert.equal(h.state.notes[0].content, raw);
  }
});

test('a delayed flush from a disposed session cannot save, leave or flush its same-note replacement', async () => {
  for (const action of ['save', 'beforeLeave', 'flushDrafts']) {
    const pending = deferred(); let old;
    const h = harness({ recovery: {}, flushPending: handle => handle === old ? pending.promise : true });
    h.mount('n', { mode: 'edit' }); await settle(); old = h.current('source');
    old.type(raw + '旧会话输入'); const running = h.api[action](); await settle();
    assert.ok(old.flushes > 0); assert.equal(h.calls.saves, 0);
    assert.equal(h.api.unmount({ force: true }), true); h.mount('n', { mode: 'edit' }); await settle();
    const replacement = h.current('source'); assert.ok(replacement); assert.notEqual(replacement, old);
    const newer = raw + '重新打开后的输入'; replacement.type(newer);
    const priorFlushes = h.calls.flushes;
    pending.resolve(true); assert.equal(await running, false, `${action} must reject the stale flush owner`);
    assert.equal(h.api.snapshot().id, 'n'); assert.equal(h.api.snapshot().mode, 'edit');
    assert.equal(h.api.getDraft('n').content, newer); assert.equal(replacement.getValue(), newer);
    assert.equal(h.el('note-document-leave').hidden, true); assert.equal(h.calls.saves, 0);
    assert.equal(h.calls.flushes, priorFlushes); assert.deepEqual(h.calls.clears, []);
    assert.equal(h.state.notes[0].content, raw);
  }
});

test('repeated mode requests share a ready failure without leaking a rejected UI action', async () => {
  const ready = deferred(); let mounts = 0;
  const h = harness({ ready: kind => kind === 'visual' && ++mounts === 1 ? ready.promise : Promise.resolve(true) });
  h.mount(); const first = h.click('rich'); await settle();
  const second = h.click('rich'); await settle();
  const results = Promise.allSettled([first, second]);
  ready.reject(new Error('fixture ready rejected'));
  const settled = await results;
  assert.equal(settled[0].status, 'fulfilled'); assert.equal(settled[1].status, 'fulfilled');
  assert.equal(h.toolbar.props.loading, false); assert.match(h.el('note-document-status').textContent, /加载失败/);
  await h.click('rich'); assert.ok(h.current('visual')); assert.equal(h.current('visual').getValue(), raw);
  assert.equal(h.state.notes[0].content, raw); assert.equal(h.calls.saves, 0);
});

test('source edits clear an obsolete unsupported-visual status and rebase the visual editor', async () => {
  const h = harness(); h.mount('n', { mode: 'rich' }); await settle(); const visual = h.current('visual');
  visual.config.onStatus({ supported: false, reason: 'fixture unsupported syntax' });
  assert.equal(h.toolbar.props.canVisual, false);
  await h.click('edit'); const source = h.current('source'); assert.ok(source);
  const supported = '# 修正后的 Markdown\n\n普通段落'; source.type(supported);
  assert.equal(h.toolbar.props.canVisual, true, 'a previous rich parse result must not disable visual editing after source changes');
  await h.click('rich'); assert.equal(h.api.snapshot().mode, 'rich');
  assert.equal(visual.getValue(), supported); assert.equal(h.api.getDraft('n').content, supported);
  assert.equal(h.state.notes[0].content, raw); assert.equal(h.calls.saves, 0);
});

test('AI apply rebases an inactive source editor on visual human edits before adding its undoable change', async () => {
  const h = harness({ canvas: true }); h.mount('n', { mode: 'edit' }); await settle();
  const source = h.current('source'); assert.equal(source.getValue(), raw);
  await h.click('rich'); const visual = h.current('visual');
  const manual = raw + '\n可视编辑中的人工补充 B'; visual.type(manual);
  assert.equal(source.getValue(), raw, 'the inactive source has not yet received the visual human edit');
  const start = manual.lastIndexOf('重复'), end = start + '重复 👩‍💻'.length;
  visual.setSelectionRange(start, end); assert.equal(await h.api.rewriteSelection(), true);
  const replacement = 'AI 改写 C', updated = manual.slice(0, start) + replacement + manual.slice(end);
  const before = source.writes.length;
  assert.equal(await h.canvasHooks.writeDraft(updated, { expected: manual, start, end: start + replacement.length }), true);
  await settle();
  assert.deepEqual(source.writes.slice(before), [
    { value: manual, origin: 'sync' },
    { value: updated, origin: 'ai', addToHistory: true }
  ], 'source undo must target the latest human draft B, not its stale pre-visual value A');
  assert.equal(h.api.snapshot().mode, 'edit'); assert.equal(source.getValue(), updated);
  assert.equal(h.api.getDraft('n').content, updated); assert.equal(h.state.notes[0].content, raw); assert.equal(h.calls.saves, 0);
});

test('undoing to the saved baseline clears both edit indicators without claiming a new persistence acknowledgement', async () => {
  for (const mode of ['edit', 'rich']) {
    const h = harness({ recovery: {} }); h.mount('n', { mode }); await settle();
    const editor = h.current(mode === 'edit' ? 'source' : 'visual');
    editor.type(raw + '\n追加');
    assert.equal(h.toolbar.props.dirty, true);
    assert.equal(h.el('note-document-status').textContent, '尚未保存');
    editor.type(raw); // The adapter reports the same committed raw value on undo.
    assert.equal(h.api.snapshot().dirty, false);
    assert.equal(h.toolbar.props.dirty, false);
    assert.equal(h.el('note-document-status').textContent, '与已保存笔记一致');
    assert.equal(h.api.getDraft('n'), null);
    assert.equal(h.calls.saves, 0, 'undo must not publish a formal note to fix a status label');
    assert.equal(h.calls.clears.length, 0, 'the status does not fabricate a durable cleanup acknowledgement');
    const title = h.el('笔记标题'); title.value = '标题仍有修改'; await title.fire('input');
    editor.type(raw + '\n再次追加'); editor.type(raw);
    assert.equal(h.toolbar.props.dirty, true, 'a body undo cannot clear unsaved metadata');
    assert.equal(h.el('note-document-status').textContent, '尚未保存');
    title.value = h.state.notes[0].title; await title.fire('input');
    assert.equal(h.toolbar.props.dirty, false);
    assert.equal(h.el('note-document-status').textContent, '与已保存笔记一致');
  }
});

test('Escape from a CodeMirror search panel closes only search even after its DOM was removed', async () => {
  for (const alreadyHandled of [false, true]) {
    const h = harness(); h.mount('n', { mode: 'edit' }); await settle();
    const source = h.current('source'), field = { closest: () => null };
    const removedPanel = { classList: { contains: name => name === 'cm-search' } };
    let stopped = false;
    await h.el('note-document').fire('keydown', {
      key: 'Escape', target: field, defaultPrevented: alreadyHandled,
      composedPath: () => [field, removedPanel, source.target],
      stopPropagation() { stopped = true; }
    });
    await settle();
    assert.equal(stopped, true, 'the consumed search key must not escape to document/global navigation');
    assert.equal(h.api.snapshot().mode, 'edit');
    assert.equal(source.destroyed, false); assert.equal(h.calls.saves, 0);
    await h.el('note-document').fire('keydown', { key: 'Escape', target: source.target });
    await settle();
    assert.equal(h.api.snapshot().mode, 'read', 'Escape from ordinary source content retains the existing document behavior');
  }
});

test('tab suspension durably preserves raw drafts without formal save and releases heavy views on commit', async () => {
  const h = harness({ recovery: {} }); h.mount('n', { mode: 'rich' }); await settle();
  const first = h.current('visual'), content = raw + '\n未正式保存的中文'; first.type(content);
  first.setSelectionRange(2, 7); h.host.scrollTop = 281;
  const bookmark = h.api.capturePosition();
  assert.equal(bookmark.mode, 'rich'); assert.equal(bookmark.scrollTop, 281);
  assert.equal(Object.hasOwn(bookmark.selection, 'value'), false, 'raw body never belongs in UI bookmark');
  assert.equal(await h.api.suspend(), true); assert.equal(first.destroyed, false, 'pending navigation must retain its current view');
  assert.equal(h.calls.saves, 0); assert.equal(h.state.notes[0].content, raw); assert.ok(h.calls.flushes > 0);
  assert.equal(await h.api.suspend({ release: true }), true); assert.equal(first.destroyed, true);
  h.mount('other'); await settle(); assert.equal(await h.api.suspend({ release: true }), true);
  h.mount('n'); await settle(); assert.equal(await h.api.restorePosition(bookmark), true);
  assert.equal(h.api.snapshot().mode, 'rich'); assert.equal(h.current('visual').getValue(), content);
  assert.equal(h.current('visual').selectionSource().start, 2); assert.equal(h.host.scrollTop, 281);
  assert.equal(h.handles.filter(handle => !handle.destroyed).length <= 2, true, 'only active document engines remain alive');
  assert.equal(h.api.currentContent().content, content); assert.equal(h.api.currentContent().dirty, true);
});

test('draft persistence failure, unavailable storage and active IME leave the current document mounted', async () => {
  for (const recovery of [undefined, { flush: () => false }, { flush: () => Promise.reject(new Error('disk full')) }]) {
    const h = harness({ recovery }); h.mount('n', { mode: 'edit' }); await settle(); const editor = h.current('source');
    editor.type(raw + '待保存'); assert.equal(await h.api.suspend({ release: true }), false);
    assert.equal(editor.destroyed, false); assert.equal(h.api.snapshot().id, 'n'); assert.equal(h.calls.saves, 0);
  }
  const h = harness({ recovery: {} }); h.mount('n', { mode: 'edit' }); await settle(); const editor = h.current('source');
  editor.beginComposition(); assert.equal(await h.api.suspend({ release: true }), false);
  assert.equal(editor.destroyed, false); assert.equal(h.calls.flushes, 0);
});

test('typing during durable flush and superseded route authority cannot release newer input', async () => {
  for (const scenario of ['new input', 'route changed']) {
    const gate = deferred(); let current = true;
    const h = harness({ recovery: { flush: () => gate.promise } }); h.mount('n', { mode: 'edit' }); await settle();
    const editor = h.current('source'); editor.type(raw + 'first');
    const suspension = h.api.suspend({ release: true, isCurrent: () => current }); await settle();
    if (scenario === 'new input') editor.type(raw + 'newer'); else current = false;
    gate.resolve(true); assert.equal(await suspension, false); assert.equal(editor.destroyed, false);
    assert.equal(h.api.currentContent().content, raw + (scenario === 'new input' ? 'newer' : 'first'));
  }
});

test('late bookmark restoration cannot change or focus the next document', async () => {
  const ready = deferred(), h = harness({ ready: (kind, value) => kind === 'visual' && value === raw ? ready.promise : Promise.resolve(true) });
  h.mount('n'); const restoring = h.api.restorePosition({ mode: 'rich', selection: { start: 2, end: 4 }, scrollTop: 400 }); await settle();
  h.api.unmount({ force: true }); h.mount('other', { mode: 'edit' }); await settle();
  ready.resolve(true); assert.equal(await restoring, false); assert.equal(h.api.snapshot().id, 'other');
  assert.equal(h.api.snapshot().mode, 'edit'); assert.notEqual(h.host.scrollTop, 400); assert.equal(h.current('source').focusCount, 0);
});

test('retiring the owning project before save retains the mounted draft and requires an explicit leave choice', async () => {
  const state = initial(); state.projects = [{ id: 'p' }]; state.notes[0].projectId = 'p';
  const h = harness({ state, recovery: {} }); h.mount('n', { mode: 'edit' }); await settle();
  const editor = h.current('source'), draft = raw + '未保存'; editor.type(draft);
  state.projects[0].archivedAt = 123;
  assert.equal(await h.api.save(), false); assert.equal(h.calls.saves, 0); assert.equal(state.notes[0].content, raw);
  assert.equal(h.api.getDraft('n').content, draft); assert.equal(editor.destroyed, false);
  let settled = false;
  const leave = Promise.resolve(h.api.beforeLeave()).then(value => { settled = true; return value; }); await settle();
  assert.equal(settled, false, 'invalid owner must not silently authorize discarding unsaved content');
  assert.equal(h.el('note-document-leave').hidden, false);
  await h.click('stay'); assert.equal(await leave, false); assert.equal(h.api.currentContent().content, draft);
});

test('scope invalidation while a save is pending cannot clear recovery or acknowledge saved output', async () => {
  for (const mutate of [
    state => { state.notes[0].status = 'archived'; },
    state => { state.projects[0].deleted = true; },
    state => { state.projects.push({ ...state.projects[0] }); }
  ]) {
    const gate = deferred(), state = initial(); state.projects = [{ id: 'p' }]; state.notes[0].projectId = 'p';
    const h = harness({ state, recovery: {}, save: () => gate.promise }); h.mount('n', { mode: 'edit' }); await settle();
    const draft = raw + 'saving'; h.current('source').type(draft);
    const saving = h.api.save(); await settle(); assert.equal(h.calls.saves, 1);
    mutate(state); gate.resolve(true);
    assert.equal(await saving, false); assert.equal(h.calls.clears.length, 0); assert.equal(h.calls.saved.length, 0);
    assert.equal(h.api.getDraft('n').content, draft); assert.equal(h.api.currentContent().content, draft);
    assert.equal(h.api.snapshot().saving, false); assert.match(h.el('note-document-status').textContent, /草稿/);
  }
});

test('late recovery cannot replace the current draft after its project became unavailable', async () => {
  const state = initial(); state.projects = [{ id: 'p' }]; state.notes[0].projectId = 'p';
  const h = harness({ state, recovery: {} }); h.mount('n', { mode: 'edit' }); await settle();
  const content = raw + '当前草稿'; h.current('source').type(content);
  const restored = { ...h.api.getDraft('n'), content: '迟到的恢复草稿' };
  state.projects[0].status = 'deleted'; h.recoveryHooks.onRestore(restored); await settle();
  assert.equal(h.api.currentContent().content, content); assert.equal(h.api.getDraft('n').content, content);
  assert.equal(h.calls.saves, 0); assert.match(h.el('note-document-status').textContent, /所属项目/);
});

test('failed adoption rolls back its receipt and content while retaining an independent lifecycle change', async () => {
  const gate = deferred(), state = initial();
  state.notes[0].aiDraft = { content: '提案', provenance: { run: { id: 'r' } } };
  const h = harness({ state, recovery: {}, save: () => gate.promise }); h.mount('n'); await settle();
  await h.click('apply-ai'); const saving = h.api.save(); await settle();
  assert.equal(state.notes[0].aiDraftHistory[0].action, 'adopt');
  state.notes[0].archivedAt = 42; gate.reject(new Error('disk full'));
  assert.equal(await saving, false); assert.equal(state.notes[0].content, raw);
  assert.equal(state.notes[0].aiDraft.content, '提案'); assert.equal(state.notes[0].aiDraftHistory, undefined);
  assert.equal(state.notes[0].archivedAt, 42, 'rollback restores only fields owned by this edit');
  assert.equal(h.api.getDraft('n').content, '提案'); assert.equal(h.calls.clears.length, 0);
});

test('scope changes during recovery cleanup retain the current buffer instead of claiming a completed save', async () => {
  for (const dirty of [false, true]) {
    const gate = deferred(), state = initial(); state.projects = [{ id: 'p' }]; state.notes[0].projectId = 'p';
    const h = harness({ state, recovery: { saved: () => gate.promise } }); h.mount('n', { mode: 'edit' }); await settle();
    const content = dirty ? raw + 'cleanup pending' : raw;
    if (dirty) h.current('source').type(content);
    const saving = h.api.save(); await settle(); assert.equal(h.calls.clears.length, 1);
    state.projects[0].status = 'archived'; gate.resolve(true);
    assert.equal(await saving, false); assert.equal(h.api.snapshot().id, 'n'); assert.equal(h.api.snapshot().saving, false);
    assert.equal(h.api.currentContent().content, content); assert.equal(h.calls.saved.length, 0);
    assert.match(h.el('note-document-status').textContent, /所属项目/);
    if (dirty) assert.equal(h.api.getDraft('n').content, content);
  }
});


test('image upload hooks keep original owner, currentContent waits and save flushes pending insertion', async () => {
  const uploaded = deferred(), flushed = deferred();
  const images = { uploadNote: () => uploaded.promise, resolveNote: (_id,url) => url };
  const h = harness({ images, flushPending: () => flushed.promise });
  h.mount('n', {mode:'rich'}); await settle(); const rich=h.current('visual');
  rich.isImageBusy=()=>true; rich.config.onImageBusy(1);
  assert.equal(h.api.currentContent(),null); assert.equal(h.toolbar.props.imageBusy,1);
  const upload=rich.config.onUploadImage({name:'a.png'});
  let finished=false;const saving=h.api.save().then(value=>{finished=true;return value;});await settle();
  assert.equal(finished,false);assert.equal(h.calls.saves,0);assert.equal(rich.disabled.at(-1),false);
  uploaded.resolve({url:'/__files/img'});assert.equal((await upload).url,'/__files/img');
  rich.type(raw+'\n![a](/__files/img)');rich.isImageBusy=()=>false;rich.config.onImageBusy(0);flushed.resolve(true);
  assert.equal(await saving,true);assert.match(h.state.notes[0].content,/!\[a\]/);
});

test('late image upload cannot insert into a replacement note', async () => {
  const uploaded=deferred(),images={uploadNote:()=>uploaded.promise,resolveNote:()=>''};
  const h=harness({images});h.mount('n',{mode:'rich'});await settle();const rich=h.current('visual');
  const pending=rich.config.onUploadImage({name:'image.png'});
  h.api.unmount({force:true});h.mount('other');uploaded.resolve({url:'/__files/img'});
  await assert.rejects(pending,/切换/);assert.equal(h.state.notes[1].content,'另一篇正文');
});

test('document AST outline uses complete TOML offsets and quoted headings without counting fenced examples', async () => {
  const markdown = await import('../app/editor/document-markdown.js');
  const content = '\ufeff+++\r\ntitle="Keep"\r\n+++\r\n> # Quoted\n\n> ```md\n> # Example\n> ```\n\n# Last';
  const state = initial(); state.notes[0].content = content;
  const received = [], h = harness({ state, documentMarkdown: markdown, renderMarkdown: raw => { received.push(raw); return markdown.render(raw, { idPrefix: 'note-n' }); } });
  h.mount(); await settle();
  assert.equal(received[0], content); const expected = markdown.headings(content);
  assert.deepEqual(expected.map(heading => heading.text), ['Quoted', 'Last']);
  const buttons = h.el('note-document-outline').querySelectorAll('button');
  assert.equal(buttons.length, 2); await buttons[1].fire('click');
  assert.equal(h.el('note-document-preview').querySelectorAll('h1')[1].scrolled, true);
  assert.equal(h.env.document.activeElement, h.el('note-document-preview').querySelectorAll('h1')[1]);
  assert.equal(h.env.document.activeElement.getAttribute('tabindex'), '-1');
  assert.equal(h.api.snapshot().mode, 'read'); assert.equal(h.api.snapshot().dirty, false);
  await h.click('edit'); h.toolbar.props.onOutline();
  await h.el('note-document-outline').querySelectorAll('button')[0].fire('click');
  assert.equal(h.current('source').selectionSource().start, expected[0].start);
  assert.equal(content.slice(expected[0].start, expected[0].end), '# Quoted');
  assert.equal(h.state.notes[0].content, content);
});

test('closed editing outline avoids AST parsing and reader DOM lifecycle survives unchanged mode round trips', async () => {
  const markdown = await import('../app/editor/document-markdown.js'); let parsed = 0, mounted = 0, disposed = 0;
  const h = harness({ documentMarkdown: { headings(raw) { parsed++; return markdown.headings(raw); } }, renderMarkdown: raw => markdown.render(raw),
    reader: { mount() { mounted++; return { destroy() { disposed++; } }; } } });
  h.mount(); await settle(); const initialParses = parsed; assert.equal(mounted, 1);
  await h.click('edit'); h.current('source').type(raw + '\n# Added'); h.flushPreview();
  assert.equal(parsed, initialParses, 'hidden directory never parses each edit'); assert.equal(mounted, 1);
  h.toolbar.props.onOutline(); assert.equal(parsed, initialParses + 1);
  await h.click('preview'); assert.equal(mounted, 2); assert.equal(disposed, 1);
  await h.click('edit'); await h.click('preview'); assert.equal(mounted, 2); assert.equal(disposed, 1);
  h.api.unmount({force:true}); assert.equal(disposed, 2);
});

test('read outline with no DOM target stays in reading and stale source directory does not select wrong offsets', async () => {
  const markdown = await import('../app/editor/document-markdown.js'); const state = initial(); state.notes[0].content = '# Target';
  const h = harness({ state, documentMarkdown: markdown, renderMarkdown: () => '<p>Temporarily unavailable</p>' });
  h.mount(); await settle(); await h.el('note-document-outline').querySelectorAll('button')[0].fire('click');
  assert.equal(h.api.snapshot().mode, 'read'); assert.match(h.el('note-document-status').textContent, /无法定位/);
  await h.click('edit'); h.toolbar.props.onOutline(); const old = h.el('note-document-outline').querySelectorAll('button')[0];
  h.current('source').type('Before\n\n# Target'); await old.fire('click');
  assert.equal(h.current('source').selectionSource().start, 0); assert.match(h.el('note-document-status').textContent, /目录已更新/);
});

test('saved source navigation uses the same live note and draft variant as its reading renderer', async () => {
  const state = initial(), contexts = [], opened = [];
  state.notes[0].content = '正文 [1](#aibro-source-body)';
  state.notes[0].aiDraft = { content: '草稿 [2](#aibro-source-draft)' };
  const h = harness({ state, renderMarkdown: (_raw, context) => { contexts.push({ ...context }); return '<p>content</p>'; },
    onOpenLink: (id, url, options) => { opened.push({ id, url, options }); return true; } });
  h.mount(); await settle(); assert.deepEqual(contexts.at(-1), { noteId: 'n', variant: 'body' });
  await h.click('rich'); const rich = h.current('visual'), anchor = {};
  assert.equal(await rich.config.onOpenDocumentLink('#aibro-source-body', { anchor, isCurrent: () => true }), true);
  assert.equal(opened[0].id, 'n'); assert.equal(opened[0].url, '#aibro-source-body'); assert.equal(opened[0].options.variant, 'body');
  assert.equal(opened[0].options.anchor, anchor); assert.equal(opened[0].options.isCurrent(), true);
  await h.click('apply-ai'); await h.click('preview'); assert.deepEqual(contexts.at(-1), { noteId: 'n', variant: 'draft' });
  await h.click('rich'); assert.equal(await h.current('visual').config.onOpenDocumentLink('#aibro-source-draft'), true);
  assert.equal(opened.at(-1).options.variant, 'draft');
  assert.equal(state.notes[0].content, '正文 [1](#aibro-source-body)', 'viewing draft links never adopts the proposed body');
});

test('a source link cannot leave active composition or retarget a replaced note', async () => {
  const opened = [], h = harness({ onOpenLink: (id, url, options) => { opened.push({ id, url, options }); return true; } });
  h.mount('n', { mode: 'rich' }); await settle(); const rich = h.current('visual');
  rich.beginComposition(); assert.equal(rich.config.onOpenDocumentLink('#aibro-source-one'), false); assert.equal(opened.length, 0);
  rich.commitComposition(raw); assert.equal(rich.config.onOpenDocumentLink('#aibro-source-one', { isCurrent: () => false }), false);
  assert.equal(rich.config.onOpenDocumentLink('#aibro-source-one', { isCurrent: () => true }), true);
  assert.equal(opened[0].options.isCurrent(), true);
  assert.throws(() => rich.config.onOpenDocumentLink('second.md'), /没有可用的文档来源/);
  h.api.unmount({ force: true }); h.mount('other', { mode: 'rich' }); await settle();
  assert.equal(opened[0].options.isCurrent(), false); assert.equal(rich.config.onOpenDocumentLink('#aibro-source-one'), false);
  assert.equal(opened.length, 1); assert.equal(h.state.notes[0].content, raw); assert.equal(h.calls.saves, 0);
});

test('read-source-rich mode round trips preserve standard source links and saving retains provenance', async () => {
  const state = initial(), text = '结论 [1](#aibro-source-run-s1)'; state.notes[0].content = text;
  state.notes[0].provenance = { version: 1, origin: { recorded: true, runId: 'run' }, inputs: [{ sourceId: 'run-s1', type: 'import', id: 'pdf', page: 16 }] };
  const receipt = JSON.stringify(state.notes[0].provenance), h = harness({ state });
  h.mount(); await settle(); await h.click('edit'); assert.equal(h.current('source').getValue(), text);
  await h.click('rich'); assert.equal(h.current('visual').getValue(), text);
  h.current('visual').type(text + '\n\n人工补充'); await h.click('preview'); await h.click('edit');
  assert.equal(h.current('source').getValue(), text + '\n\n人工补充'); assert.equal(await h.api.save(), true);
  assert.equal(state.notes[0].content, text + '\n\n人工补充'); assert.equal(JSON.stringify(state.notes[0].provenance), receipt);
});


test('real note host coordinates mode undo, keeps history after save and resets only external loads', async()=>{
 const h=harness({history:true});h.mount('n',{mode:'rich'});await settle();await settle();
 const visual=h.current('visual');visual.type(raw+'可视');await h.click('edit');h.current('source').type(raw+'源码');await h.click('rich');
 h.current('visual').config.onHistory('undo');await settle();assert.equal(h.api.snapshot().mode,'edit');assert.equal(h.api.currentContent().content,raw+'可视');assert.match(h.el('note-document-status').textContent,/已撤销源码/);
 h.current('source').config.onHistory('undo');await settle();assert.equal(h.api.snapshot().mode,'rich');assert.equal(h.api.currentContent().content,raw);
 h.current('visual').config.onHistory('redo');await settle();assert.equal(h.api.currentContent().content,raw+'可视');
 await h.api.save();assert.equal(h.state.notes[0].content,raw+'可视');h.current('visual').config.onHistory('undo');await settle();assert.equal(h.api.currentContent().content,raw);assert.equal(h.state.notes[0].content,raw+'可视','editor undo never silently writes a saved note');
 h.state.notes[0].content=raw+'外部';h.state.notes[0].updatedAt++;await h.click('reload');h.current('visual').type(raw+'外部再编辑');h.current('visual').config.onHistory('undo');await settle();assert.equal(h.api.currentContent().content,raw+'外部');
 h.current('visual').config.onHistory('undo');await settle();assert.equal(h.api.currentContent().content,raw+'外部','old history cannot cross an explicit external reload');
});
test('AI raw replacement uses source history and undo returns to the prior visual draft byte-for-byte', async()=>{
 const h=harness({history:true,canvas:true});h.mount('n',{mode:'rich'});await settle();await settle();const manual=raw+'手工';h.current('visual').type(manual);
 const canvas=h.canvasHooks;assert.ok(canvas);const next='\ufeff---\r\ntitle: AI\r\n---\r\n\r\nAI 改写\n';
 assert.equal(canvas.writeDraft(next,{expected:manual,start:0,end:next.length}),true);await settle();assert.equal(h.api.snapshot().mode,'edit');assert.equal(h.api.currentContent().content,next);
 h.current('source').config.onHistory('undo');await settle();assert.equal(h.api.currentContent().content,manual);h.current('source').config.onHistory('undo');await settle();assert.equal(h.api.snapshot().mode,'rich');assert.equal(h.api.currentContent().content,raw);assert.equal(h.calls.saves,0);
});

test('late visual readiness cannot steal the active source timeline or discard its second redo',async()=>{
 const ready=deferred(),h=harness({history:true,ready:kind=>kind==='visual'?ready.promise:Promise.resolve(true)});
 h.mount('n',{mode:'rich'});await settle();await h.click('edit');h.current('source').type(raw+'第一步');ready.resolve(true);await settle();await settle();
 h.current('source').type(raw+'第二步');h.current('source').config.onHistory('undo');await settle();assert.equal(h.api.currentContent().content,raw+'第一步');
 h.current('source').config.onHistory('undo');await settle();assert.equal(h.api.currentContent().content,raw);
 h.current('source').config.onHistory('redo');await settle();h.current('source').config.onHistory('redo');await settle();assert.equal(h.api.currentContent().content,raw+'第二步');
});
test('pending undo cannot act on a mode selected while its flush was waiting',async()=>{
 const pending=deferred();let wait=false;const h=harness({history:true,flushPending:()=>wait?pending.promise:true});h.mount('n',{mode:'rich'});await settle();await settle();h.current('visual').type(raw+'视觉');
 wait=true;h.current('visual').config.onHistory('undo');await settle();const changing=h.click('edit');pending.resolve(true);await changing;await settle();assert.equal(h.api.currentContent().content,raw+'视觉');assert.equal(h.api.snapshot().mode,'edit');
});

test('first AI draft from reading cold-loads source before creating its undoable replacement',async()=>{
 const state=initial();state.notes[0].aiDraft={title:'AI 标题',content:raw+'AI 草稿'};
 const h=harness({history:true,state,lazy:{promise:Promise.resolve()}}),loader=h.env.DocumentEditors.ensure;
 delete h.env.DocumentEditHistory;h.env.DocumentEditors.ensure=async()=>{await loader();h.env.DocumentEditHistory=require('./editor-history-fixture.cjs')};
 h.mount('n',{mode:'read'});await settle();await h.click('apply-ai');await settle();assert.equal(h.api.snapshot().mode,'edit');assert.equal(h.api.currentContent().content,raw+'AI 草稿');
 h.current('source').config.onHistory('undo');await settle();assert.equal(h.api.currentContent().content,raw);assert.equal(h.calls.saves,0);
});


test('keyboard save restores the same visual/source editor and directional selection after WebKit readonly blur', async () => {
  for (const mode of ['rich', 'edit']) for (const direction of ['forward', 'backward']) {
    const pending = deferred(), h = harness({ nativeFocus:true, save:() => pending.promise });
    h.mount('n', {mode}); await settle(); const editor = h.current(mode === 'rich' ? 'visual' : 'source');
    editor.type(raw + ' manual'); editor.setSelectionRange(5, 10, direction); editor.focus(); const original = editor.contentDOM;
    const saving = h.api.save(); await settle(); assert.equal(h.env.document.activeElement, h.env.document.body);
    pending.resolve(true); assert.equal(await saving, true);
    assert.equal(h.env.document.activeElement, original); assert.equal(editor.destroyed, false); assert.equal(editor.focusCount, 2);
    assert.deepEqual({...editor.selectionSource()}, {start:5,end:10,direction,exact:true}); assert.equal(editor.sets.length, 0);
    assert.equal((h.environmentListeners.blur || []).length, 0, 'temporary save guards are removed');
  }
});
test('Ctrl/Cmd S surface shortcuts preserve a caret and do not create an additional save', async () => {
  for (const modifier of ['ctrlKey', 'metaKey']) {
    const pending=deferred(),h=harness({nativeFocus:true,save:()=>pending.promise});h.mount('n',{mode:'rich'});await settle();const editor=h.current('visual');
    editor.type(raw+' shortcut');editor.setSelectionRange(7,7,'none');editor.focus();
    const event=await h.el('note-document').fire('keydown',{key:'s',[modifier]:true,target:editor.contentDOM});await settle();
    assert.equal(event.defaultPrevented,true);assert.equal(h.calls.saves,1);pending.resolve(true);await settle();
    assert.equal(h.env.document.activeElement,editor.contentDOM);assert.equal(editor.selectionSource().start,7);assert.equal(editor.selectionSource().end,7);
  }
});
test('toolbar save never redirects focus to prose even when macOS leaves focus in the editor on button click', async () => {
  const h=harness({nativeFocus:true});h.mount('n',{mode:'rich'});await settle();const editor=h.current('visual');editor.type(raw+' clicked');editor.focus();
  assert.equal(await h.toolbar.props.onSave(),true);assert.equal(editor.focusCount,1);assert.equal(h.env.document.activeElement,h.env.document.body);
});
test('a failed save and unchanged recovery cleanup restore keyboard editing without resetting history', async () => {
  for (const scenario of ['failed','unchanged']) {
    const h=harness({nativeFocus:true,history:true,...(scenario==='failed'?{save:()=>false}:{recovery:{}})});h.mount('n',{mode:'rich'});await settle();await settle();const editor=h.current('visual');
    if(scenario==='failed')editor.type(raw+' retained');editor.setSelectionRange(3,3,'none');editor.focus();const setsBefore=editor.sets.length;
    assert.equal(await h.api.save(),scenario!=='failed');assert.equal(h.env.document.activeElement,editor.contentDOM);assert.equal(editor.selectionSource().start,3);
    assert.equal(editor.sets.length,setsBefore);assert.equal(h.api.currentContent().content,scenario==='failed'?raw+' retained':raw);
  }
});
test('user focus, input, pointer, scroll or window blur during pending save cancels focus restoration', async () => {
  for (const intent of ['focus','keydown','pointerdown','wheel','blur']) {
    const pending=deferred(),h=harness({nativeFocus:true,save:()=>pending.promise});h.mount('n',{mode:'rich'});await settle();const editor=h.current('visual');editor.type(raw+' pending');editor.focus();
    const saving=h.api.save();await settle();
    if(intent==='focus'){const elsewhere=h.env.document.createElement('input');h.env.document.body.append(elsewhere);elsewhere.focus();elsewhere.remove();h.env.document.activeElement=h.env.document.body;}
    else if(intent==='blur')for(const listener of h.environmentListeners.blur || [])listener();
    else h.env.document.fire(intent,{target:h.env.document.body});
    pending.resolve(true);assert.equal(await saving,true);assert.equal(editor.focusCount,1);assert.equal(h.env.document.activeElement,h.env.document.body);
  }
});
test('pending navigation and forced document replacement do not reclaim editor focus after save', async () => {
  for(const intent of ['leave','replace']){
    const pending=deferred(),h=harness({nativeFocus:true,save:()=>pending.promise});h.mount('n',{mode:'rich'});await settle();const editor=h.current('visual');editor.type(raw+' old');editor.focus();const saving=h.api.save();await settle();let leaving;
    if(intent==='leave')leaving=h.api.beforeLeave();else {h.api.unmount({force:true});h.mount('other',{mode:'edit'});await settle();h.current('source').focus();}
    pending.resolve(true);await saving;if(leaving)await leaving;assert.equal(editor.focusCount,1);
    assert.equal(h.env.document.activeElement,intent==='leave'?h.env.document.body:h.current('source').contentDOM);
  }
});
test('inexact visual source mapping preserves the adapter model selection without an unsafe raw range conversion', async () => {
  const h=harness({nativeFocus:true,inexactSelection:true});h.mount('n',{mode:'rich'});await settle();const editor=h.current('visual');editor.type(raw+' **bold**');editor.setSelectionRange(4,11,'backward');editor.focus();
  assert.equal(await h.api.save(),true);assert.equal(h.env.document.activeElement,editor.contentDOM);assert.equal(editor.selectionSource().start,4);assert.equal(editor.selectionSource().end,11);assert.equal(editor.selectionSource().direction,'backward');
});
