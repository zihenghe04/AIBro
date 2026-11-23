/* Isolated motion benchmark: streaming cadence, renderer CPU, long transcript
   scrolling and first paint. Synthetic transport only; outbound requests denied.
   Usage: node_modules/.bin/electron tests/motion-bench.cjs [out.json] [shotDir] */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),net=require('node:net');
const {spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..'),PORT=Number(process.env.MOTION_BENCH_PORT||18931),ORIGIN=`http://127.0.0.1:${PORT}`;
const OUT=process.argv.find(a=>a.endsWith('.json')),SHOTS=process.argv.find(a=>!a.endsWith('.json')&&a.includes('shots'));
const TEMP=fs.mkdtempSync(path.join(os.tmpdir(),'aw-motion-bench-')),STORE=path.join(TEMP,'store');fs.mkdirSync(STORE);fs.mkdirSync(path.join(TEMP,'profile'));app.setPath('userData',path.join(TEMP,'profile'));
let server,win;const wait=ms=>new Promise(r=>setTimeout(r,ms));
const request=route=>new Promise((resolve,reject)=>http.get(ORIGIN+route,r=>{r.resume();r.on('end',()=>resolve({status:r.statusCode}));}).on('error',reject));
async function until(fn,label,timeout=20000){const start=Date.now();while(Date.now()-start<timeout){if(await fn())return;await wait(40);}throw Error(`Timed out: ${label}`);}
const watchdog=setTimeout(()=>{console.error('bench timeout',TEMP);win?.destroy();server?.kill('SIGTERM');app.exit(1);},180000);
// Deterministic bursty arrival: small steady chunks with occasional proxy stalls and catch-up bursts.
function arrivals(total,seed=7){let s=seed;const rnd=()=>(s=(s*1103515245+12345)%2147483648)/2147483648;const out=[];let at=0,sent=0;while(sent<total){const stall=rnd()<.12;at+=stall?300+rnd()*350:35+rnd()*90;const size=stall?80+Math.floor(rnd()*140):3+Math.floor(rnd()*14);sent=Math.min(total,sent+size);out.push({at:Math.round(at),end:sent});}return out;}
const ANSWER_PART=['## 课程资料核对结果','','这门课的考核由三部分组成：平时作业、期中项目和期末论文。下面按资料原文逐项说明，并标出仍需向老师确认的地方。','','- **平时作业 15%**：共八次，每次按时提交即可得基础分，迟交一周内扣一半。','- **期中项目 45%**：三到四人一组，需要提交中期报告和最终演示，评分表在第 46 页。','- **期末论文 40%**：不少于六千字，引用格式按课程网站给出的模板。','','### 实践要求','','第 47 页写明实践环节必须在第十二周前完成，但没有说明是否可以用课外项目替代。建议在下次答疑时直接询问，并把回答记到项目备注里，避免期末前才发现不符合要求。','','### 下一步','','1. 把三次截止日期加进日程，提前一周提醒。','2. 在项目里建立分组表，记录每位成员负责的部分。','3. 期中项目的评分表已经存成笔记，可以随时对照检查。','','以上内容都来自你上传的课程大纲，没有引用外部资料。如果大纲后续有更新，重新导入后我会再核对一遍差异。'].join('\n');
const ANSWER=ANSWER_PART+'\n\n'+ANSWER_PART.replace('## 课程资料核对结果','## 第二部分：往年同类课程对照')+'\n\n'+ANSWER_PART.replace('## 课程资料核对结果','## 第三部分：风险与建议');
async function run(){
 await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',()=>reject(Error(`${PORT} occupied`)));probe.listen(PORT,'127.0.0.1',()=>probe.close(resolve));});
 const log=fs.openSync(path.join(TEMP,'server.log'),'a');server=spawn(process.env.PYTHON||'python3',[path.join(ROOT,'app','server.py')],{cwd:ROOT,env:{...process.env,AI_WORKSTATION_PORT:String(PORT),AI_WORKSTATION_DATA_DIR:STORE,AI_WORKSTATION_ASSET_DIR:path.join(ROOT,'app')},stdio:['ignore',log,log]});
 await until(async()=>{if(server.exitCode!==null)throw Error('service exited');try{return(await request('/__health')).status===200;}catch{return false;}},'service');
 await app.whenReady();win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
 win.webContents.session.webRequest.onBeforeRequest({urls:['<all_urls>']},(d,cb)=>{const u=new URL(d.url);cb({cancel:['http:','https:'].includes(u.protocol)&&(u.origin!==ORIGIN||/^\/__(proxy|codex\/respond|auth\/(login|logout)|cloud\/connect)/.test(u.pathname))});});
 const evaluate=code=>win.webContents.executeJavaScript(code,true);
 const loadStart=Date.now();await win.loadURL(ORIGIN);await until(()=>evaluate('typeof storageHydrated!=="undefined"&&storageHydrated'),'hydration');
 const result={commit:process.env.MOTION_BENCH_LABEL||'',firstPaint:await evaluate(`(()=>{const p=performance.getEntriesByType('paint');const f=n=>Math.round(p.find(e=>e.name===n)?.startTime||0);return{firstPaint:f('first-paint'),firstContentfulPaint:f('first-contentful-paint'),domContentLoaded:Math.round(performance.getEntriesByType('navigation')[0]?.domContentLoadedEventEnd||0)}})()`)};
 result.firstPaint.hydratedAfterLoadMs=Date.now()-loadStart;
 await evaluate(`(()=>{const now=Date.now();state.projects=[];state.notes=[];state.tasks=[];state.imports=[];state.agentRuns=[];state.conversations=[{id:'bench',title:'动效基准',workspace:'课程',permissionMode:'auto',attachments:[],draftAttachmentIds:[],draft:'',messages:[],createdAt:now}];state.currentConversationId='bench';state.settings.permissions={'日常':'auto','课程':'auto','科研':'auto'};normalizeStateShape(state);state.ui.inspectorOpen=false;WorkstationOnboarding.close();state.ui.onboarding={version:WorkstationOnboarding.VERSION,status:'skipped'};state.ui.theme='light';save();applyUiPreferences();showView('agent','对话');renderAll();$('#apiBase').value='https://fixture.invalid/v1';$('#apiKey').value='isolated-test-placeholder';ConversationModels.configuration=()=>({provider:'api',model:'Bench isolated model',effort:'medium'});ConversationModels.resolve=async value=>value;AgentTransport.requestPlan=options=>{options.onPhase?.('reasoning');return new Promise((resolve,reject)=>{window.__bench={options,resolve,reject};});};})()`);
 // Streaming cadence: sample visible answer length every frame, outside the progress block.
 const raw=JSON.stringify({workspace:'课程',message:ANSWER,actions:[]});const plan=arrivals(raw.length);
 await evaluate(`$('#agentInput').value='整理课程考核要求';$('#agentInput').dispatchEvent(new Event('input',{bubbles:true}));$('#agentSend').click()`);
 console.error('phase send');await until(()=>evaluate('!!window.__bench'),'transport');console.error('phase stream');
 await evaluate(`__bench.options.onActivity({kind:'summary',id:'s',status:'completed',text:'已读取课程大纲。'})`);await wait(300);
 await evaluate(`(()=>{const list=$('#messageList');const s=window.__sample={frames:[],long:0,stop:false};const id=currentConversation().messages.at(-1).id;let last=performance.now();
  const measure=()=>{const m=list.querySelector('[data-message-id="'+id+'"]');if(!m)return 0;const p=m.querySelector('.agent-progress');return m.textContent.length-(p?p.textContent.length:0);};
  try{new PerformanceObserver(l=>{for(const e of l.getEntries())if(e.duration>50)s.long++;}).observe({type:'long-animation-frame',buffered:false});}catch{}
  const tick=now=>{s.frames.push([Math.round(now),measure(),Math.round(list.scrollHeight-list.scrollTop-list.clientHeight)]);last=now;if(!s.stop)requestAnimationFrame(tick);};requestAnimationFrame(tick);})()`);
 const cpu=[];const pid=win.webContents.getOSProcessId();app.getAppMetrics();
 const cpuTimer=setInterval(()=>{const m=app.getAppMetrics().find(x=>x.pid===pid);if(m)cpu.push(m.cpu.percentCPUUsage);},250);
 const shotsAt=new Set([600,1200,1800]);const t0=Date.now();
 for(const item of plan){const delay=item.at-(Date.now()-t0);if(delay>0)await wait(delay);const text=raw.slice(0,item.end);await evaluate(`__bench.options.onDelta(${JSON.stringify(text)},'',{attemptId:'a1'})`);
  if(SHOTS)for(const at of shotsAt)if(Date.now()-t0>=at){shotsAt.delete(at);fs.writeFileSync(path.join(SHOTS,`app-stream-${process.env.MOTION_BENCH_LABEL||'run'}-${at}ms.png`),(await win.webContents.capturePage()).toPNG());}}
 console.error('phase resolve');const lastArrival=Date.now();await wait(120);
 const resolvedAt=await evaluate(`(()=>{const t=performance.now();__bench.resolve(${JSON.stringify(raw)});return Math.round(t)})()`);
 await until(()=>evaluate('!sendMessage.busy'),'completed');await wait(400);clearInterval(cpuTimer);
 const samples=await evaluate('(()=>{__sample.stop=true;return{frames:__sample.frames,long:__sample.long}})()');
 const frames=samples.frames,changes=[];for(let i=1;i<frames.length;i++)if(frames[i][1]!==frames[i-1][1])changes.push({t:frames[i][0],jump:frames[i][1]-frames[i-1][1],len:frames[i][1]});
 const finalLen=frames.at(-1)[1],grow=changes.filter(c=>c.jump>0&&c.t<resolvedAt),gaps=grow.slice(1).map((c,i)=>c.t-grow[i].t),sorted=a=>[...a].sort((x,y)=>x-y),pct=(a,p)=>a.length?sorted(a)[Math.min(a.length-1,Math.floor(a.length*p))]:0;
 const frameGaps=frames.slice(1).map((f,i)=>f[0]-frames[i][0]),span=(grow.at(-1)?.t-grow[0]?.t)||1;
 result.stream={rawChars:raw.length,arrivals:plan.length,arrivalSpanMs:plan.at(-1).at,visibleUpdates:grow.length,updatesPerSec:+(grow.length/(span/1000)).toFixed(1),medianJumpChars:pct(grow.map(c=>c.jump),.5),p95JumpChars:pct(grow.map(c=>c.jump),.95),maxJumpChars:Math.max(...grow.map(c=>c.jump)),medianGapMs:pct(gaps,.5),p95GapMs:pct(gaps,.95),maxGapMs:Math.max(...gaps),
  settleAfterResolveMs:(changes.filter(c=>c.len===finalLen).at(0)?.t??resolvedAt)-resolvedAt,droppedFrames:frameGaps.filter(g=>g>25).length,frameCount:frames.length,longAnimationFrames:samples.long,
  cpuMeanPct:+(cpu.reduce((a,b)=>a+b,0)/Math.max(1,cpu.length)).toFixed(1),cpuP95Pct:+pct(cpu,.95).toFixed(1),scrollBehindMaxPx:Math.max(...frames.map(f=>f[2]))};
 result.stream.lastArrivalToResolveMs=120;void lastArrival;
 console.error('phase scroll');
 // Long transcript scroll: 120 rendered messages, scrolled by script each frame.
 await evaluate(`(()=>{const c=currentConversation(),now=Date.now();for(let i=0;i<120;i++)c.messages.push({id:'bench-'+i,role:i%2?'assistant':'user',text:i%2?${JSON.stringify(ANSWER)}:'第 '+i+' 个问题：请继续整理。',createdAt:now+i});renderAll();})()`);console.error('phase seeded');await wait(800);
 result.scroll=await evaluate(`new Promise(done=>{const list=$('#messageList');list.scrollTop=list.scrollHeight;const gaps=[];let last=0,n=0,long=0;try{new PerformanceObserver(l=>{for(const e of l.getEntries())if(e.duration>50)long++;}).observe({type:'long-animation-frame'});}catch{}
  const step=now=>{try{if(last)gaps.push(now-last);last=now;list.scrollTop-=40;if(++n<180&&list.scrollTop>0)requestAnimationFrame(step);else{const s=[...gaps].sort((a,b)=>a-b);done({frames:gaps.length,meanFrameMs:+(gaps.reduce((a,b)=>a+b,0)/gaps.length).toFixed(1),p95FrameMs:+s[Math.floor(s.length*.95)].toFixed(1),maxFrameMs:+s.at(-1).toFixed(1),over25ms:gaps.filter(g=>g>25).length,longAnimationFrames:long,scrollHeight:list.scrollHeight});}}catch(e){done({error:String(e),sh:list.scrollHeight,ch:list.clientHeight,kids:list.children.length,msgs:currentConversation().messages.length,st:list.scrollTop,ov:getComputedStyle(list).overflowY})}};requestAnimationFrame(step);setTimeout(()=>done({error:'timeout',n}),15000);})`);
 console.log(JSON.stringify(result,null,1));if(OUT)fs.writeFileSync(OUT,JSON.stringify({...result,streamTrace:changes},null,1));
}
run().then(()=>{clearTimeout(watchdog);win?.destroy();server?.kill('SIGTERM');fs.rmSync(TEMP,{recursive:true,force:true});app.exit(0);},error=>{console.error(error.stack);clearTimeout(watchdog);win?.destroy();server?.kill('SIGTERM');app.exit(1);});
