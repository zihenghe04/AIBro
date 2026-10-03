// Input is emitted by the actual Swift AgendaAgentAccess payload/query/read.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const A=require('../app/agenda-access'),P=require('../app/agenda-proposals');
const {nativeAgendaFixture}=require('./helpers/agenda-native-fixture.cjs');
test('actual Swift JSON survives desktop owner normalization and produces a reviewable exact-version proposal',{skip:process.platform!=='darwin',timeout:120000},async t=>{
 const {wire,directory}=nativeAgendaFixture(t);
 const run={id:wire.context.runId,conversationId:wire.context.conversationId,userMessageId:wire.context.userMessageId,contextWorkspace:'auto',status:'running',recordAssignmentScope:{projectId:null,workspace:'auto',readProjects:[]}};
 const quote='帮我把明天下午3点打篮球的那个日程给删了。';
 const state={projects:[{id:'p',name:'Synthetic course',workspace:'课程'}],agentRuns:[run],conversations:[{id:'c',workspace:'auto',messages:[{id:'u',role:'user',text:quote}]}]};
 A.init({getState:()=>state});const authorization=A.authorize(wire.context);assert.equal(authorization.status,'authorized');assert.deepEqual(authorization.context,wire.context);
 const context={run,getState:()=>state,bridge:{agendaQuery:async(_,owner)=>{assert.deepEqual(owner,wire.context);return wire.query;},agendaRead:async(_,owner)=>{assert.deepEqual(owner,wire.context);return wire.read;}}};
 const query=await A.execute({type:'agenda_list'},context);assert.equal(query.entries[0].eventId,wire.event.eventId);
 const read=await A.execute({type:'agenda_read',eventId:wire.event.eventId,expectedVersion:wire.event.version},context);assert.equal(read.event.start,wire.event.start);assert.equal(Number.isInteger(read.event.start),false);
 run.agendaProposals=P.validate([{operation:'delete',eventId:wire.event.eventId,expectedVersion:wire.event.version,sourceMessageId:'u',quote,scope:'single'}],state,run);
 assert.equal(A.authorize(wire.context,run.agendaProposals[0]).status,'authorized');
 fs.writeFileSync(path.join(directory,'js-roundtrip.json'),JSON.stringify({context:wire.context,authorization,proposal:run.agendaProposals[0],readVersion:read.version,passed:true},null,2)+'\n');
});
