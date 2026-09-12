const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const dictionary = require('../i18n-en');
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function translate(value) {
  if (Object.hasOwn(dictionary.exact, value)) return dictionary.exact[value];
  for (const rule of dictionary.patterns) { const pattern = new RegExp(rule.source); if (pattern.test(value)) return value.replace(pattern, rule.replacement); }
  return value;
}
function deferred() { let resolve; const promise = new Promise(r => resolve = r); return {promise, resolve}; }
function pdfHarness(fetcher = async () => ({ok:true,json:async()=>({pageCount:3})})) {
  const nodes = new Map(), calls = [];
  const node = key => {
    if (!nodes.has(key)) nodes.set(key, {style:{},textContent:'',value:'',children:[],hidden:false,disabled:false,
      querySelector(selector) { return selector === 'img' ? this.children.find(n => n.tagName === 'img') : null; },
      replaceChildren(...children) { this.children = children; }, appendChild(child) { this.children.push(child); },
      dispatchEvent(event) { this['on'+event.type]?.({target:this,...event}); }});
    return nodes.get(key);
  };
  const container = {innerHTML:'',querySelector:node};
  const context = vm.createContext({fetch:fetcher,AbortController,Event,esc,uiIcon:()=>'',toast:message=>calls.push(['toast',message]),
    window:{ReadingPane:{setPage:(...args)=>calls.push(['page',...args])}},
    document:{createElement:tagName=>({tagName,style:{},remove(){this.removed=true;}})}});
  vm.runInContext(source.slice(source.indexOf('let pdfPreviewVersion ='),source.indexOf('let previewRequestVersion =')), context);
  return {context,container,node,calls,mount:(item={id:'pdf',name:'资料库.pdf'},page=1)=>context.mountPdfPreview(container,item,null,page)};
}
test('PDF loading and changing-page status are declared UI; actual navigation and original identity are retained', async () => {
  const pending=deferred(), h=pdfHarness(()=>pending.promise), item={id:'pdf-safe',name:'资料库.pdf'}, before=JSON.stringify(item);
  const work=h.mount(item,2);
  assert.match(h.container.innerHTML, /class="pdf-loading"[^>]*data-i18n>正在准备 PDF 预览…/);
  assert.notEqual(translate('正在准备 PDF 预览…'),'正在准备 PDF 预览…');
  pending.resolve({ok:true,json:async()=>({pageCount:3})});await work;
  assert.match(h.container.innerHTML,/class="pdf-page-status"[^>]*data-i18n/);
  assert.equal(h.node('.pdf-page-status').textContent,'正在渲染第 2 页…');
  assert.equal(translate(h.node('.pdf-page-status').textContent),'Rendering page 2…');
  const image=h.node('.pdf-sheet').children[0];assert.equal(image.src,'/__files/pdf-safe/preview?page=2&scale=1.5');assert.ok(image.alt.startsWith(item.name));
  h.node('[data-pdf-next]').onclick();assert.equal(h.node('[data-pdf-page]').value,'3');assert.equal(h.node('[data-pdf-next]').disabled,true);
  assert.equal(h.node('.pdf-page-status').textContent,'正在渲染第 3 页…');
  h.node('.pdf-sheet').children[0].onerror();assert.notEqual(translate(h.node('.pdf-page-status').textContent),h.node('.pdf-page-status').textContent);
  assert.equal(JSON.stringify(item),before);
});
test('PDF failures keep the download guidance translatable and protect escaped server error content',async()=>{
  const serverText='<img src=x onerror=alert(1)>资料库';
  const h=pdfHarness(async()=>({ok:false,json:async()=>({error:serverText})}));await h.mount();
  assert.match(h.container.innerHTML,/<span data-user-content>&lt;img src=x onerror=alert\(1\)&gt;资料库<\/span>/);
  assert.match(h.container.innerHTML,/<span data-i18n>原文件仍可下载查看。<\/span>/);assert.doesNotMatch(h.container.innerHTML,/<img/);
  const invalid=pdfHarness(async()=>({ok:true,json:async()=>({pageCount:0})}));await invalid.mount();assert.match(invalid.container.innerHTML,/<span data-i18n>PDF 没有可显示的页面<\/span>/);
});
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
