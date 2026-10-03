'use strict';
// Exercise the shipped parser and renderer, not a second Markdown implementation.
// Node compilation chooses upstream's DOM-free entity decoder. A separate test
// loads the actual browser bundle with only its entity-decoding DOM primitive.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
const filename = path.join(root, 'app/editor/document-markdown.js');
const compiled = buildSync({ entryPoints: [filename], write: false, bundle: true, format: 'cjs', platform: 'node', logLevel: 'silent' }).outputFiles[0].text;
const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = module.paths; loaded._compile(compiled, filename);
const { render, renderWithMetadata, headings, resolveFragment } = loaded.exports;
const count = (html, expression) => [...html.matchAll(expression)].length;
const sha256 = value => createHash('sha256').update(value).digest('hex');

test('CommonMark preserves nested quotes, tight and loose lists, starts and task status', () => {
  const html = render('> quoted **bold**\n>\n> 3. outer\n>    - inner *emphasis*\n>    - [x] done\n>    - [ ] todo\n\n- first paragraph\n\n  second paragraph\n\n- next\n\n---');
  assert.match(html, /<blockquote><p>quoted <strong>bold<\/strong><\/p><ol start="3"><li>outer<ul/);
  assert.match(html, /<li>inner <em>emphasis<\/em><\/li>/);
  assert.match(html, /type="checkbox" disabled checked aria-label="已完成"/);
  assert.match(html, /type="checkbox" disabled aria-label="未完成"/);
  assert.match(html, /<li><p>first paragraph<\/p><p>second paragraph<\/p><\/li>/);
  assert.ok(html.endsWith('<hr>'));
});

test('headings share exact IDs with rendered anchors and strip syntactic closing hashes', () => {
  const raw = '# Hello *world* ###\n\n## 你好\n\n## 你好\n\n## 你好-1\n\n## 你好\n\n#\n\nSetext\n======\n\n[jump](#%E4%BD%A0%E5%A5%BD-1) [first](#Hello-world)';
  const data = renderWithMetadata(raw, { idPrefix: 'note one' });
  assert.deepEqual(data.headings.map(h => h.text), ['Hello world', '你好', '你好', '你好-1', '你好', '', 'Setext']);
  assert.equal(new Set(data.headings.map(h => h.id)).size, data.headings.length);
  assert.deepEqual(headings(raw, { idPrefix: 'note one' }), data.headings);
  for (const h of data.headings) {
    assert.ok(data.html.includes(`id="${h.id}" data-document-source-start="${h.start}"`));
    assert.ok(raw.slice(h.start, h.end).length > 0);
  }
  assert.ok(data.html.includes(`data-document-anchor="${data.headings[2].id}" href="#${data.headings[2].id}"`));
  assert.ok(data.html.includes(`data-document-anchor="${data.headings[0].id}"`));
});

test('closed initial YAML and TOML are folded properties with full raw source offsets', () => {
  for (const [delimiter, ending, format] of [['---', '---', 'yaml'], ['---', '...', 'yaml'], ['+++', '+++', 'toml']]) {
    const raw = `\uFEFF${delimiter}\r\ntitle: '<script>property</script>'\r\n${ending}\r\n\r\n# 正文 ###\r\n`; 
    const data = renderWithMetadata(raw);
    assert.equal(data.frontmatter.format, format);
    assert.equal(data.frontmatter.start, 1);
    assert.equal(data.headings.length, 1);
    assert.equal(data.headings[0].start, raw.indexOf('# 正文'));
    assert.equal(data.headings[0].text, '正文');
    assert.match(data.html, /^<details class="document-markdown-properties document-frontmatter"><summary>文档属性<\/summary><pre>/);
    assert.ok(data.html.includes('&lt;script&gt;property&lt;/script&gt;'));
    assert.ok(!data.html.includes('<script>'));
  }
  const bom = renderWithMetadata('\uFEFF# Title');
  assert.equal(bom.frontmatter, null);
  assert.equal(bom.headings[0].start, 1);
});

test('local heading anchors take precedence over same-note resolvers including unknown fragments', () => {
  const calls = [];
  const data = renderWithMetadata('# Target\n\n[jump](#target) [missing](#missing)', {
    resolveLink: value => { calls.push(value); return { kind: 'note', id: 'same-note' }; },
  });
  assert.deepEqual(calls, []);
  assert.match(data.html, /data-document-anchor="dm-document-heading-target" href="#dm-document-heading-target">jump/);
  assert.ok(!data.html.includes('data-open-note'));
  assert.match(data.html, /<span class="document-unavailable-link">missing<\/span>/);
});

test('unclosed or non-initial frontmatter remains visible Markdown body', () => {
  const unclosed = renderWithMetadata('---\ntitle: unfinished\n\n# Visible');
  assert.equal(unclosed.frontmatter, null);
  assert.match(unclosed.html, /title: unfinished/);
  assert.equal(unclosed.headings[0].text, 'Visible');
  const notInitial = renderWithMetadata('text\n\n+++\ntitle: text\n+++\n');
  assert.equal(notInitial.frontmatter, null);
  assert.match(notInitial.html, /title: text/);
});

test('reference links and images use first definition, preserve title, and resolve local image once', () => {
  const calls = [];
  const data = renderWithMetadata('[source][DOC] ![diagram][photo]\n\n[doc]: https://example.org/first "A & B"\n[doc]: javascript:bad\n[photo]: ./paper.assets/plot.png "A <caption>"', {
    resolveImage: value => { calls.push(value); return '/__files/image_123'; },
  });
  assert.match(data.html, /href="https:\/\/example.org\/first" target="_blank" rel="noopener noreferrer" title="A &amp; B"/);
  assert.match(data.html, /alt="diagram" src="\/__files\/image_123" title="A &lt;caption&gt;"/);
  assert.deepEqual(calls, ['./paper.assets/plot.png']);
  assert.deepEqual(data.images, [{ url: './paper.assets/plot.png', alt: 'diagram', available: true }]);
  assert.equal(data.warnings.length, 0);
});

test('only resolver-approved local image endpoints create requests; remote and denied references stay readable', () => {
  const raw = '![private report](https://tracker.invalid/pixel)';
  for (const resolver of [undefined, () => null, value => value, () => '//tracker.invalid/image', () => 'data:image/png;base64,x', () => 'blob:x', () => '/__files/p.png', () => '/__files/..', () => '/__local/document-images/read?x=y#remote']) {
    const data = renderWithMetadata(raw, { resolveImage: resolver });
    assert.ok(!data.html.includes('<img'));
    assert.match(data.html, /private report/);
    assert.match(data.html, /图片暂不可用/);
    assert.deepEqual(data.warnings, ['unavailable-image']);
    assert.equal(data.images[0].available, false);
  }
  const local = render(raw, { resolveImage: () => '/__local/document-images/read?path=a%26b&token=scope' });
  assert.match(local, /src="\/__local\/document-images\/read\?path=a%26b&amp;token=scope"/);
  const escaped = render('![a" onerror="bad](/__files/img)', { resolveImage: () => '/__files/img' });
  assert.match(escaped, /alt="a&quot; onerror=&quot;bad"/);
});

test('image metadata respects parser semantics for closed and unclosed inline code', () => {
  const resolveImage = value => value;
  assert.equal(renderWithMetadata('`![hidden](/__files/x)`', { resolveImage }).images.length, 0);
  assert.equal(renderWithMetadata('` unfinished ![visible](/__files/x)', { resolveImage }).images.length, 1);
  assert.equal(renderWithMetadata('```md\n![hidden](/__files/x)\n```', { resolveImage }).images.length, 0);
  assert.equal(renderWithMetadata('![reference][p]\n\n[p]: /__files/x', { resolveImage }).images.length, 1);
  assert.match(render('![640](/__files/x "Actual caption")', { resolveImage }), /alt="Actual caption"/);
});

test('external URLs use explicit safe schemes and source fields cannot inject markup', () => {
  const html = render('[web](https://example.org/?a=1&b=2 "say \"hello\"") [mail](mailto:hello@example.org) [phone](tel:+123)');
  assert.match(html, /href="https:\/\/example.org\/\?a=1&amp;b=2"/);
  assert.match(html, /href="mailto:hello@example.org"/);
  assert.match(html, /href="tel:\+123"/);
  for (const url of ['javascript:alert%281%29', 'java&#x73;cript:alert%281%29', 'data:text/html,hello', 'file:///etc/passwd', 'vbscript:hi', '//example.org/p', 'https://user:password@example.org/p', 'https:\\evil.invalid']) {
    const blocked = render(`[caption](${url})`);
    assert.ok(!blocked.includes('<a '), url);
    assert.ok(!blocked.includes('<img '), url);
  }
  assert.ok(!render('[bad](#unknown)').includes('<a '));
});
test('local document links require an explicit owner resolver and never become filesystem hrefs',()=>{
 const text='[Next **chapter**](second.md#%E7%BB%93%E8%AE%BA "Read next")';
 assert.ok(!render(text).includes('data-document-local-path'));
 const calls=[],html=render(text,{resolveDocumentLink:url=>{calls.push(url);return{path:'chapter/second.md',fragment:'结论'};}});
 assert.deepEqual(calls,['second.md#%E7%BB%93%E8%AE%BA']);assert.match(html,/data-document-local-path="chapter\/second.md" data-document-fragment="结论" title="Read next">Next <strong>chapter<\/strong><\/button>/);assert.ok(!html.includes('href='));
 assert.match(render('[next](x)',{resolveDocumentLink:()=>({path:'a"b.md',fragment:'x"<tag>'})}),/path="a&quot;b.md" data-document-fragment="x&quot;&lt;tag&gt;"/);
 for(const path of ['../x.md','/tmp/x.md','a//x.md','a/./x.md','a%20b.md','a\\b.md','file:foo','a#b.md','a?b.md'])assert.ok(!render('[x](relative.md)',{resolveDocumentLink:()=>({path})}).includes('data-document-local-path'),path);
 assert.ok(!render('[x](relative.md)',{resolveDocumentLink:()=>({path:'a.md',fragment:'bad\nfragment'})}).includes('data-document-local-path'));
 assert.ok(!render('`[x](second.md)`\n\n```md\n[x](second.md)\n```',{resolveDocumentLink:()=>({path:'second.md'})}).includes('data-document-local-path'));
});
test('cross-document fragments use the same IDs and duplicate-heading rules as inline anchors',()=>{
 const text='# 研究 结论\n\n# 研究 结论';const options={idPrefix:'local-document'},items=headings(text,options);
 assert.equal(resolveFragment(text,'研究-结论',options),items[0].id);assert.equal(resolveFragment(text,'研究-结论-1',options),items[1].id);
 assert.equal(resolveFragment(text,items[1].id,options),items[1].id);assert.equal(resolveFragment(text,'%E7%A0%94%E7%A9%B6',options),null,'Never URI-decode a second time');assert.equal(resolveFragment(text,'missing',options),null);
});

test('raw HTML is escaped except attribute-free br; comments and resource tags stay inert', () => {
  const html = render('before<br>after\n\n<br onclick="bad()">\n\n<script>bad()</script>\n\n<img src="https://tracker.invalid/pixel" onerror="bad()">\n\n<!-- hidden -->');
  assert.match(html, /before<br>after/);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img '));
  assert.ok(!html.includes('<br onclick'));
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(html, /&lt;!-- hidden --&gt;/);
  assert.equal(count(render('a<br/>b<BR />c'), /<br>/g), 2);
});

test('Wiki and typed document links resolve live, while code and escaped Wiki examples remain literal', () => {
  const calls = [];
  const resolveLink = value => { calls.push(value); return { kind: 'note', id: 'n"<1' }; };
  const html = render('[[target|Display & label]] [read](note:123) `[[inline]]`\n\n```md\n[[fenced]]\n```\n\n\\[[escaped]]\n\n[caption [[nested]]](https://example.org)', { resolveLink });
  assert.match(html, /data-open-note="n&quot;&lt;1">Display &amp; label/);
  assert.ok(html.includes('`') === false);
  assert.ok(html.includes('<code>[[inline]]</code>'));
  assert.ok(html.includes('[[fenced]]'));
  assert.ok(html.includes('[[escaped]]'));
  assert.deepEqual(calls, ['target', 'note:123', 'https://example.org']);
  assert.equal(count(html, /<button /g), 3);
  assert.ok(!html.includes('>caption <button'));
  for (const kind of ['import', 'conversation']) assert.match(render('[link](record:1)', { resolveLink: () => ({ kind, id: 'one' }) }), new RegExp(`data-open-${kind}="one"`));
  assert.ok(!render('[[bad]]', { resolveLink: () => ({ kind: 'script', id: 'x' }) }).includes('<button'));
});

test('bare workspace references use actual titles and existing note, task and project navigation', () => {
  const calls = [], titles = { note: '第一讲 · 观察', task: '补记候车时间', project: '交互设计方法' };
  const raw = '来源 [note:n-1]，下一步 **[task:t_1]**，归属 [project:p1]。';
  const html = render(raw, { resolveReference: target => { calls.push(target); const [kind, id] = target.split(':'); return { kind, id, title: titles[kind] }; } });
  assert.deepEqual(calls, ['note:n-1', 'task:t_1', 'project:p1']);
  assert.match(html, /data-open-note="n-1" aria-label="打开笔记：第一讲 · 观察">第一讲 · 观察<\/button>/);
  assert.match(html, /<strong><button[^>]+data-open-task="t_1"[^>]*>补记候车时间<\/button><\/strong>/);
  assert.match(html, /data-open-project="p1"[^>]*>交互设计方法<\/button>/);
  assert.equal(render(raw).includes('data-open-'), false, 'A document without workspace context retains literal references');
  assert.ok(raw.includes('[note:n-1]'), 'Rendering never changes the saved Markdown');
});

test('bare reference parsing respects code, links, escapes, entities and authored token positions', () => {
  const calls = [], resolveReference = target => { calls.push(target); const [kind,id] = target.split(':'); return { kind,id,title:'Resolved' }; };
  const raw = '\\[note:n] [note:n] &#91;note:n] [note:n]\n\n`[task:t]`\n\n```md\n[project:p]\n```\n\n[caption [note:n]](https://example.org)\n\n[label](note:n)\n\n[[note:n]]\n\n<div>[note:n]</div>';
  const html = render(raw, { resolveReference });
  assert.deepEqual(calls, ['note:n', 'note:n']);
  assert.equal(count(html, /document-record-link/g), 2);
  assert.match(html, /<code>\[task:t\]<\/code>/);
  assert.match(html, /caption \[note:n\]<\/a>/);
  assert.match(html, /&lt;div&gt;\[note:n\]&lt;\/div&gt;/);
  assert.equal(count(render('&amp; [note:n] \\\\[note:n]', { resolveReference }), /document-record-link/g), 2, 'Unrelated entities and escaped backslashes do not disable real references');
});

test('bare references fail closed without leaking a retired label or creating unsafe attributes', () => {
  const raw = '[note:n] [task:t] [project:p]';
  const data = renderWithMetadata(raw, { resolveReference: () => null });
  assert.deepEqual(data.warnings, ['unavailable-reference']);
  assert.ok(!data.html.includes('<button'));
  assert.match(data.html, /笔记不可用/); assert.match(data.html, /任务不可用/); assert.match(data.html, /项目不可用/);
  for (const resolved of [{ kind:'script', id:'n', title:'unsafe' }, { kind:'note', id:'different', title:'unsafe' }, { kind:'note', id:'n', title: { html:'unsafe' } }]) {
    const html = render('[note:n]', { resolveReference: () => resolved });
    assert.ok(!html.includes('unsafe')); assert.ok(!html.includes('<button'));
  }
  const html = render('[note:n]', { resolveReference: () => ({ kind:'note', id:'n', title:'<img src=x onerror="bad"> & title' }) });
  assert.ok(!html.includes('<img')); assert.match(html, /&lt;img src=x onerror=&quot;bad&quot;&gt; &amp; title/);
  assert.ok(!render('[note:n"onclick=x] [task:../x] [project:javascript:bad]', { resolveReference: () => { throw Error('Malformed references must not resolve'); } }).includes('document-record-link'));
  assert.ok(!renderWithMetadata('[note:n]', { resolveReference: () => { throw Error('gone'); } }).html.includes('<button'));
});

test('cached Markdown resolves references again when records are renamed or become inaccessible', () => {
  const raw = '[note:n]', record = { title:'Original title', available:true };
  const options = { resolveReference: () => record.available ? { kind:'note',id:'n',title:record.title } : null };
  assert.match(render(raw,options), /Original title/);
  record.title='Renamed title'; assert.match(render(raw,options), /Renamed title/);
  record.available=false;
  const html=render(raw,options); assert.ok(!html.includes('title')); assert.ok(!html.includes('data-open-note')); assert.match(html,/笔记不可用/);
});

test('GFM tables align headers and preserve formatting, pipe code, strikethrough and autolinks', () => {
  const html = render('| Left | Center | Right |\n| :--- | :----: | ----: |\n| **strong** | `a\\|b` | ~~gone~~ |\n\nhttps://example.org');
  assert.match(html, /<div class="markdown-table-scroll"><table><thead><tr><th scope="col" style="text-align:left">Left/);
  assert.match(html, /<th scope="col" style="text-align:center">Center/);
  assert.match(html, /<td style="text-align:right"><del>gone<\/del>/);
  assert.match(html, /<code>a\|b<\/code>/);
  assert.match(html, /href="https:\/\/example.org"/);
});

test('code blocks expose real copy targets with language metadata only for the host header', () => {
  const html = render('```js filename=x\nconst x = "<script> & value";\n```');
  assert.match(html, /<pre class="[^"]*document-code" data-document-code>/);
  assert.match(html, /<code data-language="js" class="language-js">const x = &quot;&lt;script&gt; &amp; value&quot;;<\/code>/);
  assert.ok(!html.includes('message-code-lang'));
  assert.ok(!html.includes('filename=x'));
  const calls = [];
  assert.match(render('```js\nx\n```', { highlight: (...args) => { calls.push(args); return '<span>x</span>'; } }), /<code[^>]*><span>x<\/span><\/code>/);
  assert.deepEqual(calls, [['x', 'js']]);
  assert.match(render('```<script>\nx\n```'), /<code>x<\/code>/);
});

test('default KaTeX renders matrices and MathML offline, without enabling unsafe macros', () => {
  const html = render('Inline $x^2$\n\n$$\n\\begin{bmatrix}a & b \\\\ c & d\\end{bmatrix}\n$$');
  assert.match(html, /class="katex"/);
  assert.match(html, /class="katex-display"/);
  assert.match(html, /<mtable/);
  assert.match(html, /encoding="application\/x-tex"/);
  for (const tex of ['\\href{javascript:alert(1)}{click}', '\\url{https://tracker.invalid}', '\\includegraphics{https://tracker.invalid/a.png}', '\\htmlStyle{background:url(https://tracker.invalid)}{x}']) {
    const unsafe = render(`$${tex}$`);
    assert.ok(!/<(?:a|img)\b/i.test(unsafe), tex);
    assert.ok(!/style="[^"]*url\(/i.test(unsafe), tex);
  }
  assert.match(render('$\\def\\loop{\\loop}\\loop$'), /katex-error/);
});

test('trusted math hooks receive exact TeX, null falls back visibly, and thrown callbacks are reported', () => {
  const calls = [];
  const html = render('$x_1$\n\n$$\n\\alpha\n$$', { inlineMath: tex => { calls.push(['inline', tex]); return '<i>math</i>'; }, blockMath: tex => { calls.push(['block', tex]); return null; } });
  assert.deepEqual(calls, [['inline', 'x_1'], ['block', '\\alpha']]);
  assert.match(html, /<i>math<\/i>/);
  assert.match(html, /<pre class="document-math-source">\\alpha<\/pre>/);
  const data = renderWithMetadata('[x](note:x) ![y](foo) $x$', { resolveLink() { throw Error('no'); }, resolveImage() { throw Error('no'); }, inlineMath() { throw Error('no'); } });
  assert.ok(data.warnings.includes('resolver-failed'));
  assert.ok(data.warnings.includes('renderer-callback-failed'));
});

test('footnotes number by first use, render once, backlink every reference and avoid heading ID collisions', () => {
  const data = renderWithMetadata('# fn-1\n\nFirst[^b], twice[^b] and next[^a].\n\n[^a]: A **bold**.\n[^b]: B with nested[^a].\n[^unused]: Invisible.', { idPrefix: 'scope' });
  assert.equal(count(data.html, /class="document-footnote-reference"/g), 4);
  assert.equal(count(data.html, /<li id="dm-scope-fn-/g), 2);
  assert.match(data.html, /<li id="dm-scope-fn-1"><p>B with nested/);
  assert.ok(!data.html.includes('Invisible'));
  assert.equal(count(data.html, /aria-label="返回脚注 /g), 4);
  const ids = [...data.html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const match of data.html.matchAll(/data-document-anchor="([^"]+)"/g)) assert.ok(ids.includes(match[1]));
  assert.match(render('self[^s]\n\n[^s]: self[^s]'), /document-footnotes/);
});

test('cached AST does not retain resolver scope or expose mutable metadata, and headings never render', () => {
  const raw = '# Title\n\n[[Page]] ![image](/__files/img) $\\alpha$';
  const first = renderWithMetadata(raw, { idPrefix: 'owner-a', resolveImage: url => url, resolveLink: () => ({ kind: 'note', id: 'allowed' }) });
  first.headings[0].text = 'mutated'; first.images.length = 0;
  const second = renderWithMetadata(raw, { idPrefix: 'owner-b', resolveImage: () => null, resolveLink: () => null });
  assert.ok(first.html.includes('<img '));
  assert.ok(!second.html.includes('<img '));
  assert.ok(!second.html.includes('data-open-note'));
  assert.equal(second.headings[0].text, 'Title');
  assert.ok(second.headings[0].id.startsWith('dm-owner-b-'));
  const options = { idPrefix: 'outline', inlineMath() { throw Error('must not render'); }, resolveImage() { throw Error('must not resolve'); } };
  assert.equal(headings(raw, options)[0].text, 'Title');
  assert.equal(headings('other').length, 0);
  assert.equal(headings(raw)[0].text, 'Title');
});

test('browser production bundle has the same offline renderer semantics', async () => {
  const { characterEntities } = await import('character-entities');
  let nodes = 0;
  const context = vm.createContext({ window: {}, URL, console, document: { compatMode: 'CSS1Compat',
    createElement(tag) {
      assert.equal(tag, 'i'); nodes++;
      return { textContent: '', set innerHTML(value) { this.textContent = characterEntities[value.slice(1, -1)] || value; } };
    },
  } });
  vm.runInContext(fs.readFileSync(path.join(root, 'app/document-markdown-bundle.js'), 'utf8'), context, { timeout: 5000 });
  const api = context.window.DocumentMarkdown;
  assert.equal(typeof api.render, 'function');
  assert.equal(typeof api.renderWithMetadata, 'function');
  assert.equal(typeof api.headings, 'function');
  assert.equal(Object.isFrozen(api), true);
  const raw = '# A &amp; B ##\n\n- [x] ready\n\n[ref][r] ![photo](/__files/asset)\n\n[note:n]\n\n[r]: https://example.org\n\n$$\n\\begin{matrix}1 & 2\\end{matrix}\n$$';
  const options = { idPrefix: 'actual', resolveImage: url => url, resolveReference: () => ({kind:'note',id:'n',title:'Actual source'}) };
  assert.equal(api.render(raw, options), render(raw, options));
  assert.equal(nodes, 1, 'only upstream named entity decoding uses the DOM');
});

test('generated bundle provenance pins parser and math inputs and all runtime fonts are inline', () => {
  const proof = JSON.parse(fs.readFileSync(path.join(root, 'app/editor/document-markdown-provenance.json'), 'utf8'));
  assert.deepEqual(Object.fromEntries(proof.sources.map(x => [x.name, x.version])), { unified: '11.0.5', 'remark-parse': '11.0.0', 'remark-gfm': '4.0.1', 'remark-math': '6.0.0', katex: '0.18.9' });
  for (const asset of proof.assets) {
    const bytes = fs.readFileSync(path.join(root, 'app', asset.name));
    assert.equal(bytes.length, asset.bytes); assert.equal(sha256(bytes), asset.sha256);
  }
  for (const input of proof.inputs) assert.equal(sha256(fs.readFileSync(path.join(root, input.name))), input.sha256, input.name);
  const css = fs.readFileSync(path.join(root, 'app/document-markdown.css'), 'utf8');
  const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map(x => x[1]);
  assert.equal(urls.length, 20, 'all 20 KaTeX faces ship once as WOFF2');
  assert.equal(proof.runtime.fontFaces, 20);
  assert.ok(urls.every(url => /^['"]?data:/.test(url)));
  const notices = fs.readFileSync(path.join(root, 'docs/licenses/DOCUMENT-MARKDOWN.txt'), 'utf8');
  for (const pkg of proof.packages) assert.ok(notices.includes(`${pkg.name}@${pkg.version}`));
  assert.match(notices, /Copyright/);
  assert.equal(proof.runtime.math.trust, false);
});

test('durable document citations render owned accessible buttons, not workspace-relative anchors', () => {
  const context = { noteId: 'note-"owned', variant: 'body' }, href = '#aibro-source-request-s1';
  const options = { documentSource: context, resolveDocumentSource: url => url === href ? { type: 'import', title: 'PDF "A" <source>', page: 16 } : null };
  const html = render(`[1](${href})`, options);
  assert.match(html, /<button type="button" class="citation-chip document-source-link"/);
  assert.match(html, /data-document-source-note="note-&quot;owned" data-document-source-variant="body"/);
  assert.match(html, /aria-label="查看来源 1：PDF &quot;A&quot; &lt;source&gt;，第 16 页"/);
  assert.ok(html.includes('>1</button>')); assert.ok(!html.includes('<a '));
  globalThis.WorkstationI18n = { getLanguage: () => 'en' };
  try { assert.match(render(`[1](${href})`, options), /aria-label="Open source 1: PDF &quot;A&quot; &lt;source&gt;, page 16"/); }
  finally { delete globalThis.WorkstationI18n; }
});

test('missing document citation authority is inert, exposes no old title and never falls through to another resolver', () => {
  for (const options of [ {}, { documentSource: { noteId: 'n', variant: 'body' } }, { documentSource: { noteId: 'n', variant: 'wrong' }, resolveDocumentSource: () => ({ type: 'import', title: 'hidden title' }) },
    { documentSource: { noteId: 'n', variant: 'body' }, resolveDocumentSource: () => null } ]) {
    const data = renderWithMetadata('[1](#aibro-source-missing)', { ...options, resolveLink() { throw Error('must not guess'); }, resolveDocumentLink() { throw Error('must not guess'); } });
    assert.deepEqual(data.warnings, ['unavailable-citation']); assert.ok(!data.html.includes('button')); assert.ok(!data.html.includes('<a ')); assert.ok(!data.html.includes('hidden title'));
  }
  const rendered = render('`[1](#aibro-source-example)`\n\n```md\n[1](#aibro-source-example)\n```', { documentSource: { noteId: 'n', variant: 'body' }, resolveDocumentSource() { throw Error('code is literal'); } });
  assert.ok(!rendered.includes('document-source-link'));
});

test('standard source links remain supported by the visual editor policy while raw agent markers do not', async () => {
  const { unified } = await import('unified'), { default: parse } = await import('remark-parse');
  const { diagnoseMarkdown } = await import('../app/editor/visual-policy.mjs');
  const parser = unified().use(parse);
  assert.equal(diagnoseMarkdown(parser.parse('结论 [1](#aibro-source-request-s1)')).supported, true);
  assert.equal(diagnoseMarkdown(parser.parse('结论 [[cite:request-s1]]')).supported, false);
});
