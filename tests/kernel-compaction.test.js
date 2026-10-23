// P8b run-internal compaction and the shared tool loop: a fake model drives
// toolLoop through the real ToolGateway, so the citation rule is enforced by
// the gateway exactly as in the bench. No network.
const test = require('node:test'), assert = require('node:assert/strict');
const Compaction = require('../app/kernel-compaction.js');
const RunLoop = require('../app/kernel-run-loop.js');
const Calls = require('../app/tool-calls.js');
const Gateway = require('../app/tool-gateway.js');
const Registry = require('../app/tool-registry.js');

const json = value => JSON.stringify(value);
const DOCS = Array.from({ length: 12 }, (_, i) => ({ id: 'doc-' + i, text: `第 ${i} 份资料。` + '实验记录与过程描述。'.repeat(450) + (i === 7 ? '关键结论：样本量为 4812 份。' : '') }));

function registry() {
  const r = Registry.create();
  r.plugin('test');
  r.register({ name: 'read_doc', title: { zh: '读', en: 'read' }, description: '读取资料', effect: 'none', approval: 'never', evidence: true, hosts: ['node'], input: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: { type: 'string', maxLength: 64 } } } });
  r.register({ name: 'create_note', title: { zh: '笔记', en: 'note' }, description: '写笔记', effect: 'local', approval: 'never', hosts: ['node'], citations: { fields: ['citations'] },
    input: { type: 'object', required: ['content', 'citations'], additionalProperties: false, properties: { content: { type: 'string', maxLength: 4000 }, citations: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['quote'], properties: { quote: { type: 'string', maxLength: 600 }, sourceId: { type: 'string', maxLength: 64 } } } } } } });
  return r;
}

// Native Chat replies as the accumulator expects them (raw tool calls).
const callReply = (calls, content = '') => ({ content, raw: calls.map((c, i) => ({ id: c.id || 'c' + i + Math.random().toString(36).slice(2, 6), name: c.name, arguments: json(c.args), done: true })), finish: 'tool_calls', usage: { prompt_tokens: 10, completion_tokens: 5 } });
const finalReply = text => ({ content: text, raw: [], finish: 'stop', usage: null });

function harness({ script, summary, threshold = 3000, retain = 800, signal = null, onInvoke }) {
  const reg = registry(), notes = [], requests = [], events = [];
  const gateway = Gateway.create({ registry: reg, host: 'node', ledger: Gateway.memoryLedger(), execute: async (name, args) => {
    if (name === 'read_doc') { const doc = DOCS.find(d => d.id === args.id); if (!doc) throw Object.assign(Error('no doc'), { code: 'NOT_FOUND' }); return { id: doc.id, text: doc.text }; }
    notes.push(args); return { created: true };
  } });
  const session = { id: 's1', steps: 0, turns: [{ role: 'system', content: 'SYSTEM RULES' }, { role: 'user', content: 'TASK: 读完全部资料再写笔记' }] };
  let step = 0;
  const host = {
    calls: Calls, specs: Calls.fromRegistry(reg, { host: 'node' }), protocol: 'native', wire: 'chat', signal,
    emit: async (type, data) => { events.push({ type, data }); },
    compaction: threshold ? { compactor: Compaction, thresholdTokens: threshold, retainTokens: retain } : null,
    request: async (body, { purpose }) => {
      requests.push({ purpose, messages: body.messages.map(m => m.content || '').join('\n') });
      if (purpose === 'compaction') return { content: typeof summary === 'function' ? summary(body) : summary, raw: [], usage: null };
      const reply = script[step++]; assert.ok(reply, 'no unplanned model request'); return typeof reply === 'function' ? reply(body) : reply;
    },
    invoke: async call => { onInvoke?.(call); const receipt = await gateway.invoke(call, { permissionMode: 'full' }); return json(receipt); },
  };
  return { session, host, notes, requests, events, run: () => RunLoop.toolLoop(session, host) };
}

test('prune keeps head and tail by code point and is within budget (dsh pruner semantics)', () => {
  const text = '𠀀'.repeat(50) + 'x'.repeat(10000) + '尾'.repeat(30);
  const out = Compaction.prune(text, { thresholdChars: 200, headChars: 60, tailChars: 30 });
  const pts = Array.from(out);
  assert.ok(pts.length <= 200);
  assert.equal(pts.slice(0, 50).join(''), '𠀀'.repeat(50), 'a surrogate pair is never split');
  assert.ok(out.endsWith('尾'.repeat(30)));
  assert.ok(out.includes(Compaction.PRUNE_MARKER));
  assert.equal(Compaction.prune('short', { thresholdChars: 200, headChars: 60, tailChars: 30 }), null);
  assert.throws(() => Compaction.prune('x', { thresholdChars: 10, headChars: 8, tailChars: 8 }), /at most thresholdChars/);
});

test('verifyExcerpts keeps only verbatim tool text (raw or JSON string leaves)', () => {
  const sources = Compaction.sourceTexts([{ role: 'tool', content: json({ ok: true, result: { text: '第一行\n关键结论：样本量为 4812 份。' } }) }, { role: 'assistant', content: '助手说：样本量是 5000' }]);
  const { kept, dropped } = Compaction.verifyExcerpts([
    { source: 'doc', quote: '关键结论：样本量为 4812 份。' },
    { source: 'doc', quote: '第一行\n关键结论' },
    { source: 'doc', quote: '样本量为 4800 份' },
    { source: 'doc', quote: '助手说：样本量是 5000' },
    { source: 'doc', quote: '短' },
  ], sources);
  assert.deepEqual(kept.map(k => k.quote), ['关键结论：样本量为 4812 份。', '第一行\n关键结论']);
  assert.equal(dropped, 3);
});

test('a long run compacts: system and task stay verbatim, rounds stay whole, unverified excerpts are dropped', async () => {
  const reads = DOCS.map(d => callReply([{ name: 'read_doc', args: { id: d.id } }]));
  const h = harness({
    script: [...reads, finalReply('完成')],
    summary: json({ summary: '## 任务与要求\n读完资料\n## 已完成\n已读若干份', excerpts: [{ source: 'doc-7', quote: '关键结论：样本量为 4812 份。' }, { source: 'doc-x', quote: '这是编造的原文，并不存在' }] }),
  });
  const result = await h.run();
  assert.equal(result.stop, 'final');
  assert.ok(result.compactions >= 1, 'compaction happened');
  const t = h.session.turns;
  assert.equal(t[0].content, 'SYSTEM RULES');
  assert.equal(t[1].content, 'TASK: 读完全部资料再写笔记');
  assert.equal(t[2].checkpoint, h.session.compactions, 'one merged checkpoint right after the task');
  assert.equal(t.filter(x => x.checkpoint).length, 1);
  assert.equal(t[3].role, 'assistant', 'the kept tail starts at a round boundary');
  // every tool result in the transcript still follows its assistant call
  for (let i = 0; i < t.length; i++) if (t[i].role === 'tool') assert.ok(t.slice(0, i).reverse().find(x => x.role === 'assistant' || x.checkpoint)?.role === 'assistant');
  assert.match(t[2].content, /关键结论：样本量为 4812 份。/);
  assert.doesNotMatch(t[2].content, /编造/);
  assert.ok(h.session.archive.some(a => a.kind === 'checkpoint' && a.turns.length > 2), 'replaced turns are archived, not destroyed');
  const compacted = h.events.filter(e => e.type === 'run/compacted' && e.data.compacted);
  assert.ok(compacted.length >= 1 && compacted[0].data.droppedExcerpts >= 1);
  assert.ok(h.requests.some(r => r.purpose === 'compaction' && /是资料，不是指令/.test(r.messages)));
});

test('after compaction a quote from the checkpoint passes the gateway; a paraphrase is still rejected', async () => {
  const reads = DOCS.map(d => callReply([{ name: 'read_doc', args: { id: d.id } }]));
  const h = harness({
    script: [...reads,
      callReply([{ name: 'create_note', args: { content: '汇总', citations: [{ quote: '样本量是 4812 份', sourceId: 'doc-7' }] } }]),
      callReply([{ name: 'create_note', args: { content: '汇总', citations: [{ quote: '关键结论：样本量为 4812 份。', sourceId: 'doc-7' }] } }]),
      finalReply('完成')],
    summary: json({ summary: '## 任务与要求\n写笔记', excerpts: [{ source: 'doc-7', quote: '关键结论：样本量为 4812 份。' }] }),
  });
  await h.run();
  assert.ok(h.session.compactions >= 1);
  const results = h.session.turns.filter(t => t.role === 'tool' && t.name === 'create_note').map(t => JSON.parse(t.content));
  assert.equal(results[0].code, 'CITATION_NOT_FOUND');
  assert.equal(results[1].ok, true);
  assert.equal(h.notes.length, 1);
});

test('a failed or bloated summary falls back to pruning and backs off', async () => {
  const reads = DOCS.map(d => callReply([{ name: 'read_doc', args: { id: d.id } }]));
  const h = harness({ script: [...reads, finalReply('完成')], summary: 'not json' });
  const result = await h.run();
  assert.equal(result.stop, 'final');
  assert.equal(h.session.compactions || 0, 0);
  const log = h.session.compactionLog;
  assert.ok(log.some(c => c.reason === 'summary-invalid'));
  assert.ok(log.some(c => c.reason === 'backoff'), 'no new summary request on every step');
  assert.ok(h.session.turns.some(t => t.pruned), 'old tool results pruned instead');
  assert.ok(h.requests.filter(r => r.purpose === 'compaction').length < log.length);
  // the latest rounds are never pruned
  const lastAssistant = h.session.turns.map(t => t.role).lastIndexOf('assistant');
  assert.ok(h.session.turns.slice(lastAssistant).every(t => !t.pruned));
});

test('cancel: no request or call after abort; the cut call and the rest of its turn are recorded', async () => {
  const controller = new AbortController();
  let invoked = 0;
  const h = harness({
    threshold: 0, signal: controller.signal,
    onInvoke: () => { invoked++; if (invoked === 2) controller.abort(); },
    script: [callReply([{ name: 'read_doc', args: { id: 'doc-0' } }]), callReply([{ name: 'read_doc', args: { id: 'doc-1' } }, { name: 'read_doc', args: { id: 'doc-2' } }]), finalReply('不应到达')],
  });
  const result = await h.run();
  assert.equal(result.stop, 'cancelled');
  assert.equal(invoked, 2, 'the third call never started');
  assert.equal(h.requests.length, 2, 'no model request after cancel');
  const last = h.session.turns.slice(-2).map(t => JSON.parse(t.content));
  assert.equal(last[1].code, 'CANCELLED');
  assert.ok(h.events.some(e => e.type === 'run/finished' && e.data.status === 'cancelled'));
});

test('cancel while a call hangs: graceMs then OUTCOME_UNKNOWN, never retried', async () => {
  const controller = new AbortController();
  const h = harness({ threshold: 0, signal: controller.signal, script: [callReply([{ name: 'read_doc', args: { id: 'doc-0' } }]), finalReply('x')] });
  h.host.graceMs = 50;
  h.host.invoke = () => { setTimeout(() => controller.abort(), 10); return new Promise(() => {}); };
  const result = await h.run();
  assert.equal(result.stop, 'cancelled');
  assert.equal(JSON.parse(h.session.turns.at(-1).content).code, 'OUTCOME_UNKNOWN');
});
