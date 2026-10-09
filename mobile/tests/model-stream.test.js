import test from "node:test";
import assert from "node:assert/strict";
import { createSSEParser, nativeModelStream, fetchModelStream } from "../src/model-stream.js";
import { ConversationSessions } from "../src/conversation-session.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const frame = (value) => "data: " + JSON.stringify(value) + "\r\n\r\n";
function bridgeFixture({ listenerGate, requestGate, requestError } = {}) {
  const requests = [], cancels = [];
  let callback, removed = 0;
  return {
    requests, cancels, get removed() { return removed; },
    emit(event) { callback?.(event); },
    bridge: {
      addListener(name, listener) {
        assert.equal(name, "requestStreamEvent"); callback = listener;
        const handle = { remove: async () => { removed++; } };
        return listenerGate ? listenerGate.promise.then(() => handle) : Promise.resolve(handle);
      },
      requestStream(options) {
        requests.push(options);
        if (requestError) return Promise.reject(requestError);
        return requestGate ? requestGate.promise : Promise.resolve();
      },
      cancelRequest: async ({ requestId }) => cancels.push(requestId),
    },
  };
}

test("SSE parser handles split CRLF, multiline JSON, BOM, named events and terminal DONE", () => {
  const events = [], parser = createSSEParser((event) => events.push(event));
  const content = '\uFEFF: keepalive\r\nevent: response.output_text.delta\r\ndata: {\r\ndata: "delta":"中文内容"\r\ndata: }\r\n\r\n';
  for (const character of content) parser.push(character);
  parser.push('data: {"type":"kept","value":1}\r\r');
  parser.push('\ndata: [DONE]\r\n\r\ndata: not-json\n\n');
  parser.finish();
  assert.deepEqual(events, [{ delta: "中文内容", type: "response.output_text.delta" }, { type: "kept", value: 1 }]);
  assert.equal(parser.ended, true);
});

test("SSE bounds each event without rejecting a batch of valid frames; malformed or scalar events fail", () => {
  const events = [], parser = createSSEParser((event) => events.push(event), 64);
  parser.push(Array.from({ length: 100 }, (_, n) => frame({ n })).join(""));
  assert.equal(events.length, 100);
  assert.throws(() => createSSEParser(() => {}, 64).push("data: " + "x".repeat(65)), /消息过大/);
  assert.throws(() => createSSEParser(() => {}).push("data: invalid\n\n"), /无法解析/);
  assert.throws(() => createSSEParser(() => {}).push("data: null\n\n"), /无效/);
});

test("native streams isolate request IDs and finish on DONE while removing listeners and cancelling the transport", async () => {
  const fixture = bridgeFixture(), events = [];
  const streaming = nativeModelStream(fixture.bridge, "https://model.example/v1/chat/completions", { body: { stream: true }, onEvent: (event) => events.push(event) });
  await tick();
  const { requestId, body } = fixture.requests[0];
  assert.equal(JSON.parse(body).stream, true);
  fixture.emit({ requestId: "unrelated", type: "data", data: frame({ unrelated: true }) });
  fixture.emit({ requestId, type: "data", status: 200, data: 'data: {"text":"真实中' });
  fixture.emit({ requestId, type: "data", data: '文"}\r' });
  fixture.emit({ requestId, type: "data", data: '\n\r\ndata: [DONE]\r\n\r\n' });
  await streaming;
  assert.deepEqual(events, [{ text: "真实中文" }]);
  assert.equal(fixture.removed, 1);
  assert.ok(fixture.cancels.includes(requestId));
  fixture.emit({ requestId, type: "data", data: frame({ late: true }) });
  assert.equal(events.length, 1);
});

test("native HTTP failures keep status and never surface arbitrary error bodies; parse and registration failures clean up", async () => {
  for (const status of [302, 401, 500]) {
    const fixture = bridgeFixture();
    const streaming = nativeModelStream(fixture.bridge, "https://model.example", { onEvent: () => assert.fail("HTTP error body is not an SSE event") });
    await tick();
    const requestId = fixture.requests[0].requestId;
    fixture.emit({ requestId, type: "data", status, data: '{"error":"private-token-fixture"}' });
    fixture.emit({ requestId, type: "done", status });
    await assert.rejects(streaming, (error) => error.status === status && !error.message.includes("private-token"));
    assert.equal(fixture.removed, 1);
  }
  const malformed = bridgeFixture();
  const streaming = nativeModelStream(malformed.bridge, "https://model.example", { onEvent: () => {} });
  await tick();
  malformed.emit({ requestId: malformed.requests[0].requestId, type: "data", data: "data: not-json\n\n" });
  await assert.rejects(streaming, /无法解析/);
  assert.equal(malformed.removed, 1);
  const unavailable = bridgeFixture({ requestError: Error("fixture registration failed") });
  await assert.rejects(nativeModelStream(unavailable.bridge, "https://model.example", { onEvent: () => {} }), /registration failed/);
  assert.equal(unavailable.removed, 1);
});

test("native cancellation wins listener and request registration races and cleans late acknowledgements", { timeout: 1500 }, async () => {
  const listenerGate = deferred(), first = bridgeFixture({ listenerGate }), early = new AbortController();
  const firstRequest = nativeModelStream(first.bridge, "https://model.example", { signal: early.signal, onEvent: () => {} });
  early.abort();
  await assert.rejects(firstRequest, { name: "AbortError" });
  assert.equal(first.requests.length, 0);
  listenerGate.resolve(); await tick();
  assert.equal(first.removed, 1);

  const requestGate = deferred(), second = bridgeFixture({ requestGate }), controller = new AbortController();
  const secondRequest = nativeModelStream(second.bridge, "https://model.example", { signal: controller.signal, onEvent: () => {} });
  await tick();
  assert.equal(second.requests.length, 1);
  controller.abort();
  await assert.rejects(secondRequest, { name: "AbortError" });
  const before = second.cancels.length;
  assert.equal(second.removed, 1);
  requestGate.resolve(); await tick();
  assert.ok(second.cancels.length > before, "late request registration must be cancelled again");
});

test("fetch streaming decodes split UTF-8 characters and releases an open response on DONE", async () => {
  const bytes = new TextEncoder().encode(frame({ text: "中文🙂" }) + "data: [DONE]\r\n\r\n");
  let cancelled = 0;
  const body = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); }, cancel() { cancelled++; } });
  const events = [];
  await fetchModelStream(async (url, options) => {
    assert.equal(options.redirect, "error");
    return new Response(body, { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
  }, "https://model.example", { body: { stream: true }, onEvent: (event) => events.push(event) });
  assert.deepEqual(events, [{ text: "中文🙂" }]);
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
});

test("fetch cancellation interrupts pending reads and pending response acquisition, cleaning late bodies", { timeout: 1500 }, async () => {
  let cancelled = 0;
  const body = new ReadableStream({ cancel() { cancelled++; } });
  const controller = new AbortController();
  const pending = fetchModelStream(async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }), "https://model.example", { signal: controller.signal, onEvent: () => assert.fail("no event expected") });
  await tick(); controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);

  const responseGate = deferred(), late = new AbortController();
  const pendingResponse = fetchModelStream(() => responseGate.promise, "https://model.example", { signal: late.signal, onEvent: () => {} });
  late.abort();
  await assert.rejects(pendingResponse, { name: "AbortError" });
  let lateCancelled = 0;
  responseGate.resolve(new Response(new ReadableStream({ cancel() { lateCancelled++; } }), { headers: { "Content-Type": "text/event-stream" } }));
  await tick();
  assert.equal(lateCancelled, 1);
});

test("fetch rejects HTTP errors, non-SSE bodies and pre-aborted calls without pretending to complete", async () => {
  await assert.rejects(fetchModelStream(async () => new Response('{"error":"private-token-fixture"}', { status: 401 }), "https://model.example", { onEvent: () => {} }),
    (error) => error.status === 401 && !error.message.includes("private-token"));
  let cancelled = 0;
  await assert.rejects(fetchModelStream(async () => new Response(new ReadableStream({ cancel() { cancelled++; } }), { headers: { "Content-Type": "application/json" } }), "https://model.example", { onEvent: () => {} }), /未返回流式响应/);
  assert.equal(cancelled, 1);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchModelStream(() => assert.fail("request must not start"), "https://model.example", { signal: controller.signal, onEvent: () => {} }), { name: "AbortError" });
});

test("conversation sessions preserve request snapshots and ignore cancelled, finished and replaced run events", () => {
  const sessions = new ConversationSessions(), refs = ["notes:a"];
  const first = sessions.start({ conversationID: "a", projectID: "p", contextKeys: refs, prompt: "first", messageIDs: ["old"] });
  refs.push("notes:outside");
  const second = sessions.start({ conversationID: "b", projectID: "q", prompt: "second" });
  assert.deepEqual(first.contextKeys, ["notes:a"]);
  assert.throws(() => sessions.start({ conversationID: "a", prompt: "duplicate" }), /此对话/);
  assert.throws(() => sessions.start({ conversationID: "c", prompt: "third" }), /两条/);
  sessions.progress(first, { type: "text", text: "A" });
  sessions.progress(second, { type: "reasoning", text: "B reasoning" });
  sessions.cancel("a");
  assert.equal(sessions.progress(first, { type: "text", text: "late" }), false);
  sessions.finish(first);
  const replacement = sessions.start({ conversationID: "a", projectID: "new", prompt: "new" });
  assert.equal(sessions.progress(first, { type: "text", text: "very late" }), false);
  sessions.finish(first);
  assert.equal(sessions.get("a"), replacement);
  assert.equal(second.reasoning, "B reasoning");
  assert.equal(second.text, "");
  const event = { type: "tool-result", title: "read", output: { text: "kept" } };
  sessions.progress(replacement, event); event.output.text = "mutated externally";
  assert.equal(replacement.events[0].output.text, "kept");
  sessions.finish(replacement); sessions.finish(second);
  assert.equal(sessions.runs.size, 0);
});

test("native fixed diagnostics distinguish unsupported streaming from network errors without exposing arbitrary messages", async () => {
  for (const [message, match] of [
    ["服务未返回 SSE 流式内容，请检查模型接口", /未返回流式响应/],
    ["HTTPS 安全连接失败，请检查证书或代理配置。", /HTTPS/],
    ["private-token-fixture", /模型连接中断/],
  ]) {
    const fixture = bridgeFixture();
    const pending = nativeModelStream(fixture.bridge, "https://model.example", { onEvent: () => assert.fail("error has no data") });
    await tick();
    fixture.emit({ requestId: fixture.requests[0].requestId, type: "error", status: 200, error: message });
    await assert.rejects(pending, e => match.test(e.message) && !e.message.includes("private-token"));
    assert.equal(fixture.removed, 1);
  }
});
