/* Resumable, local-only PDF text extraction. One original at a time; no model/API calls. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.PdfTextIndex=api;
})(globalThis,function(){
  'use strict';
  const VERSION=1;
  const active=x=>x&&!x.archived&&!x.archivedAt&&!x.deleted&&!x.deletedAt&&!['deleted','archived'].includes(x.status);
  const isPdf=r=>r?.mimeType==='application/pdf'||/\.pdf$/i.test(r?.name||r?.originalName||'');
  const cancelled=()=>Object.assign(Error('本机文字索引已暂停'),{code:'CANCELLED'});
  const invalidated=()=>Object.assign(Error('资料归属或文字已变化，未覆盖当前内容'),{code:'INVALIDATED'});
  const owned=['content','pages','pageCount','contentTruncated','parser','status','error','indexStatus','indexingToken','indexedAt','updatedAt','textIndex'];
  const stamp=r=>JSON.stringify([r.projectId||null,r.workspace||null,r.private,r.ephemeral,...owned.map(k=>r[k])]);
  function create({getState,persist,fetch:request=globalThis.fetch,ready=()=>true,busy=()=>false,onChanged=()=>{},readable=()=>true,delay=1000,setTimer=setTimeout,clearTimer=clearTimeout}){
    let timer=null,running=null,controller=null,stopped=false;
    const attempted=new Set();
    const usable=r=>active(r)&&isPdf(r)&&r.fileStored!==false&&readable(r)&&(!r.projectId||(getState().projects||[]).some(p=>p.id===r.projectId&&active(p)));
    const needs=r=>{
      if(!usable(r))return false;
      if(r.textIndex?.version===VERSION&&r.textIndex.status==='complete')return r.indexStatus==='saving';
      if(['pending','partial','saving','failed'].includes(r.indexStatus)||r.textIndex?.status==='indexing')return true;
      const pages=Array.isArray(r.pages)?r.pages:[];
      const hasText=!!String(r.content||r.text||r.extractedText||'').trim()||pages.some(p=>String(p.text||p.content||'').trim());
      // Preserve existing human-corrected text. Backfill missing or demonstrably
      // truncated legacy extraction, not every healthy PDF on every launch.
      return !hasText||r.contentTruncated===true||!r.textIndex&&(String(r.content||'').length===60000||pages.length===500||pages.some(p=>String(p.text||'').length===12000));
    };
    function current(id){return (getState().imports||[]).find(r=>r.id===id);}
    function schedule(){if(stopped||timer!==null)return;timer=setTimer(()=>{timer=null;void pump();},delay);}
    async function commit(id,expected,patch){
      const record=current(id);if(!usable(record)||stamp(record)!==expected)throw invalidated();
      const before=Object.fromEntries(owned.map(k=>[k,record[k]]));
      Object.assign(record,patch);const written=stamp(record);
      try{if(await persist()===false)throw Error('本机文字索引尚未保存');}
      catch(error){const latest=current(id);if(latest&&stamp(latest)===written){for(const k of owned){if(before[k]===undefined)delete latest[k];else latest[k]=before[k];}}throw error;}
      const latest=current(id);if(!usable(latest)||stamp(latest)!==written)throw invalidated();
      if(['ready','unavailable','failed'].includes(patch.indexStatus))onChanged(id);return written;
    }
    async function extract(id){
      const initial=current(id);if(!usable(initial))return;
      let baseline=stamp(initial),pages=[],sourceHash='',pageCount=0,nextPage=1;
      controller=new AbortController();const signal=controller.signal;
      const check=()=>{if(stopped||signal.aborted||!ready())throw cancelled();if(!usable(current(id))||stamp(current(id))!==baseline)throw invalidated();};
      const read=async(page,offset,source='')=>{
        check();const response=await request(`/__files/${encodeURIComponent(id)}/read-text?batch=1&page=${page}&offset=${offset}${source?'&source='+source:''}`,{cache:'no-store',signal});
        const result=await response.json();check();
        if(!response.ok)throw Object.assign(Error(result.error||`本机文字提取失败（HTTP ${response.status}）`),{code:result.code||'PDF_READ_FAILED'});
        if(!Array.isArray(result.parts)||!result.parts.length||result.parts.length>10||!Number.isSafeInteger(result.pageCount)||result.pageCount<page||!(/^[0-9a-f]{64}$/).test(result.sourceHash||''))throw Error('本机文字提取返回了无效批次');
        if(source&&result.sourceHash!==source)throw Object.assign(Error('PDF 原件已变化，请重新建立文字索引'),{code:'PDF_SOURCE_CHANGED'});
        return result;
      };
      // Probe the actual securely opened source even when resuming a checkpoint.
      // Never combine old and new source versions after an interrupted import.
      try{
      let first=await read(1,0);sourceHash=first.sourceHash;pageCount=first.pageCount;
      const previous=initial.textIndex;
      const savedPages=Array.isArray(initial.pages)?initial.pages:[];
      if(previous?.version===VERSION&&previous.sourceHash===sourceHash&&previous.pageCount===pageCount&&Number.isSafeInteger(previous.nextPage)&&previous.nextPage>1&&previous.nextPage<=pageCount+1&&savedPages.length===previous.nextPage-1&&savedPages.every((p,i)=>p.page===i+1&&typeof p.text==='string')){
        pages=savedPages.slice();nextPage=previous.nextPage;
      }
      let sinceCommit=0,charsSinceCommit=0;
      const checkpoint=async complete=>{
        check();const hasText=pages.some(p=>p.text.trim());
        const textIndex={version:VERSION,status:complete?'complete':'indexing',sourceHash,pageCount,nextPage,completedPages:pages.length,pagesWithoutText:pages.filter(p=>!p.text.trim()).map(p=>p.page)};
        // Page text is kept once, not duplicated in a giant content string.
        baseline=await commit(id,baseline,{content:'',pages:pages.slice(),pageCount,contentTruncated:!complete,parser:'pymupdf-local',status:hasText?'parsed':'original-only',error:complete&&!hasText?'没有可提取文字，可能是扫描页或空白页；未执行 OCR。':'',indexStatus:complete?'saving':'partial',indexingToken:undefined,textIndex,updatedAt:Date.now()});
        sinceCommit=0;charsSinceCommit=0;
        if(complete){
          // Only acknowledge ready after the complete text checkpoint is durable.
          baseline=await commit(id,baseline,{indexStatus:hasText?'ready':'unavailable',indexedAt:Date.now()});
        }
      };
        let pageOffset=0,pageText='',pageTotal=null;
        while(nextPage<=pageCount){
          check();if(busy())throw cancelled();
          const batch=nextPage===1&&pageOffset===0?first:await read(nextPage,pageOffset,sourceHash);
          if(batch.pageCount!==pageCount)throw Error('PDF 页信息在读取时发生变化');
          for(const part of batch.parts){
            if(part.page!==nextPage||part.offset!==pageOffset||typeof part.text!=='string'||!Number.isSafeInteger(part.totalChars)||part.totalChars<0||pageTotal!==null&&part.totalChars!==pageTotal)throw Error('PDF 文字批次顺序无效');
            pageTotal=part.totalChars;pageText+=part.text;
            const end=pageOffset+[...part.text].length;
            if(part.nextOffset!==null&&(!Number.isSafeInteger(part.nextOffset)||part.nextOffset!==end||end<=pageOffset||end>=pageTotal)||part.nextOffset===null&&end!==pageTotal)throw Error('PDF 文字分页不完整，已保留上次检查点');
            if(part.nextOffset===null){
              pages.push({page:nextPage,text:pageText});sinceCommit++;charsSinceCommit+=pageText.length;
              nextPage++;pageOffset=0;pageText='';pageTotal=null;
            }else pageOffset=part.nextOffset;
          }
          const complete=nextPage>pageCount;
          if(batch.nextPage!==(complete?null:nextPage)||batch.nextOffset!==(complete?null:pageOffset))throw Error('PDF 批次续读游标不一致');
          if(complete||sinceCommit>=10||charsSinceCommit>=100000)await checkpoint(complete);
        }
        if(nextPage>pageCount&&!['ready','unavailable'].includes(current(id)?.indexStatus))await checkpoint(true);
      }catch(error){
        if(error.code==='CANCELLED'||error.code==='INVALIDATED')throw error;
        const now=current(id);
        if(usable(now)&&stamp(now)===baseline){
          try{await commit(id,baseline,{indexStatus:'failed',error:`本机文字索引未完成：${error.message}。原件与已保存段落保留，可重试。`,textIndex:{...(now.textIndex||{}),version:VERSION,status:'failed',errorCode:error.code||'PDF_INDEX_FAILED'}});}catch{}
        }
        throw error;
      }
    }
    async function pump(){
      if(stopped||running)return running;
      if(!ready()||busy()){schedule();return;}
      const candidate=(getState().imports||[]).find(r=>needs(r)&&!attempted.has(r.id));
      if(!candidate)return;
      attempted.add(candidate.id);
      running=extract(candidate.id).catch(error=>{if(error.code==='CANCELLED'&&!stopped){attempted.delete(candidate.id);schedule();}}).finally(()=>{controller=null;running=null;schedule();});
      return running;
    }
    function enqueue(id){attempted.delete(id);schedule();}
    function stop(){stopped=true;if(timer!==null)clearTimer(timer);timer=null;controller?.abort();}
    return {workspaceSaved:schedule,enqueue,pump,stop,get busy(){return !!running;}};
  }
  let instance;
  return {VERSION,create,isPdf,init(options){instance?.stop();instance=create(options);instance.workspaceSaved();return instance;},get busy(){return !!instance?.busy;},workspaceSaved(){instance?.workspaceSaved();},enqueue(id){instance?.enqueue(id);},stop(){instance?.stop();}};
});
