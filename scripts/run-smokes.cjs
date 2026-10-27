#!/usr/bin/env node
// Sequential Electron smoke runner: one test at a time, per-test timeout, summary at the end.
// usage: node scripts/run-smokes.cjs core|all [--timeout=240]
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
// Core flows: chat run/progress, conversation window, settings (models/providers/profiles), composer, schedule, plugins, tours, import, reading.
const CORE = [
  'agent-progress', 'conversation-window', 'settings-workspace', 'model-settings', 'api-profiles',
  'composer-kit', 'scheduler', 'project-tasks-schedule', 'mcp-plugins', 'workspace-tour', 'import-workspace', 'reading-pane',
].map(name => `tests/${name}-smoke.cjs`);
const mode = process.argv[2] || 'core';
const timeout = Number((process.argv.find(a => a.startsWith('--timeout=')) || '').slice(10)) || 240;
if (!['core', 'all'].includes(mode)) { console.error('usage: run-smokes.cjs core|all'); process.exit(2); }
const files = mode === 'core' ? CORE : fs.readdirSync(path.join(ROOT, 'tests')).filter(f => /-smoke\.cjs$/.test(f)).sort().map(f => 'tests/' + f);
// Glass smokes need the native addon; build it when missing.
if (files.some(f => /glass/.test(f)) && !fs.existsSync(path.join(ROOT, 'app/native-glass.node'))) spawnSync('node', ['app/build-native-glass.js'], { cwd: ROOT, stdio: 'inherit' });
const electron = path.join(ROOT, 'node_modules/.bin/electron');
const results = [];
(async () => {
  for (const file of files) {
    const started = Date.now();
    const status = await new Promise(resolve => {
      const child = spawn(electron, [file], { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, AGENT_PROGRESS_SMOKE_PORT: process.env.AGENT_PROGRESS_SMOKE_PORT || '19911', READING_PANE_SMOKE_PORT: process.env.READING_PANE_SMOKE_PORT || '19912' } });
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('TIMEOUT'); }, timeout * 1000);
      child.on('exit', code => { clearTimeout(timer); resolve(code === 0 ? 'PASS' : 'FAIL'); });
    });
    results.push({ file, status });
    console.log(`${status.padEnd(7)} ${file} (${Math.round((Date.now() - started) / 1000)}s)`);
  }
  const bad = results.filter(r => r.status !== 'PASS');
  console.log(`\n${mode}: ${results.length - bad.length}/${results.length} passed`);
  if (bad.length) console.log('Failed: ' + bad.map(r => r.file).join(', '));
  process.exit(bad.length ? 1 : 0);
})();
