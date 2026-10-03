(function (root) {
  'use strict';
  const statuses = new Set(['running', 'completed', 'done', 'failed', 'cancelled', 'pending']);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const t = (zh,en) => root.WorkstationI18n?.getLanguage?.()==='en'?en:zh;
  function phase(message, active) {
    if (!message.live) return 'settled';
    if (active?.kind === 'tool') return 'tool';
    if (active?.kind === 'summary' || active?.kind === 'reasoning') return 'thinking';
    if (active?.kind === 'commentary' || active?.kind === 'response') return 'writing';
    if (message.phase === 'reasoning') return 'thinking';
    if (message.phase === 'output') return 'writing';
    return 'waiting';
  }
  // Keep owned record and evidence subtrees connected. Each React adapter must
  // explicitly update its own callbacks; generic DOM reconciliation cannot.
  // Open attributes come from persisted pins, not stale DOM state.
  function patchLive(previous, next) {
    const before=previous.querySelector(':scope > .agent-progress'),after=next.querySelector(':scope > .agent-progress');
    const ledger=previous.querySelector(':scope > .tool-ledger'),nextLedger=next.querySelector(':scope > .tool-ledger');
    const evidence=previous.querySelector(':scope > [data-citation-panel]'),nextEvidence=next.querySelector(':scope > [data-citation-panel]');
    const body=previous.querySelector(':scope > .message-body'),nextBody=next.querySelector(':scope > .message-body');
    // A detached render contains a plan, not a second copy of a live code block.
    // Materialize the ordinary renderer first if its target was superseded.
    root.StreamMarkdown?.prepareCommit?.(body,nextBody);
    const preserved=new Map();
    if(before&&after)preserved.set(after,before);
    if(ledger&&nextLedger)preserved.set(nextLedger,ledger);
    if(evidence&&nextEvidence)preserved.set(nextEvidence,evidence);
    if(root.StreamingBody?.canPatch(body,nextBody))preserved.set(nextBody,body);
    if(!preserved.size){previous.replaceWith(next);root.HalaskaConversation?.discard(previous);root.CitationEvidence?.discard?.(previous);return;}
    const focused=root.document?.activeElement;
    const selection=root.getSelection?.();
    const selectedRange=selection?.rangeCount?selection.getRangeAt?.(0):null;
    const selected=selection?.rangeCount&&(previous.contains(selection.anchorNode)||previous.contains(selection.focusNode))
      ? {anchor:selection.anchorNode,anchorOffset:selection.anchorOffset,focus:selection.focusNode,focusOffset:selection.focusOffset,
        anchorIsStart:selectedRange?selectedRange.startContainer===selection.anchorNode&&selectedRange.startOffset===selection.anchorOffset:undefined}:null;
    // An automatically opened segment can finish while its text is selected
    // or an inner control has keyboard focus. Keep that reading surface open
    // for this patch only; never manufacture a durable user pin. Explicit user
    // closes (including an in-flight close animation) still take precedence.
    const selectedText=selected&&(selected.anchor!==selected.focus||selected.anchorOffset!==selected.focusOffset);
    const processRoots=[before,ledger].filter(Boolean);
    const readable=node=>node&&processRoots.some(scope=>scope.contains(node))&&(()=>{
      for(let parent=node.parentElement||node.parentNode;parent&&parent!==previous;parent=parent.parentElement||parent.parentNode){
        if(parent.nodeName==='DETAILS'&&!parent.open&&!parent.querySelector(':scope > summary')?.contains(node))return false;
      }
      return true;
    })();
    const readers=[focused,...(selectedText?[selected.anchor,selected.focus]:[])].filter(readable);
    const selectedDetails=new Set();
    if(selectedText&&selectedRange?.intersectsNode)for(const scope of processRoots){
      for(const details of [scope,...scope.querySelectorAll('details[open]')]){
        if(details.nodeName!=='DETAILS'||!details.open)continue;
        const summary=details.querySelector(':scope > summary');
        try{if([...details.children].some(child=>child!==summary&&selectedRange.intersectsNode(child)))selectedDetails.add(details);}catch{}
      }
    }
    const holdsReading=details=>{
      if(details.nodeName!=='DETAILS')return false;
      const summary=details.querySelector(':scope > summary');
      return selectedDetails.has(details)||readers.some(node=>details.contains(node)&&!summary?.contains(node));
    };
    const keepOpen=(details,nextDetails=details)=>nextDetails.getAttribute('data-progress-user-open')!=='false'
      &&details._interactionDesiredOpen!==false&&holdsReading(details);
    // A new reasoning segment can change the default tab. Keep the current
    // visible reading surface for this paint, without persisting a user choice.
    const priorView=before?.querySelector(':scope > .conversation-process-navigation')?.dataset.view;
    const explicitNextView=after?.querySelector(':scope > .conversation-process-navigation')?.dataset.explicitView;
    const readingPanel=priorView&&before?.querySelector(`:scope > [data-live-key="process-${priorView}-panel"]`);
    const heldView=readingPanel&&!readingPanel.hidden&&readers.some(node=>readingPanel.contains(node))
      &&(!explicitNextView||explicitNextView===priorView)?priorView:null;
    const priorPhase=before?.dataset.progressPhase;
    const priorStates=new Map([...(before?.querySelectorAll('[data-activity-id]')||[])].map(row=>[row.dataset.activityId,row.dataset.activityState]));
    function key(n){
      if(n?.nodeType!==1)return null;
      for(const field of ['activityId','progressGroupId','progressKey','toolId','toolLedgerKey','liveKey'])if(n.dataset[field])return field+':'+n.dataset[field];
      return null;
    }
    // A second same-name tool can introduce a group around the existing first
    // row. Reuse that row across the new parent as well as across sibling deltas.
    const reusable=new Map([...(before?.querySelectorAll('[data-activity-id]')||[])].map(row=>[key(row),row]));
    const transplant=node=>{
      if(node.nodeType!==1)return;
      for(const child of [...node.children]){
        const old=reusable.get(key(child));
        if(old&&old!==child){sync(old,child);child.replaceWith(old);root.HalaskaConversation?.discard(child);reusable.delete(key(old));}
        else transplant(child);
      }
    };
    function sync(a,b){
      if(a===body&&b===nextBody&&root.StreamingBody?.patch(a,b,{selection:selected,onTextEdit:(node,edit)=>root.StreamingBody.remapSelection(selected,node,edit)}))return;
      if(a.dataset?.liveKey==='flow-text'&&b.dataset?.liveKey==='flow-text'&&root.StreamingBody?.patch(a,b,{selection:selected,onTextEdit:(node,edit)=>root.StreamingBody.remapSelection(selected,node,edit)}))return;
      if(a.dataset?.citationPanel&&b.dataset?.citationPanel&&root.CitationEvidence?.patchSection?.(a,b))return;
      if(a.dataset?.halaskaConversation&&b.dataset?.halaskaConversation&&root.HalaskaConversation?.patchIsland(a,b))return;
      // A settled receipt now lives in the retained process subtree. Its new
      // detached host is empty until attachment; diffing that empty shell would
      // erase the mounted card on the next final-state refresh.
      if(a.dataset?.liveKey?.startsWith('checkpoint-')&&a.dataset.liveKey===b.dataset?.liveKey&&typeof b._refreshCheckpoint==='function'){
        a._refreshCheckpoint=b._refreshCheckpoint;b._refreshCheckpoint(a);return;
      }
      if(a.isEqualNode(b)){
        // An identical ancestor can bypass the per-body patch. Still transfer
        // the freshly validated render ownership to its retained flow bodies.
        const oldFlow=a.querySelectorAll?.('[data-live-key="flow-text"]')||[],newFlow=b.querySelectorAll?.('[data-live-key="flow-text"]')||[];
        for(let i=0;i<oldFlow.length;i++)root.StreamMarkdown?.adoptBody?.(oldFlow[i],newFlow[i]);
        return;
      }
      if(a.nodeType!==b.nodeType||a.nodeName!==b.nodeName){a.replaceWith(b);return;}
      if(a.nodeType===3){a.nodeValue=b.nodeValue;return;}
      for(const attr of [...a.attributes])if(!(a._interactionDesiredOpen!==undefined&&['open','style'].includes(attr.name))&&!(attr.name==='open'&&keepOpen(a,b))&&attr.name!=='data-activity-paused'&&!b.hasAttribute(attr.name))a.removeAttribute(attr.name);
      for(const attr of [...b.attributes])if(!(a._interactionDesiredOpen!==undefined&&['open','style'].includes(attr.name))&&a.getAttribute(attr.name)!==attr.value)a.setAttribute(attr.name,attr.value);
      let cursor=a.firstChild;
      for(const child of [...b.childNodes]){
        let match=cursor;const id=key(child);
        if(id&&key(match||{})!==id)match=[...a.childNodes].find(n=>key(n)===id);
        if(!id&&key(match))match=null;
        if(!match){
          const remaining=[];for(let n=cursor;n;n=n.nextSibling)remaining.push(n);
          transplant(child);
          if(cursor?.parentNode!==a)cursor=remaining.find(n=>n.parentNode===a)||null;
          a.insertBefore(child,cursor);continue;
        }
        if(match!==cursor)a.insertBefore(match,cursor);
        const following=match.nextSibling;sync(match,child);cursor=following;
      }
      while(cursor){const following=cursor.nextSibling;cursor.remove();cursor=following;}
    }
    for(const [newNode,oldNode] of preserved){
      root.ToolScheduler?.prepareText?.(oldNode,newNode,{keepOpen});
      sync(oldNode,newNode);
    }
    // Grouping can add a new parent around the same retained, selected row.
    // That new disclosure must not conceal the row merely because it has no
    // previous DOM identity; untouched sibling groups still settle normally.
    for(const scope of processRoots)for(const details of [scope,...scope.querySelectorAll('details')]){
      if(details.nodeName==='DETAILS'&&!details.open&&keepOpen(details))details.open=true;
    }
    for(const attr of [...previous.attributes])if(!next.hasAttribute(attr.name))previous.removeAttribute(attr.name);
    for(const attr of [...next.attributes])if(previous.getAttribute(attr.name)!==attr.value)previous.setAttribute(attr.name,attr.value);
    // A transport delta can arrive many times per second. Only actual phase or
    // lifecycle changes animate, never every new word or elapsed-time update.
    if(before&&after){
      if(priorPhase!==before.dataset.progressPhase&&!before.querySelector('[data-lifecycle-stable-heading]'))root.ActivityMotion?.animate(before.querySelector('.progress-phase-label'),[{opacity:0,transform:'translateY(4px)'},{opacity:1,transform:'translateY(0)'}],{duration:220,easing:'cubic-bezier(.2,0,0,1)'});
      for(const row of before.querySelectorAll('[data-activity-id]')){
        const old=priorStates.get(row.dataset.activityId);
        if(old&&old!==row.dataset.activityState)root.ActivityMotion?.animate(row.querySelector('.progress-mark'),[{opacity:.35,transform:'scale(.82)'},{opacity:1,transform:'scale(1)'}],{duration:220,easing:'cubic-bezier(.2,0,0,1)'});
      }
    }
    const kept=new Set(preserved.values());
    for(const child of [...previous.childNodes])if(!kept.has(child)){if(child.nodeType===1){root.HalaskaConversation?.discard(child);root.CitationEvidence?.discard?.(child);}child.remove();}
    let cursor=previous.firstChild;
    for(const child of [...next.childNodes]){
      const node=preserved.get(child)||child;
      if(node!==cursor)previous.insertBefore(node,cursor);
      cursor=node.nextSibling;
    }
    if(heldView){root.ConversationProcess?.select?.(previous,heldView);root.HalaskaConversation?.setProcessView?.(previous,heldView);}
    root.ConversationProcess?.filterTools?.(previous, { readingNodes: [focused, ...(selectedText ? [selected.anchor, selected.focus] : [])] });
    // DOM reparenting a first activity into its group may blur a summary. Restore
    // only the exact still-connected control; no focus jump to a replacement.
    if(focused?.isConnected&&previous.contains(focused)&&root.document.activeElement!==focused)focused.focus?.({preventScroll:true});
    if(selected?.anchor.isConnected&&selected.focus.isConnected){
      const limit=node=>node.nodeType===3?node.length:node.childNodes.length;
      selection.setBaseAndExtent(selected.anchor,Math.min(selected.anchorOffset,limit(selected.anchor)),selected.focus,Math.min(selected.focusOffset,limit(selected.focus)));
    }
    // Equal vanilla subtrees can bypass sync, leaving a newly built React root
    // in the discarded holder. Dispose it explicitly rather than relying on a
    // MutationObserver that may never have seen this detached root connected.
    root.HalaskaConversation?.discard(next);
    root.CitationEvidence?.discard?.(next);
  }
  // Only public summaries and actual tool lifecycle events enter this feed.
  function update(message, event, now = Date.now()) {
    if (!event || !['summary', 'commentary', 'tool'].includes(event.kind) || typeof event.id !== 'string' || !event.id) return;
    message.activities ||= [];
    const id = event.id.slice(0,180);
    const previous = message.activities.find(item => item.id === id);
    const value = {id, kind:event.kind, name:String(event.name || '').slice(0,80),
      text:String(event.text || ''), status:statuses.has(event.status) ? event.status : 'unknown', at:previous?.at || now, updatedAt:now};
    if (previous) Object.assign(previous,value); else message.activities.push(value);
  }
  function finish(message, status) {
    for (const item of message.activities || []) if (item.status === 'running') item.status = status;
  }
  function entries(message) {
    const steps = (message.steps || []).map((step,index) => ({...step,id:step.id || `step-${index}`,kind:'step',at:step.at || message.at || 0}));
    return [...steps,...(message.activities || [])].sort((a,b) => a.at-b.at);
  }
  function duration(start, end = Date.now()) {
    const seconds = Math.max(0, Math.floor((end-start)/1000));
    return seconds >= 3600 ? `${Math.floor(seconds/3600)} 小时 ${Math.floor(seconds%3600/60)} 分` : seconds >= 60 ? `${Math.floor(seconds/60)} 分 ${seconds%60} 秒` : `${seconds} 秒`;
  }
  // 段级呼吸：正在流式的段自动展开，段完成后自动收束；用户手动开合过的段以用户
  // 的选择为准（progressPins），自动逻辑不再覆盖它。开合状态从消息数据渲染，
  // 不在 DOM 层复制，避免“自动收束被旧 DOM 状态还原”的历史行为。
  function pinned(message, key) {
    if (!message || !message.progressPins || !Object.prototype.hasOwnProperty.call(message.progressPins, key)) return null;
    return message.progressPins[key] === true;
  }
  function openAttr(message, key, auto) {
    const choice = pinned(message, key);
    return ((choice === null ? !!auto : choice) ? ' open' : '')
      +(choice===null?'':` data-progress-user-open="${choice}"`);
  }
  function pin(message, key, open) {
    if (!message || typeof key !== 'string' || !key) return false;
    message.progressPins ||= {};
    if (message.progressPins[key] === (open === true)) return false;
    message.progressPins[key] = open === true;
    return true;
  }
  // Missing or unrecognised transport states are not evidence of completion.
  // Retain an explicit rejection in historical records; all other unknown
  // states remain pending until an actual lifecycle event resolves them.
  function itemState(item) {
    if (item.status === 'done') return 'completed';
    if (item.status === 'rejected') return 'rejected';
    return statuses.has(item.status) ? item.status : 'pending';
  }
  const stateLabels = {running:'进行中',pending:'待执行',unknown:'未确认',completed:'已完成',failed:'失败',cancelled:'已停止',rejected:'已拒绝'};
  const countState = item => statuses.has(item.status) || item.status === 'rejected' ? itemState(item) : 'unknown';
  function markup(message) {
    const items = entries(message); if (!items.length) return '';
    const active = [...items].reverse().find(item => item.status === 'running');
    const currentPhase = phase(message, active);
    const newest = items[items.length-1];
    // 思考段与 NewMax 的“深度思考”对齐命名（Responses 的思考摘要与 chat 的
    // reasoning_content 明文思考共用此段类型，都是模型的思考内容本身）。
    const title = item => item.kind === 'step' ? item.text : item.kind === 'tool' ? (item.name || '工具操作') : item.kind === 'summary' ? t('模型思考', 'Model reasoning') : '模型进展';
    // A stage title is an actual lifecycle marker, not a recorded explanation.
    // Never manufacture an expandable body from timestamps or nearby events:
    // reasoning and tool content have their own durable records below.
    const activeText = active && (active.kind === 'summary' || active.kind === 'commentary') ? active.text.split('\n').filter(Boolean).pop() : active ? title(active) : '';
    const status = message.live ? 'running' : message.runStatus || (message.retryRunId ? 'failed' : 'unknown');
    const labels = {completed:'已完成',done:'已完成','completed-local':'已完成',failed:'执行失败',cancelled:'已停止','awaiting-approval':'等待审批',rejected:'已拒绝'};
    // 段级状态行：当前没有进行中的段（工具已完成、模型正在生成下一段）时给出过渡状态，
    // 而不是停留在最后一段的旧标题上。
    const heading = message.live ? activeText || (active ? title(active) : '等待模型继续') : labels[status] || '执行记录';
    const mark = state => state === 'running' ? '<span class="progress-active-mark" aria-hidden="true"></span>' : state === 'failed' ? '!' : state === 'cancelled' ? '−' : ['done','completed','completed-local'].includes(state) ? '✓' : '○';
    // 段级耗时：有起止时间的段显示实际用时，便于看出哪一步占了大头（没有时间戳的段不显示）。
    const itemTitle = item => {
      const base = title(item), start = Number(item.at), end = Number(item.updatedAt);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return esc(base);
      return `${esc(base)}<span class="progress-cost">${esc(duration(start, end))}</span>`;
    };
    const rowMarkup = (item, index) => {
      const detail = item.kind === 'step' ? item.detail : item.text;
      const body = typeof detail === 'string' && detail.trim() ? `<div class="progress-item-body">${esc(detail)}</div>` : '';
      const state = itemState(item), label = stateLabels[countState(item)];
      return `<li class="progress-item is-${esc(state)}" data-activity-id="${esc(item.id)}" data-activity-state="${esc(state)}"><span class="progress-mark" aria-label="${label}">${mark(state)}</span><div class="progress-item-content">${body ? `<details data-progress-key="${esc(item.id)}"${openAttr(message, item.id, message.live && ['running','pending'].includes(state))}><summary>${itemTitle(item)}</summary>${body}</details>` : `<span class="progress-stage-label">${itemTitle(item)}</span>`}</div></li>`;
    };
    // Consecutive tool calls form one real disclosure, not an extra summary
    // after the same N rows. Its key is anchored to the first call so appending
    // a delta or another call does not reset the user's disclosure choice.
    const rows = [];
    for (let cursor = 0; cursor < items.length;) {
      const head = items[cursor];
      let end = cursor + 1;
      if (head.kind === 'tool' && head.name) {
        while (end < items.length && items[end].kind === 'tool' && items[end].name === head.name) end += 1;
      }
      if (end - cursor < 2) {
        rows.push(rowMarkup(head, cursor)); cursor = end; continue;
      }
      const members = items.slice(cursor, end), key = `group:${head.id}`;
      const counts = {running:0,pending:0,unknown:0,failed:0,cancelled:0,rejected:0,completed:0};
      let ms = 0;
      for (const item of members) {
        counts[countState(item)] += 1;
        const from = Number(item.at), to = Number(item.updatedAt);
        if (Number.isFinite(from) && Number.isFinite(to) && to > from) ms += to - from;
      }
      const state = ['running','failed','pending','unknown','rejected','cancelled','completed'].find(value => counts[value] > 0);
      const countText = Object.entries(counts).filter(([,count]) => count > 0).map(([value,count]) => `${stateLabels[value]} ${count}`).join(' · ');
      const autoOpen = counts.running > 0 || counts.pending > 0 || counts.unknown > 0 || members.some(item => pinned(message, item.id) === true);
      const cost = ms >= 1000 ? `<span class="progress-group-cost">累计 ${esc(duration(0, ms))}</span>` : '';
      const children = members.map((item,index) => rowMarkup(item,cursor + index)).join('');
      rows.push(`<li class="progress-group is-${state}" data-progress-group-id="${esc(key)}" data-group-name="${esc(head.name)}" data-group-count="${members.length}" data-group-status="${state}" data-group-counts="${esc(JSON.stringify(counts))}" data-group-duration="${ms}"><details class="progress-group-details" data-progress-key="${esc(key)}"${openAttr(message, key, autoOpen)}><summary><span class="progress-group-mark" aria-hidden="true">${mark(state)}</span><span class="progress-group-text">${esc(head.name)} ×${members.length}</span><span class="progress-group-status">${esc(countText)}</span>${cost}<span class="progress-chevron" aria-hidden="true">›</span></summary><ol class="progress-group-items">${children}</ol></details></li>`);
      cursor = end;
    }
    const start = Number(message.startedAt || message.at), end = Number(message.finishedAt);
    const elapsed = start > 0 && (message.live || end >= start) ? `<span class="progress-elapsed" ${message.live ? `data-progress-start="${start}"` : ''}>${duration(start,message.live ? Date.now() : end)}</span>` : '';
    const phaseLabels={thinking:t('正在思考','Thinking'),tool:t('正在执行','Working'),writing:t('正在回答','Writing'),waiting:t('等待模型','Waiting')};
    const indicator=message.live?'<span class="progress-activity" aria-hidden="true"><svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="6.5"/><path d="M10 3.5a6.5 6.5 0 0 1 6.5 6.5"/></svg></span>':mark(status);
    const readingPinned = items.some(item => pinned(message, item.id) === true || pinned(message, `group:${item.id}`) === true);
    return `<details class="agent-progress" data-progress-phase="${currentPhase}" data-progress-key="feed"${openAttr(message, 'feed', !!message.live || readingPinned)}><summary><span class="progress-heading-mark">${indicator}</span>${message.live?`<span class="progress-phase-label">${phaseLabels[currentPhase]}</span>`:''}<span class="progress-heading-text">${esc(heading)}</span><span class="progress-count">${items.length} 项活动</span>${elapsed}<span class="progress-chevron" aria-hidden="true">›</span></summary><ol class="progress-timeline">${rows.join('')}</ol></details>`;
  }
  root.AgentProgress = {update,finish,entries,markup,duration,pin,phase,patchLive};
  if (typeof module !== 'undefined' && module.exports) module.exports = root.AgentProgress;
})(typeof globalThis !== 'undefined' ? globalThis : this);
