const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const Core=require('../app/pdf-reader');
const source=fs.readFileSync(require.resolve('../app/pdf-reader'),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function harness(fetcher,language='zh',settings={}){
 const textRequests=[],requests=[],images=[],imageNodes=[],observers=[],listeners=new Map(),windowListeners=new Map(),raf=new Map(),timers=new Map(),toolbars=[],toasts=[],pages=[];let rafId=0,timerId=0,now=0,allowed=true,expanded=false;
 class Node{
  constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.dataset={};this.style={};this.hidden=false;this.clientWidth=settings.width||1000;this.clientHeight=settings.height||700;this.textContent='';}
  append(...children){for(const child of children){child.parent=this;this.children.push(child);}}
  insertBefore(child,reference){const index=this.children.indexOf(reference);child.parent=this;if(index<0)this.children.push(child);else this.children.splice(index,0,child);}
  replaceChildren(...children){for(const child of this.children)child.parent=null;this.children=[];this.append(...children);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);this.parent=null;}
  setAttribute(name,value){this.attributes[name]=String(value);}
  removeAttribute(name){delete this.attributes[name];if(name==='src')this._src='';}
  set src(value){this._src=value;images.push(value);}get src(){return this._src;}
 }
 const document={documentElement:{lang:language},createElement:tag=>{const node=new Node(tag);if(tag==='img')imageNodes.push(node);return node;},addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);}};
 const context={document,AbortController,devicePixelRatio:settings.dpr||1,setTimeout:(fn,delay)=>{timers.set(++timerId,{fn,at:now+delay});return timerId;},clearTimeout:id=>timers.delete(id),addEventListener:(name,fn)=>windowListeners.set(name,fn),removeEventListener:(name,fn)=>{if(windowListeners.get(name)===fn)windowListeners.delete(name);},fetch:async(...args)=>{if(args[0].includes('/preview-text')){textRequests.push(args);return settings.textFetcher?settings.textFetcher(...args):{ok:true,json:async()=>({page:Number(new URL(args[0],'http://fixture').searchParams.get('page')),pageCount:3,width:612,height:792,words:[]})};}requests.push(args);return fetcher?fetcher(...args):{ok:true,status:200,json:async()=>({pageCount:3,width:612,height:792})};},ResizeObserver:class{constructor(fn){this.fn=fn;observers.push(this);}observe(node){this.node=node;}disconnect(){this.disconnected=true;}},requestAnimationFrame:fn=>{raf.set(++rafId,fn);return rafId;},cancelAnimationFrame:id=>raf.delete(id),getComputedStyle:()=>({paddingLeft:'12',paddingRight:'12',paddingTop:'12',paddingBottom:'12'}),HalaskaUI:{mount:(node,name,props)=>{const island={name,props,update(value){this.props=value;},unmount(){this.unmounted=true;}};toolbars.push(island);return island;}}};
 if(settings.search)vm.runInNewContext(fs.readFileSync(require.resolve('../app/pdf-search'),'utf8'),context);vm.runInNewContext(source,context);const container=new Node('main');const options={item:{id:'fixture',name:'Actual original.pdf'},requestedPage:2,onPage:page=>pages.push(page),toast:text=>toasts.push(text),onValid:()=>allowed,isExpanded:()=>expanded,onExpand:value=>{expanded=value;}};
 const mount=(changes={})=>context.PDFReader.mount(container,{...options,...changes});const byClass=(name,node=container)=>node.className===name?node:node.children.map(child=>byClass(name,child)).find(Boolean);
 return{textRequests,context,api:context.PDFReader,mount,container,byClass,requests,images,imageNodes,observers,toolbars,toasts,pages,listeners,timers,windowListeners,get toolbar(){return toolbars.at(-1).props;},set allowed(value){allowed=value;},get expanded(){return expanded;},set dpr(value){context.devicePixelRatio=value;},advance(ms){now+=ms;for(const[id,entry]of [...timers])if(entry.at<=now){timers.delete(id);entry.fn();}},complete(image=imageNodes.at(-1),width=612,height=792){const scale=Number(new URL(image.src,'http://fixture').searchParams.get('scale'));image.naturalWidth=Math.ceil(width*scale);image.naturalHeight=Math.ceil(height*scale);image.onload?.();},flush(){for(const[id,fn]of [...raf]){raf.delete(id);fn();}},image(){return byClass('pdf-sheet')?.children[0];}};
}

test('fit width uses the actual container beyond the previous 800px cap',()=>{const size=Core.fitSize({width:1400,height:900,pageWidth:612,pageHeight:792});assert.equal(size.width,1376);assert.ok(size.height>900);});
test('fit page respects both dimensions for portrait and landscape documents',()=>{for(const[width,height]of[[612,792],[1600,900]]){const size=Core.fitSize({width:900,height:560,pageWidth:width,pageHeight:height,mode:'page'});assert.ok(size.width<=876);assert.ok(size.height<=536);assert.ok(Math.abs(size.width/size.height-width/height)<1e-10);}});
test('manual zoom clamps to 50–250% and page navigation rejects invalid inputs',()=>{assert.equal(Core.clampZoom(100),2.5);assert.equal(Core.clampZoom(-10),.5);assert.equal(Core.clampZoom(NaN),1);for(const value of[0,-1,2.5,'',Infinity,4])assert.equal(Core.validPage(value,3),null);assert.equal(Core.validPage('2',3),2);});
test('metadata loads only the requested page and keeps original identity and page callback',async()=>{const h=harness(),reader=h.mount();await reader.ready;assert.equal(h.requests.length,1);assert.equal(h.requests[0][0],'/__files/fixture/preview-info');assert.deepEqual(h.images,['/__files/fixture/preview?page=2&scale=1.75&fit=1']);assert.deepEqual(h.pages,[2]);assert.equal(h.toolbar.page,2);assert.equal(h.toolbar.count,3);assert.equal(h.toolbar.title,'Actual original.pdf');assert.equal(h.toolbars[0].name,'PDFReaderToolbar');reader.destroy();});
test('resize, fit modes, expand and zoom update immediately without synchronous raster requests',async()=>{const h=harness(),reader=h.mount();await reader.ready;const image=h.image();h.complete(image);assert.equal(image.style.width,'976px');h.toolbar.onFit('page');assert.equal(Number.parseFloat(image.style.height),676);h.toolbar.onZoom(.25);assert.equal(reader.getSnapshot().mode,'zoom');const requests=h.requests.length,pages=h.images.length;h.byClass('pdf-viewport').clientWidth=1500;h.observers[0].fn();h.flush();h.toolbar.onFit('width');assert.equal(image.style.width,'1476px');h.toolbar.onExpand();h.flush();assert.equal(h.expanded,true);assert.equal(h.toolbar.expanded,true);assert.equal(h.requests.length,requests);assert.equal(h.images.length,pages);reader.destroy();});
test('only focused canvas arrow keys navigate; form input events and modifiers do not',async()=>{const h=harness(),reader=h.mount();await reader.ready;const viewport=h.byClass('pdf-viewport');let prevented=0;const fire=extra=>viewport.onkeydown({key:'ArrowRight',target:viewport,preventDefault:()=>prevented++,...extra});fire({target:{tagName:'input'}});fire({ctrlKey:true});assert.equal(h.images.length,1);fire({});assert.equal(h.toolbar.page,3);assert.equal(prevented,1);assert.equal(h.images.length,2);fire({key:'ArrowLeft'});assert.equal(h.toolbar.page,2);reader.destroy();});
test('page errors expose a real retry which only reloads that page',async()=>{const h=harness(),reader=h.mount();await reader.ready;h.image().onerror();assert.equal(reader.getSnapshot().phase,'error');assert.match(h.toolbar.error,/重试/);const loads=h.requests.length;h.toolbar.onRetry();assert.equal(h.images.length,2);assert.equal(h.requests.length,loads);assert.equal(h.toolbar.page,2);assert.equal(h.toolbar.error,'');reader.destroy();});
test('late metadata and old image callbacks cannot repaint a replaced reader',async()=>{const gate=deferred(),h=harness(async()=>gate.promise);const first=h.mount(),second=h.mount({item:{id:'second',name:'Second.pdf'},requestedPage:1});assert.equal(h.toolbars[0].unmounted,true);gate.resolve({ok:true,json:async()=>({pageCount:2,width:612,height:792})});await Promise.all([first.ready,second.ready]);assert.deepEqual(h.images,['/__files/second/preview?page=1&scale=1.75&fit=1']);const oldImage=h.image(),late=oldImage.onload;second.setPage(2);oldImage.naturalWidth=9999;oldImage.naturalHeight=9999;late();assert.equal(second.getSnapshot().phase,'page');assert.equal(second.getSnapshot().page,2);second.destroy();});
test('privacy changes discard pending data and erase already loaded canvas content',async()=>{const gate=deferred(),h=harness(async()=>gate.promise),reader=h.mount();h.allowed=false;gate.resolve({ok:true,json:async()=>({pageCount:3})});await reader.ready;assert.equal(h.container.children.length,0);assert.equal(h.images.length,0);const live=harness(),next=live.mount();await next.ready;assert.equal(live.images.length,1);live.allowed=false;next.refresh();assert.equal(live.container.children.length,0);assert.equal(live.toolbars[0].unmounted,true);assert.equal(live.observers[0].disconnected,true);assert.equal(live.listeners.size,0);});
test('legacy original restoration is bounded to the opened file and blocked after revocation',async()=>{let step=0;const h=harness(async()=>++step===1?{status:404,ok:false,json:async()=>({error:'missing'})}:{status:200,ok:true,json:async()=>({pageCount:1,width:612,height:792})});const blob={fixture:true},reader=h.mount({originalBlob:blob,requestedPage:1});await reader.ready;assert.equal(h.requests.length,3);assert.equal(h.requests[1][0],'/__files/fixture');assert.equal(h.requests[1][1].body,blob);assert.equal(h.requests[1][1].method,'POST');reader.destroy();const gate=deferred(),blocked=harness(()=>gate.promise),pending=blocked.mount({originalBlob:blob});blocked.allowed=false;gate.resolve({status:404,ok:false});await pending.ready;assert.equal(blocked.requests.length,1);});
test('metadata errors remain literal text and retry repeats metadata before page loading',async()=>{let attempt=0;const h=harness(async()=>++attempt===1?{ok:false,json:async()=>({error:'<img src=x onerror=secret()>原件错误'})}:{ok:true,json:async()=>({pageCount:1})}),reader=h.mount({requestedPage:1});await reader.ready;assert.equal(h.byClass('pdf-page-status').textContent.includes('<img'),true);assert.equal(h.images.length,0);await h.toolbar.onRetry();assert.equal(h.images.length,1);assert.equal(reader.getSnapshot().page,1);reader.destroy();});
test('destroy aborts pending metadata, removes owned roots and can be called twice safely',async()=>{const gate=deferred(),h=harness(()=>gate.promise),reader=h.mount();const signal=h.requests[0][1].signal;reader.destroy();reader.destroy();assert.equal(signal.aborted,true);gate.resolve({ok:true,json:async()=>({pageCount:3})});await reader.ready;assert.equal(h.images.length,0);assert.equal(h.container.children.length,0);assert.equal(h.toolbars[0].unmounted,true);});


test('PDF language changes translate status while original titles and literal server details stay intact',async()=>{
 const gate=deferred(),h=harness(()=>gate.promise,'en'),reader=h.mount({item:{id:'pdf',name:'资料库.pdf'},requestedPage:2});
 assert.equal(h.byClass('pdf-page-status').textContent,'Preparing PDF preview…');gate.resolve({ok:true,json:async()=>({pageCount:3})});await reader.ready;assert.equal(h.byClass('pdf-page-status').textContent,'Rendering page 2…');assert.equal(h.toolbar.title,'资料库.pdf');assert.match(h.image().alt,/资料库.pdf, page 2 of 3/);h.image().onerror();assert.match(h.byClass('pdf-page-status').textContent,/Retry, or download the original/);reader.destroy();
 const bad=harness(async()=>({ok:false,json:async()=>({error:'<img src=x>用户原文'})}),'en'),failure=bad.mount();await failure.ready;assert.equal(bad.byClass('pdf-page-status').textContent,'<img src=x>用户原文 · Read the saved text, or retry the preview.');assert.equal(bad.images.length,0);failure.destroy();
});

test('raster quality follows CSS size and DPR in bounded quarter-step buckets',()=>{
 const choose=(width,dpr=1)=>Core.rasterScale({width,height:width*792/612,pageWidth:612,pageHeight:792,dpr});
 assert.equal(choose(306),.5);assert.equal(choose(307),.75);assert.equal(choose(612),1);assert.equal(choose(612,2),2);assert.equal(choose(2000,4),2);assert.equal(choose(200),.5);assert.equal(choose(613),1.25);
});
test('first Retina render requests the capped sharper raster without loading other pages',async()=>{
 const h=harness(undefined,'zh',{dpr:2}),reader=h.mount();await reader.ready;assert.deepEqual(h.images,['/__files/fixture/preview?page=2&scale=2&fit=1']);h.complete();assert.equal(reader.getSnapshot().rasterScale,2);h.advance(1000);assert.equal(h.images.length,1);reader.destroy();
});
test('a resize storm gets one settled sharper replacement and keeps the good image and scroll',async()=>{
 const h=harness(undefined,'zh',{width:400}),reader=h.mount();await reader.ready;h.complete();const original=h.image(),viewport=h.byClass('pdf-viewport');assert.equal(reader.getSnapshot().rasterScale,.75);viewport.scrollTop=143;viewport.scrollLeft=24;
 for(const width of[500,620,740,810,920]){viewport.clientWidth=width;h.observers[0].fn();h.flush();h.advance(100);assert.equal(h.image(),original);assert.equal(h.images.length,1);}
 h.advance(79);assert.equal(h.images.length,1);h.advance(1);assert.equal(h.images.length,2);const next=h.imageNodes.at(-1);assert.match(next.src,/scale=1.5&fit=1$/);assert.equal(h.image(),original);assert.equal(reader.getSnapshot().phase,'ready');assert.equal(reader.getSnapshot().pendingScale,1.5);const size={...original.style};h.complete(next);assert.equal(h.image(),next);assert.equal(next.style.width,size.width);assert.equal(next.style.height,size.height);assert.ok(Math.abs(viewport.scrollTop-143*896/376)<1e-6);assert.ok(Math.abs(viewport.scrollLeft-24*896/376)<1e-6);assert.equal(original.src,'');assert.equal(reader.getSnapshot().rasterScale,1.5);reader.destroy();
});
test('repeated refreshes at unchanged size do not defer refinement or request the same bucket twice',async()=>{
 const h=harness(undefined,'zh',{width:400}),reader=h.mount();await reader.ready;h.complete();h.byClass('pdf-viewport').clientWidth=700;reader.refresh();h.advance(100);for(let index=0;index<20;index++)reader.refresh();h.advance(80);assert.equal(h.images.length,2);h.complete();const count=h.images.length;for(let index=0;index<20;index++){reader.refresh();h.advance(250);}assert.equal(h.images.length,count);reader.destroy();
});
test('a retained higher quality image serves shrink and expand without downscale loops',async()=>{
 const h=harness(undefined,'zh',{width:400}),reader=h.mount();await reader.ready;h.complete();const viewport=h.byClass('pdf-viewport');viewport.clientWidth=1400;reader.refresh();h.advance(180);h.complete();assert.equal(reader.getSnapshot().rasterScale,2);const best=h.image(),count=h.images.length;
 for(const width of[300,480,1200,500,1400]){viewport.clientWidth=width;reader.refresh();h.advance(500);assert.equal(h.image(),best);assert.equal(h.images.length,count);}reader.destroy();
});
test('failed refinement preserves the readable page and scroll, avoids retry loops, and can retry explicitly',async()=>{
 const h=harness(undefined,'zh',{width:400}),reader=h.mount();await reader.ready;h.complete();const original=h.image(),viewport=h.byClass('pdf-viewport');viewport.scrollTop=90;viewport.clientWidth=1100;reader.refresh();h.advance(180);h.imageNodes.at(-1).onerror();
 assert.equal(h.image(),original);assert.ok(original.src);assert.ok(Math.abs(viewport.scrollTop-90*1076/376)<1e-6);assert.equal(reader.getSnapshot().phase,'ready');assert.equal(h.byClass('pdf-page-status').hidden,true);assert.match(h.toolbar.error,/已保留/);assert.equal(h.toasts.length,1);
 for(let index=0;index<10;index++){reader.refresh();h.advance(1000);}assert.equal(h.images.length,2);h.toolbar.onRetry();assert.equal(h.images.length,3);assert.equal(h.image(),original);h.complete();assert.equal(h.toolbar.error,'');assert.equal(reader.getSnapshot().rasterScale,2);reader.destroy();
});
test('page changes cancel delayed and pending refinements; stale callbacks cannot replace the next page',async()=>{
 const h=harness(undefined,'zh',{width:400}),reader=h.mount();await reader.ready;h.complete();h.byClass('pdf-viewport').clientWidth=1100;reader.refresh();h.advance(180);const obsolete=h.imageNodes.at(-1),late=obsolete.onload;assert.ok(obsolete.src);reader.setPage(3);assert.equal(obsolete.src,'');assert.equal(obsolete.onload,null);assert.equal(obsolete.onerror,null);const page3=h.image();obsolete.naturalWidth=1224;obsolete.naturalHeight=1584;late();assert.equal(h.image(),page3);assert.equal(reader.getSnapshot().page,3);h.complete(page3);assert.equal(reader.getSnapshot().phase,'ready');h.advance(1000);assert.equal(h.images.length,3);assert.equal(h.images.every(url=>/page=(2|3)&/.test(url)),true);reader.destroy();
 const pending=harness(undefined,'zh',{width:400}),view=pending.mount();await view.ready;pending.complete();pending.byClass('pdf-viewport').clientWidth=1100;view.refresh();view.setPage(1);pending.advance(1000);assert.equal(pending.images.length,2);view.destroy();
});
test('destroy and privacy revocation cancel sharp replacement and release its listeners and timers',async()=>{
 for(const privateChange of[false,true]){const h=harness(undefined,'zh',{width:400}),reader=h.mount();await reader.ready;h.complete();h.dpr=2;h.windowListeners.get('resize')();h.flush();h.advance(180);const pending=h.imageNodes.at(-1),late=pending.onload;if(privateChange){h.allowed=false;reader.refresh();}else reader.destroy();assert.equal(pending.src,'');assert.equal(h.timers.size,0);assert.equal(h.windowListeners.size,0);pending.naturalWidth=1000;pending.naturalHeight=1200;late();assert.equal(h.container.children.length,0);h.advance(1000);assert.equal(h.images.length,2);}
});
test('DPR changes at unchanged canvas dimensions trigger only the needed sharper current page',async()=>{
 const h=harness(undefined,'zh',{width:500}),reader=h.mount();await reader.ready;h.complete();assert.equal(reader.getSnapshot().rasterScale,1);h.dpr=2;h.windowListeners.get('resize')();h.flush();h.advance(180);assert.match(h.images.at(-1),/scale=1.75&fit=1/);h.complete();h.dpr=1;h.windowListeners.get('resize')();h.flush();h.advance(500);assert.equal(h.images.length,2);reader.destroy();
});
test('hidden retained PDF keeps its geometry and reading position without refinement requests',async()=>{
 const h=harness(),reader=h.mount();await reader.ready;h.complete();const viewport=h.byClass('pdf-viewport'),image=h.image(),size={...image.style},requests=h.images.length;
 viewport.scrollTop=460;viewport.scrollLeft=16;viewport.onscroll();
 viewport.clientWidth=0;viewport.clientHeight=0;viewport.scrollTop=0;viewport.scrollLeft=0;viewport.onscroll();h.observers[0].fn();h.flush();reader.refresh();h.advance(1000);
 assert.equal(image.style.width,size.width);assert.equal(image.style.height,size.height);assert.equal(h.images.length,requests);
 viewport.clientWidth=1000;viewport.clientHeight=700;h.observers[0].fn();h.flush();assert.equal(h.image(),image);assert.equal(viewport.scrollTop,460);assert.equal(viewport.scrollLeft,16);assert.equal(reader.getSnapshot().page,2);reader.destroy();
});
test('a sharper image arriving while parked preserves the last visible position until resume',async()=>{
 const h=harness(undefined,'zh',{width:400}),reader=h.mount();await reader.ready;h.complete();const viewport=h.byClass('pdf-viewport');viewport.scrollTop=143;viewport.onscroll();
 viewport.clientWidth=1000;reader.refresh();const position=viewport.scrollTop;h.advance(180);const sharper=h.imageNodes.at(-1),size={...h.image().style};
 viewport.clientWidth=0;viewport.clientHeight=0;viewport.scrollTop=0;h.observers[0].fn();h.flush();h.complete(sharper);h.advance(1000);
 assert.equal(h.image(),sharper);assert.equal(sharper.style.width,size.width);assert.equal(sharper.style.height,size.height);assert.equal(h.images.length,2);
 viewport.clientWidth=1000;viewport.clientHeight=700;h.observers[0].fn();h.flush();assert.ok(Math.abs(viewport.scrollTop-position)<1e-6);assert.equal(h.images.length,2);reader.destroy();
});
test('a requested page finishing while parked sizes and restores its saved position on resume',async()=>{
 const h=harness(),reader=h.mount();await reader.ready;h.complete();const viewport=h.byClass('pdf-viewport');viewport.scrollTop=240;viewport.onscroll();reader.setPage(3);h.complete();reader.setPage(2);
 viewport.clientWidth=0;viewport.clientHeight=0;viewport.scrollTop=0;h.observers[0].fn();h.flush();h.complete();assert.equal(reader.getSnapshot().page,2);
 viewport.clientWidth=1000;viewport.clientHeight=700;h.observers[0].fn();h.flush();assert.equal(viewport.scrollTop,240);reader.destroy();
});
test('backend pixel caps cannot create repeated upgrade attempts or alter known first-page physical geometry',async()=>{
 const h=harness(undefined,'zh',{width:600,dpr:2}),reader=h.mount({requestedPage:1});await reader.ready;const image=h.image();image.naturalWidth=300;image.naturalHeight=388;image.onload();const originalSize={...image.style};assert.equal(reader.getSnapshot().rasterScale,2);reader.refresh();h.advance(1000);assert.equal(h.images.length,1);assert.equal(image.style.width,originalSize.width);assert.equal(image.style.height,originalSize.height);reader.destroy();
});

const textResponse=(page=2,extra={})=>({ok:true,json:async()=>({page,pageCount:3,width:612,height:792,words:[{text:'Alpha',x:30,y:40,width:36,height:15,angle:0,line:'0:0'},{text:'Beta',x:70,y:40,width:30,height:15,angle:0,line:'0:0'},{text:'Gamma',x:30,y:60,width:40,height:15,angle:0,line:'0:1'}],...extra})});
const settleText=async()=>{for(let n=0;n<8;n++)await Promise.resolve();};
test('current-page text is selectable literal content and copy preserves line breaks',async()=>{
 const copied=[],h=harness(undefined,'zh',{textFetcher:async()=>textResponse()}),reader=h.mount();h.context.navigator={clipboard:{writeText:async value=>copied.push(value)}};await reader.ready;await settleText();h.complete();const layer=h.byClass('pdf-text-layer');assert.equal(h.textRequests.length,1);assert.match(h.textRequests[0][0],/page=2$/);assert.equal(layer.children.length,3);assert.equal(layer.children[0].textContent,'Alpha ');assert.equal(layer.children[1].textContent,'Beta\n');assert.equal(layer.hidden,false);assert.equal(h.toolbar.canCopy,true);await h.toolbar.onCopy();assert.deepEqual(copied,['Alpha Beta\nGamma']);assert.match(h.toasts.at(-1),/已复制/);reader.destroy();
});
test('zoom and raster refinement retain existing word nodes and text requests',async()=>{
 const h=harness(undefined,'zh',{width:400,textFetcher:async()=>textResponse()}),reader=h.mount();await reader.ready;await settleText();h.complete();const layer=h.byClass('pdf-text-layer'),word=layer.children[0],oldTransform=layer.style.transform;h.toolbar.onZoom(.5);assert.equal(h.byClass('pdf-text-layer'),layer);assert.notEqual(layer.style.transform,oldTransform);h.advance(180);h.complete();assert.equal(h.byClass('pdf-text-layer'),layer);assert.equal(layer.children[0],word);assert.equal(h.textRequests.length,1);reader.destroy();
});
test('zoom anchors the reading location and returning to a page restores its position',async()=>{
 const h=harness(),reader=h.mount();await reader.ready;h.complete();const viewport=h.byClass('pdf-viewport');viewport.scrollTop=312;viewport.scrollLeft=70;const top=312/parseFloat(h.image().style.height),left=70/parseFloat(h.image().style.width);h.toolbar.onZoom(.25);assert.ok(Math.abs(viewport.scrollTop/parseFloat(h.image().style.height)-top)<1e-9);assert.ok(Math.abs(viewport.scrollLeft/parseFloat(h.image().style.width)-left)<1e-9);reader.setPage(3);h.complete();assert.equal(viewport.scrollTop,0);viewport.scrollTop=101;reader.setPage(2);h.complete();assert.ok(Math.abs(viewport.scrollTop/parseFloat(h.image().style.height)-top)<1e-9);h.toolbar.onFit('page');assert.equal(viewport.scrollTop,0);reader.destroy();
});
test('stale text is aborted on page change and cannot populate a different page',async()=>{
 const gate=deferred(),h=harness(undefined,'zh',{textFetcher:async url=>url.endsWith('page=2')?gate.promise:textResponse(3)}),reader=h.mount();await reader.ready;const signal=h.textRequests[0][1].signal;reader.setPage(3);assert.equal(signal.aborted,true);await settleText();gate.resolve(textResponse(2,{words:[{text:'obsolete',x:1,y:1,width:1,height:1,angle:0,line:'0'}]}));await settleText();h.complete();assert.equal(h.toolbar.page,3);assert.equal(h.byClass('pdf-text-layer').children[0].textContent,'Alpha ');reader.destroy();assert.equal(h.textRequests[1][1].signal.aborted,true);
});
test('scanned, restricted and failed text preserve raster and do not enable copy',async()=>{
 for(const [response,phase]of[[textResponse(2,{words:[]}), 'empty'],[{ok:false,json:async()=>({code:'PDF_COPY_RESTRICTED'})},'restricted'],[{ok:false,json:async()=>({error:'failure'})},'error']]){const h=harness(undefined,'zh',{textFetcher:async()=>response}),reader=h.mount();await reader.ready;await settleText();h.complete();assert.equal(h.toolbar.textPhase,phase);assert.equal(h.toolbar.canCopy,false);assert.equal(reader.getSnapshot().phase,'ready');assert.ok(h.image().src);reader.destroy();}
});
test('failed text has an explicit retry without reloading the good raster',async()=>{
 let count=0;const h=harness(undefined,'zh',{textFetcher:async()=>++count===1?{ok:false,json:async()=>({error:'offline'})}:textResponse()}),reader=h.mount();await reader.ready;await settleText();h.complete();const original=h.image();assert.equal(h.toolbar.textPhase,'error');await h.toolbar.onTextRetry();assert.equal(h.toolbar.textPhase,'ready');assert.equal(h.image(),original);assert.equal(h.images.length,1);assert.equal(h.toolbar.canCopy,true);reader.destroy();
});
test('partial and rotated words expose bounded literal geometry with honest copy failure',async()=>{
 const h=harness(undefined,'zh',{textFetcher:async()=>textResponse(2,{partial:true,words:[{text:'<script>literal</script>',x:500,y:30,width:80,height:20,angle:90,line:'0:0'}]})}),reader=h.mount();await reader.ready;await settleText();h.complete();const span=h.byClass('pdf-text-layer').children[0];assert.equal(span.textContent,'<script>literal</script>');assert.match(span.style.transform,/rotate\(90deg\)/);assert.equal(h.toolbar.textPhase,'partial');await h.toolbar.onCopy();assert.match(h.toasts.at(-1),/复制失败/);assert.equal(h.toolbar.copying,false);reader.destroy();
});
test('privacy revocation discards a pending text response and its content',async()=>{
 const gate=deferred(),h=harness(undefined,'zh',{textFetcher:async()=>gate.promise}),reader=h.mount();await reader.ready;h.complete();h.allowed=false;gate.resolve(textResponse());await settleText();assert.equal(h.container.children.length,0);assert.equal(h.textRequests[0][1].signal.aborted,true);assert.equal(h.byClass('pdf-text-layer'),undefined);reader.destroy();
});
test('late text after raster failure stays hidden until a real page renders',async()=>{
 const gate=deferred(),h=harness(undefined,'zh',{textFetcher:async()=>gate.promise}),reader=h.mount();await reader.ready;h.image().onerror();gate.resolve(textResponse());await settleText();assert.equal(reader.getSnapshot().phase,'error');assert.equal(h.byClass('pdf-text-layer').hidden,true);assert.equal(h.toolbar.textPhase,'page-error');assert.equal(h.toolbar.canCopy,false);reader.destroy();
});

test('resizing or expanding fit-width keeps the same document location',async()=>{
 const h=harness(),reader=h.mount();await reader.ready;h.complete();const viewport=h.byClass('pdf-viewport');viewport.scrollTop=400;const fraction=400/parseFloat(h.image().style.height);viewport.clientWidth=1400;h.observers[0].fn();h.flush();assert.ok(Math.abs(viewport.scrollTop/parseFloat(h.image().style.height)-fraction)<1e-9);viewport.clientWidth=1700;h.toolbar.onExpand();h.flush();assert.ok(Math.abs(viewport.scrollTop/parseFloat(h.image().style.height)-fraction)<1e-9);reader.destroy();
});
test('fully unsupported text never promises a selectable partial layer',async()=>{
 const h=harness(undefined,'zh',{textFetcher:async()=>textResponse(2,{partial:true,words:[]})}),reader=h.mount();await reader.ready;await settleText();h.complete();assert.equal(h.toolbar.textPhase,'unsupported');assert.equal(h.toolbar.canCopy,false);assert.equal(h.byClass('pdf-text-layer'),undefined);reader.destroy();
});


test('find is demand-driven, routes matches to original pages and highlights separately from selectable text',async()=>{
 const h=harness(async url=>url.includes('preview-search')?{ok:true,json:async()=>({page:Number(new URL(url,'http://fixture').searchParams.get('page')),pageCount:3,width:612,height:792,matches:[{rects:[{x:20,y:700,width:100,height:18,angle:0}]}]})}:{ok:true,json:async()=>({pageCount:3,width:612,height:792})},'zh',{search:true,textFetcher:async url=>textResponse(Number(new URL(url,'http://fixture').searchParams.get('page')))}),reader=h.mount();await reader.ready;await settleText();h.complete();
 const text=h.byClass('pdf-text-layer');assert.equal(reader.openFind(),true);assert.equal(h.requests.length,1);h.toolbar.onFindQuery('word');await h.toolbar.onFindRun();assert.equal(h.toolbar.find.matches.length,3);assert.equal(h.byClass('pdf-text-layer'),text);assert.ok(h.byClass('pdf-search-layer'));assert.ok(h.byClass('pdf-viewport').scrollTop>0);h.toolbar.onFindNext(1);assert.equal(reader.getSnapshot().page,3);h.complete();assert.ok(h.byClass('pdf-search-layer'));assert.ok(h.byClass('pdf-viewport').scrollTop>0);h.toolbar.onFindClose();assert.equal(h.byClass('pdf-search-layer'),undefined);assert.equal(reader.getSnapshot().phase,'ready');reader.destroy();
});
test('pending PDF find is cancelled when its reader is replaced or destroyed',async()=>{
 const gate=deferred();let signal;const h=harness(async(url,init)=>{if(url.includes('preview-search')){signal=init.signal;return gate.promise;}return{ok:true,json:async()=>({pageCount:3})};},'zh',{search:true}),reader=h.mount();await reader.ready;reader.openFind();h.toolbar.onFindQuery('word');const done=h.toolbar.onFindRun();reader.destroy();assert.equal(signal.aborted,true);gate.resolve({ok:true,json:async()=>({page:2,pageCount:3,width:612,height:792,matches:[]})});await done;assert.equal(h.container.children.length,0);
});

test('a changed query clears the old pending scroll target before a late page image loads',async()=>{
 const h=harness(async url=>{if(!url.includes('preview-search'))return{ok:true,json:async()=>({pageCount:3,width:612,height:792})};const page=Number(new URL(url,'http://fixture').searchParams.get('page'));return{ok:true,json:async()=>({page,pageCount:3,width:612,height:792,matches:page===3?[{rects:[{x:20,y:700,width:100,height:18,angle:0}]}]:[]})};},'zh',{search:true}),reader=h.mount();await reader.ready;h.complete();reader.openFind();h.toolbar.onFindQuery('old');await h.toolbar.onFindRun();assert.equal(reader.getSnapshot().page,3);assert.equal(reader.getSnapshot().phase,'page');h.toolbar.onFindQuery('new');h.complete();assert.equal(h.byClass('pdf-viewport').scrollTop,0);reader.destroy();
});

test('normal PDF metadata never loads the complete original and reports download availability',async()=>{
 const availability=[];let loads=0;const h=harness(),reader=h.mount({getOriginalBlob:()=>{loads++;throw Error('eager original');},onOriginalAvailability:value=>availability.push(value)});
 await reader.ready;assert.equal(loads,0);assert.deepEqual(h.requests.map(([url])=>url),['/__files/fixture/preview-info']);assert.equal(availability.at(-1),true);reader.destroy();
});
test('missing original loads legacy bytes only once, restores, then rereads metadata',async()=>{
 const original={legacy:true},availability=[];let loads=0,step=0;const h=harness(async()=>++step===1?{status:404,ok:false,json:async()=>({error:'missing original'})}:{status:200,ok:true,json:async()=>({pageCount:2})});
 const reader=h.mount({getOriginalBlob:async({signal})=>{assert.equal(signal.aborted,false);loads++;return original;},onOriginalAvailability:value=>availability.push(value)});await reader.ready;
 assert.equal(loads,1);assert.equal(h.requests.length,3);assert.equal(h.requests[1][1].method,'POST');assert.equal(h.requests[1][1].body,original);assert.equal(availability.at(-1),true);reader.destroy();
});
test('switching or revoking while legacy IDB is pending cannot upload or update the next reader',async()=>{
 for(const action of ['destroy','revoke']){const gate=deferred(),availability=[];let signal;const h=harness(async()=>({status:404,ok:false,json:async()=>({error:'missing'})}));const reader=h.mount({getOriginalBlob:options=>{signal=options.signal;return gate.promise;},onOriginalAvailability:value=>availability.push(value)});await settleText();assert.ok(signal);if(action==='destroy')reader.destroy();else h.allowed=false;const prior=availability.length;gate.resolve({legacy:true});await reader.ready;assert.equal(h.requests.length,1);assert.equal(availability.length,prior);assert.equal(signal.aborted,true);}
});
test('missing original has truthful fallback and an explicit retry can recover it',async()=>{
 let missing=true,loads=0;const availability=[],h=harness(async()=>missing?{status:404,ok:false,json:async()=>({error:'找不到附件原件'})}:{status:200,ok:true,json:async()=>({pageCount:2})});const reader=h.mount({getOriginalBlob:async()=>{loads++;return null;},onOriginalAvailability:value=>availability.push(value)});await reader.ready;
 assert.equal(loads,1);assert.equal(availability.at(-1),false);assert.doesNotMatch(h.byClass('pdf-page-status').textContent,/原文件仍可下载/);assert.match(h.byClass('pdf-page-status').textContent,/文字/);missing=false;await h.toolbar.onRetry();assert.equal(availability.at(-1),true);assert.equal(loads,1);reader.destroy();
});
test('failed legacy upload exposes the restore error and preserves the remaining local original download',async()=>{
 let step=0;const original={legacy:true},availability=[],h=harness(async()=>++step===1?{status:404,ok:false,json:async()=>({error:'missing'})}:{status:507,ok:false,json:async()=>({error:'原件恢复空间不足'})});const reader=h.mount({getOriginalBlob:async()=>original,onOriginalAvailability:(value,blob)=>availability.push({value,blob})});await reader.ready;
 assert.equal(h.requests.length,2);assert.match(h.byClass('pdf-page-status').textContent,/空间不足/);assert.equal(availability.at(-1).value,true);assert.equal(availability.at(-1).blob,original);reader.destroy();
});

test('cited excerpts map onto the page words despite spacing, line breaks and width variants', () => {
  const { locateExcerpt } = require('../app/pdf-reader.js');
  const words = ['Attention', 'is', 'all', 'you', 'need.', 'We', 'propose', 'the', 'Transformer,', 'a', 'new', 'network', '注意力机制', '是', '核心。'].map(text => ({ text }));
  assert.deepEqual(locateExcerpt(words, '[第 3 页]\nWe propose the\nTransformer, a new network'), { start: 5, end: 11 });
  assert.deepEqual(locateExcerpt(words, 'ＷＥ   PROPOSE the transformer'), { start: 5, end: 8 });
  assert.deepEqual(locateExcerpt(words, '注意力机制是核心。'), { start: 12, end: 14 });
  // Falls back to the longest unique line when the whole excerpt is not on the page.
  assert.deepEqual(locateExcerpt(words, 'Text from the previous page only\nWe propose the Transformer'), { start: 5, end: 8 });
  assert.equal(locateExcerpt(words, 'Nothing like this is on the page'), null);
  assert.equal(locateExcerpt([{ text: 'repeat words' }, { text: 'repeat words' }], 'repeat words'), null);
  assert.equal(locateExcerpt(words, ''), null);
});
