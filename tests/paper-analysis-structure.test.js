const test = require('node:test');
const assert = require('node:assert/strict');
const Research = require('../research-library');
const Core = require('../workstation-core');
const extra = {training:'TRAINING evidence',relatedWork:'RELATED WORK explanation',criticalAnalysis:'CRITICAL reasoning',counterArguments:'COUNTER argument',dataGaps:'MISSING evidence',reproduction:'REPRODUCTION steps'};
const copy=value=>JSON.parse(JSON.stringify(value));

test('new analysis fields, paper type and confidence survive normalization and incremental upsert under one stable paper ID',()=>{
  const input={id:'paper',title:'Original',paperType:'SURVEY',sourceAttachmentIds:['pdf'],confidence:{overall:'MEDIUM',reason:'  Partial evidence  ',methods:{level:'low',reason:'No code'},experiments:0.4},structured:{methods:'Taxonomy',...extra}};
  const before=copy(input), first=Research.upsertPaper([],input,{now:100});
  assert.equal(first.paper.paperType,'survey');assert.deepEqual(first.paper.structured,input.structured);
  assert.deepEqual(first.paper.confidence,{overall:'medium',reason:'Partial evidence',methods:input.confidence.methods,experiments:0.4});
  const next=Research.upsertPaper(first.papers,{id:'paper',title:'Revised',structured:{abstract:'Additional abstract'},confidence:{experiments:'high'}},{now:200});
  assert.equal(next.papers.length,1);assert.equal(next.paper.id,'paper');assert.equal(next.paper.paperType,'survey');
  for(const [key,value] of Object.entries(extra)) assert.equal(next.paper.structured[key],value);
  assert.equal(next.paper.confidence.overall,'medium');assert.equal(next.paper.confidence.reason,'Partial evidence');assert.deepEqual(next.paper.confidence.methods,input.confidence.methods);
  assert.equal(next.paper.confidence.experiments,'high');assert.deepEqual(input,before);
});

test('all six paper types render relevant section labels and each populated new section once in the same Markdown',()=>{
  const methodLabels={method:'核心方法',survey:'分类体系与覆盖范围',benchmark:'数据集构建与设计',system:'系统架构',theory:'理论框架',other:'方法'};
  for(const type of Research.PAPER_TYPES) {
    const paper={id:'paper',title:'Typed paper',paperType:type,structured:{methods:'The actual approach',...extra},confidence:{overall:'uncertain',reason:'Source evidence is incomplete'}};
    const markdown=Research.paperMarkdown(paper), labels=Research.sectionLabels(type);
    assert.equal(labels.methods,methodLabels[type]);assert.match(markdown,new RegExp('## '+methodLabels[type]+'\n'));
    for(const [key,value] of Object.entries(extra)) {assert.equal(markdown.split('## '+labels[key]+'\n').length-1,1);assert.equal(markdown.split(value).length-1,1);}
    assert.match(markdown,/paperType: "/);assert.match(markdown,/confidence:.*uncertain/);assert.match(markdown,/Source evidence is incomplete/);
    assert.doesNotMatch(markdown,/!\[\[|!\[[^\]]*\]\(/,'structure never invents an image asset');
  }
});

test('new optional sections with no actual text do not create placeholder chapters or blank companion notes',()=>{
  const markdown=Research.paperMarkdown({title:'Legacy',structured:{abstract:'Abstract',training:'',relatedWork:{text:''},criticalAnalysis:[],counterArguments:null,dataGaps:{citations:[{attachmentId:'pdf',page:1}]},reproduction:['','  ']}});
  for(const key of Research.OPTIONAL_SECTIONS) assert.ok(!markdown.includes('## '+Research.SECTION_LABELS[key]+'\n'),key);
  assert.match(markdown,/研究动机\n未核验/,'existing legacy placeholders remain compatible');
});

test('legacy sections and top-level fields render while explicit user blank edits suppress their generated replacements',()=>{
  const input={id:'paper',title:'Legacy aliases',sections:{summary:'Old summary',method:'Old method'},structured:{results:'Old experiment'},math:'Old math',training:'Top-level training',userEdits:{method:'Human method',training:''}};
  const normalized=Research.normalizePaper(input);
  assert.equal(normalized.structured.summary,'Old summary');assert.equal(normalized.structured.tldr,'Old summary');assert.equal(normalized.structured.methods,'Human method');
  assert.equal(normalized.structured.experiments,'Old experiment');assert.equal(normalized.structured.derivations,'Old math');assert.equal(normalized.structured.training,'');
  const next=Research.upsertPaper([normalized],{id:'paper',structured:{methods:'New AI method',training:'New AI training'}},{now:100}).paper;
  assert.equal(next.structured.methods,'Human method');assert.equal(next.structured.training,'');
  const markdown=Research.paperMarkdown(next);for(const value of ['Old summary','Human method','Old experiment','Old math'])assert.ok(markdown.includes(value));
  assert.doesNotMatch(markdown,/New AI method|New AI training|损失函数与训练策略/);
});

test('confidence labels normalize conservatively without altering legacy numeric or per-section evidence',()=>{
  assert.deepEqual(Research.normalizeConfidence(' HIGH '),{overall:'high',reason:''});
  assert.deepEqual(Research.normalizeConfidence({overall:'overconfident',reason:'Missing evidence',methods:{score:0.7}}),{overall:'uncertain',reason:'Missing evidence',methods:{score:0.7}});
  const legacy={overall:0.8,methods:{confidence:0.5,reason:'Old evidence'},abstract:'low'};
  assert.deepEqual(Research.normalizeConfidence(legacy),legacy);assert.deepEqual(Research.normalizeConfidence(undefined),{});
  assert.equal(Research.normalizePaper({paperType:'not-a-type'}).paperType,'other');
});

test('Core forwards new fields to the single main note, validates new-section citations, and never grants human review',()=>{
  const state={projects:[],notes:[],papers:[],imports:[{id:'pdf',name:'Paper.pdf',workspace:'科研',pages:[{page:1},{page:2}]}],tasks:[],links:[],trash:[],conversations:[],agentRuns:[]};
  const action={type:'upsert_paper',title:'Method study',workspace:'科研',projectId:null,paperType:'method',sourceAttachmentIds:['pdf'],structured:{...extra,training:{text:'TRAINING evidence',citations:[{attachmentId:'pdf',page:2}]}},confidence:{overall:'medium',reason:'Evaluation limited to two settings',training:'low'},reviewed:true};
  const first=Core.applyPlan(state,[action],{now:100}).state;
  assert.equal(first.papers.length,1);assert.equal(first.notes.length,1);assert.equal(first.notes[0].id,first.papers[0].noteId);
  assert.equal(first.papers[0].paperType,'method');assert.equal(first.papers[0].reviewed,false);assert.equal(first.papers[0].confidence.overall,'medium');
  for(const value of Object.values(extra))assert.ok(first.notes[0].content.includes(value));
  first.notes[0].userEdited=true;first.notes[0].content='My complete manual analysis';
  const changed=Core.applyPlan(first,[{...action,paperId:first.papers[0].id,structured:{...extra,criticalAnalysis:'An added critique'}}],{now:200}).state;
  assert.equal(changed.notes.length,1);assert.equal(changed.notes[0].content,'My complete manual analysis');assert.match(changed.notes[0].aiDraft.content,/An added critique/);
  const before=JSON.stringify(first);
  assert.throws(()=>Core.applyPlan(first,[{...action,structured:{training:{text:'Bad evidence',citations:[{attachmentId:'other',page:1}]}}}]),/未关联/);
  assert.equal(JSON.stringify(first),before);
});
