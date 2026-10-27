// The browser plugin over the real BrowserTools with a mock native bridge
// (same style as browser-tools.test.cjs). Site permission, the sign-in/CAPTCHA
// pause and the dispatch through ReadTools. No WKWebView here.
const {test}=require('node:test'),assert=require('node:assert/strict');
const B=require('../app/browser-tools.js'),Plugin=require('../app/plugin-browser.js'),Sites=require('../app/browser-site-policy.js');
const ReadTools=require('../app/read-tools.js');
const session=(o={})=>({sessionId:'session',tabId:'tab',status:'ready',url:'https://example.com/',title:'Example',...o});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({respond=async data=>session(data.action==='snapshot'?{snapshotId:'s1',elements:[],text:'page'}:{}),mode='smart',goal='看看网页',store={allow:[],deny:[],unknownSites:'auto'},pendingMs}={}){
  const original=global.workstationDesktop;
  const run={id:'run',conversationId:'chat',projectId:null,status:'running',permissionMode:mode,goal};
  const state={agentRuns:[run],projects:[],conversations:[{id:'chat',projectId:null}]};
  const calls=[],saved=[];
  global.workstationDesktop={browser:{request:async data=>{calls.push(data);return respond(data);}}};
  B.init({getState:()=>state,save(){},render(){}});
  const policy=Sites.create({store:{read:()=>store,save:async(origin,decision)=>{saved.push([origin,decision]);store[decision].push(origin);}},...(pendingMs?{pendingMs}:{})});
  const execute=Plugin.createExecutor({tools:()=>B,sites:()=>policy});
  const controller=new AbortController();
  const ctx={run,getState:()=>state,save(){},refresh(){},signal:controller.signal};
  return {run,state,calls,saved,policy,controller,store,call:(request,options)=>execute(request,ctx,options),restore(){B.init({});global.workstationDesktop=original;}};
}

test('automatic modes open any allowed site exactly as before (no site flag, same native request)',async()=>{
  const h=fixture();
  try{
    const viaPlugin=await h.call({type:'browser_open',url:'https://example.com'});
    assert.equal(h.calls[0].action,'open');assert.equal(h.calls[0].siteApproved,undefined);assert.equal(h.calls[0].browserPermission,'auto');
    assert.equal(viaPlugin.browserContentIsUntrusted,true);assert.equal(viaPlugin.humanRequired,undefined);
    assert.deepEqual(h.policy.list(),[]);
  }finally{h.restore();}
});

test('a denied site is refused before the native browser is asked',async()=>{
  const h=fixture({store:{allow:[],deny:['https://bad.org'],unknownSites:'auto'},goal:'打开 https://bad.org'});
  try{
    await assert.rejects(h.call({type:'browser_open',url:'https://bad.org/page'}),{code:'SITE_DENIED'});
    assert.equal(h.calls.length,0);
  }finally{h.restore();}
});

test('request mode asks about an unknown site; the answer admits it and the native page does not ask again',async()=>{
  const h=fixture({mode:'request'});
  try{
    const pending=h.call({type:'browser_open',url:'https://new.org/a'});
    await tick();
    const [question]=h.policy.list('run');assert.equal(question.origin,'https://new.org');assert.equal(h.calls.length,0,'nothing opens while the question is open');
    await h.policy.decide(question.id,'session');await pending;
    assert.equal(h.calls[0].siteApproved,true);assert.equal(h.calls[0].browserPermission,'ask','interactions still ask natively in request mode');
    // Same conversation, a later run: allowed without a question.
    assert.equal(h.policy.check({run:{...h.run,id:'run2'},url:'https://new.org/b'}).reason,'session');
  }finally{h.restore();}
});

test('the four answers are once, conversation, always and block; block and always are saved device-locally',async()=>{
  for(const [choice,expect] of [['once',null],['always',['https://s.org','allow']],['deny',['https://s.org','deny']]]){
    const h=fixture({mode:'request'});
    try{
      const pending=h.call({type:'browser_open',url:'https://s.org'});await tick();
      await h.policy.decide(h.policy.list('run')[0].id,choice);
      if(choice==='deny'){await assert.rejects(pending,{code:'SITE_DENIED'});assert.equal(h.calls.length,0);}
      else{await pending;assert.equal(h.calls[0].siteApproved,true);}
      assert.deepEqual(h.saved,expect?[expect]:[]);
    }finally{h.restore();}
  }
});

test('an address the user wrote is admitted for this run without a question',async()=>{
  const h=fixture({mode:'request',goal:'请打开 https://paper.org/abs/1 并总结'});
  try{
    await h.call({type:'browser_open',url:'https://paper.org/abs/1'});
    assert.equal(h.calls[0].siteApproved,true);assert.deepEqual(h.policy.list(),[]);
    const pending=h.call({type:'browser_open',url:'https://other.org'});await tick();
    assert.equal(h.policy.list('run').length,1,'other sites still ask');
    h.controller.abort();await assert.rejects(pending,{code:'CANCELLED'});
  }finally{h.restore();}
});

test('an unanswered question times out as a refusal; the wait is not a browser operation',async()=>{
  const h=fixture({mode:'request',pendingMs:20});
  try{
    const started=Date.now();
    await assert.rejects(h.call({type:'browser_open',url:'https://slow.org'}),{code:'SITE_PENDING_TIMEOUT'});
    assert.ok(Date.now()-started>=15);assert.equal(h.calls.length,0);
    assert.equal(h.run.browserSession,undefined,'no browser operation was started or counted');
  }finally{h.restore();}
});

test('a sign-in or CAPTCHA page pauses the page for the user once, and the next operation waits for resume',async()=>{
  let resumed=false;
  const h=fixture({respond:async data=>{
    if(data.action==='snapshot')return session({snapshotId:'s1',text:'Sign in',elements:[{ref:'e1',name:'Password',sensitive:true}]});
    if(data.action==='takeover'&&!data.waitForResume)return session({status:'paused'});
    if(data.action==='takeover'&&data.waitForResume){resumed=true;return session({status:'ready'});}
    return session();
  }});
  try{
    await h.call({type:'browser_open',url:'https://example.com'});
    const observed=await h.call({type:'browser_snapshot'});
    assert.equal(observed.humanRequired.reason,'login');assert.match(observed.humanRequired.notice,/继续 Agent/);
    assert.equal(h.run.browserSession.status,'paused');
    const pause=h.calls.find(c=>c.action==='takeover');assert.equal(pause.waitForResume,false);assert.equal(pause.runId,'run');
    // Next agent operation: BrowserTools holds it until the user resumes.
    const again=await h.call({type:'browser_snapshot'});
    assert.equal(resumed,true);
    assert.equal(again.humanRequired,undefined,'the same page does not pause twice in a run');
    assert.equal(h.calls.filter(c=>c.action==='takeover'&&!c.waitForResume).length,1);
  }finally{h.restore();}
});

test('ReadTools dispatches browser requests through the plugin when it is present',async()=>{
  const seen=[];
  const plugin={execute:async(request,ctx,{approval})=>{seen.push([request.type,approval]);return {ok:true};}};
  const ctx={run:{id:'r'},getState:()=>({}),validate(){},agentContext:()=>null,fallback:()=>{throw Error('fallback');},
    lookup:name=>({AIBroBrowserPlugin:plugin,BrowserTools:{execute:()=>{throw Error('bypassed plugin');}}})[name]};
  await ReadTools.create(ctx).execute({type:'browser_snapshot'},{approval:'ask'});
  assert.deepEqual(seen,[['browser_snapshot','ask']]);
});

test('the run card lists open site questions with the four choices',async()=>{
  const {parseHTML}=require('linkedom');const {document}=parseHTML('<!doctype html><html><body></body></html>');
  const originalDocument=global.document;global.document=document;
  const h=fixture({mode:'request'});
  try{
    const sites=Plugin.sites();// the shared policy the card reads
    const pending=sites.ask({run:h.run,url:'https://q.org/x',origin:'https://q.org'});
    const card=Plugin.card(h.run);
    assert.deepEqual([...card.querySelectorAll('[data-site-decision]')].map(b=>b.dataset.siteDecision),['once','session','always','deny']);
    assert.match(card.textContent,/https:\/\/q\.org/);assert.match(card.textContent,/10 分钟/);
    card.querySelector('[data-site-decision="once"]').onclick();
    assert.equal(await pending,'once');
    assert.equal(Plugin.card(h.run),null,'no question and no browser session: no card');
  }finally{h.restore();global.document=originalDocument;}
});

test('native page: site approval from the workspace, 10-minute approval limit, waits not counted as page loading',()=>{
  const source=require('node:fs').readFileSync(require('node:path').join(__dirname,'../native/Sources/AIBro/NativeBrowser.swift'),'utf8');
  assert.match(source,/request\["siteApproved"\] as\? Bool == true \{allowedOrigins\.insert\(Self\.origin\(url\)\)\}/);
  assert.match(source,/approvalTimeout:UInt64=600_000_000_000/);
  // Both kinds of native question (action and navigation) arm the limit and report it distinctly.
  assert.equal((source.match(/armApprovalTimeout\(\);changed\(\)/g)||[]).length,2);
  assert.equal((source.match(/"APPROVAL_TIMEOUT"/g)||[]).length,2);
  assert.match(source,/if self\.status != "awaiting-approval" && !self\.paused \{loading\+=500_000_000\}/);
});
