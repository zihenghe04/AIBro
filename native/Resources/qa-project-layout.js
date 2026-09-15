// Runs only with the native self-test's isolated, synthetic workspace.
const check=(value,message)=>{if(!value)throw Error(message);};
const settle=()=>new Promise(r=>setTimeout(r,400));
if(!state.notes.some(n=>n.id==='qa-layout-0')){
 for(let i=0;i<45;i++)state.notes.push({id:'qa-layout-'+i,projectId:'qa-trip',workspace:'日常',title:'路线资料 '+String(i+1).padStart(2,'0'),kind:'note',folderPath:'路线与装备',content:'# 路线资料\n\n供布局验证使用的虚构内容。',createdAt:Date.now(),sourceAttachmentIds:[]});
}
state.currentProjectId='qa-trip';showView('project','秋日山野计划');renderProject('qa-trip');
await openPreview('note','qa-note-trip');WorkspaceLayout.refresh();await settle();
const tree=document.querySelector('#projectTreePanel'),content=document.querySelector('.project-content'),reader=document.querySelector('#readingPane'),view=document.querySelector('#project');
const inspect=()=>{
 const t=tree.getBoundingClientRect(),c=content.getBoundingClientRect(),r=reader.getBoundingClientRect();
 check(tree.open,'tree remains expanded');
 check(document.querySelector('#projectTitle').getBoundingClientRect().width>=260,'heading retains readable width');
 check(t.height>=300,'heading leaves room for navigator');
 check(document.querySelector('#project>.page-heading').getBoundingClientRect().height<230,'heading stays compact at split-view breakpoints');
 check(content.scrollWidth<=content.clientWidth+1,'content fits its column without horizontal overflow: '+content.scrollWidth+'/'+content.clientWidth);
 check(Math.abs(t.top-c.top)<2,'tree and content start on the same row');
 check(t.right<=c.left&&c.right<=r.left,'tree, content, reader ordered left to right');
 check(t.width>=145&&c.width>=180&&r.width>=320,'all three columns usable');
 check(c.bottom<=innerHeight+1&&t.bottom<=innerHeight+1,'column scrollports fit viewport');
 check(getComputedStyle(tree).overflowY==='auto'&&getComputedStyle(content).overflowY==='auto','independent scrollports');
 check(view.scrollHeight<=view.clientHeight+1,'outer project does not scroll away the tree');
 return {width:innerWidth,tree:Math.round(t.width),content:Math.round(c.width),reader:Math.round(r.width)};
};
const geometry=inspect();
tree.scrollTop=160;content.scrollTop=120;await settle();
const scroll=tree.scrollTop;check(scroll>0,'tree scrolls with many files');
content.scrollTop=240;await settle();check(tree.scrollTop===scroll,'content scrolling does not move tree');
document.querySelector('#readingCollapse').click();WorkspaceLayout.refresh();await settle();
check(tree.scrollTop===scroll,'hiding reader preserves tree scroll');
await openPreview('note','qa-note-trip');WorkspaceLayout.refresh();await settle();inspect();
check(tree.scrollTop===scroll,'opening reader preserves tree scroll');
const firstFolder=tree.querySelector('.tree-folder');if(firstFolder){firstFolder.open=false;await openPreview('note','qa-layout-1');await settle();check(!firstFolder.open,'opening another document preserves collapsed folders');firstFolder.open=true;}
const handle=document.querySelector('#resize-reader');handle.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));await settle();inspect();
tree.scrollTop=0;content.scrollTop=0;
return JSON.stringify({status:'PASS',...geometry,checks:'left navigator; split resize; separate scrolling; folder and scroll preservation; real note preview'});
