// Mobile -> real Mac WorkspaceStore -> mobile, using only an isolated cloud.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { Store, MemoryAdapter, addMessage } from '../src/store.js';
import { Sync } from '../src/sync.js';
import { createAgentTools, applyPlan } from '../src/agent-tools.js';
test('Mac save and continuation preserve phone history; a real body edit invalidates only the plan', async () => {
  const python = ['python3.13','python3.12','python3.11','python3'].find(p => spawnSync(p, ['-c', 'import hashlib; assert hasattr(hashlib,"scrypt")']).status === 0);
  assert.ok(python);
  const child = spawn(python, ['tests/cloud-fixture.py'], { stdio: ['ignore','pipe','pipe'] });
  let failure = ''; child.stderr.on('data', chunk => failure += chunk);
  try {
    const [port] = await Promise.race([once(child.stdout,'data'),once(child,'exit').then(() => { throw Error(failure); })]);
    const base = 'http://127.0.0.1:' + String(port).trim(), secrets = new Map();
    const vault = { get: async k => secrets.get(k), set: async (k,v) => secrets.set(k,v), remove: async k => secrets.delete(k) };
    const request = async (url, opt = {}) => { const r = await fetch(url,{ method:opt.method || 'GET',headers:{'Content-Type':'application/json',...opt.headers},body:opt.body ? JSON.stringify(opt.body) : undefined }); const data=await r.json(); if(!r.ok) throw Object.assign(Error(data.error),{status:r.status}); return data; };
    const store = await new Store(new MemoryAdapter()).load();
    await store.put('conversations',{ id:'metadata-chat',title:'Synthetic metadata',projectId:null });
    const agent=createAgentTools({store,conversationID:'metadata-chat'});
    await agent.execute('propose_changes',{ actions:[{operation:'create',kind:'tasks',changes:{title:'Must remain uncreated'}}] });
    const pendingPlan=agent.pendingPlan();
    await addMessage(store,'metadata-chat','assistant','待审批的合成答复',{pendingPlan,reasoning:'合成推理',status:'completed',toolEvents:[{type:'tool-result',title:'propose_changes',output:{executed:false}}]});
    const sync=new Sync(store,request,vault,{});
    await sync.login(base,'mobile-test','fixture-password-42!'); await sync.run();
    assert.deepEqual(store.list('messages')[0].pendingPlan,pendingPlan);
    assert.equal(store.list('messages')[0].reasoning,'合成推理');
    const {token}=JSON.parse(await vault.get('sync'));
    const result=JSON.parse(execFileSync(python,['-c',`
import json,sys,tempfile,os
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request,urlopen
sys.path.insert(0,str(Path.cwd().parent/'app'))
config=json.load(sys.stdin)
assert urlparse(config['base']).hostname=='127.0.0.1'
def call(path,body=None):
    req=Request(config['base']+path,data=None if body is None else json.dumps(body).encode(),headers={'Authorization':'Bearer '+config['token'],'Content-Type':'application/json'})
    with urlopen(req,timeout=10) as response:return json.load(response)
with tempfile.TemporaryDirectory(prefix='aibro-metadata-desktop-') as directory:
    # server.py creates module-level services at import time; isolate them too.
    os.environ['AI_WORKSTATION_DATA_DIR']=str(Path(directory)/'service-workspace')
    os.environ['AI_WORKSTATION_NOTIFICATION_DIR']=str(Path(directory)/'notifications')
    from server import WorkspaceStore
    workspace=WorkspaceStore(Path(directory))
    desktop=workspace.sync
    incoming=call('/v1/sync/pull?cursor=0&limit=100')
    assert not incoming['hasMore']
    workspace.apply_cloud_changes(incoming['changes'],incoming['cursor'])
    snapshot=workspace.load()
    workspace.save(snapshot)
    assert desktop.pending()==[], 'unchanged desktop save must not create a new message version'
    def answer(snapshot):return next(m for m in snapshot['conversations'][0]['messages'] if m.get('pendingPlan'))
    original=answer(workspace.load())
    assert original['text']==original['content']=='待审批的合成答复'
    fields=('pendingPlan','reasoning','status','toolEvents')
    history={key:original[key] for key in fields}
    def push():
        operations=desktop.pending()
        result=call('/v1/sync/push',{'operations':operations})
        assert not result['conflicts']
        desktop.ack(result['accepted'],result['conflicts'])
        return operations
    snapshot=workspace.load()
    snapshot['notes'].append({'id':'synthetic-unrelated-note','title':'合成笔记','content':'与对话无关的保存'})
    workspace.save(snapshot)
    assert [op['entityType'] for op in push()]==['notes']
    snapshot=workspace.load()
    # Old renderer saves text and omits fields it does not understand.
    prior=answer(snapshot)
    prior.pop('content')
    for field in fields:prior.pop(field)
    snapshot['conversations'][0]['messages'].extend([
        {'id':'synthetic-desktop-followup','role':'user','text':'继续合成对话'},
        {'id':'synthetic-desktop-answer','role':'agent','text':'桌面合成回复'}])
    workspace.save(snapshot)
    continued=answer(workspace.load())
    assert {key:continued[key] for key in fields}==history
    operations=push()
    assert len(operations)==2 and all(op['entityType']=='messages' for op in operations)
    with desktop.db() as db:
        remote=[json.loads(row['remote_data']) for row in db.execute("SELECT remote_data FROM entities WHERE kind='messages' AND remote_data IS NOT NULL")]
    assert next(m for m in remote if m.get('pendingPlan'))['pendingPlan']==history['pendingPlan']
    # The actual Mac editor changes text, while the display alias content is old.
    snapshot=workspace.load()
    message=answer(snapshot)
    message['text']='桌面修改后的合成答复'
    workspace.save(snapshot)
    message=answer(workspace.load())
    assert message['text']==message['content']=='桌面修改后的合成答复'
    assert message['pendingPlan']['status']=='invalidated'
    for field in ('reasoning','status','toolEvents'):assert message[field]==history[field]
    pending=desktop.pending()
    assert len(pending)==1 and pending[0]['entityType']=='messages'
    assert 'text' not in pending[0]['data'], 'display alias must not create dual wire bodies'
    push()
    workspace.save(workspace.load())
    assert desktop.pending()==[]
    print(json.dumps({'preserved':list(fields),'acceptedBodyEdits':1,'continuationMessages':2}))
`],{ input:JSON.stringify({base,token}),encoding:'utf8',timeout:15000 }));
    assert.deepEqual(result,{preserved:['pendingPlan','reasoning','status','toolEvents'],acceptedBodyEdits:1,continuationMessages:2});
    await sync.run(); const after=store.list('messages').find(message=>message.pendingPlan);
    assert.equal(after.content,'桌面修改后的合成答复');
    assert.equal(after.reasoning,'合成推理');
    assert.equal(after.status,'completed');
    assert.deepEqual(after.toolEvents,[{type:'tool-result',title:'propose_changes',output:{executed:false}}]);
    assert.equal(after.pendingPlan.status,'invalidated');
    assert.equal(after.pendingPlan.invalidatedReason,'conversation-message-edited');
    assert.equal(store.list('messages').length,3);
    await assert.rejects(applyPlan(store,pendingPlan),/待审阅修改.*(变化|不存在)/);
    assert.equal(store.list('tasks').length,0);
  } finally {child.kill('SIGTERM');}
});
