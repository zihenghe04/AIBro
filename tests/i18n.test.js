const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/i18n'), 'utf8');
function harness(saved, shared, dictionary) {
  class Element {
    constructor(tag='div', attrs={}) { this.nodeType=1;this.tagName=tag;this.attributes={...attrs};this.childNodes=[];this.listeners={};this.value=''; }
    get parentElement(){return this.parent;}
    append(...nodes){for(let node of nodes){if(typeof node==='string')node={nodeType:3,nodeValue:node};node.parent=this;Object.defineProperty(node,'parentElement',{get:()=>node.parent,configurable:true});this.childNodes.push(node);}}
    get textContent(){return this.childNodes.map(n=>n.nodeType===3?n.nodeValue:n.textContent).join('');}
    set textContent(value){this.childNodes=[];this.append(String(value));}
    hasAttribute(k){return Object.hasOwn(this.attributes,k);} getAttribute(k){return this.attributes[k]??null;} setAttribute(k,v){this.attributes[k]=String(v);}
    matches(selectors){return selectors.split(',').some(part=>{
      const s=part.trim();if(!s||/[> :]/.test(s))return false;
      if(s[0]==='#')return this.attributes.id===s.slice(1);
      if(s[0]==='.')return (this.attributes.class||'').split(' ').includes(s.slice(1));
      const m=s.match(/^([\w-]+)?\[([\w-]+)(?:="([^"]*)")?\]$/);if(m)return(!m[1]||this.tagName===m[1])&&this.hasAttribute(m[2])&&(m[3]===undefined||this.getAttribute(m[2])===m[3]);
      return this.tagName===s;
    });}
    closest(selector){for(let n=this;n;n=n.parent)if(n.matches(selector))return n;return null;}
    descendants(){return this.childNodes.filter(n=>n.nodeType===1).flatMap(n=>[n,...n.descendants()]);}
    querySelectorAll(selector){return this.descendants().filter(n=>n.matches(selector));}
    addEventListener(name,fn){(this.listeners[name]||=[]).push(fn);}
    dispatchEvent(event){for(const fn of this.listeners[event.type]||[])fn(event);}
  }
  const document=new Element('document');document.documentElement=new Element('html');document.body=new Element('body');document.append(document.documentElement);document.documentElement.append(document.body);
  document.getElementById=id=>document.descendants().find(n=>n.getAttribute('id')===id);
  const add=(tag,attrs,text,parent=document.body)=>{const n=new Element(tag,attrs);if(text!==undefined)n.textContent=text;parent.append(n);return n;};
  const storage=shared||new Map(saved?[['ai-bro-language',saved]]:[]),native=[],microtasks=[];let mutation;
  const context=vm.createContext({document,localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},WorkstationEnglish:{exact:{'设置':'Settings','日常':'Personal','保存':'Save','取消':'Cancel','搜索名称':'Search names','任务':'Task','保存任务':'Save task'},patterns:[{source:'^(\\d+) 项$',replacement:'$1 items'}]},workstationDesktop:{setLanguage:value=>{native.push(value);return Promise.resolve();}},CustomEvent:class{constructor(type,init){this.type=type;Object.assign(this,init);}},MutationObserver:class{constructor(callback){mutation=callback;}observe(){}},queueMicrotask:fn=>microtasks.push(fn)});
  vm.runInContext(source,context);
  const api=context.WorkstationI18n;
  if (dictionary) context.WorkstationEnglish=dictionary;
  return{api,add,document,storage,native,init:()=>api.init(),mutate:records=>mutation(records),flush:()=>{while(microtasks.length)microtasks.shift()();},microtasks};
}
test('actual select change switches UI immediately, persists only a local preference, and calls native language',()=>{
  const h=harness(),nav=h.add('span',{'data-i18n':''},'设置'),select=h.add('select',{id:'interfaceLanguage'});
  h.init();assert.equal(nav.textContent,'设置');assert.equal(select.value,'zh-CN');
  select.value='en';select.dispatchEvent({type:'change',target:select});
  assert.equal(nav.textContent,'Settings');assert.equal(h.document.documentElement.lang,'en');assert.equal(h.storage.get('ai-bro-language'),'en');assert.deepEqual(h.native,['zh-CN','en']);
  select.value='zh-CN';select.dispatchEvent({type:'change',target:select});assert.equal(nav.textContent,'设置');
  assert.deepEqual([...h.storage.keys()],['ai-bro-language']);
});
test('a fresh renderer restores English; unsupported or missing preference keeps Chinese',()=>{
  for(const value of ['en','fr',undefined]){const h=harness(value),label=h.add('span',{'data-i18n':''},'设置');h.init();assert.equal(label.textContent,value==='en'?'Settings':'设置');}
  const first=harness();first.init();first.api.setLanguage('en');const restart=harness(null,first.storage),label=restart.add('span',{'data-i18n':''},'设置');restart.init();assert.equal(label.textContent,'Settings');
});
test('user titles equal to dictionary words, document text, code, and unsaved input values remain byte-for-byte unchanged',()=>{
  const h=harness('en');
  const userSelectors=[{id:'projectTitle'},{id:'conversationTitle'},{id:'previewTitle'},{class:'collection-title'},{class:'reading-tab-title'},{class:'message-body'},{class:'note-document-preview'},{'data-user-content':''}];
  const values=userSelectors.map(attrs=>{const parent=h.add('div',attrs),child=h.add('span',{'data-i18n':''},'设置',parent);return child;});
  const input=h.add('textarea',{'data-i18n-attrs':'placeholder',placeholder:'搜索名称'});input.value='# 设置\n日常';
  const projectOption=h.add('option',{value:'p1'},'日常');const code=h.add('code',{'data-i18n':''},'保存');
  h.init();assert.ok(values.every(n=>n.textContent==='设置'));assert.equal(input.value,'# 设置\n日常');assert.equal(input.getAttribute('placeholder'),'Search names');assert.equal(projectOption.textContent,'日常');assert.equal(code.textContent,'保存');
  h.api.setLanguage('zh-CN');assert.equal(input.value,'# 设置\n日常');assert.ok(values.every(n=>n.textContent==='设置'));
});
test('new fixed control text and asynchronous UI updates translate and can switch back without stale labels',()=>{
  const h=harness('en'),button=h.add('button',{'data-i18n':''},'保存');h.init();assert.equal(button.textContent,'Save');
  button.textContent='取消';h.mutate([{type:'childList',target:button,addedNodes:button.childNodes}]);h.flush();assert.equal(button.textContent,'Cancel');
  h.api.setLanguage('zh-CN');assert.equal(button.textContent,'取消');h.api.setLanguage('en');assert.equal(button.textContent,'Cancel');
  const count=h.add('span',{class:'collection-count'},'12 项');h.mutate([{type:'childList',target:h.document.body,addedNodes:[count]}]);h.flush();assert.equal(count.textContent,'12 items');h.api.setLanguage('zh-CN');assert.equal(count.textContent,'12 项');
});
test('mutation observer ignores streamed user text and touches only changed UI subtrees',()=>{
  const h=harness('en'),message=h.add('div',{class:'message-body'},'设置'),other=h.add('span',{'data-i18n':''},'设置');h.init();
  h.mutate([{type:'characterData',target:message.childNodes[0]}]);assert.equal(h.microtasks.length,0);
  other.childNodes[0].nodeValue='取消';h.mutate([{type:'characterData',target:other.childNodes[0]}]);h.flush();assert.equal(other.textContent,'Cancel');assert.equal(message.textContent,'设置');
});
test('placeholders and aria labels are localized without changing values or internal Chinese space IDs',()=>{
  const h=harness('en'),option=h.add('option',{'data-i18n':'',value:'日常'},'日常'),field=h.add('input',{'data-i18n-attrs':'placeholder',placeholder:'搜索名称','aria-label':'任务'});field.value='日常';h.init();
  assert.equal(option.textContent,'Personal');assert.equal(option.getAttribute('value'),'日常');assert.equal(field.value,'日常');assert.equal(field.getAttribute('aria-label'),'Task');
  h.api.setLanguage('zh-CN');assert.equal(field.getAttribute('placeholder'),'搜索名称');
});
test('settings entry and language resources are packaged and initialized before any application render',()=>{
  const html=fs.readFileSync(require.resolve('../app/index.html'),'utf8'),app=fs.readFileSync(require.resolve('../app/app.js'),'utf8'),manifest=require('../app/asset-manifest.json');
  assert.match(html,/<select[^>]+id="interfaceLanguage"/);assert.ok(html.indexOf('i18n-en.js')<html.indexOf('i18n.js'));assert.ok(html.indexOf('i18n.js')<html.indexOf('app.js'));
  for(const file of ['i18n.js','i18n-en.js','i18n.css'])assert.ok(manifest.web.includes(file));assert.ok(manifest.runtime.includes('native-ui-language.js'));
  assert.ok(app.indexOf('WorkstationI18n?.init()')<app.indexOf('renderAll();'));assert.doesNotMatch(app,/state\.(?:settings|ui)\.language\s*=/);
});
test('paper filters, citation metadata, relative time and effort translate without rewriting adjacent user names',()=>{
  const h=harness('en',null,require('../app/i18n-en'));
  const filter=h.add('button',{'data-paper-filter':'pending'},'待审阅'),review=h.add('span',{class:'paper-review-status'},'已审阅');
  const legend=h.add('span',{'data-i18n':''},'虚线：共同标签'),summary=h.add('summary',{'data-i18n':''},'已参考项目资料 · 4 项');
  const source=h.add('button',{'data-open-import':'fixture','data-source-page':'1'}),name=h.add('span',{'data-user-content':''},'第 1 页',source),page=h.add('span',{'data-i18n':''},'第 1 页',source);
  const model=h.add('span',{'data-user-content':''},'中'),effort=h.add('span',{'data-i18n':''},'中'),time=h.add('span',{'data-i18n':''},'刚刚更新');
  h.init();assert.equal(filter.textContent,'Needs review');assert.equal(review.textContent,'Reviewed');assert.equal(legend.textContent,'Dashed: shared tags');assert.equal(summary.textContent,'Project sources referenced · 4');assert.equal(page.textContent,'Page 1');assert.equal(name.textContent,'第 1 页');assert.equal(model.textContent,'中');assert.equal(effort.textContent,'Medium');assert.equal(time.textContent,'Updated just now');assert.equal(source.getAttribute('data-source-page'),'1');
  h.api.setLanguage('zh-CN');assert.equal(filter.textContent,'待审阅');assert.equal(summary.textContent,'已参考项目资料 · 4 项');assert.equal(page.textContent,'第 1 页');assert.equal(effort.textContent,'中');assert.equal(time.textContent,'刚刚更新');assert.equal(name.textContent,'第 1 页');
});

test('newly mounted note editor translates fixed controls inside a protected reader host',()=>{
  const h=harness('en'),host=h.add('div',{id:'previewContent'});h.init();
  const editor=h.add('section',{class:'note-document'},undefined,host);
  const control=h.add('button',{'data-i18n':''},'保存',editor);
  const body=h.add('article',{class:'note-document-preview'},undefined,editor);
  const user=h.add('p',{'data-i18n':''},'保存',body);
  h.mutate([{type:'childList',target:host,addedNodes:[editor]}]);h.flush();
  assert.equal(control.textContent,'Save');assert.equal(user.textContent,'保存');
  h.api.setLanguage('zh-CN');assert.equal(control.textContent,'保存');
});

test('no-deadline and unsaved interface states translate without changing matching task titles or note text',()=>{
  const h=harness('en',null,require('../app/i18n-en'));
  const card=h.add('button',{class:'message-result-link'});
  const title=h.add('b',{'data-user-content':''},'未设置截止时间',card);
  const status=h.add('span',{'data-i18n':''},'未设置截止时间',card);
  const host=h.add('div',{id:'previewContent'}),editor=h.add('section',{class:'note-document'},undefined,host);
  const saveStatus=h.add('p',{class:'note-document-status'},'尚未保存',editor);
  const body=h.add('article',{class:'note-document-preview'},'尚未保存',editor);
  h.init();
  assert.equal(status.textContent,'No deadline set');assert.equal(saveStatus.textContent,'Unsaved changes');
  assert.equal(title.textContent,'未设置截止时间');assert.equal(body.textContent,'尚未保存');
  const app=fs.readFileSync(require.resolve('../app/app.js'),'utf8');
  assert.match(app,/<span data-i18n>未设置截止时间<\/span>/);
  h.api.setLanguage('zh-CN');
  assert.equal(status.textContent,'未设置截止时间');assert.equal(saveStatus.textContent,'尚未保存');
  assert.equal(title.textContent,'未设置截止时间');assert.equal(body.textContent,'尚未保存');
});

test('builtin skill labels translate reversibly while identical custom names and commands remain unchanged',()=>{
 const h=harness('en',null,require('../app/i18n-en'));
 const builtin=h.add('div',{class:'skills-name skills-builtin'}),title=h.add('span',{'data-i18n':''},'论文深读',builtin),command=h.add('code',{'data-i18n':''},'/paper',builtin);
 const custom=h.add('div',{class:'skills-name'}),customTitle=h.add('span',{'data-user-content':''},'论文深读',custom),customDescription=h.add('p',{'data-user-content':''},'允许注入技能说明');
 h.init();assert.equal(title.textContent,'Deep paper reading');assert.equal(customTitle.textContent,'论文深读');assert.equal(customDescription.textContent,'允许注入技能说明');assert.equal(command.textContent,'/paper');h.api.setLanguage('zh-CN');assert.equal(title.textContent,'论文深读');
});


test('declared templates translate fixed option text while preserving arbitrary project and conversation names',()=>{
  const h=harness('en',null,require('../app/i18n-en'));
  const name='日常 {title} <b>课程</b>';
  const option=h.add('option',{'data-i18n-template':'课程 · {project}','data-i18n-vars':JSON.stringify({project:name}),value:'project-1'},'课程 · '+name);
  const description=h.add('p',{'data-i18n-template':'{title} · 仅影响后续消息','data-i18n-vars':JSON.stringify({title:name})},'');
  h.init();assert.equal(option.textContent,'Courses · '+name);assert.equal(option.getAttribute('value'),'project-1');assert.equal(description.textContent,name+' · Applies to future messages');
  h.api.setLanguage('zh-CN');assert.equal(option.textContent,'课程 · '+name);assert.equal(description.textContent,name+' · 仅影响后续消息');
  h.api.setLanguage('en');option.setAttribute('data-i18n-vars',JSON.stringify({project:'科研'}));h.mutate([{type:'attributes',target:option}]);h.flush();assert.equal(option.textContent,'Courses · 科研');
});
