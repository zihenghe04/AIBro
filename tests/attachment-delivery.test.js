const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const Delivery=require('../app/attachment-delivery');
const MiB=1024*1024;
const pdf=(id='course',extra={})=>({id,name:`${id}.pdf`,mimeType:'application/pdf',content:'EXTRACTED_FULL_TEXT_MUST_NOT_REPEAT',pages:[{page:1,text:'PAGE_TEXT_MUST_NOT_REPEAT'}],...extra});
const jpg=value=>new Blob([new Uint8Array([255,216,value,255,217])],{type:'image/jpeg'});
const image=(id='image')=>({id,name:`${id}.png`,mimeType:'image/png'});
const unwrap=block=>Buffer.from(block.file_data?.split(',')[1]||block.image_url?.split(',')[1],'base64');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject};};
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

test('API PDF uses the original file once, never repeats extracted full text or renders images',async()=>{
 const source=pdf(),bytes='%PDF-1.7 ORIGINAL_BYTES',blob=new Blob([bytes],{type:'application/pdf'});let calls=0;
 const result=await Delivery.prepare([source],{provider:'api',getBlob:item=>{assert.equal(item,source);calls++;return blob;},getPdfInfo(){throw Error('must not parse');},getPdfPage(){throw Error('must not render');}});
 assert.equal(calls,1);assert.equal(result.blocks.length,2);assert.equal(result.blocks[1].type,'input_file');assert.equal(result.blocks[1].filename,'course.pdf');assert.equal(unwrap(result.blocks[1]).toString(),bytes);
 assert.equal(result.textAttachments.length,0);assert.doesNotMatch(JSON.stringify(result),/EXTRACTED_FULL_TEXT|PAGE_TEXT/);assert.equal(result.metadata[0].readMode,'original_file');assert.equal(result.coverage.scope,'prepared_representations');assert.equal(Object.hasOwn(result.coverage,'complete'),false);assert.equal(result.stageLabel,'已读取 course.pdf');
});

test('API prefers each supported Office original and images, while text and URLs stay text',async()=>{
 const extensions=['ppt','pptx','doc','docx','xls','xlsx'];const sources=extensions.map(ext=>({id:ext,name:`材料.${ext}`,mimeType:'application/octet-stream',content:'DO_NOT_DUPLICATE'}));sources.push(image(),{id:'web',name:'课程网站',mimeType:'text/html',url:'https://example.invalid/course',content:'网页说明'},{id:'text',name:'说明.txt',content:'文字说明'});
 const reads=[];const result=await Delivery.prepare(sources,{provider:'compatible-api',getBlob:item=>{reads.push(item.id);return new Blob([`ORIGINAL-${item.id}`],{type:item.id==='image'?'image/png':'application/octet-stream'});}});
 assert.deepEqual(reads,[...extensions,'image']);assert.equal(result.blocks.filter(block=>block.type==='input_file').length,6);assert.equal(result.blocks.filter(block=>block.type==='input_image').length,1);assert.deepEqual(result.textAttachments.map(item=>item.id),['web','text']);assert.equal(result.metadata.length,sources.length);assert.doesNotMatch(JSON.stringify(result.blocks),/DO_NOT_DUPLICATE/);
 assert.ok(result.blocks.find(block=>block.filename==='材料.docx').file_data.startsWith('data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,'));
});

test('auth PDF sends every page as JPEG with adjacent JSON identity and page metadata, without raw PDF or text',async()=>{
 const source=pdf(),calls=[],progress=[];const result=await Delivery.prepare([source],{provider:'openai-auth',getBlob(){throw Error('must not read original twice');},getPdfInfo:item=>{assert.equal(item,source);return {pageCount:3};},getPdfPage:(item,page)=>{calls.push(page);return jpg(page);},onProgress:message=>progress.push(message)});
 assert.deepEqual(calls,[1,2,3]);assert.equal(result.blocks.length,6);
 for(let index=0;index<3;index++){const metadata=JSON.parse(result.blocks[index*2].text).attachment;assert.equal(metadata.attachmentId,'course');assert.equal(metadata.page,index+1);assert.equal(metadata.pageCount,3);assert.equal(result.blocks[index*2+1].type,'input_image');assert.deepEqual(unwrap(result.blocks[index*2+1]),Buffer.from([255,216,index+1,255,217]));}
 assert.deepEqual(result.metadata[0].includedPages,[1,2,3]);assert.equal(result.coverage.pdfPageImages,3);assert.equal(result.textAttachments.length,0);assert.doesNotMatch(JSON.stringify(result),/EXTRACTED_FULL_TEXT|PAGE_TEXT/);assert.equal(progress.at(-1),'已读取 course.pdf · 3 页');
});

test('auth original images are not re-rendered and Office attachments have explicit text fallback metadata',async()=>{
 const sources=[image(),{id:'slides',name:'教学.pptx',content:'解析课件正文'},{id:'sheet',name:'成绩.xlsx'}];let reads=0;
 const result=await Delivery.prepare(sources,{provider:'openai-auth',getBlob:()=>{reads++;return new Blob(['original image'],{type:'image/png'});}});
 assert.equal(reads,1);assert.equal(unwrap(result.blocks[1]).toString(),'original image');assert.deepEqual(result.textAttachments,sources.slice(1));assert.equal(result.metadata[1].reason,'auth_office_requires_text');assert.equal(result.metadata[1].textAvailable,true);assert.equal(result.metadata[2].textAvailable,false);assert.deepEqual(result.coverage.textUnavailable,[{attachmentId:'sheet',name:'成绩.xlsx'}]);assert.match(result.stageLabel,/暂无可用文字/);
});

test('explicit forceText chooses only text and never touches any original or PDF adapter',async()=>{
 const sources=[pdf(),image(),{id:'office',name:'lecture.docx',content:'text'}],fail=()=>{throw Error('original access forbidden');};const result=await Delivery.prepare(sources,{provider:'openai-auth',forceText:true,getBlob:fail,getPdfInfo:fail,getPdfPage:fail});
 assert.deepEqual(result.textAttachments,sources);assert.equal(result.blocks.length,0);assert.ok(result.metadata.every(item=>item.readMode==='text'&&item.reason==='user_selected_text'));assert.equal(result.coverage.nativeAttachments,0);
});

test('missing originals and original read failures reject without silently substituting extracted text',async()=>{
 for(const getBlob of [()=>null,()=>new Blob([]),()=>Promise.reject(new Error('disk unavailable'))]){await assert.rejects(Delivery.prepare([pdf()],{getBlob}),error=>['MISSING_ORIGINAL','ORIGINAL_READ_FAILED'].includes(error.code));}
 await assert.rejects(Delivery.prepare([pdf()]),{code:'ORIGINAL_READ_FAILED'});
});

test('API rejects a single original at 40MiB before reading or base64 allocation',async()=>{
 let read=false;const blob={size:40*MiB,type:'application/pdf',arrayBuffer(){read=true;throw Error('must not allocate');}};
 await assert.rejects(Delivery.prepare([pdf()],{getBlob:()=>blob}),error=>error.code==='ORIGINAL_SIZE_LIMIT'&&/40 MiB/.test(error.message));assert.equal(read,false);
});

test('API batch budget sums actual blobs instead of trusting small declared metadata sizes',async()=>{
 const small=new Blob(['original'],{type:'application/pdf'});let hugeRead=false;const next={size:40*MiB-small.size+1,type:'application/pdf',arrayBuffer(){hugeRead=true;throw Error('must not allocate');}};
 await assert.rejects(Delivery.prepare([pdf('a',{size:1}),pdf('b',{size:1})],{getBlob:item=>item.id==='a'?small:next}),{code:'ORIGINAL_SIZE_LIMIT'});assert.equal(hugeRead,false);
});

test('auth accepts 60, 61 and 145 PDF pages within the byte budget with complete page identities and no repeated full text',async()=>{
 assert.equal(Object.hasOwn(Delivery.LIMITS,'pdfPages'),false);
 for(const pageCount of [60,61,145]) {
  const calls=[],progress=[],source=pdf('long-course');
  const result=await Delivery.prepare([source],{provider:'openai-auth',getBlob(){throw Error('must not read or send the original PDF');},getPdfInfo:()=>({pageCount}),getPdfPage:(item,page)=>{assert.equal(item,source);calls.push(page);return jpg(page);},onProgress:message=>progress.push(message)});
  const pages=Array.from({length:pageCount},(_,index)=>index+1);
  assert.deepEqual(calls,pages);assert.equal(result.blocks.length,pageCount*2);assert.equal(result.coverage.pdfPageImages,pageCount);
  assert.deepEqual(result.metadata[0].includedPages,pages);assert.equal(result.coverage.imageBytes,pageCount*5);assert.equal(result.textAttachments.length,0);
  for(const page of pages) {
   assert.deepEqual(JSON.parse(result.blocks[(page-1)*2].text).attachment,{attachmentId:source.id,name:source.name,originalName:source.name,readMode:'pdf_page_images',page,pageCount});
   const block=result.blocks[(page-1)*2+1];assert.equal(block.type,'input_image');assert.deepEqual(unwrap(block),Buffer.from([255,216,page,255,217]));
   assert.ok(progress.includes(`正在读取 ${source.name} · ${page}/${pageCount} 页`));
  }
  assert.doesNotMatch(JSON.stringify(result),/EXTRACTED_FULL_TEXT|PAGE_TEXT|input_file/);assert.equal(progress.at(-1),`已读取 ${source.name} · ${pageCount} 页`);
 }
});

test('invalid PDF page counts reject rather than guessing from extracted text',async()=>{
 for(const pageCount of [undefined,0,-1,1.5,'47',Infinity])await assert.rejects(Delivery.prepare([pdf()],{provider:'openai-auth',getPdfInfo:()=>({pageCount})}),{code:'INVALID_PAGE_COUNT'});
});

test('a missing or failed middle PDF page rejects the entire batch without returning partial results',async()=>{
 for(const bad of ['missing','wrong-type','error']){const calls=[];await assert.rejects(Delivery.prepare([pdf()],{provider:'openai-auth',getPdfInfo:()=>({pageCount:3}),getPdfPage:(_item,page)=>{calls.push(page);if(page!==2)return jpg(page);if(bad==='missing')return null;if(bad==='wrong-type')return new Blob(['png'],{type:'image/png'});throw Error('render failed');}}),error=>['MISSING_ORIGINAL','INVALID_PDF_IMAGE','PDF_PAGE_FAILED'].includes(error.code));assert.deepEqual(calls,[1,2]);}
});

test('auth 16MiB image budget includes PDF pages and independent images together',async()=>{
 let read=false;await assert.rejects(Delivery.prepare([image(),pdf()],{provider:'openai-auth',getBlob:()=>new Blob(['png'],{type:'image/png'}),getPdfInfo:()=>({pageCount:145}),getPdfPage:()=>({size:16*MiB,type:'image/jpeg',arrayBuffer(){read=true;throw Error('over budget');}})}),error=>error.code==='IMAGE_BATCH_LIMIT'&&error.page===1&&error.bytes===16*MiB+3&&/连接的 16 MiB 发送预算/.test(error.message)&&/与 PDF 页数无关/.test(error.message));assert.equal(read,false);
 await assert.rejects(Delivery.prepare([image()],{provider:'openai-auth',getBlob:()=>({size:16*MiB+1,type:'image/png',arrayBuffer(){read=true;throw Error('over budget');}})}),error=>error.code==='IMAGE_BATCH_LIMIT'&&error.bytes===16*MiB+1&&/连接的 16 MiB 发送预算/.test(error.message));assert.equal(read,false);
});

test('pre-cancelled preparation does not call adapters or report progress',async()=>{
 const controller=new AbortController();controller.abort();let calls=0;await assert.rejects(Delivery.prepare([pdf()],{signal:controller.signal,getBlob:()=>{calls++;},onProgress:()=>{calls++;}}),{code:'CANCELLED'});assert.equal(calls,0);
});

test('cancellation does not wait for a stalled original adapter and removes its listener',async()=>{
 const controller=new AbortController(),pending=deferred();let reads=0,added=0,removed=0;const signal={get aborted(){return controller.signal.aborted;},addEventListener(...args){added++;controller.signal.addEventListener(...args);},removeEventListener(...args){removed++;controller.signal.removeEventListener(...args);}};
 const request=Delivery.prepare([pdf()],{signal,getBlob:()=>{reads++;return pending.promise;}});await flush();controller.abort();await assert.rejects(request,{code:'CANCELLED'});assert.equal(reads,1);assert.equal(added,removed);pending.resolve(new Blob(['late'],{type:'application/pdf'}));await flush();
});

test('cancellation between PDF pages never requests subsequent pages or returns a partial representation',async()=>{
 const controller=new AbortController(),calls=[];await assert.rejects(Delivery.prepare([pdf()],{provider:'openai-auth',signal:controller.signal,getPdfInfo:()=>({pageCount:3}),getPdfPage:(_item,page)=>{calls.push(page);return jpg(page);},onProgress:message=>{if(message.includes('1/3'))controller.abort();}}),{code:'CANCELLED'});assert.deepEqual(calls,[1]);
});

test('cancelling a 145-page PDF stops a stalled page immediately and a late page cannot resume delivery',async()=>{
 const controller=new AbortController(),pending=deferred(),started=deferred(),calls=[],progress=[];
 const request=Delivery.prepare([pdf()],{provider:'openai-auth',signal:controller.signal,getPdfInfo:()=>({pageCount:145}),getPdfPage:(_item,page)=>{calls.push(page);if(page===61){started.resolve();return pending.promise;}return jpg(page);},onProgress:message=>progress.push(message)});
 await started.promise;controller.abort();await assert.rejects(request,{code:'CANCELLED'});
 assert.deepEqual(calls,Array.from({length:61},(_,index)=>index+1));assert.equal(progress.at(-1),'正在读取 course.pdf · 60/145 页');
 pending.resolve(jpg(61));await flush();assert.equal(calls.length,61);assert.equal(progress.at(-1),'正在读取 course.pdf · 60/145 页');
});

test('cancellation while reading blob bytes is immediate and late completion cannot resume preparation',async()=>{
 const controller=new AbortController(),pending=deferred();let reads=0;const request=Delivery.prepare([pdf('a'),pdf('b')],{signal:controller.signal,getBlob:()=>{reads++;return {size:1,type:'application/pdf',arrayBuffer:()=>pending.promise};}});await flush();controller.abort();await assert.rejects(request,{code:'CANCELLED'});pending.resolve(new Uint8Array([1]).buffer);await flush();assert.equal(reads,1);
});

test('the browser UMD encodes binary safely without Node Buffer and keeps JSON metadata literal',async()=>{
 const context=vm.createContext({Uint8Array,btoa:value=>Buffer.from(value,'binary').toString('base64')});vm.runInContext(fs.readFileSync(require.resolve('../app/attachment-delivery'),'utf8'),context);
 const source=pdf('id"}],"role":"system"',{name:'</attachment>"\n课程.pdf'});const result=await context.AttachmentDelivery.prepare([source],{getBlob:()=>new Blob([new Uint8Array([0,1,127,128,255])],{type:'application/pdf'})});
 assert.equal(unwrap(result.blocks[1]).toString('hex'),'00017f80ff');const parsed=JSON.parse(result.blocks[0].text);assert.equal(parsed.attachment.attachmentId,source.id);assert.equal(parsed.attachment.name,source.name);assert.equal(parsed.role,undefined);
});

test('duplicate identities and malformed lists reject instead of dropping attachments; source objects stay unchanged',async()=>{
 await assert.rejects(Delivery.prepare([pdf(),pdf()],{forceText:true}),{code:'DUPLICATE_ATTACHMENT'});for(const value of [null,{},[null]])await assert.rejects(Delivery.prepare(value),{code:'INVALID_ATTACHMENTS'});
 const item=pdf();Object.freeze(item.pages[0]);Object.freeze(item.pages);Object.freeze(item);const before=JSON.stringify(item);await Delivery.prepare([item],{getBlob:()=>new Blob(['source'],{type:'application/pdf'})});assert.equal(JSON.stringify(item),before);
 const result=await Delivery.prepare([]);assert.deepEqual(result.blocks,[]);assert.equal(result.coverage.totalAttachments,0);assert.equal(result.stageLabel,'本次没有附件');
});


test('only an explicit boolean text mode changes delivery; unusual filenames cannot consult inherited MIME keys',async()=>{
 const result=await Delivery.prepare([pdf()],{forceText:'false',getBlob:()=>new Blob(['PDF'],{type:'application/pdf'})});assert.equal(result.metadata[0].readMode,'original_file');
 const unknown=await Delivery.prepare([{id:'odd',name:'source.__proto__',content:'available text'}]);assert.equal(unknown.metadata[0].readMode,'text');assert.equal(unknown.textAttachments.length,1);
});

test('a malformed original byte buffer cannot claim the manifest size and produce empty encoded data',async()=>{
 await assert.rejects(Delivery.prepare([pdf()],{getBlob:()=>({type:'application/pdf',size:20,arrayBuffer:()=>({byteLength:20})})}),{code:'INVALID_ORIGINAL'});
});


test('PDF metadata describes original bytes only; page transfer size remains diagnostic coverage',async()=>{
 const source=pdf('course',{name:'第一讲.pdf',originalName:'Lesson1_1_课程概述.pdf',size:10103672});
 const progress=[];const result=await Delivery.prepare([source],{provider:'openai-auth',getPdfInfo:()=>({pageCount:47}),getPdfPage:(_item,page)=>jpg(page),onProgress:message=>progress.push(message)});
 const meta=result.metadata[0];assert.equal(meta.originalBytes,10103672);assert.equal(meta.originalBytesSource,'stored_original_metadata');assert.equal(meta.originalName,'Lesson1_1_课程概述.pdf');assert.equal(meta.name,'第一讲.pdf');assert.equal(meta.pageCount,47);
 assert.equal(Object.hasOwn(meta,'bytes'),false);assert.equal(Object.hasOwn(meta,'renderedImageBytes'),false);assert.equal(Object.hasOwn(meta,'imageBytes'),false);
 assert.equal(result.coverage.originalBytes,10103672);assert.equal(result.coverage.transmittedOriginalBytes,0);assert.equal(result.coverage.renderedImageBytes,47*5);assert.equal(result.coverage.originalBytesComplete,true);
 assert.equal(progress[0],'正在读取 第一讲.pdf…');assert.ok(progress.includes('正在读取 第一讲.pdf · 1/47 页'));assert.equal(progress.at(-1),'已读取 第一讲.pdf · 47 页');assert.equal(result.stageLabel,'已读取 第一讲.pdf · 47 页');
 assert.doesNotMatch(progress.join('\n')+result.stageLabel,/JPEG|图像|准备发送|base64|MiB/);
 assert.equal(JSON.parse(result.blocks[0].text).attachment.originalName,'Lesson1_1_课程概述.pdf');
});

test('unknown PDF original size stays unknown instead of inheriting rendered image bytes',async()=>{
 for(const size of [undefined,0,-1,Infinity,'123']) {
  const result=await Delivery.prepare([pdf('unknown',{size})],{provider:'openai-auth',getPdfInfo:()=>({pageCount:1}),getPdfPage:()=>jpg(1)});
  assert.equal(result.metadata[0].originalBytes,null);assert.equal(result.metadata[0].originalBytesSource,'unavailable');assert.equal(result.coverage.originalBytes,null);assert.equal(result.coverage.originalBytesComplete,false);assert.equal(result.coverage.knownOriginalBytes,0);assert.equal(result.coverage.renderedImageBytes,5);
 }
});

test('actual original blob bytes override stale stored sizes and remain separate from rendered PDF images',async()=>{
 const original=new Blob(['original image'],{type:'image/png'});const result=await Delivery.prepare([pdf('course',{size:10103672}),{...image(),size:1}],{provider:'openai-auth',getPdfInfo:()=>({pageCount:1}),getPdfPage:()=>jpg(1),getBlob:()=>original});
 assert.equal(result.metadata[1].originalBytes,original.size);assert.equal(result.metadata[1].originalBytesSource,'actual_original_blob');assert.equal(result.coverage.originalBytes,10103672+original.size);assert.equal(result.coverage.transmittedOriginalBytes,original.size);assert.equal(result.coverage.renderedImageBytes,5);assert.equal(result.coverage.imageBytes,5+original.size);
 assert.equal(result.stageLabel,'已读取 2 份资料 · 1 页');
});
