const test=require('node:test'),assert=require('node:assert/strict');
const Sites=require('../app/browser-site-policy');

function fixture({unknownSites='auto',allow=[],deny=[]}={}){
  const saved={allow:[...allow],deny:[...deny],unknownSites},writes=[],timers=[];
  const store={read:()=>saved,save:async(origin,decision)=>{writes.push([origin,decision]);saved[decision].push(origin);}};
  let clock=1000;
  const policy=Sites.create({store,now:()=>clock,setTimer:(fn,ms)=>{const t={fn,ms,cleared:false};timers.push(t);return t;},clearTimer:t=>{if(t)t.cleared=true;}});
  return {policy,saved,writes,timers,tick:ms=>{clock+=ms;for(const t of timers)if(!t.cleared&&t.ms<=ms){t.cleared=true;t.fn();}}};
}
const run=(extra={})=>({id:'run1',conversationId:'c1',permissionMode:'smart',...extra});

test('origins: only http(s) without credentials; user-written addresses end at CJK punctuation',()=>{
  assert.equal(Sites.originOf('https://Example.org/a?b'),'https://example.org');
  assert.equal(Sites.originOf('http://a.org:8080/x'),'http://a.org:8080');
  for(const bad of ['javascript:alert(1)','file:///etc/passwd','https://u:p@a.org','not a url'])assert.equal(Sites.originOf(bad),null);
  assert.deepEqual(Sites.explicitOrigins('打开 https://a.org/x，然后看 http://b.org:81/y。还有 (https://c.org/z) 和 https://a.org/again.'),['https://a.org','http://b.org:81','https://c.org']);
  assert.deepEqual(Sites.explicitOrigins('去 example.com 看看'),[],'a bare domain is not an address the user wrote');
});

test('decision order: deny, always, session, once, user-written, then mode',async()=>{
  const {policy}=fixture({allow:['https://ok.org'],deny:['https://bad.org']});
  const r=run({permissionMode:'request'});
  assert.equal(policy.check({run:r,url:'https://bad.org/x',userText:'https://bad.org/x'}).decision,'deny','a user-written address does not lift a denial');
  assert.deepEqual(policy.check({run:r,url:'https://ok.org/p'}),{decision:'allow',reason:'always',origin:'https://ok.org'});
  assert.deepEqual(policy.check({run:r,url:'https://new.org/'}),{decision:'ask',reason:'unknown',origin:'https://new.org'});
  assert.equal(policy.check({run:r,url:'https://mine.org/a',userText:'请看 https://mine.org/b'}).reason,'explicit');
  assert.equal(policy.check({run:r,url:'https://mine.org/c'}).reason,'once','the user-written site stays allowed for this run');
  assert.equal(policy.check({run:run({id:'run2',permissionMode:'request'}),url:'https://mine.org/c'}).decision,'ask','but not for the next run');
});

test('unknown sites: automatic as before unless request mode or the browser setting asks',()=>{
  assert.equal(fixture().policy.check({run:run(),url:'https://x.org'}).decision,'allow');
  assert.equal(fixture().policy.check({run:run({permissionMode:'full'}),url:'https://x.org'}).reason,'auto');
  assert.equal(fixture({unknownSites:'ask'}).policy.check({run:run({permissionMode:'full'}),url:'https://x.org'}).decision,'ask');
  assert.equal(fixture().policy.check({run:run(),url:'javascript:1'}).reason,'not-a-site');
});

test('the four answers: once (run), session (conversation), always and deny (device lists)',async()=>{
  const {policy,writes,saved}=fixture({unknownSites:'ask'});
  const ask=(r,url)=>{const origin=Sites.originOf(url);const p=policy.ask({run:r,url,origin});return {p,id:policy.list(r.id).find(i=>i.origin===origin).id};};
  let q=ask(run(),'https://once.org');await policy.decide(q.id,'once');assert.equal(await q.p,'once');
  assert.equal(policy.check({run:run(),url:'https://once.org/2'}).reason,'once');
  assert.equal(policy.check({run:run({id:'run9'}),url:'https://once.org/2'}).decision,'ask');
  q=ask(run(),'https://sess.org');await policy.decide(q.id,'session');await q.p;
  assert.equal(policy.check({run:run({id:'run9'}),url:'https://sess.org'}).reason,'session');
  assert.equal(policy.check({run:run({id:'run9',conversationId:'c2'}),url:'https://sess.org'}).decision,'ask');
  policy.endConversation('c1');assert.equal(policy.check({run:run({id:'run9'}),url:'https://sess.org'}).decision,'ask');
  q=ask(run(),'https://keep.org');await policy.decide(q.id,'always');await q.p;
  q=ask(run(),'https://nope.org');await policy.decide(q.id,'deny');assert.equal(await q.p,'deny');
  assert.deepEqual(writes,[['https://keep.org','allow'],['https://nope.org','deny']]);
  assert.equal(policy.check({run:run({id:'x',conversationId:'z'}),url:'https://keep.org'}).reason,'always');
  assert.equal(policy.check({run:run({id:'x',conversationId:'z'}),url:'https://nope.org'}).decision,'deny');
  await assert.rejects(policy.decide(ask(run(),'https://y.org').id,'forever'),/Unknown site decision/);
  assert.equal(await policy.decide('missing','once'),false);
  assert.ok(saved.allow.includes('https://keep.org'));
});

test('a pending question expires after 10 minutes, is shared per site, and stops with the run',async()=>{
  const {policy,timers,tick}=fixture({unknownSites:'ask'});
  const first=policy.ask({run:run(),url:'https://slow.org/a',origin:'https://slow.org'});
  const again=policy.ask({run:run(),url:'https://slow.org/b',origin:'https://slow.org'});
  assert.equal(first,again);assert.equal(policy.list().length,1);
  assert.equal(timers[0].ms,10*60*1000);
  const item=policy.list()[0];assert.equal(item.expiresAt-item.createdAt,600000);
  tick(599999);assert.equal(policy.list().length,1);
  tick(600000);assert.equal(await first,'timeout');assert.equal(policy.list().length,0);
  const controller=new AbortController();
  const stopped=policy.ask({run:run(),url:'https://stop.org',origin:'https://stop.org',signal:controller.signal});
  controller.abort();assert.equal(await stopped,'cancelled');
  const ended=policy.ask({run:run(),url:'https://end.org',origin:'https://end.org'});
  policy.endRun('run1');assert.equal(await ended,'cancelled');
});

test('pages that need a person: password fields and human checks',()=>{
  const page=(extra)=>({title:'T',url:'https://a.org',text:'hello',elements:[{ref:'e1',name:'Search',sensitive:false}],...extra});
  assert.equal(Sites.humanCheck(page()),null);
  assert.equal(Sites.humanCheck(page({elements:[{ref:'e1',name:'Password',sensitive:true}]})),'login');
  assert.equal(Sites.humanCheck(page({text:'Please verify you are human'})),'captcha');
  assert.equal(Sites.humanCheck(page({title:'安全验证'})),'captcha');
  assert.equal(Sites.humanCheck(page({url:'https://www.google.com/recaptcha/api2/anchor'})),'captcha');
  assert.equal(Sites.humanCheck({url:'https://a.org',title:'验证码'}),null,'only observations with elements (snapshot/screenshot)');
  assert.equal(Sites.humanCheck(null),null);
});
