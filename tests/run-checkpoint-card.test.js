'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const React = require('react');
const esbuild = require('esbuild');
const source = fs.readFileSync(require.resolve('../app/ui/run-checkpoint-card.jsx'), 'utf8');
const css = fs.readFileSync(require.resolve('../app/run-checkpoint.css'), 'utf8');
// Transform this controlled component in memory; this does not build or change
// the production Kit bundle. The real Kit primitive behavior is tested by its
// renderer suite; these tests exercise this card's state and callback contract.
const compiled = esbuild.transformSync(source, { loader: 'jsx', format: 'cjs' }).code;
const elements = node => React.isValidElement(node) ? [node, ...React.Children.toArray(node.props.children).flatMap(elements)] : [];
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node)
  : React.isValidElement(node) ? React.Children.toArray(node.props.children).map(text).join(' ') : '';
function fixture(language = 'zh') {
  const appended = [], module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports,
    document: { documentElement: { lang: language }, getElementById: () => null, createElement: () => ({}), head: { appendChild: node => appended.push(node) } },
    require: id => id === 'react' ? React : id.endsWith('.css') ? css : { Button: 'KitButton', Card: 'KitCard', StatusBadge: 'KitStatusBadge' },
  });
  vm.runInContext(compiled, context);
  return { render: module.exports.RunCheckpointCard, appended };
}
test('prepared and applied checkpoints delegate only their distinct recovery action without advancing phase', () => {
  const h = fixture(); let continued = 0, saved = 0, history = 0;
  const callbacks = { onContinue: () => continued++, onSave: () => saved++, onHistory: () => history++ };
  for (const [phase, label, expected] of [['prepared', '继续完成整理', 'onContinue'], ['applied', '继续保存结果', 'onSave']]) {
    const card = h.render({ phase, ...callbacks, actionCount: 3 });
    const action = elements(card).find(node => node.type === 'KitButton' && text(node) === label);
    assert.equal(action.props.onClick, callbacks[expected]);
    assert.equal(action.props.disabled, false);
    assert.equal(card.props['data-checkpoint-phase'], phase);
    assert.doesNotMatch(text(card), /结果已保存/);
    action.props.onClick();
    assert.equal(card.props['data-checkpoint-phase'], phase, 'the callback cannot acknowledge persistence in the presentation');
  }
  assert.equal(continued, 1); assert.equal(saved, 1); assert.equal(history, 0);
});
test('busy state disables recovery and history while exposing phase-specific loading text', () => {
  const h = fixture();
  for (const [phase, label] of [['prepared', '正在校验并继续整理…'], ['applied', '正在保存现有结果…']]) {
    const card = h.render({ phase, busy: true, onContinue() {}, onSave() {}, onHistory() {} });
    assert.equal(card.props['aria-busy'], true);
    const buttons = elements(card).filter(node => node.type === 'KitButton');
    assert.equal(buttons.length, 2); assert.ok(buttons.every(node => node.props.disabled));
    assert.equal(buttons[0].props.loading, true); assert.equal(text(buttons[0]), label);
    assert.doesNotMatch(text(card), /结果已保存/);
  }
});
test('only committed with a confirmed output renders saved state and never offers continuation; unknown phases render nothing', () => {
  const h = fixture(), card = h.render({ phase: 'committed', actionCount: 2, hasSavedResult: true, onContinue() {}, onSave() {}, onHistory() {} });
  assert.match(text(card), /结果已保存/); assert.match(text(card), /2 项本机操作/);
  const buttons = elements(card).filter(node => node.type === 'KitButton');
  assert.equal(buttons.length, 1); assert.equal(text(buttons[0]), '查看执行记录');
  assert.equal(h.render({ phase: 'completed' }), null); assert.equal(h.render({}), null);
});
test('committed answers and proposals without a confirmed output display completed in either language', () => {
  for (const [language, label] of [['zh', '已完成'], ['en', 'Completed']]) {
    const h = fixture(language);
    for (const props of [{ actionCount: 0 }, { actionCount: 2, hasSavedResult: false }, { actionCount: 2, hasSavedResult: 'true' }]) {
      const card = h.render({ phase: 'committed', ...props, onHistory() {} });
      assert.ok(text(card).includes(label)); assert.doesNotMatch(text(card), /结果已保存|Results saved/);
      assert.equal(elements(card).filter(node => node.type === 'KitButton').length, 1);
    }
    for (const phase of ['prepared', 'applied']) assert.doesNotMatch(text(h.render({ phase, hasSavedResult: true })), /结果已保存|Results saved/);
  }
});
test('missing callbacks cannot execute; invalid metadata stays hidden and errors remain literal accessible text', () => {
  const h = fixture(), error = '<script>source</script>\n保存尚未确认';
  const card = h.render({ phase: 'applied', actionCount: NaN, at: Infinity, error });
  const nodes = elements(card), action = nodes.find(node => node.type === 'KitButton');
  assert.equal(action.props.disabled, true); assert.equal(nodes.some(node => node.type === 'time'), false);
  assert.doesNotMatch(text(card), /NaN|Invalid Date/); assert.equal(nodes.find(node => node.props.role === 'alert').props.children, error);
  assert.equal(card.type, 'section'); assert.ok(card.props['aria-label']);
  assert.ok(nodes.some(node => node.props.role === 'status' && node.props['aria-live'] === 'polite'));
});
test('English labels, finite timestamps and scoped stylesheet remain usable without timers or global CSS', () => {
  const h = fixture('en'), at = Date.UTC(2026, 8, 29, 12, 30), card = h.render({ phase: 'applied', actionCount: 1, at, onSave() {} });
  assert.match(text(card), /Changes applied, awaiting save confirmation/); assert.match(text(card), /1 local operation/);
  assert.equal(elements(card).find(node => node.type === 'time').props.dateTime, new Date(at).toISOString());
  assert.equal(h.appended.length, 1); assert.equal(h.appended[0].id, 'halaska-run-checkpoint-styles');
  assert.doesNotThrow(() => esbuild.transformSync(css, { loader: 'css' }));
  assert.match(css, /prefers-reduced-motion/); assert.match(css, /body\.reduce-motion \.run-checkpoint-card/);
});
