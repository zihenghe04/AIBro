// Real offline production bundle + React root in a Node DOM adapter. This is
// state/lifetime acceptance, not WebKit layout, FPS or native visual approval.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML } = require(process.env.AIBRO_TEST_DOM_MODULE || '/tmp/aibro-stream-dom.7i7LZ9/node_modules/linkedom');
const bundle = fs.readFileSync(path.resolve(__dirname, '../app/halaska-ui.js'), 'utf8');
async function fixture() {
  const { window } = parseHTML('<html lang="zh"><head></head><body><div id="root"></div></body></html>');
  let time = 0, serial = 0;
  const jobs = new Map(), listeners = new Map(), mediaListeners = new Set(), observers = new Set(), errors = [];
  const media = { matches: false, addEventListener: (_, listener) => mediaListeners.add(listener), removeEventListener: (_, listener) => mediaListeners.delete(listener) };
  const context = { document: window.document, console: { ...console, error: (...args) => errors.push(args.map(String).join(' ')) }, Date, performance: { now: () => time }, queueMicrotask, AbortController,
    setTimeout: (callback, delay) => { const id = ++serial; jobs.set(id, { callback, at: time + (delay || 0) }); return id; }, clearTimeout: id => jobs.delete(id),
    setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {}, navigator: { userAgent: 'Node DOM fixture' }, matchMedia: () => media,
    addEventListener: (name, listener) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); },
    removeEventListener: (name, listener) => listeners.get(name)?.delete(listener),
    IntersectionObserver: class { constructor(callback) { this.callback = callback; observers.add(this); } observe(node) { this.node = node; } disconnect() { observers.delete(this); } }
  };
  for (const key of ['MutationObserver', 'Element', 'HTMLElement', 'HTMLIFrameElement', 'Node', 'Event', 'CustomEvent']) context[key] = window[key];
  context.window = context; context.self = context; context.globalThis = context; vm.createContext(context); vm.runInContext(bundle, context);
  const host = window.document.querySelector('#root');
  context.HalaskaUI.mount(host, 'AgentLifecycleSummary', { phase: 'thinking', status: 'running', label: '正在思考', detail: '阅读合成材料', count: '1 项活动', elapsed: '1 秒', startedAt: 1000, keyboardHint: '展开' });
  async function drain() {
    for (let pass = 0; pass < 8; pass++) {
      await new Promise(setImmediate);
      for (const [id, job] of [...jobs]) if (job.at <= time) { jobs.delete(id); job.callback(); }
    }
    assert.deepEqual(errors, []);
  }
  await drain();
  return { host, context, media, observers, listeners, drain,
    heading: () => host.querySelector('.progress-phase-label')?.textContent,
    update: values => context.HalaskaUI.update(host, values),
    tick: async next => { time = next; await drain(); },
    emit: name => { for (const listener of listeners.get(name) || []) listener(); },
    reduce: () => { media.matches = true; for (const listener of mediaListeners) listener(); },
    futureTimers: () => [...jobs.values()].filter(job => job.at > time).length,
    destroy: () => context.HalaskaUI.unmount(host),
  };
}
test('real lifecycle root stabilizes only its heading while counters and elapsed update immediately', async () => {
  const f = await fixture(), line = f.host.firstElementChild, orb = f.host.querySelector('[data-halaska-orb]');
  await f.tick(20); f.update({ phase: 'tool', label: '正在执行', detail: '读取下一份材料', count: '2 项活动', elapsed: '2 秒' });
  assert.equal(f.heading(), '正在思考'); assert.equal(f.host.querySelector('.progress-count').textContent, '2 项活动');
  assert.equal(f.host.querySelector('.progress-elapsed').textContent, '2 秒');
  await f.tick(80); f.update({ phase: 'writing', label: '正在回答', detail: '第一段正文已到达', count: '3 项活动' });
  await f.tick(150);
  assert.equal(f.heading(), '正在回答'); assert.equal(f.host.querySelector('.progress-heading-text').textContent, '第一段正文已到达');
  assert.equal(f.host.firstElementChild, line); assert.equal(f.host.querySelector('[data-halaska-orb]'), orb, 'Stable updates retain the actual kit host');
  assert.equal(f.futureTimers(), 0); f.destroy();
});
test('real lifecycle root immediately shows failure and approval without a late live title returning', async () => {
  for (const status of ['failed', 'awaiting-approval', 'awaiting-save', 'cancelled']) {
    const f = await fixture(); await f.tick(20); f.update({ phase: 'tool', label: '正在执行' });
    f.update({ status, phase: 'settled', label: status, detail: '', count: '2 项活动' });
    assert.equal(f.host.querySelector('[data-lifecycle-status]').dataset.lifecycleStatus, status);
    assert.equal(f.host.querySelector('[data-halaska-orb]'), null); assert.equal(f.heading(), undefined);
    await f.tick(500); assert.ok(f.host.textContent.startsWith(status)); assert.equal(f.futureTimers(), 0); f.destroy();
  }
});
test('reduced motion and native hidden surfaces flush the real pending heading and release its timer', async () => {
  for (const pause of [f => f.reduce(), f => { f.context.__aibroPresentationVisible = false; f.emit('aibro:presentation-visibility'); },
    f => { for (const observer of f.observers) observer.callback([{ isIntersecting: false }]); }]) {
    const f = await fixture(); await f.tick(20); f.update({ phase: 'tool', label: '正在执行' }); assert.equal(f.futureTimers(), 1);
    pause(f); await f.drain(); assert.equal(f.heading(), '正在执行'); assert.equal(f.futureTimers(), 0);
    await f.tick(30); f.update({ phase: 'writing', label: '正在回答' }); assert.equal(f.heading(), '正在回答'); assert.equal(f.futureTimers(), 0); f.destroy();
  }
});
test('unmount removes the real pending timer and native visibility subscriptions', async () => {
  const f = await fixture(); await f.tick(20); f.update({ phase: 'tool', label: '正在执行' }); assert.equal(f.futureTimers(), 1);
  f.destroy(); await f.drain(); assert.equal(f.futureTimers(), 0); assert.equal(f.observers.size, 0);
  assert.equal(f.listeners.get('aibro:presentation-visibility')?.size || 0, 0);
  assert.equal(f.listeners.get('aibro:surface-visibility')?.size || 0, 0);
  await f.tick(500); assert.equal(f.host.textContent, '');
});
test('outer phase animation respects the stable heading while tool feedback remains immediate', async () => {
  const f = await fixture(), animations = [];
  f.context.ActivityMotion = { animate: (node, frames, options) => animations.push({ node, options }) };
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../app/agent-progress.js'), 'utf8'), f.context);
  for (const stable of [true, false]) {
    const markup = (phase, state) => `<details class="agent-progress" data-progress-phase="${phase}"><summary><span ${stable ? 'data-lifecycle-stable-heading' : ''}><span class="progress-phase-label">${phase}</span></span></summary><ol><li data-activity-id="fixture-tool" data-activity-state="${state}"><span class="progress-mark">${state}</span></li></ol></details>`;
    const previous = f.context.document.createElement('div'), next = f.context.document.createElement('div');
    previous.innerHTML = markup('thinking', 'running'); next.innerHTML = markup('tool', 'completed');
    f.context.document.body.append(previous); animations.length = 0;
    f.context.AgentProgress.patchLive(previous, next);
    assert.equal(animations.filter(item => item.node?.classList.contains('progress-phase-label')).length, stable ? 0 : 1);
    assert.equal(animations.filter(item => item.node?.classList.contains('progress-mark')).length, 1);
    assert.ok(animations.every(item => item.options.duration === 220));
    assert.equal(previous.querySelector('[data-activity-id]').dataset.activityState, 'completed');
    previous.remove();
  }
  f.destroy();
});
