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
  assert.equal(html, '<p>说明</p><pre class="message-code"><code data-language="html">&lt;div&gt;**literal**&lt;/div&gt;\n\n[no link](https://example.com)</code></pre><p>之后</p>');
  assert.equal(render('````txt\n```\n\nend\n````'), '<pre class="message-code"><code data-language="txt">```\n\nend</code></pre>');
  assert.equal(render('```js\nconst x = "<safe>";\n'), '<pre class="message-code"><code data-language="js">const x = &quot;&lt;safe&gt;&quot;;\n</code></pre>');
  assert.equal(render('~~~js\n1 + 1\n~~~'), '<pre class="message-code"><code data-language="js">1 + 1</code></pre>');
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
