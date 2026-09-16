export async function seed(store) {
  const now = Date.now(),
    p = {
      id: "demo_research",
      name: "视频理解 · 研究计划",
      workspace: "科研",
      description: "把文献、实验和新问题，放在一起继续推进。",
      createdAt: now,
      updatedAt: now,
    };
  await store.put("projects", p);
  await store.put("projects", {
    id: "demo_course",
    name: "机器学习 · 课程笔记",
    workspace: "课程",
    createdAt: now,
    updatedAt: now,
  });
  await store.put("notes", {
    id: "demo_capture",
    title: "短事件可能被平均准确率掩盖",
    content:
      "今天读文献时想到：如果把长视频按固定间隔采样，很短的动作会不会刚好被跳过？\n\n下次实验可以单独统计短事件的覆盖率。",
    kind: "随记",
    tags: ["实验想法"],
    projectId: p.id,
    workspace: "科研",
    createdAt: now,
    updatedAt: now,
  });
  await store.put("notes", {
    id: "demo_wiki",
    title: "时间采样与事件覆盖",
    content:
      "# 时间采样与事件覆盖\n\n## 核心问题\n如何在固定帧预算下覆盖更多短事件？\n\n## 待验证的想法\n比较均匀采样与自适应关键帧采样，保持其他变量一致。\n\n> 这是演示资料，不代表已完成的实验结论。",
    kind: "科研 Wiki",
    wikiCategory: "concepts",
    workspace: "科研",
    projectId: p.id,
    createdAt: now,
    updatedAt: now,
  });
  await store.put("tasks", {
    id: "demo_task",
    title: "整理本周文献与开放问题",
    status: "todo",
    workspace: "科研",
    projectId: p.id,
    dueAt: new Date(now + 3600000).toISOString(),
    createdAt: now,
    updatedAt: now,
  });
}
