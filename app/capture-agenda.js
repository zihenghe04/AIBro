/* Calendar remains the native store; captures only keep links and open review UI. */
(function(root){const t=(zh,en)=>root.WorkstationI18n?.getLanguage?.()==='en'?en:zh;let entries=[],updated=0,loading=false;
 async function refresh(force=false){if(!root.workstationDesktop?.agendaRelated||loading||!force&&Date.now()-updated<5000)return;loading=true;try{const next=await root.workstationDesktop.agendaRelated();updated=Date.now();if(JSON.stringify(next)!==JSON.stringify(entries)){entries=next;root.CaptureNotes?.render();}}catch{}finally{loading=false;}}
 function append(footer,note){if(!root.workstationDesktop?.agendaDraft)return;const b=document.createElement('button');b.type='button';b.className='secondary';b.textContent=t('安排日程','Schedule');b.dataset.captureAgenda=note.id;b.onclick=async()=>{try{await saveDocumentDurably();await root.workstationDesktop.agendaDraft(note.id);}catch(e){toast(e.message);}};footer.append(b);
  for(const event of entries.filter(e=>e.documentID===note.id)){const link=document.createElement('button');link.type='button';link.className='capture-file';link.textContent=t('日程 · ','Event · ')+event.title;link.dataset.captureAgendaLink=event.id;link.onclick=async()=>{try{await root.workstationDesktop.agendaOpen(event.id);}catch(e){toast(e.message);refresh(true);}};footer.append(link);}refresh();
 }
 root.CaptureAgenda={append,refresh};document.addEventListener('aibro-agenda-changed',()=>refresh(true));
})(globalThis);
