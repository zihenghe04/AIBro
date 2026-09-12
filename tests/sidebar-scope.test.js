const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../app/app.js'),'utf8');
const start = source.indexOf('function sidebarProjectWorkspace(');
const end = source.indexOf('\nlet manageTarget',start);
assert.ok(start >= 0 && end > start,'Extract real sidebar scope and renderer');

function fixture() {
  return {
    projects:[
      {id:'daily',name:'生活计划',workspace:'日常',folderId:'mixed'},
      {id:'course',name:'智能控制',workspace:'课程',folderId:'mixed'},
      {id:'research',name:'智能控制',workspace:'科研',folderId:'research-folder'},
      {id:'old-research',name:'已归档论文',workspace:'科研',archived:true},
      {id:'deleted-research',name:'已删除论文',workspace:'科研',deletedAt:1}
    ],
    conversations:[{id:'chat',title:'论文讨论',projectId:'research',workspace:'科研'},{id:'daily-chat',title:'明天安排',workspace:'日常'},{id:'old-chat',title:'旧对话',workspace:'课程',archived:true}],
    folders:{projects:[{id:'mixed',name:'混合旧文件夹'},{id:'research-folder',name:'研究资料',workspace:'科研'},{id:'empty-course',name:'空课程文件夹',workspace:'课程'},{id:'empty-research',name:'空科研文件夹',workspace:'科研'}],conversations:[]},
    tasks:[],currentProjectId:'research',currentConversationId:'chat'
  };
}
function harness(view='research') {
  const state=fixture(), elements=new Map(), opened=[], managed=[], folderMenus=[];
  class Element {
    constructor() {this.value='';this.dataset={};this.buttons=[];this.textContent='';this.attributes={};}
    set innerHTML(value) {
      this.html=value;this.buttons=[];
      for(const match of value.matchAll(/<button\b([^>]*)>/g)) {
        const button={dataset:{},onclick:null};
        for(const data of match[1].matchAll(/data-([a-z-]+)="([^"]*)"/g)) button.dataset[data[1].replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=data[2];
        this.buttons.push(button);
      }
    }
    get innerHTML(){return this.html||'';}
    setAttribute(key,value){this.attributes[key]=value;}
    showModal(){this.open=true;}
    focus(){}
  }
  const $=selector=>{if(!elements.has(selector))elements.set(selector,new Element());return elements.get(selector);};
  const $$=selector=>{const attribute=/^(?:button)?\[data-([a-z-]+)\]$/.exec(selector)?.[1];if(!attribute)return[];const key=attribute.replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase());return [...elements.values()].flatMap(node=>node.buttons.filter(button=>Object.hasOwn(button.dataset,key)));};
  const context=vm.createContext({state,document:{body:{dataset:{view}}},$,$$,conversationQuery:'',
    normalize:value=>String(value??'').trim().toLowerCase().replace(/[\s·_-]+/g,''),
    workspaceName:value=>['课程','科研'].includes(value)?value:'日常',formatRelative:()=> '刚刚',
    esc:value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])),uiIcon:()=>'',visibleTask:task=>!task.archived,
    openConversation:id=>opened.push(['conversation',id]),openProject:id=>opened.push(['project',id]),
    openManageDialog:(kind,id)=>managed.push([kind,id]),openFolderDialog:id=>folderMenus.push(id),setTimeout:()=>{}
  });
  vm.runInContext(source.slice(start,end),context);
  const openDialogStart=source.indexOf('function openCreateProjectDialog(');
  vm.runInContext(source.slice(openDialogStart,source.indexOf('\n',openDialogStart)),context);
  return {state,context,$,$$,opened,managed,folderMenus,render:context.renderSidebar,scope:context.sidebarProjectWorkspace};
}

test('space pages and a live project resolve their exact workspace, while global and unavailable contexts do not invent one',()=>{
  const h=harness();
  for(const [view,space] of [['daily','日常'],['courses','课程'],['research','科研']]) assert.equal(h.scope(view),space);
  assert.equal(h.scope('project'), '科研');
  for(const view of ['agent','dashboard','settings','trash','unknown','constructor','__proto__','toString']) assert.equal(h.scope(view),null,view);
  h.state.projects.find(item=>item.id==='research').archived=true;
  assert.equal(h.scope('project'),null);
  assert.equal(h.scope('project',h.state.projects,'missing'),null);
});

test('project list shows only the selected space including its archive and matching empty folders',()=>{
  const h=harness('research');h.render();
  assert.deepEqual(h.$$('[data-project-id]').map(button=>button.dataset.projectId),['research','old-research']);
  assert.equal(h.$('#projectListLabel').textContent,'科研项目');
  assert.equal(h.$('#projectList').attributes['aria-label'],'科研空间的项目');
  assert.match(h.$('#projectList').innerHTML,/空科研文件夹/);
  assert.doesNotMatch(h.$('#projectList').innerHTML,/空课程文件夹|生活计划|已删除论文|混合旧文件夹/);
  assert.match(h.$('#projectList').innerHTML,/已归档/);
});

test('switching spaces rebuilds project destinations and menus without leaking a same-name project from another space',()=>{
  const h=harness('research');h.render();
  h.context.document.body.dataset.view='courses';h.render();
  assert.deepEqual(h.$$('[data-project-id]').map(button=>button.dataset.projectId),['course']);
  h.$$('[data-project-id]')[0].onclick();
  h.$$('[data-project-menu]')[0].onclick({stopPropagation(){}});
  assert.deepEqual(h.opened,[['project','course']]);
  assert.deepEqual(h.managed,[['project','course']]);
  assert.match(h.$('#projectList').innerHTML,/混合旧文件夹|空课程文件夹/);
  assert.doesNotMatch(h.$('#projectList').innerHTML,/生活计划|空科研文件夹|已归档论文/);
});

test('global views show all non-deleted project spaces, and conversation search does not narrow project scope',()=>{
  const h=harness('dashboard');h.context.conversationQuery='论文';h.render();
  assert.deepEqual(h.$$('[data-project-id]').map(button=>button.dataset.projectId).sort(),['course','daily','old-research','research']);
  assert.equal(h.$('#projectListLabel').textContent,'全部项目');
  assert.deepEqual(h.$$('[data-conversation-id]').map(button=>button.dataset.conversationId),['chat']);
  assert.equal(h.$('#conversationCount').textContent,'1');
});

test('project detail keeps its workspace scope and exposes only its actual active row',()=>{
  const h=harness('project');h.render();
  assert.deepEqual(h.$$('[data-project-id]').map(button=>button.dataset.projectId),['research','old-research']);
  assert.match(h.$('#projectList').innerHTML,/project-item active[^>]*data-project-id="research"[^>]*aria-current="page"/);
  assert.doesNotMatch(h.$('#projectList').innerHTML,/project-item active[^>]*data-project-id="old-research"/);
});

test('new project dialog inherits the current space or current project, and global entry defaults to daily',()=>{
  const h=harness();
  for(const [view,expected] of [['research','科研'],['courses','课程'],['project','科研'],['dashboard','日常']]) {
    h.context.document.body.dataset.view=view;h.context.openCreateProjectDialog();
    assert.equal(h.$('#newProjectWorkspaceInput').value,expected);
  }
});

test('sidebar title markup is escaped and scoped empty state remains actionable without fake projects',()=>{
  const h=harness('research');h.state.projects=[];h.state.folders.projects=[];h.render();
  assert.equal(h.$$('[data-project-id]').length,0);
  assert.match(h.$('#projectList').innerHTML,/暂无科研项目/);
  h.state.projects.push({id:'safe',name:'<img src=x onerror=alert(1)>',workspace:'科研'});h.render();
  assert.doesNotMatch(h.$('#projectList').innerHTML,/<img/);
  assert.match(h.$('#projectList').innerHTML,/&lt;img/);
});
