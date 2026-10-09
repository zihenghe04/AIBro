import test from 'node:test';
import assert from 'node:assert/strict';
import { messageSources } from '../src/message-sources.js';
const state = () => ({records:Object.fromEntries([
  ['notes:n',{id:'n',title:'当前笔记',content:'body'}],
  ['tasks:n',{id:'n',title:'不同类型的同 ID 任务'}],
  ['imports:i',{id:'i',name:'原件.pdf'}],
  ['papers:p',{id:'p',title:'论文',noteId:'n'}],
].map(([key,data])=>[key,{data,deleted:false}]))});
const resolve = (s,sources) => messageSources(s,{retrievedSources:sources});

test('desktop singular and mobile collection identities open the same current source',()=>{
 const s=state();
 const rows=resolve(s,[{type:'note',id:'n'},{kind:'notes',id:'n',citation:7},{type:'import',id:'i'},{type:'task',id:'n'}]);
 assert.deepEqual(rows.map(r=>r.target),[{kind:'notes',id:'n'},{kind:'notes',id:'n'},{kind:'imports',id:'i'},{kind:'tasks',id:'n'}]);
 assert.equal(rows[1].label,7);assert.equal(rows[0].title,'当前笔记');
});
test('unknown, contradictory, malformed and missing references never guess by ID',()=>{
 for(const source of [{id:'n'},{type:'local',id:'n'},{type:'task',kind:'notes',id:'n'},{kind:'notes',id:'missing'},null,{kind:'notes',id:'../n'}])
  assert.equal(resolve(state(),[source])[0].target,null);
});
test('source privacy, owner privacy, deletion and conflict hide cached titles and prevent opening',()=>{
 const source={type:'note',id:'n',title:'cached private title'};
 for(const flag of ['private','archived','deletedAt','hidden']){
  const s=state();s.records['notes:n'].data[flag]=true;
  assert.deepEqual(resolve(s,[source])[0],{index:0,label:1,title:'来源不可用',target:null});
 }
 const s=state();s.records['notes:n'].data.projectId='owner';s.records['projects:owner']={data:{id:'owner',private:true}};
 assert.equal(resolve(s,[source])[0].title,'来源不可用');
 delete s.records['projects:owner'];s.records['notes:n'].conflict={};
 assert.equal(resolve(s,[source])[0].target,null);
});
test('desktop paper opens only its explicit current note or explains the desktop-only target',()=>{
 const s=state(),source={type:'paper',id:'p'};
 assert.deepEqual(resolve(s,[source])[0].target,{kind:'notes',id:'n'});
 delete s.records['papers:p'].data.noteId;
 assert.equal(resolve(s,[source])[0].target,null);
 assert.match(resolve(s,[source])[0].title,/请在 Mac 查看/);
});
