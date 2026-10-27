const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');

function load() {
  const { document, window } = parseHTML('<html lang="zh-CN"><body><label for="s">模式</label><select id="s"><option value="a">甲</option><option value="b">乙</option><optgroup label="更多"><option value="c">丙</option></optgroup></select></body></html>');
  globalThis.document = document; globalThis.Event = window.Event;
  delete require.cache[require.resolve('../app/ui-kit.js')];
  return { UIKit: require('../app/ui-kit.js'), document };
}
const key = (document, node, name) => node.dispatchEvent(Object.assign(new document.defaultView.Event('keydown', { bubbles: true, cancelable: true }), { key: name }));

test('select lists groups and options, filters by search, and reports the chosen value', () => {
  const { UIKit, document } = load();
  const picked = [];
  const select = UIKit.select({ options: [{ value: 'x', label: 'Alpha', group: 'G1', sub: 'first' }, { value: 'y', label: 'Beta', group: 'G2' }, { value: 'z', label: 'Gamma', group: 'G2', disabled: true }], value: 'x', searchable: true, onChange: value => picked.push(value) });
  document.body.append(select.el);
  assert.equal(select.trigger.getAttribute('aria-expanded'), 'false');
  select.open();
  assert.equal(select.trigger.getAttribute('aria-expanded'), 'true');
  const pop = document.querySelector('.uk-pop');
  assert.deepEqual([...pop.querySelectorAll('.uk-group')].map(n => n.textContent), ['G1', 'G2']);
  assert.equal(pop.querySelector('[aria-selected="true"]').dataset.value, 'x');
  const search = pop.querySelector('.uk-search'); search.value = 'bet'; search.dispatchEvent(new document.defaultView.Event('input'));
  assert.deepEqual([...pop.querySelectorAll('[role=option]')].map(n => n.dataset.value), ['y']);
  pop.querySelector('[role=option]').click();
  assert.deepEqual(picked, ['y']);
  assert.equal(select.value(), 'y');
  assert.equal(select.trigger.getAttribute('aria-expanded'), 'false');
});

test('select keyboard: arrows move the active option, Enter picks, disabled options are skipped on click', () => {
  const { UIKit, document } = load();
  const picked = [];
  const select = UIKit.select({ options: ['one', 'two', 'three'], value: 'one', onChange: value => picked.push(value) });
  document.body.append(select.el);
  select.open();
  key(document, select.trigger, 'ArrowDown'); key(document, select.trigger, 'Enter');
  assert.deepEqual(picked, ['two']);
  const disabled = UIKit.select({ options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B', disabled: true }], value: 'a', onChange: v => picked.push(v) });
  document.body.append(disabled.el); disabled.open();
  document.querySelector('.uk-pop [data-value="b"]').click();
  assert.deepEqual(picked, ['two']);
});

test('enhanceSelect keeps the native select as the source of truth', () => {
  const { UIKit, document } = load();
  const native = document.getElementById('s'), seen = [];
  native.addEventListener('change', () => seen.push(native.value));
  const component = UIKit.enhanceSelect(native);
  assert.ok(native.classList.contains('uk-native'));
  assert.equal(UIKit.enhanceSelect(native), component);
  assert.equal(component.trigger.getAttribute('aria-labelledby') !== null, true);
  component.open();
  assert.deepEqual([...document.querySelectorAll('.uk-pop [role=option]')].map(n => n.dataset.value), ['a', 'b', 'c']);
  document.querySelector('.uk-pop [data-value="c"]').click();
  assert.equal(native.querySelector('option[selected]').value, 'c'); assert.deepEqual(seen.length, 1);
  component.setValue('a');
  assert.equal(component.value(), 'a');
});

test('segmented, switch and effort picker are keyboard-operable radiogroup/switch controls', () => {
  const { UIKit, document } = load();
  const got = [];
  const seg = UIKit.segmented({ options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], value: 'a', onChange: v => got.push(v) });
  document.body.append(seg.el);
  assert.equal(seg.el.getAttribute('role'), 'radiogroup');
  key(document, seg.el, 'ArrowRight');
  assert.deepEqual(got, ['b']); assert.equal(seg.el.querySelector('[aria-checked="true"]').dataset.value, 'b');
  const sw = UIKit.switch({ checked: false, label: 'x', onChange: v => got.push(v) });
  sw.el.click(); assert.equal(sw.el.getAttribute('aria-checked'), 'true'); assert.equal(got.at(-1), true);
  const effort = UIKit.effortPicker({ levels: [{ value: 'low', label: '低' }, { value: 'high', label: '高' }], value: '', onChange: v => got.push(v) });
  assert.deepEqual([...effort.el.querySelectorAll('.uk-seg-item')].map(n => n.dataset.value), ['', 'low', 'high']);
});

test('badge and row render text and tone', () => {
  const { UIKit } = load();
  assert.equal(UIKit.badge('默认', { tone: 'accent' }).dataset.tone, 'accent');
  const row = UIKit.row({ title: 'Provider', sub: 'host', badges: ['默认'], selected: true, onClick() {} });
  assert.equal(row.getAttribute('aria-current'), 'true');
  assert.match(row.textContent, /Provider/);
});
