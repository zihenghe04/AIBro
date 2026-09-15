const {test}=require('node:test'),assert=require('node:assert/strict'),T=require('../app/terminal-tools.js');
test('terminal requests bind trusted current project, ignoring model-provided roots',()=>{const s={projects:[{id:'p',localFolder:{id:'trusted'}},{id:'foreign',localFolder:{id:'other'}}]};assert.deepEqual(T.payload({argv:['pwd'],candidateId:'evil',projectId:'foreign'},s,{id:'r',projectId:'p'}),{candidateId:'trusted',projectId:'p',runId:'r',argv:['pwd'],cwd:'',timeout:60});assert.throws(()=>T.payload({argv:['pwd']},s,{id:'r'}));s.projects[0].archived=true;assert.throws(()=>T.payload({argv:['pwd']},s,{id:'r',projectId:'p'}));});
const F=require('../app/file-context.js');
test('trusted command uses authoritative results and returns stdout to the tool loop',async()=>{
 const original=F.request,calls=[],state={projects:[{id:'p',localFolder:{id:'c'}}],conversations:[{id:'chat',projectId:'p'}]},run={id:'r',projectId:'p',conversationId:'chat',status:'running'};
 F.request=async(path,p)=>{calls.push([path,p]);if(path.endsWith('/propose'))return {id:'cmd',candidateId:'c',projectId:'p',argv:['/bin/pwd'],trusted:true,status:'pending'};return {status:path.endsWith('/start')?'running':'succeeded',exitCode:0,output:'actual project path'};};
 try{const result=await T.execute({argv:['pwd']},state,run,{refresh(){},save(){}});assert.equal(result.output,'actual project path');assert.equal(calls[1][1].automatic,true);assert.equal(run.commands[0].status,'succeeded');}finally{F.request=original;}
});
test('stopping while approval is pending cancels the proposal without starting it',async()=>{
 const original=F.request,calls=[],controller=new AbortController(),state={projects:[{id:'p',localFolder:{id:'c'}}]},run={id:'r',projectId:'p'};
 F.request=async(path)=>{calls.push(path);return {id:'cmd-stop',candidateId:'c',projectId:'p',argv:['pwd'],status:path.endsWith('/propose')?'pending':'cancelled'};};
 try{await assert.rejects(T.execute({argv:['pwd']},state,run,{signal:controller.signal,refresh(){controller.abort();},save(){}}),{code:'CANCELLED'});assert(!calls.some(p=>p.endsWith('/start')));assert.equal(run.commands[0].status,'cancelled');}finally{F.request=original;}
});
