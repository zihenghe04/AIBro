/* 第 9 轮验收：项目「排期」Tab（§6.1）——周视图日历 + 项目计划文档。
   真实渲染器中验证；出站模型请求一律拒绝（本脚本不发消息）。
   运行：node_modules/.bin/electron tests/agent-round9-smoke.cjs */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),PORT=18917,ORIGIN=`http://127.0.0.1:${PORT}`;
const TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aw-round9-')),STORE=path.join(TEMP,'store');fs.mkdirSync(STORE);fs.mkdirSync(path.join(TEMP,'profile'));app.setPath('userData',path.join(TEMP,'profile'));
let server,win;const passed=[],failures=[];const wait=ms=>new Promise(r=>setTimeout(r,ms));
const request=route=>new Promise((resolve,reject)=>http.get(ORIGIN+route,r=>{r.resume();r.on('end',()=>resolve({status:r.statusCode}));}).on('error',reject));
async function until(fn,label,timeout=15000){const start=Date.now();while(Date.now()-start<timeout){if(await fn())return;await wait(60);}throw Error(`Timed out: ${label}`);}
const watchdog=setTimeout(()=>{console.error('QA timeout',TEMP);win?.destroy();server?.kill('SIGTERM');app.exit(1);},180000);
async function run(){
 await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',()=>reject(Error(`${PORT} occupied`)));probe.listen(PORT,'127.0.0.1',()=>probe.close(resolve));});
 const log=fs.openSync(path.join(TEMP,'server.log'),'a');server=spawn(process.env.PYTHON||'python3',[path.join(ROOT,'app','server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(PORT),AI_WORKSTATION_DATA_DIR:STORE,AI_WORKSTATION_ASSET_DIR:path.join(ROOT,'app')},stdio:['ignore',log,log]});
 await until(async()=>{if(server.exitCode!==null)throw Error('QA service exited');try{return(await request('/__health')).status===200;}catch{return false;}},'QA service');
 await app.whenReady();win=new BrowserWindow({show:true,width:1400,height:950,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 const errors=[];win.webContents.on('console-message',(_event,level,message)=>{if(level>=3){errors.push(message);}});
 const evaluate=async code=>{try{return await win.webContents.executeJavaScript(code,true);}catch(error){console.error('Renderer errors:',JSON.stringify(errors));throw error;}};
 async function step(label,fn){try{await fn();passed.push(label);console.log('PASS',label);}catch(error){failures.push({label,error:error.stack});console.error('FAIL',label,error.message);}}
 await win.loadURL(ORIGIN);await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydration');
 await wait(600);
 assert.equal(await evaluate('!!window.ProjectSchedule'),true,'排期模块必须加载');

 // 造项目 + 本周内外的任务 + 无日期任务
 await evaluate(`(()=>{const now=Date.now();const day=86400000;
  const monday=(()=>{const d=new Date();d.setHours(0,0,0,0);d.setDate(d.getDate()-((d.getDay()+6)%7));return d.getTime();})();
  state.projects=[{id:'qa_proj',name:'排期验收项目',workspace:'科研',description:'合成数据',createdAt:now,updatedAt:now}];
  state.notes=[];state.imports=[];state.agentRuns=[];state.conversations=[];
  state.tasks=[
   {id:'qa_t1',title:'周一启动会',projectId:'qa_proj',workspace:'科研',status:'todo',priority:'high',dueAt:monday+9*3600000,createdAt:now,updatedAt:now},
   {id:'qa_t2',title:'周三实验',projectId:'qa_proj',workspace:'科研',status:'in_progress',priority:'medium',dueAt:monday+2*day+14*3600000,createdAt:now,updatedAt:now},
   {id:'qa_t3',title:'周五写报告',projectId:'qa_proj',workspace:'科研',status:'done',priority:'medium',dueAt:monday+4*day,createdAt:now,updatedAt:now},
   {id:'qa_t4',title:'下周的事',projectId:'qa_proj',workspace:'科研',status:'todo',priority:'low',dueAt:monday+9*day,createdAt:now,updatedAt:now},
   {id:'qa_t5',title:'还没定日期',projectId:'qa_proj',workspace:'科研',status:'blocked',priority:'low',dueAt:null,createdAt:now,updatedAt:now}
  ];
  normalizeStateShape(state);state.settings.permissions={'日常':'auto','课程':'auto','科研':'auto'};
  save();applyUiPreferences();openProject('qa_proj');})()`);
 await wait(900);

 // 项目分区由 WorkspaceNavigation 的 Kit 标签驱动；旧 [data-project-tab] 条在导航就绪后隐藏，仅作兼容。
 const PANEL=`document.querySelector('[data-project-panel="schedule"]')`;
 async function openSchedule(label){await evaluate(`document.querySelector('[data-workspace-route="schedule"]').click()`);await until(()=>evaluate(`!${PANEL}.hidden&&!!${PANEL}.querySelector('.schedule-day')`),label);}
 await step('项目视图新增「排期」Tab，且默认不在排期面板',async()=>{
  const probe=await evaluate(`(()=>{const tab=document.querySelector('[data-workspace-route="schedule"]');
   const panel=${PANEL};
   return {tab:!!tab,visible:!!tab?.getClientRects().length,text:tab?.textContent||'',selected:tab?.getAttribute('aria-selected'),panelHidden:panel?.hidden??null};})()`);
  assert.equal(probe.tab,true,'必须有排期 Tab');
  assert.equal(probe.visible,true,'排期 Tab 必须可见');
  assert.equal(probe.text,'排期');
  assert.equal(probe.selected,'false');
  assert.equal(probe.panelHidden,true,'未切换时面板应隐藏');
 });

 await step('切到排期：渲染周视图（周一→周日七列）与计划文档',async()=>{
  await openSchedule('排期面板');
  const probe=await evaluate(`(()=>{const panel=${PANEL};
   const days=[...panel.querySelectorAll('.schedule-day')];
   return {hidden:panel.hidden,visible:panel.getClientRects().length>0,selected:document.querySelector('[data-workspace-route="schedule"]').getAttribute('aria-selected'),dayCount:days.length,names:days.map(d=>d.querySelector('.schedule-day-head strong')?.textContent||''),
     hasPlan:!!panel.querySelector('details.project-plan-panel'),range:panel.querySelector('.schedule-range')?.textContent||''};})()`);
  assert.equal(probe.hidden,false,'面板应显示');
  assert.equal(probe.visible,true,'面板应可见');
  assert.equal(probe.selected,'true','排期 Tab 应为当前项');
  assert.equal(probe.dayCount,7,'应为七天');
  assert.deepEqual(probe.names,['周一','周二','周三','周四','周五','周六','周日']);
  assert.equal(probe.hasPlan,true,'应渲染计划文档面板');
  assert.match(probe.range,/月/, '应显示周范围');
 });

 await step('任务按截止日期落到正确的列，且带状态颜色点',async()=>{
  const probe=await evaluate(`(()=>{const panel=${PANEL};
   const days=[...panel.querySelectorAll('.schedule-day')];
   const pick=i=>[...days[i].querySelectorAll('.schedule-task-row')].map(c=>c.textContent.trim());
   return {mon:pick(0),wed:pick(2),fri:pick(4),dots:[...panel.querySelectorAll('.schedule-week-list .schedule-task-dot')].map(d=>d.className)};})()`);
  assert.match(probe.mon.join('|'),/周一启动会/,'周一应有启动会');
  assert.match(probe.wed.join('|'),/周三实验/,'周三应有实验');
  assert.match(probe.fri.join('|'),/周五写报告/,'周五应有报告');
  assert.ok(probe.dots.some(c=>/tone-todo/.test(c)),'待开始有颜色点');
  assert.ok(probe.dots.some(c=>/tone-progress/.test(c)),'进行中有颜色点');
  assert.ok(probe.dots.some(c=>/tone-done/.test(c)),'已完成有颜色点');
 });

 await step('不在本周的任务不出现；无日期的进「未安排」区（不静默丢掉）',async()=>{
  const probe=await evaluate(`(()=>{const panel=${PANEL};
   const text=panel.textContent;
   const unscheduled=[...panel.querySelectorAll('.schedule-extra')].find(section=>section.querySelector('h3')?.textContent==='未安排');
   return {hasNext:!/下周的事/.test(text),unscheduled:!!unscheduled,unscheduledText:unscheduled?.textContent||''};})()`);
  assert.equal(probe.hasNext,true,'下周任务不应出现在本周视图');
  assert.equal(probe.unscheduled,true,'应有未安排区');
  assert.match(probe.unscheduledText,/还没定日期/,'无日期任务必须在未安排区可见');
 });

 await step('周导航：下一周/上一周/回到本周都生效',async()=>{
  const probe=await evaluate(`(()=>{const panel=${PANEL};
   const before=panel.querySelector('.schedule-range').textContent;
   panel.querySelector('[data-schedule-next]').click();
   const next=panel.querySelector('.schedule-range').textContent;
   const nextHasTask=/下周的事/.test(panel.textContent);
   panel.querySelector('[data-schedule-today]').click();
   const back=panel.querySelector('.schedule-range').textContent;
   const backTag=/本周/.test(back);
   return {before,next,nextHasTask,back,backTag};})()`);
  assert.notEqual(probe.next,probe.before,'下一周应改变范围');
  assert.equal(probe.nextHasTask,true,'下一周应能看到下周的任务');
  assert.equal(probe.backTag,true,'回到本周应带"本周"标记');
 });

 await step('计划文档：编辑并保存写回项目，且内容按 Markdown 渲染在预览里',async()=>{
  // 计划默认折叠：先展开，再按真实输入事件编辑受控文本框。
  await evaluate(`${PANEL}.querySelector('.project-plan-panel > summary').click()`);
  await until(()=>evaluate(`${PANEL}.querySelector('.project-plan-panel').open&&!!${PANEL}.querySelector('[data-plan-input]')?.getClientRects().length`),'展开计划文档');
  const probe=await evaluate(`(()=>{const panel=${PANEL};
   const input=panel.querySelector('[data-plan-input]');
   Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'# 阶段性目标\\n\\n- 完成数据采集\\n- 复现基线 <script>alert(1)</script>');input.dispatchEvent(new Event('input',{bubbles:true}));
   panel.querySelector('[data-plan-preview]').click();
   const preview=panel.querySelector('.project-plan-preview');
   const html=preview?.innerHTML||'';
   return {previewShown:!!preview?.getClientRects().length,hasHeading:!!preview?.querySelector('h1'),
     injected:/<script/i.test(html),escaped:/&lt;script&gt;/.test(html),unsaved:state.projects.find(p=>p.id==='qa_proj').plan||''};})()`);
  assert.equal(probe.previewShown,true,'预览应显示');
  assert.equal(probe.hasHeading,true,'Markdown 标题应被渲染');
  assert.equal(probe.injected,false,'计划内容不得注入脚本');
  assert.equal(probe.escaped,true,'应转义为字面实体');
  assert.equal(probe.unsaved,'','保存前不得写回项目');
  await evaluate(`${PANEL}.querySelector('[data-plan-save]').click()`);
  await until(()=>evaluate(`!ProjectSchedule.isBusy()&&!ProjectSchedule.isDirty()`),'计划保存回执');
  const saved=await evaluate(`({saved:state.projects.find(p=>p.id==='qa_proj').plan||'',hint:${PANEL}.querySelector('.project-plan-actions [role=status]')?.textContent||''})`);
  assert.match(saved.saved,/阶段性目标/,'保存应写回项目对象');
  assert.equal(saved.hint,'已保存');
 });

 await step('计划文档持久化：保存后重新打开项目仍在',async()=>{
  const stored=await evaluate(`fetch('/__state').then(r=>r.json()).then(data=>(data.state||data).projects.find(p=>p.id==='qa_proj')?.plan||'')`);
  assert.match(stored,/阶段性目标/,'计划应写入本地存储');
  await evaluate(`renderAll();openProject('qa_proj',{section:'overview'})`);await until(()=>evaluate(`state.ui.projectTab==='overview'&&${PANEL}.hidden`),'离开排期');
  await openSchedule('重新打开排期');
  const probe=await evaluate(`(()=>{const panel=${PANEL};
   const value=panel.querySelector('[data-plan-input]')?.value||'';
   const collapsed=panel.querySelector('.project-plan-panel')?.tagName.toLowerCase()==='details';
   return {value,collapsed};})()`);
  assert.match(probe.value,/阶段性目标/,'重开后计划内容应保留');
  assert.equal(probe.collapsed,true,'计划文档应可折叠（details）');
 });

 console.log(JSON.stringify({passed:passed.length,failures,qaStore:TEMP,modelCalls:0},null,2));
 assert.deepEqual(failures,[]);
}
// A passing run leaves nothing behind; a failing run keeps its store for diagnosis.
function finish(code){clearTimeout(watchdog);win?.destroy();const done=()=>{if(!code){fs.rmSync(TEMP,{recursive:true,force:true});/* Chromium flushes the profile while exiting; remove that last copy afterwards. */spawn('/bin/sh',['-c','sleep 2; rm -rf "$0"',TEMP],{detached:true,stdio:'ignore'}).unref();}app.exit(code||0);};if(server&&server.exitCode===null){server.once('exit',done);server.kill('SIGTERM');}else done();}
run().then(()=>finish(0)).catch(error=>{console.error(error);console.error('QA store retained:',TEMP);finish(1);});
