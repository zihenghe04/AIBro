import test from "node:test";
import assert from "node:assert/strict";
import { Store, MemoryAdapter } from "../src/store.js";
import { ask } from "../src/ai.js";
import { createResponsesOutput } from "../src/responses-output.js";

const message = (id, text) => ({ type: "message", id, role: "assistant", status: "completed",
  content: [{ type: "output_text", text, annotations: [] }] });
const call = (id, name, args) => ({ type: "function_call", id: `fc_${id}`, call_id: id,
  name, arguments: JSON.stringify(args), status: "completed" });

async function fixture() {
  const store = await new Store(new MemoryAdapter()).load();
  await store.tx(state => { state.settings.model = { base: "https://fixture.invalid/v1", model: "synthetic", format: "responses" }; });
  await store.put("conversations", { id: "integrity", title: "合成协议检查", projectId: null });
  return { store, vault: { get: async () => "public-synthetic-token" }, conversationID: "integrity" };
}

test("Responses preserves later done-only message text after an earlier streamed message", async () => {
  const setup = await fixture(), events = [];
  const first = message("message_one", "第一段。"), second = message("message_two", "第二段完整结论。");
  const result = await ask({ ...setup, prompt: "解释这个合成例子", onProgress: event => events.push(event),
    stream: async (_, { onEvent }) => {
      onEvent({ type: "response.output_item.added", output_index: 0, item: { ...first, status: "in_progress", content: [] } });
      onEvent({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: first.id, delta: "第一段。" });
      onEvent({ type: "response.output_text.done", output_index: 0, content_index: 0, item_id: first.id, text: "第一段。" });
      onEvent({ type: "response.output_item.done", output_index: 0, item: first });
      onEvent({ type: "response.output_item.done", output_index: 1, item: second });
      onEvent({ type: "response.completed", response: { status: "completed", output: [first, second] } });
    } });
  assert.equal(result.text, "第一段。第二段完整结论。");
  assert.equal(setup.store.list("messages").at(-1).content, result.text);
  assert.equal(events.filter(event => event.type === "text").map(event => event.text).join(""), result.text);
});

test("Responses completes a streamed text prefix from the authoritative final part without duplicating it", () => {
  const events = [], parser = createResponsesOutput(event => events.push(event));
  const item = message("message_prefix", "收到一半，最终结论完整。");
  parser.consume({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } });
  parser.consume({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: item.id, delta: "收到一半" });
  parser.consume({ type: "response.output_text.done", output_index: 0, content_index: 0, item_id: item.id, text: item.content[0].text });
  parser.consume({ type: "response.output_item.done", output_index: 0, item });
  parser.consume({ type: "response.completed", response: { status: "completed", output: [item] } });
  assert.equal(parser.result().text, item.content[0].text);
  assert.equal(events.filter(event => event.type === "text").map(event => event.text).join(""), item.content[0].text);
});

test("Responses retains final reasoning summaries from subsequent items without storing opaque content", () => {
  const parser = createResponsesOutput(() => {});
  const items = [
    { type: "reasoning", id: "reasoning_one", encrypted_content: "synthetic-opaque", summary: [{ type: "summary_text", text: "先理解" }] },
    { type: "reasoning", id: "reasoning_two", summary: [{ type: "summary_text", text: "再核对" }] },
  ];
  parser.consume({ type: "response.output_item.added", output_index: 0, item: { ...items[0], summary: [] } });
  parser.consume({ type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, item_id: items[0].id, delta: "先理解" });
  items.forEach((item, output_index) => parser.consume({ type: "response.output_item.done", output_index, item }));
  parser.consume({ type: "response.completed", response: { status: "completed", output: items } });
  assert.match(parser.result().reasoning, /^先理解\s*再核对$/);
  assert.doesNotMatch(parser.result().reasoning, /synthetic-opaque/);
});

test("Responses orders buffered items and content parts by their indices", () => {
  const events = [], parser = createResponsesOutput(event => events.push(event));
  const first = message("ordered_one", "第一段。");
  first.content.push({ type: "output_text", text: "第二段。", annotations: [] });
  const second = message("ordered_two", "第三段。");
  parser.consume({ type: "response.output_item.done", output_index: 1, item: second });
  assert.equal(events.length, 0);
  parser.consume({ type: "response.output_item.added", output_index: 0, item: { ...first, status: "in_progress", content: [] } });
  parser.consume({ type: "response.output_text.delta", output_index: 0, content_index: 1, item_id: first.id, delta: "第二段。" });
  assert.equal(events.length, 0);
  parser.consume({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: first.id, delta: "第一段。" });
  assert.equal(events.map(event => event.text).join(""), "第一段。");
  parser.consume({ type: "response.output_item.done", output_index: 0, item: first });
  parser.consume({ type: "response.completed", response: { status: "completed", output: [first, second] } });
  assert.equal(parser.result().text, "第一段。第二段。第三段。");
  assert.equal(events.map(event => event.text).join(""), parser.result().text);
});

test("Responses rejects contradictory final text, missing final parts and changed item identity", () => {
  for (const final of [message("consistent", "不同正文"), { ...message("consistent", ""), content: [] }, message("changed", "原始正文")]) {
    const parser = createResponsesOutput(() => {});
    parser.consume({ type: "response.output_item.added", output_index: 0, item: { ...message("consistent", ""), content: [] } });
    parser.consume({ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "consistent", delta: "原始正文" });
    assert.throws(() => parser.consume({ type: "response.completed", response: { status: "completed", output: [final] } }), /不完整|不一致/);
    assert.throws(() => parser.result(), /完成前中断/);
  }
});

test("Responses text-only compatibility reconciles supplied final text and accepts absent final text", () => {
  for (const response of [{ status: "completed" }, { status: "completed", output_text: "兼容正文完整" },
    { status: "completed", output: [message("compatibility", "兼容正文完整")] }]) {
    const parser = createResponsesOutput(() => {});
    parser.consume({ type: "response.output_text.delta", delta: "兼容正文" });
    parser.consume({ type: "response.completed", response });
    assert.equal(parser.result().text, response.output_text || response.output?.[0].content[0].text || "兼容正文");
  }
});

test("Responses cannot replace done-only tool arguments before executing the round", async () => {
  const setup = await fixture(), events = [];
  const first = call("immutable", "propose_changes", { actions: [{ operation: "create", kind: "tasks", changes: { title: "首次参数" } }] });
  const replacement = call("immutable", "propose_changes", { actions: [{ operation: "create", kind: "tasks", changes: { title: "被替换的参数" } }] });
  let rounds = 0;
  await assert.rejects(ask({ ...setup, prompt: "新建一个合成任务", onProgress: event => events.push(event),
    stream: async (_, { onEvent }) => {
      if (rounds++) return onEvent({ type: "response.completed", response: { status: "completed", output: [message("final", "方案准备好了")] } });
      onEvent({ type: "response.output_item.done", output_index: 0, item: first });
      onEvent({ type: "response.completed", response: { status: "completed", output: [replacement] } });
    } }), /不完整|不一致/);
  assert.equal(rounds, 1);
  assert.equal(events.some(event => event.type === "tool-start" && event.title === "propose_changes"), false);
  assert.equal(setup.store.list("tasks").length, 0);
  assert.equal(setup.store.list("messages").at(-1).status, "failed");
  assert.equal(setup.store.list("messages").at(-1).pendingPlan, null);
});

test("Responses rejects a reused call ID from another round before executing any call in that round", async () => {
  const setup = await fixture(), events = [];
  let requests = 0;
  await assert.rejects(ask({ ...setup, prompt: "查询合成目录", onProgress: event => events.push(event), http: async () => {
    requests++;
    return { status: "completed", output: [call("repeated", "workspace_list", { kind: "tasks" })] };
  } }), /重复使用工具调用标识/);
  assert.equal(requests, 2);
  assert.equal(events.filter(event => event.type === "tool-start" && event.title === "workspace_list").length, 1);
  assert.equal(setup.store.list("messages").at(-1).status, "failed");
});
