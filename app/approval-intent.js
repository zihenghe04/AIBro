/* A current user's explicit request for human review can only narrow the
 * workstation's transactional auto-apply policy. It never grants permission.
 * Host integration must pass the current message itself, not assembled context.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ApprovalIntent = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = 1;
  const SCOPE = 'workstation-actions';
  const fault = (code, message) => Object.assign(new Error(message), { code });

  // Quoted examples, pasted code and Markdown blockquotes are data. An unmatched
  // quote/fence hides its remainder rather than turning its text into an order.
  // Apostrophes inside words (don't / user's) remain ordinary characters.
  function instructionText(value) {
    if (typeof value !== 'string') return '';
    const lines = value.normalize('NFKC').replace(/\r\n?/g, '\n').split('\n');
    let fence = null;
    const visible = [];
    for (const line of lines) {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = { char: marker[0], length: marker.length };
        else if (marker[0] === fence.char && marker.length >= fence.length) fence = null;
        visible.push(''); continue;
      }
      visible.push(fence || /^\s*>/.test(line) || /^(?: {4}|\t)/.test(line) ? '' : line);
    }
    const text = visible.join('\n'), output = [], pairs = new Map([['“','”'],['‘','’'],['「','」'],['『','』'],['"','"'],["'","'"]]);
    let closing = null, ticks = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (ticks) {
        if (char === '`') { let end=i; while (text[end]==='`') end++; if (end-i===ticks) ticks=0; i=end-1; }
        output.push(char==='\n'?'\n':' '); continue;
      }
      if (closing) { if (char===closing && text[i-1]!=='\\') closing=null; output.push(char==='\n'?'\n':' '); continue; }
      if (char === '`') { let end=i; while (text[end]==='`') end++; ticks=end-i; i=end-1; output.push(' '); continue; }
      const apostropheInWord=char==="'" && /[\p{L}\p{N}]/u.test(text[i-1]||'') && /[\p{L}\p{N}]/u.test(text[i+1]||'');
      const trailingPossessive=char==="'" && /[\p{L}\p{N}]/u.test(text[i-1]||'');
      if (pairs.has(char) && !apostropheInWord && !trailingPossessive) { closing=pairs.get(char); output.push(' '); continue; }
      output.push(char);
    }
    return output.join('').toLowerCase().replace(/’/g, "'");
  }

  // Strip only a small grammar of direct address, never arbitrary text before a
  // keyword. “总结论文的同行审阅结论” therefore cannot become “审阅结论”.
  function directClause(value) {
    let text=value.trim();
    text=text.replace(/^(?:[-*+]\s+|\d+[.)、]\s*)/, '');
    for (let i=0; i<5; i++) {
      const next=text.replace(/^(?:请你|请|麻烦你|麻烦|帮我|本轮|本次|这次|现在|目前|我要求你|我要求|我希望你|我希望|我要你|能不能|可以)\s*/, '');
      if(next===text)break;
      text=next;
    }
    return text.replace(/^(?:please\s+|could you\s+|can you\s+|i (?:want|need) you to\s+|for this (?:turn|request),?\s*)+/i,'').trim();
  }

  const writeZh='(?:执行|应用|落库|写入|保存|修改|改动|更新|删除|提交|创建|添加|移动)';
  const rules = [
    // A local exclusion (do not change the title / 不要删除原文) constrains
    // a field or target, not the review policy of the whole requested action.
    ['zh-no-execute', /^(?:先|暂时|还|现在)?(?:不要|别|不能|不可以|不准|禁止|暂不)(?:先|直接|自动|立即|马上|实际)?(?:执行|应用)(?:(?:任何|这些|本轮|本次|这次|全部|所有)?(?:操作|修改|变更|计划|动作|内容)|或写入文件)?(?:先|即可)?$/],
    ['zh-no-write-all', /^(?:先|暂时|还|现在)?(?:不要|别|不能|不可以|不准|禁止|暂不)(?:先|直接|自动|立即|马上|实际)?(?:修改|改动|写入|保存|删除|提交|创建|更新)(?:任何|所有|全部)(?:文件|记录|资料|内容|数据|改动|修改|变更)$/],
    ['zh-no-direct-write', /^(?:先|暂时)?(?:不要|别|暂不)直接(?:修改|写入|保存)(?:资料|文件|记录|数据)$/],
    ['zh-human-before-write', new RegExp('^(?:先)?(?:等|等待|待)(?:我|我的)(?:亲自)?(?:确认|批准|审阅)(?:完|通过)?(?:后|以后|之后)?(?:才|再|才能)'+writeZh)],
    ['zh-before-write-human', new RegExp('^'+writeZh+'(?:前|之前)(?:请|先)?(?:让我|给我|等我|等待我)(?:亲自)?(?:确认|审阅|批准|过目)')],
    ['zh-review-proposal', /^(?:先|只|仅)?(?:生成|准备|给出|提供|展示|列出)(?:一份|一个|本次|这次)?(?:修改|变更|改动)?(?:审阅|预览|草稿|方案|计划)(?:内容|结果|方案|计划)?\s*(?:供我|让我|给我|由我)(?:先|亲自)?(?:确认|审阅|审核|批准|过目)(?:一下)?$/],
    ['zh-change-preview', /^(?:先|只|仅)?(?:生成|准备|给出|提供|展示|列出)(?:一份|一个|本次|这次)?(?:修改|变更|改动)(?:审阅|预览|草稿)(?:即可|就好|一下)?$/],
    ['zh-show-before-write', /^(?:先)?给我看(?:看|一下)?(?:本次|这次|这些)?(?:修改|变更|改动|计划|方案)(?:内容|结果)?$/],
    ['zh-show-changes', /^(?:先)?(?:让我|给我)(?:先|亲自)?(?:预览|审阅|过目)(?:一下)?(?:本次|这次|这些|待执行的)?(?:修改|改动|变更|方案|计划)(?:内容|结果)?(?:再(?:执行|应用|保存|修改))?$/],
    ['zh-preview-only', /^(?:只|仅)(?:要|做|生成|给出|展示|提供)?(?:修改预览|变更预览|预览|修改草稿|修改方案|变更计划)(?:即可|就好|一下|本次修改|这些修改)?$/],
    ['zh-preview-before-write', new RegExp('^先(?:预览|审阅)(?:一下|修改|改动|变更|计划|方案|草稿)?(?:后)?(?:再|然后再)'+writeZh)],
    ['en-no-execute', /^(?:(?:for now|first),?\s+)?(?:do not|don't|never)\s+(?:(?:automatically|actually|directly|immediately)\s+)?(?:apply|execute)(?: (?:anything|changes|any changes|the changes|these changes|this plan|the plan|any actions|this update))?(?: yet| for now)?$/],
    ['en-no-write-all', /^(?:(?:for now|first),?\s+)?(?:do not|don't|never)\s+(?:(?:automatically|actually|directly|immediately)\s+)?(?:modify|edit|write|save|delete|update|create) (?:any|all) (?:files?|records?|data|changes|content)(?: yet| for now)?$/],
    ['en-wait-for-human', new RegExp('^(?:wait for|require|get) (?:my|me to give) (?:explicit |personal )?(?:approval|confirmation|review)(?: first| before| prior to|$)')],
    ['en-human-before-write', new RegExp('^before (?:you )?(?:applying|executing|saving|writing|modifying|editing|updating|deleting|committing|making changes)\\b[^.!?;\\n]{0,60}\\b(?:ask me|let me (?:review|confirm|approve)|get my (?:approval|confirmation))\\b')],
    ['en-show-changes', /^(?:first,?\s+)?(?:show me|let me (?:review|preview|approve)) (?:a |the |these |your )?(?:proposed |planned |pending )?(?:changes|edits|patch|modifications|plan|preview|diff)\b(?:[^.!?;\n]{0,60})$/],
    ['en-review-proposal', /^(?:first,?\s+)?(?:generate|prepare|provide) (?:a |the )?(?:change review|preview|draft|change plan|diff) (?:for me to (?:review|confirm|approve)|for my (?:review|approval|confirmation))\b/],
    ['en-preview-only', /^(?:(?:only|just) (?:show|prepare|generate|give me) (?:a |the )?)?(?:preview|proposed changes|change plan|diff) only$/],
  ];

  function analyze(text) {
    const visible=instructionText(text);
    const sentences=visible.split(/[。！？!?;；\n]+|[.](?!\d)/);
    const clauses=[...new Set(sentences.flatMap(sentence=>[sentence,...sentence.split(/[，,](?!\d)/)]).map(directClause).filter(Boolean))];
    const ids=new Set();
    const directWrite=clauses.some(clause=>/^(?:先|请)?(?:修改|更新|删除|创建|添加|移动|保存|执行|应用)|^把[^。！？!?;；\n]{1,100}(?:改|删|更新|移|保存)/.test(clause));
    for(const clause of clauses) {
      for(const [id,pattern] of rules) if(pattern.test(clause))ids.add(id);
      // An independent “先让我确认” is an instruction only when this same
      // current message actually asks for a write; ordinary confirmation of an
      // author's identity or a paper's conclusions does not match.
      if(directWrite && /^(?:先)?(?:让我|等我|由我)(?:亲自)?(?:确认|批准|审阅)(?:一下|后再改)?$/.test(clause))ids.add('zh-human-review-write');
    }
    return Object.freeze({ required:ids.size>0, rules:Object.freeze([...ids]) });
  }

  function capture({ source, role, text, runId, userMessageId } = {}) {
    if(source!=='current-user' || role!=='user') return null;
    const result=analyze(text);
    if(!result.required)return null;
    if(typeof runId!=='string'||!runId.trim()||typeof userMessageId!=='string'||!userMessageId.trim())
      throw fault('REVIEW_INTENT_OWNER','本轮审阅要求缺少所属执行或用户消息，未开始自动执行。');
    return Object.freeze({ version:VERSION, scope:SCOPE, runId, userMessageId, requireHumanReview:true, rules:result.rules });
  }

  function requiresHumanReview(run, actions = run?.pendingActions || []) {
    if(!Array.isArray(actions) || !actions.length)return false;
    const intent=run?.approvalIntent;
    if(intent==null)return false;
    // A persisted but damaged/misbound constraint must not silently grant auto
    // execution. Only the host-created owner can proceed to human plan review.
    return true;
  }

  function assertOwner(run) {
    const intent=run?.approvalIntent;
    if(intent==null)return true;
    const allowedRules=new Set([...rules.map(([id])=>id),'zh-human-review-write']);
    if(intent.version!==VERSION || intent.scope!==SCOPE || intent.requireHumanReview!==true ||
      intent.runId!==run.id || intent.userMessageId!==run.userMessageId || !Array.isArray(intent.rules) || !intent.rules.length || intent.rules.length>allowedRules.size || intent.rules.some(id=>!allowedRules.has(id)))
      throw fault('REVIEW_INTENT_CHANGED','本轮审阅要求的归属已变化，请重新检查原始请求。');
    return true;
  }

  function assertAutomaticAllowed(run, actions) {
    if(!requiresHumanReview(run,actions))return true;
    assertOwner(run);
    throw fault('CHECKPOINT_REVIEW_REQUIRED','按你的本轮要求，修改先保留为审阅计划，等待你本人确认后再执行。');
  }

  // These messages describe host receipts, not assertions from model prose.
  // The host uses this only for an explicit-review run, leaving ordinary answers
  // intact. A saved receipt must replace, not append to, stale pending wording.
  function messageFor(run, phase, summary='') {
    if(run?.approvalIntent==null)return null;
    const labels={
      pending:'按你的要求，已准备修改审阅，尚未执行。请核对后确认。',
      saving:'已按你确认的计划执行，正在保存结果。',
      completed:'已按你确认的计划执行并保存。具体结果见下方。',
      rejected:'已取消这份修改计划，没有执行其中的操作。',
    };
    const label=labels[phase];
    return label ? label+(phase==='pending'&&summary?'\n\n'+String(summary):'') : null;
  }

  return Object.freeze({ analyze, capture, requiresHumanReview, assertOwner, assertAutomaticAllowed, messageFor });
});
