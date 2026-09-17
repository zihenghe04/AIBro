/* Provider-neutral estimates, not a tokenizer. Budgets govern one request, never corpus access. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.ContextWindow=api;})(globalThis,function(){
 'use strict';
 function tokens(value){const text=typeof value==='string'?value:JSON.stringify(value);let wide=0;for(const c of text||'')if(c.charCodeAt(0)>127)wide++;return Math.ceil(wide*1.5+((text||'').length-wide)/3);}
 function budget(value,fallback=4000){if(value===undefined)return fallback;const n=Number(value);if(!Number.isSafeInteger(n)||n<256||n>16000)throw Error('Context budget must be 256–16000 estimated tokens');return n;}
 function page(ranked,{offset=0,maxTokens=4000}={}){const capacity=budget(maxTokens),entries=[];let used=0;for(const e of ranked.slice(offset)){const size=tokens(e);if(entries.length&&used+size>capacity)break;entries.push(e);used+=size;if(used>=capacity)break;}return {entries,nextOffset:offset+entries.length<ranked.length?offset+entries.length:null,estimatedTokens:used,tokenBudget:capacity};}
 // Interleave repeated sources after their strongest hit. Every candidate remains pageable.
 function diversify(ranked){const counts=new Map();return ranked.map((e,i)=>{const key=`${e.type}:${e.recordId}`,n=counts.get(key)||0;counts.set(key,n+1);return {e,rank:i+1+n*4};}).sort((a,b)=>a.rank-b.rank||String(a.e.id).localeCompare(String(b.e.id))).map(x=>x.e);}
 return {tokens,budget,page,diversify};
});
