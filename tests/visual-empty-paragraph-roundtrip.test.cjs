const test = require('node:test');
const assert = require('node:assert/strict');
let fromMarkdown, toMarkdown, policy, processor, schema, EditorState, history, undo, redo;

// Real pinned Milkdown schema factories, Remark transforms, parser and
// serializer, and real ProseMirror transactions. Only the editor-init wait
// barrier is omitted: this test has no DOM, native app, or fixture workspace.
test.before(async () => {
  const [{ Ctx, Container, Clock }, core, preset, { Schema }, transformer, unifiedModule, parse, stringify, proseState, proseHistory, gfm, remarkGfm] = await Promise.all([
    import('@milkdown/ctx'), import('@milkdown/core'), import('@milkdown/preset-commonmark'), import('@milkdown/prose/model'),
    import('@milkdown/transformer'), import('unified'), import('remark-parse'), import('remark-stringify'), import('@milkdown/prose/state'), import('@milkdown/prose/history'), import('@milkdown/preset-gfm'), import('remark-gfm'),
  ]);
  policy = await import('../app/editor/visual-policy.mjs');
  const ctx = new Ctx(new Container(), new Clock());
  ctx.inject(core.nodesCtx, []).inject(core.marksCtx, []).inject(core.remarkPluginsCtx, []).inject(core.remarkStringifyOptionsCtx, {});
  ctx.wait = async () => {};
  for (const plugin of [preset.docSchema, preset.paragraphSchema, preset.textSchema, preset.htmlSchema,
    preset.linkSchema, preset.blockquoteSchema, preset.listItemSchema, preset.bulletListSchema,
    gfm.tableSchema, gfm.tableHeaderRowSchema, gfm.tableRowSchema, gfm.tableHeaderSchema, gfm.tableCellSchema,
    preset.remarkPreserveEmptyLinePlugin, preset.remarkHtmlTransformer].flat()) await plugin(ctx)();
  schema = new Schema({ nodes: Object.fromEntries(ctx.get(core.nodesCtx)), marks: Object.fromEntries(ctx.get(core.marksCtx)) });
  processor = ctx.get(core.remarkPluginsCtx).reduce((p, item) => p.use(item.plugin, item.options),
    unifiedModule.unified().use(parse.default).use(stringify.default).use(remarkGfm.default));
  fromMarkdown = transformer.ParserState.create(schema, processor);
  toMarkdown = transformer.SerializerState.create(schema, processor);
  ({ EditorState } = proseState); ({ history, undo, redo } = proseHistory);
});
function emptyParagraphs(doc) {
  let count = 0; doc.descendants(node => { if (node.type.name === 'paragraph' && node.childCount === 0) count++; }); return count;
}
const raw = 'Before\n\n<br />\n\n<br />\n\nAfter [note:demo-note] and [source](#aibro-source-demo)\n';

test('the prior failure is specifically preflight HTML, and real Milkdown restores two empty paragraphs', () => {
  const ast = processor.parse(raw), html = ast.children.filter(node => node.type === 'html');
  assert.equal(html.length, 2); assert.equal(html[0].value, '<br />');
  assert.equal(policy.diagnoseMarkdown(ast).supported, true);
  const doc = fromMarkdown(raw);
  assert.equal(emptyParagraphs(doc), 2);
  assert.equal(doc.childCount, 4);
  assert.equal(doc.child(0).textContent, 'Before');
  assert.equal(doc.child(3).textContent, 'After [note:demo-note] and source');
  assert.equal(doc.child(3).lastChild.marks[0].attrs.href, '#aibro-source-demo');
});
test('editing surrounding text, serializing, and reparsing retains both empty paragraphs and internal link', () => {
  const before = fromMarkdown(raw);
  let state = EditorState.create({ schema, doc: before });
  state = state.apply(state.tr.insertText('Edited ', 1));
  const output = toMarkdown(state.doc), reloaded = fromMarkdown(output);
  assert.equal((output.match(/<br \/>/g) || []).length, 2);
  assert.equal(policy.diagnoseMarkdown(processor.parse(output)).supported, true);
  assert.equal(emptyParagraphs(reloaded), 2);
  assert.equal(reloaded.eq(state.doc), true);
  assert.equal(reloaded.child(3).lastChild.marks[0].attrs.href, '#aibro-source-demo');
});
test('nested empty paragraphs survive actual blockquote and list parser/serializer paths', () => {
  for (const input of ['> Before\n>\n> <br />\n>\n> After', '- Before\n\n  <br />\n\n  After']) {
    assert.equal(policy.diagnoseMarkdown(processor.parse(input)).supported, true);
    const doc = fromMarkdown(input), output = toMarkdown(doc);
    assert.equal(emptyParagraphs(doc), 1); assert.equal(fromMarkdown(output).eq(doc), true);
  }
});
test('sole table-cell markers round-trip through the actual GFM table schema as empty cells', () => {
  const input = '| A | B |\n| - | - |\n| <br /> | value |';
  assert.equal(policy.diagnoseMarkdown(processor.parse(input)).supported, true);
  const doc = fromMarkdown(input), output = toMarkdown(doc), restored = fromMarkdown(output);
  assert.equal(doc.child(0).child(1).child(0).textContent, '');
  assert.equal(doc.child(0).child(1).child(1).textContent, 'value');
  assert.equal(restored.eq(doc), true);
});
test('undo and redo preserve real empty nodes and the link target', () => {
  const original = fromMarkdown(raw);
  let state = EditorState.create({ schema, doc: original, plugins: [history()] });
  const dispatch = transaction => { state = state.apply(transaction); };
  dispatch(state.tr.insertText('Edited ', 1)); const edited = state.doc;
  assert.equal(undo(state, dispatch), true); assert.equal(state.doc.eq(original), true);
  assert.equal(redo(state, dispatch), true); assert.equal(state.doc.eq(edited), true);
  assert.equal(emptyParagraphs(fromMarkdown(toMarkdown(state.doc))), 2);
});
test('HTML with attributes and ordinary inline HTML are still refused before real parsing', () => {
  for (const input of ['<br data-source="retain">', 'before <br /> after', '<a href="#note:demo" data-extra="retain">note</a>']) {
    const result = policy.diagnoseMarkdown(processor.parse(input));
    assert.equal(result.supported, false); assert.match(result.reason, /HTML/);
  }
});
