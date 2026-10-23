const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

// WebKit (the native app's WKWebView) does not focus a clicked <button>. The
// overflow menu closes on blur, so without keeping focus on mousedown the menu
// collapsed under the pointer and 重新生成 / 存为文档 / 分支 never received a click.
test('message overflow menu keeps focus on mousedown so WebKit clicks reach the item', () => {
  const jsx = read('app/ui/message-actions.jsx');
  assert.match(jsx, /<span className="message-action-options" onMouseDown=\{event => event\.preventDefault\(\)\} onClick=/);
  const bundle = read('app/halaska-ui.js');
  assert.equal(bundle.split('{className:"message-action-options",onMouseDown:i=>i.preventDefault(),onClick:').length, 2);
  // The blur-to-close behaviour for real focus moves stays in place.
  assert.match(bundle, /message-actions-overflow",onKeyDown:[A-Za-z]+,onBlur:i=>\{i\.currentTarget\.contains\(i\.relatedTarget\)\|\|\(i\.currentTarget\.open=!1\)\}/);
});

test('patched Halaska bundle provenance matches the shipped file', () => {
  const report = JSON.parse(read('app/ui/halaska-provenance.json'));
  const asset = report.assets.find(item => item.name === 'halaska-ui.js');
  const content = fs.readFileSync(path.join(__dirname, '../app/halaska-ui.js'));
  assert.equal(asset.bytes, content.length);
  assert.equal(asset.sha256, crypto.createHash('sha256').update(content).digest('hex'));
});

// In the native app 在此分支继续 on the last message only shows a toast and
// does not re-render, so the delegated handler itself must close the menu.
test('the delegated conversation action handler closes the overflow menu it came from', () => {
  const app = read('app/app.js');
  const start = app.indexOf("const forkPath = event.target?.closest?.('[data-fork-message]');");
  assert.ok(start > 0);
  const body = app.slice(start, app.indexOf('if (quoteMessage) {', start));
  assert.match(body, /event\.preventDefault\(\); event\.stopPropagation\(\);\n[\s\S]*const overflowMenu = event\.target\.closest\('details\.message-actions-overflow'\);\n  if \(overflowMenu\) overflowMenu\.open = false;/);
});
