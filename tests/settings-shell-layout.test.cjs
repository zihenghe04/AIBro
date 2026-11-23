const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const css = fs.readFileSync(__dirname + '/../app/settings-shell.css', 'utf8');

test('settings shell is not centered by the generic .view > * rule', () => {
  assert.match(css, /#settings > \.st-shell \{[^}]*max-width: none;[^}]*margin-left: 0;/);
});
test('settings page column has a bounded reading width', () => {
  assert.match(css, /\.st-page \{ max-width: (8\d\d|7\d\d)px;/);
});
