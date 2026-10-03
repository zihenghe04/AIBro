const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const start = source.indexOf('function renderRichText(');
const end = source.indexOf('\nfunction renderMessage(', start);
assert.ok(start >= 0 && end > start, 'conversation renderer remains available');
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const render = vm.runInNewContext(`(${source.slice(start, end)})`, { esc, URL });
const renderNote = vm.runInNewContext(`(${source.slice(start, end)})`, { esc, URL, window: {}, state: {} });

test('document reading preserves visual editor empty paragraphs without rendering arbitrary HTML', () => {
  assert.equal(renderNote('<br />\n\n#\n\n## Title', 'note-1'), '<p><br></p><h1></h1><h2>Title</h2>');
  assert.equal(renderNote('before<br>after', {resolveImageUrl() { return null; }}), '<p>before<br>after</p>');
  for (const input of ['`<br />`', '<br onclick="alert(1)">', '<br class=x>', '<script>alert(1)</script>']) {
    assert.doesNotMatch(renderNote(input, 'note-1'), /<(?:br|script)\b/);
  }
  assert.equal(render('<br />'), '<p>&lt;br /&gt;</p>');
});

test('conversation Markdown renders headings, emphasis and inline code', () => {
  const html = render('# 项目计划\n**材料清单**、*时间节点*，以及 `model_name`。\n\n## 下一步\n普通文本');
  assert.match(html, /^<h1>项目计划<\/h1>/);
  assert.match(html, /<strong>材料清单<\/strong>、<em>时间节点<\/em>/);
  assert.match(html, /<code>model_name<\/code>/);
  assert.match(html, /<h2>下一步<\/h2><p>普通文本<\/p>/);
  assert.equal(render('model_name_test 和 **粗体**'), '<p>model_name_test 和 <strong>粗体</strong></p>');
  assert.equal(render('***重点***'), '<p><strong><em>重点</em></strong></p>');
  assert.equal(render('# C#\n## 标题 ##'), '<h1>C#</h1><h2>标题</h2>');
});

test('bullets and ordered items remain separate semantic lists', () => {
  const html = render('准备：\n- **护照**\n- 预约确认单\n\n3. 确认日期\n4. 核对资料\n\n完成后继续对话。');
  assert.equal(html, '<p>准备：</p><ul><li><strong>护照</strong></li><li>预约确认单</li></ul><ol start="3"><li>确认日期</li><li>核对资料</li></ol><p>完成后继续对话。</p>');
});

test('fenced code keeps blank lines, escapes HTML and ignores Markdown tokens', () => {
  const html = render('说明\n\n```html\n<div>**literal**</div>\n\n[no link](https://example.com)\n```\n\n之后');
  assert.equal(html, '<p>说明</p><pre class="message-code"><span class="message-code-lang">html</span><code data-language="html">&lt;div&gt;**literal**&lt;/div&gt;\n\n[no link](https://example.com)</code></pre><p>之后</p>');
  assert.equal(render('````txt\n```\n\nend\n````'), '<pre class="message-code"><span class="message-code-lang">txt</span><code data-language="txt">```\n\nend</code></pre>');
  assert.equal(render('```js\nconst x = "<safe>";\n'), '<pre class="message-code"><span class="message-code-lang">js</span><code data-language="js">const x = &quot;&lt;safe&gt;&quot;;\n</code></pre>');
  assert.equal(render('~~~js\n1 + 1\n~~~'), '<pre class="message-code"><span class="message-code-lang">js</span><code data-language="js">1 + 1</code></pre>');
  // 没有语言标注的围栏：不产生语言标签（也不产生空标签）
  assert.equal(render('```\nplain\n```'), '<pre class="message-code"><code>plain</code></pre>');
});

test('inline code is escaped and never becomes a link or emphasis', () => {
  assert.equal(render('`<script>alert(1)</script> **raw**`'), '<p><code>&lt;script&gt;alert(1)&lt;/script&gt; **raw**</code></p>');
  assert.equal(render('``use `backticks` here``'), '<p><code>use `backticks` here</code></p>');
  assert.equal(render('\\*literal\\*'), '<p>*literal*</p>');
});

test('only complete HTTP or HTTPS links become clickable', () => {
  const html = render('[**参考**](https://example.com/paper_(v2)?a=1&b=2) [本地说明](http://localhost:8765/)');
  assert.match(html, /href="https:\/\/example.com\/paper_\(v2\)\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer"><strong>参考<\/strong><\/a>/);
  assert.match(html, /href="http:\/\/localhost:8765\/"/);
  for (const input of ['[执行](javascript:alert(1))', '[打开](data:text/html,<script>alert(1)</script>)', '[编码](&#106;avascript:alert(1))', '[跳转](//example.com)', '[不完整](https://example.com']) {
    assert.equal(render(input), `<p>${esc(input)}</p>`);
    assert.doesNotMatch(render(input), /<a\b/);
  }
});

test('hostile source cannot inject HTML, attributes or scripts', () => {
  const html = render('<img src=x onerror=alert(1)>\n**<script>alert(1)</script>**\n\n```js" onmouseover="alert(1)\n<script>alert(2)</script>\n```');
  assert.doesNotMatch(html, /<(?:script|img)\b/i);
  assert.doesNotMatch(html, /<code[^>]*onmouseover=/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /<strong>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/strong>/);
  const attribute = render('[safe](https://example.com/"onmouseover="alert(1))');
  assert.match(attribute, /%22onmouseover=%22/);
  assert.doesNotMatch(attribute, /"onmouseover="/);
  assert.equal(render(null), '');
});

test('document tables and source blockquotes render safely without losing code pipes',()=>{
 const html=render('Intro\n> 来源：**课程讲义** 第 2 页\n\n| 方法 | 结果 |\n| --- | ---: |\n| `a|b` | <img src=x onerror=1> |');
 assert.match(html,/<blockquote><p>来源：<strong>课程讲义<\/strong> 第 2 页/);
 assert.match(html,/<table>/);assert.match(html,/<code>a\|b<\/code>/);assert.match(html,/text-align:right/);assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;img/);
 assert.match(render('```\n> literal\n| x | y |\n| --- | --- |\n```'),/<code>&gt; literal/);
});

test('note reading accepts the visual editor serializer short GFM table delimiters', () => {
  const markdown = '| 项目 | 状态 | |\n| ---- | --------- | :- |\n| 表格单元 | | a |';
  const html = renderNote(markdown, 'note-1');
  assert.equal(html, '<div class="markdown-table-scroll"><table><thead><tr><th style="text-align:left">项目</th><th style="text-align:left">状态</th><th style="text-align:left"></th></tr></thead><tbody><tr><td style="text-align:left">表格单元</td><td style="text-align:left"></td><td style="text-align:left">a</td></tr></tbody></table></div>');
  const aligned = renderNote('| Left | Center | Right | Plain |\r\n| :- | :-: | -: | - |\r\n| **L** | C | R | |', 'note-1');
  assert.match(aligned, /<th style="text-align:center">Center<\/th>/);
  assert.match(aligned, /<th style="text-align:right">Right<\/th>/);
  assert.match(aligned, /<td style="text-align:left"><strong>L<\/strong><\/td>/);
  for (const delimiter of ['| : | - |', '| --x | - |', '| - - | - |', '| - |', '| - | - | - |']) {
    assert.doesNotMatch(renderNote(`| A | B |\n${delimiter}\n| value | value |`, 'note-1'), /<table>/, delimiter);
  }
});

test('note task lists expose labeled disabled checked states without introducing write actions', () => {
  const html = renderNote('- [ ] **待办**\n* [x] 已完成\n+ [X] 完成\n- 普通事项\n\n3. [x] 编号任务', 'note-1');
  assert.equal((html.match(/type="checkbox" disabled/g) || []).length, 4);
  assert.equal((html.match(/type="checkbox" disabled checked/g) || []).length, 3);
  assert.match(html, /<label><input type="checkbox" disabled> <strong>待办<\/strong><\/label>/);
  assert.match(html, /<li>普通事项<\/li>/);
  assert.match(html, /<ol start="3"><li class="markdown-task-item">/);
  assert.doesNotMatch(html, /onclick|onchange|data-(?:action|task-id)|tabindex=/);
  assert.match(renderNote('- [x]', 'note-1'), /disabled checked aria-label="已完成"/);
  assert.match(renderNote('- [ ]', 'note-1'), /disabled aria-label="未完成"/);
  assert.match(renderNote('- [x]\n  下一行正文', 'note-1'), /disabled checked> 下一行正文<\/label>/);
});

test('new table and task rendering still escapes hostile HTML and keeps literal markers literal', () => {
  const html = renderNote('| <img src=x onerror=1> | Safe |\n| :- | -: |\n| <script>alert(1)</script> | `a|b` |\n\n- [x] <svg onload=alert(1)>\n- [ ] [run](javascript:alert(1))', 'note-1');
  assert.doesNotMatch(html, /<(?:img|svg|script)\b|<a\b/);
  assert.match(html, /&lt;img src=x onerror=1&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;svg onload=alert\(1\)&gt;/);
  assert.match(html, /<code>a\|b<\/code>/);
  for (const markdown of ['- [z] ordinary', '- [x]no-space', '- \\[x] escaped', '- `[x]` inline', 'paragraph [x] ordinary', '```md\n- [x] code\n```']) {
    assert.doesNotMatch(renderNote(markdown, 'note-1'), /type="checkbox"/, markdown);
  }
});

test('list indentation produces actual nested ownership while ordered starts and siblings stay intact',()=>{
 const markdown='- Course\n  - Read the paper\n    3. Compare methods\n    4. Save evidence\n  - Write a note\n- Research\n\n7. First step\n   - Supporting point\n8. Next step';
 assert.equal(render(markdown),'<ul><li>Course<ul><li>Read the paper<ol start="3"><li>Compare methods</li><li>Save evidence</li></ol></li><li>Write a note</li></ul></li><li>Research</li></ul><ol start="7"><li>First step<ul><li>Supporting point</li></ul></li><li>Next step</li></ol>');
});

test('read-only checklists retain citations and nested blocks without putting a list inside a label',()=>{
 const html=render('- [ ] Read **source** [[cite:ev1]]\n  continuation\n  - nested source\n- [x] Already done\n\n3. [ ] Ordered check\n4. Regular item');
 assert.match(html,/<label><input type="checkbox" disabled> Read <strong>source<\/strong> \[\[cite:ev1\]\]<br>continuation<\/label><ul><li>nested source/);
 assert.match(html,/<ol start="3"><li class="markdown-task-item">/);
 assert.match(html,/<li>Regular item<\/li>/);
 assert.equal((html.match(/type="checkbox" disabled/g)||[]).length,3);
 assert.doesNotMatch(html,/<label>(?:(?!<\/label>)[\s\S])*<(?:ul|ol|blockquote|pre)>|onchange|contenteditable|data-task-id/);
});

test('folded source quotes keep paragraphs, nested lists, nested quotes and code boundaries',()=>{
 const html=render('> A long **source**\n> wraps without a new paragraph.\n>\n> The next paragraph [[cite:ev2]].\n> - first\n> - second\n>\n> > nested source\n\nOutside');
 assert.equal(html,'<blockquote><p>A long <strong>source</strong><br>wraps without a new paragraph.</p><p>The next paragraph [[cite:ev2]].</p><ul><li>first</li><li>second</li></ul><blockquote><p>nested source</p></blockquote></blockquote><p>Outside</p>');
 const code=render('- Example\n  ```js\n  const n = 1;\n\n  // - [x] literal\n  ```\n- Next');
 assert.match(code,/<li>Example<pre class="message-code">/);assert.match(code,/const n = 1;\n\n\/\/ - \[x\] literal/);
 assert.doesNotMatch(code,/type="checkbox"/);assert.match(code,/<\/pre><\/li><li>Next<\/li>/);
});

test('deep block input remains bounded and hostile nested content stays escaped',()=>{
 const deep='> '.repeat(80)+'<script>alert(1)</script>';
 const html=render(deep);assert.doesNotMatch(html,/<script/);assert.match(html,/&lt;script&gt;/);
 assert.ok((html.match(/<blockquote>/g)||[]).length<=25);assert.match(html,/&gt; &gt;/);
 assert.doesNotMatch(render('- Parent\n  - <img src=x onerror=1>\n  > [run](javascript:alert(1))'),/<img|<a\b/);
});


test('checklist first-line block-looking text remains inline under its saved checkbox',()=>{
 for(const text of ['# A title','- A dash','> A quote']){
  const html=render('- [ ] '+text+'\n  - actual child');
  assert.match(html,/<label><input type="checkbox" disabled>/);
  assert.doesNotMatch(html,/<h1>|<blockquote>/);
  assert.match(html,/<\/label><ul><li>actual child<\/li><\/ul>/);
  assert.equal((html.match(/<ul>/g)||[]).length,2);
 }
});
