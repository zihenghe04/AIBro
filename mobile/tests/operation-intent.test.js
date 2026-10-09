import test from "node:test";
import assert from "node:assert/strict";
import { operationIntent, missingPlanOperations, recentOperationReceipts } from "../src/operation-intent.js";

test("explicit Chinese/English CRUD and unresolved followups select receipt handling without inventing IDs", () => {
  for (const [prompt, kind, operation] of [
    ['请创建一个项目叫“毕业论文”', "projects", "create"],
    ['Create a project named “Calendar”', "projects", "create"],
    ["帮我 add a task：明天交报告", "tasks", "create"],
    ["把这个任务标记为已完成", "tasks", "update"],
    ["把这段内容保存为新笔记", "notes", "create"],
    ["Please restore the deleted note", "notes", "restore"],
    ["把明天篮球日程推迟一小时", "agenda", "update"],
    ["把那个日程给删了", "agenda", "remove"],
    ["请恢复刚才删除的项目", "projects", "restore"],
    ["Could you delete the old task?", "tasks", "remove"],
    ["把刚才那个删掉", null, "remove"],
    ["把刚才那个改到明天下午三点", null, "update"],
    ["恢复刚才那个", null, "restore"],
    ["帮我保存这篇笔记", "notes", null],
    ["把这段内容记到笔记里", "notes", null],
    ["记下这个任务：明天交报告", "tasks", "create"],
    ["把这段总结写入新笔记", "notes", "create"],
    ["给任务添加 description：写完论文", "tasks", "update"],
    ["给这个任务添加描述：写完论文", "tasks", "update"],
    ["Add a description to this task", "tasks", "update"],
    ["Set up a project named Demo", "projects", "create"],
    ["Set a calendar event for tomorrow at 3 PM", "agenda", "create"],
    ["能否帮我删除这个任务", "tasks", "remove"],
  ]) {
    assert.deepEqual(operationIntent(prompt), { mutation: true, requirements: [{ kind, operation }] }, prompt);
    assert.equal(Object.hasOwn(operationIntent(prompt).requirements[0], "id"), false);
  }
});

test("questions, tutorial, quoted instructions, drafts and negation do not become workspace writes", () => {
  for (const prompt of ["怎么创建项目？", "Can this app create calendar events?", "Explain how to delete a task",
    "帮我写一份项目计划草稿", "起草一条‘取消日程’的通知", '翻译：“Please delete the note.”',
    "不要删除项目，只告诉我有哪些任务", "Don’t modify any records; show me a draft", "刚才那个任务删除了吗？",
    "如果删除日程，会影响项目吗？", "刚才那个怎么样了", "取消删除刚才那个项目", "介绍项目创建流程", "note 和 notebook 有什么区别",
    '请总结“删除任务”的步骤', "项目管理和创建任务有什么关系？", "任务删除后能恢复吗？", "I want to know how I can delete this task",
    "创建任务是什么意思？", "创建笔记会同步吗？", "Is it possible to delete the task?", "Can I restore a note?"]) {
    assert.equal(operationIntent(prompt).mutation, false, prompt);
  }
});

test("target containers, new titles and locally negated clauses do not confuse required actions", () => {
  for (const [prompt, expected] of [
    ['把项目名称改为“日程”', [{ kind: "projects", operation: "update" }]],
    ['给“日程”项目添加任务', [{ kind: "tasks", operation: "create" }]],
    ["删除项目里的篮球日程", [{ kind: "agenda", operation: "remove" }]],
    ["把篮球日程移动到运动项目", [{ kind: "agenda", operation: "update" }]],
    ["更新任务标题，但不要修改截止日期", [{ kind: "tasks", operation: "update" }]],
    ["新建笔记，不要删除原文", [{ kind: "notes", operation: "create" }]],
    ['把任务标题改成“不要执行”', [{ kind: "tasks", operation: "update" }]],
    ["不要创建项目，只创建任务", [{ kind: "tasks", operation: "create" }]],
    ["先查日程，再把这个测试日程删掉", [{ kind: "agenda", operation: "remove" }]],
    ["修改笔记并创建任务、项目", [{ kind: "notes", operation: "update" }, { kind: "tasks", operation: "create" }, { kind: "projects", operation: "create" }]],
  ]) assert.deepEqual(operationIntent(prompt).requirements, expected, prompt);
});

test("only a matching real pending action satisfies an operation, including partial multi-record requests", () => {
  const intent = operationIntent("创建任务、项目");
  const task = { kind: "tasks", operation: "create" };
  assert.deepEqual(missingPlanOperations(intent, null), intent.requirements);
  assert.deepEqual(missingPlanOperations(intent, { status: "applied", actions: [task] }), intent.requirements);
  assert.deepEqual(missingPlanOperations(intent, { status: "pending", actions: [task] }), [{ kind: "projects", operation: "create" }]);
  assert.deepEqual(missingPlanOperations(operationIntent("把刚才那个删掉"), { status: "pending", actions: [{ kind: "notes", operation: "remove" }] }), []);
});

test("querying the history of created or deleted records stays read-only", () => {
  for (const prompt of ['查询刚才确认创建的「合成项目」及其任务、笔记和日程。读取真实记录，列出四条的名称、ID、归属。',
    "请列出今天创建的任务", "帮我查看刚才删除的笔记", "查询已恢复的日程", "List the tasks I deleted", "Show recently created projects"])
    assert.equal(operationIntent(prompt).mutation, false, prompt);
  assert.deepEqual(operationIntent("查询刚才创建的任务，并删除任务").requirements, [{ operation: "remove", kind: "tasks" }]);
  assert.deepEqual(operationIntent("List the created tasks and delete the previous task").requirements, [{ operation: "remove", kind: "tasks" }]);
});

test("receipt context contains only applied persisted IDs and a bounded safe field projection", () => {
  const applied = { role: "assistant", id: "message", conversationId: "chat", position: 2, pendingPlan: { id: "plan", conversationID: "chat", status: "applied", appliedAt: 10,
    receipts: [{ operation: "remove", kind: "tasks", id: "task", title: "合成任务", lifecycleOperation: "trash", recoveryKey: "trash:synthetic",
      authorization: "must-not-enter-context", after: { secret: "not-context" } }] } };
  const rows = [applied, { ...applied, position: 3, pendingPlan: { ...applied.pendingPlan, status: "pending" } },
    { ...applied, position: 4, role: "user" }, { ...applied, position: 5, private: true },
    { ...applied, position: 6, pendingPlan: { ...applied.pendingPlan, status: "rejected" } },
    { ...applied, id: { content: "must-not-enter-context" } },
    { ...applied, pendingPlan: { ...applied.pendingPlan, conversationID: "other" } }];
  const actual = recentOperationReceipts(rows);
  assert.deepEqual(actual, [{ operation: "remove", kind: "tasks", id: "task", title: "合成任务", planId: "plan", messageId: "message", appliedAt: 10,
    lifecycleOperation: "trash", recoveryKey: "trash:synthetic" }]);
  assert.doesNotMatch(JSON.stringify(actual), /must-not-enter-context|not-context/);
  assert.equal(recentOperationReceipts(Array.from({ length: 30 }, () => applied)).length, 20);
});
