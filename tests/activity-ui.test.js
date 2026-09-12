const test = require('node:test');
const assert = require('node:assert/strict');
const ActivityUI = require('../activity-ui.js');

class Node {
  constructor(dataset = {}, pressed = 'true') { this.dataset = dataset; this.style = {}; this.listeners = {}; this.pressed = pressed; this.attrs = {}; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  getAttribute(name) { return name === 'aria-pressed' ? this.pressed : this.attrs[name]; }
  setAttribute(name, value) { this.attrs[name] = value; if (name === 'aria-pressed') this.pressed = value; }
  click() { this.listeners.click?.(); }
  focus() { this.focused = true; this.listeners.focus?.(); }
}
const parseNodes = value => {
  const nodes = {};
  for (const [attribute, key] of [['days', 'activityDays'], ['toggle', 'activityToggle'], ['workspace', 'activityWorkspace'], ['metric', 'activityMetric'], ['index', 'activityIndex'], ['entry', 'activityEntry']]) {
    nodes[`[data-activity-${attribute}]`] = [...value.matchAll(new RegExp(`<[^>]*data-activity-${attribute}="([^\"]+)"[^>]*>`, 'g'))].map(match => {
      const node = new Node({ [key]: match[1], activityType: /data-activity-type="([^\"]+)"/.exec(match[0])?.[1] }, /aria-pressed="([^\"]+)"/.exec(match[0])?.[1]);
      return node;
    });
  }
  return nodes;
};
class Container {
  constructor() { this.classList = { add() {} }; this.events = []; }
  set innerHTML(value) {
    this.html = value; this.tooltip = { style: {} }; this.nodes = parseNodes(value);
    let markup = ''; const owner = this;
    this.chart = { clientWidth: 800, addEventListener() {}, set innerHTML(text) { markup=text; owner.chartNodes=parseNodes(text); }, get innerHTML() { return markup; } };
    this.chartNodes = {};
  }
  get innerHTML() { return this.html.replace('<div class="activity-ui-chart"></div>', `<div class="activity-ui-chart">${this.chart.innerHTML}</div>`); }
  querySelector(selector) {
    if (selector === '.activity-ui-chart') return this.chart;
    if (selector === '.activity-ui-tooltip') return this.tooltip;
    return this.querySelectorAll(selector)[0] || null;
  }
  querySelectorAll(selector) {
    const match = /^\[data-activity-([a-z]+)="([^\"]+)"\]$/.exec(selector);
    if (match) { const key = 'activity'+match[1][0].toUpperCase()+match[1].slice(1); return this.querySelectorAll(`[data-activity-${match[1]}]`).filter(node=>node.dataset[key]===match[2]); }
    return [...(this.nodes[selector] || []), ...(this.chartNodes[selector] || [])];
  }
  dispatchEvent(event) { this.events.push(event); }
}

const options = { now: new Date(2026, 8, 10), days: 7, workspace: '科研', projectId: 'p' };
const state = { projects: [{ id: 'p', workspace: '科研' }, { id: 'other', workspace: '科研' }], tasks: [{ id: 't', projectId: 'p', status: 'done', completedAt: '2026-09-10' }, { id: 'other', projectId: 'other', status: 'done', completedAt: '2026-09-10' }] };

test('activity date window and hidden series survive ordinary state rerenders', () => {
  const container = new Container();
  assert.equal(ActivityUI.render(container, state, options).totals.tasks, 1);
  container.querySelectorAll('[data-activity-days]').find(node => node.dataset.activityDays === '30').click();
  container.querySelectorAll('[data-activity-toggle]').find(node => node.dataset.activityToggle === 'materials').click();
  const result = ActivityUI.render(container, state, options);
  assert.equal(result.days, 30);
  assert.equal(container.querySelectorAll('[data-activity-toggle]').find(node => node.dataset.activityToggle === 'materials').pressed, 'false');
  assert.ok(container.querySelectorAll('[data-activity-metric="materials"]').every(node => node.style.display === 'none'));
  assert.equal(ActivityUI.render(container, state, { ...options, projectId: 'other' }).days, 7);
});

test('workspace links emit one valid navigation event without generic conflicting jump attributes', () => {
  const container = new Container(); ActivityUI.render(container, state, options);
  assert.doesNotMatch(container.innerHTML, /data-view-jump/);
  const links = container.querySelectorAll('[data-activity-workspace]'); assert.equal(links.length, 1);
  links[0].click(); assert.equal(container.events.length, 1);
  assert.equal(container.events[0].type, 'activity-view-jump');
  assert.equal(container.events[0].detail.workspace, '科研');
});

test('rerender and date switching remove archived or missing project activity from chart and metric buttons', () => {
  const container = new Container();
  const project = { id: 'p', workspace: '科研' };
  const workspace = { projects: [project], tasks: [{ id: 't', projectId: 'p', status: 'done', completedAt: '2026-09-10' }], imports: [{ id: 'source', projectId: 'p', createdAt: '2026-09-10' }] };
  assert.deepEqual(ActivityUI.render(container, workspace, options).totals, { tasks: 1, materials: 1 });
  project.archived = true;
  assert.deepEqual(ActivityUI.render(container, workspace, options).totals, { tasks: 0, materials: 0 });
  assert.match(container.innerHTML, /显示完成任务，共 0 项/);
  assert.match(container.innerHTML, /显示收集资料，共 0 项/);
  assert.match(container.innerHTML, /所选时间段暂无活动记录/);
  container.querySelectorAll('[data-activity-days]').find(node => node.dataset.activityDays === '30').click();
  assert.match(container.innerHTML, /显示完成任务，共 0 项/);
  delete project.archived;
  assert.deepEqual(ActivityUI.render(container, workspace, options).totals, { tasks: 1, materials: 1 });
  workspace.projects = [];
  assert.deepEqual(ActivityUI.render(container, workspace, options).totals, { tasks: 0, materials: 0 });
  assert.equal(workspace.tasks.length, 1);
  assert.equal(workspace.imports.length, 1);
});

test('real D3 produces a shared integer axis and genuine sparse data without synthetic points', () => {
  const d3 = require('../d3.min.js'), Core = require('../activity-core.js');
  const data = Core.aggregate(state, options);
  for (const width of [280, 500, 1100]) {
    const geometry = ActivityUI.chartGeometry(data, width, d3);
    assert.equal(geometry.engine, 'd3');
    assert.deepEqual(geometry.ticks, [0, 1]);
    assert.equal(new Set(geometry.tickIndices).size, geometry.tickIndices.length);
    assert.equal(geometry.series[0].points.filter(point => point.value).length, 1);
    assert.equal(geometry.series[1].points.filter(point => point.value).length, 0);
    for (const metric of geometry.series) {
      assert.doesNotMatch(metric.line + metric.area, /NaN|Infinity/);
      for (const point of metric.points) {
        assert.ok(point.x >= geometry.pad.left && point.x <= width-geometry.pad.right);
        assert.ok(point.y >= geometry.pad.top && point.y <= geometry.height-geometry.pad.bottom);
      }
    }
    assert.deepEqual(geometry.series[0].points.map(point=>point.x), geometry.series[1].points.map(point=>point.x));
  }
});

test('empty charts display no fabricated line or scatter marks', () => {
  const container = new Container(); ActivityUI.render(container, {}, options);
  assert.doesNotMatch(container.innerHTML, /class="activity-ui-line |class="activity-ui-point /);
  assert.match(container.innerHTML, /所选时间段暂无活动记录/);
});

test('clicking a day reveals only its actual scoped sources with escaped names and opens the current typed entity', () => {
  const container = new Container(), opens = [];
  let latest = { projects: [{ id: 'p', name: '<img src=x>', workspace: '科研' }], tasks: [{ id: 't', title: '<script>attack()</script>', projectId: 'p', status: 'done', completedAt: '2026-09-10' }], notes: [{ id: 'n', title: '原文标题', projectId: 'p', createdAt: '2026-09-09' }] };
  const config = { ...options, getState: () => latest, openEntity: (...args) => opens.push(args) };
  ActivityUI.render(container, latest, config);
  container.querySelector('[data-activity-index="6"]').click();
  assert.match(container.innerHTML, /activity-ui-day/);
  assert.match(container.innerHTML, /data-user-content>&lt;script&gt;attack\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(container.innerHTML, /data-activity-entry="n"/);
  const savedButton = container.querySelector('[data-activity-entry="t"]');
  savedButton.click(); assert.deepEqual(opens, [['task', 't']]);
  latest = { ...latest, tasks: [] };
  savedButton.click(); assert.equal(opens.length, 1);
  assert.doesNotMatch(container.innerHTML, /data-activity-entry="t"/);
});

test('legend filters affect day detail and survive switching the 7/30 day range', () => {
  const container = new Container();
  const data = { projects: [{ id: 'p', workspace:'科研' }], tasks:[{id:'t',projectId:'p',status:'done',completedAt:'2026-09-10'}], imports:[{id:'i',projectId:'p',createdAt:'2026-09-10'}] };
  ActivityUI.render(container, data, options);
  container.querySelector('[data-activity-index="6"]').click();
  assert.equal(container.querySelectorAll('[data-activity-entry]').length, 2);
  container.querySelector('[data-activity-toggle="materials"]').click();
  assert.equal(container.querySelectorAll('[data-activity-entry]').length, 1);
  container.querySelector('[data-activity-days="30"]').click();
  assert.equal(container.querySelectorAll('[data-activity-entry]').length, 1);
  assert.equal(container.querySelector('[data-activity-toggle="materials"]').pressed, 'false');
});

test('keyboard day navigation and Enter expose the same actual records as clicking', () => {
  const container = new Container(); ActivityUI.render(container, state, options);
  let prevented = 0;
  container.querySelector('[data-activity-index="5"]').listeners.keydown({key:'ArrowRight',preventDefault(){prevented++;}});
  assert.equal(container.querySelector('[data-activity-index="6"]').focused, true);
  container.querySelector('[data-activity-index="6"]').listeners.keydown({key:'Enter',preventDefault(){prevented++;}});
  assert.equal(prevented, 2); assert.ok(container.querySelector('[data-activity-entry="t"]'));
});

test('language changes rerender only interface dates; user entity names remain untouched', () => {
  const previousDoc = global.document, previousI18n = global.WorkstationI18n;
  const events = {}; let language = 'zh-CN';
  global.document = { addEventListener: (name,fn)=>{events[name]=fn;},removeEventListener:(name)=>{delete events[name];} };
  global.WorkstationI18n = { getLanguage:()=>language,translate(){} };
  try {
    const container = new Container(); ActivityUI.render(container, { ...state, tasks:[{...state.tasks[0],title:'总览'}] }, options);
    container.querySelector('[data-activity-index="6"]').click();
    assert.match(container.innerHTML, /9月/);
    language = 'en'; events['workstation-language-change']();
    assert.match(container.innerHTML, /Sep/); assert.match(container.innerHTML, /data-user-content>总览/);
    ActivityUI.destroy(container); assert.equal(events['workstation-language-change'], undefined);
  } finally { global.document = previousDoc; global.WorkstationI18n = previousI18n; }
});
