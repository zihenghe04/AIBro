const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { transformSync } = require('esbuild');
const source = fs.readFileSync(require.resolve('../app/ui/project-schedule.jsx'), 'utf8');
const compiled = transformSync(source + '\nexport { ScheduleTask, SchedulePlan, ScheduleAction };', { loader: 'jsx', format: 'cjs' }).code;
const primitives = {
  Button: ({ children, onClick, disabled, loading, variant, ...props }) => React.createElement('button', { type: 'button', disabled: disabled || loading, onClick, 'data-kit-button': variant, 'aria-label': props['aria-label'], 'aria-expanded': props['aria-expanded'] }, React.createElement('span', null, children)),
  TextArea: ({ value, onChange, placeholder, rows, disabled }) => React.createElement('textarea', { value, onChange, readOnly: !onChange, placeholder, rows, disabled, 'data-kit-textarea': '' }),
  EmptyState: ({ title }) => React.createElement('div', { 'data-kit-empty': '' }, title),
};
function load(language = 'zh', hookStubs = false) {
  let id = 0; const module = { exports: {} }, document = { documentElement: { lang: language }, getElementById: () => null, createElement: () => ({}), head: { append() {} } };
  const react = hookStubs ? { ...React, useId: () => 'test-' + id++, useRef: value => ({ current: value }), useLayoutEffect() {} } : React;
  vm.runInNewContext(compiled, { document, module, exports: module.exports, require: id => id === 'react' ? react : id.endsWith('.css') ? '' : primitives });
  return module.exports;
}
const render = (props, language) => renderToStaticMarkup(React.createElement(load(language).ProjectScheduleSurface, props));
function nodes(element, predicate) { if (Array.isArray(element)) return element.flatMap(value => nodes(value, predicate)); if (!element || typeof element !== 'object') return []; return [...(predicate(element) ? [element] : []), ...nodes(element.props?.children, predicate)]; }
const task = (id, extra = {}) => ({ id, title: 'Task ' + id, status: 'todo', statusLabel: '待开始', time: '10:30', ...extra });
const days = () => Array.from({ length: 7 }, (_, i) => ({ ts: i + 1, label: '周' + (i + 1), month: 10, day: i + 1, tasks: i === 0 ? [task('a')] : [] }));

test('unavailable project never renders stale plan or tasks', () => {
  const html = render({ available: false, days: days(), range: 'SECRET', plan: { value: 'SECRET' }, unscheduled: [task('SECRET')] });
  assert.match(html, /项目当前不可用/); assert.doesNotMatch(html, /SECRET|<button|<textarea|schedule-day/);
});

test('week surface uses consecutive day sections with real counts and separately visible invalid/undated records', () => {
  const html = render({ available: true, range: '10 月 1 日 – 7 日', days: days(), weekCount: 1, openCount: 1, unscheduled: [task('none')], invalid: [task('bad', { invalidDate: '2026-02-31' })] });
  assert.equal((html.match(/class="schedule-day[ "]/g) || []).length, 7); assert.match(html, /本周 1 项 · 待完成 1 项/);
  assert.match(html, /aria-label="未安排"/); assert.match(html, /aria-label="待修正日期"/); assert.match(html, /2026-02-31/);
  assert.doesNotMatch(html, /schedule-grid|progressbar|%/); assert.equal((html.match(/data-schedule-task=/g) || []).length, 3);
});

test('task actions forward the exact Kit button anchor and disable when the host has no handler', () => {
  const { ScheduleTask } = load(), calls = [], button = {}, icon = {};
  const tree = ScheduleTask({ task: task('a'), onTask: (...args) => calls.push(args) });
  const action = nodes(tree, node => node.type === primitives.Button)[0]; action.props.onClick({ currentTarget: button, target: icon });
  assert.deepEqual(calls, [['a', button]]);
  assert.equal(nodes(ScheduleTask({ task: task('a') }), node => node.type === primitives.Button)[0].props.disabled, true);
});

test('week navigation sends only the chosen delta and today is disabled on the current week', () => {
  const { ProjectScheduleSurface, ScheduleAction } = load(), calls = [];
  const tree = ProjectScheduleSurface({ available: true, currentWeek: true, onWeek: delta => calls.push(delta) });
  const actions = nodes(tree, node => node.type === ScheduleAction);
  actions[0].props.onClick(); actions[1].props.onClick(); assert.deepEqual(calls, [-1, 1]); assert.equal(actions[2].props.disabled, true);
});

test('legacy plan is collapsed by default and distinguishes Markdown preview from editing and memory', () => {
  const html = render({ available: true, plan: { value: '# 用户计划\n<script>bad</script>' } });
  assert.match(html, /<details class="project-plan-panel">/); assert.match(html, /独立于项目记忆/); assert.match(html, /只读预览/);
  assert.match(html, /data-kit-textarea=""/); assert.match(html, /&lt;script&gt;bad&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>|已保存/);
});

test('saving, conflict and IME prevent submission while conflict choices stay explicitly separate from saving', () => {
  const { SchedulePlan, ScheduleAction } = load('zh', true);
  for (const extra of [{ busy: true }, { composing: true }, { conflict: true }, { dirty: false }]) {
    const tree = SchedulePlan({ plan: { value: 'Draft', dirty: true, ...extra }, onPlanSave() {} });
    assert.equal(nodes(tree, node => node.type === ScheduleAction && node.props.marker === 'data-plan-save')[0].props.disabled, true);
  }
  const calls = [], tree = SchedulePlan({ plan: { dirty: true, conflict: true, savedVersion: 'Remote' }, onPlanSave: () => calls.push('save'), onPlanResolve: value => calls.push(value) });
  const buttons = nodes(tree, node => node.type === primitives.Button); buttons.forEach(button => button.props.onClick());
  assert.deepEqual(calls, ['draft', 'saved']);
});

test('IME composition suppresses Cmd+S, then a committed input can save once', () => {
  const { SchedulePlan } = load('zh', true), calls = [];
  const tree = SchedulePlan({ plan: { dirty: true, value: 'Draft' }, onPlanSave: () => calls.push('save'), onPlanChange: value => calls.push(value), onPlanComposition: value => calls.push(value) });
  const input = nodes(tree, node => node.props?.onCompositionStart)[0], event = { metaKey: true, key: 's', preventDefault() {}, nativeEvent: {} };
  input.props.onCompositionStart(); input.props.onKeyDown(event); assert.deepEqual(calls, [true]);
  input.props.onCompositionEnd({ target: { value: '组合完成' } }); input.props.onKeyDown(event);
  assert.deepEqual(calls, [true, '组合完成', false, 'save']);
});

test('long/user-provided titles stay literal and English chrome does not translate them', () => {
  const title = '<img src=x onerror=x>' + '超长任务'.repeat(80);
  const html = render({ available: true, days: [{ ts: 1, label: 'Mon', month: 10, day: 1, tasks: [task('long', { title })] }], invalid: [task('bad')], plan: { dirty: true, value: '原始草稿' } }, 'en-US');
  for (const value of ['Project schedule', 'Previous week', 'Next week', 'Dates to correct', 'Standalone project plan', 'Unsaved', '原始草稿', '超长任务'.repeat(80)]) assert.ok(html.includes(value), value);
  assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img|独立项目计划/);
});

test('layout includes a one-column narrow fallback, wrapped titles and reduced-motion override', () => {
  const css = fs.readFileSync(require.resolve('../app/ui/project-schedule.css'), 'utf8');
  assert.match(css, /grid-template-columns: 112px minmax\(0, 1fr\)/); assert.match(css, /@container project-content \(max-width: 500px\)/);
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\)/); assert.match(css, /overflow-wrap: anywhere/); assert.match(css, /prefers-reduced-motion/); assert.doesNotMatch(css, /repeat\(7/);
});

test('today marks the current time between timed tasks and the week carries a navigation direction', () => {
  const later = task('later', { time: '23:59' }), earlier = task('early', { time: '00:00' }), untimed = task('free', { time: '' });
  const today = [{ ts: 1, label: '周一', month: 10, day: 1, isToday: true, tasks: [earlier, later, untimed] }];
  const html = render({ available: true, days: today });
  assert.equal((html.match(/schedule-now-line/g) || []).length, 1);
  assert.ok(html.indexOf('Task early') < html.indexOf('schedule-now-line') && html.indexOf('schedule-now-line') < html.indexOf('Task later'));
  assert.doesNotMatch(render({ available: true, days: [{ ...today[0], tasks: [untimed] }] }), /schedule-now-line/, 'No invented time for untimed tasks');
  assert.doesNotMatch(render({ available: true, days: [{ ...today[0], isToday: false }] }), /schedule-now-line/);
  const { ProjectScheduleSurface } = load(), week = ts => nodes(ProjectScheduleSurface({ available: true, days: [{ ...today[0], ts }] }), node => node.props?.['data-week-direction'])[0].props['data-week-direction'];
  assert.equal(week(100), 'none'); assert.equal(week(200), 'next'); assert.equal(week(200), 'next'); assert.equal(week(50), 'prev');
  assert.match(html, /class="schedule-day is-today"/);
});
