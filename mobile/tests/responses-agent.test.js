import test from "node:test";
import assert from "node:assert/strict";
import { Store, MemoryAdapter, clone } from "../src/store.js";
import { ask } from "../src/ai.js";
import { applyPlan } from "../src/agent-tools.js";
import { createResponsesOutput } from "../src/responses-output.js";

async function fixture() {
  const store = await new Store(new MemoryAdapter()).load();
  await store.tx(s => { s.settings.model = { base: "https://model.example/v1", model: "fixture", format: "responses" }; });
  await store.put("conversations", { id: "chat", title: "合成", projectId: null });
  await store.put("notes", { id: "source", title: "原文", content: "保留原文" });
  let credential = "synthetic-secret";
  return { store, vault: { get: async () => credential, set: async (_key, value) => { credential = value; } } };
}
const call = (name, args, id) => ({ type: "function_call", id: "fc_" + id, call_id: id, name, arguments: JSON.stringify(args), status: "completed" });
const message = text => ({ type: "message", id: "m", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
function streamItem(onEvent, item, index) {
  if (item.type !== "function_call") return onEvent({ type: "response.output_item.done", output_index: index, item });
  onEvent({ type: "response.output_item.added", output_index: index, item: { ...item, arguments: "", status: "in_progress" } });
  for (const delta of [item.arguments.slice(0, 5), item.arguments.slice(5)])
    onEvent({ type: "response.function_call_arguments.delta", output_index: index, item_id: item.id, delta });
  onEvent({ type: "response.function_call_arguments.done", output_index: index, item_id: item.id, arguments: item.arguments });
  onEvent({ type: "response.output_item.done", output_index: index, item });
}

test("Responses SSE reads, proposes mixed changes and replays all reasoning/calls without executing before approval", async () => {
  const { store, vault } = await fixture(), progress = [], requests = [];
  const opaque = { type: "reasoning", id: "r1", encrypted_content: "opaque-private-not-for-ui", summary: [{ type: "summary_text", text: "读取原文后准备方案" }] };
  const rounds = [
    [opaque, call("knowledge_read", { kind: "notes", id: "source" }, "read")],
    [call("propose_changes", { actions: [
      { operation: "update", kind: "notes", id: "source", changes: { content: "保留原文并补充结构" } },
      { operation: "create", kind: "projects", ref: "research", changes: { name: "合成研究", workspace: "科研" } },
      { operation: "create", kind: "tasks", changes: { title: "检查结果", projectRef: "research" } },
    ] }, "plan")], [message("已全部完成！")],
  ];
  const result = await ask({ store, vault, conversationID: "chat", prompt: "修改这篇笔记，并新建研究项目和任务", onProgress: e => progress.push(e),
    stream: async (url, { body, onEvent }) => {
      requests.push(clone(body)); assert.match(url, /\/responses$/);
      assert.equal(body.store, false); assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
      assert.ok(body.tools.every(t => t.type === "function" && t.strict === false && t.name && !t.function));
      const output = rounds.shift(); output.forEach((item, index) => streamItem(onEvent, item, index));
      assert.equal(store.get("notes", "source").content, "保留原文"); assert.equal(store.list("projects").length, 0);
      onEvent({ type: "response.completed", response: { status: "completed", output } });
    } });
  assert.equal(rounds.length, 0); assert.equal(result.pendingPlan.actions.length, 3);
  assert.deepEqual(requests[1].input.slice(-3, -1), [opaque, requests[1].input.at(-2)]);
  assert.equal(requests[1].input.at(-1).type, "function_call_output");
  assert.equal(requests[1].input.at(-1).call_id, "read");
  assert.match(requests[1].input.at(-1).output, /保留原文/);
  assert.ok(requests[2].input.some(item => item.type === "reasoning" && item.encrypted_content === opaque.encrypted_content));
  assert.ok(requests[2].input.some(item => item.type === "function_call_output" && item.call_id === "plan"));
  assert.doesNotMatch(JSON.stringify(store.state), /opaque-private-not-for-ui|synthetic-secret|已全部完成/);
  assert.ok(progress.some(e => e.type === "reasoning" && e.text === "读取原文后准备方案"));
  assert.equal(progress.filter(e => e.type === "tool-start" && e.title === "propose_changes").length, 1);
  const reloaded = await new Store(store.adapter).load();
  await applyPlan(reloaded, result.pendingPlan);
  assert.equal(reloaded.get("notes", "source").content, "保留原文并补充结构");
  assert.equal(reloaded.list("tasks")[0].projectId, reloaded.list("projects")[0].id);
});

test("Responses HTTP output and item.done-only completion support multiple calls in order", async () => {
  const { store, vault } = await fixture(); let count = 0;
  const result = await ask({ store, vault, conversationID: "chat", prompt: "查询原文", http: async (_, { body }) => {
    if (!count++) return { status: "completed", output: [call("knowledge_read", { kind: "notes", id: "source" }, "a"), call("workspace_list", { kinds: ["notes"] }, "b")] };
    assert.deepEqual(body.input.slice(-2).map(item => item.call_id), ["a", "b"]);
    return { status: "completed", output: [message("原文已读取。")] };
  } });
  assert.equal(result.text, "原文已读取。");
  const parser = createResponsesOutput(() => {}), item = call("workspace_list", {}, "c");
  streamItem(e => parser.consume(e), item, 0);
  parser.consume({ type: "response.completed", response: { status: "completed" } });
  assert.equal(parser.result().toolCalls[0].id, "c");
});

test("Responses malformed, partial, duplicate, mismatched and unsupported calls never reach tools", async () => {
  const good = call("propose_changes", { actions: [{ operation: "create", kind: "tasks", changes: { title: "不能创建" } }] }, "x");
  const cases = [
    on => on({ type: "response.output_item.added", output_index: 0, item: { ...good, arguments: "" } }),
    on => { on({ type: "response.output_item.added", output_index: 0, item: { ...good, arguments: "" } }); on({ type: "response.completed", response: { status: "completed" } }); },
    on => on({ type: "response.completed", response: { status: "completed", output: [good, good] } }),
    on => { streamItem(on, good, 0); on({ type: "response.completed", response: { status: "completed", output: [{ ...good, arguments: "{}" }] } }); },
    on => on({ type: "response.completed", response: { status: "completed", output: [{ type: "computer_call", id: "unsupported" }] } }),
    on => on({ type: "response.failed", response: { status: "failed" } }),
  ];
  for (const consume of cases) {
    const { store, vault } = await fixture(), events = [];
    await assert.rejects(ask({ store, vault, conversationID: "chat", prompt: "创建任务", onProgress: e => events.push(e), stream: async (_, { onEvent }) => consume(onEvent) }));
    assert.equal(store.list("tasks").length, 0);
    assert.equal(events.some(e => e.type === "tool-start" && e.title === "propose_changes"), false);
    assert.equal(store.list("messages").at(-1).status, "failed");
  }
});

test("Responses cancellation and read-only draft mode cannot yield a write plan", async () => {
  const { store, vault } = await fixture(), controller = new AbortController(); let late;
  await assert.rejects(ask({ store, vault, conversationID: "chat", prompt: "创建任务", signal: controller.signal,
    stream: async (_, { onEvent }) => { late = onEvent; onEvent({ type: "response.reasoning_summary_text.delta", delta: "已有摘要" }); controller.abort(); return new Promise(() => {}); } }), e => e.name === "AbortError");
  late({ type: "response.completed", response: { status: "completed", output: [message("迟到")] } });
  assert.equal(store.list("messages").at(-1).status, "cancelled");
  await assert.rejects(ask({ store, vault, conversationID: "chat", prompt: "改写正文", allowWritePlans: false, http: async (_, { body }) => {
    assert.ok(body.tools.every(t => t.name !== "propose_changes"));
    return { status: "completed", output: [call("propose_changes", { actions: [{ operation: "create", kind: "tasks", changes: { title: "越权" } }] }, "forbidden")] };
  } }), /写入已被阻止/);
  assert.equal(store.list("tasks").length, 0);
  assert.equal(store.list("messages").at(-1).pendingPlan, null);
});
