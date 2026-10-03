'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Library=require('../app/project-library.js');
const records=[{id:'1',folderPath:'课程/讲义/第一讲'},{id:'2',folderPath:'课程/讲义'},{id:'3',folderPath:'课程/作业'},{id:'4',folderPath:'科研/讲义'},{id:'5'},{id:'6',folderPath:'课程'}];
const node=(model,path)=>{let result;function walk(rows){for(const row of rows){if(row.path===path)result=row;walk(row.children);}}walk(model.roots);return result;};
test('folders retain exact ancestry and aggregate counts with no duplicate parent rows',()=>{
 const m=Library.buildModel(records);assert.equal(m.count,6);assert.equal(m.uncategorized,1);assert.equal(m.roots.length,2);assert.equal(node(m,'课程').count,4);assert.equal(node(m,'课程/讲义').count,2);assert.equal(node(m,'科研/讲义').count,1);assert.equal(node(m,'课程').expanded,false);assert.equal(node(m,'课程/讲义').expanded,false);
});
test('all sources and uncategorized remain distinct, invalid selections return all',()=>{
 assert.equal(Library.buildModel(records,null).selected,null);assert.equal(Library.buildModel(records,'').selected,'');assert.equal(Library.buildModel(records,'已删除/目录').selected,null);assert.equal(Library.buildModel(records.filter(x=>x.folderPath),'').selected,null);assert.deepEqual(Library.buildModel([],null).roots,[]);
});
test('selection reveals unknown ancestors while explicit collapse retains selection and breadcrumbs',()=>{
 const m=Library.buildModel(records,'课程/讲义/第一讲');assert.equal(m.selected,'课程/讲义/第一讲');assert.equal(node(m,'课程').expanded,true);assert.equal(node(m,'课程/讲义').expanded,true);assert.equal(m.hiddenSelection,false);
 const collapsed=Library.buildModel(records,m.selected,{'课程':false});assert.equal(collapsed.hiddenSelection,true);assert.equal(collapsed.selected,m.selected);assert.equal(node(collapsed,'课程').expanded,false);assert.deepEqual(collapsed.breadcrumbs.map(x=>x.path),['课程','课程/讲义','课程/讲义/第一讲']);
});
test('normalization matches folder metadata and preserves literal user names',()=>{
 const rows=[{folderPath:'//A\\B///C/'},{folderPath:'A/B/C'},{folderPath:'<img>/__proto__/constructor'}],m=Library.buildModel(rows,'A\\B/C/');assert.equal(node(m,'A/B/C').count,2);assert.equal(m.selected,'A/B/C');assert.equal(node(m,'<img>/__proto__/constructor').label,'constructor');assert.equal({}.polluted,undefined);
});
test('model consumes only supplied records without mutations or inferred files',()=>{
 const source=JSON.parse(JSON.stringify(records)),expansion={'课程':true,'科研':false},before=JSON.stringify({source,expansion});Library.buildModel(source,null,expansion);assert.equal(JSON.stringify({source,expansion}),before);assert.equal(Library.buildModel(source.slice(0,2)).count,2);
});
function controller(){
 const mounts=new Map(),unmounted=[],selections=[],toggles=[];
 const ctx={HalaskaUI:{mount(host,component,props){mounts.set(host,{component,props});},unmount(host){unmounted.push(host);mounts.delete(host);}}};vm.runInNewContext(fs.readFileSync(require.resolve('../app/project-library.js'),'utf8'),ctx);
 const host={querySelector:()=>({focus(){host.focused=true;}})},breadcrumb={};
 const options={projectId:'one',records,selected:null,expansion:{},breadcrumbHost:breadcrumb,onSelect:(...args)=>selections.push(args),onToggle:(...args)=>toggles.push(args)};
 return {api:ctx.ProjectLibrary,host,breadcrumb,options,mounts,unmounted,selections,toggles};
}
test('mount updates reuse the root, toggles do not select and reveal restores selected ancestors',()=>{
 const f=controller(),a=f.api.mount(f.host,{...f.options,selected:'课程/讲义/第一讲'});assert.equal(f.api.mount(f.host,{records}),a);
 f.mounts.get(f.host).props.onToggle('课程',false);assert.equal(f.selections.length,0);assert.equal(f.mounts.get(f.host).props.model.hiddenSelection,true);assert.equal(f.toggles[0][3].projectId,'one');
 f.mounts.get(f.breadcrumb).props.onReveal();assert.equal(f.mounts.get(f.host).props.model.hiddenSelection,false);assert.equal(f.host.focused,true);assert.equal(f.toggles[1][3].reveal,true);
 f.mounts.get(f.host).props.onSelect('科研/讲义');assert.equal(f.selections[0][0],'科研/讲义');assert.equal(f.selections[0][1].expansion['科研'],true);
});
test('project switch never carries same-name path expansion or selected directory across projects',()=>{
 const f=controller(),a=f.api.mount(f.host,{...f.options,selected:'课程/讲义',expansion:{'课程':true}});a.update({projectId:'two'});assert.equal(f.mounts.get(f.host).props.model.selected,null);assert.equal(node(f.mounts.get(f.host).props.model,'课程').expanded,false);a.update({projectId:'one',selected:'课程/讲义',expansion:{'课程':false}});assert.equal(f.mounts.get(f.host).props.model.hiddenSelection,true);
});
test('retired breadcrumbs unmount; disposed callbacks cannot select or update',()=>{
 const f=controller(),a=f.api.mount(f.host,f.options),stale=f.mounts.get(f.host).props;a.update({breadcrumbHost:null});assert.ok(f.unmounted.includes(f.breadcrumb));a.unmount();stale.onSelect('课程');stale.onToggle('课程',true);a.revealSelection();assert.equal(f.selections.length,0);assert.equal(f.toggles.length,0);assert.equal(f.mounts.size,0);
});

test('shared empty directories retain zero counts, selected crumbs and scope separation without fake records',()=>{
 const folders=[{id:'empty',folderPath:'Course/Empty'}],m=Library.buildModel([], 'Course/Empty', {},folders);
 assert.equal(m.count,0);assert.equal(m.roots[0].count,0);assert.equal(node(m,'Course/Empty').count,0);assert.equal(m.selected,'Course/Empty');
 const ui={};Library.rememberLocation(ui,'p','content',{selected:'Course/Empty',expansion:{Course:true}});
 assert.equal(Library.scopeModel([],ui,'p',folders).selected,'Course/Empty');
 const recordView=Library.selectScope(ui,'p','records',[],folders);assert.equal(recordView.selected,null);
 assert.equal(Library.selectScope(ui,'p','content',[],folders).selected,'Course/Empty');
 const f=controller(),api=f.api.mount(f.host,{...f.options,records:[],folders,selected:'Course/Empty'});
 assert.equal(f.mounts.get(f.host).props.model.selected,'Course/Empty');api.update({projectId:'another'});
 assert.equal(f.mounts.get(f.host).props.model.roots.length,0);
});
