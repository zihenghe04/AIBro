'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const plain=value=>JSON.parse(JSON.stringify(value));
const source=fs.readFileSync(path.join(__dirname,'../app/file-actions.js'),'utf8');
// Minimal element: closest() walks explicit ancestors by attribute selectors.
function element(dataset,parent=null,tag='button'){
  const attr={openNote:'data-open-note',wikiTreeNote:'data-wiki-tree-note',cuiKind:'data-cui-kind',cuiId:'data-cui-id',fileRef:'data-file-ref',documentFileKey:'data-document-file-key',openImport:'data-open-import'};
  const has=name=>Object.entries(dataset).some(([key])=>attr[key]===name);
  const node={tagName:tag.toUpperCase(),dataset,parent,
    matches(selector){return selector.split(',').some(part=>{part=part.trim();if(part==='button')return tag==='button';const names=[...part.matchAll(/\[([a-z-]+)\]/g)].map(m=>m[1]);return names.length>0&&names.every(has);});},
    closest(selector){let current=node;while(current){if(current.matches(selector))return current;current=current.parent;}return null;},
    getBoundingClientRect:()=>({left:10,bottom:20}),isConnected:true,focus(){},};
  return node;
}
function load({desktop=false,ask,canAsk=()=>true,wiki={}}={}){
  const listeners={},appended=[];
  const document={addEventListener:(type,fn)=>{(listeners[type]||=[]).push(fn);},activeElement:null,
    createElement:tag=>{const children=[];const node={tag,children,style:{},dataset:{},setAttribute(){},append:child=>children.push(child),remove(){},querySelector:()=>children[0],querySelectorAll:()=>children,offsetWidth:100,offsetHeight:40,focus(){document.activeElement=node;},contains:value=>value===node||children.includes(value)};return node;},
    body:{append:node=>appended.push(node)}};
  const root={document,workstationDesktop:desktop?{isDesktop:true}:undefined,FileContext:{available:()=>true},addEventListener(){},innerWidth:800,innerHeight:600};
  root.globalThis=root;Object.assign(root,{innerWidth:800,innerHeight:600});
  vm.runInNewContext(source,{globalThis:root,document,innerWidth:800,innerHeight:600,addEventListener(){}});
  const toasts=[];root.FileActions.init({getState:()=>({_wikiFiles:wiki,projects:[]}),toast:m=>toasts.push(m),ask,canAsk});
  const contextmenu=target=>{const event={target,preventDefault(){event.prevented=true;},clientX:5,clientY:5};listeners.contextmenu.forEach(fn=>fn(event));return event;};
  return {api:root.FileActions,contextmenu,appended,toasts};
}
test('file rows name their record for ask: collection rows, library notes, file tree local files',()=>{
  const {api}=load({ask:()=>true});
  const row=element({cuiKind:'import',cuiId:'pdf-1'},null,'div'),button=element({},row);
  assert.deepEqual(plain(api.reference(button)),{type:'import',id:'pdf-1'});
  assert.deepEqual(plain(api.reference(element({openNote:'n1'}))),{type:'note',id:'n1'});
  const key=JSON.stringify(['local-file',JSON.stringify(['p','c','docs/a.md'])]);
  assert.deepEqual(plain(api.reference(element({documentFileKey:key}))),{type:'local',projectId:'p',candidateId:'c',path:'docs/a.md',title:'a.md'});
  assert.equal(api.reference(element({cuiKind:'task',cuiId:'t'},null,'div')),null);
});
test('context menu offers 问 AI first and calls the host with the row ref; private mode and web without ask stay quiet',async()=>{
  const asked=[];let allowed=true;
  const f=load({ask:(ref,anchor)=>{asked.push({ref,anchor});return true;},canAsk:()=>allowed});
  const row=element({cuiKind:'note',cuiId:'n2'},null,'div');
  const event=f.contextmenu(row);assert.equal(event.prevented,true);
  const menu=f.appended.at(-1);assert.equal(menu.children.length,1,'no Finder item outside the desktop shell or for a non-wiki note');
  assert.match(menu.children[0].textContent,/问 AI/);
  await menu.children[0].onclick();assert.deepEqual(plain(asked[0].ref),{type:'note',id:'n2'});assert.equal(asked[0].anchor,row);
  allowed=false;const quiet=f.contextmenu(element({cuiKind:'note',cuiId:'n2'},null,'div'));assert.equal(quiet.prevented,undefined);
  const web=load();assert.equal(web.contextmenu(element({openNote:'n1'})).prevented,undefined);
});
test('desktop wiki files keep Show in Finder after the ask item',()=>{
  const f=load({desktop:true,ask:()=>true,wiki:{w:true}});
  f.contextmenu(element({openNote:'w'}));const menu=f.appended.at(-1);
  assert.deepEqual(menu.children.map(n=>n.textContent),['问 AI · 就这份资料提问','在 Finder 中显示']);
});
