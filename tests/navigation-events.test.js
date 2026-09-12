const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');

test('view navigation binds buttons without making the body a bubbling click handler', () => {
  const statement = source.split('\n').find(line => line.startsWith("$$('") && line.includes('[data-view]') && line.includes('.onclick'));
  assert.ok(statement, 'the view navigation binding must be inspectable');
  const body = { tagName: 'BODY', dataset: { view: 'agent' }, onclick: null };
  const button = { tagName: 'BUTTON', dataset: { view: 'research' }, onclick: null, textContent: '科研' };
  const views = [];
  vm.runInNewContext(statement, {
    $$: selector => [body, button].filter(node => selector === '[data-view]' || (selector === 'button[data-view]' && node.tagName === 'BUTTON')),
    showView: view => views.push(view),
    viewLabels: { research: '科研' }
  });
  assert.equal(body.onclick, null, 'body data-view is UI state; a handler here rebuilds checkboxes before change fires');
  assert.equal(typeof button.onclick, 'function');
  button.onclick();
  assert.deepEqual(views, ['research']);
});
