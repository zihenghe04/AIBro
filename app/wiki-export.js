(function(root){'use strict';
 const el=(tag,text)=>{const e=document.createElement(tag);e.textContent=text;return e;};
 async function request(path,body){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw Error((await r.json()).error||'导出失败');return r;}
 async function open(ids){let busy=false;try{
  await saveDocumentDurably();const preview=await(await request('/__wiki/bundle-preview',{ids})).json(),dialog=el('dialog','');dialog.className='wiki-dialog';dialog.id='wikiExportDialog';
  dialog.append(el('h2','导出 Wiki 目录与原件'),el('p','只导出下方清单。批准正文与原件保持不变，ZIP 中附来源清单；缺失原件和未选中的链接目标会明确列出。'));
  const chosen=new Set(ids),list=el('div','');for(const row of preview.entries){const label=el('label',''),check=el('input','');check.type='checkbox';check.checked=true;check.onchange=()=>check.checked?chosen.add(row.id):chosen.delete(row.id);label.append(check,el('span',row.title+' · '+row.path));list.append(label,el('br',''));}dialog.append(list);
  const include=el('input','');include.type='checkbox';include.checked=true;const label=el('label','');label.append(include,document.createTextNode('包含所选条目的原始附件'));dialog.append(label);
  const sources=el('details','');sources.append(el('summary','来源清单 · '+preview.sources.length+' 份'));for(const source of preview.sources)sources.append(el('p',source.name||source.id));dialog.append(sources);
  const status=el('p',''),download=el('button','生成 ZIP'),close=el('button','关闭');download.className='primary';download.dataset.wikiExport='';download.onclick=async()=>{if(busy)return;busy=true;download.disabled=true;try{const entries=preview.entries.filter(e=>chosen.has(e.id));if(!entries.length)throw Error('请至少选择一篇 Wiki');const r=await request('/__wiki/bundle',{entries,includeSources:include.checked}),blob=await r.blob(),url=URL.createObjectURL(blob),a=el('a','下载 research-wiki.zip');a.href=url;a.download='research-wiki.zip';status.replaceChildren(a);a.click();dialog.addEventListener('close',()=>URL.revokeObjectURL(url),{once:true});}catch(e){status.textContent=e.message;}finally{busy=false;download.disabled=false;}};
  close.onclick=()=>{if(!busy){dialog.close();dialog.remove();}};dialog.addEventListener('cancel',e=>{if(busy)e.preventDefault();});dialog.append(status,download,close);document.body.append(dialog);dialog.showModal();
 }catch(e){toast(e.message);}}
 root.WikiExport={open};
})(globalThis);
