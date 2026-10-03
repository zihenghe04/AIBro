// Actual controllers + production-patched Kit/React in isolated Node DOM.
// No user workspace, model requests, GUI or production bundle writes.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { parseHTML } = require(process.env.AIBRO_TEST_DOM_MODULE || 'linkedom');
const ROOT = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aibro-tool-issues-'));
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
const bundlePath = path.join(temp, 'halaska-ui.js');
// Reuse every production source patch, stopping before font/provenance writes.
let build = fs.readFileSync(path.join(ROOT, 'scripts/build-halaska-ui.mjs'), 'utf8').split('for (const [from, to]')[0];
build = build.replace("const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');", `const root = ${JSON.stringify(ROOT)};`)
  .replace("from 'esbuild'", `from ${JSON.stringify(pathToFileURL(require.resolve('esbuild', { paths: [ROOT] })).href)}`)
  .replace("'./halaska-data-table-patch.mjs'", JSON.stringify(pathToFileURL(path.join(ROOT, 'scripts/halaska-data-table-patch.mjs')).href))
  .replace("outfile: path.join(root, 'app/halaska-ui.js')", `outfile: ${JSON.stringify(bundlePath)}`);
const buildPath = path.join(temp, 'isolated-kit-build.mjs'); fs.writeFileSync(buildPath, build);
execFileSync(process.execPath, [buildPath], { cwd: ROOT, stdio: 'pipe' });
const bundle = fs.readFileSync(bundlePath, 'utf8');
const appSource = fs.readFileSync(path.join(ROOT, 'app/app.js'), 'utf8');
const from = appSource.indexOf("document.addEventListener('conversation-process-view'");
const to = appSource.indexOf('// Remember deliberate disclosure', from);
assert.ok(from > 0 && to > from);
const listener = appSource.slice(from, to);

const call = (id, status = 'completed', error) => ({ id, type: 'read', status, request: { id: `source-${id}` }, result: { result: { title: `Fictional source ${id}`, text: 'Recorded content' } }, ...(error ? { error } : {}) });
async function fixture({ language = 'zh', calls = [call('ok'), call('bad', 'failed', 'Synthetic read timeout')], progress = true, message: extra = {} } = {}) {
  const { window } = parseHTML(`<html lang="${language}"><head></head><body><main id="root"></main></body></html>`);
  Object.defineProperty(window.HTMLElement.prototype, 'open', { configurable: true, get() { return this.hasAttribute('open'); }, set(value) { value ? this.setAttribute('open', '') : this.removeAttribute('open'); } });
  const errors = [], jobs = new Map(); let serial = 0, focus = null, selection = null;
  const context = { document: window.document, console: { ...console, error: (...args) => errors.push(args.map(String).join(' ')) },
    Date, performance: { now: () => 1000 }, queueMicrotask, AbortController, navigator: { userAgent: 'Node fixture' },
    setTimeout: callback => { const id = ++serial; jobs.set(id, callback); return id; }, clearTimeout: id => jobs.delete(id),
    setInterval: () => 0, clearInterval() {}, requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {},
    getSelection: () => selection, fetch: () => { throw Error('Network is forbidden in this fixture'); },
    WorkstationI18n: { getLanguage: () => language, t: value => value },
  };
  Object.defineProperty(window.document, 'activeElement', { configurable: true, get: () => focus || window.document.body });
  for (const key of ['MutationObserver', 'Element', 'HTMLElement', 'HTMLIFrameElement', 'Node', 'Event', 'CustomEvent']) context[key] = window[key];
  context.window = context; context.self = context; context.globalThis = context; vm.createContext(context); vm.runInContext(bundle, context);
  for (const file of ['agent-progress.js', 'tool-scheduler.js', 'conversation-process.js', 'halaska-conversation.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'app', file), 'utf8'), context);
  const message = { id: 'msg-test', role: 'agent', text: 'Answer retained', runId: 'run-test', runStatus: 'completed', ...(progress ? { activities: [{ id: 'progress-test', kind: 'commentary', text: 'A real event', status: 'completed' }] } : {}), ...extra };
  const run = { id: 'run-test', status: 'completed', toolCalls: calls };
  context.state = { conversations: [{ id: 'conv-test', messages: [message] }], agentRuns: [run] };
  let saves = 0; context.save = () => { saves++; }; vm.runInContext(listener, context);
  const mount = previous => {
    const wrapper = window.document.createElement('article'); wrapper.className = 'message-wrap'; wrapper.dataset.messageId = message.id;
    wrapper.innerHTML = context.AgentProgress.markup(message) + '<div class="message-body">Answer retained</div>';
    context.ConversationProcess.compose(wrapper, message, run);
    context.HalaskaConversation.enhance(wrapper, message, run, { previous }); return wrapper;
  };
  const wrapper = mount(); window.document.querySelector('#root').append(wrapper);
  const drain = async () => { for (let i = 0; i < 5; i++) { await new Promise(setImmediate); const current = [...jobs.values()]; jobs.clear(); current.forEach(fn => fn()); } assert.deepEqual(errors, []); };
  await drain();
  return { context, wrapper, message, run, drain, saves: () => saves,
    row: id => wrapper.querySelector(`[data-tool-id="${id}"]`),
    button: text => [...wrapper.querySelectorAll('.conversation-tool-filters button')].find(node => node.textContent === text),
    click: button => { assert.ok(button, 'Expected a real Kit button'); button.dispatchEvent(new window.Event('click', { bubbles: true })); },
    update: () => { const next = mount(wrapper); context.AgentProgress.patchLive(wrapper, next); },
    focus: node => { focus = node; }, select: node => { selection = { isCollapsed: false, rangeCount: 1, anchorNode: node, focusNode: node, anchorOffset: 0, focusOffset: 3, toString: () => 'Syn', setBaseAndExtent() {} }; },
    close: () => { context.HalaskaConversation.discard(wrapper); wrapper.remove(); jobs.clear(); },
  };
}

test('a recovered run exposes only recorded failures, timeouts and interruptions, not deliberate stops or unknowns', async () => {
  const calls = Array.from({ length: 70 }, (_, i) => call(`ok-${i}`));
  calls.push(call('bad', 'failed', 'Synthetic permission failure'), call('timeout', 'timed_out'), call('interrupt', 'interrupted'), call('stop', 'cancelled'), call('decline', 'rejected'), call('unknown', 'unconfirmed'));
  const f = await fixture({ calls }); const before = JSON.stringify(f.run);
  assert.equal(f.context.ToolScheduler.issueCount(f.run), 3);
  assert.equal(f.wrapper.querySelector('.progress-issues').textContent, '3 次工具异常');
  assert.equal(f.row('bad').querySelector('.tool-ledger-error-preview').textContent, 'Synthetic permission failure');
  const body = f.wrapper.querySelector('.message-body'); const row = f.row('bad');
  f.click(f.button('仅看异常（3）')); await f.drain();
  assert.equal(f.message.processView, 'tools'); assert.equal(f.message.processToolFilter, 'issues'); assert.equal(f.saves(), 1);
  assert.equal(f.wrapper.querySelector('[data-live-key="process-progress-panel"]').hidden, true);
  assert.equal(f.wrapper.querySelectorAll('.tool-ledger-row:not([hidden])').length, 3);
  assert.equal(f.row('bad'), row); assert.equal(f.wrapper.querySelector('.message-body'), body);
  assert.equal(JSON.stringify(f.run), before, 'Inspection never changes tool execution or results');
  f.click(f.button('全部工具')); await f.drain(); assert.equal(f.wrapper.querySelectorAll('.tool-ledger-row:not([hidden])').length, 76);
  assert.equal(f.button('全部工具').getAttribute('aria-pressed'), 'true'); f.close();
});

test('filter and focused Kit button survive incremental additions, while real issue counts update', async () => {
  const f = await fixture(); f.click(f.button('仅看异常（1）')); await f.drain();
  const button = f.button('仅看异常（1）'), row = f.row('bad'); f.focus(button);
  f.run.toolCalls.push(call('second', 'failed', 'A second recorded error'), call('later-ok'));
  f.update(); await f.drain();
  assert.equal(f.button('仅看异常（2）'), button); assert.equal(f.row('bad'), row);
  assert.equal(f.row('later-ok').hidden, true); assert.equal(f.row('second').hidden, false);
  assert.equal(button.getAttribute('aria-pressed'), 'true'); assert.equal(f.message.processToolFilter, 'issues'); f.close();
});

test('a corrected outcome preserves a selected row for this render and offers the all-tools escape', async () => {
  const f = await fixture(); f.click(f.button('仅看异常（1）')); await f.drain();
  const text = f.row('bad').querySelector('.tool-ledger-error-preview').firstChild;
  f.select(text); f.focus(f.row('bad').querySelector('summary'));
  f.run.toolCalls[1].status = 'completed'; delete f.run.toolCalls[1].error;
  f.update(); await f.drain();
  assert.equal(f.row('bad').hidden, false, 'The exact focused row stays readable during replacement');
  assert.equal(f.wrapper.querySelector('.progress-issues'), null); assert.equal(f.row('bad').querySelector('.tool-ledger-error-preview'), null);
  assert.equal(f.wrapper.querySelector('.conversation-tools-empty').hidden, false); assert.ok(f.button('全部工具'));
  f.focus(null); f.select(null); f.context.getSelection = () => null; f.update(); await f.drain(); assert.equal(f.row('bad').hidden, true);
  f.click(f.button('全部工具')); await f.drain(); assert.equal(f.row('bad').hidden, false); f.close();
});

test('tool-only history and persisted filters expose controls even when no issues remain', async () => {
  const f = await fixture({ progress: false, calls: [call('ok')], message: { processToolFilter: 'issues' } });
  assert.equal(f.wrapper.querySelector('.conversation-process-navigation').hidden, false);
  assert.equal(f.wrapper.querySelectorAll('[role="tab"]').length, 1); assert.ok(f.button('全部工具'));
  assert.equal(f.row('ok').hidden, true); f.click(f.button('全部工具')); await f.drain(); assert.equal(f.row('ok').hidden, false); f.close();
});

test('English, multiline unsafe error text, durable row choices and the original full error remain intact', async () => {
  const error = '<img src=x onerror=alert(1)>\n' + 'Long recorded error. '.repeat(100);
  const f = await fixture({ language: 'en', calls: [call('bad', 'failed', error)] });
  const field = f.row('bad').querySelector('[data-live-key="error"] .tool-ledger-text-field');
  assert.ok(field); assert.equal(field.querySelector('.tool-ledger-full-text'), null);
  f.run.toolLedgerPins = { bad: true, 'raw:bad': true }; f.update(); await f.drain();
  assert.equal(f.row('bad').querySelector('img'), null); assert.equal(f.row('bad').querySelector('.tool-ledger-error-preview').textContent, error);
  f.run.toolLedgerPins[field.dataset.toolLedgerKey] = true; f.update(); await f.drain();
  assert.equal(f.row('bad').querySelector('[data-live-key="error"] .tool-ledger-full-text').textContent, error);
  assert.equal(f.row('bad').querySelector('img'), null);
  assert.equal(f.row('bad').open, true); assert.equal(f.row('bad').querySelector('.tool-ledger-raw').open, true);
  assert.ok(f.button('Issues only (1)')); assert.equal(f.wrapper.querySelector('.progress-issues').textContent, '1 tool issue'); f.close();
});

test('invalid filters and stale message events cannot mutate current conversation preferences', async () => {
  const f = await fixture();
  for (const detail of [{ messageId: 'removed', view: 'tools', filter: 'issues' }, { messageId: f.message.id, view: 'tools', filter: 'bogus' }]) f.context.document.dispatchEvent(new f.context.CustomEvent('conversation-process-view', { detail }));
  assert.equal(f.saves(), 0); assert.equal(f.message.processToolFilter, undefined); f.close();
});
