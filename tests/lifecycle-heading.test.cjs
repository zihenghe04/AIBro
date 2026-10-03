const test = require('node:test');
const assert = require('node:assert/strict');
const policy = import('../app/ui/lifecycle-heading.mjs');
const heading = (phase, detail = phase) => ({ phase, label: phase, detail });
async function fixture(initial = heading('thinking')) {
  const { createLifecycleHeading } = await policy;
  let time = 0, serial = 0, displayed = initial;
  const jobs = new Map(), cancelled = [], changes = [];
  const controller = createLifecycleHeading({ initial, identity: 'run-one', now: () => time,
    onChange: value => { displayed = value; changes.push({ at: time, value }); },
    schedule: (callback, delay) => { const id = ++serial; jobs.set(id, { callback, at: time + delay }); return id; },
    cancel: id => { if (jobs.has(id)) cancelled.push(jobs.get(id).callback); jobs.delete(id); }
  });
  return { controller, jobs, changes, cancelled, get displayed() { return displayed; },
    set: (next, options = {}) => controller.update(next, { active: true, identity: 'run-one', ...options }),
    tick(next) { time = next; for (const [id, job] of [...jobs]) if (job.at <= time) { jobs.delete(id); job.callback(); } }
  };
}
test('rapid running headings share one fixed deadline instead of endlessly debouncing or replaying each phase', async () => {
  const f = await fixture();
  f.tick(30); f.set(heading('tool', 'Read synthetic material'));
  f.tick(80); f.set(heading('writing', 'First complete sentence'));
  f.tick(140); f.set(heading('tool', 'Read the second synthetic material'));
  assert.equal(f.jobs.size, 1); assert.equal(f.displayed.phase, 'thinking');
  assert.equal([...f.jobs.values()][0].at, 150);
  f.tick(150); assert.deepEqual(f.displayed, heading('tool', 'Read the second synthetic material'));
  assert.equal(f.changes.length, 1); assert.equal(f.jobs.size, 0);
});
test('terminal, approval, cancelled and save-failure headings immediately supersede a queued running title', async () => {
  for (const status of ['completed', 'failed', 'cancelled', 'interrupted', 'awaiting-approval', 'awaiting-save', 'rejected']) {
    const f = await fixture(); f.tick(20); f.set(heading('tool')); f.tick(35);
    f.set(heading(status), { active: false });
    assert.equal(f.displayed.phase, status); assert.equal(f.jobs.size, 0);
    for (const callback of f.cancelled) callback();
    f.tick(500); assert.equal(f.displayed.phase, status, 'A stale timer cannot revive a live title');
  }
});
test('returning to the displayed phase cancels the queued detour', async () => {
  const f = await fixture(); f.tick(10); f.set(heading('tool')); f.tick(60); f.set(heading('thinking'));
  assert.equal(f.jobs.size, 0); f.tick(300); assert.equal(f.changes.length, 0);
});
test('reduced motion, hidden surfaces and a replaced run bypass the delay', async () => {
  for (const options of [{ immediate: true }, { identity: 'run-two' }]) {
    const f = await fixture(); f.tick(10); f.set(heading('tool')); f.tick(20); f.set(heading('writing'), options);
    assert.equal(f.displayed.phase, 'writing'); assert.equal(f.jobs.size, 0);
  }
  const f = await fixture(); f.tick(10); f.set(heading('tool')); f.controller.flush();
  assert.equal(f.displayed.phase, 'tool'); assert.equal(f.jobs.size, 0, 'Visibility pause catches up without leaving a timer');
});
test('a settled phase transition commits immediately after its minimum dwell', async () => {
  const f = await fixture(); f.tick(151); f.set(heading('tool'));
  assert.equal(f.displayed.phase, 'tool'); assert.equal(f.jobs.size, 0);
  f.tick(160); f.set(heading('writing')); assert.equal([...f.jobs.values()][0].at, 301);
});
test('unmount disposes pending work and does not retain or deliver stale callbacks', async () => {
  const f = await fixture(); f.tick(10); f.set(heading('tool')); f.controller.destroy();
  f.set(heading('writing')); f.controller.flush(); f.tick(500); for (const callback of f.cancelled) callback();
  assert.equal(f.jobs.size, 0); assert.equal(f.changes.length, 0);
});
test('caller-owned title changes cannot mutate queued content and full public text is preserved', async () => {
  const f = await fixture(), detail = '公开进展🙂 '.repeat(2500), input = heading('writing', detail);
  f.tick(20); f.set(input); input.detail = 'changed by caller'; f.tick(150);
  assert.equal(f.displayed.detail, detail); assert.equal(f.displayed.detail.length, detail.length);
});
