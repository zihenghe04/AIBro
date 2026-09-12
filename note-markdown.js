/* Export current document identity without altering user-authored Markdown. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.NoteMarkdown=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const managed=new Set(['id','noteId','paperId','title','projectId','project_id','workspace','sources','sourceAttachmentIds','reviewed']);
  function serialize(note){
    const original=String(note.content||'');
    const match=/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(original);
    const preserved=[];let removing=false;
    if(match)for(const row of match[1].split(/\r?\n/)){
      const key=/^(?:"([\w-]+)"|'([\w-]+)'|([\w-]+))\s*:/.exec(row);
      if(key)removing=managed.has(key[1] || key[2] || key[3]);
      if(!removing)preserved.push(row);
    }
    const meta={id:note.id,noteId:note.id,paperId:note.paperId||null,title:note.title||'笔记',projectId:note.projectId||null,workspace:note.workspace||'',sourceAttachmentIds:note.sourceAttachmentIds||[],reviewed:!!note.reviewed};
    const yaml=[...Object.entries(meta).map(([key,value])=>`${key}: ${JSON.stringify(value)}`),...preserved].join('\n');
    const body=match?original.slice(match[0].length):`\n# ${note.title||'笔记'}\n\n${original}\n`;
    return `---\n${yaml}\n---\n${body}`;
  }
  return {serialize};
});
