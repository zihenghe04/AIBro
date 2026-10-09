import test from "node:test";
import assert from "node:assert/strict";
import { Store, MemoryAdapter, addMessage, clone } from "../src/store.js";
import { ask, selectedContext } from "../src/ai.js";
import { createAgentTools, applyPlan, rejectPlan, validatePlan } from "../src/agent-tools.js";
import { readEvent } from "../src/agenda.js";

async function fixture(format = "chat") {
  const store = await new Store(new MemoryAdapter()).load();
  await store.tx((state) => state.settings.model = { base: "https://model.example/v1", model: "fixture", format });
  await store.put("conversations", { id: "chat", title: "Fixture", projectId: null });
  const vault = { get: async (key) => { assert.equal(key, "model"); return "fixture-api-key"; } };
  return { store, vault };
}
const toolCall = (name, args, id = name) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const toolReply = (calls) => ({ choices: [{ message: { content: null, tool_calls: calls }, finish_reason: "tool_calls" }] });
const finalReply = (content = "请审阅修改。") => ({ choices: [{ message: { content }, finish_reason: "stop" }] });
async function stage(store, actions, reads = []) {
  const tools = createAgentTools({ store, conversationID: "chat" });
  for (const read of reads) assert.equal((await tools.execute("knowledge_read", read)).error, undefined);
  const result = await tools.execute("propose_changes", { actions });
  assert.equal(result.error, undefined, result.error);
  const plan = tools.pendingPlan();
  await addMessage(store, "chat", "assistant", "尚未保存", { pendingPlan: plan });
  return plan;
}

test("Chinese chunk retrieval reaches document tails and respects fixed project, explicit references and private records", async () => {
  const { store } = await fixture();
  await store.put("projects", { id: "p", name: "材料", workspace: "科研" });
  await store.put("projects", { id: "q", name: "另一个项目", workspace: "科研" });
  const body = "普通背景介绍。".repeat(7000) + "量子材料的退火温度为 760℃，保持两小时。";
  await store.put("imports", { id: "long", name: "完整材料.txt", content: body, projectId: "p" });
  await store.put("notes", { id: "other", title: "量子材料", content: "unselected-secret", projectId: "q" });
  await store.put("notes", { id: "private", title: "量子材料", content: "private-record-secret", private: true, projectId: "p" });
  const tools = createAgentTools({ store, conversationID: "chat", projectID: "p" });
  const result = await tools.execute("knowledge_search", { query: "查找量子材料的退火温度" });
  assert.ok(result.entries.some((entry) => entry.offset > 24000 && entry.content.includes("760℃")));
  assert.doesNotMatch(JSON.stringify(result), /unselected-secret|private-record-secret/);
  assert.match((await tools.execute("knowledge_read", { kind: "notes", id: "other" })).error, /范围/);
  assert.match(selectedContext(store, ["imports:long"], "退火温度")[0].content, /760℃/);
  const selected = createAgentTools({ store, contextKeys: ["imports:long"] });
  assert.doesNotMatch(JSON.stringify(await selected.execute("knowledge_search", { query: "量子材料" })), /unselected-secret/);
});

test("native Chat Completions tool loop persists a reviewable plan; restart approval atomically writes all supported entities", async () => {
  const { store, vault } = await fixture();
  await store.put("notes", { id: "note", title: "Original", content: "Original facts" });
  const replies = [
    toolReply([toolCall("knowledge_read", { kind: "notes", id: "note" })]),
    toolReply([toolCall("propose_changes", { actions: [
      { operation: "update", kind: "notes", id: "note", changes: { title: "Edited", content: "Original facts with structure" } },
      { operation: "create", kind: "tasks", changes: { title: "Run experiment", dueAt: "2030-01-02T08:00:00+08:00", reminderMinutes: 15 } },
      { operation: "create", kind: "projects", changes: { name: "Research project", workspace: "科研" } },
      { operation: "create", kind: "agenda", changes: { title: "Group meeting", start: "2030-01-03T08:00:00+08:00", end: "2030-01-03T09:00:00+08:00", timeZone: "Asia/Shanghai" } },
    ] })]), finalReply(),
  ];
  const events = [], requests = [];
  const result = await ask({ store, vault, conversationID: "chat", prompt: "修改笔记并创建任务、项目和组会，先给我审阅", onProgress: (event) => events.push(event),
    http: async (url, options) => { requests.push(clone(options.body)); assert.match(url, /chat\/completions$/); return replies.shift(); } });
  assert.equal(replies.length, 0);
  assert.equal(store.get("notes", "note").content, "Original facts");
  assert.equal(store.list("tasks").length, 0);
  assert.equal(result.pendingPlan.actions.length, 4);
  assert.match(result.text, /确认后才会保存/);
  assert.equal(events.filter((event) => event.type === "tool-start" && event.title === "knowledge_read").length, 1);
  assert.ok(requests[2].messages.some((message) => message.role === "tool" && message.content.includes("awaiting_user_review")));
  assert.doesNotMatch(JSON.stringify(requests), /fixture-api-key/);
  const reloaded = await new Store(store.adapter).load();
  const saved = reloaded.list("messages").find((message) => message.id === result.messageID);
  assert.deepEqual(saved.pendingPlan, result.pendingPlan);
  validatePlan(reloaded, result.pendingPlan);
  const applied = await applyPlan(reloaded, result.pendingPlan);
  assert.equal(applied.status, "applied");
  assert.equal(applied.receipts.length, 4);
  assert.equal(reloaded.get("notes", "note").revisionHistory[0].content, "Original facts");
  assert.equal(reloaded.list("tasks")[0].reminderMinutes, 15);
  assert.equal(reloaded.list("projects")[0].name, "Research project");
  assert.equal(readEvent(reloaded.list("notes").find((note) => note.kind === "日程")).title, "Group meeting");
  await applyPlan(reloaded, result.pendingPlan);
  assert.equal(reloaded.list("tasks").length, 1, "repeated approval must be idempotent");
});

test("review rejects changes after a read, stale approval and unread document replacement", async () => {
  const { store } = await fixture();
  await store.put("notes", { id: "note", title: "Long", content: "证据".repeat(7000) });
  const tools = createAgentTools({ store, conversationID: "chat" });
  const action = { operation: "update", kind: "notes", id: "note", changes: { content: "short replacement" } };
  assert.match((await tools.execute("propose_changes", { actions: [action] })).error, /先调用 knowledge_read/);
  await tools.execute("knowledge_read", { kind: "notes", id: "note" });
  assert.match((await tools.execute("propose_changes", { actions: [action] })).error, /完整原文/);
  await tools.execute("knowledge_read", { kind: "notes", id: "note", offset: 6000, limit: 8000 });
  await store.put("notes", { ...store.get("notes", "note"), content: "concurrent human edit" });
  assert.match((await tools.execute("propose_changes", { actions: [action] })).error, /读取后已变化/);
  const plan = await stage(store, [action, { operation: "create", kind: "tasks", changes: { title: "Should remain pending" } }], [{ kind: "notes", id: "note" }]);
  await store.put("notes", { ...store.get("notes", "note"), title: "another human edit" });
  await assert.rejects(applyPlan(store, plan), /其他位置修改/);
  assert.equal(store.list("tasks").length, 0);
  assert.equal(store.get("notes", "note").content, "concurrent human edit");
  assert.equal(store.list("messages").at(-1).pendingPlan.status, "pending");
});

test("plan rejection and durable-save failure never mutate business records; forged fields cannot be approved", async () => {
  const { store } = await fixture();
  const plan = await stage(store, [{ operation: "create", kind: "tasks", changes: { title: "Durable task" } }]);
  const originalWrite = store.adapter.write.bind(store.adapter);
  store.adapter.write = async () => { throw Error("fixture disk unavailable"); };
  await assert.rejects(applyPlan(store, plan), /disk unavailable/);
  assert.equal(store.list("tasks").length, 0);
  assert.equal(store.list("messages")[0].pendingPlan.status, "pending");
  store.adapter.write = originalWrite;
  await rejectPlan(store, plan);
  await rejectPlan(store, plan);
  await assert.rejects(applyPlan(store, plan), /已经拒绝/);
  assert.equal(store.list("tasks").length, 0);

  const forged = await stage(store, [{ operation: "create", kind: "projects", changes: { name: "Reviewed" } }]);
  forged.actions[0].after.localFolder = "/unreviewed/path";
  await store.tx((state) => {
    Object.values(state.records).find((record) => record.data?.pendingPlan?.id === forged.id).data.pendingPlan = clone(forged);
  });
  await assert.rejects(applyPlan(store, forged), /方案内容/);
  assert.equal(store.list("projects").length, 0);
});

test("tool validation rejects hidden fields, invalid dates, unsupported deletes and missing project names", async () => {
  const { store } = await fixture(), tools = createAgentTools({ store, conversationID: "chat" });
  for (const action of [
    { operation: "delete", kind: "notes", id: "n", changes: {} },
    { operation: "create", kind: "tasks", changes: { title: "Fixture", apiKey: "must-not-persist" } },
    { operation: "create", kind: "tasks", changes: { title: "Fixture", dueAt: "明天晚上" } },
    { operation: "create", kind: "tasks", changes: { title: "Fixture", dueAt: "2030-02-30T12:00:00Z" } },
    { operation: "create", kind: "tasks", changes: { title: "Fixture", reminderMinutes: true } },
    { operation: "create", kind: "projects", changes: { description: "Missing name" } },
  ]) assert.ok((await tools.execute("propose_changes", { actions: [action] })).error);
  assert.equal(tools.pendingPlan(), null);
  const dateOnly = await tools.execute("propose_changes", { actions: [{ operation: "create", kind: "tasks", changes: { title: "Deadline day", dueAt: "2030-02-28" } }] });
  assert.equal(dateOnly.error, undefined);
  assert.equal(tools.pendingPlan().actions[0].after.dueAt, "2030-02-28");
});

test("streamed thoughts and fragmented tool arguments produce review locally and ignore late provider text", async () => {
  const { store, vault } = await fixture();
  await store.put("tasks", { id: "task", title: "Existing task", status: "todo", priority: "medium" });
  let round = 0, lateEvent;
  const events = [];
  const result = await ask({ store, vault, conversationID: "chat", prompt: "把已有任务标为完成，先让我审阅", onProgress: (event) => events.push(event),
    stream: async (url, { body, onEvent }) => {
      assert.equal(body.stream, true);
      if (round === 0) {
        onEvent({ choices: [{ delta: { reasoning_content: "先读取任务状态" } }] });
        onEvent({ choices: [{ delta: { tool_calls: [{ index: 0, id: "read", function: { name: "knowledge_read", arguments: '{"kind":"tasks",' } }] } }] });
        onEvent({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"id":"task"}' } }] }, finish_reason: "tool_calls" }] });
      } else if (round === 1) {
        onEvent({ choices: [{ delta: { tool_calls: [toolCall("propose_changes", { actions: [{ operation: "update", kind: "tasks", id: "task", changes: { status: "done" } }] }, "plan")] }, finish_reason: "tool_calls" }] });
        lateEvent = onEvent;
      } else {
        assert.fail('a complete single-target review must not depend on a provider prose tail');
      }
      round++;
    } });
  assert.equal(result.reasoning, "先读取任务状态");
  assert.equal(round, 2);
  assert.match(result.text, /拟修改任务/);
  assert.equal(store.get("tasks", "task").status, "todo");
  assert.equal(result.pendingPlan.actions[0].after.status, "done");
  assert.ok(events.some((event) => event.type === "tool-result" && event.title === "propose_changes" && event.output.executed === false));
  lateEvent({ choices: [{ delta: { content: "late invalid content" } }] });
  await store.tail;
  assert.doesNotMatch(store.list("messages").at(-1).content, /late invalid/);
});

test("cancel keeps partial answer durable and ignores later stream events without changing conversation targets", async () => {
  const { store, vault } = await fixture(), controller = new AbortController();
  await store.put("conversations", { id: "other", title: "Other", projectId: null });
  await store.tx((state) => state.drafts["chat:other"] = "unfinished other draft");
  let late;
  await assert.rejects(ask({ store, vault, conversationID: "chat", prompt: "解释这份资料", signal: controller.signal,
    onProgress: (event) => { if (event.type === "text") controller.abort(); },
    stream: async (url, { onEvent }) => {
      late = onEvent;
      onEvent({ choices: [{ delta: { content: "已经收到的部分" } }] });
      return new Promise(() => {});
    } }), (error) => error.name === "AbortError" && error.conversationID === "chat" && error.partialText === "已经收到的部分");
  late({ choices: [{ delta: { content: "不可进入的迟到内容" }, finish_reason: "stop" }] });
  const reloaded = await new Store(store.adapter).load();
  const response = reloaded.list("messages").find((message) => message.role === "assistant");
  assert.equal(response.status, "cancelled");
  assert.equal(response.content, "已经收到的部分");
  assert.equal(response.conversationId, "chat");
  assert.equal(reloaded.state.drafts["chat:other"], "unfinished other draft");
  assert.equal(reloaded.list("messages").filter((message) => message.conversationId === "other").length, 0);
});

test("existing conversation owns project scope even when caller passes a different project", async () => {
  const { store, vault } = await fixture();
  await store.put("projects", { id: "p", name: "Correct", workspace: "科研" });
  await store.put("projects", { id: "q", name: "Wrong", workspace: "课程" });
  await store.put("conversations", { ...store.get("conversations", "chat"), projectId: "p" });
  await store.put("notes", { id: "p-note", title: "材料", content: "correct-project-material", projectId: "p" });
  await store.put("notes", { id: "q-note", title: "材料", content: "wrong-project-private", projectId: "q" });
  const result = await ask({ store, vault, conversationID: "chat", projectID: "q", prompt: "请查询材料", http: async (url, { body }) => {
    assert.match(JSON.stringify(body), /correct-project-material/);
    assert.doesNotMatch(JSON.stringify(body), /wrong-project-private/);
    return finalReply("找到了材料 [1]。");
  } });
  assert.equal(result.conversationID, "chat");
  assert.equal(store.get("conversations", "chat").projectId, "p");
});

test("Responses streams preserve provider summaries and reject incomplete or malformed tool output", async () => {
  const { store, vault } = await fixture("responses");
  const result = await ask({ store, vault, conversationID: "chat", prompt: "解释一下", stream: async (url, { body, onEvent }) => {
    assert.match(url, /responses$/); assert.ok(body.tools.some(tool => tool.name === "knowledge_read"));
    onEvent({ type: "response.reasoning_summary_text.delta", delta: "提供可见摘要" });
    onEvent({ type: "response.output_text.delta", delta: "有效回答" });
    onEvent({ type: "response.completed", response: { status: "completed" } });
  } });
  assert.match(result.text, /有效回答/);
  assert.equal(result.text, "有效回答");
  assert.equal(result.capabilities.writePlans, true);
  assert.equal(result.pendingPlan, null);
  await assert.rejects(ask({ store, vault, conversationID: "chat", prompt: "另一个问题", stream: async (url, { onEvent }) => {
    onEvent({ type: "response.output_text.delta", delta: "中断内容" });
  } }), /完成前中断/);
  assert.equal(store.list("messages").at(-1).status, "failed");
  assert.equal(store.list("messages").at(-1).content, "中断内容");
  await assert.rejects(ask({ store, vault, conversationID: "chat", prompt: "创建任务", http: async () => ({ status: "completed", output: [{ type: "function_call" }] }) }), /不完整或前后不一致/);
  assert.equal(store.list("tasks").length, 0);
});

test("rewrite mode excludes write tools and refuses a provider's unauthorized write call", async () => {
  const { store, vault } = await fixture();
  let calls = 0;
  await assert.rejects(ask({ store, vault, conversationID: "chat", prompt: "请直接生成改写正文", allowWritePlans: false,
    http: async (url, { body }) => {
      calls++;
      assert.ok(body.tools.every((tool) => tool.function.name !== "propose_changes"));
      return toolReply([toolCall("propose_changes", { actions: [{ operation: "create", kind: "notes", changes: { title: "Unauthorized", content: "Must not write" } }] })]);
    } }), /模型请求写入已被阻止/);
  assert.equal(calls, 1);
  assert.equal(store.list("notes").length, 0);
  assert.equal(store.list("messages").at(-1).pendingPlan, null);
  assert.equal(store.list("messages").at(-1).status, "failed");
});
