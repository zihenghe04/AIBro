const test = require('node:test');
const assert = require('node:assert/strict');

let policy, parser;
test.before(async () => {
  policy = await import('../app/editor/visual-policy.mjs');
  const [{ unified }, { default: parse }, { default: gfm }, { default: math }] = await Promise.all([
    import('unified'), import('remark-parse'), import('remark-gfm'), import('remark-math'),
  ]);
  parser = unified().use(parse).use(gfm).use(math);
});

test('BOM and CRLF frontmatter are preserved byte-for-byte outside the editable body', () => {
  const raw = '\uFEFF---\r\ntitle: 中文😀\r\ncustom: "**raw**"\r\n---\r\n\r\n# 正文\n末尾';
  const result = policy.splitFrontmatter(raw);
  assert.equal(result.supported, true);
  assert.equal(result.prefix, '\uFEFF---\r\ntitle: 中文😀\r\ncustom: "**raw**"\r\n---\r\n');
  assert.equal(result.prefix + result.body, raw);
  assert.equal(result.body, '\r\n# 正文\n末尾');
});

test('unclosed frontmatter declines visual editing without discarding source', () => {
  const raw = '---\ntitle: unfinished\n# 正文';
  const result = policy.splitFrontmatter(raw);
  assert.equal(result.supported, false);
  assert.equal(result.raw, raw);
  assert.match(result.reason, /尚未闭合/);
});

test('TOML and YAML alternate terminators remain exact, plain Markdown keeps its body', () => {
  for (const raw of ['+++\na=1\n+++\ntext', '---\na: 1\n...\ntext']) {
    const split = policy.splitFrontmatter(raw);
    assert.equal(split.supported, true); assert.equal(split.body, 'text'); assert.equal(split.prefix + split.body, raw);
  }
  assert.deepEqual(policy.splitFrontmatter('\uFEFF# hi'), { raw: '\uFEFF# hi', prefix: '\uFEFF', body: '# hi', supported: true, reason: '' });
});

test('real Remark AST accepts common editable tables, tasks, code, math and image links', () => {
  const source = '# 标题\n\n- [x] 中文😀\n- [ ] 下一项\n\n| 列一 | 列二 |\n| --- | --- |\n| **粗体** | `x` |\n\n```js\nconst x = "[[not a wiki]] <b>";\n```\n\n$x^2$\n\n$$\na=b\n$$\n\n![图](https://example.com/image.png)\n';
  assert.equal(policy.diagnoseMarkdown(parser.parse(source)).supported, true);
});

test('HTML, wiki syntax, footnotes and reference definitions explicitly fall back', () => {
  for (const source of ['hello <b>世界</b>', 'hello [[笔记]]', '[^1]\n\n[^1]: footnote', '[link][id]\n\n[id]: https://example.com', '::: custom\n内容\n:::']) {
    const diagnosis = policy.diagnoseMarkdown(parser.parse(source));
    assert.equal(diagnosis.supported, false, source); assert.ok(diagnosis.reason.length > 10);
  }
});

test('Milkdown empty-paragraph markers are supported without weakening arbitrary HTML fallback', () => {
  for (const source of [
    'Before\n\n<br />\n\n<br />\n\nAfter',
    '> Before\n>\n> <br />\n>\n> After',
    '- Before\n\n  <br />\n\n  After',
    '| A | B |\n| - | - |\n| <br /> | value |',
  ]) assert.equal(policy.diagnoseMarkdown(parser.parse(source)).supported, true, source);
  for (const source of [
    'Before <br /> after', 'Before\n<br />\nafter', '<br class="kept">', '<br data-id="source">',
    '<br style="height:40px">', '<br onclick="run()">', '<br /><br />', '<br />\n<script>run()</script>',
    '<a href="#note:kept" data-source-id="kept">linked</a>', '<!-- metadata: kept -->', '<BR class=x />',
  ]) {
    const result = policy.diagnoseMarkdown(parser.parse(source));
    assert.equal(result.supported, false, source); assert.match(result.reason, /HTML/);
  }
});

test('safe empty-paragraph markers do not mask unsupported syntax later in the document', () => {
  for (const suffix of ['<custom data-value="keep">x</custom>', '[[wiki]]', '[^1]\n\n[^1]: keep', '```js title="keep"\nx()\n```']) {
    assert.equal(policy.diagnoseMarkdown(parser.parse(`Before\n\n<br />\n\n${suffix}`)).supported, false);
  }
  assert.equal(policy.diagnoseMarkdown(parser.parse('Before\n\n<br />\n\n来源 [note:demo-note]；[资料](#note:demo-note)')).supported, true);
});

test('unknown syntax inside a code block is editable code, not a false fallback', () => {
  const source = '```md\n<div>hi</div>\n[[wiki]]\n::: aside\n[^1]: note\n```';
  assert.equal(policy.diagnoseMarkdown(parser.parse(source)).supported, true);
  assert.equal(policy.diagnoseMarkdown(parser.parse('```js title="keep me"\nx()\n```')).supported, false);
});

test('temporary, executable and local-file URLs never become accepted image resources', () => {
  for (const url of ['blob:https://app/id', 'data:image/svg+xml,<svg/>', 'javascript:alert(1)', 'file:///tmp/test.png', '//remote/image.png', '\\server\\image', 'java\nscript:alert(1)']) {
    assert.equal(policy.safeDocumentUrl(url, { image: true }), false, url);
  }
  for (const url of ['/__attachments/image-id', './images/a.png', 'https://example.com/a.png', '']) {
    assert.equal(policy.safeDocumentUrl(url, { image: true }), true, url);
  }
  assert.equal(policy.safeDocumentUrl('mailto:hello@example.com'), true);
  assert.equal(policy.safeDocumentUrl('mailto:hello@example.com', { image: true }), false);
});

test('diagnostics inspect parsed URLs rather than trusting displayed link text', () => {
  const unsafe = parser.parse('[https://safe.example](javascript:alert)');
  assert.equal(policy.diagnoseMarkdown(unsafe).supported, false);
});

test('source mapping resolves repeated phrases in document order using UTF16 positions', () => {
  const body = '## 中文😀\n\n重复 **重复**\n';
  const ast = parser.parse(body);
  // ProseMirror positions include each heading/paragraph boundary; emoji is two UTF16 units.
  const mappings = policy.sourceTextMappings(body, ast, [{ pos: 1, text: '中文😀' }, { pos: 7, text: '重复 ' }, { pos: 10, text: '重复' }], 9);
  assert.equal(policy.mapProsePosition(mappings, 10), 9 + body.lastIndexOf('重复'));
  assert.equal(policy.mapSourcePosition(mappings, 9 + body.lastIndexOf('重复')), 10);
  assert.equal(policy.mapProsePosition(mappings, 5, -1), 9 + '## 中文😀'.length);
});

test('escaped source is an unmapped gap; following text still maps correctly', () => {
  const body = 'a\\*b **后文**';
  const mappings = policy.sourceTextMappings(body, parser.parse(body), [{ pos: 1, text: 'a*b ' }, { pos: 5, text: '后文' }]);
  assert.equal(policy.mapProsePosition(mappings, 2), null);
  assert.equal(policy.mapProsePosition(mappings, 5), body.indexOf('后文'));
});

test('a parser/document disagreement yields no guessed source positions', () => {
  assert.deepEqual(policy.sourceTextMappings('abc', parser.parse('abc'), [{ pos: 1, text: 'abX' }]), []);
});

test('fenced code literal positions map while fence and language metadata do not', () => {
  const body = '```js\nconst smile = "😀";\n```';
  const text = 'const smile = "😀";';
  const mappings = policy.sourceTextMappings(body, parser.parse(body), [{ pos: 1, text }]);
  assert.equal(policy.mapProsePosition(mappings, 1), body.indexOf('const'));
  assert.equal(policy.mapSourcePosition(mappings, 1), null);
  assert.equal(policy.mapProsePosition(mappings, 1 + text.length, -1), body.indexOf('const') + text.length);
});
