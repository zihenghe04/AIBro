// Only loaded by AIBRO_NATIVE_QA_OVERVIEW in the isolated native QA workspace.
(()=>{
 const today=new Date(),day=n=>{const d=new Date(today);d.setDate(d.getDate()+n);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
 const specs=[
 ['日常','续借本周到期的图书',-1,'high'],['日常','寄出借阅资料',0,'medium'],['日常','整理周末出行清单',2,'medium'],['日常','预约年度体检',6,'low'],['日常','整理桌面与下载文件夹',null,'low'],
 ['课程','提交机器学习课程作业',0,'high'],['课程','复习线性代数第二章',2,'medium'],['课程','整理第一讲课堂笔记',null,'medium'],['课程','补充课程参考资料',null,'medium'],['科研','整理论文修订清单',5,'high']];
 state.tasks=specs.map(([workspace,title,due,priority],i)=>({id:'overview-'+i,title,workspace,projectId:workspace==='科研'?'native-qa':workspace==='课程'?'qa-course':'qa-trip',status:i===8?'blocked':i===9?'in_progress':'todo',dueAt:due===null?null:day(due),priority,createdAt:Date.now(),updatedAt:Date.now(),description:'隔离测试中的虚构任务',checklist:[],sourceAttachmentIds:[]}));
 save();renderAll();return true;
})();
