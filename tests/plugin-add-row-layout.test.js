'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('the plugin form row is a grid so a label cannot squeeze its input', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'app', 'settings-workspace.css'), 'utf8');
  assert.match(css, /\.plugin-add-row\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(6rem, 10rem\) minmax\(0, 1fr\)/);
  assert.match(css, /\.plugin-add-row input\s*\{[^}]*width:\s*100%/);
});
