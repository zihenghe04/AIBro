const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const read = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const app = read('app/app.js');
const body = (src, name) => { const i = src.indexOf('function ' + name); assert.ok(i >= 0, name + ' exists'); const j = src.indexOf('\nfunction ', i + 10); return src.slice(i, j < 0 ? undefined : j); };

test('every route into the settings view (showView) activates the new shell', () => {
  const sv = body(app, 'showView');
  assert.match(sv, /viewId\s*===\s*'settings'[^\n]*SettingsShell\??\.(show|open)\(/, 'showView must show the shell for the settings route');
});
test('top bar title for the settings route is plain', () => {
  const sw = read('native/Sources/AIBro/AIBro.swift');
  assert.doesNotMatch(sw, /模型与知识库设置/);
});
test('nothing asks for a second settings page', () => {
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'app')).filter(n => /\.(js|html|jsx)$/.test(n))) {
    const s = read('app/' + f);
    assert.doesNotMatch(s, /SettingsWorkspace\.(reveal|restore|init)|试用新版设置|旧版设置/, f + ' still references the old settings page');
  }
});
