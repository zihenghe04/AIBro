const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/app.js'), 'utf8');
const dictionary = require('../app/i18n-en');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function translate(value) {
  if (Object.hasOwn(dictionary.exact, value)) return dictionary.exact[value];
  for (const rule of dictionary.patterns) { const pattern = new RegExp(rule.source); if (pattern.test(value)) return value.replace(pattern, rule.replacement); }
  return value;
}
// PDF controller navigation, retries and language behavior are exercised through
// the actual PDFReader module in pdf-reader.test.js.
test('analysis details and CTA are declared interface text without changing attachment IDs',()=>{
  for (const analysis of [
    {status:'pending',detail:'尚无可用的分析笔记或论文记录；文字索引、改名和归档不代表已分析。'},
    {status:'pending',detail:'已关联 2 个任务；尚无可用的分析笔记或论文记录。'},
    {status:'analyzed',detail:'已关联 1 篇分析笔记；可打开核对与补充。'},
    {status:'analyzed',detail:'已关联 2 篇论文分析；可打开核对与补充。'},
    {status:'analyzed',detail:'已关联 2 篇分析笔记、 3 篇论文分析；可打开核对与补充。'}
  ]) {
    const box={}, item={id:'source-id',name:'关联资料',content:'资料库'};
    const context=vm.createContext({$:()=>box,esc,analysisBadge:()=>'',importAnalysis:()=>analysis});
    vm.runInContext(source.slice(source.indexOf('function renderPreviewAnalysis('),source.indexOf('// Stage a focused analysis request')),context);
    context.renderPreviewAnalysis(item);
    assert.match(box.innerHTML,/<span data-i18n>/);assert.match(box.innerHTML,/data-analyze-import="source-id"/);
    assert.notEqual(translate(analysis.detail),analysis.detail);
    assert.deepEqual(item,{id:'source-id',name:'关联资料',content:'资料库'});
  }
});
test('reader counts, pending banner and relationship headings have narrow dictionary coverage',()=>{
  for(const label of ['资料库','知识库','关联资料','所属项目','原始来源','分析笔记','3 份资料待 AI 分析','1 个来源','2 个来源','1 篇笔记','3 篇笔记','2 个来源不可用','2 个来源已删除或不可用；恢复原件后可继续查看。','第 2 页','原件已保存；生成分析笔记后才会进入知识关联。']) assert.notEqual(translate(label),label,label);
  for(const userText of ['我的资料库','课程：3 份资料待 AI 分析','第 2 页是我的标题','关联资料 · 用户原文'])assert.equal(translate(userText),userText);
});

test('bookmark reader explains the missing body and never exposes an enabled analysis action', () => {
  const Analysis = require('../app/attachment-analysis'), item = { id: 'bookmark', parser: 'bookmark', url: 'https://example.org/source', content: '', fileStored: false, pages: [] }, box = {};
  const analysis = Analysis.derive({ imports: [item] }, item);
  const context = vm.createContext({ $: () => box, esc, analysisBadge: () => '', importAnalysis: () => analysis });
  vm.runInContext(source.slice(source.indexOf('function renderPreviewAnalysis('), source.indexOf('// Stage a focused analysis request')), context);
  context.renderPreviewAnalysis(item);
  assert.match(box.innerHTML, /尚未下载网页/); assert.match(box.innerHTML, /disabled>需先导入网页内容/); assert.doesNotMatch(box.innerHTML, /data-analyze-import=/);
  for (const label of [analysis.label, analysis.detail, '链接收藏', '需先导入网页内容', '网址已收藏，网页内容尚未下载。', '打开原网页', '原网页地址无效，请在链接库中核对。']) assert.notEqual(translate(label), label, label);
});
