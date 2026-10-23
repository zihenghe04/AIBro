const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

// Background runs: an ordinary step's notification keeps 批准 / 拒绝; a destructive
// step's only offers 查看 / 拒绝 (the service refuses a native approval of it too,
// see kernel-runs.test.py).
test('destructive background steps notify with view / reject only', () => {
  const store = read('native/Sources/AIBro/AgendaStore.swift'), host = read('native/Sources/AIBro/NativeKernelHost.swift');
  const category = id => store.match(new RegExp(`UNNotificationCategory\\(identifier:"${id}",actions:\\[(.*?)\\],intentIdentifiers`))?.[1] || '';
  const actions = id => [...category(id).matchAll(/identifier:"(\w+)"/g)].map(m => m[1]);
  assert.deepEqual(actions('AIBRO_KERNEL_APPROVAL'), ['KERNEL_APPROVE', 'KERNEL_REJECT']);
  assert.deepEqual(actions('AIBRO_KERNEL_REVIEW'), ['KERNEL_VIEW', 'KERNEL_REJECT']);
  assert.match(host, /static let reviewCategory = "AIBRO_KERNEL_REVIEW"/);
  assert.match(host, /content\.categoryIdentifier = destructive \? Self\.reviewCategory : Self\.category/);
  // Anything other than approve/reject (查看, a plain click) opens the run instead of answering.
  assert.match(host, /let decision = action == "KERNEL_APPROVE" \? "allowed-once" : action == "KERNEL_REJECT" \? "rejected" : nil\n\s*guard let decision else \{ onShow\?\(runId\); return \}/);
  // The flag reaches the shell from both the page and the service poll.
  assert.match(read('app/kernel-host.js'), /notifyNative\(\{type:'attention',[^}]*destructive:destructive===true\}\)/);
  assert.match(read('app/kernel_runs.py'), /'destructive': a\.get\('destructive'\) is True\}/);
});
