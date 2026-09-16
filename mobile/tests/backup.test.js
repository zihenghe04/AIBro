import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {createBackup,restoreBackup} from '../src/backup.js';import {Store,MemoryAdapter} from '../src/store.js';
import {unzipSync,zipSync} from 'fflate';
const hash=async bytes=>createHash('sha256').update(bytes).digest('hex');
test('full backup restores original bytes and records but no credentials; damaged archives cannot partially restore',async()=>{
 const source=await new Store(new MemoryAdapter()).load(), data=new TextEncoder().encode('image bytes fixture'), sha=await hash(data);
 await source.put('imports',{id:'file',title:'原图',blobHash:sha});await source.tx(s=>s.settings.model={key:'excluded-secret'});
 const zip=await createBackup(source,async()=>data,hash), restored=await new Store(new MemoryAdapter()).load();let writes=[];
 const files={write:async(h,bytes)=>writes.push([h,bytes])};await restoreBackup(restored,zip,files,hash);
 assert.equal(writes[0][0],sha);assert.deepEqual(writes[0][1],data);assert.equal(restored.list('imports')[0].title,'原图');assert.deepEqual(restored.state.settings,{});
 await assert.rejects(restoreBackup(restored,zip,files,hash));
 const entries=unzipSync(zip);entries['blobs/'+sha][0]=0;
 const empty=await new Store(new MemoryAdapter()).load();writes=[];
 await assert.rejects(restoreBackup(empty,zipSync(entries),files,hash));assert.equal(writes.length,0);assert.equal(Object.keys(empty.state.records).length,0);
 entries['../evil']=data;await assert.rejects(restoreBackup(empty,zipSync(entries),files,hash));
});
