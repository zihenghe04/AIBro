const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Stream = require('../app/stream-markdown.js');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const parser = source.slice(source.indexOf('function renderRichText('), source.indexOf('\nfunction renderMessage('));
function environment() {
  const env = { URL, esc: value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])),
    MathRender: { ...require('../app/math-render.js') }, CodeHighlight: { ...require('../app/code-highlight.js') },
    window: { ConversationLink: { ...require('../app/conversation-link.js') } }, state: {} };
  return { env, render: vm.runInNewContext(`(${parser})`, env) };
}
const fixed = [
  '- a\n\n+ b\n\nsecond\n\nthird',
  'intro\nheader | one\n--- | ---\ncell | two\n\nnext',
  '| 项目 | 状态 | |\n| ---- | --------- | :- |\n| 表格单元 | | a |\n\nnext',
  '- [ ] todo\n* [x] **done**\n+ [X] complete\n\nplain\n\nlast',
  '# title\n\n> quote\n> more\n\nend',
  'a\n\n3. three\n  continuation\n\n4. four\n\nend',
  'a\n\n```js\nconst a = "safe";\n\n// **literal**\n```\n\nend',
  'a\n\n~~~html\n<script>escaped</script>\n~~~\n\nend',
  'a\n\n$$\n\\frac{x}{y}\n\n+ z\n$$\n\nend',
  '[**nested**](https://example.com/x_(y))\n\n[[cite:ev1]]\n\nlast',
  'a\n\ninline *across\nlines* plus ``a`b``\n\nend',
  'a\r\n\r\nb\r\n\r\nc\r\nend',
  'a\n\n[x](aibro://conversation/conv_1)\n\nend',
  '😀\n\n<script>literal</script> [x](javascript:alert(1))\n\nend',
  '- [ ] Parent [[cite:ev1]]\n  - child **one**\n    3. ordered\n    4. child\n- [x] finished\n\nAfter',
  '> A folded source\n> on another line.\n>\n> - quoted item\n>   - nested\n> > another source\n\nAfter',
  '- Example\n  ```js\n  const n = 1;\n  ```\n- Next\n\nAfter',
];
test('incremental actual parser equals full parser at every partial grammar boundary', () => {
  const { render } = environment();
  let seed = 734189;
  const rand = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const tokens = ['a', '中', '\n', '\n\n', '- ', '+ ', '1. ', '  ', '> ', '# ', '|', '---', '```', '~~~', '$', '$$', '[x](', ')', 'https://a.test', '`x`', '\\', '*', '[[cite:ev]]'];
  const samples = [...fixed, ...Array.from({ length: 150 }, () => Array.from({ length: 50 }, () => tokens[rand(tokens.length)]).join(''))];
  for (const input of samples) {
    const cache = {};
    for (let i = 0; i <= input.length; i++) {
      const prefix = input.slice(0, i);
      assert.equal(render(prefix, null, cache), render(prefix), JSON.stringify(prefix));
    }
  }
});
test('source edits, shortened replies and provider replacement invalidate settled prefixes', () => {
  const { render } = environment(), cache = {};
  const values = ['# A\n\nfirst\n\nsecond\n\nlast', '# A\n\nfirst\n\nsecond\n\nlast more', '# A\n\nREPLACED\n\nsecond\n\nlast more', '', 'x', ...fixed];
  for (const text of values) assert.equal(render(text, null, cache), render(text));
});
test('loaded/replaced helpers re-render frozen blocks and state-dependent Wiki bypasses cache', () => {
  const { env, render } = environment(), cache = {};
  const input = '$x^2$\n\n```js\nconst a = 1;\n```\n\n[x](aibro://conversation/conv_1)\n\nsecond\n\nlast';
  render(input, null, cache);
  for (const [host, name, fn] of [[env.MathRender, 'inlineMath', () => '<b>new math</b>'], [env.CodeHighlight, 'highlight', () => 'new highlight'], [env.window.ConversationLink, 'resolve', () => 'new_target']]) {
    host[name] = fn; assert.equal(render(input, null, cache), render(input));
  }
  let destination = 'first';
  env.window.ResearchWiki = { resolveLink: () => destination };
  const wiki = '[note](wiki:note)\n\nsecond\n\nthird';
  assert.match(render(wiki, 'n1', cache), /data-open-note="first"/);
  destination = 'changed';
  assert.match(render(wiki, 'n1', cache), /data-open-note="changed"/);
});
test('cache reduces parsed characters across multi-block output without limiting large single blocks', () => {
  const { render } = environment(), cache = {};
  const text = fixed.slice(0, 6).join('\n\n').repeat(30);
  let full = 0, incremental = 0;
  for (let end = 90; end <= text.length + 90; end += 90) {
    const frame = text.slice(0, end); assert.equal(render(frame, null, cache), render(frame));
    full += frame.length; incremental += cache.parsedCharacters;
  }
  assert.ok(incremental < full / 10, `${incremental} vs ${full}`);
  const huge = 'long sentence '.repeat(2000);
  assert.equal(render(huge, null, cache), render(huge));
});
test('pool is bounded across abandoned streams, release/final clears and evictions never truncate', () => {
  const { render } = environment();
  const pool = Stream.create({ maxEntries: 2, maxCharacters: 1000 });
  const a = {}, b = {}, c = {};
  for (const owner of [a, b, c]) assert.equal(pool.render(owner, fixed[0], render, true), render(fixed[0]));
  assert.equal(pool.inspect().entries, 2);
  assert.equal(pool.render(a, 'text '.repeat(1000), render, true), render('text '.repeat(1000)));
  assert.ok(pool.inspect().characters <= 1000);
  pool.render(b, 'final', render, false); pool.release(c); pool.clear();
  assert.equal(pool.inspect().entries, 0);
  pool.render(a, fixed[0], render, true);
  assert.equal(pool.render(a, fixed[0], value => 'new renderer ' + value, true), 'new renderer ' + fixed[0]);
});
test('production uses message ownership, final release even before preview, and fresh citations', () => {
  assert.match(source, /const markdownOwner = message;\s*if \(!message.live \|\| message.deletedAt\) window.StreamMarkdown\?\.release\(markdownOwner\)/);
  assert.match(source, /StreamMarkdown.render\(markdownOwner, text, renderRichText, !!message.live\)[\s\S]{0,140}CitationEvidence\?\.decorate/);
  assert.match(source, /finally \{\s*window.StreamMarkdown\?\.release\(liveMessage\)/);
  assert.match(source, /function normalizeStateShape\(candidate\) \{\s*window.StreamMarkdown\?\.clear\(\)/);
});

test('status-only updates reuse raw Markdown but revisions, dependency changes and settling parse current content',()=>{
  const {env,render}=environment(),pool=Stream.create(),owner={};let parses=0,probes=0;
  const counted=(...args)=>{if(args[2]?.probeOnly)probes++;else parses++;return render(...args);};
  const text='Unchanged **answer** $x$.\n\nA final paragraph.';
  const initial=pool.render(owner,text,counted,true);
  for(let i=0;i<20;i++)assert.equal(pool.render(owner,text,counted,true),initial);
  assert.equal(parses,1);assert.equal(probes,20);
  const revised=text.replace('answer','revision');assert.equal(pool.render(owner,revised,counted,true),render(revised));assert.equal(parses,2);
  env.MathRender.inlineMath=()=>'<b>new math</b>';assert.match(pool.render(owner,revised,counted,true),/new math/);assert.equal(parses,3);
  assert.equal(pool.render(owner,revised,counted,false),render(revised));assert.equal(parses,4);assert.equal(pool.inspect().entries,0);
});

test('unversioned renderers never reuse stale output and raw-HTML cache shares the bounded pool budget',()=>{
  const pool=Stream.create({maxCharacters:200}),owner={};let revision=0;
  const dynamic=text=>`${text}:${++revision}`;
  assert.notEqual(pool.render(owner,'same',dynamic,true),pool.render(owner,'same',dynamic,true));
  const {render}=environment();pool.render(owner,'<>&'.repeat(500),render,true);
  assert.equal(pool.inspect().entries,0);assert.ok(pool.inspect().characters<=200);
});
