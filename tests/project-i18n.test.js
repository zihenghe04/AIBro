const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../app.js'),'utf8'),dictionary=require('../i18n-en');
function translate(value){if(Object.hasOwn(dictionary.exact,value))return dictionary.exact[value];for(const rule of dictionary.patterns){const regex=new RegExp(rule.source);if(regex.test(value))return value.replace(regex,rule.replacement);}return value;}
function render(overrides={},analysisStatus='analyzed'){
 const nodes=new Map(),state={projects:[{id:'p',name:'知识库',workspace:'课程',description:'项目状态'}],tasks:[{id:'t',title:'尚未开始',workspace:'课程',projectId:'p',status:'todo',priority:'medium',dueAt:'2026-09-15T10:00:00Z'}],notes:[{id:'n',title:'规划与任务',kind:'User category',workspace:'课程',projectId:'p',content:'知识条目'}],imports:[],papers:[],conversations:[],...overrides};
 const get=selector=>{if(!nodes.has(selector))nodes.set(selector,{dataset:{projectId:'p'},innerHTML:'',textContent:'',hidden:false,classList:{remove(){},toggle(){}},setAttribute(){},replaceChildren(){},querySelector(){return{onclick:null};},closest(){return{toggleAttribute(){}};}});return nodes.get(selector);};
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const context=vm.createContext({state,$:get,document:{body:{dataset:{view:'project'}}},window:{matchMedia:()=>({matches:false})},requestAnimationFrame(){},updateProjectHeading(){},workspaceName:x=>x,esc,orderTasks:x=>x,visibleTask:()=>true,visibleNote:()=>true,visibleImport:()=>true,visiblePaper:()=>true,conversationProjectIds:c=>[c.projectId],formatDate:()=> '2026/9/15 GMT+8 18:00',formatRelative:()=> '刚刚更新',statusLabel:()=> '待开始',priorityLabel:()=> '中',uiIcon:()=>'',importAnalysis:()=>({status:analysisStatus}),analysisBadge:()=>'',nestedTree:(items,fn)=>items.map(fn).join(''),setEntityBox:(selector,html)=>get(selector).innerHTML=html,entityTask:()=>'',entityNote:()=>'',entityImport:()=>'',renderPlanning(){},applySectionTabs(){}});
 vm.runInContext(source.slice(source.indexOf('function renderProject('),source.indexOf('function updateProjectHeading(')),context);context.renderProject('p');return{state,nodes,get};
}
test('actual populated project header, tree and metrics expose translatable labels while preserving user fields',()=>{
 const h=render(),before=JSON.stringify(h.state),html=['#projectWorkspace','#projectMetrics','#projectSummary','#projectTree'].map(key=>h.get(key).innerHTML).join('');
 const labels=[...html.matchAll(/<[^>]*\bdata-i18n(?=\s|>)[^>]*>([^<>]+)</g)].map(match=>match[1]);
 for(const label of labels.filter(x=>/[\u3400-\u9fff]/.test(x)))assert.notEqual(translate(label),label,'Untranslated project UI: '+label);
 for(const key of ['规划与任务','知识库','知识条目','尚未开始','可从文件树跳转','原件可预览','下个截止','项目状态','下一截止','还有 1 项待推进'])assert.ok(labels.includes(key),'Missing explicit interface marker: '+key);
 assert.equal(h.get('#projectTitle').textContent,'知识库');assert.equal(h.get('#projectDescription').textContent,'项目状态');assert.match(h.get('#projectSummary').innerHTML,/<p data-user-content>项目状态<\/p>/);assert.match(h.get('#projectSummary').innerHTML,/<span data-user-content>尚未开始<\/span>/);assert.match(h.get('#projectTree').innerHTML,/<span>规划与任务<\/span>/);assert.equal(JSON.stringify(h.state),before);
});
test('empty and completed project variants localize without arbitrary title or date regex capture',()=>{
 const empty=render({tasks:[],notes:[]}),done=render({tasks:[{id:'done',projectId:'p',status:'done'}]});
 for(const html of [empty.get('#projectMetrics').innerHTML,empty.get('#projectSummary').innerHTML,done.get('#projectMetrics').innerHTML,done.get('#projectSummary').innerHTML])for(const match of html.matchAll(/<[^>]*\bdata-i18n>([^<>]+)</g)){const label=match[1];if(/[\u3400-\u9fff]/.test(label))assert.notEqual(translate(label),label);}
 assert.equal(translate('还有 12 项待推进'),'12 open tasks remaining');assert.equal(translate('已完成 1 项'),'1 completed');assert.equal(translate('项目状态：还有 12 项待推进'),'项目状态：还有 12 项待推进');assert.equal(translate('我的知识库'),'我的知识库');assert.equal(translate('2026/9/15 GMT+8 18:00'),'2026/9/15 GMT+8 18:00');
});

test('project pending-analysis banner marks all fixed content and leaves source names unchanged',()=>{
 const imports=[1,2,3].map(n=>({id:'original-'+n,name:'资料库',workspace:'课程',projectId:'p',content:'原件已保存'}));
 const h=render({imports},'pending'),box=h.get('#projectPendingAnalysis');
 assert.equal(box.hidden,false);assert.match(box.innerHTML,/<strong data-i18n>3 份资料待 AI 分析<\/strong>/);
 assert.match(box.innerHTML,/<p data-i18n>原件已保存；生成分析笔记后才会进入知识关联。<\/p>/);
 assert.notEqual(translate('3 份资料待 AI 分析'),'3 份资料待 AI 分析');assert.ok(h.state.imports.every(item=>item.name==='资料库'&&item.content==='原件已保存'));
 const empty=render({imports:[]},'pending');assert.equal(empty.get('#projectPendingAnalysis').hidden,true);
});
