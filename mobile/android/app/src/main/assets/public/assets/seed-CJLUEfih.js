async function d(e){const t=Date.now(),a={id:"demo_research",name:"视频理解 · 研究计划",workspace:"科研",description:"把文献、实验和新问题，放在一起继续推进。",createdAt:t,updatedAt:t};await e.put("projects",a),await e.put("projects",{id:"demo_course",name:"机器学习 · 课程笔记",workspace:"课程",createdAt:t,updatedAt:t}),await e.put("notes",{id:"demo_capture",title:"短事件可能被平均准确率掩盖",content:`今天读文献时想到：如果把长视频按固定间隔采样，很短的动作会不会刚好被跳过？

下次实验可以单独统计短事件的覆盖率。`,kind:"随记",tags:["实验想法"],projectId:a.id,workspace:"科研",createdAt:t,updatedAt:t}),await e.put("notes",{id:"demo_wiki",title:"时间采样与事件覆盖",content:`# 时间采样与事件覆盖

## 核心问题
如何在固定帧预算下覆盖更多短事件？

## 待验证的想法
比较均匀采样与自适应关键帧采样，保持其他变量一致。

> 这是演示资料，不代表已完成的实验结论。`,kind:"科研 Wiki",wikiCategory:"concepts",workspace:"科研",projectId:a.id,createdAt:t,updatedAt:t}),await e.put("tasks",{id:"demo_task",title:"整理本周文献与开放问题",status:"todo",workspace:"科研",projectId:a.id,dueAt:new Date(t+36e5).toISOString(),createdAt:t,updatedAt:t})}export{d as seed};
