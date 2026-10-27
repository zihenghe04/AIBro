const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../app/run-failure-diagnostics.js');

test('ChatGPT channel failures map to specific diagnostics instead of the generic one', () => {
  const code = failure => D.fromStream(failure).code;
  assert.equal(code({ code: 'chatgpt_modelNotSupported' }), 'MODEL_NOT_AVAILABLE');
  assert.equal(code({ code: 'chatgpt_quota' }), 'QUOTA_EXHAUSTED');
  assert.equal(code({ code: 'chatgpt_auth' }), 'HTTP_UNAUTHORIZED');
  assert.equal(code({ code: 'needs_reauth' }), 'HTTP_UNAUTHORIZED');
  assert.equal(code({ code: 'chatgpt_stream_error' }), 'UPSTREAM_STREAM_INTERRUPTED');
  assert.equal(D.fromHttp(400, { code: 'model_not_found' }).code, 'MODEL_NOT_AVAILABLE');
  assert.equal(D.fromStream({ code: 'something-else' }).code, 'MODEL_STREAM_ERROR');
});
