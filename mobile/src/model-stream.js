import { modelHttpError, modelTransportError } from "./http-error.js";

// SSE frames can be split anywhere, including between CR and LF. UTF-8 decoding
// belongs to the native bridge / TextDecoder; this layer consumes decoded text.
export function createSSEParser(onEvent, maxBuffer = 8 * 1024 * 1024) {
  let buffer = "", data = [], dataSize = 0, event = "", ended = false, first = true;
  function dispatch() {
    const payload = data.join("\n");
    data = [];
    dataSize = 0;
    const name = event;
    event = "";
    if (!payload) return;
    if (payload.trim() === "[DONE]") { ended = true; return; }
    if (ended) return;
    let value;
    try { value = JSON.parse(payload); }
    catch { throw Error("模型返回了无法解析的流式内容"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("模型返回了无效的流式事件");
    if (name && !value.type) value.type = name;
    onEvent(value);
  }
  function line(text) {
    if (ended) return;
    if (text.length + dataSize > maxBuffer) throw Error("模型单条流式消息过大");
    if (!text) return dispatch();
    if (text.startsWith(":")) return;
    const split = text.indexOf(":"), field = split < 0 ? text : text.slice(0, split);
    const value = split < 0 ? "" : text.slice(split + 1).replace(/^ /, "");
    if (field === "data") { data.push(value); dataSize += value.length + 1; }
    else if (field === "event") event = value;
  }
  return {
    push(text) {
      if (ended) return;
      if (first && text.length) { text = text.replace(/^\uFEFF/, ""); first = false; }
      buffer += text;
      let match;
      while ((match = /[\r\n]/.exec(buffer))) {
        const at = match.index;
        if (buffer[at] === "\r" && at === buffer.length - 1) break;
        line(buffer.slice(0, at));
        buffer = buffer.slice(at + (buffer.slice(at, at + 2) === "\r\n" ? 2 : 1));
      }
      if (ended) buffer = "";
      else if (buffer.length + dataSize > maxBuffer) throw Error("模型单条流式消息过大");
    },
    finish() {
      if (buffer) line(buffer.replace(/\r$/, ""));
      buffer = "";
      dispatch();
    },
    get ended() { return ended; },
  };
}

const aborted = () => new DOMException("已停止回复", "AbortError");
export async function nativeModelStream(bridge, url, options) {
  const { method = "POST", headers = {}, body, signal, onEvent } = options;
  if (signal?.aborted) throw aborted();
  const requestId = crypto.randomUUID();
  let status = 200, errorBody = "", settled = false, failed = false, listener, cleaned = false, listenerRemoved = false;
  const parser = createSSEParser(onEvent);
  let resolve, reject;
  const completion = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Register a rejection observer before asynchronous listener registration.
  completion.catch(() => {});
  const cancel = async () => { try { await bridge.cancelRequest({ requestId }); } catch {} };
  const fail = (e) => { if (!settled) { settled = true; failed = true; reject(e); } };
  const abort = () => { cancel(); fail(aborted()); };
  const removeListener = async () => {
    if (!listener || listenerRemoved) return;
    listenerRemoved = true;
    try { await listener.remove(); } catch {}
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const registeringListener = Promise.resolve(bridge.addListener("requestStreamEvent", (e) => {
      if (e.requestId !== requestId || settled) return;
      if (e.status) status = e.status;
      try {
        if (e.type === "data") {
          if (status < 200 || status >= 300) errorBody = (errorBody + (e.data || "")).slice(0, 131072);
          else {
            parser.push(e.data || "");
            if (parser.ended) { settled = true; resolve(); cancel(); }
          }
        } else if (e.type === "error") {
          fail(signal?.aborted ? aborted() : status < 200 || status >= 300 ? modelHttpError(status, errorBody) : modelTransportError(e.error));
        } else if (e.type === "done") {
          if (status < 200 || status >= 300) return fail(modelHttpError(status, errorBody));
          parser.finish();
          settled = true;
          resolve();
        }
      } catch (e) { cancel(); fail(e); }
    })).then(async (handle) => { listener = handle; if (cleaned) await removeListener(); });
    await Promise.race([registeringListener, completion]);
    if (signal?.aborted) throw aborted();
    const registration = Promise.resolve(bridge.requestStream({ requestId, url, method, headers,
      body: typeof body === "string" ? body : JSON.stringify(body ?? {}) }));
    // If cancellation wins before native registration acknowledges, cancel
    // again when the late acknowledgement arrives so no orphan request lives.
    registration.then(() => { if (signal?.aborted || failed) cancel(); }, () => {});
    await Promise.race([registration, completion]);
    // Cancellation may have raced native request registration.
    if (signal?.aborted) { await cancel(); throw aborted(); }
    await completion;
  } catch (e) {
    fail(e);
    await cancel();
    throw e;
  } finally {
    signal?.removeEventListener("abort", abort);
    cleaned = true;
    await removeListener();
  }
}

export async function fetchModelStream(request, url, options) {
  if (options.signal?.aborted) throw aborted();
  const { onEvent, body, ...init } = options;
  let rejectCancelled;
  const cancelled = new Promise((_, reject) => { rejectCancelled = reject; });
  cancelled.catch(() => {});
  const abortRequest = () => rejectCancelled(aborted());
  options.signal?.addEventListener("abort", abortRequest, { once: true });
  let response;
  try {
    const requested = Promise.resolve(request(url, { ...init, redirect: "error",
      body: typeof body === "string" ? body : JSON.stringify(body ?? {}) })).then(async (value) => {
      if (options.signal?.aborted) { try { await value.body?.cancel(); } catch {} }
      return value;
    });
    response = await Promise.race([requested, cancelled]);
  } finally { options.signal?.removeEventListener("abort", abortRequest); }
  if (options.signal?.aborted) throw aborted();
  if (!response.ok) throw modelHttpError(response.status, (await response.text()).slice(0, 131072));
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    try { await response.body?.cancel(); } catch {}
    throw Error("模型服务未返回流式响应，请检查接口类型与模型配置");
  }
  if (!response.body) throw Error("模型响应为空");
  const reader = response.body.getReader(), decoder = new TextDecoder(), parser = createSSEParser(onEvent);
  const abortRead = () => { reader.cancel().catch(() => {}); };
  options.signal?.addEventListener("abort", abortRead, { once: true });
  try {
    while (true) {
      if (options.signal?.aborted) throw aborted();
      const { done, value } = await reader.read();
      if (options.signal?.aborted) throw aborted();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
      if (parser.ended) break;
    }
    parser.push(decoder.decode());
    parser.finish();
  } finally {
    options.signal?.removeEventListener("abort", abortRead);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
