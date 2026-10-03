// Current component and clock source, compiled in memory. No browser/native UI,
// published bundle, user state, provider or real network is used by this check.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { build } = require('esbuild');
const { parseHTML } = require(process.env.AIBRO_TEST_DOM_MODULE || 'linkedom');
const repo = path.resolve(__dirname, '..');
const bundled = build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
  import {AgentLifecycleSummary} from './app/ui/agent-lifecycle.jsx';
  window.fixtureMount = (host, props) => { const root=createRoot(host); let current=props;
    const update=next=>{current={...current,...next};flushSync(()=>root.render(<AgentLifecycleSummary {...current}/>));};
    update({}); return {update, destroy:()=>flushSync(()=>root.unmount())}; };`, resolveDir: repo, loader: 'jsx' },
  bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'text' } }).then(value => value.outputFiles[0].text);

async function fixture() {
  const { window } = parseHTML('<html lang="zh"><head></head><body><div id="host"></div><div id="body">Synthetic unchanged long reply.</div></body></html>');
  let time = 1790928000000, serial = 0;
  const jobs = new Map(), observers = new Set(), listeners = new Map(), errors = [];
  class FixtureDate extends Date { static now() { return time; } }
  const media = { matches: false, addEventListener() {}, removeEventListener() {} };
  window.HTMLElement.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, right: 600, bottom: 24, width: 600, height: 24 }; };
  const context = { document: window.document, Date: FixtureDate, performance: { now: () => time }, console: { ...console, error: (...args) => errors.push(args.join(' ')) },
    setTimeout: (callback, delay = 0) => { const id = ++serial; jobs.set(id, { callback, at: time + delay }); return id; }, clearTimeout: id => jobs.delete(id),
    setInterval: () => { throw Error('A separate reception interval is forbidden'); }, clearInterval() {},
    queueMicrotask, AbortController, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    navigator: { userAgent: 'Source DOM fixture' }, innerWidth: 1000, innerHeight: 800, matchMedia: () => media,
    getComputedStyle: node => ({ display: node.hidden ? 'none' : 'block', visibility: 'visible', opacity: '1', overflowX: 'visible', overflowY: 'visible' }),
    addEventListener: (name, callback) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
    removeEventListener: (name, callback) => listeners.get(name)?.delete(callback),
    IntersectionObserver: class { constructor(callback) { this.callback = callback; this.targets = new Set(); observers.add(this); } observe(node) { this.targets.add(node); } unobserve(node) { this.targets.delete(node); } disconnect() { observers.delete(this); } }
  };
  for (const key of ['MutationObserver', 'Node', 'Element', 'HTMLElement', 'HTMLIFrameElement', 'Event', 'CustomEvent']) context[key] = window[key];
  context.window = context; context.globalThis = context; context.self = context;
  vm.createContext(context);
  for (const source of ['stream-reception.js', 'agent-progress.js', 'activity-motion.js']) vm.runInContext(fs.readFileSync(path.join(repo, 'app', source), 'utf8'), context);
  vm.runInContext(await bundled, context);
  const host = window.document.querySelector('#host'), body = window.document.querySelector('#body');
  let receipt;
  const emitter = context.StreamReception.createEmitter(event => { receipt = context.StreamReception.reduce(receipt, event); });
  emitter.start();
  const mounted = context.fixtureMount(host, { status: 'running', phase: 'writing', label: '正在回答', detail: '', count: '1 项活动',
    startedAt: time, elapsed: '0 秒', streamReception: receipt, keyboardHint: '展开' });
  const drain = async () => {
    for (let i = 0; i < 8; i++) {
      await new Promise(setImmediate);
      for (const [id, job] of [...jobs]) if (job.at <= time && jobs.has(id)) { jobs.delete(id); job.callback(); }
    }
    assert.deepEqual(errors, []);
  };
  await drain();
  return { context, host, body, jobs, observers, emitter, mounted, drain,
    heading: () => host.querySelector('.progress-phase-label')?.textContent,
    async advance(ms) { time += ms; for (const [id, job] of [...jobs]) if (job.at <= time && jobs.has(id)) { jobs.delete(id); job.callback(); } await drain(); },
    async content() { emitter.content('output'); mounted.update({ streamReception: receipt }); await drain(); },
    async visibility(visible) { context.__aibroPresentationVisible = visible; for (const callback of listeners.get('aibro:presentation-visibility') || []) callback(); await drain(); },
    async surface(visible) { context.__aibroSurfaceVisible = visible; for (const callback of listeners.get('aibro:surface-visibility') || []) callback(); await drain(); },
    async end(status = 'completed') { emitter.finish(status); mounted.update({ status, streamReception: receipt, phase: 'settled', label: status }); await drain(); },
    async destroy() { mounted.destroy(); await drain(); context.ActivityMotion.destroy(); assert.equal(jobs.size, 0); }
  };
}
test('source React heading uses the one existing visible clock, waits and resumes without replacing reply DOM', async () => {
  const f = await fixture();
  try {
    const line = f.host.firstElementChild, text = f.body.firstChild;
    assert.equal(f.context.ActivityMotion.inspect().visibleClocks, 2, 'Elapsed and reception nodes share one timer');
    assert.equal(f.jobs.size, 1); assert.equal(f.heading(), '正在回答');
    await f.advance(15000); assert.equal(f.heading(), '等待模型响应 · 15 秒');
    assert.ok(f.host.querySelector('[data-reception-quiet]'));
    assert.equal(f.host.querySelector('[data-halaska-orb]'), null, 'Quiet wait does not keep a writing orb running');
    await f.content(); assert.equal(f.heading(), '正在回答'); assert.ok(f.host.querySelector('[data-halaska-orb]'));
    await f.advance(16000); assert.equal(f.heading(), '暂未收到新内容 · 16 秒');
    assert.equal(f.host.firstElementChild, line); assert.equal(f.body.firstChild, text); assert.equal(f.jobs.size, 1);
    await f.end(); assert.equal(f.host.querySelector('[data-reception-clock]'), null); assert.equal(f.jobs.size, 0);
  } finally { await f.destroy(); }
});
test('hidden or private native surface releases shared timer and re-entry catches up once', async () => {
  const f = await fixture();
  try {
    await f.content(); await f.visibility(false); assert.equal(f.jobs.size, 0);
    await f.advance(60000); assert.equal(f.heading(), '正在回答');
    await f.visibility(true); assert.equal(f.heading(), '暂未收到新内容 · 60 秒'); assert.equal(f.jobs.size, 1);
    await f.surface(false); assert.equal(f.jobs.size, 0);
    await f.advance(1000); await f.surface(true); assert.equal(f.heading(), '暂未收到新内容 · 61 秒'); assert.equal(f.jobs.size, 1);
  } finally { await f.destroy(); }
});
test('replaced run and cancellation clear quiet state, no old timer can revive it', async () => {
  const f = await fixture();
  try {
    await f.advance(20000); assert.ok(f.host.querySelector('[data-reception-quiet]'));
    const late = [...f.jobs.values()].map(job => job.callback);
    let second;
    const emitter = f.context.StreamReception.createEmitter(event => { second = f.context.StreamReception.reduce(second, event); });
    emitter.start();
    f.mounted.update({ streamReception: second, startedAt: second.startedAt, label: '等待模型', phase: 'waiting' }); await f.drain();
    assert.equal(f.host.querySelector('[data-reception-quiet]'), null); assert.equal(f.heading(), '等待模型');
    await f.end('cancelled');
    for (const callback of late) callback(); await f.drain();
    assert.equal(f.host.querySelector('[data-reception-clock]'), null); assert.equal(f.heading(), undefined); assert.equal(f.jobs.size, 0);
  } finally { await f.destroy(); }
});
test('offscreen active heading has no clock work and reduced motion retains waiting facts', async () => {
  const f = await fixture();
  try {
    const intersect = visible => {
      for (const observer of f.observers) observer.callback([...observer.targets].map(target => ({ target, isIntersecting: visible,
        intersectionRect: { width: visible ? 600 : 0, height: visible ? 24 : 0 } })));
    };
    intersect(false); await f.drain(); assert.equal(f.jobs.size, 0);
    await f.advance(30000); assert.equal(f.heading(), '正在回答');
    f.context.document.body.classList.add('reduce-motion'); intersect(true); await f.drain();
    assert.equal(f.heading(), '等待模型响应 · 30 秒'); assert.equal(f.jobs.size, 1);
    await f.content(); assert.equal(f.heading(), '正在回答');
    await f.end('cancelled'); assert.equal(f.jobs.size, 0);
  } finally { await f.destroy(); }
});
