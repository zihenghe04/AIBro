/* Provider-neutral estimates, not a tokenizer. Budgets govern one request, never corpus access. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.ContextWindow=api;})(globalThis,function(){
 'use strict';
 function tokens(value){const text=typeof value==='string'?value:JSON.stringify(value);let wide=0;for(const c of text||'')if(c.charCodeAt(0)>127)wide++;return Math.ceil(wide*1.5+((text||'').length-wide)/3);}
 function budget(value,fallback=4000){if(value===undefined)return fallback;const n=Number(value);if(!Number.isSafeInteger(n)||n<256||n>16000)throw Error('Context budget must be 256–16000 estimated tokens');return n;}
 function page(ranked,{offset=0,maxTokens=4000}={}){const capacity=budget(maxTokens),entries=[];let used=0;for(const e of ranked.slice(offset)){const size=tokens(e);if(entries.length&&used+size>capacity)break;entries.push(e);used+=size;if(used>=capacity)break;}return {entries,nextOffset:offset+entries.length<ranked.length?offset+entries.length:null,estimatedTokens:used,tokenBudget:capacity};}
 // Relative relevance is evaluated inside each original retrieval channel,
 // never against compressed RRF scores or across incomparable score scales.
 function promotionCandidates(ranked,field='score'){
  let best=0;for(const e of ranked)if(Number.isFinite(e[field]))best=Math.max(best,e[field]);
  return new Set(best>0?ranked.filter(e=>Number.isFinite(e[field])&&e[field]>0&&e[field]>=best*0.5).map(e=>e.id):[]);
 }
 function diversify(ranked,eligible=promotionCandidates(ranked)){
  // Keep the two strongest passages, then offer up to four relevant sources
  // near the front. Four is a first-page presentation budget, NOT a corpus
  // limit. All remaining passages retain their exact relevance order. Compute
  // this once over the full ranking before either count or token pagination.
  const front=ranked.slice(0,2),picked=new Set(front),key=e=>JSON.stringify([e.type,e.recordId]);
  const sources=new Set(front.map(key));
  for(const e of ranked){
   if(sources.size>=4)break;
   if(sources.has(key(e))||!eligible.has(e.id))continue;
   front.push(e);picked.add(e);sources.add(key(e));
  }
  return front.concat(ranked.filter(e=>!picked.has(e)));
 }
 return {tokens,budget,page,diversify,promotionCandidates};
});
