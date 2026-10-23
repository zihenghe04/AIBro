/* Approval broker (P5): the one decision for "may this tool call run now?",
   shared by the main window's ToolScheduler and the ToolGateway (MCP and other
   kernels). Every layer votes allow/ask/deny and the strictest vote wins, so a
   layer can only tighten. Nothing in a call (arguments, _meta, provider
   fields) is a layer. A layer that throws or returns an unknown vote denies.
   Permission mode: the run's mode is frozen when it starts; later reads take
   the stricter of the frozen and the conversation's current mode, so a change
   to a stricter mode applies at once and a looser one only to the next run.
   No DOM. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.ApprovalBroker=api;})(globalThis,()=>{
  'use strict';
  const RANK={allow:0,ask:1,deny:2};
  const strictest=votes=>votes.reduce((worst,vote)=>RANK[vote]>RANK[worst]?vote:worst,'allow');
  // full < smart < legacy (per-space settings) < request. Unknown = legacy.
  const MODE_RANK={full:0,smart:1,legacy:2,request:3};
  const modeOf=mode=>Object.hasOwn(MODE_RANK,mode)?mode:'legacy';
  function stricterMode(...modes){
    return modes.map(modeOf).reduce((worst,mode)=>MODE_RANK[mode]>MODE_RANK[worst]?mode:worst,'full');
  }
  // frozen: the mode recorded when the run started (missing on runs saved
  // before freezing existed: then the current mode is all there is).
  const effectiveMode=(frozen,current)=>frozen==null?modeOf(current):stricterMode(frozen,current);
  // The spec's own floor. "host" means the executor asks for itself (the
  // command card, the native browser per site); every other layer still applies.
  function baseVote(spec,run){
    if(spec.destructive||spec.approval==='always')return 'ask';
    if(spec.approval==='policy'){
      if(['local','external'].includes(spec.effect)&&(run.permissionMode==='request'||!['smart','full'].includes(run.permissionMode)))return 'ask';
    }
    return 'allow';
  }
  // Built-in layers; hosts may add more but cannot remove these.
  const builtinLayers=Object.freeze([
    // The user said "show me first" this turn: anything that can change state waits for a person.
    (spec,run)=>run.requiresHumanReview&&!['none','view'].includes(spec.effect)?'ask':'allow',
    // Read-only runs (subagents, unattended reads) may not change anything.
    (spec,run)=>run.readOnly&&!['none','view'].includes(spec.effect)?'deny':'allow',
  ]);
  function decide(spec,run={},layers=[]){
    if(!spec)return 'deny';
    const votes=[baseVote(spec,run),...[...builtinLayers,...layers].map(layer=>{try{return layer(spec,run)||'allow';}catch{return 'deny';}})];
    for(const vote of votes)if(!Object.hasOwn(RANK,vote))return 'deny';
    return strictest(votes);
  }
  // Closed answer set: only an explicit "allowed-once" admits a call that had
  // to ask. Anything else (rejected, timeout, missing answerer, a truthy value
  // of another shape) is a refusal.
  const OUTCOMES=Object.freeze(['allowed-once','rejected','cancelled','unavailable']);
  const admits=answer=>answer==='allowed-once';

  // Plan-level approval (P8a): may a whole action plan (the final plan plus
  // staged tool-phase writes) apply without a person? Same rule: every reason
  // votes, the strictest wins. ctx: {actions, mode, spaces, permissions,
  // approvalIntent, requiresAssignmentReview, routingReview, sessionAllows,
  // reviewerEnabled}. policy: WorkstationPermissionPolicy.
  // Reasons that ask: the user's "show me first" this turn, an assignment or
  // course-routing review, a deletion under the legacy mode, an irreversible
  // operation (any mode; reversible trash deletions follow the mode), the permission
  // policy (mode × action types × affected spaces). Only the policy's vote can
  // be waived, and only by "allowed for this session" (same non-destructive
  // action types the user approved before in this conversation). Answerers:
  // the user always; the reviewer only for plans it may decide (never with
  // "show me first", routing review, assignments or destructive actions).
  const policyOf=policy=>policy||globalThis.WorkstationPermissionPolicy||null;
  const PLAN_UNWAIVABLE=Object.freeze(['approval-intent','assignment-review','routing-review','legacy-deletion','irreversible']);
  function decidePlan(ctx={},policy){
    const P=policyOf(policy),actions=Array.isArray(ctx.actions)?ctx.actions:[];
    if(!actions.length)return Object.freeze({vote:'allow',reasons:[],waived:null,answerers:['user'],sessionTypes:[]});
    const mode=modeOf(ctx.mode),reasons=[];
    if(ctx.approvalIntent)reasons.push('approval-intent');
    if(ctx.requiresAssignmentReview)reasons.push('assignment-review');
    if(ctx.routingReview)reasons.push('routing-review');
    if(mode==='legacy'&&actions.some(action=>/delete|merge|remove|archive/.test(action?.type||'')))reasons.push('legacy-deletion');
    // Irreversible operations (no trash / undo path) ask in every mode, full access included;
    // reversible deletions follow the mode (full: automatic; smart: ask). Same rule as the policy.
    const lasting=type=>P?.irreversible?P.irreversible(type):/(?:^|_)(?:delete|merge|remove|archive|purge)(?:_|$)/.test(type);
    if(actions.some(action=>lasting(String(action?.type||''))))reasons.push('irreversible');
    let policyAsks,policyFailed=false;
    try{policyAsks=P?P.needsApproval({mode,actions,spaces:[...(ctx.spaces||[])],permissions:ctx.permissions||{}})!==false
      :[...(ctx.spaces||[])].some(space=>((ctx.permissions||{})[space]||'auto')==='approval');}
    catch{policyAsks=true;policyFailed=true;}
    if(policyAsks)reasons.push('policy');
    const unwaivable=reasons.some(reason=>PLAN_UNWAIVABLE.includes(reason));
    let waived=null;
    if(reasons.length&&!unwaivable&&!policyFailed&&ctx.sessionAllows&&typeof ctx.sessionAllows==='object'){
      try{if(P?.canSessionAllow({actions,allows:ctx.sessionAllows})===true)waived='session-allow';}catch{}
    }
    const vote=reasons.length&&!waived?'ask':'allow';
    // Who may answer this plan when it waits for a person (approveRun checks
    // this after the card was shown, whatever the current vote).
    const answerers=['user'];
    if(!ctx.approvalIntent&&!ctx.routingReview){
      try{if(P?.canDelegateReview({actions,routingReview:false,enabled:ctx.reviewerEnabled===true})===true)answerers.push('reviewer');}catch{}
    }
    let sessionTypes=[];
    if(!ctx.approvalIntent&&!ctx.routingReview){try{sessionTypes=P?.allowableTypes?.(actions)||[];}catch{}}
    return Object.freeze({vote,reasons,waived,answerers,sessionTypes});
  }
  // Background runs (headless host). The user's "后台运行权限" setting:
  // follow (default) – what the main window does for a chat without its own
  //   mode: the automation setting of the run's space (auto → smart: ordinary
  //   writes run, risky ones ask; approval → request: every write asks);
  // request – every write asks; readonly – no writes at all.
  // A mode the run's client asked for only tightens. Destructive tools ask in
  // every mode (baseVote), so no setting lets them run unattended.
  const HEADLESS_SETTINGS=Object.freeze(['follow','request','readonly']);
  function headlessMode({setting,requested,spacePermission}={}){
    const choice=HEADLESS_SETTINGS.includes(setting)?setting:'follow';
    const follow=spacePermission==='auto'?'smart':'request';
    const mode=stricterMode(follow,choice==='follow'?'full':'request',requested==null?'full':requested);
    return Object.freeze({mode,readOnly:choice==='readonly',setting:choice});
  }
  // Who may answer a plan waiting for a person. A missing or unknown answerer may not.
  const mayAnswer=(decision,answerer)=>!!decision&&Array.isArray(decision.answerers)&&decision.answerers.includes(answerer);
  return Object.freeze({RANK,MODE_RANK,strictest,stricterMode,effectiveMode,baseVote,builtinLayers,decide,OUTCOMES,admits,decidePlan,mayAnswer,PLAN_UNWAIVABLE,HEADLESS_SETTINGS,headlessMode});
});
