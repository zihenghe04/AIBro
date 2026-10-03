const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

// These guards share the real path-save function identity and busy state.
// Loading the actual host keeps unrelated workflow fixtures independent of
// brittle source slices without replacing the safety gate with a stub.
module.exports = function installConversationPathHost(context) {
  const source = fs.readFileSync(require.resolve('../../app/app.js'), 'utf8');
  const from = source.indexOf('function conversationPathSaving(');
  const to = source.indexOf('\nasync function forkConversationBranch(', from);
  assert.ok(from >= 0 && to > from, 'Conversation path host boundary');
  vm.runInContext(source.slice(from, to), context);
};
