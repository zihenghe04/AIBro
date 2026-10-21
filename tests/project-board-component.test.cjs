'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),React=require('react'),esbuild=require('esbuild');
const code=esbuild.transformSync(fs.readFileSync(require.resolve('../app/ui/project-board.jsx'),'utf8'),{loader:'jsx',format:'cjs'}).code;
function fixture(lang='zh'){
  const module={exports:{}},changed=[];
  vm.runInNewContext(code,{module,exports:module.exports,document:{documentElement:{lang}},require(name){
    if(name==='react')return {...React,useState:()=>[false,value=>changed.push(value)]};
    if(name.endsWith('.css'))return '';
    if(name.includes('halaska-kit'))return {Button:'Kit:Button',EmptyState:'Kit:EmptyState'};
    if(name.includes('kit-controls'))return {KitSelect:'Kit:Select',KitSegmentedControl:'Kit:SegmentedControl'};
    if(name.includes('planning-motion'))return {layoutMotion:()=>undefined};
    return new Proxy({},{get:(_,key)=>`Icon:${String(key)}`});
  }});
  const render=props=>{const all=[];function visit(node){if(Array.isArray(node)){node.forEach(visit);return;}if(!React.isValidElement(node))return;if(typeof node.type==='function'){visit(node.type(node.props));return;}all.push(node);visit(node.props.children);}visit(module.exports.ProjectBoardPanel(props));return all;};
  return {render,changed};
}
const task=(patch={})=>({id:'t',title:'Literal <script>task</script>',status:'todo',dueAt:'2026-10-01',...patch});
const byClass=(nodes,name)=>nodes.filter(node=>String(node.props.className||'').split(' ').includes(name));
const text=node=>React.Children.toArray(node?.props?.children).map(value=>typeof value==='string'||typeof value==='number'?String(value):React.isValidElement(value)?text(value):'').join('');

test('continuous list uses one controlled Kit status selector per task and a semantic title button',()=>{
  const opens=[],moves=[],nodes=fixture().render({tasks:[task()],onOpen:(...args)=>opens.push(args),onStatus:(...args)=>moves.push(args)});
  const row=byClass(nodes,'project-task-item')[0];assert.equal(row.type,'li');assert.equal(row.props.draggable,false);assert.equal(row.props['data-board-task'],'t');
  const select=nodes.find(node=>node.type==='Kit:Select');assert.equal(select.props.attributes['data-task-status-select'],'t');assert.match(select.props.label,/更改任务状态/);assert.equal(select.props.value,'todo');
  assert.deepEqual(Array.from(select.props.options,value=>value.value),['todo','in_progress','blocked','done']);select.props.onChange('blocked');assert.deepEqual(moves,[['t','blocked']]);
  const button=byClass(nodes,'project-task-copy')[0].props.children[0],anchor={};assert.equal(button.type,'Kit:Button');button.props.onClick({currentTarget:anchor});assert.deepEqual(opens,[['t',anchor]]);
  assert.equal(byClass(nodes,'project-board-moves').length,0);assert.equal(text(byClass(nodes,'project-task-title')[0]),'Literal <script>task</script>');assert.ok(nodes.every(node=>!node.props.dangerouslySetInnerHTML));
});

test('real Kit list-board control and optional create action call supplied hooks only',()=>{
  const calls=[],nodes=fixture('en').render({tasks:[],onMode:value=>calls.push(value),onCreate:()=>calls.push('create')});
  const mode=nodes.find(node=>node.type==='Kit:SegmentedControl');assert.equal(mode.props.label,'Task view');assert.deepEqual(Array.from(mode.props.options,value=>value.label),['List','Board']);mode.props.onChange('board');
  const add=nodes.find(node=>node.type==='Kit:Button');assert.equal(text(add),'Add task');add.props.onClick();assert.deepEqual(calls,['board','create']);
  assert.equal(fixture().render({tasks:[]}).some(node=>node.type==='Kit:Button'),false);
  const unavailable=fixture().render({available:false,tasks:[],onCreate(){}});assert.equal(unavailable.some(node=>node.type==='Kit:Button'),false);assert.equal(unavailable.find(node=>node.type==='Kit:EmptyState').props.title,'项目当前不可用');
});

test('board groups actual status rows, exposes native status alternatives, and guards drag/drop',()=>{
  let allow=false,prevented=0;const calls=[],nodes=fixture().render({mode:'board',tasks:[task(),task({id:'done',status:'done'})],canDrop:()=>allow,onDrop:status=>calls.push(['drop',status]),onDragStart:id=>{calls.push(['start',id]);return true;}});
  const columns=byClass(nodes,'project-board-column');assert.deepEqual(columns.map(node=>node.props['data-board-status']),['todo','in_progress','blocked','done']);assert.equal(nodes.filter(node=>node.type==='Kit:Select').length,2);
  const row=byClass(nodes,'project-task-item')[0],transfer={setData:(...args)=>calls.push(args)};
  row.props.onDragStart({dataTransfer:transfer,preventDefault:()=>prevented++});assert.equal(transfer.effectAllowed,'move');assert.deepEqual(calls.slice(0,2),[['start','t'],['text/plain','t']]);
  const event={preventDefault:()=>prevented++,dataTransfer:{}};columns[1].props.onDrop(event);assert.equal(calls.length,2);allow=true;columns[1].props.onDragOver(event);assert.equal(event.dataTransfer.dropEffect,'move');columns[1].props.onDrop(event);assert.deepEqual(calls.at(-1),['drop','in_progress']);assert.ok(prevented>=2);
});

test('pending row disables its actual native-select adapter and cannot begin a drag',()=>{
  let dragCalls=0,prevented=0;const nodes=fixture().render({mode:'board',tasks:[task()],busyIds:['t'],onDragStart:()=>{dragCalls++;return true;}});
  const row=byClass(nodes,'project-task-item')[0];assert.equal(row.props['aria-busy'],true);assert.equal(row.props.draggable,false);assert.equal(nodes.find(node=>node.type==='Kit:Select').props.disabled,true);
  row.props.onDragStart({preventDefault:()=>prevented++});assert.equal(prevented,1);assert.equal(dragCalls,0);
});

test('calendar-only deadlines retain exact dates and invalid dates do not roll into another day',()=>{
  const invalid=['2026-02-31','2026-02-30T09:00:00','2026-10-01T24:01:00','2026-10-01T12:60','2026-10-01T12:10:60'];
  const nodes=fixture().render({tasks:[task(),...invalid.map((dueAt,index)=>task({id:`invalid-${index}`,dueAt})),task({id:'unset',dueAt:null})]});
  const times=nodes.filter(node=>node.type==='time');assert.equal(times.length,1);assert.equal(times[0].props.dateTime,'2026-10-01');
  assert.equal(nodes.filter(node=>node.type==='span'&&text(node)==='日期待修正').length,invalid.length);assert.equal(text(byClass(nodes,'project-task-undated')[0]),'未排期');
});

test('task metadata stays compact and prerequisite state never includes hidden owner names',()=>{
  const nodes=fixture().render({tasks:[task({prerequisitesIncomplete:true,title:'Long title '.repeat(90)})]});
  assert.equal(text(byClass(nodes,'project-task-prerequisite')[0]),'前置任务未就绪');assert.equal(text(byClass(nodes,'project-task-title')[0]),'Long title '.repeat(90));
  assert.equal(nodes.some(node=>String(node.props.className||'').includes('project-board-toolbar')),false);
});

test('status icon is a labelled shortcut to the same guarded status action and due chips state urgency in words',()=>{
  const moves=[],today=new Date(),iso=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const past=new Date(today);past.setDate(past.getDate()-3);
  const nodes=fixture().render({tasks:[task({dueAt:iso(today)}),task({id:'late',dueAt:iso(past)}),task({id:'done',status:'done',dueAt:iso(past)})],onStatus:(...args)=>moves.push(args)});
  const toggles=byClass(nodes,'project-task-state-icon');assert.equal(toggles.length,3);assert.ok(toggles.every(node=>node.type==='button'));
  assert.match(toggles[0].props['aria-label'],/标记为已完成/);assert.equal(toggles[2].props['aria-pressed'],true);
  toggles[0].props.onClick();toggles[2].props.onClick();assert.deepEqual(moves,[['t','done'],['done','todo']]);
  const chips=nodes.filter(node=>node.type==='time').map(node=>[node.props.className,text(node)]);
  assert.match(chips[0][0],/is-today/);assert.match(chips[0][1],/^今天/);assert.match(chips[1][0],/is-overdue/);assert.match(chips[1][1],/^已逾期/);
  assert.doesNotMatch(chips[2][0],/is-overdue/,'Completed work is never flagged overdue');
  assert.equal(fixture().render({tasks:[task()],busyIds:['t'],onStatus(){}}).find(node=>String(node.props.className||'').includes('project-task-state-icon')).props.disabled,true);
});
