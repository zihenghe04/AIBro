const test = require('node:test');
const assert = require('node:assert/strict');
const Rules = require('../app/kernel-rules.js');
require('../app/kernel-host.js'); // no host token: loads without starting
const Host = globalThis.AIBroKernelHost;

test('scheduled runs get the unattended rules, others do not', () => {
  const scheduled = Rules.text(['headless', 'scheduled', 'mark-done']), plain = Rules.text('headless'), app = Rules.text('app');
  for (const id of ['scheduled-no-questions', 'scheduled-no-self-scheduling', 'scheduled-scope', 'scheduled-mark-done'])
    assert.ok(Rules.forHost(['headless', 'scheduled', 'mark-done']).some(rule => rule.id === id), id);
  assert.match(scheduled, /不要向用户提问/); assert.match(scheduled, /mark_task_done/); assert.match(scheduled, /无人值守的后台运行/);
  assert.doesNotMatch(plain, /mark_task_done|计划任务/); assert.doesNotMatch(app, /计划任务/);
  // The main window's automations: unattended rules without mark_task_done (that path has no such tool).
  const window = Rules.text(['app', 'scheduled']);
  assert.match(window, /不要设定、调度/); assert.doesNotMatch(window, /mark_task_done/);
});

test('declared scope only tightens: read asks for writes, undeclared external tools ask, computer use has its own switch', () => {
  const write = { name: 'create_task', effect: 'local', plugin: 'kernel' }, read = { name: 'project_list', effect: 'none', plugin: 'core' };
  const external = { name: 'ext.write', effect: 'external', plugin: 'mcp-x', mcp: { plugin: 'mcp-x' } }, computer = { name: 'computer_click', effect: 'external', plugin: 'computer' };
  const readOnly = Host.scopeLayer({ access: 'read', tools: [], computerUse: false });
  assert.equal(readOnly(read), 'allow'); assert.equal(readOnly(write), 'ask'); assert.equal(readOnly(external), 'ask'); assert.equal(readOnly(computer), 'deny');
  const writer = Host.scopeLayer({ access: 'write', tools: ['ext.write'], computerUse: true });
  assert.equal(writer(write), 'allow'); assert.equal(writer(external), 'allow'); assert.equal(writer(computer), 'ask');
  assert.equal(Host.scopeLayer({ access: 'write', tools: [] })(external), 'ask');
  assert.equal(Host.scopeLayer(null)(write), 'ask');
  for (const name of ['ask_user', 'clarify', 'schedule_task', 'cron_create', 'remind_me']) assert.equal(writer({ name, effect: 'none', plugin: 'x' }), 'deny', name);
  assert.equal(writer({ name: 'mark_task_done', effect: 'none', plugin: 'kernel' }), 'allow');
});

test('mark_task_done is registered for scheduled runs only and changes nothing', () => {
  assert.equal(Host.MARK_DONE.effect, 'none'); assert.equal(Host.MARK_DONE.approval, 'never');
  assert.ok(Host.HOST_SLOTS > 1);
});
