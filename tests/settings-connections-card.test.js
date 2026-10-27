'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Integration guard: #connectionsCard (P9a) must be moved into the models section by
// settings-workspace.js, otherwise it is left over and shows up under whichever tab is open (it did, under Plugins).
test('settings-workspace groups the connections card into the models section', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'settings-workspace.js'), 'utf8');
  assert.match(source, /move\(page\.querySelector\('#connectionsCard'\), 'models'\)/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  assert.match(html, /id="connectionsCard"/);
});
