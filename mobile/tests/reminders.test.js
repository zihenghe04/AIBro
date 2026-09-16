import test from 'node:test';
import assert from 'node:assert/strict';
import {Store,MemoryAdapter} from '../src/store.js';
import {ask} from '../src/ai.js';
import {eventsFor} from '../src/agenda.js';
test('chat creates one durable reminder and shopping list without model credentials',async()=>{
 const adapter=new MemoryAdapter(),store=await new Store(adapter).load();
 const result=await ask({store,prompt:'明天晚上8点提醒我买熨斗，洗衣液，护发素，袜子',http:()=>{throw Error('unexpected network')},vault:{get:()=>{throw Error('unexpected credential read')}}});
 assert.match(result.text,/开启本机通知/);assert.equal(store.list('tasks').length,1);assert.equal(store.list('tasks')[0].checklist.length,4);assert.equal(store.list('messages').length,2);
 const loaded=await new Store(adapter).load(),task=loaded.list('tasks')[0];assert.equal(task.reminderMinutes,0);
 let events=eventsFor(loaded,Date.now(),Date.now()+3*86400000);assert.equal(events[0].reminderAt,Date.parse(task.dueAt));
 await loaded.put('tasks',{...task,status:'done'});assert.equal(eventsFor(loaded,Date.now(),Date.now()+3*86400000).length,0);
});
test('deadline defaults, overrides, date-only local 09:00 and close deadlines',async()=>{
 const store=await new Store(new MemoryAdapter()).load(),now=Date.now(),due=now+30*60000;
 await store.put('tasks',{id:'t',title:'Synthetic',status:'todo',dueAt:due,updatedAt:now});
 assert.equal(eventsFor(store,now,now+86400000)[0].reminderAt,due);
 await store.put('tasks',{...store.get('tasks','t'),reminderMinutes:null});assert.equal(eventsFor(store,now,now+86400000)[0].reminderAt,null);
 await store.put('tasks',{...store.get('tasks','t'),reminderMinutes:15});assert.equal(eventsFor(store,now,now+86400000)[0].reminderAt,due-15*60000);
 await store.remove('tasks','t');assert.equal(eventsFor(store,now,now+86400000).length,0);
 await store.put('tasks',{id:'d',title:'Day',dueAt:'2026-10-01'});const d=eventsFor(store,new Date(2026,9,1).getTime(),new Date(2026,9,2).getTime())[0];assert.equal(new Date(d.start).getHours(),9);
});
