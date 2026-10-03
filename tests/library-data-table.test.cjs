const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { transformSync } = require('esbuild');
const raw = fs.readFileSync(require.resolve('../app/ui/halaska-kit.jsx'), 'utf8');
const patchModule = import(pathToFileURL(require.resolve('../scripts/halaska-data-table-patch.mjs')).href);
const componentSource = fs.readFileSync(require.resolve('../app/ui/library-data-table.jsx'), 'utf8');

// Execute the actual pinned DataTable function, with the production pure patch.
// Only theme values and its tiny hook store are supplied; JSX uses real React.
// This is not a production bundle or browser/GUI build.
function tableHarness(source) {
  const start = source.indexOf('function DataTable('), end = source.indexOf('\nfunction AlertDialog(', start);
  const code = transformSync(source.slice(start, end) + '\nexport {DataTable};', { loader: 'jsx', format: 'cjs' }).code;
  let cursor = 0; const state = [], module = { exports: {} };
  const Checkbox = props => React.createElement('span', { role: 'presentation', 'data-legacy-checkbox': '' });
  vm.runInNewContext(code, { module, exports: module.exports, require: () => React, React, Checkbox,
    useThemeContext: () => 'dark', usePal: () => ({ borderSubtle: '#333', accentBg: '#abcdef', bgSubtle: '#222', text: '#fff' }),
    useState(initial) { const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], next => { state[index] = next; }]; },
    tokens: { radius: { md: 8 }, font: { sans: 'sans-serif' }, type: { xs: {}, sm: {} }, weight: { semibold: 600 } },
    motion: { smooth: '0s', normal: '0s', easeInOut: 'ease' },
  });
  const DataTable = props => { cursor = 0; return module.exports.DataTable(props); };
  return { DataTable, render: DataTable, Checkbox };
}
function nodes(element, predicate) {
  if (Array.isArray(element)) return element.flatMap(value => nodes(value, predicate));
  if (!element || typeof element !== 'object') return [];
  return [...(predicate(element) ? [element] : []), ...nodes(element.props?.children, predicate)];
}
const byType = (element, type) => nodes(element, node => node.type === type);
const bodyRows = element => byType(element, 'tbody')[0].props.children;
const makeRows = () => [
  { key: 'note:same', id: 'same', kind: 'note', title: 'Zulu <literal>', cells: ['Zulu', 'Needs review'] },
  { key: 'import:same', id: 'same', kind: 'import', title: 'Alpha', cells: ['Alpha', 'Pending'] },
];
function controlled(rows = makeRows(), extra = {}) {
  return { rows, columns: ['Name', 'Status'], columnKeys: ['name', 'status'], getRowId: row => row.key, getRowCells: row => row.cells,
    selectedIds: ['note:same'], sort: { key: 'name', dir: 'asc' }, sortKeys: ['name', null], manualSort: true,
    renderSelection: ({ all, checked, indeterminate, disabled, onChange, key }) => React.createElement('input', {
      type: 'checkbox', checked, disabled, 'data-key': key, 'data-all': all, 'aria-checked': indeterminate ? 'mixed' : checked,
      onChange: event => onChange(event.target.checked),
    }), getRowProps: row => ({ 'data-cui-key': row.key }), ...extra };
}
const kitButton = ({ children, disabled, onClick, title, ...props }) => React.createElement('button', { type: 'button', disabled, onClick, title, 'aria-label': props['aria-label'] }, children);
function libraryHarness(DataTable, language = 'zh-CN', overrides = {}) {
  const code = transformSync(componentSource + '\nexport {TableSelection, TableAction};', { loader: 'jsx', format: 'cjs' }).code;
  const module = { exports: {} }, hooks = { ...React, ...overrides };
  const kit = { DataTable, Button: kitButton, Checkbox: props => React.createElement('span', { 'data-kit-checkbox': true, 'aria-hidden': true }, props.checked ? '✓' : '') };
  const document = { documentElement: { lang: language }, getElementById: () => null, createElement: () => ({}), head: { append() {} } };
  vm.runInNewContext(code, { module, exports: module.exports, document, require: id => id === 'react' ? hooks : id.endsWith('.css') ? '' : kit });
  return { ...module.exports, kit };
}
const sourceRows = () => makeRows().map((row, index) => ({ ...row, folder: index ? '' : 'research/notes', status: index ? '待 AI 分析' : '待审阅', statusTone: 'analysis-pending', statusDetail: 'Original remains unchanged', updated: index ? 0 : Date.UTC(2026, 9, 1), projectId: 'p', projectName: 'Project' }));

test('the unmodified pinned table reproduces index selection drifting after sorting', () => {
  const h = tableHarness(raw), props = { columns: ['Name'], rows: [['Zulu'], ['Alpha']] };
  let tree = h.render(props);
  const firstCheck = nodes(bodyRows(tree)[0], node => node.type === h.Checkbox)[0]; firstCheck.props.onChange(true);
  tree = h.render(props); byType(tree, 'th')[1].props.onClick(); tree = h.render(props);
  assert.equal(bodyRows(tree)[0].props.children[1][0].props.children, 'Alpha');
  assert.equal(nodes(bodyRows(tree)[0], node => node.type === h.Checkbox)[0].props.checked, true, 'The checked index moved from Zulu to Alpha');
});

test('the pure patch preserves other vendor components and fails closed on drift, duplicates or a second application', async () => {
  const { patchHalaskaDataTable } = await patchModule, patched = patchHalaskaDataTable(raw);
  const before = raw.indexOf('function DataTable('), after = raw.indexOf('\nfunction AlertDialog(', before);
  assert.equal(patched.slice(0, before), raw.slice(0, before)); assert.equal(patched.slice(patched.indexOf('\nfunction AlertDialog(', before)), raw.slice(after));
  assert.throws(() => patchHalaskaDataTable(raw.replace('const [hoverRow, setHoverRow] = useState(-1);', 'const [hoverRow, setHoverRow] = useState(null);')), /source changed/);
  assert.throws(() => patchHalaskaDataTable(raw + raw), /unique pinned/);
  assert.throws(() => patchHalaskaDataTable(patched), /unique pinned/);
  assert.doesNotThrow(() => tableHarness(patched));
});

test('controlled rows preserve typed identity, external order and selection through reorder and insertion', async () => {
  const { patchHalaskaDataTable } = await patchModule, h = tableHarness(patchHalaskaDataTable(raw)), rows = makeRows(), calls = [];
  const props = controlled(rows, { onToggleRow: (...args) => calls.push(args) });
  let tree = h.render(props);
  assert.deepEqual(bodyRows(tree).map(row => row.key), ['note:same', 'import:same'], 'manualSort does not reorder the supplied rows');
  byType(bodyRows(tree)[1], 'input')[0].props.onChange({ target: { checked: true } });
  assert.deepEqual(calls, [['import:same', true]]);
  const inserted = { key: 'note:new', cells: ['First', ''] };
  tree = h.render({ ...props, rows: [inserted, rows[1], rows[0]] });
  assert.deepEqual(bodyRows(tree).map(row => [row.key, row.props['aria-selected']]), [['note:new', false], ['import:same', false], ['note:same', true]]);
  assert.equal(byType(bodyRows(tree)[1], 'input')[0].props.checked, false, 'No optimistic internal selection is used in controlled mode');
});

test('visible selection controls all and mixed state without counting stale selected IDs', async () => {
  const { patchHalaskaDataTable } = await patchModule, h = tableHarness(patchHalaskaDataTable(raw)), calls = [];
  let tree = h.render(controlled(makeRows(), { selectedIds: ['note:same', 'no-longer-visible'], onToggleAll: value => calls.push(value) }));
  let all = byType(tree, 'input')[0]; assert.equal(all.props['aria-checked'], 'mixed'); assert.equal(all.props.checked, false);
  all.props.onChange({ target: { checked: true } }); assert.deepEqual(calls, [true]);
  tree = h.render(controlled([makeRows()[0]], { selectedIds: ['note:same', 'no-longer-visible'] }));
  all = byType(tree, 'input')[0]; assert.equal(all.props['aria-checked'], true); assert.equal(all.props.checked, true);
  tree = h.render(controlled([], { selectedIds: ['note:same'] })); all = byType(tree, 'input')[0];
  assert.equal(all.props.disabled, true); assert.equal(all.props.checked, false);
});

test('invalid controlled IDs cannot silently fall back to positional selection', async () => {
  const { patchHalaskaDataTable } = await patchModule, h = tableHarness(patchHalaskaDataTable(raw));
  for (const rows of [[{ key: '' }], [{ key: 0 }], [{ key: 'same' }, { key: 'same' }]]) assert.throws(() => h.render(controlled(rows)), /unique non-empty/);
  assert.throws(() => h.render(controlled(makeRows(), { getRowId: undefined })), /requires/);
  assert.throws(() => h.render(controlled(makeRows(), { renderSelection: undefined })), /requires/);
});

test('sortable headers are native buttons with controlled aria-sort; unsortable status never emits sort', async () => {
  const { patchHalaskaDataTable } = await patchModule, h = tableHarness(patchHalaskaDataTable(raw)), calls = [];
  const tree = h.render(controlled(makeRows(), { onSortChange: key => calls.push(key) }));
  const name = byType(tree, 'th').find(node => node.props['data-column'] === 'name');
  const status = byType(tree, 'th').find(node => node.props['data-column'] === 'status');
  assert.equal(name.props['aria-sort'], 'ascending'); assert.equal(status.props['aria-sort'], undefined); assert.equal(byType(status, 'button').length, 0);
  const button = byType(name, 'button')[0]; assert.equal(button.props.type, 'button'); button.props.onClick(); assert.deepEqual(calls, ['name']);
  assert.deepEqual(bodyRows(h.render(controlled())).map(node => node.key), ['note:same', 'import:same'], 'Header does not introduce its own sort order');
});

test('disabled controlled table rejects direct selection and sorting callbacks', async () => {
  const { patchHalaskaDataTable } = await patchModule, h = tableHarness(patchHalaskaDataTable(raw)), calls = [];
  const tree = h.render(controlled(makeRows(), { disabled: true, onToggleRow: () => calls.push('row'), onToggleAll: () => calls.push('all'), onSortChange: () => calls.push('sort') }));
  for (const input of byType(tree, 'input')) { assert.equal(input.props.disabled, true); input.props.onChange({ target: { checked: true } }); }
  for (const button of byType(tree, 'button')) { assert.equal(button.props.disabled, true); button.props.onClick(); }
  assert.deepEqual(calls, []); assert.equal(byType(tree, 'table')[0].props['aria-busy'], true);
});

test('legacy arrays continue rendering and local sorting without controlled props', async () => {
  const { patchHalaskaDataTable } = await patchModule, h = tableHarness(patchHalaskaDataTable(raw)), props = { columns: ['Name'], rows: [['Zulu'], ['Alpha']] };
  byType(h.render(props), 'button')[0].props.onClick(); const tree = h.render(props);
  assert.equal(bodyRows(tree)[0].props.children[1][0].props.children, 'Alpha');
  assert.equal(byType(tree, 'th')[1].props['aria-sort'], 'ascending');
});

test('LibraryDataTable renders the patched DataTable, all real source rows, native controls and escaped status without fabricating saved output', async () => {
  const { patchHalaskaDataTable } = await patchModule, h = tableHarness(patchHalaskaDataTable(raw)), { LibraryDataTable } = libraryHarness(h.DataTable);
  const rows = sourceRows(), html = renderToStaticMarkup(React.createElement(LibraryDataTable, { rows, projectScoped: true, selectedKeys: ['note:same'], canDelete: true, onOpen() {}, onDelete() {} }));
  assert.match(html, /<table/); assert.equal((html.match(/data-cui-key=/g) || []).length, 2);
  assert.match(html, /data-cui-key="note:same"[^>]*data-cui-id="same"[^>]*data-cui-kind="note"/);
  assert.match(html, /Zulu &lt;literal&gt;/); assert.match(html, /待审阅/); assert.match(html, /待 AI 分析/);
  assert.doesNotMatch(html, /已保存|已采纳|data-column="project"/);
  assert.equal((html.match(/type="checkbox"/g) || []).length, 3); assert.match(html, /aria-checked="mixed"[^>]*data-cui-all/);
  assert.match(html, /<th[^>]*data-column="updated"[^>]*aria-sort="descending"/);
  assert.match(html, /<time>—<\/time>/);
});

test('LibraryDataTable forwards exact button anchors, typed action keys, explicit sort intents and project entry keys', async () => {
  const { patchHalaskaDataTable } = await patchModule, h = tableHarness(patchHalaskaDataTable(raw)), { LibraryDataTable } = libraryHarness(h.DataTable);
  const calls = [], row = sourceRows()[0], props = { rows: [row], canDelete: true,
    onOpen: (...args) => calls.push(['open', ...args]), onDelete: key => calls.push(['delete', key]), onProject: key => calls.push(['project', key]),
    onSort: key => calls.push(['sort', key]), onToggle: (...args) => calls.push(['toggle', ...args]), onToggleAll: checked => calls.push(['all', checked]) };
  const table = LibraryDataTable(props).props.children, cell = table.props.getRowCells(row);
  assert.equal(table.type, h.DataTable); assert.equal(table.props.manualSort, true);
  const button = {}, nestedIcon = {}; cell[0].props.onClick({ currentTarget: button, target: nestedIcon }); cell[1].props.onClick(); cell.at(-1).props.onClick();
  table.props.onToggleRow('note:same', true); table.props.onToggleAll(false); table.props.onSortChange('updated');
  assert.deepEqual(calls, [['open', 'note:same', button], ['project', 'note:same'], ['delete', 'note:same'], ['toggle', 'note:same', true], ['all', false], ['sort', 'updated']]);
  assert.deepEqual(Array.from(table.props.sortKeys), ['name', null, null, 'updated', null]);
  const busyTable = LibraryDataTable({ ...props, busy: true }).props.children;
  busyTable.props.getRowCells(row)[0].props.onClick({ currentTarget: button }); busyTable.props.getRowCells(row).at(-1).props.onClick(); busyTable.props.onSortChange('name');
  assert.equal(calls.length, 6, 'Busy guard also protects direct invocation');
});

test('source names expose a distinct named button without folding the folder into its accessible action', async () => {
  const { patchHalaskaDataTable } = await patchModule, h = tableHarness(patchHalaskaDataTable(raw));
  const row = { ...sourceRows()[1], title: '换乘等待的主观成本 · <演示研究札记>.pdf', folder: '原始资料/演示' };
  for (const [language, label] of [['zh-CN', `打开资料：${row.title}`], ['en', `Open source: ${row.title}`]]) {
    const { LibraryDataTable, TableAction } = libraryHarness(h.DataTable, language, { useRef: () => ({ current: null }), useLayoutEffect() {} });
    const table = LibraryDataTable({ rows: [row], projectScoped: true, onOpen() {} }).props.children;
    const action = table.props.getRowCells(row)[0], nativeAction = TableAction(action.props).props.children;
    assert.equal(nativeAction.props.type, 'button', 'Native button supplies Tab, Enter and Space activation without custom key handlers');
    assert.equal(nativeAction.props['aria-label'], label);
    assert.equal(nativeAction.props.title, row.title);
    assert.equal(nativeAction.props.disabled, false);
    assert.equal(byType(action, 'span').find(node => node.props.className === 'library-data-name').props['aria-hidden'], 'true', 'Only the explicitly labelled action is exposed, not duplicate filename/folder descendants');
    const html = renderToStaticMarkup(React.createElement(LibraryDataTable, { rows: [row], projectScoped: true, onOpen() {} }));
    assert.match(html, /<button[^>]*aria-label="(?:打开资料：|Open source: )换乘等待的主观成本 · &lt;演示研究札记&gt;\.pdf"/);
    assert.match(html, /<small>原始资料\/演示<\/small>/, 'Folder and full name remain visible');
    assert.doesNotMatch(html, /aria-label="[^"\n]*原始资料\/演示/);
  }
});

test('selection adapter sets the actual mixed property and action selectors belong to the Kit button', async () => {
  const refs = [], effects = [], calls = [];
  const button = { attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } };
  const { TableSelection, TableAction, kit } = libraryHarness(() => null, 'zh', {
    useRef: () => { const ref = { current: { indeterminate: false, querySelector: () => button } }; refs.push(ref); return ref; },
    useLayoutEffect: fn => effects.push(fn),
  });
  const control = TableSelection({ checked: false, indeterminate: true, all: true, disabled: false, onChange: value => calls.push(value) });
  effects.splice(0).forEach(fn => fn()); assert.equal(refs[0].current.indeterminate, true);
  const input = byType(control, 'input')[0]; assert.equal(input.props.type, 'checkbox'); assert.equal(input.props['data-cui-all'], '');
  input.props.onChange({ target: { checked: true } }); assert.deepEqual(calls, [true]);
  const action = TableAction({ attribute: 'data-cui-open', className: 'library-data-open', children: 'Open' });
  effects.splice(0).forEach(fn => fn()); assert.equal(button.attrs['data-cui-open'], ''); assert.equal(action.props.children.type, kit.Button);
  assert.equal(action.props['data-cui-open'], undefined, 'Wrapper is not an extra hit target');
});

test('English chrome keeps custom status and names intact, status never adopts the type sort indicator', async () => {
  const { patchHalaskaDataTable } = await patchModule, h = tableHarness(patchHalaskaDataTable(raw)), { LibraryDataTable } = libraryHarness(h.DataTable, 'en');
  const rows = sourceRows(); rows[1].status = 'My custom status'; rows[1].title = '用户原名';
  const html = renderToStaticMarkup(React.createElement(LibraryDataTable, { rows, sort: { key: 'type', dir: 'asc' } }));
  assert.match(html, /Needs review/); assert.match(html, /My custom status/); assert.match(html, /用户原名/); assert.match(html, /Select all visible items/);
  assert.doesNotMatch(html, /aria-sort="ascending"|aria-sort="descending"/);
});
