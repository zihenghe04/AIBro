'use strict';
// 导航用短名：侧栏、页面标题（面包屑）和英文本地化一致，“总览”“对话”不再另有长名。
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const app = read('app/app.js'), html = read('app/index.html'), en = read('app/i18n-en.js');
const labels = Function(`return ${app.match(/const viewLabels = (\{[^\n]*\});/)[1]}`)();

test('page titles use the same short names as the sidebar', () => {
  for (const view of ['agent', 'dashboard']) {
    const nav = html.match(new RegExp(`class="nav-item[^"]*" data-view="${view}">.*?<span data-i18n>([^<]+)</span>`))[1];
    assert.equal(labels[view], nav, `${view} title matches the sidebar`);
  }
  assert.equal(labels.agent, '对话'); assert.equal(labels.dashboard, '总览');
  assert.match(html, /id="currentContext"><span data-i18n>对话<\/span>/, 'initial breadcrumb uses the short name');
});

test('the long names are gone from the app and its English table', () => {
  for (const [name, text] of [['app.js', app], ['index.html', html], ['i18n-en.js', en]]) {
    assert.doesNotMatch(text, /全局驾驶舱/, name);
    assert.doesNotMatch(text, /["'>]持续对话["'<]/, name);
  }
  assert.match(en, /"对话": "Chats"/); assert.match(en, /"总览": "Overview"/);
});
