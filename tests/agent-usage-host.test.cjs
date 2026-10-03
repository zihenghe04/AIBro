const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const Usage = require('../app/agent-usage'), Flow = require('../app/conversation-flow');
const source = fs.readFileSync(require.resolve('../app/app'), 'utf8');
const cut = (start, end) => { const a = source.indexOf(start), b = source.indexOf(end, a); assert.ok(a >= 0 && b > a); return source.slice(a, b); };
const route = { provider: 'api', model: 'fixture' };
function hooks(currentRoute = () => route) {
 const run = {}, liveMessage = {}, usageRecorder = Usage.create(run, liveMessage), conversationFlow = Flow.create(liveMessage); let owns = true, saves = 0;
 const ctx = vm.createContext({ run, liveMessage, usageRecorder, conversationFlow, usageRoute: currentRoute, ownsRun: () => owns, save: () => saves++, refreshLive() {}, window: {} });
 vm.runInContext(cut('  const onAttempt = event => {', '  const onSources =') + cut('  const onUsage = (usage, meta)', "  stage('分析目标") + '\nthis.hooks = {onAttempt,onUsage,compactionUsage};', ctx);
 return { run, liveMessage, h: ctx.hooks, saves: () => saves, replaceOwner: () => { owns = false; } };
}

test('actual app callbacks persist both finished attempts and compatibility totals without changing flow settlement', () => {
 const f = hooks(); for (const id of ['a', 'b']) { f.h.onAttempt({ id, status: 'running' }); f.h.onUsage({ input: 10, output: 2, total: 12 }, { attemptId: id }); f.h.onAttempt({ id, status: 'completed' }); }
 assert.equal(f.run.usage.total, 24); assert.equal(f.liveMessage.usage.total, 24); assert.equal(f.saves(), 2);
 const saved = JSON.parse(JSON.stringify(f.run)); assert.equal(Usage.view(f.liveMessage, saved).usage.total, 24);
 const before = JSON.stringify(f.run); f.replaceOwner(); f.h.onAttempt({ id: 'c', status: 'running' }); f.h.onUsage({ total: 500 }, { attemptId: 'c' }); assert.equal(JSON.stringify(f.run), before);
});

test('actual history-compaction callbacks contribute without clearing main prose or adding flow blocks', () => {
 const f = hooks(); f.liveMessage.text = 'retained main prose'; const cb = f.h.compactionUsage;
 cb.onAttempt({ id: 'compact', status: 'running' }); cb.onUsage({ input: 3, output: 1, total: 4 }, { attemptId: 'compact' }); cb.onAttempt({ id: 'compact', status: 'completed' });
 assert.equal(f.run.usage.total, 4); assert.equal(f.run.usageLedger.attempts[0].purpose, 'history-compaction'); assert.equal(f.liveMessage.text, 'retained main prose'); assert.equal(f.liveMessage.conversationFlow.items.length, 0);
 assert.match(source, /signal:attachmentSignal,\.\.\.compactionUsage/);
});

test('actual child host request uses its registered tool parent for usage callbacks', async () => {
 const run = { toolCalls: [{ id: 'child', type: 'delegate' }] }, liveMessage = {}, recorder = Usage.create(run, liveMessage); let options, resolved = { provider: 'api', model: '' };
 const childSource = cut('        ask:(text,blocks,{signal,child})=>', '\n      return executeReadTool');
 const expression = childSource.slice(childSource.indexOf('ask:') + 4).replace(/\}\);\s*$/, '');
 const ctx = vm.createContext({ run, provider: 'api', base: 'https://synthetic.invalid', model: 'fixture', effort: '', token: '', usageRoute: () => resolved, usageRecorder: recorder, ownsRun: () => true, requestAgentPlan: value => { options = value; }, conversationFlow: null, save() {}, refreshLive() {}, window: {} });
 // Extract the exact ask arrow from the scheduler object, preserving callback bodies.
 vm.runInContext('this.ask = ' + expression + ';', ctx);
 resolved = { provider: 'openai-auth', model: 'resolved-child-model' }; await ctx.ask('fixture', [], { child: { id: 'child' } }); options.onAttempt({ id: 'child-attempt', status: 'running' }); options.onUsage({ input: 2, output: 1, total: 3 }, { attemptId: 'child-attempt' }); options.onAttempt({ id: 'child-attempt', status: 'completed' });
 assert.equal(run.usage.total, 3); assert.equal(run.usageLedger.attempts[0].parentId, 'child'); assert.equal(run.usageLedger.attempts[0].model, 'resolved-child-model');
});

function markup(message, run) {
 const section = cut('    const usageView = window.AgentUsage?.view', '      // 重新生成 /');
 const ctx = vm.createContext({ message, metaRun: run, window: { AgentUsage: Usage, UsageCost: require('../app/usage-cost') }, state: { settings: { usagePrice: { currency: '$', input: 2, output: 8 } } }, elapsed: '', processFeed: false, document: { createElement: () => ({}) }, esc: value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'), formatTokenCount: value => String(value) });
 vm.runInContext('this.result = (() => {' + section + 'return parts.join(""); } return "";})();', ctx); return ctx.result;
}

test('actual metadata is compact for complete usage and truthful for partial, missing, zero and legacy records', () => {
 const run = {}, message = {}, r = Usage.create(run, message); r.attempt({ id: 'a', status: 'running' }, route); r.report({ input: 10, output: 2, total: 12 }, { attemptId: 'a' }); r.attempt({ id: 'a', status: 'completed' });
 const full = markup(message, run); assert.match(full, />12 tokens<\/span>/); assert.match(full, /title="[^\"]*1\/1 次请求有用量/); assert.match(full, /meta-cost/);
 r.attempt({ id: 'b', status: 'running' }, route); r.attempt({ id: 'b', status: 'cancelled' }); const partial = markup(message, run); assert.match(partial, />12 tokens · 已报告<\/span>/); assert.doesNotMatch(partial, /meta-cost/);
 const legacy = markup({ usage: { input: 10, output: 2, total: 12 } }, {}); assert.match(legacy, />12 tokens<\/span>/); assert.match(legacy, /历史记录仅保存最后一次请求/); assert.doesNotMatch(legacy, /meta-cost/);
 const zero = { usageLedger: { version: 1, attempts: [{ id: 'z', status: 'completed', ...route, usage: { input: 0, output: 0, total: 0 } }] } }; assert.match(markup({}, zero), />0 tokens<\/span>/);
 zero.usageLedger.attempts[0].usage = null; assert.match(markup({}, zero), />用量未提供<\/span>/);
});

test('usage asset is registered once before app host and both reply-copy paths remove any ledger', () => {
 const html = fs.readFileSync(require.resolve('../app/index.html'), 'utf8'), manifest = require('../app/asset-manifest.json');
 assert.equal(manifest.web.filter(x => x === 'agent-usage.js').length, 1); assert.equal(html.split('src="agent-usage.js"').length - 1, 1); assert.ok(html.indexOf('src="agent-usage.js"') < html.indexOf('src="app.js"'));
 const copies = [...source.matchAll(/for \(const key of \[[^\n]+\]\) delete copy\[key\];/g)].filter(m => m[0].includes("'conversationFlow'")); assert.equal(copies.length, 2);
 for (const match of copies) { const ctx = vm.createContext({ copy: { text: 'retained answer', usage: { total: 12 }, usageLedger: { version: 1 }, runId: 'old' } }); vm.runInContext(match[0], ctx); assert.deepEqual(Object.keys(ctx.copy), ['text']); }
});


test('host callback route reflects resolved connection after an initially empty or stale model', () => {
 for (const initial of ['', 'stale-model']) {
  let resolved = { provider: 'api', model: initial }; const f = hooks(() => resolved);
  resolved = { provider: 'openai-auth', model: 'resolved-model' };
  f.h.onAttempt({ id: 'main', status: 'running' }); f.h.onUsage({ total: 7 }, { attemptId: 'main' }); f.h.onAttempt({ id: 'main', status: 'completed' });
  f.h.compactionUsage.onAttempt({ id: 'compact', status: 'running' }); f.h.compactionUsage.onUsage({ total: 3 }, { attemptId: 'compact' }); f.h.compactionUsage.onAttempt({ id: 'compact', status: 'completed' });
  assert.equal(f.run.usage.total, 10); assert.ok(f.run.usageLedger.attempts.every(a => a.provider === 'openai-auth' && a.model === 'resolved-model'));
 }
 assert.match(source, /usageRoute = \(\) => \(\{ provider, model \}\)/);
});
