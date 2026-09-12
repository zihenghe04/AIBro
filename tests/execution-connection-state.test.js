const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const start = source.indexOf('function renderExecutionConnectionState()');
const code = source.slice(start, source.indexOf('\nfunction renderAll()', start));

test('approval completion clears the stale header without hiding other pending work', () => {
  const node = { textContent: '', classList: { contains: () => false } };
  const run = { status: 'awaiting-approval' };
  const context = vm.createContext({ $: () => node, serverConflict: false, state: { agentRuns: [run] }, visibleRun: r => !r.archived });
  vm.runInContext(code, context);
  context.renderExecutionConnectionState(); assert.match(node.textContent, /等待审批/);
  run.status = 'completed'; context.renderExecutionConnectionState(); assert.match(node.textContent, /本地已就绪/);
  context.state.agentRuns.push({ status: 'awaiting-approval', routingReview: { required: true } });
  context.renderExecutionConnectionState(); assert.match(node.textContent, /等待确认归属/);
  run.status = 'running'; context.renderExecutionConnectionState(); assert.match(node.textContent, /执行中/);
  node.textContent = '● 待处理同步冲突'; context.serverConflict = true;
  context.renderExecutionConnectionState(); assert.equal(node.textContent, '● 待处理同步冲突');
  context.serverConflict = false; node.textContent = '● 离线本地模式'; node.classList.contains = () => true;
  context.renderExecutionConnectionState(); assert.equal(node.textContent, '● 离线本地模式');
});
