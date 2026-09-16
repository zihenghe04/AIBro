import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHandler,schoolRequest} from '../api/ucas.mjs';
const base='https://iclass.ucas.edu.cn:8181/app/';
const login={url:base+'user/login.action',method:'POST',body:'phone=demo&password=fixture',headers:{Authorization:'Bearer forbidden',sessionId:'unused'}};
async function invoke(body, upstream, overrides={}) {
  const req={method:'POST',headers:{origin:'https://aibro-web.vercel.app','content-type':'application/json'},body,...overrides};
  const res={headers:{},setHeader(k,v){this.headers[k]=v;},end(body){this.body=JSON.parse(body);}};
  await createHandler(upstream)(req,res);return res;
}
test('school login independent of sync; fixed protocol and no cloud key forwarded', async()=>{
  let outgoing;
  const res=await invoke(login,async(url,options)=>{outgoing={url,options};return Response.json({STATUS:'0',result:{sessionId:'demo-only'}});});
  assert.equal(res.statusCode,200);assert.equal(outgoing.url,login.url);
  assert.equal(outgoing.options.headers.Authorization,undefined);
  assert.equal(outgoing.options.headers.sessionId,undefined);
  const form=new URLSearchParams(outgoing.options.body);
  assert.equal(form.get('phone'),'demo');assert.equal(form.get('verificationType'),'1');
  assert.match(outgoing.options.headers['User-Agent'],/20__110000$/);
  assert.equal(res.headers['Cache-Control'],'private, no-store');
});
test('fixed transport rejects arbitrary origin, path, method and invalid session',()=>{
  for(const patch of [{url:'https://example.com/'},{url:base+'../admin'},{method:'GET'},{url:base+'user/login.action#fragment'}]) assert.throws(()=>schoolRequest({...login,...patch}));
  const course={url:base+'course/get_stu_course_sched.action',method:'POST',body:'id=123&dateStr=20260916'};
  for(const sessionId of ['',null,'x\r\ny']) assert.throws(()=>schoolRequest({...course,headers:{sessionId}}));
  assert.equal(schoolRequest({...course,headers:{sessionId:'A'}}).options.headers.sessionId,'A');
  assert.equal(schoolRequest({...course,headers:{sessionId:'B'}}).options.headers.sessionId,'B');
  assert.equal(schoolRequest({url:base+'common/get_timestamp.do?id=7',method:'POST'}).url,base+'common/get_timestamp.do?id=0');
  assert.throws(()=>schoolRequest({...login,body:login.body+'&phone=second'}));
});
test('origin and method checked before upstream; errors never echo credentials',async()=>{
  const never=()=>{throw Error('must not call');};
  assert.equal((await invoke(login,never,{headers:{origin:'https://evil.example'}})).statusCode,403);
  assert.equal((await invoke(login,never,{method:'GET'})).statusCode,405);
  assert.equal((await invoke('not-json',never)).statusCode,400);
  assert.equal((await invoke('x'.repeat(8193),never)).statusCode,413);
  const fail=await invoke(login,()=>{throw Error('private password fixture');});
  assert.deepEqual(fail.body,{code:'school_unavailable'});
  assert.equal((await invoke(login,async()=>new Response('private',{status:401}))).statusCode,401);
  assert.equal((await invoke(login,async()=>new Response('private',{status:500}))).statusCode,502);
  assert.equal((await invoke(login,async()=>new Response('x'.repeat(2*1024*1024+1)))).statusCode,502);
});
