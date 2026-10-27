'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appDir = path.join(__dirname, '..', 'app');
const manifest = JSON.parse(fs.readFileSync(path.join(appDir, 'asset-manifest.json'), 'utf8'));
const shipped = new Set([...manifest.runtime, ...(manifest.optionalRuntime || [])]);
const localModules = new Set(fs.readdirSync(appDir).filter((name) => name.endsWith('.py')).map((name) => name.slice(0, -3)));

function importedLocalModules(file) {
  const source = fs.readFileSync(path.join(appDir, file), 'utf8');
  const found = new Set();
  // Top-level and function-local imports alike: a lazy import still breaks a packaged build.
  for (const match of source.matchAll(/^[ \t]*import\s+([\w., \t]+)/gm)) {
    for (const part of match[1].split(',')) found.add(part.trim().split(/\s+as\s+/)[0].split('.')[0]);
  }
  for (const match of source.matchAll(/^[ \t]*from\s+([\w.]+)\s+import\b/gm)) found.add(match[1].split('.')[0]);
  return [...found].filter((name) => localModules.has(name));
}

test('every Python module reachable from server.py is listed in asset-manifest.json', () => {
  const seen = new Set();
  const queue = ['server'];
  while (queue.length) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    queue.push(...importedLocalModules(`${name}.py`));
  }
  const missing = [...seen].map((name) => `${name}.py`).filter((file) => !shipped.has(file));
  assert.deepEqual(missing, [], `missing from asset-manifest.json runtime: ${missing.join(', ')}`);
});

test('every app/*.py module imported by a shipped Python module is listed in the manifest', () => {
  const missing = [];
  for (const file of shipped) {
    if (!file.endsWith('.py')) continue;
    for (const name of importedLocalModules(file)) {
      if (!shipped.has(`${name}.py`)) missing.push(`${file} -> ${name}.py`);
    }
  }
  assert.deepEqual(missing, []);
});
