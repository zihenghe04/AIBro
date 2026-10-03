'use strict';

// Explicit, synthetic-only QA. Importing this module or omitting allowNetwork
// never contacts a provider. No credentials, endpoint, vectors, or workspace
// data are written, logged, or returned. The caller owns any evidence file.
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const R = require('../../app/context-retrieval');
const V = require('../../app/vector-index');
const K = require('../../app/knowledge-access');
const E = require('../../app/citation-evidence');

const MAIN = 'synthetic-learning', OTHER = 'synthetic-other';
const hash = value => createHash('sha256').update(value).digest('hex');
function fixture() {
  const ferry = '# Context\n\nThis is a fictional ferry study.\n\n## Observation\n\nAt a ferry pier, travelers waited exactly six minutes. Those who saw a departure countdown reported less anxiety. People given no timing information judged the interval longer. The proposed cause was uncertainty, not extra elapsed time.';
  return {
    projects: [{id: MAIN, name: 'Synthetic learning', workspace: '科研'}, {id: OTHER, name: 'Synthetic other project', workspace: '科研'}],
    notes: [
      {id: 'synthetic-ferry', projectId: MAIN, title: 'Record Indigo', content: ferry},
      {id: 'synthetic-learning', projectId: MAIN, title: '合成札记乙', content: '# 场景\n\n这是虚构的课堂观察。\n\n## 做法\n\n学习者合上书，从记忆中回答问题；两天后、七天后再次练习。把复习分散在多个日期，远比同一晚连续通读更容易在数周后回想概念。错误答案用于下一次自测，而不是只盯着页面看。'},
      {id: 'synthetic-glaze', projectId: MAIN, title: 'Glaze experiment', content: 'A fictional workshop compared copper pigments across three kiln temperatures. Glossy surfaces formed after slow cooling; matte finishes appeared after rapid cooling.'},
      {id: 'synthetic-garden', projectId: MAIN, title: '花园观察', content: '这是虚构的屋顶种植记录。木箱采用椰糠与珍珠岩混合基质，苗床铺遮阳网，收获后称量番茄质量。'},
      {id: 'synthetic-foreign-ferry', projectId: OTHER, title: 'Record Indigo', content: ferry}
    ]
  };
}
const cases = [
  {id: 'english-paraphrase', query: 'Why can unpredictable delays feel worse despite identical measured duration?', expected: 'synthetic-ferry'},
  {id: 'chinese-paraphrase', query: '怎样减少背诵遗忘，而非当天反复浏览课本？', expected: 'synthetic-learning'}
];
const modules = ['vector-index.js', 'context-retrieval.js', 'knowledge-access.js', 'citation-evidence.js'];
function failure(code, status) { return Object.assign(new Error(code), {qaCode: code, ...(Number.isInteger(status) ? {status} : {})}); }

async function runSyntheticSemanticAcceptance(options = {}) {
  const state = fixture(), before = JSON.stringify(state), scope = {projectId: MAIN, allowedTaskIds: []};
  const rows = new Map(), calls = [], checks = [];
  const report = {
    version: 1, fixture: 'bilingual-semantic-v1', mode: options.allowNetwork === true ? 'provider-module' : 'dry-run',
    startedAt: new Date().toISOString(), passed: false, networkRequests: 0,
    boundary: 'Production retrieval modules with synthetic records and in-memory vectors; not native GUI, credential-store, full Harness, PDF, or actual answer-attribution acceptance.',
    production: modules.map(file => ({path: 'app/' + file, sha256: hash(fs.readFileSync(path.join(__dirname, '../../app', file)))})),
    corpus: {records: state.notes.length, projects: 2, characters: state.notes.reduce((n, x) => n + x.content.length, 0), sha256: hash(before)},
    queries: [], checks, calls
  };
  const record = (name, passed) => { checks.push({name, passed: !!passed}); return !!passed; };
  let stage = 'preflight', signal = options.signal;
  try {
    for (const item of cases) {
      const lexical = R.searchIndex(state, {...scope, query: item.query, all: true});
      const target = state.notes.find(note => note.id === item.expected);
      const targetTerms = new Set(R.tokens(target.title + '\n' + target.content, {all: true}));
      const overlap = R.tokens(item.query, {all: true}).filter(token => targetTerms.has(token));
      report.queries.push({id: item.id, text: item.query, expected: item.expected, lexicalHits: lexical.entries.length, targetTokenOverlap: overlap});
      record(item.id + ': no lexical hit or target core-token overlap', lexical.entries.length === 0 && overlap.length === 0);
    }
    if (checks.some(x => !x.passed)) throw failure('FIXTURE_LEXICAL_PREFLIGHT_FAILED');
    report.corpus.chunks = (await V.snapshot(state)).length;
    if (options.allowNetwork !== true) { report.passed = null; report.preflightPassed = true; report.networkDisabled = true; return report; }
    if (typeof options.key !== 'string' || !options.key.trim()) throw failure('KEY_REQUIRED');
    if (typeof options.endpoint !== 'string' || typeof options.model !== 'string' || !options.model.trim()) throw failure('CONFIGURATION_REQUIRED');
    let config;
    try { config = V.configuration({base: options.endpoint, model: options.model, dimensions: options.dimensions, enabled: true, autoUpdate: false}); }
    catch (_) { throw failure('CONFIGURATION_INVALID'); }
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') throw failure('FETCH_UNAVAILABLE');
    const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 30000;
    const embed = async (cfg, texts, upstreamSignal) => {
      if (signal?.aborted || upstreamSignal?.aborted) throw failure('CANCELLED');
      const controller = new AbortController(), start = Date.now();
      const cancel = () => controller.abort();
      signal?.addEventListener('abort', cancel, {once: true});
      upstreamSignal?.addEventListener('abort', cancel, {once: true});
      const timer = setTimeout(cancel, timeoutMs);
      const call = {kind: stage === 'index' ? 'index' : 'query', inputCount: texts.length, inputCharacters: texts.reduce((n, x) => n + x.length, 0)};
      calls.push(call); report.networkRequests++;
      try {
        // One explicit request, no retries and no redirect forwarding of credentials.
        const response = await fetchImpl(cfg.base, {method: 'POST', redirect: 'error', signal: controller.signal,
          headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + options.key.trim()},
          body: JSON.stringify({model: cfg.model, input: texts, encoding_format: 'float', ...(cfg.dimensions ? {dimensions: cfg.dimensions} : {})})});
        call.httpStatus = response.status;
        if (!response.ok) throw failure('PROVIDER_HTTP_ERROR', response.status);
        let payload;
        try { payload = await response.json(); } catch (_) { throw failure('PROVIDER_JSON_INVALID'); }
        const data = payload?.data;
        if (!Array.isArray(data) || data.length !== texts.length || data.some((item, i) => !item || !Number.isSafeInteger(item.index) || item.index < 0 || item.index >= texts.length) || new Set(data.map(item => item.index)).size !== texts.length) throw failure('PROVIDER_RESULT_SHAPE_INVALID');
        const vectors = [...data].sort((a, b) => a.index - b.index).map(item => item.embedding);
        call.dimensions = V.validate(vectors, texts.length, cfg.dimensions);
        if (controller.signal.aborted) throw failure('CANCELLED_OR_TIMEOUT');
        return vectors;
      } catch (error) {
        if (error.qaCode) throw error;
        throw failure(controller.signal.aborted ? 'CANCELLED_OR_TIMEOUT' : 'PROVIDER_REQUEST_FAILED');
      } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', cancel); upstreamSignal?.removeEventListener('abort', cancel);
        call.elapsedMs = Date.now() - start;
      }
    };
    const store = {
      async load(profile) { return [...rows.values()].filter(row => row.profile === profile); },
      async write(profile, puts = [], removes = []) {
        for (const id of removes) rows.delete(profile + ':' + id);
        for (const value of puts) rows.set(profile + ':' + value.id, {...value, profile});
      }
    };
    const engine = V.create({getState: () => state, store, embed, queryTimeoutMs: timeoutMs + 1000});
    stage = 'index'; report.index = await engine.update(config, {signal});
    record('all synthetic chunks indexed', report.index.ready === report.index.total && report.index.pending === 0 && report.index.total > 0);
    const citations = new Map();
    for (const item of cases) {
      stage = item.id;
      const result = await engine.search(config, item.query, scope, 0, {signal});
      const top = result.entries[0], query = report.queries.find(q => q.id === item.id);
      query.coverage = {strategy: result.coverage.strategy, semanticStatus: result.coverage.semanticStatus, vectorReady: result.coverage.vectorReady, vectorTotal: result.coverage.vectorTotal};
      query.rankedRecordIDs = [...new Set(result.entries.map(entry => entry.recordId))];
      record(item.id + ': real vector strategy and top target', result.coverage.strategy === 'hybrid-rrf' && result.coverage.semanticStatus === 'ready' && top?.recordId === item.expected);
      record(item.id + ': other project excluded', result.entries.every(entry => entry.projectId === MAIN && entry.recordId !== 'synthetic-foreign-ferry'));
      if (!top || top.recordId !== item.expected) continue;
      const original = state.notes.find(note => note.id === top.recordId);
      const read = await K.execute(state, scope, {type: 'read', recordType: top.type, id: top.recordId, offset: top.offset});
      const exact = original.content.slice(top.offset, top.end), excerpt = read.text.slice(0, top.end - top.offset);
      record(item.id + ': nonzero source offset and exact body readback', top.offset > 0 && top.end > top.offset && top.text === exact && excerpt === exact);
      const run = {id: 'synthetic-acceptance-' + item.id};
      const citation = E.capture(run, {type: top.type, id: top.recordId, title: top.title, offset: top.offset, end: top.end, excerpt, version: top.version, origin: 'synthetic_qa_read'}, state);
      const current = citation && E.status(citation, state);
      const marker = citation && E.markers('Synthetic claim [[cite:' + citation.sourceId + ']]', run.evidenceSources)[0];
      record(item.id + ': citation maps back to retained source', !!citation && current.kind === 'snapshot' && current.canOpen && marker?.source === citation && citation.excerpt === exact);
      citations.set(item.expected, citation);
      query.source = {recordId: top.recordId, offset: top.offset, end: top.end, characters: excerpt.length, sha256: hash(excerpt), citationStatus: current?.kind};
    }
    stage = 'scope';
    const broad = await engine.search(config, cases[0].query, {}, 0, {signal});
    record('excluded duplicate actually exists in global vector results', broad.entries.some(entry => entry.recordId === 'synthetic-foreign-ferry'));
    let rejected = false;
    try { await K.execute(state, scope, {type: 'read', recordType: 'note', id: 'synthetic-foreign-ferry'}); } catch (_) { rejected = true; }
    record('direct read cannot bypass project scope', rejected);
    const target = state.notes.find(note => note.id === cases[0].expected);
    target.private = true;
    try {
      const afterPrivate = await engine.search(config, cases[0].query, scope, 0, {signal});
      record('cached vectors do not bypass newly private record', !afterPrivate.entries.some(entry => entry.recordId === target.id || entry.recordId === 'synthetic-foreign-ferry'));
      const citation = citations.get(target.id);
      record('saved citation becomes private and cannot open', !!citation && E.status(citation, state).kind === 'private' && E.status(citation, state).canOpen === false);
    } finally { delete target.private; }
    record('synthetic source data unchanged after verification', JSON.stringify(state) === before);
    report.passed = checks.every(x => x.passed);
    return report;
  } catch (error) {
    // Never return raw provider errors: they may contain a URL, request, or key.
    report.error = {stage, code: error.qaCode || (error.code === 'CANCELLED' || error.code === 'EMBEDDING_QUERY_TIMEOUT' ? error.code : 'MODULE_VALIDATION_FAILED'), ...(Number.isInteger(error.status) ? {httpStatus: error.status} : {})};
    return report;
  } finally {
    rows.clear(); report.finishedAt = new Date().toISOString();
  }
}

module.exports = {runSyntheticSemanticAcceptance};
