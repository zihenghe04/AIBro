// This selects truthful output handling, not write permission or a target ID.
const kinds = /项目|任务|待办|笔记|随记|日程|日历事件|\bcalendar\s+events?\b|\bprojects?\b|\btasks?\b|\btodos?\b|\breminders?\b|\bnotes?\b|\bevents?\b|\bagenda\b/gi;
const kindOf = (value) => /项目|\bprojects?\b/i.test(value) ? "projects" : /任务|待办|\btasks?\b|\btodos?\b|\breminders?\b/i.test(value) ? "tasks" : /笔记|随记|\bnotes?\b/i.test(value) ? "notes" : "agenda";
const operations = [
  ["restore", /恢复|还原|撤销删除|\b(?:restore|undelete|unarchive)\b/i],
  ["create", /新建|创建|新增|添加|建立|保存为|存为|存成|记为|记下|(?:写入|保存到|记到)(?:一(?:条|篇|份))?新|安排|\b(?:create|add|schedule)\b|\bset\s+up\b|\bset\s+an?\s+(?:(?:calendar\s+)?event|reminder)\s+(?:for|on|at)\b|\bsave\b.{0,30}\bas\b/i],
  ["remove", /删除|删掉|删了|移除|归档|取消|移入回收站|\b(?:delete|remove|archive|cancel)\b/i],
  ["update", /修改|更改|更新|调整|改期|改名|重命名|改为|改成|改到|标记为|标为|设为|设成|推迟|提前|移到|移动到|追加|补充|\b(?:update|edit|modify|rename|reschedule|move|mark|set|complete|append)\b/i],
  // Saving wording can mean either create or update. Require a real plan,
  // while leaving that distinction to the model's read/propose loop.
  [null, /保存|记到|记录到|写入|\bsave\b/i],
];
const reference = /刚才那个|刚才那条|刚才那项|刚才的|这个|那个|这条|那条|这项|那项|它们|它|\b(?:it|that|those|these|previous|last)\b/i;
const noOperation = /不要|别(?:再)?|无需|不用|不需要|不想|不必|暂不|先不|请勿|\b(?:don['’]t|do not|never)\b/i;
const validID = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const allowedKinds = new Set(["projects", "tasks", "notes", "agenda", "imports", "trash"]);
const allowedOperations = new Set(["create", "update", "remove", "restore"]);

function unquoted(value) {
  return value.replace(/"[^"\n]*"|“[^”\n]*”|「[^」\n]*」|『[^』\n]*』|`[^`\n]*`/g, (part) => " ".repeat(part.length));
}
function informational(clause) {
  // Reading records whose history says "created/deleted" is not a new write.
  if (/^(?:请|帮我)?\s*(?:查询|查看|查找|搜索|检索|浏览|列出|读取)|^(?:please\s+)?(?:find|search|list|read|show|look\s+up)\b/i.test(clause)) return true;
  if (/^(?:请|帮我)?\s*(?:翻译|解释|介绍|总结|分析|告诉我|教我|演示|讨论)|^(?:please\s+)?(?:explain|describe|translate|summarize|show me how|teach me|how\b|what\b|why\b)/i.test(clause)) return true;
  if (/如何|怎么|怎样|教程|的(?:步骤|流程|方法|示例)|(?:有何|有什么)(?:影响|关系|区别|用)|是什么|^如果|\b(?:how to|what if|tutorial|instructions for)\b|\b(?:how|whether)\s+(?:i|we|one|you)\b/i.test(clause)) return true;
  if (/^(?:能否|是否|支持|can (?:this|the) (?:app|application)|can\s+(?:i|we)\b|do\s+(?:i|we|they)\b|does\b|did\b|has\b|have\b|is\b|are\b|should\b)/i.test(clause) && !/帮我|替我|为我/.test(clause)) return true;
  if (/了吗|了没|是否已经|有没有|(?:能|可以|会).*[吗么]$/.test(clause) && !/帮我|替我|为我/.test(clause)) return true;
  // Content drafting does not by itself ask to persist a workspace record.
  return /起草|草拟|草稿|文案|大纲|模板|(?:创建|制作)(?:一份|一个)?项目计划|\b(?:draft|compose|outline|template)\b|\bcreate\s+(?:a\s+)?project\s+plan\b/i.test(clause) &&
    !/保存为|存为|存成|保存到|写入|\b(?:save|persist)\b/i.test(clause);
}

export function operationIntent(prompt) {
  const text = unquoted(String(prompt || "").normalize("NFKC"));
  const requirements = [];
  for (let clause of text.split(/[，,；;。!?！？\n]|(?:然后|并且|而是)|并(?=创建|新建|添加|修改|更新|删除|恢复)|\b(?:and|then)\s+(?=(?:create|add|update|edit|delete|remove|restore|archive)\b)/i)) {
    clause = clause.trim().replace(/^(?:但是|但|再|只|仅|and\s+|then\s+)/i, "");
    if (!clause || informational(clause)) continue;
    // Cancelling a proposed removal is not another remove operation.
    if (/^(?:请|帮我)?取消(?:这次|本次)?(?:删除|移除|归档)/.test(clause)) continue;
    const found = operations.map(([operation, pattern]) => ({ operation, match: pattern.exec(clause) }))
      .filter(({ match }) => match).sort((a, b) => a.match.index - b.match.index);
    const selected = found[0];
    if (!selected) continue;
    const prefix = clause.slice(0, selected.match.index);
    if (noOperation.test(prefix)) continue;
    const mentions = [...clause.matchAll(kinds)].map((match) => ({ kind: kindOf(match[0]), index: match.index, end: match.index + match[0].length }));
    // A resource used as a container is not the record being changed.
    const targets = mentions.filter((item, index) => !mentions.slice(index + 1).some((next) =>
      /^(?:里|中|下|内|里面|中的|里的|\s+containing\b)/.test(clause.slice(item.end, next.index))));
    const before = targets.filter((item) => item.index < selected.match.index);
    const after = targets.filter((item) => item.index > selected.match.index);
    if (selected.operation === "create" && /添加|\badd\b/i.test(selected.match[0]) &&
        /描述|说明|标签|正文|内容|截止日期|清单|\b(?:description|details|tag|tags|content|deadline|checklist)\b/i.test(clause.slice(selected.match.index + selected.match[0].length)))
      selected.operation = "update";
    const candidates = selected.operation !== "create" && before.length ? before : after;
    const picked = [];
    for (const item of candidates) {
      if (!picked.length) picked.push(item);
      else if (/^(?:\s|、|和|及|与|以及|一起|and\b|an?\b|一个|一条|一项|新)*$/i.test(clause.slice(picked.at(-1).end, item.index))) picked.push(item);
    }
    if (picked.length) for (const { kind } of picked) requirements.push({ operation: selected.operation, kind });
    else if (reference.test(clause)) requirements.push({ operation: selected.operation, kind: null });
  }
  return { mutation: requirements.length > 0, requirements: requirements.filter((item, index) =>
    requirements.findIndex((other) => other.kind === item.kind && other.operation === item.operation) === index) };
}

export function operationActionTargets(action) {
  if (action?.operation === "restore" && action.kind === "trash") {
    return (Array.isArray(action.lifecycleReview?.entries) ? action.lifecycleReview.entries : [])
      .filter((entry) => entry && allowedKinds.has(entry.kind) && entry.kind !== "trash" && validID(entry.data?.id))
      .map((entry) => ({ kind: entry.kind === "notes" && entry.data.kind === "日程" ? "agenda" : entry.kind,
        id: entry.data.id, title: entry.data.title || entry.data.name || "未命名" }));
  }
  return action && allowedKinds.has(action.kind) ? [{ kind: action.kind, id: action.targetId, title: action.title }] : [];
}

export function missingPlanOperations(intent, plan) {
  const actions = plan?.status === "pending" && Array.isArray(plan.actions) ? plan.actions : [];
  return intent.requirements.filter((requirement) => !actions.some((action) =>
    (!requirement.operation || action.operation === requirement.operation) &&
      (!requirement.kind || operationActionTargets(action).some((target) => target.kind === requirement.kind))));
}

// Only durable applied receipts, never prose, pending actions or tool claims.
// This is historical locator data, not proof of the record's current contents.
export function recentOperationReceipts(messages, { limit = 20 } = {}) {
  const receipts = [];
  for (const message of [...messages].sort((a, b) => (b.position || 0) - (a.position || 0))) {
    const plan = message.pendingPlan;
    if (message.role !== "assistant" || !validID(message.id) || !validID(message.conversationId) ||
        message.deletedAt || message.private || message.ephemeral || message.incognito || message.hidden ||
        plan?.status !== "applied" || !validID(plan.id) || plan.conversationID !== message.conversationId || !Array.isArray(plan.receipts)) continue;
    for (const receipt of plan.receipts) {
      if (!allowedKinds.has(receipt?.kind) || !allowedOperations.has(receipt.operation) || !validID(receipt.id)) continue;
      const item = { operation: receipt.operation, kind: receipt.kind, id: receipt.id,
        title: typeof receipt.title === "string" ? receipt.title.slice(0, 240) : "", planId: plan.id, messageId: message.id };
      if (Number.isSafeInteger(plan.appliedAt) && plan.appliedAt >= 0) item.appliedAt = plan.appliedAt;
      if (["trash", "archive", "restore-trash", "unarchive"].includes(receipt.lifecycleOperation)) item.lifecycleOperation = receipt.lifecycleOperation;
      if (typeof receipt.recoveryKey === "string" && /^(?:trash|projects|tasks|notes):[A-Za-z0-9_-]{1,200}$/.test(receipt.recoveryKey)) item.recoveryKey = receipt.recoveryKey;
      if (Array.isArray(receipt.restored)) item.restored = receipt.restored.filter((entry) =>
        entry && allowedKinds.has(entry.kind) && validID(entry.id)).map(({ kind, id }) => ({ kind, id })).slice(0, 10);
      receipts.push(item);
      if (receipts.length >= limit) return receipts;
    }
  }
  return receipts;
}
