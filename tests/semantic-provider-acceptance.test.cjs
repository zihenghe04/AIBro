'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const {runSyntheticSemanticAcceptance} = require('../scripts/qa/semantic-provider-acceptance.cjs');
const endpoint = 'https://synthetic-provider.invalid/v1', key = 'SYNTHETIC_KEY_NOT_A_CREDENTIAL';
const base = {allowNetwork: true, endpoint, key, model: 'synthetic-vector-model'};

test('default dry-run has zero network, zero lexical hits, no core-token overlap, and no semantic success claim', async () => {
  const result = await runSyntheticSemanticAcceptance({endpoint, key, fetchImpl: () => { throw Error('must not fetch'); }});
  assert.equal(result.mode, 'dry-run'); assert.equal(result.passed, null); assert.equal(result.preflightPassed, true);
  assert.equal(result.networkRequests, 0); assert.equal(result.corpus.records, 5);
  assert.deepEqual(result.queries.map(x => [x.lexicalHits, x.targetTokenOverlap.length]), [[0,0],[0,0]]);
  assert.ok(result.production.every(x => /^[a-f0-9]{64}$/.test(x.sha256)));
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_KEY_NOT_A_CREDENTIAL|synthetic-provider\.invalid/);
});

test('injected provider exercises actual index, ranking, scope, exact offset readback and citation production modules', async () => {
  const bodies = [];
  const result = await runSyntheticSemanticAcceptance({...base, fetchImpl: async (url, init) => {
    assert.equal(url, endpoint + '/embeddings'); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer ' + key);
    const body = JSON.parse(init.body); bodies.push(body);
    const vector = text => /countdown|unpredictable/.test(text) ? [1,0,0,0] : /合上书|背诵/.test(text) ? [0,1,0,0] : /glaze|铜|木箱|pigments/i.test(text) ? [0,0,1,0] : [0,0,0,1];
    return {ok: true, status: 200, json: async () => ({data: body.input.map((text, index) => ({index, embedding: vector(text)})).reverse()})};
  }});
  assert.equal(result.passed, true, JSON.stringify(result)); assert.equal(result.mode, 'provider-module');
  assert.equal(result.networkRequests, 3); assert.equal(bodies.length, 3);
  assert.equal(result.index.total, 8); assert.equal(result.index.pending, 0);
  assert.ok(result.checks.every(x => x.passed));
  for (const query of result.queries) {
    assert.equal(query.coverage.strategy, 'hybrid-rrf'); assert.equal(query.coverage.semanticStatus, 'ready');
    assert.equal(query.rankedRecordIDs[0], query.expected); assert.ok(query.source.offset > 0);
    assert.equal(query.source.citationStatus, 'snapshot');
  }
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_KEY_NOT_A_CREDENTIAL|synthetic-provider\.invalid|embedding"\s*:|\[1,0,0,0\]/);
});

test('no key or no explicit network authorization cannot start a request', async () => {
  const result = await runSyntheticSemanticAcceptance({...base, key: '', fetchImpl: () => { throw Error('must not fetch'); }});
  assert.equal(result.passed, false); assert.equal(result.error.code, 'KEY_REQUIRED'); assert.equal(result.networkRequests, 0);
});

test('provider failure evidence cannot expose thrown endpoint or key, and does not retry', async () => {
  let count = 0;
  const result = await runSyntheticSemanticAcceptance({...base, fetchImpl: async () => { count++; throw Error(endpoint + ' ' + key); }});
  assert.equal(count, 1); assert.equal(result.passed, false); assert.equal(result.error.code, 'PROVIDER_REQUEST_FAILED');
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_KEY_NOT_A_CREDENTIAL|synthetic-provider\.invalid/);
});

test('duplicate response indices are rejected instead of binding vectors to wrong synthetic records', async () => {
  const result = await runSyntheticSemanticAcceptance({...base, fetchImpl: async (_, init) => ({ok: true, status: 200,
    json: async () => ({data: JSON.parse(init.body).input.map(() => ({index: 0, embedding: [1,0]}))})})});
  assert.equal(result.passed, false); assert.equal(result.error.code, 'PROVIDER_RESULT_SHAPE_INVALID'); assert.equal(result.networkRequests, 1);
});

test('already cancelled runner sends no provider request', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await runSyntheticSemanticAcceptance({...base, signal: controller.signal, fetchImpl: () => { throw Error('must not fetch'); }});
  assert.equal(result.passed, false); assert.equal(result.error.code, 'CANCELLED'); assert.equal(result.networkRequests, 0);
});
