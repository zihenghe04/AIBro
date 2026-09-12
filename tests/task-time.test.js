const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const start = source.indexOf('function taskDueFields(');
const end = source.indexOf('const orderTasks', start);
assert.ok(start >= 0 && end > start, 'actual deadline helpers are present');
const helpers = source.slice(start, end);

function inTimezone(zone) {
  const script = `const vm=require('node:vm');const f=vm.runInNewContext(${JSON.stringify(helpers + '\n({taskDueFields,taskDueValue,formatDate})')});const original='2026-10-03T08:30:22.987+08:00';const fields=f.taskDueFields(original);process.stdout.write(JSON.stringify({fields,unchanged:f.taskDueValue(fields.date,fields.time,original),added:f.taskDueValue('2026-10-03','10:45','2026-10-03'),removed:f.taskDueValue(fields.date,'',original),dateOnly:f.taskDueValue('2026-10-03','','2026-10-03'),dateFields:f.taskDueFields('2026-10-03'),cleared:f.taskDueValue('','',original),display:f.formatDate(original),dateDisplay:f.formatDate('2026-10-03')}));`;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: zone }, encoding: 'utf8' }));
}

for (const [zone, expected] of [
  ['Asia/Shanghai', { date: '2026-10-03', time: '08:30', added: '2026-10-03T02:45:00.000Z' }],
  ['America/New_York', { date: '2026-10-02', time: '20:30', added: '2026-10-03T14:45:00.000Z' }],
  ['UTC', { date: '2026-10-03', time: '00:30', added: '2026-10-03T10:45:00.000Z' }]
]) {
  test(`deadline preservation, editing and all-day semantics in ${zone}`, () => {
    const result = inTimezone(zone);
    assert.deepEqual(result.fields, { date: expected.date, time: expected.time });
    assert.equal(result.unchanged, '2026-10-03T08:30:22.987+08:00', 'changing other task fields preserves offset, seconds and milliseconds');
    assert.equal(result.added, expected.added, 'new local wall-clock time maps to the expected UTC instant');
    assert.equal(result.removed, expected.date, 'clearing time explicitly converts to the displayed calendar date');
    assert.equal(result.dateOnly, '2026-10-03');
    assert.deepEqual(result.dateFields, { date: '2026-10-03', time: '' });
    assert.equal(result.cleared, null);
    assert.ok(result.display.includes(expected.time), result.display);
    assert.match(result.display, /GMT|UTC|EDT/);
    assert.match(result.dateDisplay, /2026\/10\/3/);
    assert.doesNotMatch(result.dateDisplay, /:/, 'all-day deadlines must not acquire a time');
  });
}

test('description/status saves wire both date and time through the preservation helper', () => {
  const save = source.match(/function saveTaskDetails\(\) \{[^\n]+/)[0];
  assert.match(save, /taskDueValue\(\$\('#taskDueInput'\)\.value, \$\('#taskTimeInput'\)\.value, task\.dueAt\)/);
  const render = source.slice(source.indexOf('function renderTaskDialog('), source.indexOf('function openTask('));
  assert.match(render, /taskTimeInput[^<]+type="time"/);
  assert.match(render, /taskDueFields\(task\.dueAt\)\.time/);
});

test('blank and invalid legacy deadlines can be displayed without throwing', () => {
  const f = vm.runInNewContext(helpers + '\n({taskDueFields,taskDueValue})');
  assert.equal(f.taskDueFields(null).date, '');
  assert.equal(f.taskDueFields('corrupt-old-value').time, '');
  assert.equal(f.taskDueValue('', '', null), null);
});
