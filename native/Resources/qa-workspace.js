// Synthetic fixture. Loaded only by AIBRO_NATIVE_QA into a unique isolated directory.
(()=>{
 const now=Date.now(), day=n=>{const d=new Date();d.setDate(d.getDate()+n);d.setHours(12,0,0,0);return d.toISOString();};
 state.projects=[{id:'native-qa',name:'多模态推理 · 文献研究',workspace:'科研'},{id:'qa-course',name:'线性代数 · 学习笔记',workspace:'课程'},
 {id:'qa-trip',name:'秋日山野计划',workspace:'日常'},{id:'qa-wellness',name:'恢复运动节奏',workspace:'日常'},{id:'qa-home',name:'整理我的生活空间',workspace:'日常'}].map(p=>({...p,status:'active',createdAt:now,updatedAt:now}));
 const specs=[
 ['qa-trip','确定旅行路线','done',-6,-4],['qa-trip','整理交通方案','done',-4,-2],['qa-trip','预订周末住宿','in_progress',0,2],['qa-trip','准备轻量行李','todo',2,4],['qa-trip','确认天气和备用路线','todo',null,4],
 ['qa-wellness','制定每周运动计划','done',-8,-7],['qa-wellness','完成第一次轻松跑','done',-5,-4],['qa-wellness','完成拉伸训练','done',-3,-2],['qa-wellness','保持规律作息','in_progress',-1,5],['qa-wellness','准备周末骑行','todo',3,6],['qa-wellness','预约体能评估','blocked',null,7],
 ['qa-home','整理书桌与线缆','done',-4,-3],['qa-home','筛选闲置物品','in_progress',0,3],['qa-home','捐赠可用书籍','todo',3,5],['qa-home','完成资料数字归档','todo',4,8],['qa-home','更新家庭物品清单','todo',null,null]];
 state.tasks=specs.map(([projectId,title,status,start,due],i)=>({id:'qa-task-'+i,title,projectId,workspace:'日常',description:'这是独立预览中的虚构任务，用于检查交互与可视化。',status,priority:i%4===0?'high':'medium',startAt:start===null?null:day(start),dueAt:due===null?null:day(due),completedAt:status==='done'?Date.parse(day(due)):null,createdAt:now,updatedAt:now,checklist:[],sourceAttachmentIds:[]}));
 state.notes=[{id:'qa-note-trip',projectId:'qa-trip',workspace:'日常',title:'山野周末 · 出行笔记',kind:'note',content:'# 山野周末 · 出行笔记\n\n> 让计划留有余地，让出发更轻松。\n\n## 行程安排\n\n| 时间 | 安排 | 备注 |\n| --- | --- | --- |\n| 周六上午 | 出发与短途徒步 | 按天气调整 |\n| 周六下午 | 山间步道 | 留足休息时间 |\n| 周日 | 返程 | 保留弹性 |\n\n## 装备清单\n\n- [x] 轻便背包\n- [ ] 雨具和备用衣物\n- [ ] 饮水与补给\n\n## 准备原则\n\n不为了完成行程而赶路。计划可以调整，安全和体验更重要。\n\n## 待确认事项\n\n住宿退订规则、交通班次、当地天气。\n',createdAt:now,updatedAt:now,sourceAttachmentIds:[]},
 {id:'qa-note-wellness',projectId:'qa-wellness',workspace:'日常',title:'运动节奏 · 每周回顾',kind:'note',content:'# 运动节奏\n\n逐渐恢复，不追求一次完成所有目标。\n\n## 本周记录\n\n已完成轻松跑和拉伸训练。\n',createdAt:now,updatedAt:now,sourceAttachmentIds:[]}];
 state.papers=[];state.imports=[];state.agentRuns=[];
 normalizeStateShape(state);save();renderAll();return true;
})();
