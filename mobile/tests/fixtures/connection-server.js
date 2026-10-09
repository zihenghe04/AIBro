import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
const python = String.raw`
import json,sqlite3,sys
from contextlib import contextmanager
sys.path.insert(0,sys.argv[2])
from connection_sync_store import ConnectionSyncStore,ConnectionSyncError
@contextmanager
def database():
 db=sqlite3.connect(sys.argv[1])
 try: yield db
 finally: db.close()
def verify(db,identity):
 if set(identity)!={'accountId','sessionId'}: raise ValueError()
 return identity
store=ConnectionSyncStore(database,'https://sync.example.test',verify)
for line in sys.stdin:
 try:
  m=json.loads(line);op=m['operation'];args=[m['identity']]
  if op in ('initialize','register'):args += [m['deviceSecret'],m['payload']]
  elif op=='status':args += [m['deviceId'],m['deviceSecret']]
  elif op in ('read','owner_state'):args += [m['deviceId'],m['deviceSecret'],m['payload']['epoch']]
  else:args += [m['deviceId'],m['deviceSecret'],m['payload']]
  result={'status':200,'body':getattr(store,op)(*args)}
 except ConnectionSyncError as e:result={'status':e.status,'body':{'code':e.code}}
 except Exception:result={'status':500,'body':{}}
 print(json.dumps(result,separators=(',',':')),flush=True)
`;
export async function connectionServer(t) {
  const directory = await mkdtemp(join(tmpdir(),'aibro-mobile-pairing-'));
  const child = spawn('python3',['-u','-c',python,join(directory,'synthetic.sqlite'),fileURLToPath(new URL('../../../app',import.meta.url))],
    {env:{PATH:process.env.PATH,HOME:process.env.HOME,PYTHONDONTWRITEBYTECODE:'1'},stdio:['pipe','pipe','pipe']});
  const waiting=[];let count=0;
  createInterface({input:child.stdout}).on('line',line=>waiting.shift()?.resolve(JSON.parse(line)));
  child.on('exit',()=>waiting.splice(0).forEach(item=>item.reject(Error('synthetic server ended'))));
  child.stderr.resume();
  t.after(async()=>{child.stdin.end();await new Promise(resolve=>child.once('close',resolve));await rm(directory,{recursive:true,force:true});});
  return {count:()=>count,transport(request){count++;return new Promise((resolve,reject)=>{waiting.push({resolve,reject});child.stdin.write(JSON.stringify({...request,identity:{accountId:request.session.accountId,sessionId:request.session.sessionId}})+'\n');});}};
}
